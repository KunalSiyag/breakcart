# Connection pool exhausted: the hot row ate all the connections

> **Lab `pool-exhaustion`** · Database · intermediate · scenario [`festival-combos`](#scenario) · [all labs](README.md)

Long row locks on one hot SKU hold every pooled connection; unrelated reads time out.

## The story

Only four SKUs are contended — the festival combo deals — yet stock lookups for every product in the same service start failing with "timeout exceeded when trying to connect".

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=pool-exhaustion VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=pool-exhaustion VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `inventory.reserve` = `select_for_update` | flag `inventory.reserve` = `atomic_conditional_update` |
| flag `gateway.waitingRoom` = `off` | flag `gateway.waitingRoom` = `off` |
| tuning `dbPoolSize` = `8` | tuning `dbPoolSize` = `8` |
| tuning `raceWindowMs` = `40` | tuning `raceWindowMs` = `40` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: inventory DB pool (waiting vs idle) and stock reads failing on the home page ("degraded: stock").
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- db_pool_connections{state="waiting"} > 0 with idle = 0
- db_errors_total{code="acquire_timeout"}
- Timeline: "DB pool exhausted"
- Unrelated inventory reads (stock on home page) degrade

## Where to look

- War Room service grid → inventory DB pool bar
- Grafana → Data → pool acquire time

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `DbPoolWaiting` | warning | {{ $labels.service }}: {{ $value }} requests queued for a DB connection |
| `DbPoolExhausted` | critical | {{ $labels.service }}: DB pool exhausted (0 idle, requests waiting) |
| `DbAcquireTimeouts` | critical | {{ $labels.service }}: requests failing because no DB connection became free |
| `PostgresConnectionsNearLimit` | warning | Postgres is using {{ $value \| humanizePercentage }} of max_connections |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

select_for_update holds a row lock *and a pooled connection* for the whole transaction, including app-side work (raceWindowMs). Every buyer of a hot SKU queues on its row lock while holding a connection; with a small pool (dbPoolSize = 8) all connections end up waiting on a handful of rows and every other query in the service waits for a connection.

</details>

<details>
<summary><strong>The fix</strong></summary>

Shorten what happens while a connection is held (atomic conditional update, no app logic inside the transaction), size pools deliberately, set acquire timeouts and statement_timeout, and consider moving the hottest counters to an atomic in-memory gate.

Notice also what happens when the traffic stops: queued queries keep waiting and timing out for seconds, because callers that gave up never cancel the work they started. Propagating deadlines (pass the caller's remaining time budget downstream and abandon work that can no longer be useful) stops a backlog from outliving its customers.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `inventory.reserve` | `naive_read_modify_write` (bug) | SELECT stock, check in app, UPDATE with computed value. Lost updates → oversell. |
| `inventory.reserve` | `select_for_update` | Pessimistic row lock. Correct, but hot SKUs serialize and hold DB connections. |
| `inventory.reserve` | `atomic_conditional_update` (fix) | UPDATE … SET available = available - n WHERE available >= n. Correct and short locks. |
| `inventory.reserve` | `redis_lua` | Atomic Lua gate in Redis, then DB write. Fastest; Redis becomes the source of truth for the hot path. |

## In the real world

HikariCP's "About Pool Sizing" explains why bigger pools rarely help; contention on a few hot rows is a recurring flash-sale failure mode.

## Scenario

<a id="scenario"></a>**Festival combo rush** (`festival-combos`, 180s) — Diwali-style bundle offers: shoppers put two or three of the same high-stock deals in their cart, in whatever order they click. Sustained contention on a handful of stock rows.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 20s | 20 → 80 |
| rush | 160s | 80 → 80 |

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
