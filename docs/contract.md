# BreakCart — interface contract

This file pins down every interface between components: public API, control-plane API,
live event stream, metric names, and container topology. If you change an interface,
change it here first.

Runtime knobs (flags / chaos / tuning) are defined in `server/src/shared/defs.ts` and
served dynamically by `GET /control/state`, so UIs must render them from that response
rather than hard-coding them.

## 1. Topology

| Container | Port | Role |
|---|---|---|
| `web` (nginx) | 8080 (host) | React storefront + war room. Proxies `/api/` → `gateway:3000/api/`, `/control/` → `control-plane:3010/control/` |
| `gateway` (×4 replicas) | 3000 (no host port) | Edge / BFF: auth, rate limit, waiting room, load shedding, bot protection, fan-out. Reach it from the host via `web` at `:8080/api`. |
| `catalog` | 3001 | Products, deals, search, prices, caching |
| `inventory` | 3002 | Stock + reservations |
| `cart` | 3003 | Carts in Redis |
| `orders` | 3004 | Checkout, payment orchestration, coupons, reconciler, outbox |
| `payments` | 3005 | Mock payment service provider (PSP) |
| `recommendations` | 3006 | Non-critical recs service |
| `control-plane` | 3010 | Flags, chaos, tuning, scenarios, labs, integrity checker, metrics summary, SSE |
| `loadgen` | 3011 | Behavioural traffic generator |
| `workers` | 3012 | Fulfillment stream consumer, outbox relay (metrics only HTTP) |
| `postgres` | 5432 (host 5440) | Primary DB, schemas `catalog`, `inventory`, `orders`, `payments`, `fulfillment` |
| `redis` | 6379 (host 6390) | Cache, sessions, carts, rate limits, waiting room, streams, pub/sub |
| `prometheus` | 9090 (host 9091) | Scrapes every service at `/metrics` every 2s (gateway replicas via DNS service discovery) |
| `grafana` | 3000 (host 3300) | Dashboards (anonymous admin) |
| `jaeger` | 16686 (host) | Traces via OTLP HTTP 4318 |
| `postgres-exporter` | 9187 | |
| `redis-exporter` | 9121 | |

Every Node service exposes `GET /health`, `GET /ready`, `GET /metrics`.

## 2. Public API (through the gateway, prefix `/api`)

Auth: `Authorization: Bearer <token>` from `POST /api/auth/guest`. All errors use:

```json
{ "error": { "code": "OUT_OF_STOCK", "message": "human readable", "retryable": false } }
```

Error codes: `UNAUTHENTICATED`, `RATE_LIMITED` (429, `Retry-After`), `OVERLOADED` (503, shed),
`QUEUE_REQUIRED` (409, checkout needs waiting-room pass), `BOT_SUSPECTED` (403),
`OUT_OF_STOCK` (409), `PRICE_CHANGED` (409), `COUPON_EXHAUSTED` (409), `PAYMENT_DECLINED` (402),
`PAYMENT_TIMEOUT` (504), `PAYMENT_PENDING` (202 — not an error, see below), `REQUEST_IN_PROGRESS` (409),
`INVALID_STATE` (409), `NOT_FOUND` (404), `UPSTREAM_UNAVAILABLE` (502/503/504), `INTERNAL` (500),
`INJECTED_FAULT` (500), `SALE_NOT_STARTED` (409), `BAD_REQUEST` (400), `INVALID_COUPON` (400),
`COUPON_NOT_APPLICABLE` (409, cart below the coupon minimum, or a sale-only coupon used outside the sale), `ORDER_EXPIRED` (409, stock hold expired before payment).

Semantics worth knowing:

- `POST /api/cart/items` **adds** `qty` to the line (it does not set it). Flash deals are capped at 2 per customer
  (the cart clamps silently); other items at 10.
- Idempotency (when `orders.idempotency = on`): every non-5xx outcome is stored under the key and replayed for
  24h (response header `idempotent-replayed: true`); 5xx outcomes release the key so the client may retry with it.
  Checkout is also **resumable**: the order id is derived from (customer, key), so a retry after an attempt that failed
  half-way finds that attempt's order — replayed if it completed, resumed from the reservation step if it stopped at
  `CREATED`, its rejection replayed if it was a business rejection. Reservations and coupon redemptions are idempotent
  per order. Checkouts abandoned at `CREATED` for 2 minutes are rejected (`ABANDONED`) and their stock/coupon released.
- A decline returns the order to `AWAITING_PAYMENT` (the customer may retry); `PAYMENT_FAILED` is terminal and the
  stock has been released.
- `GET /api/sale` may return `null` (no sale configured).

### Types

```ts
interface ProductCard {
  id: number; sku: string; name: string; brand: string; category: string;
  priceCents: number;          // what the customer pays now (deal price if sale is live)
  listPriceCents: number;      // regular price
  mrpCents: number;            // strike-through price
  dealPriceCents: number | null;
  isDeal: boolean; dealLive: boolean;
  rating: number; reviewCount: number; imageSeed: number;
  priceVersion: number;
}
interface Product extends ProductCard { description: string; stock: { available: number; total: number } | null; }
interface Sale { name: string; startsAt: string; endsAt: string; now: string; live: boolean; }
interface CartLine { productId: number; sku: string; name: string; qty: number; unitPriceCents: number; priceVersion: number; imageSeed: number; }
interface Cart { items: CartLine[]; subtotalCents: number; }
type OrderStatus = 'CREATED' | 'REJECTED' | 'AWAITING_PAYMENT' | 'PAYMENT_IN_PROGRESS' | 'PAYMENT_PENDING' | 'PAID' | 'PAYMENT_FAILED' | 'EXPIRED';
interface Order { id: string; status: OrderStatus; totalCents: number; discountCents: number; couponCode: string | null;
  items: { productId: number; sku: string; name: string; qty: number; unitPriceCents: number }[];
  createdAt: string; updatedAt: string; failureReason: string | null; }
```

### Endpoints

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/api/auth/guest` | – | `{ token, userId }` |
| GET | `/api/home` | – | `{ sale: Sale, deals: (ProductCard & {stock:{available,total}\|null})[], recommendations: ProductCard[], degraded: string[] }` |
| GET | `/api/products` | `?category=&page=1&pageSize=24` | `{ items: ProductCard[], page, pageSize, total }` |
| GET | `/api/products/:id` | – | `Product & { recommendations: ProductCard[], degraded: string[] }` |
| GET | `/api/categories` | – | `{ items: { name: string; count: number }[] }` |
| GET | `/api/search` | `?q=` | `{ items: ProductCard[], tookMs }` |
| GET | `/api/sale` | – | `Sale` |
| GET | `/api/cart` | – | `Cart` |
| POST | `/api/cart/items` | `{ productId, qty }` | `Cart` |
| DELETE | `/api/cart/items/:productId` | – | `Cart` |
| DELETE | `/api/cart` | – | `Cart` |
| POST | `/api/checkout` | header `Idempotency-Key`, optional header `X-Queue-Pass`; body `{ couponCode?: string }` | 201 `{ order: Order }` (status `AWAITING_PAYMENT`) |
| POST | `/api/orders/:id/pay` | header `Idempotency-Key`; body `{ method: 'card' \| 'upi' }` | 200 `{ order }` (PAID) · 202 `{ order }` (PAYMENT_PENDING) · error |
| GET | `/api/orders` | – | `{ items: Order[] }` |
| GET | `/api/orders/:id` | – | `{ order }` |
| POST | `/api/queue/join` | – | `{ ticket: number, position: number, etaSec: number }` |
| GET | `/api/queue/status` | `?ticket=` | `{ admitted: boolean, position: number, etaSec: number, pass?: string }` |

Waiting room: when `gateway.waitingRoom = on` and the sale is live, `POST /api/checkout` without a valid
`X-Queue-Pass` returns 409 `QUEUE_REQUIRED`. Client joins, polls status every ~2s, then retries
checkout with the pass. Passes are valid 120s.

## 3. Control plane API (prefix `/control`)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/control/state` | – | `{ runtime: RuntimeState, defs: { flags: FLAGS, serviceChaosDefaults, paymentsChaosDefaults, dataChaosDefaults, tuningDefaults, tuningHelp, services: string[] } }` |
| PATCH | `/control/flags` | `{ [flagKey]: mode }` | `RuntimeState` |
| PATCH | `/control/chaos` | `{ services?: { [svc]: Partial<ServiceChaos> }, payments?: Partial<PaymentsChaos>, data?: Partial<DataChaos> }` (deep-merged) | `RuntimeState` |
| PATCH | `/control/tuning` | `Partial<Tuning>` | `RuntimeState` |
| POST | `/control/presets/:id` | – (`hardened`, `naive`, `calm-chaos`) — `naive`/`hardened` set all flags; `calm-chaos` clears chaos | `RuntimeState` |
| POST | `/control/actions/:action` | `{ target?: string, ... }` — actions: `flush-cache`, `kill-service` (target), `reset-data`, `inject-poison`, `price-change` (`{productId, dealPriceCents}`), `restock` | `{ ok: true, message }` |
| GET | `/control/scenarios` | – | `ScenarioSummary[]` |
| POST | `/control/scenarios/:id/start` | `{ multiplier?: number }` | loadgen status |
| POST | `/control/scenarios/stop` | – | loadgen status |
| PATCH | `/control/loadgen` | `{ multiplier: number }` | loadgen status |
| GET | `/control/loadgen` | – | `LoadgenStats` |
| GET | `/control/labs` | – | `Lab[]` |
| POST | `/control/labs/:id/start` | `{ variant: 'broken' \| 'fixed', multiplier?: number }` | `{ ok, runtime, loadgen }` |
| GET | `/control/integrity` | – | `Integrity` |
| GET | `/control/summary` | – | `Summary` |
| GET | `/control/services` | – | `{ items: { service, up, latencyMs, startedAt, restarts, instances } [] }` (`instances` = running replicas) |
| GET | `/control/events` | – | **SSE** stream (see §4) |
| GET | `/control/events/recent` | – | `{ items: TimelineEvent[] }` (last 200) |
| GET | `/control/journeys/recent` | – | `{ items: Journey[] }` (last 100 of the current or last run, newest first; emptied when a scenario starts) |
| GET | `/control/prom/query_range` | `?query=&minutes=10&step=2` | raw Prometheus `query_range` JSON |
| GET | `/control/prom/query` | `?query=` | raw Prometheus `query` JSON |

```ts
interface ScenarioSummary { id: string; name: string; description: string; durationSec: number;
  saleStartsAtSec: number | null; botShare: number;
  phases: { name: string; durationSec: number; fromRate: number; toRate: number }[];
  timeline: { atSec: number; description: string }[]; }

interface Lab { id: string; title: string; category: string; difficulty: 'beginner' | 'intermediate' | 'advanced';
  summary: string; story: string; symptoms: string[]; watch: string[]; rootCause: string; fix: string;
  realWorld: string; flags: string[]; scenario: string; steps: string[]; brokenPatch: object; fixedPatch: object; }

interface LoadgenStats { running: boolean; scenarioId: string | null; scenarioName: string | null;
  elapsedSec: number; durationSec: number; phase: string | null; multiplier: number;
  targetArrivalPerSec: number; actualArrivalPerSec: number; activeSessions: number; droppedArrivals: number;
  rps: number;
  steps: { step: string; rps: number; p50Ms: number; p95Ms: number; p99Ms: number; errorPct: number; codes: Record<string, number> }[];
  sessions: { started: number; converted: number; abandoned: number; failed: number; blocked: number; soldOut: number };
  anomalies: Record<string, number>; }

// Sampled shopper journeys. The loadgen decides at session start, with probability
// min(1, 4 / max(1, target arrivals/s)) — ~4 journeys/s at any load — records every request the session
// makes (retries and waiting-room polls included) and, when it ends, publishes one Journey on the Redis
// channel `bc:journeys`. Only sessions of the current run are published (stragglers of a stopped run are dropped).
interface Journey {
  id: string;                 // short random session id (8 chars)
  persona: 'shopper' | 'bot';
  startedAt: number;          // epoch ms
  durationMs: number;
  result: 'converted' | 'abandoned' | 'failed' | 'blocked' | 'sold_out';
  steps: { step: string; atMs: number; ms: number; status: number; code: string | null }[];
    // step: loadgen step label (§5 "Steps"); atMs: click time from session start; ms: latency as the customer felt it;
    // status: HTTP status, 0 for timeout / network error; code: error code from the JSON error body (OUT_OF_STOCK,
    // QUEUE_REQUIRED…), 'timeout' / 'network' when status is 0, else null. Ordered by atMs.
    // At most 40: a longer session keeps its first 39 steps and its last one, and sets truncated: true.
  truncated?: boolean;
  product: { id: number; name: string } | null;   // the first product page the session viewed
  amountCents: number | null;   // totalCents of the order the session paid for (a converted session that never saw
                                // PAID — a bot accepting a 202 — reports its checkout total), else null
  queueWaitMs: number | null;   // first waiting-room join → end of the last waiting-room call; null if never queued
}

interface Integrity { checkedAt: string;
  violations: { oversoldUnits: number; negativeStockSkus: number; duplicateOrders: number; duplicateCharges: number;
    orphanCharges: number; couponOverRedemptions: number; priceMismatches: number; stuckOrders: number;
    lostEvents: number; phantomHeldUnits: number; paidUncommitted: number; };
  oversoldSkus: { sku: string; name: string; total: number; claimed: number }[];
  totals: { orders: number; paidOrders: number; gmvCents: number; charges: number; shipments: number; unitsSold: number; dlqDepth: number }; }

interface Summary { ts: number;
  gateway: { rps: number; errorPct: number; p50Ms: number; p95Ms: number; p99Ms: number; inflight: number };
  routes: { route: string; rps: number; p95Ms: number; p99Ms: number; errorPct: number }[];
  services: { service: string; up: boolean; rps: number; p99Ms: number; errorPct: number; eventLoopLagMs: number;
    inflight: number; dbPool: { total: number; idle: number; waiting: number; max: number } | null; memMb: number; cpuPct: number;
    instances: number }[];   // running replicas (DNS answers for the service; 1 when unknown)
  breakers: { service: string; target: string; state: 'closed' | 'half_open' | 'open' }[];
  // Topology (15s windows, every number finite: NaN → 0).
  edges: { from: string; to: string; rps: number; p99Ms: number; errorPct: number }[];
    // Caller → callee from http_client_request_duration_seconds{service,target} (errorPct = share with outcome != "ok"),
    // led by the synthetic customers → gateway edge (gateway server rps, p99, 5xx %). Edges under 0.05 rps are omitted.
  stores: { service: string; store: 'postgres' | 'redis'; opsPerSec: number; p99Ms: number; errorPct: number }[];
    // db_query_duration_seconds / redis_command_duration_seconds per service (errorPct = share with outcome="error"),
    // control-plane excluded, under 0.05 ops/s omitted. Postgres rows first; each store sorted by service.
  stream: { producedPerSec: number; consumedPerSec: number; lag: number; dlq: number };
    // produced = orders_events_published_total{mode="dual_write",result="ok"} + outbox_relayed_total;
    // consumed = stream_processed_total{result="ok"}; lag and dlq as business.consumerLag / business.dlqDepth.
  hotStock: { sku: string; available: number }[];   // max by (sku) (inventory_available_units), sorted by sku
  business: { checkoutsPerMin: number; paidPerMin: number; gmvPerMinCents: number; paymentSuccessPct: number;
    waitingRoomLength: number; consumerLag: number; dlqDepth: number; cacheHitPct: number;
    rateLimitedPerSec: number; shedPerSec: number; botBlockedPerSec: number; dbDeadlocksPerMin: number;
    retriesPerSec: number; outboxBacklog: number };
  sale: Sale | null; }
```

## 4. Live events (SSE `GET /control/events`)

Named events:

- `timeline` — `{ id, ts, level: 'info'|'warn'|'critical', source, kind, message, data? }` (incidents: breaker opened, deadlock,
  pool exhausted, oversell detected, service restarted, chaos changed, flag flipped, scenario phase...)
- `loadgen` — `LoadgenStats`, once per second while running (and once on connect)
- `runtime` — `RuntimeState` whenever it changes
- `integrity` — `Integrity` every 5s
- `journey` — `Journey`, one per sampled session as it ends (~4/s while a scenario runs). Not replayed on connect:
  a new client loads `GET /control/journeys/recent` once, then appends these.

## 5. Metrics (Prometheus, every series has label `service`)

HTTP server: `http_server_request_duration_seconds{method,route,status}` (histogram, buckets
.005 .01 .025 .05 .1 .25 .5 1 2.5 5 10 30; `status="499"` = client closed the connection before the response), `http_server_inflight_requests`,
`http_server_errors_total{route,code}` (error responses by error code — splits 409 into OUT_OF_STOCK, QUEUE_REQUIRED…).

HTTP client: `http_client_request_duration_seconds{target,outcome}` (outcome: ok, http_error, timeout,
network_error, circuit_open), `http_client_retries_total{target}`, `http_client_retry_budget_exhausted_total{target}`,
`http_client_connections_opened_total{target}` (TCP connects — the connection-churn signal),
`circuit_breaker_state{target}` (0 closed, 1 half-open, 2 open), `circuit_breaker_transitions_total{target,to}`.

DB: `db_pool_connections{state}` (total, idle, waiting), `db_pool_acquire_duration_seconds`,
`db_query_duration_seconds{op,outcome}`, `db_errors_total{code}` (Postgres SQLSTATE, `acquire_timeout`).
Redis: `redis_command_duration_seconds{op,outcome}`.
Cache: `cache_requests_total{cache,result}` (hit, miss, stale, l1_hit, coalesced, bypass),
`cache_rebuilds_total{cache}`, `cache_rebuild_inflight{cache}`.

Node process defaults from prom-client (`process_cpu_seconds_total`, `process_resident_memory_bytes`,
`process_start_time_seconds`, `nodejs_eventloop_lag_p99_seconds`, `nodejs_heap_size_used_bytes`, `nodejs_gc_duration_seconds`…).
`chaos_active{kind}` gauge (kind: latency, errors, hang, cpu_burn, memory_leak, gc_pause, clock_skew, db_slow, redis),
`clock_offset_seconds` (business-clock skew of this service), `db_pool_connections{state="max"}` (configured pool size).

Gateway: `gateway_ratelimit_decisions_total{decision}` (allowed, limited, error_allowed, error_rejected),
`gateway_shed_total{priority,reason}` (priority: critical, high, normal, low; reason: inflight, queue_delay), `gateway_admission_inflight` (the shedder's own
in-flight count — compare with `http_server_inflight_requests`), `gateway_waiting_room_queue_length`, `gateway_waiting_room_admitted_total`,
`gateway_waiting_room_rejected_total`, `gateway_bot_blocked_total{reason}` (ip_velocity, fresh_account, no_product_view, too_fast,
checkout_velocity), `gateway_sessions_created_total`.

Inventory: `inventory_reservations_total{strategy,result}` (ok, out_of_stock, deadlock, error),
`inventory_reservation_duration_seconds{strategy}`, `inventory_expired_reservations_total`,
`inventory_available_units{sku}` (hot SKUs).

Orders: `orders_checkouts_total{result}` (created, resumed, out_of_stock, price_changed, coupon_exhausted, duplicate_replayed,
in_progress, error), `orders_payments_total{result}` (paid, declined, timeout, pending, error, rate_limited, replayed, expired),
`orders_gmv_cents_total`, `orders_reconciled_total{result}` (paid, failed, still_unknown, error, checkout_abandoned, stock_committed, stock_lost),
`orders_events_published_total{mode,result}` (mode: dual_write, outbox; result: ok, failed),
`orders_coupon_redemptions_total{result}` (ok, exhausted), `db_replica_lag_seconds` (simulated replica lag).

Payments (PSP): `psp_charges_total{result}` (succeeded, declined, rate_limited, outage, idempotent_replay),
`psp_charged_cents_total`.

Workers: `stream_consumer_lag{stream,group}`, `stream_pending_messages{stream,group}`,
`stream_processed_total{result}` (ok, failed, dead_lettered), `stream_dlq_length`, `outbox_unpublished`, `outbox_relayed_total`.

Control plane: `runtime_flag{flag,mode}` (1 for the active mode), `integrity_violations{kind}` (oversold_units, negative_stock_skus, duplicate_orders, duplicate_charges,
orphan_charges, coupon_over_redemptions, price_mismatches, stuck_orders, lost_events, phantom_held_units, paid_uncommitted),
`business_orders{status}`.

Loadgen: `loadgen_step_duration_seconds{step,outcome}`, `loadgen_requests_total{step,code}`, `loadgen_arrivals_total{persona}`,
`loadgen_sessions_active`, `loadgen_sessions_total{persona,result}` (persona: shopper, bot; result: converted,
abandoned, failed, blocked, sold_out), `loadgen_arrival_rate_target`, `loadgen_arrivals_dropped_total`,
`loadgen_anomalies_total{kind}` (order_missing_after_pay, repurchased_after_missing_order, price_changed_at_checkout,
human_blocked_as_bot).

Steps (loadgen `step` label): auth, home, search, category, product, add_to_cart, view_cart, checkout, queue, pay, order_status.

Exporters: postgres-exporter (`pg_stat_database_deadlocks`, `pg_stat_activity_count`, `pg_locks_count`…),
redis-exporter (`redis_connected_clients`, `redis_commands_processed_total`, `redis_memory_used_bytes`…).
