# N+1: fine in dev, 25x the queries in prod

> **Lab `n-plus-one`** · Database · beginner · scenario [`steady-peak`](#scenario) · [all labs](README.md)

Listing pages issue one query per product; carts call catalog once per line.

## The story

Category pages are slow and the catalog DB does 25x more queries than requests. Cart views fan out into many catalog calls.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=n-plus-one VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=n-plus-one VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `catalog.listQuery` = `n_plus_one` | flag `catalog.listQuery` = `batched` |
| flag `cart.pricing` = `per_item_calls` | flag `cart.pricing` = `batch_call` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: query rate by operation and the /api/products route p95.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- db_query_duration_seconds_count{op="list.item"} ≫ requests
- Category page latency grows with page size
- cart → catalog calls ∝ cart size

## Where to look

- Grafana → Data → query rate by op
- Gateway route p95 for /api/products and /api/cart

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `QueryAmplification` | warning | {{ $labels.service }} runs {{ $value \| humanize }} SQL queries per HTTP request |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

catalog/main.ts listing (catalog.listQuery = n_plus_one) loads each product in a loop; cart/main.ts (cart.pricing = per_item_calls) calls catalog once per line, sequentially.

</details>

<details>
<summary><strong>The fix</strong></summary>

Batch: one `WHERE id = ANY($1)` query; one batch HTTP call per cart (/products/batch).

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `catalog.listQuery` | `n_plus_one` (bug) | One query for ids, then one query per product (ORM lazy loading). |
| `catalog.listQuery` | `batched` (fix) | One query with = ANY($1). |
| `cart.pricing` | `per_item_calls` (bug) | One HTTP call to catalog per cart line (fan-out amplification). |
| `cart.pricing` | `batch_call` (fix) | One batch call per cart. |

## In the real world

The N+1 query problem is the most common ORM performance bug; it hides in development because local round trips are ~free.

## Scenario

<a id="scenario"></a>**Sustained peak (soak)** (`steady-peak`, 600s, 2% bots) — Ten minutes at a high, flat rate. Slow leaks, unbounded queues and pool creep show up here, not in short spikes.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 30s | 20 → 140 |
| soak | 570s | 140 → 140 |

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
