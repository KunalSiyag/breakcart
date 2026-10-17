# Two carts, two SKUs, one deadlock

> **Lab `deadlocks`** · Inventory & consistency · intermediate · scenario [`festival-combos`](#scenario) · [all labs](README.md)

Multi-item carts lock stock rows in cart order; opposite orders deadlock under load.

## The story

After the oversell incident the team switched to SELECT … FOR UPDATE. Overselling stopped. Then the festival combo offers went live — earbuds + air fryer + shoes in one cart — and checkout started failing with 503s while Postgres logs filled with "deadlock detected".

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=deadlocks VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=deadlocks VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `inventory.reserve` = `select_for_update` | flag `inventory.reserve` = `select_for_update` |
| flag `inventory.lockOrdering` = `cart_order` | flag `inventory.lockOrdering` = `sorted_by_sku` |
| flag `gateway.waitingRoom` = `off` | flag `gateway.waitingRoom` = `off` |
| tuning `raceWindowMs` = `10` | tuning `raceWindowMs` = `10` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: deadlocks per minute, checkout error codes in the loadgen panel, and the incident timeline.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- db_errors_total{code="40P01"} > 0, timeline shows "deadlock" events
- Checkout 503 UPSTREAM_UNAVAILABLE for multi-item carts
- Lock waits in Postgres (pg_locks)

## Where to look

- Summary → deadlocks/min
- Grafana → Data → db errors by code / pg deadlocks
- inventory_reservations_total{result="deadlock"}

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `AppDeadlocks` | warning | {{ $labels.service }}: {{ $value \| humanize }} deadlocks in the last minute |
| `PostgresDeadlocks` | warning | Postgres detected {{ $value \| humanize }} deadlocks in {{ $labels.datname }} |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

inventory/main.ts `reserveForUpdate` locks rows in the order items appear in the cart (inventory.lockOrdering = cart_order). Cart A = [HOT-1, HOT-2], cart B = [HOT-2, HOT-1]: each transaction holds one row lock and waits for the other. Postgres detects the cycle after deadlock_timeout and aborts one victim.

</details>

<details>
<summary><strong>The fix</strong></summary>

Acquire locks in one global order (sort items by SKU) so cycles are impossible. Keep transactions short, and retry deadlock victims with jittered backoff.

Twist: while building this lab the deadlocks first refused to appear. The cart read Redis with ioredis `hgetall()`, which returns a JS object — and JS objects enumerate integer-like keys in ascending numeric order, so every cart came back sorted by product id: an accidental global lock order. cart/main.ts now reads the raw HGETALL array to keep insertion order. Lesson: an "unrelated" refactor can add or remove a deadlock; make the ordering explicit where it matters.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `inventory.lockOrdering` | `cart_order` (bug) | Lock rows in whatever order the cart lists them → two carts with A,B and B,A deadlock. |
| `inventory.lockOrdering` | `sorted_by_sku` (fix) | Always lock in a global order → no lock cycles. |
| `inventory.reserve` | `naive_read_modify_write` (bug) | SELECT stock, check in app, UPDATE with computed value. Lost updates → oversell. |
| `inventory.reserve` | `select_for_update` | Pessimistic row lock. Correct, but hot SKUs serialize and hold DB connections. |
| `inventory.reserve` | `atomic_conditional_update` (fix) | UPDATE … SET available = available - n WHERE available >= n. Correct and short locks. |
| `inventory.reserve` | `redis_lua` | Atomic Lua gate in Redis, then DB write. Fastest; Redis becomes the source of truth for the hot path. |

## In the real world

Lock-ordering deadlocks are a classic in order, ledger and transfer systems (A→B and B→A transfers). Postgres documents exactly this pattern and recommends consistent lock ordering.

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
