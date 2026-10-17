import { db } from '../../shared/db';
import { emitEvent } from '../../shared/events';
import { m } from '../../shared/metrics';
import { runtime } from '../../shared/runtime';
import { runService } from '../../shared/server';
import { chance, HttpError, logNormal, sleep, uuid } from '../../shared/util';

/**
 * A mock third-party payment service provider (think card network / UPI switch).
 * It has its own ledger (payments.charges) and its own failure modes, all driven by
 * the "payments" chaos section:
 *
 *  - log-normal latency (median / p99)
 *  - declines
 *  - "late responses": the charge SUCCEEDS but the HTTP response only arrives after
 *    lateResponseMs — longer than the merchant's timeout. The merchant can't tell
 *    whether the customer was charged.
 *  - a PSP-side rate limit (429) and full outages (503)
 *
 * It honours an idempotency key when the merchant sends one.
 */

interface ChargeRow {
  id: string;
  order_id: string;
  idempotency_key: string | null;
  amount_cents: number;
  method: string;
  status: string;
  created_at: Date;
}

let bucket = { tokens: 0, at: Date.now() };
function pspRateLimited(): boolean {
  const limit = runtime.payments.rateLimitPerSec;
  if (limit <= 0) return false;
  const now = Date.now();
  bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.at) / 1000) * limit);
  bucket.at = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return false;
  }
  return true;
}

const toCharge = (r: ChargeRow) => ({
  id: r.id,
  orderId: r.order_id,
  amountCents: r.amount_cents,
  method: r.method,
  status: r.status,
  createdAt: r.created_at,
});

void runService({
  name: 'payments',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async (app) => {
    app.post<{ Body: { orderId: string; amountCents: number; method?: string; idempotencyKey?: string } }>('/charges', async (req, reply) => {
      const c = runtime.payments;
      const { orderId, amountCents, method = 'card', idempotencyKey } = req.body ?? ({} as never);
      if (!orderId || !Number.isInteger(amountCents) || amountCents <= 0) throw new HttpError(400, 'BAD_REQUEST', 'orderId and amountCents required');

      if (c.outage) {
        m.pspCharges.inc({ result: 'outage' });
        emitEvent('critical', 'psp-outage', 'Payment provider returning 503 (outage)', undefined, { throttleMs: 10_000 });
        throw new HttpError(503, 'PSP_UNAVAILABLE', 'payment provider unavailable', true);
      }
      if (pspRateLimited()) {
        m.pspCharges.inc({ result: 'rate_limited' });
        throw new HttpError(429, 'PSP_RATE_LIMITED', 'payment provider rate limit exceeded', true, { 'retry-after': '1' });
      }

      if (idempotencyKey) {
        const existing = await db.query<ChargeRow>('charge.by_key', 'SELECT * FROM payments.charges WHERE idempotency_key = $1', [idempotencyKey]);
        if (existing[0]) {
          m.pspCharges.inc({ result: 'idempotent_replay' });
          return reply.status(existing[0].status === 'SUCCEEDED' ? 200 : 402).send({ charge: toCharge(existing[0]), replayed: true });
        }
      }

      await sleep(logNormal(c.medianMs, c.p99Ms));
      const declined = chance(c.declinePct);
      const status = declined ? 'DECLINED' : 'SUCCEEDED';
      const rows = await db.query<ChargeRow>(
        'charge.insert',
        `INSERT INTO payments.charges (id, order_id, idempotency_key, amount_cents, method, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING *`,
        [uuid(), orderId, idempotencyKey ?? null, amountCents, method, status],
      );
      let row = rows[0];
      if (!row && idempotencyKey) {
        // Lost the race to a concurrent request with the same key — return the winner's result.
        row = (await db.query<ChargeRow>('charge.by_key', 'SELECT * FROM payments.charges WHERE idempotency_key = $1', [idempotencyKey]))[0];
        m.pspCharges.inc({ result: 'idempotent_replay' });
        return reply.status(row.status === 'SUCCEEDED' ? 200 : 402).send({ charge: toCharge(row), replayed: true });
      }

      if (declined) {
        m.pspCharges.inc({ result: 'declined' });
        return reply.status(402).send({ error: { code: 'PAYMENT_DECLINED', message: 'card declined by issuer', retryable: false }, charge: toCharge(row) });
      }
      m.pspCharges.inc({ result: 'succeeded' });
      m.pspChargedCents.inc(amountCents);

      if (chance(c.lateResponsePct)) {
        // Money has moved. The response is just very late.
        await sleep(c.lateResponseMs);
      }
      return { charge: toCharge(row) };
    });

    app.get<{ Querystring: { orderId?: string } }>('/charges', async (req) => {
      const orderId = String(req.query.orderId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new HttpError(400, 'BAD_REQUEST', 'orderId required');
      const rows = await db.query<ChargeRow>('charge.by_order', 'SELECT * FROM payments.charges WHERE order_id = $1 ORDER BY created_at', [orderId]);
      return { items: rows.map(toCharge) };
    });
  },
});
