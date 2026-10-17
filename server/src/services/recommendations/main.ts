import { db } from '../../shared/db';
import { DataRedis } from '../../shared/redis';
import { SaleClock } from '../../shared/sale';
import { runService } from '../../shared/server';
import { PRODUCT_COLUMNS, toCard, type ProductRow } from '../catalog/products';

/**
 * Recommendations: deliberately non-critical. The storefront works fine without it —
 * unless the caller waits for it forever (lab: cascading-failure).
 */
const redis = new DataRedis();
const sale = new SaleClock(redis);
const byCategory = new Map<string, { rows: ProductRow[]; exp: number }>();
const CATEGORIES = ['Mobiles', 'Laptops', 'TVs', 'Audio', 'Wearables', 'Gaming', 'Kitchen', 'Home'];

async function topFor(category: string): Promise<ProductRow[]> {
  const hit = byCategory.get(category);
  if (hit && hit.exp > Date.now()) return hit.rows;
  const rows = await db.query<ProductRow>(
    'recs.top',
    `SELECT ${PRODUCT_COLUMNS} FROM catalog.products WHERE category = $1 ORDER BY rating DESC, id LIMIT 40`,
    [category],
  );
  byCategory.set(category, { rows, exp: Date.now() + 30_000 });
  return rows;
}

void runService({
  name: 'recommendations',
  db: true,
  ready: async () => {
    await db.query('ready', 'SELECT 1');
  },
  routes: async (app) => {
    await redis.connect();
    app.get<{ Querystring: { productId?: string; userId?: string } }>('/recs', async (req) => {
      const pid = Number(req.query.productId);
      let category = CATEGORIES[Math.abs(hash(req.query.userId ?? '')) % CATEGORIES.length];
      if (Number.isInteger(pid) && pid > 0) {
        const [row] = await db.query<{ category: string }>('recs.category', 'SELECT category FROM catalog.products WHERE id = $1', [pid]);
        if (row) category = row.category;
      }
      const rows = (await topFor(category)).filter((r) => r.id !== pid);
      // Rotate so different users see different picks.
      const offset = Math.floor(Math.random() * Math.max(1, rows.length - 8));
      const s = await sale.get();
      return { items: rows.slice(offset, offset + 8).map((r) => toCard(r, s)), strategy: 'top-rated-in-category' };
    });
  },
  shutdown: async () => redis.disconnect(),
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
