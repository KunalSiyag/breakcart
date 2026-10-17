# "Where is my order?" — read-after-write on a lagging replica

> **Lab `replica-lag`** · Async & events · intermediate · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

Order history reads from a replica that is seconds behind; customers pay again.

## The story

Customers pay, land on "My orders", see nothing (or "awaiting payment"), and pay again.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=replica-lag VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=replica-lag VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.readConsistency` = `replica` | flag `orders.readConsistency` = `read_your_writes` |
| chaos `data.replicaLagMs` = `4000` | chaos `data.replicaLagMs` = `4000` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: loadgen anomalies (order missing after pay).
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- loadgen_anomalies_total{kind="order_missing_after_pay"}
- 404s on /api/orders/:id right after payment
- More pay attempts than checkouts

## Where to look

- Loadgen anomalies
- Route /api/orders/:id status codes

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ReplicaLagHigh` | warning | Order-history replica is {{ $value \| humanizeDuration }} behind the primary |
| `CustomersSeeMissingOrders` | warning | Shoppers paid but their order is missing from My Orders ({{ $value \| humanize }} in 1m) |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

orders.readConsistency = replica: all reads go to a replica with replicaLagMs (4s here) of lag, including the read right after the customer's own write.

</details>

<details>
<summary><strong>The fix</strong></summary>

Read-your-writes: route a user's reads to the primary for a short window after they write (or use a session LSN / causal token).

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.readConsistency` | `replica` (bug) | Always read the (lagging) replica. Users don't see the order they just paid for and pay again. |
| `orders.readConsistency` | `read_your_writes` (fix) | Route reads to primary for a user for a few seconds after they write. |

## In the real world

Read-after-write anomalies on async replicas are common; systems use sticky primary reads, LSN tokens, or synchronous replicas for user-facing reads.

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
