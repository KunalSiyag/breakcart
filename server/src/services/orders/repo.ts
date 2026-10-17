import { db, type Tx } from '../../shared/db';
import { KEYS } from '../../shared/defs';
import { m } from '../../shared/metrics';
import type { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { chance } from '../../shared/util';

export interface OrderRow {
  id: string;
  user_id: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  coupon_code: string | null;
  idempotency_key: string | null;
  failure_reason: string | null;
  payment_attempts: number;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface ItemRow {
  order_id: string;
  product_id: number;
  sku: string;
  name: string;
  qty: number;
  unit_price_cents: number;
  price_version: number;
}

export function toOrder(o: OrderRow, items: ItemRow[], statusOverride?: string) {
  return {
    id: o.id,
    status: statusOverride ?? o.status,
    totalCents: o.total_cents,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    couponCode: o.coupon_code,
    items: items.map((i) => ({ productId: i.product_id, sku: i.sku, name: i.name, qty: i.qty, unitPriceCents: i.unit_price_cents })),
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    failureReason: o.failure_reason,
  };
}

export type Order = ReturnType<typeof toOrder>;

export async function getOrder(id: string, userId?: string): Promise<Order | null> {
  const rows = await db.query<OrderRow>(
    'order.get',
    userId ? 'SELECT * FROM orders.orders WHERE id = $1 AND user_id = $2' : 'SELECT * FROM orders.orders WHERE id = $1',
    userId ? [id, userId] : [id],
  );
  if (!rows[0]) return null;
  const items = await db.query<ItemRow>('order.items', 'SELECT * FROM orders.order_items WHERE order_id = $1', [id]);
  return toOrder(rows[0], items);
}

export async function setStatus(id: string, status: string, failureReason: string | null = null): Promise<void> {
  await db.query('order.set_status', 'UPDATE orders.orders SET status = $2, failure_reason = $3, updated_at = now() WHERE id = $1', [
    id,
    status,
    failureReason,
  ]);
}

/* ------------------------------------------------------------ events */

function eventPayload(order: { id: string; userId: string; totalCents: number }): string {
  if (chance(runtime.data.poisonPct)) {
    // A producer bug ships a malformed event (think: schema change deployed before consumers).
    return `{"orderId":"${order.id}","totalCents":`;
  }
  return JSON.stringify({ orderId: order.id, userId: order.userId, totalCents: order.totalCents, paidAt: new Date().toISOString() });
}

/**
 * Mark an order PAID and emit OrderPaid.
 *  - dual_write: commit, then XADD. Anything that fails between the two loses the event forever.
 *  - outbox:     insert the event in the same transaction; the workers' relay publishes it.
 */
export async function markPaid(redis: DataRedis, order: { id: string; userId: string; totalCents: number }): Promise<boolean> {
  const mode = runtime.flag('orders.eventPublishing');
  const payload = eventPayload(order);
  const updated = await db.tx('order.mark_paid', async (tx: Tx) => {
    const res = await tx.query(
      `UPDATE orders.orders SET status = 'PAID', paid_at = now(), updated_at = now(), failure_reason = NULL
        WHERE id = $1 AND status <> 'PAID'`,
      [order.id],
    );
    if (res.rowCount && mode === 'outbox') {
      await tx.query('INSERT INTO orders.outbox (aggregate_id, event_type, payload) VALUES ($1, $2, $3::jsonb)', [
        order.id,
        'OrderPaid',
        JSON.stringify({ raw: payload }),
      ]);
    }
    return (res.rowCount ?? 0) > 0;
  });
  if (!updated) return false;
  m.gmv.inc(order.totalCents);

  if (mode === 'dual_write') {
    try {
      if (chance(runtime.data.eventPublishFailPct)) throw new Error('broker write failed (chaos)');
      await redis.run('xadd', (r) => r.xadd(KEYS.orderStream, '*', 'type', 'OrderPaid', 'orderId', order.id, 'payload', payload));
      m.eventsPublished.inc({ mode, result: 'ok' });
    } catch {
      // The order is PAID in Postgres but fulfillment will never hear about it.
      m.eventsPublished.inc({ mode, result: 'failed' });
    }
  } else {
    m.eventsPublished.inc({ mode, result: 'ok' });
  }
  return true;
}
