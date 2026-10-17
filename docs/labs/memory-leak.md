# OOMKilled every four minutes

> **Lab `memory-leak`** · Runtime · beginner · scenario [`steady-peak`](#scenario) · [all labs](README.md)

Catalog leaks memory until the container hits its limit and is killed mid-request.

## The story

Catalog restarts every few minutes under load. Each restart: a burst of 502s, cold caches, and a stampede.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=memory-leak VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=memory-leak VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| chaos `catalog.leakMbPerMin` = `240` | chaos `catalog.leakMbPerMin` = `0` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: catalog memory, restarts on the timeline, and the error spikes at each restart.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- process_resident_memory_bytes climbs linearly
- Timeline: "catalog started (boot #N)"
- 502s on catalog routes during restarts

## Where to look

- Service grid → catalog memory
- Timeline restarts
- Gateway error %

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ServiceRestarted` | warning | {{ $labels.service }} restarted in the last 2 minutes |
| `MemoryGrowing` | warning | {{ $labels.service }} RSS growing {{ $value \| humanize1024 }}B/s |
| `MemoryNearContainerLimit` | critical | {{ $labels.service }} RSS is {{ $value \| humanize1024 }}B, above 85% of its container memory limit |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

Chaos leakMbPerMin on catalog retains buffers forever (think: an unbounded in-process cache or listeners never removed). The container memory limit (512MB) triggers the kernel OOM killer.

</details>

<details>
<summary><strong>The fix</strong></summary>

Bound every in-process cache (size + TTL), heap-snapshot and fix the leak, set memory alerts on growth rate — and run more than one replica so a crash isn't an outage.

</details>

## In the real world

Unbounded caches and leaked listeners are among the most common Node.js production leaks; OOM-kill restart loops are a familiar Kubernetes symptom (CrashLoopBackOff).

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
