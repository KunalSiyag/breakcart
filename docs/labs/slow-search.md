# Search took down the product pages

> **Lab `slow-search`** · Database · beginner · scenario [`steady-peak`](#scenario) · [all labs](README.md)

An unindexed ILIKE scan monopolises the shared catalog connection pool.

## The story

Search is slow — expected. But product detail pages, which never touch search, are also slow and failing.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=slow-search VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=slow-search VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `catalog.search` = `ilike_scan` | flag `catalog.search` = `fts_index` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: the /api/search and /api/products/:id rows in the route table.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- /api/search p99 in seconds
- catalog DB pool saturated
- PDP latency rises with search traffic (shared pool)

## Where to look

- Route table: /api/search vs /api/products/:id p99
- catalog DB pool
- Postgres: pg_stat_statements top queries

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `SlowQueries` | warning | {{ $labels.service }} {{ $labels.op }} queries: p99 {{ $value \| humanizeDuration }} |
| `StatementTimeouts` | warning | {{ $labels.service }}: queries cancelled by statement_timeout |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

catalog.search = ilike_scan runs `WHERE name ILIKE '%q%' OR description ILIKE '%q%'` over 100k rows — a sequential scan (~200ms+) holding a pooled connection that PDP requests also need.

</details>

<details>
<summary><strong>The fix</strong></summary>

Use the GIN-indexed tsvector (fts_index). Isolate expensive workloads (separate pool, replica, or search engine) and give them their own limits.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `catalog.search` | `ilike_scan` (bug) | WHERE name ILIKE '%q%' OR description ILIKE '%q%' → sequential scan, holds a connection for long. |
| `catalog.search` | `fts_index` (fix) | tsvector + GIN index. |

## In the real world

One expensive query class starving a shared pool is a frequent cause of "unrelated" page failures; bulkheads exist for this reason.

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
