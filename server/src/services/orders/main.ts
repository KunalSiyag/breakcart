import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../shared/db';
import { emitEvent } from '../../shared/events';
import { Upstream } from '../../shared/http-client';
import { logger } from '../../shared/logger';
import { m } from '../../shared/metrics';
import { COUPON_CODE } from '../../shared/defs';
import { DataRedis } from '../../shared/redis';
import { isLive, SaleClock } from '../../shared/sale';
import { runtime } from '../../shared/runtime';
import { fwd, runService } from '../../shared/server';
import { HttpError, sleep, uuid } from '../../shared/util';
import { orderIdFor } from './ids';
import { getOrder, markPaid, setStatus, toOrder, type ItemRow, type Order, type OrderRow } from './repo';

const redis = new DataRedis();
const sale = new SaleClock(redis);
const cart = Upstream.for('cart');
const catalog = Upstream.for('catalog');
const inventory = Upstream.for('inventory');
const payments = Upstream.for('payments');

interface CartLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  priceVersion: number;
}

interface Outcome {
  status: number;
  body: unknown;
}

function userOf(req: FastifyRequest): string {
  const u = req.headers['x-user-id'];
  if (typeof u !== 'string' || !u) throw new HttpError(401, 'UNAUTHENTICATED', 'missing user');
  return u;
}

function errorOutcome(err: HttpError): Outcome {
  return { status: err.status, body: { error: { code: err.code, message: err.message, retryable: err.retryable } } };
}

/* ------------------------------------------------------------ idempotency */

/**
 * Idempotency-Key handling (orders.idempotency = on):
 *  - first request claims the key (SET NX) and stores its final outcome;
 *  - a concurrent duplicate gets 409 REQUEST_IN_PROGRESS;
 *  - a later duplicate gets the stored outcome replayed byte-for-byte;
 *  - transient failures (5xx) release the key so the client can retry.
 */
async function withIdempotency(kind: string, req: FastifyRequest, reply: FastifyReply, fn: () => Promise<Outcome>) {
  const send = (o: Outcome) => reply.status(o.status).send(o.body);
  const run = async (): Promise<Outcome> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) return errorOutcome(err);
      throw err;
    }
  };

  if (runtime.flag('orders.idempotency') === 'off') return send(await run());

  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key header required (8-128 chars)');
  }
  const rkey = `bc:idem:${kind}:${userOf(req)}:${key}`;
  const claimed = await redis.run('idem_claim', (r) => r.set(rkey, 'IN_PROGRESS', 'EX', 3600, 'NX'));
  if (claimed !== 'OK') {
    const stored = await redis.run('idem_get', (r) => r.get(rkey));
    if (!stored || stored === 'IN_PROGRESS') {
      m.checkouts.inc({ result: 'in_progress' });
      throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'an identical request is still being processed', true);
    }
    if (kind === 'checkout') m.checkouts.inc({ result: 'duplicate_replayed' });
    else m.payments.inc({ result: 'replayed' });
    reply.header('idempotent-replayed', 'true');
    return send(JSON.parse(stored) as Outcome);
  }
  let outcome: Outcome;
  try {
    outcome = await run();
  } catch (err) {
    await redis.run('idem_release', (r) => r.del(rkey)).catch(() => undefined);
    throw err;
  }
  if (outcome.status >= 500) await redis.run('idem_release', (r) => r.del(rkey)).catch(() => undefined);
  else await redis.run('idem_store', (r) => r.set(rkey, JSON.stringify(outcome), 'EX', 86_400)).catch(() => undefined);
  return send(outcome);
}

/* ------------------------------------------------------------ coupons */

/** Sale coupons ("first 200 orders after midnight") only work while the sale is live. */
const SALE_ONLY_COUPONS = new Set([COUPON_CODE]);

async function redeemCoupon(code: string, orderId: string, userId: string, subtotal: number): Promise<number> {
  // A resumed checkout may already hold this coupon: never redeem twice for one order.
  const [already] = await db.query<{ discount_cents: number }>(
    'coupon.already_redeemed',
    `SELECT c.discount_cents FROM orders.coupon_redemptions r JOIN orders.coupons c ON c.code = r.code WHERE r.code = $1 AND r.order_id = $2`,
    [code, orderId],
  );
  if (already) return Math.min(already.discount_cents, subtotal);
  if (SALE_ONLY_COUPONS.has(code)) {
    const s = await sale.get();
    if (!isLive(s, Date.now())) throw new HttpError(409, 'COUPON_NOT_APPLICABLE', 'this coupon is valid only during the sale');
  }
  const mode = runtime.flag('orders.coupon');
  if (mode === 'check_then_act') {
    const [c] = await db.query<{ used: number; max_uses: number; discount_cents: number; min_subtotal_cents: number }>(
      'coupon.read',
      'SELECT used, max_uses, discount_cents, min_subtotal_cents FROM orders.coupons WHERE code = $1',
      [code],
    );
    if (!c) throw new HttpError(400, 'INVALID_COUPON', 'unknown coupon');
    if (subtotal < c.min_subtotal_cents) throw new HttpError(409, 'COUPON_NOT_APPLICABLE', 'cart total too low for this coupon');
    if (c.used >= c.max_uses) {
      m.couponRedemptions.inc({ result: 'exhausted' });
      throw new HttpError(409, 'COUPON_EXHAUSTED', 'this coupon has been fully redeemed');
    }
    await sleep(runtime.tuning.raceWindowMs);
    await db.query('coupon.increment', 'UPDATE orders.coupons SET used = used + 1 WHERE code = $1', [code]);
    await db.query('coupon.redeem', 'INSERT INTO orders.coupon_redemptions (code, order_id, user_id) VALUES ($1, $2, $3)', [code, orderId, userId]);
    m.couponRedemptions.inc({ result: 'ok' });
    return Math.min(c.discount_cents, subtotal);
  }
  const discount = await db.tx('coupon.atomic', async (tx) => {
    const res = await tx.query<{ discount_cents: number }>(
      `UPDATE orders.coupons SET used = used + 1
        WHERE code = $1 AND used < max_uses AND min_subtotal_cents <= $2
        RETURNING discount_cents`,
      [code, subtotal],
    );
    if (!res.rows[0]) return null;
    await tx.query('INSERT INTO orders.coupon_redemptions (code, order_id, user_id) VALUES ($1, $2, $3)', [code, orderId, userId]);
    return res.rows[0].discount_cents;
  });
  if (discount === null) {
    const [c] = await db.query<{ used: number; max_uses: number; min_subtotal_cents: number }>(
      'coupon.read',
      'SELECT used, max_uses, min_subtotal_cents FROM orders.coupons WHERE code = $1',
      [code],
    );
    if (!c) throw new HttpError(400, 'INVALID_COUPON', 'unknown coupon');
    if (subtotal < c.min_subtotal_cents) throw new HttpError(409, 'COUPON_NOT_APPLICABLE', 'cart total too low for this coupon');
    m.couponRedemptions.inc({ result: 'exhausted' });
    throw new HttpError(409, 'COUPON_EXHAUSTED', 'this coupon has been fully redeemed');
  }
  m.couponRedemptions.inc({ result: 'ok' });
  return Math.min(discount, subtotal);
}

async function unredeemCoupon(code: string, orderId: string) {
  await db
    .tx('coupon.compensate', async (tx) => {
      const res = await tx.query('DELETE FROM orders.coupon_redemptions WHERE code = $1 AND order_id = $2', [code, orderId]);
      if (res.rowCount) await tx.query('UPDATE orders.coupons SET used = used - 1 WHERE code = $1', [code]);
    })
    .catch((err) => logger.warn({ err: err.message }, 'coupon compensation failed'));
}

/* ------------------------------------------------------------ checkout */

/** Business rejections are replayed to a retry; anything else was transient and may be retried. */
const FINAL_REJECTIONS = new Set(['OUT_OF_STOCK', 'PRICE_CHANGED', 'COUPON_EXHAUSTED', 'COUPON_NOT_APPLICABLE', 'INVALID_COUPON']);

async function checkout(req: FastifyRequest<{ Body: { couponCode?: string } }>): Promise<Outcome> {
  const userId = userOf(req);
  const couponCode = req.body?.couponCode ? String(req.body.couponCode).trim().toUpperCase().slice(0, 32) : null;
  const key = req.headers['idempotency-key'] as string | undefined;
  // With idempotency on, every step below is a recovery point: an attempt that failed half-way
  // (after creating the order, after reserving stock, or just before answering) is resumed by
  // the retry, not repeated. The naive mode mints a fresh order id per attempt.
  const resumable = runtime.flag('orders.idempotency') === 'on' && !!key;
  const orderId = resumable ? orderIdFor(userId, key!) : uuid();

  let resumed = false;
  if (resumable) {
    const [prev] = await db.query<OrderRow>('order.by_id', 'SELECT * FROM orders.orders WHERE id = $1', [orderId]);
    if (prev && prev.status === 'REJECTED' && !FINAL_REJECTIONS.has(prev.failure_reason ?? '')) {
      // The earlier attempt failed for a transient reason (and gave back its coupon): start over.
      await db.query('order.discard_rejected', `DELETE FROM orders.orders WHERE id = $1 AND status = 'REJECTED'`, [orderId]);
    } else if (prev && prev.status === 'REJECTED') {
      const code = prev.failure_reason!;
      throw new HttpError(409, code, `this checkout was already rejected: ${code}`);
    } else if (prev && prev.status !== 'CREATED') {
      // It went through — only the answer was lost. Replay it.
      m.checkouts.inc({ result: 'duplicate_replayed' });
      return { status: 201, body: { order: await getOrder(orderId) } };
    } else if (prev) {
      resumed = true; // CREATED: the order exists; carry on from the reservation step
    }
  }

  let items: { sku: string; qty: number }[];
  let discount = 0;
  if (resumed) {
    items = await db.query<{ sku: string; qty: number }>('order.items_for_resume', 'SELECT sku, qty FROM orders.order_items WHERE order_id = $1', [orderId]);
    const [o] = await db.query<{ discount_cents: number }>('order.discount', 'SELECT discount_cents FROM orders.orders WHERE id = $1', [orderId]);
    discount = o?.discount_cents ?? 0;
  } else {
    const { items: lines } = await cart.json<{ items: CartLine[] }>({ path: '/cart', headers: fwd(req) });
    if (!lines.length) throw new HttpError(409, 'INVALID_STATE', 'cart is empty');

    // Pricing: trust the (possibly cached, possibly skewed) cart quote, or re-read the source of truth.
    let priced = lines.map((l) => ({ ...l }));
    if (runtime.flag('orders.pricing') === 'authoritative') {
      const { items: fresh } = await catalog.json<{ items: { id: number; priceCents: number; priceVersion: number }[] }>({
        path: '/prices',
        query: { ids: lines.map((l) => l.productId).join(',') },
        headers: fwd(req),
      });
      const byId = new Map(fresh.map((p) => [p.id, p]));
      const changed = lines.filter((l) => byId.get(l.productId)?.priceCents !== l.unitPriceCents);
      if (changed.length) {
        m.checkouts.inc({ result: 'price_changed' });
        throw new HttpError(409, 'PRICE_CHANGED', `price changed for ${changed.map((c) => c.name).join(', ')} — please review your cart`);
      }
      priced = lines.map((l) => ({ ...l, unitPriceCents: byId.get(l.productId)!.priceCents, priceVersion: byId.get(l.productId)!.priceVersion }));
    }

    const subtotal = priced.reduce((s, l) => s + l.unitPriceCents * l.qty, 0);
    if (couponCode) {
      try {
        discount = await redeemCoupon(couponCode, orderId, userId, subtotal);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'COUPON_EXHAUSTED') m.checkouts.inc({ result: 'coupon_exhausted' });
        throw err;
      }
    }

    const created = await db.tx('order.create', async (tx) => {
      const res = await tx.query(
        `INSERT INTO orders.orders (id, user_id, status, subtotal_cents, discount_cents, total_cents, coupon_code, idempotency_key)
         VALUES ($1, $2, 'CREATED', $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [orderId, userId, subtotal, discount, subtotal - discount, discount ? couponCode : null, key ?? null],
      );
      if (!res.rowCount) return false;
      for (const l of priced) {
        await tx.query(
          'INSERT INTO orders.order_items (order_id, product_id, sku, name, qty, unit_price_cents, price_version) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [orderId, l.productId, l.sku, l.name, l.qty, l.unitPriceCents, l.priceVersion],
        );
      }
      return true;
    });
    if (!created) throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'an identical checkout is being processed', true);
    items = priced.map((l) => ({ sku: l.sku, qty: l.qty }));
  }

  try {
    // Idempotent per order id in inventory: a resumed attempt does not reserve twice.
    await inventory.json({ method: 'POST', path: '/reservations', body: { orderId, items }, headers: fwd(req), idempotent: false });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 'INTERNAL';
    await setStatus(orderId, 'REJECTED', code).catch(() => undefined);
    if (discount && couponCode) await unredeemCoupon(couponCode, orderId);
    m.checkouts.inc({ result: code === 'OUT_OF_STOCK' ? 'out_of_stock' : 'error' });
    throw err;
  }

  await setStatus(orderId, 'AWAITING_PAYMENT');
  await markWrite(userId);
  m.checkouts.inc({ result: resumed ? 'resumed' : 'created' });
  return { status: 201, body: { order: await getOrder(orderId) } };
}

/* ------------------------------------------------------------ pay */

async function pay(req: FastifyRequest<{ Params: { id: string }; Body: { method?: string } }>): Promise<Outcome> {
  const userId = userOf(req);
  const orderId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(404, 'NOT_FOUND', 'order not found');
  const method = req.body?.method === 'upi' ? 'upi' : 'card';
  const safe = runtime.flag('orders.idempotency') === 'on';

  let order: OrderRow | undefined;
  if (safe) {
    // Compare-and-set: exactly one request can move the order into PAYMENT_IN_PROGRESS.
    [order] = await db.query<OrderRow>(
      'order.cas_pay',
      `UPDATE orders.orders SET status = 'PAYMENT_IN_PROGRESS', payment_attempts = payment_attempts + 1, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'AWAITING_PAYMENT' RETURNING *`,
      [orderId, userId],
    );
    if (!order) {
      const current = await getOrder(orderId, userId);
      if (!current) throw new HttpError(404, 'NOT_FOUND', 'order not found');
      if (current.status === 'PAID') return { status: 200, body: { order: current } };
      if (current.status === 'PAYMENT_PENDING') return { status: 202, body: { order: current } };
      if (current.status === 'PAYMENT_IN_PROGRESS') throw new HttpError(409, 'REQUEST_IN_PROGRESS', 'payment already in progress', true);
      throw new HttpError(409, 'INVALID_STATE', `order is ${current.status}`);
    }
  } else {
    // The naive version: read, check, write. Two concurrent requests both see AWAITING_PAYMENT.
    [order] = await db.query<OrderRow>('order.read', 'SELECT * FROM orders.orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'order not found');
    if (order.status === 'PAID') return { status: 200, body: { order: await getOrder(orderId) } };
    if (order.status !== 'AWAITING_PAYMENT' && order.status !== 'PAYMENT_IN_PROGRESS') {
      throw new HttpError(409, 'INVALID_STATE', `order is ${order.status}`);
    }
    await sleep(runtime.tuning.raceWindowMs);
    await db.query('order.set_in_progress', `UPDATE orders.orders SET status = 'PAYMENT_IN_PROGRESS', payment_attempts = payment_attempts + 1, updated_at = now() WHERE id = $1`, [orderId]);
  }

  // Make sure the stock hold is alive (and won't expire mid-payment) before taking money.
  try {
    await inventory.json({
      method: 'POST',
      path: `/reservations/${orderId}/extend`,
      // Longer than the reconciler's 60s stall threshold: a payment that stalls is resolved by the
      // reconciler while its stock is still held.
      body: { ttlSec: Math.ceil(runtime.tuning.paymentTimeoutMs / 1000) + 120 },
      headers: fwd(req),
      idempotent: true,
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'RESERVATION_EXPIRED') {
      await setStatus(orderId, 'EXPIRED', 'reservation expired');
      m.payments.inc({ result: 'expired' });
      throw new HttpError(409, 'ORDER_EXPIRED', 'your reservation expired — please check out again');
    }
    await setStatus(orderId, 'AWAITING_PAYMENT', 'inventory unavailable');
    throw err;
  }

  let res;
  try {
    res = await payments.call<{ charge?: { status: string }; error?: { code: string; message: string } }>({
      method: 'POST',
      path: '/charges',
      body: { orderId, amountCents: order.total_cents, method, idempotencyKey: safe ? `order-${orderId}` : undefined },
      headers: fwd(req),
      timeoutMs: runtime.tuning.paymentTimeoutMs,
      idempotent: safe,
    });
  } catch (err) {
    const e = err as HttpError;
    const timedOut = e.status === 504;
    if (timedOut && runtime.flag('orders.paymentTimeout') === 'pending_reconcile') {
      // We don't know. Say so, and find out.
      await setStatus(orderId, 'PAYMENT_PENDING', 'psp timeout — reconciling');
      m.payments.inc({ result: 'pending' });
      emitEvent('warn', 'payment-pending', 'PSP timed out — orders parked in PAYMENT_PENDING for reconciliation');
      return { status: 202, body: { order: await getOrder(orderId) } };
    }
    if (timedOut) {
      // The bug: a timeout is NOT a failure. The PSP may well have charged the customer.
      await setStatus(orderId, 'PAYMENT_FAILED', 'psp timeout');
      await inventory.json({ method: 'POST', path: `/reservations/${orderId}/release`, body: { reason: 'payment timeout' }, headers: fwd(req) }).catch(() => undefined);
      m.payments.inc({ result: 'timeout' });
      emitEvent('warn', 'payment-timeout', 'PSP timed out — orders marked FAILED and stock released (customers may have been charged!)');
      throw new HttpError(504, 'PAYMENT_TIMEOUT', 'payment timed out — please try again');
    }
    await setStatus(orderId, 'AWAITING_PAYMENT', 'payment provider unreachable');
    await rearmHold(req, orderId);
    m.payments.inc({ result: 'error' });
    throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'payment provider unavailable — please retry', true);
  }

  if (res.status === 200) {
    await markPaid(redis, { id: orderId, userId, totalCents: order.total_cents });
    await inventory.json({ method: 'POST', path: `/reservations/${orderId}/commit`, headers: fwd(req), idempotent: true }).catch(async (err) => {
      // The money has moved; the stock hold must not be allowed to expire and be sold again.
      // Queue the commit for the reconciler to retry until inventory takes it.
      logger.warn({ err: err.message, orderId }, 'commit failed after payment — queued for retry');
      emitEvent('warn', 'commit-failed', 'Payment captured but stock commit failed — queued for retry');
      await redis.run('commit_retry_add', (r) => r.sadd(COMMIT_RETRY_KEY, orderId)).catch(() => undefined);
    });
    await cart.call({ method: 'DELETE', path: '/cart', headers: fwd(req) }).catch(() => undefined);
    await markWrite(userId);
    m.payments.inc({ result: 'paid' });
    return { status: 200, body: { order: await getOrder(orderId) } };
  }
  if (res.status === 402) {
    // Keep the reservation so the customer can retry with another card — for the normal hold
    // window only, so the TTL sweeper still cleans up if they walk away.
    await setStatus(orderId, 'AWAITING_PAYMENT', 'PAYMENT_DECLINED');
    await rearmHold(req, orderId);
    m.payments.inc({ result: 'declined' });
    throw new HttpError(402, 'PAYMENT_DECLINED', 'your bank declined the payment — try another method');
  }
  await setStatus(orderId, 'AWAITING_PAYMENT', `psp ${res.status}`);
  await rearmHold(req, orderId);
  m.payments.inc({ result: res.status === 429 ? 'rate_limited' : 'error' });
  throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'payment provider busy — please retry', true, { 'retry-after': '2' });
}

/** After a failed payment attempt: give the hold the normal window again (best effort). */
async function rearmHold(req: FastifyRequest, orderId: string) {
  await inventory
    .json({ method: 'POST', path: `/reservations/${orderId}/extend`, body: { ttlSec: runtime.tuning.reservationTtlSec }, headers: fwd(req), idempotent: true })
    .catch(() => undefined);
}

/* ------------------------------------------------------------ reads (primary vs lagging replica) */

const recentWriteKey = (userId: string) => `bc:ryw:${userId}`;

async function markWrite(userId: string) {
  await redis.run('ryw_mark', (r) => r.set(recentWriteKey(userId), '1', 'EX', 15)).catch(() => undefined);
}

/**
 * Simulated asynchronous replica: rows created within the lag window are invisible and
 * orders paid within it still look unpaid — exactly what a lagging read replica serves.
 */
async function useReplica(userId: string): Promise<boolean> {
  if (runtime.data.replicaLagMs <= 0) return false;
  if (runtime.flag('orders.readConsistency') === 'replica') return true;
  const recent = await redis.run('ryw_check', (r) => r.exists(recentWriteKey(userId))).catch(() => 1);
  return recent === 0;
}

function replicaView(rows: OrderRow[]): { row: OrderRow; status?: string }[] {
  const horizon = Date.now() - runtime.data.replicaLagMs;
  return rows
    .filter((o) => o.created_at.getTime() <= horizon)
    .map((o) => ({ row: o, status: o.paid_at && o.paid_at.getTime() > horizon ? 'AWAITING_PAYMENT' : undefined }));
}

async function listOrders(userId: string): Promise<Order[]> {
  const rows = await db.query<OrderRow>('order.list', 'SELECT * FROM orders.orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
  const view = (await useReplica(userId)) ? replicaView(rows) : rows.map((row) => ({ row, status: undefined }));
  if (!view.length) return [];
  const items = await db.query<ItemRow>('order.items_many', 'SELECT * FROM orders.order_items WHERE order_id = ANY($1::uuid[])', [view.map((v) => v.row.id)]);
  return view.map((v) => toOrder(v.row, items.filter((i) => i.order_id === v.row.id), v.status));
}

/* ------------------------------------------------------------ reconciler */

/** Paid orders whose stock commit failed; the reconciler retries them. */
const COMMIT_RETRY_KEY = 'bc:commit-retry';
/** Commits retried at once: one at a time, a slow inventory turns the queue into a backlog. */
const COMMIT_RETRY_CONCURRENCY = 10;

/**
 * Retry stock commits for paid orders. Inventory's commit is idempotent. If the hold has
 * already expired, the unit may have been sold to someone else: that can't be fixed here,
 * so it is raised loudly (and the auditor's paid-uncommitted invariant counts it).
 */
async function retryStockCommits() {
  const ids = ((await redis.run('commit_retry_list', (r) => r.srandmember(COMMIT_RETRY_KEY, 100)).catch(() => [])) ?? []) as string[];
  for (let i = 0; i < ids.length; i += COMMIT_RETRY_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + COMMIT_RETRY_CONCURRENCY).map(retryStockCommit));
  }
}

async function retryStockCommit(id: string) {
  try {
    await inventory.json({ method: 'POST', path: `/reservations/${id}/commit`, idempotent: true });
    await redis.run('commit_retry_done', (r) => r.srem(COMMIT_RETRY_KEY, id));
    m.reconciled.inc({ result: 'stock_committed' });
  } catch (err) {
    // Anything but an expired hold means inventory is still unavailable: try again next round.
    if (!(err instanceof HttpError && err.code === 'RESERVATION_EXPIRED')) return;
    await redis.run('commit_retry_done', (r) => r.srem(COMMIT_RETRY_KEY, id)).catch(() => undefined);
    // The order itself is gone after a data reset: nothing was sold twice.
    const [order] = await db.query<{ status: string }>('reconcile.commit_retry_order', 'SELECT status FROM orders.orders WHERE id = $1', [id]);
    if (order?.status !== 'PAID') return;
    m.reconciled.inc({ result: 'stock_lost' });
    emitEvent('critical', 'paid-uncommitted', `Order ${id} was paid but its stock hold expired before the commit — the unit may have been sold twice`, undefined, {
      throttleMs: 0,
    });
  }
}

/** Checkouts that failed half-way and were never retried: give the stock and coupon back. */
async function expireAbandonedCheckouts() {
  const rows = await db.query<{ id: string; coupon_code: string | null; discount_cents: number }>(
    'reconcile.abandoned_checkouts',
    `SELECT id, coupon_code, discount_cents FROM orders.orders WHERE status = 'CREATED' AND updated_at < now() - interval '2 minutes' LIMIT 50`,
  );
  for (const o of rows) {
    await inventory.json({ method: 'POST', path: `/reservations/${o.id}/release`, body: { reason: 'checkout abandoned mid-way' } }).catch(() => undefined);
    if (o.discount_cents && o.coupon_code) await unredeemCoupon(o.coupon_code, o.id);
    await setStatus(o.id, 'REJECTED', 'ABANDONED').catch(() => undefined);
    m.reconciled.inc({ result: 'checkout_abandoned' });
  }
}

async function reconcileOnce() {
  await retryStockCommits().catch((err) => logger.warn({ err: err.message }, 'stock-commit retry failed'));
  await expireAbandonedCheckouts().catch((err) => logger.warn({ err: err.message }, 'abandoned-checkout sweep failed'));
  if (runtime.flag('orders.paymentTimeout') !== 'pending_reconcile') return;
  const rows = await db.query<OrderRow>(
    'reconcile.scan',
    `SELECT * FROM orders.orders
      WHERE (status = 'PAYMENT_PENDING' AND updated_at < now() - interval '2 seconds')
         OR (status = 'PAYMENT_IN_PROGRESS' AND updated_at < now() - interval '60 seconds')
      ORDER BY updated_at LIMIT 50`,
  );
  for (const o of rows) {
    try {
      const { items } = await payments.json<{ items: { status: string }[] }>({ path: '/charges', query: { orderId: o.id } });
      if (items.some((c) => c.status === 'SUCCEEDED')) {
        await markPaid(redis, { id: o.id, userId: o.user_id, totalCents: o.total_cents });
        await inventory.json({ method: 'POST', path: `/reservations/${o.id}/commit`, idempotent: true }).catch(async () => {
          await redis.run('commit_retry_add', (r) => r.sadd(COMMIT_RETRY_KEY, o.id)).catch(() => undefined);
        });
        m.reconciled.inc({ result: 'paid' });
      } else if (Date.now() - o.updated_at.getTime() > Math.max(30_000, runtime.payments.lateResponseMs * 2)) {
        await setStatus(o.id, 'PAYMENT_FAILED', 'no charge found at PSP');
        await inventory.json({ method: 'POST', path: `/reservations/${o.id}/release`, body: { reason: 'reconcile: not charged' } }).catch(() => undefined);
        m.reconciled.inc({ result: 'failed' });
      } else {
        m.reconciled.inc({ result: 'still_unknown' });
      }
    } catch {
      m.reconciled.inc({ result: 'error' });
    }
  }
}

void runService({
  name: 'orders',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async (app) => {
    await redis.connect();

    app.post<{ Body: { couponCode?: string } }>('/checkout', async (req, reply) => withIdempotency('checkout', req, reply, () => checkout(req)));

    app.post<{ Params: { id: string }; Body: { method?: string } }>('/orders/:id/pay', async (req, reply) =>
      withIdempotency('pay', req, reply, () => pay(req)),
    );

    app.get('/orders', async (req) => ({ items: await listOrders(userOf(req)) }));

    app.get<{ Params: { id: string } }>('/orders/:id', async (req) => {
      const userId = userOf(req);
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'NOT_FOUND', 'order not found');
      const rows = await db.query<OrderRow>('order.get', 'SELECT * FROM orders.orders WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
      const view = rows.length && (await useReplica(userId)) ? replicaView(rows) : rows.map((row) => ({ row, status: undefined }));
      if (!view.length) throw new HttpError(404, 'NOT_FOUND', 'order not found');
      const items = await db.query<ItemRow>('order.items', 'SELECT * FROM orders.order_items WHERE order_id = $1', [req.params.id]);
      return { order: toOrder(view[0].row, items, view[0].status) };
    });
  },
  background: () => {
    const lagGauge = () => m.replicaLag.set(runtime.data.replicaLagMs / 1000);
    lagGauge();
    runtime.on('change', lagGauge);
    void (async () => {
      for (;;) {
        await reconcileOnce().catch((err) => logger.warn({ err: err.message }, 'reconcile failed'));
        await sleep(2000);
      }
    })();
  },
  shutdown: async () => redis.disconnect(),
});
