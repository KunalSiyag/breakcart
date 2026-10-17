# Congestive collapse: 100% busy, 0% useful

> **Lab `overload-collapse`** · Edge & traffic · intermediate · scenario [`singles-day`](#scenario) · [all labs](README.md)

Without load shedding, queues grow until every request times out — goodput falls to zero.

## The story

11.11, 00:00:10. Traffic is 20x. Gateway CPU is pegged, every request takes 10+ seconds, and conversions are zero even though "the servers are up".

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=overload-collapse VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=overload-collapse VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.loadShedding` = `off` | flag `gateway.loadShedding` = `on` |
| tuning `gatewayMaxInflight` = `400` | tuning `gatewayMaxInflight` = `400` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: gateway inflight, shed/s, and converted sessions.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Gateway inflight in the thousands
- p50 ≈ p99 ≈ timeout
- Loadgen: sessions failed/abandoned ≫ converted

## Where to look

- Gateway inflight
- Loadgen funnel
- Summary → shed/s (fixed run)

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `GatewayLatencyFastBurn` | critical | Gateway latency SLO (99% < 1s) burning at >14.4x |
| `GatewayLatencySlowBurn` | warning | Gateway latency SLO burning at >6x |
| `ServiceCpuSaturated` | warning | {{ $labels.service }} is using {{ $value \| humanizePercentage }} of a CPU core |
| `GatewayInflightHigh` | warning | Gateway has {{ $value }} requests in flight |
| `GatewayShedding` | info | Gateway is shedding {{ $labels.priority }}-priority requests ({{ $value \| humanize }}/s) |
| `CriticalTrafficShed` | warning | Gateway is shedding checkout / pay / waiting-room requests ({{ $value \| humanize }}/s) |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway.loadShedding = off accepts unbounded concurrency; work queues up, clients time out and retry, the server keeps working on requests nobody is waiting for.

</details>

<details>
<summary><strong>The fix</strong></summary>

Shed early and cheaply, lowest priority first (search, recs, browse), with a fast 503 + Retry-After, protecting checkout. Shed on queueing delay, not only on an in-flight count: when the gateway itself is the bottleneck, requests wait in its event loop before they are ever counted, so an in-flight limit never trips (gateway/edge.ts sheds on both; see gateway_shed_total{reason}).

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.loadShedding` | `off` (bug) | Accept everything; queues grow until every request times out (congestive collapse). |
| `gateway.loadShedding` | `on` (fix) | Shed low-priority routes first (search, recs, browse) when in-flight requests or queueing delay (event-loop lag) cross per-priority limits; checkout is shed last. |

## In the real world

AWS Builders' Library "Using load shedding to avoid overload" and Google's SRE book "Handling Overload" both describe goodput collapse and priority-based shedding.

## Scenario

<a id="scenario"></a>**Singles' Day 11.11 — the wall** (`singles-day`, 180s, 5% bots) — A near-vertical step: 20 → 450 sessions/s in ten seconds at 00:00. Nothing autoscales that fast; only admission control survives.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| warm-up | 30s | 20 → 20 |
| the wall | 10s | 20 → 450 |
| peak | 90s | 400 → 400 |
| decay | 50s | 400 → 80 |

Timeline:

- **T+30s** — 11.11 00:00 — sale live

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
