import { db } from '../../shared/db';
import { runtime } from '../../shared/runtime';
import { isLive, type SaleState } from '../../shared/sale';

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  price_cents: number;
  mrp_cents: number;
  deal_price_cents: number | null;
  is_deal: boolean;
  rating: number;
  review_count: number;
  image_seed: number;
  price_version: number;
}

export interface ProductCard {
  id: number;
  sku: string;
  name: string;
  brand: string;
  category: string;
  priceCents: number;
  listPriceCents: number;
  mrpCents: number;
  dealPriceCents: number | null;
  isDeal: boolean;
  dealLive: boolean;
  rating: number;
  reviewCount: number;
  imageSeed: number;
  priceVersion: number;
}

export const PRODUCT_COLUMNS =
  'id, sku, name, brand, category, description, price_cents, mrp_cents, deal_price_cents, is_deal, rating, review_count, image_seed, price_version';

export function toCard(row: ProductRow, sale: SaleState | null, nowMs = runtime.now()): ProductCard {
  const dealLive = row.is_deal && row.deal_price_cents !== null && isLive(sale, nowMs);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    brand: row.brand,
    category: row.category,
    priceCents: dealLive ? row.deal_price_cents! : row.price_cents,
    listPriceCents: row.price_cents,
    mrpCents: row.mrp_cents,
    dealPriceCents: row.deal_price_cents,
    isDeal: row.is_deal,
    dealLive,
    rating: row.rating,
    reviewCount: row.review_count,
    imageSeed: row.image_seed,
    priceVersion: row.price_version,
  };
}

export function toProduct(row: ProductRow, sale: SaleState | null) {
  return { ...toCard(row, sale), description: row.description };
}

/**
 * Load one product the expensive way: this models the real cost of assembling a
 * product page entry (pricing engine, review aggregation, seller info...) as
 * `cacheRebuildCostMs` of DB time on the same connection.
 */
export async function loadProduct(id: number): Promise<ProductRow | null> {
  const cost = runtime.tuning.cacheRebuildCostMs / 1000;
  const rows = await db.query<ProductRow>(
    'product.load',
    `SELECT ${PRODUCT_COLUMNS}, pg_sleep($2)::text AS _cost FROM catalog.products WHERE id = $1`,
    [id, cost],
  );
  return rows[0] ?? null;
}

export async function loadProducts(ids: number[]): Promise<ProductRow[]> {
  if (!ids.length) return [];
  const cost = runtime.tuning.cacheRebuildCostMs / 1000;
  return db.query<ProductRow>(
    'product.load_many',
    `SELECT ${PRODUCT_COLUMNS}, pg_sleep($2)::text AS _cost FROM catalog.products WHERE id = ANY($1::bigint[])`,
    [ids, cost],
  );
}
