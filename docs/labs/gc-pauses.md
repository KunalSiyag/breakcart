# p50 is fine, p99 is on fire

> **Lab `gc-pauses`** · Runtime · intermediate · scenario [`steady-peak`](#scenario) · [all labs](README.md)

Periodic stop-the-world pauses in the gateway destroy tail latency.

## The story

Median latency is 20ms. p99 is 600ms. The averages look healthy, customers do not.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=gc-pauses VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=gc-pauses VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| chaos `gateway.gcPauseMs` = `400` | chaos `gateway.gcPauseMs` = `0` |
| chaos `gateway.gcPauseEverySec` = `3` |  |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: gateway p50 vs p99 and event loop lag.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Large p99/p50 gap
- Event loop lag spikes every few seconds
- Every request in flight during a pause gets +pause

## Where to look

- Gateway p50 vs p99
- Event loop lag

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `EventLoopStalls` | warning | {{ $labels.service }}: event loop stalled for {{ $value \| humanizeDuration }} |
| `GcTimeHigh` | warning | {{ $labels.service }} spends {{ $value \| humanizePercentage }} of its time in GC |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

Chaos gcPauseMs on the gateway blocks its event loop for 400ms every 3s (like a full GC on a large heap). Every in-flight request through the gateway absorbs it, and fan-out makes it worse.

</details>

<details>
<summary><strong>The fix</strong></summary>

Reduce allocation/heap size, tune GC, spread load across more instances, and hedge/timeout requests. Always alert on percentiles, never on averages.

</details>

## In the real world

Discord wrote publicly about Go GC-induced latency spikes in a hot service (2020); JVM shops tune G1/ZGC for the same reason.

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
