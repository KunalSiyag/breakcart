import { KEYS } from './defs';
import type { DataRedis } from './redis';
import { runtime } from './runtime';

export interface SaleState {
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface SaleView extends SaleState {
  now: string;
  live: boolean;
}

export const DEFAULT_SALE: SaleState = {
  name: 'Big Billion Sale',
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
};

export function isLive(sale: SaleState | null, nowMs: number): boolean {
  if (!sale) return false;
  return nowMs >= Date.parse(sale.startsAt) && nowMs < Date.parse(sale.endsAt);
}

/** Sale window from Redis, cached for 1s per process; survives Redis blips with the last known value. */
export class SaleClock {
  private cached: SaleState | null = null;
  private fetchedAt = 0;
  private inflight?: Promise<SaleState | null>;

  constructor(private redis: DataRedis) {}

  async get(): Promise<SaleState | null> {
    if (Date.now() - this.fetchedAt < 1000) return this.cached;
    if (!this.inflight) {
      this.inflight = this.redis
        .run('get', (r) => r.get(KEYS.sale))
        .then((raw) => {
          this.cached = raw ? (JSON.parse(raw) as SaleState) : DEFAULT_SALE;
          this.fetchedAt = Date.now();
          return this.cached;
        })
        .catch(() => this.cached ?? DEFAULT_SALE)
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  /** Uses this service's (possibly skewed) clock. */
  async view(): Promise<SaleView | null> {
    const sale = await this.get();
    if (!sale) return null;
    const now = runtime.now();
    return { ...sale, now: new Date(now).toISOString(), live: isLive(sale, now) };
  }
}
