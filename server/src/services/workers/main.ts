import { db } from '../../shared/db';
import { KEYS } from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import { logger } from '../../shared/logger';
import { m } from '../../shared/metrics';
import { DataRedis, rawRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { runService } from '../../shared/server';
import { sleep } from '../../shared/util';

/**
 * Async side of the platform:
 *  1. Fulfillment consumer — reads OrderPaid events from a Redis stream (consumer group),
 *     creates a shipment and a notification. Poison messages either block the partition
 *     forever (retry_forever) or go to a DLQ (dead_letter).
 *  2. Outbox relay — publishes rows from orders.outbox to the stream (orders.eventPublishing = outbox).
 *  3. Lag / backlog gauges.
 */
const GROUP = 'fulfillment';
// Stable name so a restarted worker picks up its own un-acked entries.
const CONSUMER = 'fulfillment-1';
const MAX_ATTEMPTS = 3;

const redis = new DataRedis();
const blocking = rawRedis('workers-stream');

type Entry = [id: string, fields: string[]];

function fieldsToObj(fields: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return o;
}

async function ensureGroup() {
  try {
    await blocking.xgroup('CREATE', KEYS.orderStream, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
  }
}

async function handle(fields: Record<string, string>) {
  const slow = runtime.data.consumerSlowMs;
  if (slow > 0) await sleep(slow);
  const event = JSON.parse(fields.payload) as { orderId: string };
  if (!event.orderId) throw new Error('event without orderId');
  await db.tx('fulfillment.handle', async (tx) => {
    const res = await tx.query(`INSERT INTO fulfillment.shipments (order_id, status) VALUES ($1, 'READY_TO_SHIP') ON CONFLICT DO NOTHING`, [event.orderId]);
    if (res.rowCount) await tx.query(`INSERT INTO fulfillment.notifications (order_id, kind) VALUES ($1, 'order_confirmation_email')`, [event.orderId]);
  });
}

async function consumeLoop() {
  await ensureGroup();
  const attempts = new Map<string, number>();
  // Start by re-processing anything this consumer left un-acked, then new entries.
  let cursor = '0';
  for (;;) {
    try {
      if (runtime.data.consumerPaused) {
        await sleep(500);
        continue;
      }
      const res = (await blocking.xreadgroup('GROUP', GROUP, CONSUMER, 'COUNT', 20, 'BLOCK', 1000, 'STREAMS', KEYS.orderStream, cursor)) as
        | [string, Entry[]][]
        | null;
      const entries = res?.[0]?.[1] ?? [];
      if (cursor === '0' && entries.length === 0) {
        cursor = '>';
        continue;
      }
      for (const [id, raw] of entries) {
        const fields = fieldsToObj(raw);
        try {
          await handle(fields);
          await blocking.xack(KEYS.orderStream, GROUP, id);
          attempts.delete(id);
          m.streamProcessed.inc({ result: 'ok' });
        } catch (err) {
          const n = (attempts.get(id) ?? 0) + 1;
          attempts.set(id, n);
          m.streamProcessed.inc({ result: 'failed' });
          if (runtime.flag('workers.poisonMessages') === 'dead_letter' && n >= MAX_ATTEMPTS) {
            await blocking.xadd(KEYS.orderDlq, '*', ...raw, 'error', String((err as Error).message).slice(0, 200), 'sourceId', id);
            await blocking.xack(KEYS.orderStream, GROUP, id);
            attempts.delete(id);
            m.streamProcessed.inc({ result: 'dead_lettered' });
            emitEvent('warn', 'dead-lettered', `Moved poison message ${id} to the DLQ after ${n} attempts`);
          } else {
            emitEvent(
              'critical',
              'poison-pill',
              `Fulfillment consumer stuck on message ${id} (attempt ${n}): ${(err as Error).message}`,
              undefined,
              { throttleMs: 5000 },
            );
            // Head-of-line blocking: go back and re-read our pending entries from the start.
            cursor = '0';
            await sleep(200);
            break;
          }
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'consume loop error');
      await sleep(1000);
      await ensureGroup().catch(() => undefined);
    }
  }
}

async function relayLoop() {
  for (;;) {
    try {
      if (runtime.flag('orders.eventPublishing') === 'outbox') {
        const published = await db.tx('outbox.relay', async (tx) => {
          const res = await tx.query<{ id: number; aggregate_id: string; event_type: string; payload: { raw: string } }>(
            'SELECT id, aggregate_id, event_type, payload FROM orders.outbox WHERE published_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED',
          );
          if (!res.rows.length) return 0;
          await redis.run('xadd_batch', (r) => {
            const p = r.pipeline();
            for (const row of res.rows) p.xadd(KEYS.orderStream, '*', 'type', row.event_type, 'orderId', row.aggregate_id, 'payload', row.payload.raw);
            return p.exec();
          });
          await tx.query('UPDATE orders.outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [res.rows.map((r) => r.id)]);
          return res.rows.length;
        });
        if (published) {
          m.outboxRelayed.inc(published);
          continue;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'outbox relay failed (will retry — at-least-once)');
    }
    await sleep(250);
  }
}

async function gaugeLoop() {
  for (;;) {
    try {
      const groups = (await blocking.xinfo('GROUPS', KEYS.orderStream)) as unknown[][];
      for (const g of groups) {
        const o: Record<string, unknown> = {};
        for (let i = 0; i < g.length; i += 2) o[String(g[i])] = g[i + 1];
        if (o.name !== GROUP) continue;
        m.streamLag.set({ stream: 'orders', group: GROUP }, Number(o.lag ?? 0));
        m.streamPending.set({ stream: 'orders', group: GROUP }, Number(o.pending ?? 0));
        const lag = Number(o.lag ?? 0) + Number(o.pending ?? 0);
        if (lag > 500) emitEvent('warn', 'consumer-lag', `Fulfillment consumer lag: ${lag} events behind`, undefined, { throttleMs: 15_000 });
      }
      m.dlqLength.set(await blocking.xlen(KEYS.orderDlq));
      const [{ count }] = await db.query<{ count: number }>('outbox.backlog', 'SELECT count(*)::int AS count FROM orders.outbox WHERE published_at IS NULL');
      m.outboxUnpublished.set(count);
    } catch {
      /* stream may not exist yet */
    }
    await sleep(2000);
  }
}

void runService({
  name: 'workers',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async () => {
    await redis.connect();
  },
  background: () => {
    void consumeLoop();
    void relayLoop();
    void gaugeLoop();
  },
  shutdown: async () => {
    redis.disconnect();
    blocking.disconnect();
  },
});
