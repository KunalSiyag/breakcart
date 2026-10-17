import type { FastifyRequest } from 'fastify';
import { HOT_PRODUCT_IDS } from '../../shared/defs';
import { Upstream } from '../../shared/http-client';
import { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { fwd, runService } from '../../shared/server';
import { HttpError } from '../../shared/util';

interface Card {
  id: number;
  sku: string;
  name: string;
  priceCents: number;
  priceVersion: number;
  imageSeed: number;
}

const redis = new DataRedis();
const catalog = Upstream.for('catalog');
const HOT = new Set(HOT_PRODUCT_IDS);
const CART_TTL_SEC = 7 * 24 * 3600;
const cartKey = (userId: string) => `bc:cart:${userId}`;

function userOf(req: FastifyRequest): string {
  const u = req.headers['x-user-id'];
  if (typeof u !== 'string' || !u) throw new HttpError(401, 'UNAUTHENTICATED', 'missing user');
  return u;
}

async function priceLines(req: FastifyRequest, lines: { productId: number; qty: number }[]) {
  if (!lines.length) return { items: [], subtotalCents: 0 };
  const cards = new Map<number, Card>();
  if (runtime.flag('cart.pricing') === 'per_item_calls') {
    // One call per line, in sequence — the classic fan-out that multiplies catalog load by cart size.
    for (const l of lines) {
      const c = await catalog.json<Card>({ path: `/products/${l.productId}`, headers: fwd(req) });
      cards.set(c.id, c);
    }
  } else {
    const { items } = await catalog.json<{ items: Card[] }>({
      path: '/products/batch',
      query: { ids: lines.map((l) => l.productId).join(',') },
      headers: fwd(req),
    });
    for (const c of items) cards.set(c.id, c);
  }
  const items = lines
    .filter((l) => cards.has(l.productId))
    .map((l) => {
      const c = cards.get(l.productId)!;
      return { productId: c.id, sku: c.sku, name: c.name, qty: l.qty, unitPriceCents: c.priceCents, priceVersion: c.priceVersion, imageSeed: c.imageSeed };
    });
  return { items, subtotalCents: items.reduce((s, i) => s + i.unitPriceCents * i.qty, 0) };
}

async function readLines(userId: string) {
  // Raw HGETALL reply (flat [field, value, …] array) keeps the hash's insertion order.
  // NOT r.hgetall(): it returns a JS object, and objects enumerate integer-like keys
  // ("6", "9", …) in ascending numeric order — which silently sorts every cart by product id.
  // (That accident gives every checkout the same lock order; see lab deadlocks.)
  const flat = (await redis.run('hgetall', (r) => r.call('HGETALL', cartKey(userId)))) as string[];
  const lines: { productId: number; qty: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) lines.push({ productId: Number(flat[i]), qty: Number(flat[i + 1]) });
  return lines.filter((l) => l.qty > 0);
}

void runService({
  name: 'cart',
  ready: async () => {
    await redis.run('ping', (r) => r.ping());
  },
  routes: async (app) => {
    await redis.connect();

    app.get('/cart', async (req) => priceLines(req, await readLines(userOf(req))));

    app.post<{ Body: { productId: number; qty?: number } }>('/cart/items', async (req) => {
      const userId = userOf(req);
      const productId = Number(req.body?.productId);
      const qty = Number(req.body?.qty ?? 1);
      if (!Number.isInteger(productId) || productId <= 0) throw new HttpError(400, 'BAD_REQUEST', 'invalid productId');
      if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new HttpError(400, 'BAD_REQUEST', 'qty must be 1..10');
      // Validate the product exists (and warm the catalog cache).
      await catalog.json({ path: `/products/${productId}`, headers: fwd(req) });
      const limit = HOT.has(productId) ? 2 : 10; // purchase limit per customer on flash deals
      const key = cartKey(userId);
      await redis.run('cart_add', async (r) => {
        const next = await r.hincrby(key, String(productId), qty);
        if (next > limit) await r.hset(key, String(productId), String(limit));
        await r.expire(key, CART_TTL_SEC);
      });
      return priceLines(req, await readLines(userId));
    });

    app.delete<{ Params: { productId: string } }>('/cart/items/:productId', async (req) => {
      const userId = userOf(req);
      await redis.run('hdel', (r) => r.hdel(cartKey(userId), String(Number(req.params.productId))));
      return priceLines(req, await readLines(userId));
    });

    app.delete('/cart', async (req) => {
      const userId = userOf(req);
      await redis.run('del', (r) => r.del(cartKey(userId)));
      return { items: [], subtotalCents: 0 };
    });
  },
  shutdown: async () => redis.disconnect(),
});
