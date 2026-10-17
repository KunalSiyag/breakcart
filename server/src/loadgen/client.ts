import type { Dispatcher } from 'undici';
import { m } from '../shared/metrics';
import type { JourneyRecorder } from './journey';
import type { StepStats } from './stats';

export interface Resp {
  status: number;
  /** HTTP status, or 'timeout' / 'network'. */
  code: string;
  /** Error code from the JSON error body, if any. */
  error: string | null;
  body: any;
  ms: number;
  retryAfterMs: number | null;
}

export interface CallOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  timeoutMs?: number;
  ip: string;
  query?: Record<string, string | number>;
}

/**
 * The virtual users' "browser". Latency is measured from the moment the user clicks
 * (including time queued for a connection in this process) — what the customer feels.
 */
export class Api {
  /**
   * `current` is false once the session's scenario run has ended: stragglers must not pollute the next run's stats.
   * `journey` is set only for sampled sessions.
   */
  constructor(
    private pool: Dispatcher,
    private stats: StepStats,
    private current: () => boolean = () => true,
    private journey: JourneyRecorder | null = null,
  ) {}

  async call(step: string, method: 'GET' | 'POST' | 'DELETE', path: string, o: CallOpts): Promise<Resp> {
    const headers: Record<string, string> = { accept: 'application/json', 'x-forwarded-for': o.ip, 'user-agent': 'BreakCart-VU/1.0' };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    for (const [k, v] of Object.entries(o.headers ?? {})) if (v !== undefined) headers[k] = v;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    if (o.query) path += `?${new URLSearchParams(Object.entries(o.query).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
    const timeoutMs = o.timeoutMs ?? 15_000;
    const t0 = performance.now();
    const ac = new AbortController();
    const deadline = setTimeout(() => ac.abort(new DOMException('customer gave up', 'TimeoutError')), timeoutMs);
    let resp: Resp;
    try {
      const res = await this.pool.request({
        method,
        path,
        headers,
        body,
        signal: ac.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });
      const text = await res.body.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      const ra = Number(res.headers['retry-after']);
      resp = {
        status: res.statusCode,
        code: String(res.statusCode),
        error: parsed && typeof parsed === 'object' && parsed.error ? String(parsed.error.code) : null,
        body: parsed,
        ms: performance.now() - t0,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null,
      };
    } catch (err) {
      const e = err as Error & { code?: string };
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError' || /TIMEOUT/.test(e.code ?? '');
      resp = { status: 0, code: timeout ? 'timeout' : 'network', error: null, body: null, ms: performance.now() - t0, retryAfterMs: null };
    } finally {
      clearTimeout(deadline);
    }
    if (!this.current()) return resp;
    const isError = resp.status === 0 || resp.status >= 500 || resp.status === 429;
    const label = resp.error ? `${resp.code} ${resp.error}` : resp.code;
    this.stats.record(step, resp.ms, label, isError);
    m.lgStep.observe({ step, outcome: isError ? (resp.code === 'timeout' ? 'timeout' : 'error') : 'ok' }, resp.ms / 1000);
    m.lgRequests.inc({ step, code: resp.code });
    this.journey?.record(step, t0, resp);
    return resp;
  }
}
