# Observability guide

How to see what BreakCart is doing: where the dashboards are, how to read them, which panel
shows which lab, how the SLO alerts work, and PromQL you can paste into Prometheus or Grafana
Explore.

| Tool | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3300 | Anonymous admin. The home page is the **Sale Day War Room**. All dashboards are in the *BreakCart* folder. |
| Prometheus | http://localhost:9091 | `/alerts` shows alert states and their `runbook`. `/rules` shows recording rules. `/query` runs ad-hoc PromQL. |
| Jaeger | http://localhost:16686 | Traces, sampled at 5% (`OTEL_SAMPLE_RATIO` in `docker-compose.yml`). |
| War room (web) | http://localhost:8080 | The React war room: flags, chaos and labs. Grafana is where you dig deeper. |

The configuration lives in these files:

- `infra/prometheus/prometheus.yml` (scrape config)
- `infra/prometheus/rules/recording.yml` and `rules/alerts.yml`
- `infra/grafana/provisioning/` (datasources and dashboard provider)
- `infra/grafana/dashboards/*.json`

Metric names and labels are defined in `docs/contract.md` §5.

**Speed.** Prometheus scrapes every service every **2s** and evaluates rules every **5s**.
Dashboards refresh every 5s and use **30s / 1m** rate windows, so a flag flip shows up within
about 30 seconds. Real production setups use 15-60s scrapes and 5m windows. Here everything is
compressed because a lab run lasts minutes.

---

## The dashboards

### Sale Day War Room (`breakcart-war-room`)

One screen for sale day. Read it top to bottom:

1. **Edge — golden signals.** Gateway RPS, 5xx rate, p95/p99, in-flight requests, and the
   checkout error-budget burn rate. This row answers "are customers hurting?".
2. **Business throughput.** Orders created/min, paid/min, GMV/min (₹), payment success, the
   waiting-room queue and the fulfillment consumer lag. This row answers "is the sale making
   money?".
3. **Integrity.** Oversold units, duplicate charges, orphan charges, plus the seven other
   invariants from the control-plane checker. These must stay **0**. A non-zero value is a
   correctness bug, not a performance problem. It will not fix itself when the load drops.
4. **Now.** *Firing alerts* (critical first; the `lab` column names the lab that teaches the
   failure) and *Service health*.
5. **Edge traffic & latency.** Latency heatmap, percentiles with the 1s SLO line, requests by
   route, non-2xx responses by status, and **error responses by code**. The code separates what
   one status hides: a 409 can be `OUT_OF_STOCK`, `QUEUE_REQUIRED` or `PRICE_CHANGED`, and a
   503 can be `OVERLOADED` or `UPSTREAM_UNAVAILABLE`.
6. **What customers experience.** Per-step p95 measured by the load generator, and how sessions
   ended.
7. **Orders, dependencies & saturation.** Checkout/payment outcomes, circuit breakers,
   event-loop lag, DB pool waiting, and active chaos.

### Service Golden Signals (`breakcart-services`)

RED and saturation per service. Use the `service` selector to narrow it down.

- **Traffic & errors.** Request rate, 5xx ratio, error responses by code, p50/p95/p99,
  in-flight, non-2xx by status, and a sortable per-route table.
- **Saturation (Node.js runtime).** Event-loop lag p99 and max, CPU (100% = one core, the
  ceiling for single-threaded JS), RSS against the 512 MiB container limit, heap vs external
  memory, memory growth rate, GC time and runs, active handles.
- **Dependencies.** Outbound calls per target, failures by outcome (`http_error`, `timeout`,
  `network_error`, `circuit_open`), call p99, retries, retry amplification, breaker state and
  transitions. Also **TCP connections opened/s** and **new connections per call**: about 0
  with keep-alive, about 1 without.
- **Lifecycle.** Up/down timeline, restarts in range, active chaos.

### Data Layer (`breakcart-data`)

- **Connection pools.** Waiting, idle, busy/open/max (`max` is the configured `dbPoolSize`),
  pool utilization (busy ÷ max), acquire time, acquire timeouts, and DB errors by SQLSTATE.
- **Queries.** p99 and rate by `op`, queries per HTTP request (the N+1 detector), failed
  queries.
- **Postgres server** (postgres-exporter). Deadlocks, backends by state against
  `max_connections`, locks by mode, commits vs rollbacks, longest open transaction.
- **Replication & clocks.** Order-history replica lag (`db_replica_lag_seconds`), and each
  service's clock offset from real time (`clock_offset_seconds`; negative = behind).
- **Redis.** App-side p99 by op and by service, errors, server commands/s, memory against
  `maxmemory`, clients.
- **Caches.** Hit ratio, lookups by result, rebuilds/s, and concurrent rebuilds (the stampede
  meter).
- **Streams.** Consumer lag, pending messages, processed by result, DLQ length, outbox backlog,
  event publishing by mode.

### Business & Edge Protection (`breakcart-business`)

- **Funnel & money.** Checkouts, payments and PSP charges by result. *GMV vs charged by the
  PSP*: if the PSP charged more than paid orders are worth, someone was charged for nothing.
  Also orders by status, reconciler outcomes and coupon redemptions.
- **Inventory.** Reservations by strategy and result, reservation latency, hot-SKU available
  units (below zero = oversold) and expired reservations.
- **Edge protection.** Rate-limiter decisions, load shed by priority, bot blocks by reason,
  waiting-room queue and admissions, guest sessions.

### Load Generator (`breakcart-loadgen`)

The built-in traffic generator's view:

- Target vs actual arrival rate (`loadgen_arrivals_total`, split by persona), and dropped
  arrivals.
- Active sessions, and time in system (Little's law).
- Customer-measured vs server-measured p95.
- Per-step percentiles and a step table.
- Response codes, sessions by persona and result, shopper conversion, bot share of purchases.
- The anomalies customers noticed.

k6 traffic (`k6/`) does **not** appear here, only on the other dashboards.

### Chaos and annotations

Each dashboard has four annotation toggles at the top:

- **Restarts** (red, on). A service's `process_start_time_seconds` changed. Causes: a crash,
  an OOM kill, or the `kill-service` action.
- **Critical alerts** (orange, on). The time ranges where a `severity="critical"` alert fired.
- **Chaos** (purple, off by default). Shaded while `chaos_active{kind}` is 1 on a service.
  Kinds: `latency`, `errors`, `hang`, `cpu_burn`, `memory_leak`, `gc_pause`, `clock_skew`,
  `db_slow`, `redis`.
- **Flag flips** (blue, on). A runtime flag changed mode, labelled `flag → new mode`.
  `runtime_flag{flag,mode}` is 1 for the active mode and 0 for the others. A flip therefore
  changes two series, and the query `changes(runtime_flag[10s]) > 0 and runtime_flag == 1` keeps
  only the newly active one. "Did the graph change when I flipped the flag?" is the core lab
  question, and this marker answers it.

Check *Active chaos* before you debug. A symptom that matches an injected fault is not a code
bug. The `ChaosActive` alert (severity `info`) shows the same thing in the alert table.

---

## Methods: golden signals, RED and USE

**The four golden signals** (Google SRE): latency, traffic, errors, saturation. The top row of
the war room is exactly these four, measured at the edge where customers feel them.

**RED** (for request-driven services): **R**ate, **E**rrors, **D**uration. Each service's
`http_server_request_duration_seconds` histogram gives all three:

```promql
sum by (service) (rate(http_server_request_duration_seconds_count[30s]))                    # Rate
sum by (service) (rate(http_server_request_duration_seconds_count{status=~"5.."}[30s]))     # Errors
histogram_quantile(0.99, sum by (le, service) (rate(http_server_request_duration_seconds_bucket[30s])))  # Duration
```

**USE** (for resources): **U**tilization, **S**aturation, **E**rrors. Saturation is the one
that warns you early. It is work that is *waiting*.

| Resource | Utilization | Saturation (waiting) | Errors | Where |
|---|---|---|---|---|
| Node event loop | CPU (`process_cpu_seconds_total`) | `nodejs_eventloop_lag_p99_seconds` | – | Services → Saturation |
| Gateway concurrency | `http_server_inflight_requests` vs `gatewayMaxInflight` | `gateway_shed_total` | 503 OVERLOADED | War Room, Business |
| DB connection pool | busy ÷ max (`db_pool_connections{state="max"}`) | `db_pool_connections{state="waiting"}`, acquire time | `db_errors_total{code="acquire_timeout"}` | Data → Pools |
| Postgres | `pg_stat_activity_count` vs `max_connections` | lock waits (`pg_locks_count`), longest transaction | deadlocks, rollbacks | Data → Postgres |
| Redis | commands/s, memory vs `maxmemory` | `redis_command_duration_seconds` p99 | `outcome="error"` | Data → Redis |
| Downstream services | calls/s, new TCP connections/s | call p99, retries | outcomes ≠ ok, breaker open | Services → Dependencies |
| Fulfillment consumer | processed/s | `stream_consumer_lag`, pending | failed, DLQ | Data → Streams |
| Memory | RSS vs 512 MiB limit | GC time | OOM kill → restart | Services → Saturation |

Two rules of thumb. Utilization tells you how busy something is. Saturation tells you that
someone is waiting, and waiting is what turns into latency. When a request is slow, find where
it was waiting.

---

## Reading latency

Every duration metric is a Prometheus **histogram**. It has cumulative counters per bucket
(`_bucket{le="0.25"}` counts requests that took at most 0.25s), plus `_sum` and `_count`. To get
a percentile:

```promql
histogram_quantile(0.99, sum by (le, route) (rate(http_server_request_duration_seconds_bucket{service="gateway"}[30s])))
```

1. `rate(...[30s])` turns the cumulative counters into per-second rates over the last 30s.
2. `sum by (le, ...)` adds up instances and labels you don't care about. **Always keep `le`.**
3. `histogram_quantile` finds the bucket where the 99th percentile falls and interpolates inside
   it.

Things to know:

- **Percentiles are estimates.** The HTTP buckets are .005 .01 .025 .05 .1 .25 .5 1 2.5 5 10 30
  seconds. A p99 of "1.7s" really means "somewhere between 1s and 2.5s". The `le="1"` bucket is
  exact, which is why the latency SLO is defined at 1s.
- **Don't average percentiles.** You cannot average p99s across services or across time. Sum
  the buckets first, then take the quantile, as the query above does.
- **Averages hide the tail.** The mean is `rate(_sum) / rate(_count)`. One request stuck for 30s
  among 999 fast ones barely moves the mean, but it ruins the p99.
- **p50 vs p99.** p50 steady while p99 climbs: a minority of requests is stuck (lock waits,
  timeouts, GC pauses). Both climbing: the whole service is saturated.
- **Heatmaps show shape.** The war-room heatmap shows every bucket over time. A second bright
  band at 5s, 10s or 30s is requests waiting for a timeout. A band drifting upwards is a queue
  growing.
- **Customer vs server latency.** The load generator measures latency on the client. Server
  metrics can't see time spent before the request reached the handler (connection setup,
  queueing). The *Customer vs server latency* panel shows the gap.
- **`rate(_sum)` is average concurrency.** `rate(http_server_request_duration_seconds_sum[1m])`
  is "seconds of request time per second". By Little's law, that is the average number of
  requests in flight.

---

## SLOs, error budgets and burn rates

| SLO | Objective | Good event | Error budget |
|---|---|---|---|
| `checkout-availability` | 99.5% | `POST /api/checkout` or `POST /api/orders/:id/pay` at the gateway that is **not** 5xx | 0.5% of requests |
| `gateway-latency` | 99% | `/api/*` request at the gateway that completes in **≤ 1s** | 1% of requests |

4xx responses are good events for availability. `OUT_OF_STOCK`, `RATE_LIMITED`,
`QUEUE_REQUIRED` and `PAYMENT_DECLINED` are correct answers. A fast `503 OVERLOADED` counts as a
good latency event but a bad availability event, which is why you need both SLOs.

**Error budget.** The error budget is `1 − objective`: the share of requests you are *allowed*
to fail. At 99.5%, 1 in 200 checkouts may fail.

**Burn rate.** `error ratio ÷ error budget`. It says how fast you are spending the budget:

- **1x**: the budget lasts exactly the SLO period.
- **14.4x**: a 30-day budget is gone in about 2 days. One hour at 14.4x spends 2% of the month's
  budget.

| Alert | Long window | Short window | Burn rate | Fires when the error ratio exceeds | Severity |
|---|---|---|---|---|---|
| `CheckoutAvailabilityFastBurn` | 5m | 1m | 14.4x | 7.2% | critical (page) |
| `CheckoutAvailabilitySlowBurn` | 30m | 5m | 6x | 3% | warning (ticket) |
| `GatewayLatencyFastBurn` | 5m | 1m | 14.4x | 14.4% slower than 1s | critical |
| `GatewayLatencySlowBurn` | 30m | 5m | 6x | 6% slower than 1s | warning |

These are **multi-window, multi-burn-rate** alerts (Google SRE Workbook, ch. 5). The production
versions use 1h + 5m and 6h + 30m windows for a 30-day SLO. Here the windows are compressed so
an alert can fire and clear within one lab run.

- **The long window** makes the alert *significant*. A 10-second blip doesn't page.
- **The short window** makes it *current*. Once the problem is fixed, the alert clears within
  about a minute instead of firing for the rest of the long window.
- **A low-traffic guard** (`slo:sli_total:rate1m > 0.2`) stops 1 failure out of 3 requests from
  paging anyone.

The recording rules behind the panels and alerts:

- `slo:sli_error:ratio_rate{1m,5m,30m}{slo}`: the error ratio per window.
- `slo:burn_rate:rate{1m,5m,30m}{slo}`: the burn rate per window.
- `slo:error_budget:ratio{slo}` and `slo:objective:ratio{slo}`: constants.

The war room shows `slo:burn_rate:rate5m{slo="checkout-availability"}`.

### Triage an SLO alert

An SLO alert tells you customers are hurting. It does not tell you why. Work from symptom to
cause:

1. **Error or latency?** On the war room, look at *Error responses by code* (next to *Non-2xx
   responses by status*). It names the reason:
   - `OVERLOADED` means shedding.
   - `UPSTREAM_UNAVAILABLE` means a dependency or the DB pool.
   - `PAYMENT_TIMEOUT` means the PSP.
   - `INJECTED_FAULT` means chaos.
   - `INTERNAL` means a bug.
2. **What else is firing?** *Firing alerts* lists cause alerts such as `DbPoolExhausted`,
   `CircuitBreakerOpen`, `EventLoopLagHigh` or `PaymentTimeouts`. Their `lab` label names the
   lesson.
3. **Is it injected?** Check *Active chaos*.
4. **Follow the dependency chain.** On Services, *Failed calls by outcome* shows which
   caller → target pair is failing. The deepest failing service is usually the cause; everyone
   above it is a victim.
5. **Look at that service's resources.** Check the event loop, the DB pool (Data dashboard),
   Redis and its own dependencies.
6. **Find an example.** The *Latency p99* stat links to slow gateway traces in Jaeger.
7. **Fix it and watch the alert clear.** Flip the flag to its hardened mode. The 1m burn rate
   falls first and the alert clears. The 5m and 30m rates take longer to recover. That is what
   the budget looks like being spent.

---

## Lab → where to look

| Lab | Flag / knob | What you see first | Where | Alerts |
|---|---|---|---|---|
| `oversell-race` | `inventory.reserve` | Oversold units > 0; hot-SKU stock below 0 | War Room → Integrity; Business → *Hot SKU available units*, *Reservation latency* (select_for_update p99 grows); Data → *Locks by mode* | `IntegrityOversoldUnits`, `IntegrityNegativeStock`, `HotSkuNegativeStock` |
| `deadlocks` | `inventory.lockOrdering` | SQLSTATE 40P01, reservations with result `deadlock` | Data → *DB errors by code*, *Deadlocks*; Business → *Reservations by strategy and result* | `AppDeadlocks`, `PostgresDeadlocks` |
| `phantom-sellout` | `inventory.reservationTtl` | Hot SKUs at 0 while *Expired reservations* stays 0; shoppers end `sold_out` | Business → *Hot SKU stock now*, *Expired reservations*; War Room → *Other integrity checks* (`phantom_held_units`) | `IntegrityPhantomHeldUnits` |
| `cache-stampede` | `catalog.cache`, action `flush-cache` | Hit-ratio cliff; dozens of concurrent rebuilds; catalog pool waiting | Data → *Concurrent rebuilds*, *Cache hit ratio*, *Cache rebuilds per second*, *Waiting for a connection* | `CacheStampede`, `CacheHitRatioLow`, `DbPoolWaiting` |
| `stale-price` | `catalog.priceInvalidation`, `orders.pricing`, action `price-change` | Price mismatches; checkouts with `price_changed` | War Room → *Other integrity checks*; Load Generator → *Anomalies*; Business → *Checkouts by result* | `IntegrityPriceMismatch`, `CustomersSeePriceChanges` |
| `n-plus-one` | `catalog.listQuery`, `cart.pricing` | Queries per request jump from ~1 to ~25; catalog request rate ≫ gateway rate | Data → *Queries per HTTP request*, *Queries per second by op*; Services → *Request rate* | `QueryAmplification` |
| `slow-search` | `catalog.search` | `search.ilike` p99 in seconds; catalog pool starves | Data → *Query latency p99 by op*, *Longest open transaction*, *Waiting for a connection* | `SlowQueries`, `StatementTimeouts`, `DbPoolWaiting` |
| `cascading-failure` | `bff.nonCriticalDeps` + latency/hang chaos on recommendations | gateway → recommendations calls take 30s; gateway in-flight and p99 explode | Services → *Call latency p99 by target*, *Failed calls by outcome*; War Room → *Gateway in-flight* | `UpstreamTimeouts`, `GatewayInflightHigh`, `GatewayLatencyFastBurn` |
| `retry-storm` | `platform.retries`, `platform.circuitBreaker` | Retries multiply load on a failing target; breakers never open (off) or open and fail fast (on) | Services → *Retries per second*, *Retry amplification*, *Circuit breaker state*; War Room → *Circuit breakers* | `RetryStorm`, `CircuitBreakerOpen`, `RetryBudgetExhausted` |
| `connection-churn` | `platform.keepAlive` | New TCP connections per call jumps from ~0 to ~1; higher CPU and call latency at the same throughput | Services → *TCP connections opened/s by target*, *New connections per call*, *CPU*, *Call latency p99 by target* | `ConnectionChurn`, `ServiceCpuSaturated` |
| `logging-meltdown` | `platform.logging` | Event-loop lag p99 in hundreds of ms on every service; scrapes time out (DOWN flaps) | Services → *Event loop lag p99*, *CPU*; War Room → *Service health* | `EventLoopLagHigh`, `ServiceDown` |
| `rate-limit-bursts` | `gateway.rateLimit` | `limited` decisions and 429s; fixed windows let 2x bursts through at window edges | Business → *Rate limiter decisions*; War Room → *Error responses by code* (`RATE_LIMITED`) | `RateLimitingHeavy` |
| `redis-blip` | `gateway.rateLimitFailMode`, chaos `redisDown` / `redisLatencyMs` | `error_rejected` (fail closed: outage) vs `error_allowed` (fail open) | Business → *Rate limiter decisions*; Data → *Redis errors*, *Redis p99 by service* | `RateLimiterFailingClosed`, `RateLimiterFailingOpen`, `RedisCommandErrors`, `RedisSlow` |
| `overload-collapse` | `gateway.loadShedding`, tuning `gatewayMaxInflight` | Off: in-flight climbs until everything times out. On: low-priority 503s, checkout survives | War Room → *Gateway in-flight*, *Latency p99*, *Error responses by code* (`OVERLOADED`); Business → *Load shed by priority* | `GatewayInflightHigh`, `GatewayShedding`, `CriticalTrafficShed`, `GatewayLatencyFastBurn` |
| `shedding-death-spiral` | `gateway.inflightAccounting` | Shedding continues after the dependency recovers; the shedder's count stays high while real in-flight is near zero | Explore: `sum(gateway_admission_inflight)` vs `sum(http_server_inflight_requests{service="gateway"})`; 499s in `http_server_request_duration_seconds_count{status="499"}`; Business → *Load shed by priority* (`reason` label: `inflight` vs `queue_delay`) | `AdmissionCounterLeak` |
| `thundering-herd` | `gateway.waitingRoom` | Checkout spike at sale start, inventory/orders pools fill; with the waiting room, a queue instead | War Room → *Requests by route*, *Waiting room*, *Error responses by code* (`QUEUE_REQUIRED`); Business → *Waiting room queue*, *Waiting room admissions* | `CheckoutLatencyHigh`, `CheckoutAvailabilityFastBurn` |
| `bot-army` | `gateway.botProtection` | Bots convert while shoppers sell out; with protection, `bot_blocked` by reason | Business → *Bot blocks by reason*; War Room → *Error responses by code* (`BOT_SUSPECTED`); Load Generator → *Bot share of purchases*, *Sessions by persona and result* | `BotsWinningStock`, `BotTrafficBlocked`, `ShoppersBlockedAsBots` |
| `double-charge` | `orders.idempotency` | Duplicate charges/orders; PSP charged > GMV; no `idempotent_replay` at the PSP | War Room → Integrity; Business → *Money: GMV vs charged by the PSP*, *PSP charges by result* | `IntegrityDuplicateCharges`, `IntegrityDuplicateOrders`, `CustomersSeeDuplicateCharges` |
| `payment-limbo` | `orders.paymentTimeout`, PSP `lateResponsePct` | Payment `timeout`s; orphan charges (mark_failed) or a PAYMENT_PENDING pile that the reconciler drains | Business → *Payments by result*, *Orders by status*, *Reconciler outcomes*; War Room → *Orphan charges* | `PaymentTimeouts`, `IntegrityOrphanCharges`, `IntegrityStuckOrders`, `PaymentsPendingPileUp` |
| `lost-events` | `orders.eventPublishing`, data chaos `eventPublishFailPct` | `dual_write failed` events; paid orders never shipped | Data → *Event publishing*, *Outbox backlog*; War Room → *Other integrity checks* (`lost_events`) | `EventPublishFailures`, `IntegrityLostEvents`, `OutboxBacklogGrowing` |
| `coupon-overrun` | `orders.coupon` | More than 200 `BIGSALE500` redemptions succeed | Business → *Coupon redemptions*, *Coupons redeemed in range*; War Room → *Other integrity checks* | `IntegrityCouponOverRedemption` |
| `replica-lag` | `orders.readConsistency`, data chaos `replicaLagMs` | Replica lag above 1s, and customers don't see the order they just paid for (and pay again). The lag stays in the fixed variant; read-your-writes routing is what removes the anomaly | Data → *Replica lag*, *Replica lag over time*; Load Generator → *Anomalies per minute* (`order_missing_after_pay`), *Order missing after pay* | `ReplicaLagHigh`, `CustomersSeeMissingOrders` |
| `poison-pill` | `workers.poisonMessages`, action `inject-poison` | Consumer lag grows without bound and `failed` repeats (retry_forever); or the DLQ fills and lag recovers (dead_letter) | Data → *Consumer lag*, *Pending*, *Messages processed by result*, *DLQ length*; War Room → *Consumer lag* | `ConsumerLagGrowing`, `DeadLetterQueueNotEmpty` |
| `memory-leak` | chaos `leakMbPerMin` | RSS ramps to the 512 MiB line, then a restart | Services → *Resident memory (RSS)*, *Memory growth rate*, *Heap used & external memory*, *Restarts in range*; Restarts annotation | `MemoryGrowing`, `MemoryNearContainerLimit`, `ServiceRestarted`, `ServiceDown` |
| `gc-pauses` | chaos `gcPauseMs` / `gcPauseEverySec` | Periodic event-loop stalls; a striped heatmap; p99 up while p50 is flat | Services → *Event loop lag max*, *Time in GC*; War Room → *Gateway latency heatmap* | `EventLoopStalls`, `GcTimeHigh` |
| `clock-skew` | chaos `clockSkewMs` | One service's clock offset beyond ±1s. Then time-based logic misfires: waiting-room passes rejected, reservations expiring early, `SALE_NOT_STARTED` errors | Data → *Clock offset by service*; War Room → *Error responses by code* (`QUEUE_REQUIRED`, `SALE_NOT_STARTED`); Business → *Waiting room admissions*, *Expired reservations* | `ClockSkew` |
| `pool-exhaustion` | tuning `dbPoolSize`, chaos `dbSlowMs`/`dbSlowPct` | `waiting > 0` while `idle == 0`; acquire time near 3s; then `acquire_timeout` errors and 503s | Data → *Waiting for a connection*, *Pool utilization*, *Busy / open / max connections*, *Connection acquire time p99*, *Acquire timeouts*, *Backends by state* | `DbPoolWaiting`, `DbPoolExhausted`, `DbAcquireTimeouts`, `PostgresConnectionsNearLimit` |

---

## Alert catalogue

Every alert has these fields:

- `severity`: `critical` (customer impact or wrong data), `warning` (look now), or `info`
  (context).
- `lab`: the lab id, or `none` for infrastructure alerts.
- `runbook`: points to `docs/labs/<lab>.md`.
- `summary` and `description`.

Some also carry `related_labs` and `triage`. There is no Alertmanager. Firing alerts show up in:

- Prometheus → Alerts
- Grafana → Alerting → Alert rules (data-source managed, read-only)
- the war-room *Firing alerts* table, which reads the synthetic `ALERTS` series
- the *Critical alerts* annotation

| Group | Alerts |
|---|---|
| SLO burn rate | `CheckoutAvailabilityFastBurn`, `CheckoutAvailabilitySlowBurn`, `GatewayLatencyFastBurn`, `GatewayLatencySlowBurn` |
| Integrity | `IntegrityOversoldUnits`, `IntegrityNegativeStock`, `IntegrityDuplicateCharges`, `IntegrityOrphanCharges` (critical); `IntegrityDuplicateOrders`, `IntegrityCouponOverRedemption`, `IntegrityPriceMismatch`, `IntegrityStuckOrders`, `IntegrityLostEvents`, `IntegrityPhantomHeldUnits`, `IntegrityCheckerSilent` |
| Saturation | `DbPoolWaiting`, `DbPoolExhausted`, `DbAcquireTimeouts`, `PostgresConnectionsNearLimit`, `EventLoopLagHigh`, `EventLoopStalls`, `ServiceCpuSaturated`, `GatewayInflightHigh`, `GatewayShedding`, `CriticalTrafficShed`, `CheckoutLatencyHigh` |
| Resilience | `ServiceDown`, `ServiceRestarted`, `ServiceErrorRateHigh`, `CircuitBreakerOpen`, `CircuitBreakerFlapping`, `RetryStorm`, `RetryBudgetExhausted`, `UpstreamTimeouts`, `DependencyFailing`, `ConnectionChurn`, `RateLimiterFailingClosed`, `RateLimiterFailingOpen`, `RateLimitingHeavy`, `BotTrafficBlocked` |
| Data | `AppDeadlocks`, `PostgresDeadlocks`, `SlowQueries`, `StatementTimeouts`, `QueryAmplification`, `CacheStampede`, `CacheHitRatioLow`, `RedisCommandErrors`, `RedisSlow`, `RedisDown`, `PostgresDown`, `ExporterDown`, `ReplicaLagHigh`, `ConsumerLagGrowing`, `DeadLetterQueueNotEmpty`, `OutboxBacklogGrowing`, `EventPublishFailures` |
| Business | `PaymentSuccessLow`, `PaymentTimeouts`, `PaymentsPendingPileUp`, `PspErrorRateHigh`, `PspOutage`, `HotSkuNegativeStock` |
| Process | `MemoryGrowing`, `MemoryNearContainerLimit`, `GcTimeHigh`, `ClockSkew`, `ChaosActive` |
| Customer (loadgen) | `CustomersSeeMissingOrders`, `CustomersSeeDuplicateCharges`, `CustomersSeePriceChanges`, `ShoppersBlockedAsBots`, `BotsWinningStock`, `LoadgenDroppingArrivals` |

Some alerts mean "the hardened mode is working", not that something is broken:

- `RetryBudgetExhausted`
- `GatewayShedding`
- `DeadLetterQueueNotEmpty`
- `BotTrafficBlocked`

A good engineer still wants to know about these. They are capacity and abuse signals.

---

## Recording rules

`infra/prometheus/rules/recording.yml` precomputes the common series. The naming follows
`level:metric:operation`, where the level is the labels the result is aggregated by.

| Group | Examples |
|---|---|
| HTTP (RED) | `service:http_requests:rate30s`, `service:http_errors:ratio_rate30s`, `service:http_latency_seconds:p99_30s`, `service_route:http_latency_seconds:p99_30s`, `service_status:http_requests:rate30s`, `service_code:http_server_errors:rate30s`, `gateway:api_latency_seconds:p{50,95,99}_30s` |
| Runtime | `service:process_cpu_seconds:rate30s`, `service:nodejs_eventloop_lag_p99_seconds:max`, `service:nodejs_gc_seconds:rate30s`, `service:process_resident_memory_bytes:deriv5m` |
| Dependencies | `service_target:http_client_failures:ratio_rate30s`, `service_target:http_client_latency_seconds:p99_30s`, `service_target:http_client_retries:ratio_rate1m`, `service_target:http_client_connections_per_call:ratio_rate1m` |
| Data | `service:db_pool_waiting:max`, `service:db_pool_busy:sum`, `service:db_pool_utilization:ratio`, `service:db_queries_per_request:ratio_rate1m`, `cache:cache_requests:hit_ratio_rate30s`, `cache:cache_rebuild_inflight:sum` |
| Business | `orders:checkout_success:ratio_rate1m`, `orders:payment_success:ratio_rate1m`, `orders:gmv_cents:rate1m`, `psp:charge_errors:ratio_rate1m` |
| SLO | `slo:sli_error:ratio_rate{1m,5m,30m}`, `slo:burn_rate:rate{1m,5m,30m}`, `slo:error_budget:ratio` |

The dashboards mostly query raw metrics, so you can copy any panel query and learn from it.
Use the recording rules for quick checks and your own alerts.

---

## Open vs closed load and coordinated omission

BreakCart's load generator and the k6 scripts use an **open** workload model. Customers
*arrive* at a scheduled rate, whether or not the site keeps up, just like real users at
00:00:00. A **closed** model, with a fixed number of users who each wait for a response before
sending the next request, quietly reduces the load when the system slows down. It hides exactly
the failures this lab is about.

When the generator cannot start an arrival because it hit its session cap, it counts a **dropped
arrival** (`loadgen_arrivals_dropped_total`, alert `LoadgenDroppingArrivals`). Dropped arrivals
mean the applied load was lower than the scenario says, so the results understate the damage.

**Coordinated omission** is a closed-loop client failing to send requests while the server is
stalled, so the worst experiences are never measured. See `k6/README.md` for the long version
and Little's law sizing.

---

## Traces

Services (except control-plane and loadgen) export OpenTelemetry traces to Jaeger at a 5%
sample rate. Ways in:

- The *Latency p99* stat and the *Gateway latency percentiles* panel link to Jaeger, searching
  for gateway traces slower than 1s.
- In Grafana Explore, pick the **Jaeger** datasource. A span's *Related metrics* link opens the
  emitting service's request rate, 5xx ratio and p99. This is configured via
  `tracesToMetrics`.
- If services attach `trace_id` exemplars to histograms, the Prometheus datasource already
  links them to Jaeger.

A trace shows where one slow request spent its time. Metrics tell you whether that request was
typical. Use metrics to find the pattern and traces to explain one example.

---

## Useful PromQL

```promql
# Golden signals at the edge
sum(rate(http_server_request_duration_seconds_count{service="gateway", route=~"/api/.*"}[30s]))
(sum(rate(http_server_request_duration_seconds_count{service="gateway", route=~"/api/.*", status=~"5.."}[30s])) or vector(0))
  / sum(rate(http_server_request_duration_seconds_count{service="gateway", route=~"/api/.*"}[30s]))
histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket{service="gateway", route=~"/api/.*"}[30s])))

# Why requests fail, by error code (409s and 503s split into their real reasons)
sum by (code) (rate(http_server_errors_total{service="gateway"}[1m]))

# Which flags flipped in the last 5 minutes, and the current mode of every flag
changes(runtime_flag[5m]) > 0 and runtime_flag == 1
runtime_flag == 1

# The five slowest routes anywhere
topk(5, service_route:http_latency_seconds:p99_30s)

# Which dependency is failing (caller -> target), worst first
sort_desc(service_target:http_client_failures:ratio_rate30s > 0)

# Retry amplification: extra calls per call
sum by (service, target) (rate(http_client_retries_total[1m])) / sum by (service, target) (rate(http_client_request_duration_seconds_count[1m]))

# Connection churn: new TCP connections per call (≈0 with keep-alive, ≈1 without)
sort_desc(service_target:http_client_connections_per_call:ratio_rate1m)

# Pool exhaustion: requests waiting while no connection is idle; and utilization vs dbPoolSize
db_pool_connections{state="waiting"} > 0 and ignoring(state) db_pool_connections{state="idle"} == 0
service:db_pool_utilization:ratio

# Replica lag and per-service clock offset (negative = behind real time)
max(db_replica_lag_seconds)
clock_offset_seconds != 0

# Average concurrency from the histogram (Little's law): request-seconds per second
sum by (service) (rate(http_server_request_duration_seconds_sum[1m]))

# Share of gateway requests faster than 250ms (Apdex-style "satisfied")
sum(rate(http_server_request_duration_seconds_bucket{service="gateway", route=~"/api/.*", le=~"0.25"}[1m]))
  / sum(rate(http_server_request_duration_seconds_count{service="gateway", route=~"/api/.*"}[1m]))

# SLO burn rate right now (1 = exactly on budget)
slo:burn_rate:rate5m

# Money check: rupees/min charged by the PSP but not accounted for as paid orders
(sum(rate(psp_charged_cents_total[5m])) - sum(rate(orders_gmv_cents_total[5m]))) * 60 / 100

# Seconds until the waiting room drains at the current admission rate
sum(gateway_waiting_room_queue_length) / sum(rate(gateway_waiting_room_admitted_total[1m]))

# Services that will hit the 512 MiB memory limit within 10 minutes at the current slope
predict_linear(process_resident_memory_bytes{job="breakcart", service!="loadgen"}[5m], 600) > 512 * 1024 * 1024

# Restarts in the last 15 minutes
changes(process_start_time_seconds{job="breakcart"}[15m]) > 0

# Hot-SKU stock (negative = oversold)
min by (sku) (inventory_available_units)

# Everything firing, with the lab that teaches it
ALERTS{alertstate="firing"}
```

---

## Gotchas

- **Counters reset on restart.** `rate()` and `increase()` handle resets. Raw counter values
  don't, so never graph a raw `_total`.
- **No series is not zero.** A counter with labels only exists after its first increment, so
  "no 5xx yet" returns *no data* rather than 0. The dashboards use `(... or vector(0))` or
  `(... or 0 * <total>)` to turn that into a real 0.
- **Window vs scrape interval.** A rate window needs at least 4 samples. With 2s scrapes, 30s
  is comfortable. Grafana's `$__rate_interval` does this automatically, based on the
  datasource's `timeInterval: 2s`.
- **`increase()` extrapolates.** `increase(x[1m])` can return 2.97 for 3 events. Round in your
  head.
- **NaN means no traffic.** `histogram_quantile` and ratios are NaN when nothing happened in the
  window. Panels show a gap.
- **`le` is a float in Prometheus 3.** Classic-histogram bucket labels are stored as
  `le="1.0"`, not `le="1"`. Match both with `le=~"1|1.0"`.
- **Blocked event loops fail scrapes.** A Node process whose event loop is blocked longer than
  the 2s scrape timeout shows `up == 0` even though it is alive. Your load balancer's health
  check would conclude the same.
- **`honor_labels: true`.** Each service sets its own `service` label, and Prometheus keeps it.
  The static `service` target label in `prometheus.yml` only feeds `up` and the other synthetic
  `scrape_*` series.
- **Probes are excluded from HTTP SLIs.** `/metrics`, `/health` and `/ready` are not counted as
  traffic.
