import { db, DbError, type Tx } from '../../shared/db';
import { emitEvent } from '../../shared/events';
import { logger } from '../../shared/logger';
import { m } from '../../shared/metrics';
import { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { runService } from '../../shared/server';
import { HttpError, sleep } from '../../shared/util';

interface Item {
  sku: string;
  qty: number;
}

const redis = new DataRedis();
const stockKey = (sku: string) => `bc:stock:${sku}`;
let reserveScript: ReturnType<DataRedis['script']>;
let releaseScript: ReturnType<DataRedis['script']>;

/**
 * All-or-nothing multi-SKU decrement. Returns 1 on success, 0 when any SKU lacks stock,
 * -1 when a key is not initialised yet (caller seeds it from Postgres and retries).
 */
const RESERVE_LUA = `
for i = 1, #KEYS do
  local v = redis.call('GET', KEYS[i])
  if not v then return {-1, i} end
  if tonumber(v) < tonumber(ARGV[i]) then return {0, i} end
end
for i = 1, #KEYS do
  redis.call('DECRBY', KEYS[i], ARGV[i])
end
return {1, 0}
`;

const RELEASE_LUA = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('INCRBY', KEYS[i], ARGV[i]) end
end
return 1
`;

/** EVALSHA-cached script whose key count varies per call. */
function variadic(name: string, lua: string): ReturnType<DataRedis['script']> {
  redis.client.defineCommand(name, { lua });
  const fn = (redis.client as unknown as Record<string, (...a: (string | number)[]) => Promise<unknown>>)[name].bind(redis.client);
  return (keys, args) => fn(keys.length, ...keys, ...args);
}

class OutOfStock extends HttpError {
  constructor(sku: string) {
    super(409, 'OUT_OF_STOCK', `${sku} is out of stock`);
  }
}

function orderItems(items: Item[]): Item[] {
  if (runtime.flag('inventory.lockOrdering') === 'sorted_by_sku') {
    return [...items].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  }
  return items;
}

function expiresAt(): Date | null {
  return runtime.flag('inventory.reservationTtl') === 'expire_and_sweep' ? new Date(Date.now() + runtime.tuning.reservationTtlSec * 1000) : null;
}

async function insertReservation(q: Pick<Tx, 'query'>, orderId: string, it: Item, exp: Date | null) {
  await q.query('INSERT INTO inventory.reservations (order_id, sku, qty, status, expires_at) VALUES ($1, $2, $3, $4, $5)', [
    orderId,
    it.sku,
    it.qty,
    'HELD',
    exp,
  ]);
}

/* ------------------------------------------------------------------ strategies */

/** The bug: read, decide in application code, write back a computed value. */
async function reserveNaive(orderId: string, items: Item[]) {
  const done: Item[] = [];
  const exp = expiresAt();
  try {
    for (const it of items) {
      const [row] = await db.query<{ available: number }>('stock.read', 'SELECT available FROM inventory.stock WHERE sku = $1', [it.sku]);
      if (!row || row.available < it.qty) throw new OutOfStock(it.sku);
      // "Validate the order, run fraud checks, compute the new value..." — the race window.
      await sleep(runtime.tuning.raceWindowMs);
      await db.query('stock.write_computed', 'UPDATE inventory.stock SET available = $2, reserved = reserved + $3, updated_at = now() WHERE sku = $1', [
        it.sku,
        row.available - it.qty,
        it.qty,
      ]);
      await db.query('reservation.insert', 'INSERT INTO inventory.reservations (order_id, sku, qty, status, expires_at) VALUES ($1, $2, $3, $4, $5)', [
        orderId,
        it.sku,
        it.qty,
        'HELD',
        exp,
      ]);
      done.push(it);
    }
  } catch (err) {
    if (done.length) await release(orderId, 'compensation').catch(() => undefined);
    throw err;
  }
}

async function reserveForUpdate(orderId: string, items: Item[]) {
  const exp = expiresAt();
  await db.tx('reserve.for_update', async (tx) => {
    for (const it of items) {
      const res = await tx.query<{ available: number }>('SELECT available FROM inventory.stock WHERE sku = $1 FOR UPDATE', [it.sku]);
      const row = res.rows[0];
      if (!row || row.available < it.qty) throw new OutOfStock(it.sku);
      await sleep(runtime.tuning.raceWindowMs); // same app logic, now inside the lock: the lock is held longer
      await tx.query('UPDATE inventory.stock SET available = available - $2, reserved = reserved + $2, updated_at = now() WHERE sku = $1', [
        it.sku,
        it.qty,
      ]);
      await insertReservation(tx, orderId, it, exp);
    }
  });
}

async function reserveAtomic(orderId: string, items: Item[]) {
  const exp = expiresAt();
  await db.tx('reserve.atomic', async (tx) => {
    for (const it of items) {
      const res = await tx.query(
        `UPDATE inventory.stock SET available = available - $2, reserved = reserved + $2, updated_at = now()
          WHERE sku = $1 AND available >= $2 RETURNING available`,
        [it.sku, it.qty],
      );
      if (res.rowCount === 0) throw new OutOfStock(it.sku);
      await insertReservation(tx, orderId, it, exp);
    }
  });
}

async function seedRedisStock(skus: string[]) {
  const rows = await db.query<{ sku: string; available: number }>('stock.read_many', 'SELECT sku, available FROM inventory.stock WHERE sku = ANY($1)', [
    skus,
  ]);
  await redis.run('stock_seed', async (r) => {
    const p = r.pipeline();
    for (const row of rows) p.set(stockKey(row.sku), String(Math.max(0, row.available)), 'NX');
    return p.exec();
  });
}

async function reserveRedis(orderId: string, items: Item[]) {
  const keys = items.map((i) => stockKey(i.sku));
  const qtys = items.map((i) => String(i.qty));
  let result: [number, number] = [-1, 0];
  for (let attempt = 0; attempt < 2; attempt++) {
    result = (await redis.run('reserve_lua', () => reserveScript(keys, qtys))) as [number, number];
    if (result[0] !== -1) break;
    await seedRedisStock(items.map((i) => i.sku));
  }
  if (result[0] === 0) throw new OutOfStock(items[result[1] - 1].sku);
  if (result[0] !== 1) throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'stock cache not initialised', true);
  // Redis is the gate; Postgres records the reservation. If this write fails we must give the units back.
  try {
    const exp = expiresAt();
    await db.tx('reserve.redis_persist', async (tx) => {
      for (const it of orderItems(items)) {
        await tx.query('UPDATE inventory.stock SET available = available - $2, reserved = reserved + $2, updated_at = now() WHERE sku = $1', [
          it.sku,
          it.qty,
        ]);
        await insertReservation(tx, orderId, it, exp);
      }
    });
  } catch (err) {
    await redis.run('release_lua', () => releaseScript(keys, qtys)).catch(() => undefined);
    throw err;
  }
}

/* ------------------------------------------------------------------ release / commit */

async function applyToStock(tx: Tx, rows: { sku: string; qty: number }[], sql: string) {
  const bySku = new Map<string, number>();
  for (const r of rows) bySku.set(r.sku, (bySku.get(r.sku) ?? 0) + r.qty);
  for (const sku of [...bySku.keys()].sort()) await tx.query(sql, [sku, bySku.get(sku)]);
  return bySku;
}

async function release(orderId: string, reason: string, status: 'RELEASED' | 'EXPIRED' = 'RELEASED') {
  const bySku = await db.tx('reservation.release', async (tx) => {
    const res = await tx.query<{ sku: string; qty: number }>(
      `UPDATE inventory.reservations SET status = $2, updated_at = now() WHERE order_id = $1 AND status = 'HELD' RETURNING sku, qty`,
      [orderId, status],
    );
    return applyToStock(tx, res.rows, 'UPDATE inventory.stock SET available = available + $2, reserved = reserved - $2, updated_at = now() WHERE sku = $1');
  });
  await giveBackToRedis(bySku);
  return { released: [...bySku.entries()].map(([sku, qty]) => ({ sku, qty })), reason };
}

async function giveBackToRedis(bySku: Map<string, number>) {
  if (!bySku.size || runtime.flag('inventory.reserve') !== 'redis_lua') return;
  const keys = [...bySku.keys()].map(stockKey);
  const qtys = [...bySku.values()].map(String);
  await redis.run('release_lua', () => releaseScript(keys, qtys)).catch(() => undefined);
}

/* ------------------------------------------------------------------ service */

void runService({
  name: 'inventory',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async (app) => {
    await redis.connect();
    // Variadic keys: the number of SKUs differs per call, so numberOfKeys is passed per call.
    reserveScript = variadic('bcReserve', RESERVE_LUA);
    releaseScript = variadic('bcRelease', RELEASE_LUA);

    // Leaving redis_lua mode: drop the Redis stock gate so it is re-seeded from Postgres next time.
    let lastStrategy = runtime.flag('inventory.reserve');
    runtime.on('change', () => {
      const next = runtime.flag('inventory.reserve');
      if (lastStrategy === 'redis_lua' && next !== 'redis_lua') {
        void redis
          .run('scan_del', async (r) => {
            const keys = await r.keys('bc:stock:*');
            if (keys.length) await r.del(...keys);
          })
          .catch(() => undefined);
      }
      lastStrategy = next;
    });

    app.get<{ Querystring: { skus?: string; productIds?: string } }>('/stock', async (req) => {
      const skus = String(req.query.skus ?? '').split(',').filter(Boolean).slice(0, 100);
      const pids = String(req.query.productIds ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 100);
      const rows = await db.query<{ sku: string; product_id: number; available: number; total: number }>(
        'stock.read_many',
        'SELECT sku, product_id, available, total FROM inventory.stock WHERE sku = ANY($1) OR product_id = ANY($2::bigint[])',
        [skus, pids],
      );
      return { items: rows.map((r) => ({ sku: r.sku, productId: r.product_id, available: Math.max(0, r.available), total: r.total })) };
    });

    app.post<{ Body: { orderId: string; items: Item[] } }>('/reservations', async (req) => {
      const { orderId, items } = req.body ?? ({} as never);
      if (!orderId || !Array.isArray(items) || !items.length) throw new HttpError(400, 'BAD_REQUEST', 'orderId and items required');
      for (const it of items) {
        if (typeof it.sku !== 'string' || !Number.isInteger(it.qty) || it.qty <= 0 || it.qty > 10) {
          throw new HttpError(400, 'BAD_REQUEST', 'invalid item');
        }
      }
      // Idempotent per order: a resumed checkout must not reserve the same order twice.
      const [held] = await db.query('reservation.exists', `SELECT 1 FROM inventory.reservations WHERE order_id = $1 AND status IN ('HELD', 'COMMITTED') LIMIT 1`, [
        orderId,
      ]);
      if (held) return { ok: true, orderId, replayed: true };
      const strategy = runtime.flag('inventory.reserve');
      const ordered = orderItems(items);
      const end = m.reservationDuration.startTimer({ strategy });
      try {
        if (strategy === 'naive_read_modify_write') await reserveNaive(orderId, ordered);
        else if (strategy === 'select_for_update') await reserveForUpdate(orderId, ordered);
        else if (strategy === 'atomic_conditional_update') await reserveAtomic(orderId, ordered);
        else await reserveRedis(orderId, ordered);
        m.reservations.inc({ strategy, result: 'ok' });
        return { ok: true, orderId, strategy };
      } catch (err) {
        if (err instanceof OutOfStock) {
          m.reservations.inc({ strategy, result: 'out_of_stock' });
          throw err;
        }
        if (err instanceof DbError && err.pgCode === '40P01') {
          m.reservations.inc({ strategy, result: 'deadlock' });
          throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'deadlock detected while reserving stock', true);
        }
        m.reservations.inc({ strategy, result: 'error' });
        throw err;
      } finally {
        end();
      }
    });

    /**
     * Re-arm a hold's expiry: before charging (so it cannot expire mid-payment) and after a
     * failed attempt (back to the normal window). Bounded, so an abandoned retry is still swept.
     */
    app.post<{ Params: { orderId: string }; Body: { ttlSec?: number } }>('/reservations/:orderId/extend', async (req) => {
      const ttlSec = Math.min(600, Math.max(5, Number(req.body?.ttlSec ?? 120) || 120));
      const rows = await db.query<{ status: string }>(
        'reservation.extend',
        `UPDATE inventory.reservations
            SET expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE now() + make_interval(secs => $2) END, updated_at = now()
          WHERE order_id = $1 AND status = 'HELD' RETURNING status`,
        [req.params.orderId, ttlSec],
      );
      if (!rows.length) throw new HttpError(409, 'RESERVATION_EXPIRED', 'reservation is no longer held');
      return { ok: true };
    });

    app.post<{ Params: { orderId: string } }>('/reservations/:orderId/commit', async (req) => {
      const orderId = req.params.orderId;
      const committed = await db.tx('reservation.commit', async (tx) => {
        const res = await tx.query<{ sku: string; qty: number }>(
          `UPDATE inventory.reservations SET status = 'COMMITTED', updated_at = now() WHERE order_id = $1 AND status = 'HELD' RETURNING sku, qty`,
          [orderId],
        );
        await applyToStock(tx, res.rows, 'UPDATE inventory.stock SET reserved = reserved - $2, sold = sold + $2, updated_at = now() WHERE sku = $1');
        return res.rowCount ?? 0;
      });
      if (committed === 0) {
        const [{ count }] = await db.query<{ count: number }>(
          'reservation.count_committed',
          `SELECT count(*)::int AS count FROM inventory.reservations WHERE order_id = $1 AND status = 'COMMITTED'`,
          [orderId],
        );
        if (count === 0) throw new HttpError(409, 'RESERVATION_EXPIRED', 'nothing to commit');
      }
      return { ok: true };
    });

    app.post<{ Params: { orderId: string }; Body: { reason?: string } }>('/reservations/:orderId/release', async (req) => {
      return release(req.params.orderId, String(req.body?.reason ?? 'released'));
    });
  },
  background: () => {
    // TTL sweeper: return stock held by abandoned checkouts.
    const sweep = async () => {
      if (runtime.flag('inventory.reservationTtl') !== 'expire_and_sweep') return;
      const expired = await db.query<{ order_id: string }>(
        'reservation.scan_expired',
        `SELECT DISTINCT order_id FROM inventory.reservations WHERE status = 'HELD' AND expires_at < now() LIMIT 200`,
      );
      let units = 0;
      for (const { order_id } of expired) {
        const out = await release(order_id, 'ttl', 'EXPIRED').catch(() => null);
        if (out) units += out.released.reduce((s, r) => s + r.qty, 0);
      }
      if (units > 0) {
        m.expiredReservations.inc(expired.length);
        emitEvent('info', 'reservations-expired', `Sweeper returned ${units} units from ${expired.length} abandoned checkouts`, undefined, {
          throttleMs: 10_000,
        });
      }
    };
    const loop = async () => {
      for (;;) {
        await sweep().catch((err) => logger.warn({ err: err.message }, 'sweeper failed'));
        await sleep(2000);
      }
    };
    void loop();

    // Hot SKU gauges.
    const gauges = async () => {
      for (;;) {
        try {
          const rows = await db.query<{ sku: string; available: number }>(
            'stock.hot_gauges',
            `SELECT sku, available FROM inventory.stock WHERE sku LIKE 'HOT-%'`,
          );
          for (const r of rows) m.availableUnits.set({ sku: r.sku }, r.available);
        } catch {
          /* pool exhausted etc. — try again later */
        }
        await sleep(2000);
      }
    };
    void gauges();
  },
  shutdown: async () => redis.disconnect(),
});
