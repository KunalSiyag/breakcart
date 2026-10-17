import { db } from '../../shared/db';
import { HOT_PRODUCT_IDS, KEYS } from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import { DataRedis, rawRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { isLive, SaleClock } from '../../shared/sale';
import { runService } from '../../shared/server';
import { HttpError } from '../../shared/util';
import { Cache } from './cache';
import { loadProduct, loadProducts, PRODUCT_COLUMNS, toCard, toProduct, type ProductRow } from './products';

const redis = new DataRedis();
const sale = new SaleClock(redis);

const HOT = new Set(HOT_PRODUCT_IDS.map(String));
const productCache = new Cache<ProductRow>('product', redis, (k) => loadProduct(Number(k)), { isHot: (k) => HOT.has(k) });
const dealsCache = new Cache<ProductRow[]>('deals', redis, () => loadProducts(HOT_PRODUCT_IDS), { l1TtlMs: 1000, isHot: () => true });
const categoriesCache = new Cache<{ name: string; count: number }[]>('categories', redis, () =>
  db.query('categories', 'SELECT category AS name, count(*)::int AS count FROM catalog.products GROUP BY 1 ORDER BY 1'),
);

function parseIds(raw: unknown): number[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 100);
}

function idParam(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'BAD_REQUEST', 'invalid product id');
  return id;
}

void runService({
  name: 'catalog',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async (app) => {
    await redis.connect();

    // Cross-instance invalidation (used when catalog.priceInvalidation = pubsub_invalidate).
    const sub = rawRedis('catalog-invalidation');
    await sub.subscribe(KEYS.invalidationChannel);
    sub.on('message', (_ch, msg) => {
      try {
        const { keys } = JSON.parse(msg) as { keys: string[] };
        productCache.dropL1(keys);
        dealsCache.dropL1();
      } catch {
        /* ignore */
      }
    });
    runtime.on('command', (cmd) => {
      if (cmd.action === 'flush-l1') {
        productCache.dropL1();
        dealsCache.dropL1();
        categoriesCache.dropL1();
      }
    });

    app.get('/sale', async () => sale.view());

    app.get<{ Params: { id: string } }>('/products/:id', async (req) => {
      const row = await productCache.get(String(idParam(req.params.id)));
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'product not found');
      return toProduct(row, await sale.get());
    });

    app.get<{ Querystring: { ids?: string } }>('/products/batch', async (req) => {
      const ids = parseIds(req.query.ids);
      const s = await sale.get();
      const rows = await Promise.all(ids.map((id) => productCache.get(String(id))));
      return { items: rows.filter((r): r is ProductRow => r !== null).map((r) => toCard(r, s)) };
    });

    app.get<{ Querystring: { category?: string; page?: string; pageSize?: string } }>('/products', async (req) => {
      const category = String(req.query.category ?? 'Mobiles').slice(0, 40);
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const pageSize = Math.min(48, Math.max(1, Number(req.query.pageSize ?? 24) || 24));
      const ids = (
        await db.query<{ id: number }>(
          'list.ids',
          'SELECT id FROM catalog.products WHERE category = $1 ORDER BY rating DESC, id LIMIT $2 OFFSET $3',
          [category, pageSize, (page - 1) * pageSize],
        )
      ).map((r) => r.id);

      let rows: ProductRow[];
      if (runtime.flag('catalog.listQuery') === 'n_plus_one') {
        // What an ORM with lazy loading does inside a loop: one round trip per row.
        rows = [];
        for (const id of ids) {
          const r = await db.query<ProductRow>('list.item', `SELECT ${PRODUCT_COLUMNS} FROM catalog.products WHERE id = $1`, [id]);
          if (r[0]) rows.push(r[0]);
        }
      } else {
        const byId = new Map(
          (
            await db.query<ProductRow>('list.batch', `SELECT ${PRODUCT_COLUMNS} FROM catalog.products WHERE id = ANY($1::bigint[])`, [ids])
          ).map((r) => [r.id, r]),
        );
        rows = ids.map((id) => byId.get(id)).filter((r): r is ProductRow => !!r);
      }
      const [{ count }] = await db.query<{ count: number }>('list.count', 'SELECT count(*)::int AS count FROM catalog.products WHERE category = $1', [
        category,
      ]);
      const s = await sale.get();
      return { items: rows.map((r) => toCard(r, s)), page, pageSize, total: count };
    });

    app.get('/categories', async () => ({ items: (await categoriesCache.get('all')) ?? [] }));

    app.get<{ Querystring: { q?: string } }>('/search', async (req) => {
      const q = String(req.query.q ?? '').trim().slice(0, 80);
      if (!q) return { items: [], tookMs: 0 };
      const started = performance.now();
      let rows: ProductRow[];
      if (runtime.flag('catalog.search') === 'ilike_scan') {
        rows = await db.query<ProductRow>(
          'search.ilike',
          `SELECT ${PRODUCT_COLUMNS} FROM catalog.products
            WHERE name ILIKE $1 OR description ILIKE $1
            ORDER BY review_count DESC LIMIT 24`,
          [`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`],
        );
      } else {
        rows = await db.query<ProductRow>(
          'search.fts',
          `SELECT ${PRODUCT_COLUMNS} FROM catalog.products, websearch_to_tsquery('english', $1) query
            WHERE search_tsv @@ query
            ORDER BY ts_rank(search_tsv, query) DESC, review_count DESC LIMIT 24`,
          [q],
        );
      }
      const s = await sale.get();
      return { items: rows.map((r) => toCard(r, s)), tookMs: Math.round(performance.now() - started) };
    });

    app.get('/deals', async () => {
      const rows = (await dealsCache.get('all')) ?? [];
      const s = await sale.get();
      return { items: rows.sort((a, b) => a.id - b.id).map((r) => toCard(r, s)) };
    });

    /**
     * Authoritative prices: straight from the database, with sale liveness decided by the
     * database clock (one clock for business decisions — not each container's own).
     */
    app.get<{ Querystring: { ids?: string } }>('/prices', async (req) => {
      const ids = parseIds(req.query.ids);
      const rows = await db.query<ProductRow & { db_now: Date }>(
        'prices.fresh',
        `SELECT ${PRODUCT_COLUMNS}, now() AS db_now FROM catalog.products WHERE id = ANY($1::bigint[])`,
        [ids],
      );
      const s = await sale.get();
      return {
        items: rows.map((r) => {
          const live = r.is_deal && r.deal_price_cents !== null && isLive(s, r.db_now.getTime());
          return { id: r.id, priceCents: live ? r.deal_price_cents! : r.price_cents, priceVersion: r.price_version, dealLive: live };
        }),
      };
    });

    app.post<{ Body: { productId: number; dealPriceCents?: number; priceCents?: number } }>('/admin/price', async (req) => {
      const { productId, dealPriceCents, priceCents } = req.body ?? ({} as never);
      const id = idParam(productId);
      const row = await db.tx('price.change', async (tx) => {
        const res = await tx.query<ProductRow>(
          `UPDATE catalog.products
              SET deal_price_cents = COALESCE($2, deal_price_cents),
                  price_cents = COALESCE($3, price_cents),
                  price_version = price_version + 1,
                  updated_at = now()
            WHERE id = $1
        RETURNING ${PRODUCT_COLUMNS}`,
          [id, dealPriceCents ?? null, priceCents ?? null],
        );
        const r = res.rows[0];
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'product not found');
        await tx.query(
          'INSERT INTO catalog.price_history (product_id, price_version, price_cents, deal_price_cents, valid_from) VALUES ($1, $2, $3, $4, now())',
          [r.id, r.price_version, r.price_cents, r.deal_price_cents],
        );
        return r;
      });
      const invalidate = runtime.flag('catalog.priceInvalidation') === 'pubsub_invalidate';
      if (invalidate) {
        await productCache.invalidate([String(id)]);
        await dealsCache.invalidate(['all']);
        await redis.run('publish', (r) => r.publish(KEYS.invalidationChannel, JSON.stringify({ keys: [String(id)] }))).catch(() => undefined);
      }
      emitEvent(
        'info',
        'price-change',
        `Price change on #${id} (${row.name}) → v${row.price_version}${invalidate ? ', caches invalidated' : ', caches NOT invalidated (TTL only)'}`,
        undefined,
        { throttleMs: 0 },
      );
      return { product: toProduct(row, await sale.get()), invalidated: invalidate };
    });
  },
  shutdown: async () => redis.disconnect(),
});
