import { emitEvent } from '../../shared/events';
import { m } from '../../shared/metrics';
import type { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { sleep } from '../../shared/util';

interface Envelope<T> {
  v: T;
  /** Soft expiry (ms epoch). After it, serve stale and refresh in the background. */
  soft: number;
}

/**
 * Cache-aside with three behaviours selected by the `catalog.cache` flag:
 *
 *  none       – always load.
 *  naive_ttl  – Redis GET; on miss every caller loads and SETs with the same fixed TTL.
 *               A hot key expiring under load triggers N concurrent rebuilds (stampede),
 *               and keys written together expire together (synchronized expiry).
 *  hardened   – L1 in-process cache (absorbs hot keys) → in-process single-flight →
 *               Redis envelope with soft TTL (stale-while-revalidate) and jittered hard TTL →
 *               distributed rebuild lock so only one process rebuilds a key.
 */
export class Cache<T> {
  private l1 = new Map<string, { v: T; exp: number }>();
  private flights = new Map<string, Promise<T | null>>();
  private rebuilding = 0;

  constructor(
    readonly name: string,
    private redis: DataRedis,
    private loader: (key: string) => Promise<T | null>,
    private opts: { l1TtlMs?: number; l1Max?: number; isHot?: (key: string) => boolean } = {},
  ) {}

  /** Naive and hardened entries use different shapes, so they live in different namespaces. */
  private rkey(key: string, mode = runtime.flag('catalog.cache') === 'naive_ttl' ? 'n' : 'h') {
    return `bc:cache:${this.name}:${mode}:${key}`;
  }

  async get(key: string): Promise<T | null> {
    const mode = runtime.flag('catalog.cache');
    if (mode === 'none') {
      m.cacheRequests.inc({ cache: this.name, result: 'bypass' });
      return this.rebuild(key);
    }
    if (mode === 'naive_ttl') return this.getNaive(key);
    return this.getHardened(key);
  }

  /* ------------------------------------------------------------ naive */
  private async getNaive(key: string): Promise<T | null> {
    let raw: string | null = null;
    try {
      raw = await this.redis.run('get', (r) => r.get(this.rkey(key)));
    } catch {
      // Redis down → fall through to the DB for every request (thundering herd on the DB).
    }
    if (raw !== null) {
      m.cacheRequests.inc({ cache: this.name, result: 'hit' });
      return JSON.parse(raw) as T;
    }
    m.cacheRequests.inc({ cache: this.name, result: 'miss' });
    const v = await this.rebuild(key);
    const ttl = runtime.tuning.cacheTtlSec;
    this.redis.run('set', (r) => r.set(this.rkey(key), JSON.stringify(v), 'EX', ttl)).catch(() => undefined);
    return v;
  }

  /* ------------------------------------------------------------ hardened */
  private async getHardened(key: string): Promise<T | null> {
    const now = Date.now();
    const l1 = this.l1.get(key);
    if (l1 && l1.exp > now) {
      m.cacheRequests.inc({ cache: this.name, result: 'l1_hit' });
      return l1.v;
    }
    const flight = this.flights.get(key);
    if (flight) {
      m.cacheRequests.inc({ cache: this.name, result: 'coalesced' });
      return flight;
    }
    const p = this.fetchHardened(key).finally(() => this.flights.delete(key));
    this.flights.set(key, p);
    return p;
  }

  private async fetchHardened(key: string): Promise<T | null> {
    let env: Envelope<T> | null = null;
    let redisOk = true;
    try {
      const raw = await this.redis.run('get', (r) => r.get(this.rkey(key)));
      env = raw ? (JSON.parse(raw) as Envelope<T>) : null;
    } catch {
      redisOk = false;
    }

    if (env) {
      if (env.soft > Date.now()) {
        m.cacheRequests.inc({ cache: this.name, result: 'hit' });
      } else {
        // Stale: serve it now, refresh in the background if we win the lock.
        m.cacheRequests.inc({ cache: this.name, result: 'stale' });
        void this.refreshWithLock(key).catch(() => undefined);
      }
      this.setL1(key, env.v);
      return env.v;
    }

    m.cacheRequests.inc({ cache: this.name, result: 'miss' });
    if (!redisOk) {
      const v = await this.rebuild(key);
      this.setL1(key, v);
      return v;
    }

    // Cold miss: one process rebuilds; the others briefly wait for its result.
    const won = await this.tryLock(key);
    if (won) {
      const v = await this.rebuildAndStore(key);
      this.setL1(key, v);
      return v;
    }
    for (let i = 0; i < 20; i++) {
      await sleep(25);
      try {
        const raw = await this.redis.run('get', (r) => r.get(this.rkey(key)));
        if (raw) {
          const v = (JSON.parse(raw) as Envelope<T>).v;
          this.setL1(key, v);
          return v;
        }
      } catch {
        break;
      }
    }
    const v = await this.rebuildAndStore(key);
    this.setL1(key, v);
    return v;
  }

  private async tryLock(key: string): Promise<boolean> {
    try {
      const ok = await this.redis.run('set_nx', (r) => r.set(`${this.rkey(key)}:lock`, '1', 'PX', 3000, 'NX'));
      return ok === 'OK';
    } catch {
      return true;
    }
  }

  private async refreshWithLock(key: string) {
    if (await this.tryLock(key)) await this.rebuildAndStore(key);
  }

  private async rebuildAndStore(key: string): Promise<T | null> {
    const v = await this.rebuild(key);
    const base = runtime.tuning.cacheTtlSec;
    const jitter = 0.8 + Math.random() * 0.4;
    const softMs = Math.round(base * 1000 * jitter);
    const env: Envelope<T | null> = { v, soft: Date.now() + softMs };
    // Hard TTL is a multiple of the soft TTL so stale data is available while refreshing.
    const hardSec = Math.max(5, Math.round((softMs / 1000) * 4));
    this.redis
      .run('set', (r) => r.set(this.rkey(key), JSON.stringify(env), 'EX', hardSec))
      .then(() => this.redis.run('del', (r) => r.del(`${this.rkey(key)}:lock`)))
      .catch(() => undefined);
    return v;
  }

  private setL1(key: string, v: T | null) {
    if (v === null) return;
    const ttl = this.opts.l1TtlMs ?? 2000;
    if (this.l1.size >= (this.opts.l1Max ?? 5000)) {
      const first = this.l1.keys().next().value;
      if (first !== undefined) this.l1.delete(first);
    }
    this.l1.set(key, { v, exp: Date.now() + ttl });
  }

  private async rebuild(key: string): Promise<T | null> {
    this.rebuilding++;
    m.cacheRebuilds.inc({ cache: this.name, tier: this.opts.isHot?.(key) ? 'hot' : 'long_tail' });
    m.cacheRebuildInflight.set({ cache: this.name }, this.rebuilding);
    if (this.rebuilding >= 50) {
      emitEvent('warn', `stampede-${this.name}`, `Cache stampede: ${this.rebuilding} concurrent rebuilds of "${this.name}" in one process`);
    }
    try {
      return await this.loader(key);
    } finally {
      this.rebuilding--;
      m.cacheRebuildInflight.set({ cache: this.name }, this.rebuilding);
    }
  }

  /** Evict locally and in Redis. */
  async invalidate(keys: string[]) {
    for (const k of keys) this.l1.delete(k);
    if (!keys.length) return;
    const all = keys.flatMap((k) => [this.rkey(k, 'n'), this.rkey(k, 'h')]);
    await this.redis.run('del', (r) => r.del(...all)).catch(() => undefined);
  }

  dropL1(keys?: string[]) {
    if (!keys) this.l1.clear();
    else for (const k of keys) this.l1.delete(k);
  }
}
