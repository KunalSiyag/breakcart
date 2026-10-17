import type Redis from 'ioredis';
import { db } from '../../shared/db';
import { KEYS } from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import { m } from '../../shared/metrics';

/**
 * Business invariant auditor — the "finance reconciliation job" of BreakCart. It reads
 * across every service's schema and counts things that must never happen. A system can
 * be 100% "green" on latency and errors while violating these.
 */
export interface Integrity {
  checkedAt: string;
  violations: {
    oversoldUnits: number;
    negativeStockSkus: number;
    duplicateOrders: number;
    duplicateCharges: number;
    orphanCharges: number;
    couponOverRedemptions: number;
    priceMismatches: number;
    stuckOrders: number;
    lostEvents: number;
    phantomHeldUnits: number;
    paidUncommitted: number;
  };
  oversoldSkus: { sku: string; name: string; total: number; claimed: number }[];
  totals: { orders: number; paidOrders: number; gmvCents: number; charges: number; shipments: number; unitsSold: number; dlqDepth: number };
}

const one = async (op: string, sql: string): Promise<number> => {
  const rows = await db.query<{ n: number }>(op, sql);
  return Number(rows[0]?.n ?? 0);
};

export async function checkIntegrity(redis: Redis): Promise<Integrity> {
  const [
    oversoldSkus,
    negativeStockSkus,
    duplicateOrders,
    duplicateCharges,
    orphanCharges,
    couponOverRedemptions,
    priceMismatches,
    stuckOrders,
    lostEvents,
    phantomHeldUnits,
    paidUncommitted,
    totals,
  ] = await Promise.all([
    db.query<{ sku: string; name: string; total: number; claimed: number }>(
      'integrity.oversold',
      `SELECT s.sku, p.name, s.total, r.claimed::int AS claimed
         FROM (SELECT sku, sum(qty) AS claimed FROM inventory.reservations
                WHERE status IN ('HELD', 'COMMITTED') GROUP BY sku) r
         JOIN inventory.stock s ON s.sku = r.sku
         JOIN catalog.products p ON p.id = s.product_id
        WHERE r.claimed > s.total
        ORDER BY r.claimed - s.total DESC`,
    ),
    one('integrity.negative', 'SELECT count(*)::int AS n FROM inventory.stock WHERE available < 0'),
    one(
      'integrity.dup_orders',
      `SELECT COALESCE(sum(c - 1), 0)::int AS n FROM (
         SELECT count(*) AS c FROM orders.orders
          WHERE idempotency_key IS NOT NULL AND status <> 'REJECTED'
          GROUP BY user_id, idempotency_key HAVING count(*) > 1) x`,
    ),
    one(
      'integrity.dup_charges',
      `SELECT COALESCE(sum(c - 1), 0)::int AS n FROM (
         SELECT count(*) AS c FROM payments.charges WHERE status = 'SUCCEEDED' GROUP BY order_id HAVING count(*) > 1) x`,
    ),
    one(
      'integrity.orphan_charges',
      `SELECT count(DISTINCT c.order_id)::int AS n
         FROM payments.charges c JOIN orders.orders o ON o.id = c.order_id
        WHERE c.status = 'SUCCEEDED'
          AND o.status IN ('PAYMENT_FAILED', 'EXPIRED', 'REJECTED', 'AWAITING_PAYMENT')
          AND c.created_at < now() - interval '5 seconds'`,
    ),
    one(
      'integrity.coupons',
      `SELECT COALESCE(sum(GREATEST(c.used - c.max_uses, COALESCE(r.n, 0) - c.max_uses, 0)), 0)::int AS n
         FROM orders.coupons c
         LEFT JOIN (SELECT code, count(*) AS n FROM orders.coupon_redemptions GROUP BY code) r ON r.code = c.code`,
    ),
    // A line is mispriced if neither the price at order time nor 3s before (in-flight reads) matches what was charged.
    one(
      'integrity.prices',
      `WITH items AS (
         SELECT oi.unit_price_cents, oi.product_id, o.created_at, p.is_deal
           FROM orders.order_items oi
           JOIN orders.orders o ON o.id = oi.order_id
           JOIN catalog.products p ON p.id = oi.product_id
          WHERE o.status <> 'REJECTED' AND o.created_at > now() - interval '2 hours')
       SELECT count(*)::int AS n FROM items i
        WHERE NOT EXISTS (
          SELECT 1
            FROM (VALUES (i.created_at), (i.created_at - interval '3 seconds')) AS t(ts)
            CROSS JOIN LATERAL (
              SELECT price_cents, deal_price_cents FROM catalog.price_history
               WHERE product_id = i.product_id AND valid_from <= t.ts
               ORDER BY valid_from DESC LIMIT 1) ph
           WHERE i.unit_price_cents = CASE
                   WHEN i.is_deal AND ph.deal_price_cents IS NOT NULL
                    AND EXISTS (SELECT 1 FROM catalog.sale_windows w WHERE t.ts >= w.starts_at AND t.ts < w.ends_at)
                   THEN ph.deal_price_cents ELSE ph.price_cents END)`,
    ).catch(() => 0),
    one(
      'integrity.stuck',
      `SELECT count(*)::int AS n FROM orders.orders
        WHERE status IN ('CREATED', 'PAYMENT_IN_PROGRESS', 'PAYMENT_PENDING') AND updated_at < now() - interval '2 minutes'`,
    ),
    one(
      'integrity.lost_events',
      `SELECT count(*)::int AS n FROM orders.orders o
         LEFT JOIN fulfillment.shipments s ON s.order_id = o.id
        WHERE o.status = 'PAID' AND o.paid_at < now() - interval '30 seconds' AND s.order_id IS NULL`,
    ),
    one(
      'integrity.phantom',
      `SELECT COALESCE(sum(qty), 0)::int AS n FROM inventory.reservations
        WHERE status = 'HELD' AND created_at < now() - interval '90 seconds'`,
    ),
    // Paid, but the stock hold never became a sale: the unit can expire back into stock and be sold twice.
    one(
      'integrity.paid_uncommitted',
      `SELECT count(*)::int AS n FROM orders.orders o
        WHERE o.status = 'PAID' AND o.paid_at < now() - interval '30 seconds'
          AND NOT EXISTS (SELECT 1 FROM inventory.reservations r WHERE r.order_id = o.id AND r.status = 'COMMITTED')`,
    ),
    db.query<{ orders: number; paid: number; gmv: number; charges: number; shipments: number; sold: number }>(
      'integrity.totals',
      `SELECT (SELECT count(*) FROM orders.orders)::int AS orders,
              (SELECT count(*) FROM orders.orders WHERE status = 'PAID')::int AS paid,
              (SELECT COALESCE(sum(total_cents), 0) FROM orders.orders WHERE status = 'PAID')::bigint AS gmv,
              (SELECT count(*) FROM payments.charges WHERE status = 'SUCCEEDED')::int AS charges,
              (SELECT count(*) FROM fulfillment.shipments)::int AS shipments,
              (SELECT COALESCE(sum(sold), 0) FROM inventory.stock WHERE sold > 0)::int AS sold`,
    ),
  ]);

  const dlqDepth = await redis.xlen(KEYS.orderDlq).catch(() => 0);
  const t = totals[0];
  return {
    checkedAt: new Date().toISOString(),
    violations: {
      oversoldUnits: oversoldSkus.reduce((s, r) => s + (r.claimed - r.total), 0),
      negativeStockSkus,
      duplicateOrders,
      duplicateCharges,
      orphanCharges,
      couponOverRedemptions,
      priceMismatches,
      stuckOrders,
      lostEvents,
      phantomHeldUnits,
      paidUncommitted,
    },
    oversoldSkus: oversoldSkus.slice(0, 20),
    totals: {
      orders: t.orders,
      paidOrders: t.paid,
      gmvCents: Number(t.gmv),
      charges: t.charges,
      shipments: t.shipments,
      unitsSold: t.sold,
      dlqDepth,
    },
  };
}

const KIND_LABEL: Record<keyof Integrity['violations'], [string, string]> = {
  oversoldUnits: ['oversold_units', 'Oversold units'],
  negativeStockSkus: ['negative_stock_skus', 'SKUs with negative stock'],
  duplicateOrders: ['duplicate_orders', 'Duplicate orders'],
  duplicateCharges: ['duplicate_charges', 'Duplicate charges'],
  orphanCharges: ['orphan_charges', 'Customers charged without a paid order'],
  couponOverRedemptions: ['coupon_over_redemptions', 'Coupon redemptions over the cap'],
  priceMismatches: ['price_mismatches', 'Order lines charged at the wrong price'],
  stuckOrders: ['stuck_orders', 'Orders stuck in a transient state > 2 min'],
  lostEvents: ['lost_events', 'Paid orders not fulfilled after 30s'],
  phantomHeldUnits: ['phantom_held_units', 'Units held by abandoned checkouts > 90s'],
  paidUncommitted: ['paid_uncommitted', 'Paid orders whose stock was never committed'],
};

const CRITICAL = new Set(['oversoldUnits', 'duplicateCharges', 'orphanCharges', 'negativeStockSkus', 'paidUncommitted']);
let previous: Integrity['violations'] | null = null;

/** Export gauges and raise timeline events when a violation count increases. */
export function publishIntegrity(r: Integrity) {
  for (const [k, v] of Object.entries(r.violations) as [keyof Integrity['violations'], number][]) {
    m.integrity.set({ kind: KIND_LABEL[k][0] }, v);
    const before = previous?.[k] ?? 0;
    if (v > before) {
      emitEvent(CRITICAL.has(k) ? 'critical' : 'warn', `integrity-${k}`, `${KIND_LABEL[k][1]}: ${before} → ${v}`, undefined, { throttleMs: 10_000 });
    }
  }
  previous = { ...r.violations };
}

export function resetIntegrityBaseline() {
  previous = null;
}
