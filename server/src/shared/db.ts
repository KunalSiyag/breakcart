import pg from 'pg';
import { config } from './config';
import { emitEvent } from './events';
import { logger } from './logger';
import { m } from './metrics';
import { runtime } from './runtime';
import { chance, HttpError } from './util';

// BIGINT → number (ids and counters stay well below 2^53).
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC → number
pg.types.setTypeParser(1700, (v) => Number(v));

export type Tx = pg.PoolClient;

/**
 * Postgres access with an observable, tunable pool. The pool is rebuilt when
 * tuning.dbPoolSize / timeouts change so you can starve or grow it live.
 */
class Database {
  private pool?: pg.Pool;
  private poolKey = '';
  private retired: pg.Pool[] = [];
  private gaugeTimer?: NodeJS.Timeout;

  start() {
    this.ensurePool();
    runtime.on('change', () => this.ensurePool());
    this.gaugeTimer = setInterval(() => this.updateGauges(), 1000);
    this.gaugeTimer.unref();
  }

  private ensurePool(): pg.Pool {
    const t = runtime.tuning;
    const key = `${t.dbPoolSize}:${t.dbAcquireTimeoutMs}:${t.dbStatementTimeoutMs}`;
    if (this.pool && key === this.poolKey) return this.pool;
    const old = this.pool;
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: t.dbPoolSize,
      connectionTimeoutMillis: t.dbAcquireTimeoutMs,
      idleTimeoutMillis: 30_000,
      statement_timeout: t.dbStatementTimeoutMs,
      application_name: config.service,
    });
    this.pool.on('error', (err) => logger.warn({ err: err.message }, 'idle pg client error'));
    this.poolKey = key;
    if (old) {
      logger.info({ max: t.dbPoolSize }, 'db pool resized');
      this.retired.push(old);
      old.end().finally(() => {
        this.retired = this.retired.filter((p) => p !== old);
      });
    }
    return this.pool;
  }

  private updateGauges() {
    const pools = this.pool ? [this.pool, ...this.retired] : this.retired;
    let total = 0;
    let idle = 0;
    let waiting = 0;
    for (const p of pools) {
      total += p.totalCount;
      idle += p.idleCount;
      waiting += p.waitingCount;
    }
    m.dbPool.set({ state: 'total' }, total);
    m.dbPool.set({ state: 'idle' }, idle);
    m.dbPool.set({ state: 'waiting' }, waiting);
    m.dbPool.set({ state: 'max' }, runtime.tuning.dbPoolSize);
  }

  stats() {
    const p = this.ensurePool();
    return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, max: runtime.tuning.dbPoolSize };
  }

  private async acquire(): Promise<pg.PoolClient> {
    const end = m.dbAcquire.startTimer();
    try {
      const client = await this.ensurePool().connect();
      end();
      return client;
    } catch (err) {
      end();
      throw translate(err);
    }
  }

  /** Chaos: make this connection slow before running real work (keeps it checked out). */
  private async maybeSlow(client: pg.PoolClient) {
    const c = runtime.chaos();
    if (c.dbSlowMs > 0 && chance(c.dbSlowPct)) {
      await client.query('SELECT pg_sleep($1)', [c.dbSlowMs / 1000]);
    }
  }

  async query<R extends pg.QueryResultRow = any>(op: string, sql: string, params: unknown[] = []): Promise<R[]> {
    const end = m.dbQuery.startTimer({ op });
    let client: pg.PoolClient | undefined;
    try {
      client = await this.acquire();
      await this.maybeSlow(client);
      const res = await client.query<R>(sql, params);
      end({ outcome: 'ok' });
      return res.rows;
    } catch (err) {
      end({ outcome: 'error' });
      throw translate(err);
    } finally {
      client?.release();
    }
  }

  async tx<T>(op: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const end = m.dbQuery.startTimer({ op });
    let client: pg.PoolClient | undefined;
    let broken = false;
    try {
      client = await this.acquire();
      await this.maybeSlow(client);
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      end({ outcome: 'ok' });
      return out;
    } catch (err) {
      end({ outcome: 'error' });
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      throw translate(err);
    } finally {
      client?.release(broken);
    }
  }

  async end() {
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    await this.pool?.end();
  }
}

export class DbError extends HttpError {
  constructor(
    public readonly pgCode: string,
    message: string,
  ) {
    const unavailable = pgCode === 'acquire_timeout' || pgCode === '57014' || pgCode === 'connection';
    super(unavailable ? 503 : 500, unavailable ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL', message, unavailable);
  }
}

function translate(err: unknown): Error {
  if (err instanceof DbError || err instanceof HttpError) return err;
  const e = err as { code?: string; message?: string };
  let code = e.code ?? 'unknown';
  const msg = e.message ?? String(err);
  if (/timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(msg)) {
    code = 'acquire_timeout';
    emitEvent('critical', 'pool-exhausted', `DB pool exhausted: waited ${runtime.tuning.dbAcquireTimeoutMs}ms for a connection`, db.stats());
  } else if (/ECONNREFUSED|terminating connection|Connection terminated/i.test(msg)) {
    code = 'connection';
  }
  m.dbErrors.inc({ code });
  if (code === '40P01') emitEvent('warn', 'deadlock', 'Postgres detected a deadlock and aborted a transaction', undefined, { throttleMs: 2000 });
  if (code === '57014') emitEvent('warn', 'statement-timeout', 'Query cancelled by statement_timeout');
  return new DbError(code, msg);
}

export const db = new Database();
