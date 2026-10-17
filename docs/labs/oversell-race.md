# We had 100 phones. We sold more than 100.

> **Lab `oversell-race`** · Inventory & consistency · beginner · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

A read-modify-write race in stock reservation oversells the hottest deal.

## The story

Midnight. The Nimbus X15 is ₹79,999 with 100 units. The stock counter ticks down more slowly than orders come in, every request is a 2xx, and by the time "available" reaches zero the store has already promised more phones than it has. The warehouse calls at 00:07.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=oversell-race VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=oversell-race VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `inventory.reserve` = `naive_read_modify_write` | flag `inventory.reserve` = `atomic_conditional_update` |
| flag `gateway.waitingRoom` = `off` | flag `gateway.waitingRoom` = `off` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: Business invariants (oversold units), the hot SKU stock bars on the storefront, and inventory reservation rate.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity panel: "Oversold units" > 0 and climbing for HOT-0001 / HOT-0012
- `available` lags behind reservations: it reaches zero only after more units than exist have been claimed
- No errors anywhere — every request is a 2xx

## Where to look

- Business invariants → Oversold units
- inventory_reservations_total{result="ok"} vs stock
- Grafana → Business → hot SKU available units

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityOversoldUnits` | critical | Oversell: {{ $value }} units sold that did not exist |
| `IntegrityNegativeStock` | critical | {{ $value }} SKUs have negative available stock |
| `HotSkuNegativeStock` | critical | SKU {{ $labels.sku }} has {{ $value }} units available |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

inventory/main.ts `reserveNaive`: SELECT available → check in application code → sleep(raceWindowMs) → UPDATE … SET available = <value computed from the stale read>. Concurrent requests read the same value and each writes back "read − 1" (a lost update), so N buyers decrement stock by 1 in total while N reservations are inserted.

</details>

<details>
<summary><strong>The fix</strong></summary>

Make the check and the write one atomic operation: `UPDATE stock SET available = available - $n WHERE sku = $1 AND available >= $n` and treat 0 rows as "out of stock" (atomic_conditional_update). Alternatives: SELECT … FOR UPDATE (correct but serialises on the hot row), or an atomic Redis Lua gate (redis_lua). Never rely on application-side checks for contended counters.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `inventory.reserve` | `naive_read_modify_write` (bug) | SELECT stock, check in app, UPDATE with computed value. Lost updates → oversell. |
| `inventory.reserve` | `select_for_update` | Pessimistic row lock. Correct, but hot SKUs serialize and hold DB connections. |
| `inventory.reserve` | `atomic_conditional_update` (fix) | UPDATE … SET available = available - n WHERE available >= n. Correct and short locks. |
| `inventory.reserve` | `redis_lua` | Atomic Lua gate in Redis, then DB write. Fastest; Redis becomes the source of truth for the hot path. |

## In the real world

Overselling limited stock is one of the most common flash-sale failures; it is why large retailers keep inventory decrements atomic and treat "available" as a guarded counter. The same check-then-act bug appears in seat booking, coupon limits and wallet balances.

## Scenario

<a id="scenario"></a>**Big Billion Day — midnight drop** (`midnight-flash-sale`, 300s, 5% bots) — Shoppers gather before midnight refreshing the home page, then everyone hits the same dozen deals the second the sale goes live. Arrival rate jumps from 60 to 260 new shoppers a second in 30 seconds.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| pre-sale crowd | 60s | 25 → 60 |
| midnight spike | 30s | 60 → 260 |
| peak | 120s | 260 → 200 |
| long tail | 90s | 200 → 60 |

Timeline:

- **T+60s** — 00:00:00 — sale is live, deal prices switch on

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
