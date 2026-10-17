// BreakCart k6 helpers: guest auth, a small API client, idempotency keys, the waiting-room
// protocol (docs/contract.md §2) and the shopper journey shared by flash-sale.js and soak.js.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

export const BASE_URL = (__ENV.BASE_URL || 'http://gateway:3000').replace(/\/+$/, '');
/** Flash-deal products are ids 1..12; the rest of the catalog is ids 13..100000. */
export const HOT_PRODUCT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
export const CATALOG_MAX_ID = 100000;
export const COUPON_CODE = 'BIGSALE500';
const SEARCH_TERMS = ['acme', 'bolt', 'cobalt', 'delta', 'ember', 'halo', 'wireless', 'pro', 'shoes', 'phone'];

// The gateway rate-limits anonymous calls (guest sign-in) per client IP and trusts the first
// X-Forwarded-For hop. From a single k6 container every VU would share one IP, so by default
// each session gets its own synthetic address. SPOOF_IPS=false turns this off.
const SPOOF_IPS = (__ENV.SPOOF_IPS || 'true') !== 'false';

// Only 5xx and transport errors count towards http_req_failed. 4xx answers (409 OUT_OF_STOCK,
// 429 RATE_LIMITED, 409 QUEUE_REQUIRED, 402 PAYMENT_DECLINED...) are correct answers from a
// healthy system; they are tracked by the business metrics below instead.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

export const metrics = {
  /** Checkout ended in a correct answer: order created, or an honest "no" (sold out, sale not started). */
  checkoutSuccess: new Rate('checkout_success'),
  /** Payment attempt for a created order ended PAID. */
  paymentSuccess: new Rate('payment_success'),
  ordersCreated: new Counter('orders_created'),
  ordersPaid: new Counter('orders_paid'),
  soldOut: new Counter('sold_out'),
  queueWait: new Trend('queue_wait', true),
  journeyDuration: new Trend('journey_duration', true),
  rateLimited: new Counter('rate_limited'),
  shed: new Counter('shed'),
  botBlocked: new Counter('bot_blocked'),
  paymentPending: new Counter('payment_pending'),
};

/* ------------------------------------------------------------------ small helpers */

export function think(minSec, maxSec) {
  sleep(minSec + Math.random() * (maxSec - minSec));
}

export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

/** UUID-v4-shaped key. Reuse the SAME key when retrying the same logical operation. */
export function idempotencyKey(prefix) {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  let s = '';
  for (let i = 0; i < 32; i++) s += hex();
  const variant = '89ab'[Math.floor(Math.random() * 4)];
  const uuid = `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20, 32)}`;
  return prefix ? `${prefix}-${uuid}` : uuid;
}

export function json(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

/** The `error.code` of a BreakCart error body, or null. */
export function errorCode(res) {
  const body = json(res);
  return body && body.error ? body.error.code : null;
}

/** Seconds from a Retry-After header (capped), or the fallback. */
export function retryAfter(res, fallbackSec = 1) {
  const n = Number(res.headers['Retry-After']);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : fallbackSec;
}

function syntheticIp() {
  const vu = exec.vu.idInTest;
  const it = exec.vu.iterationInScenario;
  return `10.${(vu >> 8) & 255}.${vu & 255}.${(it % 250) + 1}`;
}

/* ------------------------------------------------------------------ API client */

export class Client {
  /** @param {'shopper'|'bot'} persona */
  constructor(persona = 'shopper', { ip } = {}) {
    this.persona = persona;
    this.token = null;
    this.userId = null;
    this.ip = ip || (SPOOF_IPS ? syntheticIp() : null);
  }

  headers(extra) {
    const h = { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': `breakcart-k6/${this.persona}` };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.ip) h['X-Forwarded-For'] = this.ip;
    return Object.assign(h, extra || {});
  }

  /**
   * `endpoint` becomes both the `name` tag (keeps /api/orders/<id>/pay as ONE time series)
   * and the `endpoint` tag used by thresholds, e.g. http_req_duration{endpoint:checkout}.
   */
  request(method, path, body, endpoint, { headers, timeout } = {}) {
    const params = {
      headers: this.headers(headers),
      tags: { name: endpoint, endpoint, persona: this.persona },
      timeout: timeout || '30s',
    };
    return http.request(method, `${BASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), params);
  }

  get(path, endpoint, opts) {
    return this.request('GET', path, undefined, endpoint, opts);
  }

  post(path, body, endpoint, opts) {
    return this.request('POST', path, body === undefined ? {} : body, endpoint, opts);
  }

  del(path, endpoint, opts) {
    return this.request('DELETE', path, undefined, endpoint, opts);
  }

  /** POST /api/auth/guest → bearer token. Retries a rate-limited sign-in a couple of times. */
  login() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = this.post('/api/auth/guest', undefined, 'auth_guest');
      const body = json(res);
      if (res.status === 200 && body && body.token) {
        this.token = body.token;
        this.userId = body.userId;
        return true;
      }
      if (res.status === 429) {
        metrics.rateLimited.add(1);
        sleep(retryAfter(res));
        continue;
      }
      check(res, { 'guest sign-in ok': () => false });
      return false;
    }
    return false;
  }
}

/* ------------------------------------------------------------------ waiting room */

/**
 * Join the virtual waiting room and poll until admitted (contract §2): POST /api/queue/join,
 * then GET /api/queue/status?ticket= every ~2s until { admitted: true, pass }. Passes last 120s.
 */
export function waitForPass(client, { maxWaitSec = 180, pollSec = 2 } = {}) {
  const started = Date.now();
  const join = client.post('/api/queue/join', {}, 'queue_join');
  const joined = json(join);
  if (join.status !== 200 || !joined || !joined.ticket) return { pass: null, reason: `queue_join_${join.status}` };

  while ((Date.now() - started) / 1000 < maxWaitSec) {
    // Poll faster when we're near the front, never faster than every 0.5s.
    const eta = Number(joined.etaSec);
    sleep(Number.isFinite(eta) && eta < pollSec ? 0.5 : pollSec);
    const res = client.get(`/api/queue/status?ticket=${joined.ticket}`, 'queue_status');
    if (res.status === 429) {
      sleep(retryAfter(res));
      continue;
    }
    const st = json(res);
    if (res.status === 200 && st) {
      joined.etaSec = st.etaSec;
      if (st.admitted && st.pass) {
        metrics.queueWait.add(Date.now() - started);
        return { pass: st.pass };
      }
    }
  }
  return { pass: null, reason: 'queue_timeout' };
}

/* ------------------------------------------------------------------ checkout & pay */

/**
 * POST /api/checkout with an Idempotency-Key, handling QUEUE_REQUIRED (waiting room),
 * RATE_LIMITED (Retry-After), OVERLOADED (shed), REQUEST_IN_PROGRESS and retryable 5xx.
 * Retries of the same checkout reuse the same key, so a hardened server creates one order.
 * `backoff(res)` returns the seconds to wait after a 429/503 (default: honour Retry-After).
 *
 * @returns {{ outcome: string, order?: object }}
 */
export function checkout(client, { couponCode, maxAttempts = 4, queueWaitSec = 180, pollSec = 2, backoff = retryAfter } = {}) {
  let key = idempotencyKey('checkout');
  let pass = null;
  let queueJoins = 0;
  let body = couponCode ? { couponCode } : {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = { 'Idempotency-Key': key };
    if (pass) headers['X-Queue-Pass'] = pass;
    const res = client.post('/api/checkout', body, 'checkout', { headers });

    if (res.status === 201) {
      const order = (json(res) || {}).order;
      metrics.ordersCreated.add(1);
      metrics.checkoutSuccess.add(true);
      return { outcome: 'created', order };
    }

    const code = errorCode(res);
    switch (code) {
      case 'QUEUE_REQUIRED': {
        if (queueJoins++ >= 2) break; // pass rejected twice: give up
        const w = waitForPass(client, { maxWaitSec: queueWaitSec, pollSec });
        if (!w.pass) {
          metrics.checkoutSuccess.add(false);
          return { outcome: w.reason };
        }
        pass = w.pass;
        attempt--; // waiting in the queue is not a failed attempt
        continue;
      }
      case 'RATE_LIMITED':
        metrics.rateLimited.add(1);
        sleep(backoff(res));
        continue;
      case 'OVERLOADED':
        metrics.shed.add(1);
        sleep(backoff(res) + Math.random());
        continue;
      case 'REQUEST_IN_PROGRESS':
        sleep(0.5 + Math.random()); // same key is still being processed; ask again
        continue;
      case 'COUPON_EXHAUSTED':
        body = {}; // buy anyway without the coupon: a different request, so a new key
        key = idempotencyKey('checkout');
        continue;
      case 'PRICE_CHANGED':
        key = idempotencyKey('checkout'); // the customer accepts the new price and retries
        continue;
      case 'OUT_OF_STOCK':
        metrics.soldOut.add(1);
        metrics.checkoutSuccess.add(true); // an honest answer, not a failure
        return { outcome: 'sold_out' };
      case 'SALE_NOT_STARTED':
        metrics.checkoutSuccess.add(true);
        return { outcome: 'sale_not_started' };
      case 'BOT_SUSPECTED':
        metrics.botBlocked.add(1);
        metrics.checkoutSuccess.add(client.persona === 'bot');
        return { outcome: 'blocked' };
      default:
        if (res.status === 0 || res.status >= 500) {
          sleep(0.5 + Math.random()); // retryable: same key, so no duplicate order
          continue;
        }
    }
    break; // non-retryable 4xx (INVALID_STATE, NOT_FOUND, ...)
  }
  metrics.checkoutSuccess.add(false);
  return { outcome: 'failed' };
}

/** Poll GET /api/orders/:id until the order leaves PAYMENT_PENDING / PAYMENT_IN_PROGRESS. */
export function awaitPaymentResult(client, orderId, maxWaitSec = 30) {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxWaitSec) {
    sleep(2);
    const res = client.get(`/api/orders/${orderId}`, 'order_status');
    const body = json(res);
    const status = body && body.order ? body.order.status : null;
    if (status === 'PAID') return 'paid';
    if (status === 'PAYMENT_FAILED' || status === 'EXPIRED' || status === 'REJECTED') return 'failed';
  }
  return 'pending';
}

/**
 * POST /api/orders/:id/pay. On a timeout or 5xx the client retries with the SAME
 * Idempotency-Key — safe only when the server honours it (orders.idempotency=on). With the
 * flag off, exactly this retry produces duplicate charges (lab double-charge).
 */
export function pay(client, orderId, { method = 'card', maxAttempts = 3 } = {}) {
  const key = idempotencyKey('pay');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = client.post(`/api/orders/${orderId}/pay`, { method }, 'pay', { headers: { 'Idempotency-Key': key }, timeout: '20s' });
    let result = null;
    if (res.status === 200) result = 'paid';
    else if (res.status === 202) {
      metrics.paymentPending.add(1);
      result = awaitPaymentResult(client, orderId);
    } else {
      const code = errorCode(res);
      if (code === 'PAYMENT_DECLINED') result = 'declined';
      else if (code === 'RATE_LIMITED') {
        metrics.rateLimited.add(1);
        sleep(retryAfter(res));
        continue;
      } else if (code === 'REQUEST_IN_PROGRESS') {
        sleep(1);
        continue;
      } else if (res.status === 0 || res.status >= 500) {
        sleep(0.5 + Math.random());
        continue;
      } else result = 'failed';
    }
    if (result === 'paid') metrics.ordersPaid.add(1);
    metrics.paymentSuccess.add(result === 'paid');
    return result;
  }
  metrics.paymentSuccess.add(false);
  return 'failed';
}

/* ------------------------------------------------------------------ shopper journey */

function pickProduct(homeRes, hotShare) {
  const home = json(homeRes);
  const deals = home && Array.isArray(home.deals) ? home.deals.filter((d) => !d.stock || d.stock.available > 0) : [];
  if (Math.random() < hotShare) return deals.length ? pick(deals).id : pick(HOT_PRODUCT_IDS);
  return 13 + Math.floor(Math.random() * (CATALOG_MAX_ID - 13));
}

/**
 * One customer session: home → (browse / search) → product → cart → checkout → pay.
 * Think times are what make this a realistic open-model test: a shopper holds a VU for
 * ~10-25s, so concurrency = arrival rate x session time (Little's law).
 *
 * @returns {string} how the session ended
 */
export function shopperJourney({ buyShare = 0.6, hotShare = 0.7, couponShare = 0.25, queueWaitSec = 180 } = {}) {
  const started = Date.now();
  const c = new Client('shopper');
  const end = (result) => {
    metrics.journeyDuration.add(Date.now() - started, { result });
    return result;
  };
  if (!c.login()) return end('failed');

  const home = c.get('/api/home', 'home');
  check(home, { 'home is 200': (r) => r.status === 200 });
  think(1.5, 4);

  const r = Math.random();
  if (r < 0.2) {
    c.get(`/api/search?q=${pick(SEARCH_TERMS)}`, 'search');
    think(1, 3);
  } else if (r < 0.45) {
    c.get(`/api/products?page=${1 + Math.floor(Math.random() * 3)}&pageSize=24`, 'products');
    think(1, 3);
  }

  const productId = pickProduct(home, hotShare);
  const product = c.get(`/api/products/${productId}`, 'product');
  check(product, { 'product is 200': (res) => res.status === 200 });
  think(2, 5); // reading the page (bot protection expects >= 1.5s on hot SKUs)
  if (Math.random() > buyShare) return end('browsed');

  const add = c.post('/api/cart/items', { productId, qty: 1 }, 'add_to_cart');
  if (add.status !== 200) {
    const code = errorCode(add);
    if (code === 'BOT_SUSPECTED') metrics.botBlocked.add(1);
    if (code === 'OUT_OF_STOCK') metrics.soldOut.add(1);
    return end(code ? code.toLowerCase() : 'failed');
  }
  think(1, 3);
  c.get('/api/cart', 'cart');

  const co = checkout(c, { couponCode: Math.random() < couponShare ? COUPON_CODE : undefined, queueWaitSec });
  if (co.outcome !== 'created' || !co.order) return end(co.outcome);
  think(2, 5); // entering payment details

  const paid = pay(c, co.order.id, { method: Math.random() < 0.5 ? 'card' : 'upi' });
  if (paid === 'paid' && Math.random() < 0.5) {
    think(1, 2);
    c.get('/api/orders', 'my_orders');
  }
  return end(paid);
}

/** setup() helper: fail fast with a clear message when the gateway is unreachable. */
export function preflight() {
  const res = http.get(`${BASE_URL}/api/sale`, { tags: { name: 'preflight', endpoint: 'preflight' } });
  if (res.status !== 200) {
    exec.test.abort(`gateway not reachable at ${BASE_URL} (status ${res.status}). Set BASE_URL or check the docker network.`);
  }
  const sale = json(res) || {};
  console.log(`BreakCart sale "${sale.name}": live=${sale.live} startsAt=${sale.startsAt} endsAt=${sale.endsAt}`);
  return sale;
}
