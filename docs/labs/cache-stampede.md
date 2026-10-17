# The cache expired, and so did the database

> **Lab `cache-stampede`** · Caching · intermediate · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

Hot keys expire together under load; thousands of requests rebuild them at once.

## The story

Every 10 seconds, like clockwork, p99 latency spikes and the catalog DB pool empties. Between spikes everything is fine.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=cache-stampede VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=cache-stampede VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `catalog.cache` = `naive_ttl` | flag `catalog.cache` = `hardened` |
| tuning `cacheTtlSec` = `10` | tuning `cacheTtlSec` = `10` |
| tuning `cacheRebuildCostMs` = `120` | tuning `cacheRebuildCostMs` = `120` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: cache rebuilds, catalog DB pool and gateway p99.
3. At the peak, press "Flush cache" in the War Room actions to simulate a cache node restart.
4. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
5. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
6. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Saw-tooth latency with a period equal to the cache TTL
- cache_rebuilds_total spikes; cache_rebuild_inflight in the hundreds
- Catalog DB pool waiting > 0 during spikes
- Timeline: "Cache stampede" events

## Where to look

- Summary → cache hit %
- Grafana → Data → cache rebuilds / inflight rebuilds, db pool
- Gateway p99

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `CacheStampede` | warning | {{ $value }} concurrent rebuilds of cache {{ $labels.cache }} |
| `CacheHitRatioLow` | info | Cache {{ $labels.cache }} hit ratio is {{ $value \| humanizePercentage }} |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

catalog/cache.ts naive_ttl: on a miss every concurrent caller loads from the DB and writes the cache. Hot keys (the 12 deals) are all written at the same moment with the same TTL, so they expire together and each expiry triggers N parallel rebuilds (each costing cacheRebuildCostMs of DB time).

</details>

<details>
<summary><strong>The fix</strong></summary>

hardened mode: in-process L1 cache for hot keys, single-flight per key, a distributed rebuild lock (SET NX) so one process rebuilds, jittered TTLs so keys do not expire together, and stale-while-revalidate (serve the old value while one request refreshes).

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `catalog.cache` | `none` | Every read hits Postgres. |
| `catalog.cache` | `naive_ttl` (bug) | Cache-aside with a fixed TTL. Hot keys expire together → thousands of concurrent rebuilds (stampede). |
| `catalog.cache` | `hardened` (fix) | In-process L1 for hot keys + single-flight + distributed rebuild lock + jittered TTL + stale-while-revalidate. |

## In the real world

Facebook's "Scaling Memcache at Facebook" (NSDI 2013) introduced leases to fix thundering herds on hot keys; "Optimal Probabilistic Cache Stampede Prevention" (VLDB 2015) describes probabilistic early expiration.

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
