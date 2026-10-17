import { COUPON_CODE, HOT_PRODUCT_IDS } from '../shared/defs';
import type { Behaviour } from '../shared/scenarios';
import { chance, logNormal, pick, uuid, zipfIndex } from '../shared/util';
import type { Api, Resp } from './client';

export type Persona = 'shopper' | 'bot';
export type SessionResult = 'converted' | 'abandoned' | 'failed' | 'blocked' | 'sold_out';

export interface VuContext {
  api: Api;
  b: Behaviour;
  ip: string;
  /** False once the scenario stopped — sessions exit at the next step. */
  alive: () => boolean;
  anomaly: (kind: string) => void;
  takeToken: () => string | undefined;
  returnToken: (t: string) => void;
  /** Sleep that resolves early when the scenario stops. */
  sleep: (ms: number) => Promise<void>;
}

/** Hot deals in order of desirability (the ₹1 box and the flagship phone first). */
const HOT_BY_DEMAND = [1, 12, 2, 4, 5, 3, 6, 7, 11, 10, 8, 9].filter((id) => HOT_PRODUCT_IDS.includes(id));
const SEARCH_TERMS = ['phone', 'laptop', 'headphones', 'sneakers', 'smartwatch', 'smart tv', 'air fryer', 'gaming', 'pro max', 'kettle', 'jacket', 'yoga mat'];
const CATEGORIES = ['Mobiles', 'Laptops', 'TVs', 'Audio', 'Wearables', 'Fashion', 'Footwear', 'Home', 'Kitchen', 'Beauty', 'Gaming'];

class Exit extends Error {
  constructor(readonly result: SessionResult) {
    super(result);
  }
}

const think = (ctx: VuContext, ms: number) => ctx.sleep(Math.min(20_000, logNormal(ms, ms * 4)));
const hotPick = (b?: Behaviour) => {
  const pool = b?.hotProducts?.length ? b.hotProducts : HOT_BY_DEMAND;
  return pool[zipfIndex(pool.length, b?.hotProducts?.length ? 0.3 : 1.2)];
};
const isOverload = (r: Resp) => r.status === 0 || r.status >= 500 || r.status === 429;

/* ================================================================== shopper */

export async function shopper(ctx: VuContext): Promise<SessionResult> {
  const { api, b, ip } = ctx;
  const guard = () => {
    if (!ctx.alive()) throw new Exit('abandoned');
  };
  /** A page load. Slow or broken pages get refreshed (rage clicks) — or the customer leaves. */
  const page = async (step: string, path: string, token?: string, query?: Record<string, string | number>) => {
    let r = await api.call(step, 'GET', path, { token, ip, query, timeoutMs: b.patienceMs });
    for (let i = 0; i < 2 && isOverload(r) && chance(b.rageRetryProb * 100); i++) {
      await ctx.sleep(150 + Math.random() * 600);
      r = await api.call(step, 'GET', path, { token, ip, query, timeoutMs: b.patienceMs });
    }
    if (isOverload(r)) throw new Exit('failed');
    return r;
  };

  try {
    // 1. Session: returning visitors reuse a token, new visitors sign in as guest.
    let token = chance(b.returningProb * 100) ? ctx.takeToken() : undefined;
    if (!token) {
      const r = await api.call('auth', 'POST', '/api/auth/guest', { ip });
      if (r.status !== 200) throw new Exit(r.status === 429 ? 'blocked' : 'failed');
      token = r.body.token as string;
    }
    const tk = token;

    // 2. Land on the home page.
    guard();
    const home = await page('home', '/api/home', tk);
    await think(ctx, b.thinkMs);

    // 3. Find a product.
    guard();
    let productId: number;
    if (chance(b.hotFocus * 100)) {
      productId = hotPick(b);
      const live = (home.body?.deals ?? []).find((d: { id: number }) => d.id === productId);
      if (live?.stock && live.stock.available === 0 && chance(70)) throw new Exit('sold_out');
    } else if (chance(b.searchProb * 100)) {
      const r = await page('search', '/api/search', tk, { q: pick(SEARCH_TERMS) });
      const items = r.body?.items ?? [];
      if (!items.length) throw new Exit('abandoned');
      productId = pick(items as { id: number }[]).id;
      await think(ctx, b.thinkMs);
    } else {
      const r = await page('category', '/api/products', tk, { category: pick(CATEGORIES), page: 1 + Math.floor(Math.random() * 3) });
      const items = r.body?.items ?? [];
      if (!items.length) throw new Exit('abandoned');
      productId = pick(items as { id: number }[]).id;
      await think(ctx, b.thinkMs);
    }

    // 4. Product page.
    guard();
    const pdp = await page('product', `/api/products/${productId}`, tk);
    if (pdp.body?.stock && pdp.body.stock.available === 0) throw new Exit('sold_out');
    await think(ctx, b.thinkMs);
    if (!chance(b.addToCartProb * 100)) throw new Exit('abandoned');

    // 5. Add to cart (sometimes a second hot item, in whatever order the customer clicks).
    const add = async (id: number) => {
      guard();
      const r = await api.call('add_to_cart', 'POST', '/api/cart/items', { token: tk, ip, body: { productId: id, qty: 1 } });
      if (r.error === 'BOT_SUSPECTED') {
        ctx.anomaly('human_blocked_as_bot');
        throw new Exit('blocked');
      }
      if (isOverload(r)) throw new Exit('failed');
    };
    await add(productId);
    // More items, in whatever order the customer happens to click them.
    const inCart = new Set([productId]);
    for (const p of [b.multiItemProb, b.multiItemProb * (b.thirdItemProb ?? 0)]) {
      if (!chance(p * 100)) break;
      const next = hotPick(b);
      if (inCart.has(next)) continue;
      inCart.add(next);
      await page('product', `/api/products/${next}`, tk);
      await think(ctx, b.thinkMs);
      await add(next);
    }
    await think(ctx, b.thinkMs / 2);

    // 6. Cart + checkout.
    guard();
    await page('view_cart', '/api/cart', tk);
    if (!chance(b.checkoutProb * 100)) {
      ctx.returnToken(tk);
      throw new Exit('abandoned');
    }
    const order = await checkout(ctx, tk, chance(b.couponProb * 100) ? COUPON_CODE : undefined);
    if (typeof order === 'string') throw new Exit(order);

    // 7. Payment page — some customers walk away here (their stock stays reserved).
    await think(ctx, b.thinkMs);
    guard();
    if (!chance(b.payProb * 100)) throw new Exit('abandoned');
    const paid = await pay(ctx, tk, order.id);
    if (paid !== 'converted') throw new Exit(paid);

    // 8. "Where's my order?"
    await ctx.sleep(300 + Math.random() * 700);
    const check = await api.call('order_status', 'GET', `/api/orders/${order.id}`, { token: tk, ip });
    if (check.status === 404 || (check.status === 200 && check.body?.order?.status !== 'PAID')) {
      ctx.anomaly('order_missing_after_pay');
      await api.call('order_status', 'GET', '/api/orders', { token: tk, ip });
      if (chance(30)) {
        // Frustrated customer buys it again.
        ctx.anomaly('repurchased_after_missing_order');
        try {
          await add(productId);
          const again = await checkout(ctx, tk, undefined);
          if (typeof again !== 'string') await pay(ctx, tk, again.id);
        } catch {
          /* the first purchase still counts */
        }
      }
    }
    ctx.returnToken(tk);
    return 'converted';
  } catch (err) {
    if (err instanceof Exit) return err.result;
    return 'failed';
  }
}

/** Checkout with Idempotency-Key, waiting room handling and client retries. Returns the order or a session result. */
async function checkout(ctx: VuContext, token: string, coupon: string | undefined): Promise<{ id: string } | SessionResult> {
  const { api, b, ip } = ctx;
  let pass: string | undefined;
  let couponCode = coupon;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!ctx.alive()) return 'abandoned';
    const key = uuid();
    const send = () =>
      api.call('checkout', 'POST', '/api/checkout', {
        token,
        ip,
        body: couponCode ? { couponCode } : {},
        headers: { 'idempotency-key': key, 'x-queue-pass': pass },
        timeoutMs: 20_000,
      });
    let r: Resp;
    if (chance(b.doubleClickProb * 100)) {
      const both = await Promise.all([send(), ctx.sleep(30 + Math.random() * 120).then(send)]);
      r = both.find((x) => x.status === 201) ?? both[0];
    } else {
      r = await send();
    }
    if (r.code === 'timeout') r = await send(); // the app retries with the same key
    if (r.status === 201) return r.body.order as { id: string };

    switch (r.error) {
      case 'QUEUE_REQUIRED':
        pass = await waitInQueue(ctx, token, 2000);
        if (!pass) return 'abandoned';
        continue;
      case 'OUT_OF_STOCK':
        return 'sold_out';
      case 'PRICE_CHANGED':
        ctx.anomaly('price_changed_at_checkout');
        await api.call('view_cart', 'GET', '/api/cart', { token, ip });
        continue;
      case 'COUPON_EXHAUSTED':
      case 'COUPON_NOT_APPLICABLE':
        couponCode = undefined;
        continue;
      case 'BOT_SUSPECTED':
        ctx.anomaly('human_blocked_as_bot');
        return 'blocked';
      case 'INVALID_STATE':
        return 'failed';
      default:
        if (r.status === 0 || r.status >= 500 || r.status === 429 || r.error === 'REQUEST_IN_PROGRESS') {
          await ctx.sleep(r.retryAfterMs ?? 800 + Math.random() * 1200);
          continue;
        }
        return 'failed';
    }
  }
  return 'failed';
}

async function waitInQueue(ctx: VuContext, token: string, pollMs: number): Promise<string | undefined> {
  const { api, ip, b } = ctx;
  const join = await api.call('queue', 'POST', '/api/queue/join', { token, ip });
  if (join.status !== 200) return undefined;
  const ticket = join.body.ticket as number;
  // People wait in a queue far longer than they wait for a spinner.
  const giveUpAt = Date.now() + Math.max(60_000, b.patienceMs * 15);
  while (Date.now() < giveUpAt && ctx.alive()) {
    await ctx.sleep(pollMs);
    const s = await api.call('queue', 'GET', '/api/queue/status', { token, ip, query: { ticket } });
    if (s.status === 200 && s.body.admitted) return s.body.pass as string;
  }
  return undefined;
}

async function pay(ctx: VuContext, token: string, orderId: string): Promise<SessionResult> {
  const { api, b, ip } = ctx;
  let method: 'card' | 'upi' = chance(60) ? 'upi' : 'card';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!ctx.alive()) return 'abandoned';
    const key = uuid();
    const send = () =>
      api.call('pay', 'POST', `/api/orders/${orderId}/pay`, { token, ip, body: { method }, headers: { 'idempotency-key': key }, timeoutMs: 30_000 });
    let r: Resp;
    if (chance(b.doubleClickProb * 100)) {
      const both = await Promise.all([send(), ctx.sleep(50 + Math.random() * 150).then(send)]);
      r = both.find((x) => x.status === 200) ?? both.find((x) => x.status === 202) ?? both[0];
    } else {
      r = await send();
    }
    if (r.code === 'timeout') r = await send();
    if (r.status === 200) return 'converted';
    if (r.status === 202) {
      // "We're confirming your payment…"
      for (let i = 0; i < 15 && ctx.alive(); i++) {
        await ctx.sleep(2000);
        const s = await api.call('order_status', 'GET', `/api/orders/${orderId}`, { token, ip });
        const st = s.body?.order?.status;
        if (st === 'PAID') return 'converted';
        if (st === 'PAYMENT_FAILED') return 'failed';
      }
      return 'abandoned';
    }
    switch (r.error) {
      case 'PAYMENT_DECLINED':
        method = method === 'upi' ? 'card' : 'upi';
        await think(ctx, b.thinkMs);
        continue;
      case 'PAYMENT_TIMEOUT':
        // "Payment failed, please try again" — so they do.
        await ctx.sleep(1000 + Math.random() * 2000);
        continue;
      case 'ORDER_EXPIRED':
      case 'INVALID_STATE':
      case 'NOT_FOUND':
        return 'failed';
      default:
        if (r.status === 0 || r.status >= 500 || r.status === 429 || r.error === 'REQUEST_IN_PROGRESS') {
          await ctx.sleep(r.retryAfterMs ?? 1000 + Math.random() * 1500);
          continue;
        }
        return 'failed';
    }
  }
  return 'failed';
}

/* ================================================================== bot */

/**
 * Scalper bot: fresh accounts, no browsing, machine-speed retries that ignore Retry-After.
 * ~30% are "smart" bots that fake a product view and wait out the timing check.
 */
export async function bot(ctx: VuContext): Promise<SessionResult> {
  const { api, ip } = ctx;
  const smart = chance(30);
  const target = chance(60) ? 12 : pick([1, 2, 4, 5]);
  let accounts = 0;
  try {
    while (accounts < 3 && ctx.alive()) {
      accounts++;
      const auth = await api.call('auth', 'POST', '/api/auth/guest', { ip });
      if (auth.status !== 200) {
        await ctx.sleep(100);
        continue;
      }
      const token = auth.body.token as string;
      if (smart) {
        await ctx.sleep(3100); // wait out "fresh account"
        await api.call('product', 'GET', `/api/products/${target}`, { token, ip });
        await ctx.sleep(1600);
      }
      let carted = false;
      for (let i = 0; i < 15 && ctx.alive(); i++) {
        const r = await api.call('add_to_cart', 'POST', '/api/cart/items', { token, ip, body: { productId: target, qty: 2 } });
        if (r.status === 200) {
          carted = true;
          break;
        }
        if (r.error === 'BOT_SUSPECTED') break;
        await ctx.sleep(100);
      }
      if (!carted) continue; // burn the account, try another

      let pass: string | undefined;
      for (let i = 0; i < 30 && ctx.alive(); i++) {
        const r = await api.call('checkout', 'POST', '/api/checkout', {
          token,
          ip,
          body: {},
          headers: { 'idempotency-key': uuid(), 'x-queue-pass': pass },
          timeoutMs: 10_000,
        });
        if (r.status === 201) {
          const p = await api.call('pay', 'POST', `/api/orders/${r.body.order.id}/pay`, {
            token,
            ip,
            body: { method: 'card' },
            headers: { 'idempotency-key': uuid() },
            timeoutMs: 15_000,
          });
          return p.status === 200 || p.status === 202 ? 'converted' : 'failed';
        }
        if (r.error === 'OUT_OF_STOCK') return 'sold_out';
        if (r.error === 'BOT_SUSPECTED') return 'blocked';
        if (r.error === 'QUEUE_REQUIRED') {
          pass = await waitInQueue(ctx, token, 250);
          if (!pass) return 'abandoned';
          continue;
        }
        await ctx.sleep(100); // ignore Retry-After
      }
    }
    return 'blocked';
  } catch {
    return 'failed';
  }
}
