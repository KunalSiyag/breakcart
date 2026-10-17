import type { ApiErrorBody, ClientErrorCode, ErrorCode } from './types';

/** Every failed call — HTTP error, network failure, timeout — surfaces as an ApiError. */
export class ApiError extends Error {
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  readonly code: ErrorCode | ClientErrorCode | (string & {});
  readonly retryable: boolean;
  /** Seconds from the Retry-After header, when the server sent one. */
  readonly retryAfterSec: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    retryable: boolean;
    retryAfterSec?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfterSec = init.retryAfterSec ?? null;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof ApiError) return e.code === 'ABORTED';
  return e instanceof DOMException && e.name === 'AbortError';
}

/** Normalise anything thrown into an ApiError so UIs have one shape to render. */
export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (isAbortError(e)) {
    return new ApiError({ status: 0, code: 'ABORTED', message: 'Request cancelled', retryable: false });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new ApiError({ status: 0, code: 'BAD_RESPONSE', message, retryable: true });
}

function isErrorBody(body: unknown): body is ApiErrorBody {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const err = (body as { error: unknown }).error;
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return null;
}

/** Build an ApiError from a non-2xx response (JSON error envelope or a bare proxy page). */
export function errorFromResponse(res: Response, body: unknown): ApiError {
  const retryAfterSec = parseRetryAfter(res.headers.get('Retry-After'));
  if (isErrorBody(body)) {
    return new ApiError({
      status: res.status,
      code: body.error.code,
      message: body.error.message || `HTTP ${res.status}`,
      retryable: Boolean(body.error.retryable),
      retryAfterSec,
    });
  }
  let code: string = 'BAD_RESPONSE';
  if (res.status === 401) code = 'UNAUTHENTICATED';
  else if (res.status === 404) code = 'NOT_FOUND';
  else if (res.status === 429) code = 'RATE_LIMITED';
  else if (res.status === 502 || res.status === 503 || res.status === 504) code = 'UPSTREAM_UNAVAILABLE';
  else if (res.status >= 500) code = 'INTERNAL';
  return new ApiError({
    status: res.status,
    code,
    message: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
    retryable: res.status >= 500 || res.status === 429,
    retryAfterSec,
  });
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Client-side safety timeout. Browsers have none by default; we cap at this. */
  timeoutMs?: number;
}

export interface RawResult {
  res: Response;
  body: unknown;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * fetch() + JSON body handling + timeout. Network failures, timeouts and aborts are
 * converted to ApiError (status 0); HTTP errors are returned to the caller as-is.
 */
export async function rawRequest(url: string, opts: RequestOptions = {}): Promise<RawResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? 0;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ctrl.abort();
        }, timeoutMs)
      : null;
  const forwardAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: payload,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const body = await readBody(res);
    return { res, body };
  } catch (e) {
    if (timedOut) {
      throw new ApiError({
        status: 0,
        code: 'TIMEOUT',
        message: `No response after ${Math.round(timeoutMs / 1000)}s`,
        retryable: true,
      });
    }
    if (ctrl.signal.aborted) {
      throw new ApiError({ status: 0, code: 'ABORTED', message: 'Request cancelled', retryable: false });
    }
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      message: e instanceof Error && e.message ? e.message : 'Network error',
      retryable: true,
    });
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Some endpoints may wrap lists as { items: [...] }; accept both shapes. */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

/** Resolves after `ms`, or rejects early (AbortError) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
