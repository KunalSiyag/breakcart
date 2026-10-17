# Paid, but never shipped

> **Lab `lost-events`** · Async & events · intermediate · scenario [`steady-peak`](#scenario) · [all labs](README.md)

The dual-write problem: committing to the DB and publishing to a broker are not atomic.

## The story

A few orders a minute are PAID but fulfillment never hears about them. No errors in orders' 2xx responses.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=lost-events VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=lost-events VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.eventPublishing` = `dual_write` | flag `orders.eventPublishing` = `outbox` |
| chaos `data.eventPublishFailPct` = `5` | chaos `data.eventPublishFailPct` = `5` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: lost events and outbox backlog.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → lost events (paid > 30s, no shipment) grows
- orders_events_published_total{result="failed"}

## Where to look

- Business invariants → lost events
- Grafana → Data → outbox backlog (fixed run)

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityLostEvents` | warning | {{ $value }} paid orders never reached fulfillment |
| `OutboxBacklogGrowing` | warning | {{ $value }} outbox events waiting to be relayed |
| `EventPublishFailures` | warning | {{ $value \| humanize }} order events failed to publish (mode={{ $labels.mode }}) |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

orders.eventPublishing = dual_write: UPDATE … PAID commits, then XADD fails (5% here) — the event is gone. A crash between the two writes has the same effect.

</details>

<details>
<summary><strong>The fix</strong></summary>

Transactional outbox: write the event row in the same transaction as the state change; a relay publishes at-least-once and consumers are idempotent.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.eventPublishing` | `dual_write` (bug) | Commit to Postgres then XADD to Redis. If the second write fails the order is never shipped. |
| `orders.eventPublishing` | `outbox` (fix) | Write event to an outbox table in the same transaction; a relay publishes it at-least-once. |

## In the real world

The transactional outbox (microservices.io) and change-data-capture exist because dual writes silently lose data under failure.

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
