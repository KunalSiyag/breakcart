import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, isAbortError, toApiError } from '../api/http';

/** Wall clock that re-renders the caller every `intervalMs`. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Ref that always holds the latest value (for callbacks fired from timers). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface PollingOptions {
  enabled?: boolean;
  /** Upper bound for exponential back-off after failures. */
  maxBackoffMs?: number;
  /** Skip ticks while the tab is hidden (default true). */
  pauseWhenHidden?: boolean;
}

/**
 * Runs `task` now and then every `intervalMs` after it settles (never overlapping).
 * A task that throws backs off exponentially, so a dead backend is not hammered and
 * an error never turns into a tight loop.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  { enabled = true, maxBackoffMs = 30_000, pauseWhenHidden = true }: PollingOptions = {},
): void {
  const taskRef = useLatest(task);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let failures = 0;
    let timer: number | undefined;
    const ctrl = new AbortController();
    const schedule = (ms: number) => {
      if (!stopped) timer = window.setTimeout(tick, ms);
    };
    const tick = async () => {
      if (stopped) return;
      if (pauseWhenHidden && document.visibilityState === 'hidden') {
        schedule(intervalMs);
        return;
      }
      try {
        await taskRef.current(ctrl.signal);
        failures = 0;
      } catch (e) {
        if (stopped || isAbortError(e)) return;
        failures += 1;
      }
      schedule(failures ? Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures, 6)) : intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [enabled, intervalMs, maxBackoffMs, pauseWhenHidden, taskRef]);
}

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** When the current request started (for "still loading… 7s" indicators). */
  startedAt: number | null;
  reload: () => void;
  setData: (updater: (prev: T | null) => T | null) => void;
}

/**
 * Loads data when `deps` change. Keeps the previous data while reloading (no flash),
 * aborts superseded requests, and never retries on its own (callers offer a button).
 */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useLatest(fn);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setStartedAt(Date.now());
    fnRef.current(ctrl.signal).then(
      (value) => {
        if (ctrl.signal.aborted) return;
        setDataState(value);
        setLoading(false);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted || isAbortError(e)) return;
        setError(toApiError(e));
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState(updater), []);
  return { data, error, loading, startedAt, reload, setData };
}

/** Debounced callback; `flush` runs a pending call immediately. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delayMs: number) {
  const fnRef = useLatest(fn);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<A | null>(null);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const args = pending.current;
    pending.current = null;
    if (args) fnRef.current(...args);
  }, [fnRef]);

  const call = useCallback(
    (...args: A) => {
      pending.current = args;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { call, flush };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/** Seconds elapsed since `startedAt` while `active`, ticking once per second. */
export function useElapsed(startedAt: number | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active || startedAt == null) return 0;
  return Math.max(0, (now - startedAt) / 1000);
}
