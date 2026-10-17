import { Pool } from 'undici';
import { backoffMs, CircuitBreaker, RetryBudget, type BreakerState } from './breaker';
import { config, type UpstreamName } from './config';
import { emitEvent } from './events';
import { m } from './metrics';
import { runtime } from './runtime';
import { syncLog } from './sync-log';
import { HttpError, sleep } from './util';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CallOptions {
  method?: Method;
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Safe to retry: GET, or a write that carries an idempotency key. */
  idempotent?: boolean;
}

export interface CallResult<T> {
  status: number;
  body: T;
  /** Raw response text (lets a proxy relay bytes without re-serialising). */
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

type Outcome = 'ok' | 'http_error' | 'timeout' | 'network_error' | 'circuit_open';

const BREAKER_STATE_VALUE: Record<BreakerState, number> = { closed: 0, half_open: 1, open: 2 };

export const upstreams = new Map<string, Upstream>();

/**
 * An instrumented, chaos-aware HTTP client for one downstream service, with the
 * retry / circuit-breaker / keep-alive behaviour selected live by platform.* flags.
 */
export class Upstream {
  private pool: Pool;
  private poolConnections: number;
  readonly breaker: CircuitBreaker;
  private budget = new RetryBudget(0.1, 20);

  constructor(
    readonly name: string,
    readonly baseUrl: string,
  ) {
    this.poolConnections = runtime.tuning.upstreamConnections;
    this.pool = this.makePool();
    this.breaker = new CircuitBreaker({
      onTransition: (from, to) => {
        m.breakerState.set({ target: name }, BREAKER_STATE_VALUE[to]);
        m.breakerTransitions.inc({ target: name, to });
        emitEvent(
          to === 'open' ? 'critical' : 'info',
          `breaker-${name}-${to}`,
          `Circuit breaker ${config.service} → ${name}: ${from} → ${to}`,
          undefined,
          { throttleMs: 0 },
        );
      },
    });
    m.breakerState.set({ target: name }, 0);
    upstreams.set(name, this);
    runtime.on('change', () => {
      if (runtime.tuning.upstreamConnections !== this.poolConnections) {
        const old = this.pool;
        this.poolConnections = runtime.tuning.upstreamConnections;
        this.pool = this.makePool();
        void old.close().catch(() => undefined);
      }
      if (runtime.flag('platform.circuitBreaker') === 'off' && this.breaker.state !== 'closed') this.breaker.reset();
    });
  }

  static for(name: UpstreamName): Upstream {
    return upstreams.get(name) ?? new Upstream(name, config.urls[name]);
  }

  private makePool() {
    const pool = new Pool(this.baseUrl, {
      connections: this.poolConnections,
      pipelining: 1,
      keepAliveTimeout: 10_000,
      connectTimeout: 3000,
    });
    pool.on('connect', () => m.clientConnections.inc({ target: this.name }));
    return pool;
  }

  async call<T = any>(opts: CallOptions): Promise<CallResult<T>> {
    const policy = runtime.flag('platform.retries');
    const breakerOn = runtime.flag('platform.circuitBreaker') === 'on';
    const method = opts.method ?? 'GET';
    const idempotent = opts.idempotent ?? method === 'GET';
    const maxAttempts = policy === 'none' ? 1 : policy === 'naive_immediate' ? 4 : idempotent ? 3 : 1;
    const started = performance.now();
    this.budget.deposit();

    let last: { outcome: Outcome; result?: CallResult<T>; error?: Error } | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        if (policy === 'budgeted_backoff') {
          if (!this.budget.trySpend()) {
            m.clientBudgetExhausted.inc({ target: this.name });
            break;
          }
          await sleep(backoffMs(attempt));
        }
        m.clientRetries.inc({ target: this.name });
      }

      if (breakerOn && !this.breaker.tryAcquire()) {
        last = {
          outcome: 'circuit_open',
          error: new HttpError(503, 'UPSTREAM_UNAVAILABLE', `${this.name} circuit open`, true),
        };
        break; // never retry into an open breaker
      }

      last = await this.once<T>(opts, method);
      if (breakerOn) {
        if (last.outcome === 'ok' || (last.result && last.result.status < 500)) this.breaker.onSuccess();
        else this.breaker.onFailure();
      }

      if (!this.shouldRetry(last, policy)) break;
    }

    const outcome = last!.outcome;
    m.clientDuration.observe({ target: this.name, outcome }, (performance.now() - started) / 1000);
    if (last!.result) return last!.result;
    throw last!.error!;
  }

  /** Call and unwrap: 2xx → body, otherwise throw an HttpError carrying the upstream error code. */
  async json<T = any>(opts: CallOptions): Promise<T> {
    const res = await this.call<T>(opts);
    if (res.status >= 200 && res.status < 300) return res.body;
    throw toHttpError(this.name, res);
  }

  private shouldRetry(last: { outcome: Outcome; result?: CallResult<unknown> }, policy: string): boolean {
    if (policy === 'none') return false;
    if (last.outcome === 'timeout' || last.outcome === 'network_error') return true;
    const status = last.result?.status ?? 0;
    if (policy === 'naive_immediate') return status >= 500 || status === 429;
    return status === 502 || status === 503 || status === 504;
  }

  private async once<T>(opts: CallOptions, method: Method): Promise<{ outcome: Outcome; result?: CallResult<T>; error?: Error }> {
    const timeoutMs = opts.timeoutMs ?? runtime.tuning.upstreamTimeoutMs;
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    let path = opts.path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) path += (path.includes('?') ? '&' : '?') + s;
    }
    // One deadline for the whole call, including time queued for a pooled connection
    // (undici's headersTimeout only starts once the request is on a socket).
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(new DOMException('deadline exceeded', 'TimeoutError')), timeoutMs);
    try {
      const res = await this.pool.request({
        path,
        method,
        headers,
        body,
        signal: ac.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        reset: runtime.flag('platform.keepAlive') === 'off',
      });
      const text = await res.body.text();
      let parsed: unknown = text;
      if (text && String(res.headers['content-type'] ?? '').includes('json')) {
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep text */
        }
      }
      const result: CallResult<T> = { status: res.statusCode, body: parsed as T, text, headers: res.headers };
      if (runtime.flag('platform.logging') === 'sync_verbose') {
        // "Debug logging for the HTTP client, just for now": every upstream call, pretty-printed,
        // with the full response body — through the same synchronous, fsync'd path as the access log.
        syncLog({ ts: new Date().toISOString(), service: config.service, upstream: this.name, method, path, request: opts.body, status: res.statusCode, headers: res.headers, response: parsed });
      }
      return { outcome: res.statusCode >= 500 ? 'http_error' : 'ok', result };
    } catch (err) {
      const e = err as Error & { code?: string; name?: string };
      const isTimeout =
        e.name === 'TimeoutError' ||
        e.name === 'AbortError' ||
        e.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        e.code === 'UND_ERR_BODY_TIMEOUT' ||
        e.code === 'UND_ERR_ABORTED';
      if (isTimeout) {
        return { outcome: 'timeout', error: new HttpError(504, 'UPSTREAM_UNAVAILABLE', `${this.name} timed out after ${timeoutMs}ms`, true) };
      }
      return {
        outcome: 'network_error',
        error: new HttpError(502, 'UPSTREAM_UNAVAILABLE', `${this.name} unreachable: ${e.code ?? e.message}`, true),
      };
    } finally {
      clearTimeout(deadline);
    }
  }

  async close() {
    await this.pool.close();
  }
}

export function toHttpError(target: string, res: CallResult<any>): HttpError {
  const err = res.body && typeof res.body === 'object' ? (res.body as any).error : undefined;
  if (err && typeof err.code === 'string') {
    const headers: Record<string, string> = {};
    const ra = res.headers['retry-after'];
    if (typeof ra === 'string') headers['retry-after'] = ra;
    return new HttpError(res.status, err.code, err.message ?? err.code, !!err.retryable, headers);
  }
  return new HttpError(res.status >= 500 ? 502 : res.status, 'UPSTREAM_UNAVAILABLE', `${target} returned ${res.status}`, res.status >= 500);
}

export function breakerStates() {
  return [...upstreams.values()].map((u) => ({ target: u.name, state: u.breaker.state }));
}
