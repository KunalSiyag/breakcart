# Architecture

BreakCart is deliberately shaped like a real (if small) e-commerce backend so that its failures are the real
ones. This document explains the moving parts, the request paths, where state lives, and the resilience
mechanisms the labs switch on and off.

## Services

| Service | Owns | Talks to | Notes |
|---|---|---|---|
| **gateway** (BFF) | Edge policy | catalog, inventory, cart, orders, recommendations, Redis | Stateless HMAC session tokens; rate limiting, load shedding, waiting room and bot checks run here; composes the home and product pages. |
| **catalog** | `catalog.*` (products, price history, sale windows) | Postgres, Redis | Product/deal cache with three strategies; ILIKE vs full-text search; authoritative prices use the DB clock. |
| **inventory** | `inventory.*` (stock, reservations) | Postgres, Redis | Four reservation strategies; lock ordering; TTL sweeper for abandoned holds. |
| **cart** | `bc:cart:*` hashes | catalog, Redis | Prices lines via catalog (per-item vs batch). Purchase limit of 2 on flash deals. |
| **orders** | `orders.*` (orders, items, coupons, outbox) | cart, catalog, inventory, payments, Postgres, Redis | Two-step checkout (reserve → pay), idempotency keys, coupons, payment orchestration, reconciler, outbox. |
| **payments** | `payments.charges` | Postgres | A mock third-party PSP with its own ledger, latency distribution, declines, late responses, rate limit and outages. |
| **recommendations** | — (reads catalog data) | Postgres | Non-critical by design. |
| **workers** | `fulfillment.*` | Redis stream, Postgres | Fulfilment consumer group, outbox relay, lag gauges. |
| **control-plane** | runtime state in Redis | everything | Flags/chaos/tuning writer, scenarios + timelines, labs, integrity auditor, Prometheus summary, SSE. |
| **loadgen** | — | gateway | Open-model behavioural traffic. |

All Node services share `server/src/shared`:

| Module | Responsibility |
|---|---|
| `server.ts` | Fastify factory: request ids, metrics, chaos hook, error envelope, `/health` `/ready` `/metrics`, graceful shutdown, kill command. Skips requests whose client already disconnected while they waited in a backlog, and records client aborts as status 499 (otherwise the slowest requests vanish from latency histograms). In-flight accounting uses the response's `close` event (once per request, finished or aborted) — `onResponse` never fires for aborted requests. |
| `http-client.ts` | `Upstream`: undici pool per dependency, timeouts, retries (none / naive / budgeted backoff), circuit breaker, keep-alive switch, metrics. |
| `breaker.ts` | Sliding-window circuit breaker, retry budget, full-jitter backoff. |
| `db.ts` | Observable, live-resizable `pg` pool; acquire timeout; statement timeout; chaos slow queries; error translation (deadlock, pool exhausted). |
| `redis.ts` | Chaos-aware Redis wrapper (latency, outage) + metrics. |
| `runtime.ts` | Subscribes to `bc:runtime` (pub/sub + 3s poll); exposes flags, chaos, tuning, and a skewable clock. |
| `chaos.ts` | Request chaos (latency, errors, hangs, CPU) and process chaos (memory leak, GC pauses). |
| `events.ts` | Incident timeline events (throttled per kind) to `bc:events`. |
| `defs.ts` · `labs.ts` · `scenarios.ts` | The curriculum: every knob, lab and traffic shape. |

## Request paths

### Browse

```
GET /api/home
  gateway ── catalog /sale
          ├─ catalog /deals            (cache: none | naive TTL | hardened)
          ├─ inventory /stock?ids=…    (timeout 1.5s → degraded: stock)
          └─ recommendations /recs     (blocking 30s  |  isolated 250ms + breaker + fallback)
```

### Buy

```
POST /api/cart/items     gateway (bot check on hot SKUs) → cart → catalog (validate) → Redis HINCRBY
POST /api/checkout       gateway (velocity, waiting-room pass) → orders
                           orders: idempotency claim → cart → [catalog /prices if authoritative]
                                   → coupon redeem → INSERT order (CREATED)
                                   → inventory POST /reservations (strategy) → AWAITING_PAYMENT
POST /api/orders/:id/pay gateway → orders
                           orders: idempotency claim → CAS AWAITING_PAYMENT→PAYMENT_IN_PROGRESS (or naive read/write)
                                   → inventory /extend (hold must still be alive)
                                   → payments POST /charges (timeout paymentTimeoutMs)
                                       200 → PAID (+ outbox row | dual-write XADD) → inventory /commit → clear cart
                                             (commit failed → bc:commit-retry, retried by the reconciler)
                                       402 → back to AWAITING_PAYMENT (customer may retry)
                                       timeout → PAYMENT_FAILED + release (bug)  |  PAYMENT_PENDING → reconciler
async                    workers: outbox relay → stream bc:stream:orders → fulfilment consumer → shipment + notification
```

### Order state machine

```
CREATED ──reserve ok──▶ AWAITING_PAYMENT ──pay──▶ PAYMENT_IN_PROGRESS ──200──▶ PAID
   │                        ▲    │                       │
   │ reserve failed         │    │ hold expired          ├──402 / PSP busy──▶ AWAITING_PAYMENT
   ▼                        │    ▼                       ├──timeout (naive)──▶ PAYMENT_FAILED
REJECTED                    │  EXPIRED                   └──timeout (hardened)──▶ PAYMENT_PENDING ──reconciler──▶ PAID | PAYMENT_FAILED
```

## Where state lives

| Data | Store | Why it matters |
|---|---|---|
| Products, prices, price history, sale windows | Postgres `catalog` | Price history lets the auditor know the right price at any moment. |
| Stock counters, reservations | Postgres `inventory` (+ Redis gate in `redis_lua`) | `available` has **no** `CHECK >= 0` so the naive path can oversell. |
| Orders, items, coupons, outbox | Postgres `orders` | No unique constraint on idempotency keys — the naive path must be able to duplicate. |
| Charges | Postgres `payments` | The PSP's own ledger: the auditor compares it with orders. |
| Shipments, notifications | Postgres `fulfillment` | "Paid but never shipped" is detectable. |
| Carts, idempotency records, rate-limit buckets, waiting-room counters, product-view marks | Redis | Fast, ephemeral, and a single point of failure if you let it be. |
| Order events | Redis stream + consumer group, DLQ stream | Lag, pending entries and poison messages are observable. |
| Runtime state (flags, chaos, tuning), sale window, incident log | Redis (`bc:runtime`, `bc:sale`, `bc:events:log`) | Written only by the control plane. |

## Resilience mechanisms (and their naive twins)

| Concern | Naive | Hardened | Lab |
|---|---|---|---|
| Contended counters | read → decide → write | atomic conditional UPDATE / Lua | oversell-race, coupon-overrun |
| Locking | cart order | global order (sorted SKUs) | deadlocks |
| Holds | forever | TTL + sweeper + extend-before-charge | phantom-sellout |
| Caching | fixed TTL cache-aside | L1 + single-flight + lock + jitter + SWR | cache-stampede |
| Price changes | wait for TTL | pub/sub invalidation + re-validate at checkout | stale-price |
| Dependencies | wait 30s | timeout + breaker + fallback | cascading-failure |
| Retries | 3× immediate, everything | idempotent only, backoff + jitter, 10% budget | retry-storm |
| Overload | accept everything | priority load shedding | overload-collapse |
| Admission accounting | release slot in `onResponse` | release on the response's `close` (also on client abort) | shedding-death-spiral |
| Spikes | first come first crash | virtual waiting room | thundering-herd |
| Duplicates | none | Idempotency-Key + CAS + PSP key | double-charge |
| Ambiguous payments | timeout = failure | PENDING + reconciliation | payment-limbo |
| Events | dual write | transactional outbox | lost-events |
| Bad messages | retry forever | bounded retries + DLQ | poison-pill |
| Replicas | always replica | read-your-writes window | replica-lag |
| Protective dependencies | fail closed | fail open + shedding backstop | redis-blip |

## Business invariants (the auditor)

`control-plane/integrity.ts` runs every 5 seconds across all schemas and exports `integrity_violations{kind}`:

| Invariant | Query idea |
|---|---|
| No oversell | Σ reservations (HELD + COMMITTED) per SKU ≤ total |
| No negative stock | `available >= 0` |
| One order per idempotency key | group by (user, key) |
| One successful charge per order | group by order in the PSP ledger |
| Every charge has a paid order | charges joined to non-paid orders (5 s grace) |
| Coupon cap | `used <= max_uses`, redemptions ≤ cap |
| Correct price | charged price = price effective at order time (3 s grace for in-flight reads) |
| No stuck orders | no transient state older than 2 min |
| Every paid order ships | shipment within 30 s |
| No phantom holds | no HELD reservation older than 90 s |
| Paid orders keep their stock | every PAID order (30 s grace) has a COMMITTED reservation |

Latency and error rates tell you the system is *slow*; these tell you it is *wrong*.

## Lessons the platform itself taught

Building the labs surfaced real bugs in BreakCart's own "hardened" code; each became a fix and most became lab material:

- **Leaky in-flight counters.** In-flight gauges and the load shedder's admission count were decremented in
  `onResponse`, which never runs for a client that hangs up first. Under timeouts the counters ratcheted up until the
  gateway shed everything — now lab `shedding-death-spiral`.
- **Shedding on a count when the shedder is the bottleneck.** When the gateway's own CPU saturates, requests wait in
  its event loop before being counted, so an in-flight limit never trips. The gateway now also sheds on queueing delay.
- **Work outlives its customers.** Queries and requests abandoned by callers keep running (no deadline propagation),
  so overload lingers after the traffic stops — the server now skips requests whose client is gone.
- **Accidental lock ordering.** `ioredis.hgetall()` returns an object, and JS objects order integer-like keys
  numerically, so every cart came back sorted by product id — silently preventing the deadlocks the deadlocks lab
  needed. The cart now reads the raw reply to keep insertion order.
- **"Idempotent" checkout that wasn't, under stress.** With the database pool exhausted, a checkout could create its
  order and reserve stock, then time out on its final read and answer 503. A 5xx releases the idempotency key so the
  customer can retry — and the retry created a second order holding a second unit of stock. The business-invariant
  auditor caught it (duplicate orders under the *hardened* baseline). Checkout is now resumable: the order id is derived
  from (customer, key), each step is idempotent, and abandoned half-finished checkouts are swept after 2 minutes.
- **A 10-minute "extend" before payment** kept abandoned holds alive — the very phantom-sellout bug the hardened mode
  was supposed to fix. Holds are now extended only for the payment window (PSP timeout + 2 min) and re-armed to the
  normal TTL on failure.
- **Paid, but the stock never committed.** When the stock commit failed after a successful payment, nothing retried it:
  the hold expired, the sweeper put the unit back on sale, and no invariant noticed (the oversold check counts only
  HELD and COMMITTED reservations). Failed commits now go to a retry queue (`bc:commit-retry`) that the reconciler
  drains; a hold that expired first raises a critical alarm, and the `paid_uncommitted` invariant counts it. That
  invariant then caught the reconciler's own commit call swallowing errors: under load it settled stuck payments just
  after their 64 s pre-charge holds ran out, the commit failed, and nothing retried it. The reconciler now uses the same
  queue, and the pre-charge hold outlasts its 60 s stall threshold by a minute. Re-verification then caught the queue
  falling behind in the hardened retry-storm run (one commit at a time against a slow inventory, so up to 257 paid orders
  waited more than 30 s for their stock); it now retries ten at a time, and skips orders that a data reset removed
  instead of alarming.
- **Tracing isn't free, and NodeSDK adds a metrics pipeline you didn't ask for.** A CPU profile of the gateway showed
  OpenTelemetry instrumentation at roughly 20–25% of its CPU even with 5% head sampling (instrumentation runs on every
  request; only export is sampled), and NodeSDK silently starts an OTLP *metrics* exporter when
  `OTEL_METRICS_EXPORTER` is unset. Metrics/logs exporters are now off, Redis/pg spans require a traced parent, and the
  gateway scales out to four replicas (a ×1 midnight peak needs ~2.5 cores of edge on this hardware).

## Simulations and their limits

- **Replica lag** is simulated in `orders` by hiding rows newer than `replicaLagMs` (and showing just-paid orders as
  unpaid). There is one Postgres.
- **The PSP** is a local service. Its failure modes are modelled on real gateway behaviour.
- **GC pauses** are simulated with a busy-wait of the event loop; the effect on in-flight requests is the same.
- Everything else (races, deadlocks, pool exhaustion, cache stampedes, OOM kills, synchronous logging, retry
  amplification, connection churn) happens for real.
