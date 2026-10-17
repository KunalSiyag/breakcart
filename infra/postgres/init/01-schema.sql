-- BreakCart schema. One database, one schema per service (logical ownership).
-- Services only touch their own schema; the control plane reads across schemas
-- to audit business invariants, the way a data/finance reconciliation job would.

CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS inventory;
CREATE SCHEMA IF NOT EXISTS orders;
CREATE SCHEMA IF NOT EXISTS payments;
CREATE SCHEMA IF NOT EXISTS fulfillment;

-- ---------------------------------------------------------------- catalog
CREATE TABLE catalog.products (
  id               BIGINT PRIMARY KEY,
  sku              TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  brand            TEXT NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT NOT NULL,
  price_cents      INTEGER NOT NULL CHECK (price_cents > 0),
  mrp_cents        INTEGER NOT NULL,
  deal_price_cents INTEGER,
  is_deal          BOOLEAN NOT NULL DEFAULT FALSE,
  rating           NUMERIC(2,1) NOT NULL DEFAULT 4.0,
  review_count     INTEGER NOT NULL DEFAULT 0,
  image_seed       INTEGER NOT NULL DEFAULT 0,
  price_version    INTEGER NOT NULL DEFAULT 1,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_tsv       TSVECTOR GENERATED ALWAYS AS (
                     to_tsvector('english', name || ' ' || brand || ' ' || category || ' ' || description)
                   ) STORED
);
CREATE INDEX products_category_rating_idx ON catalog.products (category, rating DESC, id);
CREATE INDEX products_search_idx ON catalog.products USING GIN (search_tsv);
CREATE INDEX products_deal_idx ON catalog.products (id) WHERE is_deal;

-- Every price change is versioned so the integrity checker can tell which price
-- was correct at the moment an order was placed.
CREATE TABLE catalog.price_history (
  id               BIGSERIAL PRIMARY KEY,
  product_id       BIGINT NOT NULL,
  price_version    INTEGER NOT NULL,
  price_cents      INTEGER NOT NULL,
  deal_price_cents INTEGER,
  valid_from       TIMESTAMPTZ NOT NULL
);
CREATE INDEX price_history_lookup_idx ON catalog.price_history (product_id, valid_from DESC);

CREATE TABLE catalog.sale_windows (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at   TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------- inventory
CREATE TABLE inventory.stock (
  sku         TEXT PRIMARY KEY,
  product_id  BIGINT NOT NULL,
  total       INTEGER NOT NULL,
  available   INTEGER NOT NULL,   -- NOTE: deliberately no CHECK (available >= 0): the naive path must be able to oversell
  reserved    INTEGER NOT NULL DEFAULT 0,
  sold        INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_product_idx ON inventory.stock (product_id);

CREATE TABLE inventory.reservations (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL,
  sku         TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0),
  status      TEXT NOT NULL,            -- HELD | COMMITTED | RELEASED | EXPIRED
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reservations_order_idx ON inventory.reservations (order_id);
CREATE INDEX reservations_sku_status_idx ON inventory.reservations (sku, status);
CREATE INDEX reservations_expiry_idx ON inventory.reservations (expires_at) WHERE status = 'HELD';

-- ---------------------------------------------------------------- orders
CREATE TABLE orders.orders (
  id               UUID PRIMARY KEY,
  user_id          TEXT NOT NULL,
  status           TEXT NOT NULL,
  subtotal_cents   INTEGER NOT NULL,
  discount_cents   INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL,
  coupon_code      TEXT,
  idempotency_key  TEXT,               -- no UNIQUE constraint: the naive mode must be able to create duplicates
  failure_reason   TEXT,
  payment_attempts INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ
);
CREATE INDEX orders_user_idx ON orders.orders (user_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders.orders (status, updated_at);
CREATE INDEX orders_idem_idx ON orders.orders (user_id, idempotency_key);

CREATE TABLE orders.order_items (
  order_id         UUID NOT NULL REFERENCES orders.orders (id) ON DELETE CASCADE,
  product_id       BIGINT NOT NULL,
  sku              TEXT NOT NULL,
  name             TEXT NOT NULL,
  qty              INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  price_version    INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE orders.outbox (
  id            BIGSERIAL PRIMARY KEY,
  aggregate_id  UUID NOT NULL,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON orders.outbox (id) WHERE published_at IS NULL;

CREATE TABLE orders.coupons (
  code               TEXT PRIMARY KEY,
  max_uses           INTEGER NOT NULL,
  used               INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL,
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders.coupon_redemptions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  order_id    UUID NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- payments (the PSP's own ledger)
CREATE TABLE payments.charges (
  id               UUID PRIMARY KEY,
  order_id         UUID NOT NULL,
  idempotency_key  TEXT,
  amount_cents     INTEGER NOT NULL,
  method           TEXT NOT NULL,
  status           TEXT NOT NULL,       -- SUCCEEDED | DECLINED
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX charges_order_idx ON payments.charges (order_id);
CREATE UNIQUE INDEX charges_idem_idx ON payments.charges (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------- fulfillment
CREATE TABLE fulfillment.shipments (
  order_id    UUID PRIMARY KEY,
  status      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fulfillment.notifications (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL,
  kind        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_order_idx ON fulfillment.notifications (order_id);
