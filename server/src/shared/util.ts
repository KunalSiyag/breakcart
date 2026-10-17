import { randomUUID } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Busy-wait — deliberately blocks the event loop (used for chaos and naive code paths). */
export function burnCpu(ms: number): void {
  const end = performance.now() + ms;
  // eslint-disable-next-line no-empty
  while (performance.now() < end) {}
}

export const uuid = () => randomUUID();

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Log-normal sample parameterised by median and p99. */
export function logNormal(medianMs: number, p99Ms: number): number {
  const mu = Math.log(Math.max(1, medianMs));
  const sigma = Math.max(0.01, (Math.log(Math.max(medianMs + 1, p99Ms)) - mu) / 2.326);
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.exp(mu + sigma * z);
}

/** Pick an index from a Zipf-like distribution over n items (s ≈ 1.1). */
export function zipfIndex(n: number, s = 1.1): number {
  // Inverse-CDF on a precomputed table would be faster; n is small enough here.
  let total = 0;
  for (let i = 1; i <= n; i++) total += 1 / Math.pow(i, s);
  let r = Math.random() * total;
  for (let i = 1; i <= n; i++) {
    r -= 1 / Math.pow(i, s);
    if (r <= 0) return i - 1;
  }
  return n - 1;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function chance(pct: number): boolean {
  return pct > 0 && Math.random() * 100 < pct;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge for plain objects (arrays and scalars are replaced). */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}
