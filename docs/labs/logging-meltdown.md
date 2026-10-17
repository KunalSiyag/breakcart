# The logs were the outage

> **Lab `logging-meltdown`** · Runtime · intermediate · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

Synchronous, pretty-printed per-request logging blocks the event loop at peak.

## The story

Someone turned on verbose request logging to debug a checkout bug. At midnight the event loop lag hits seconds.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=logging-meltdown VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=logging-meltdown VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `platform.logging` = `sync_verbose` | flag `platform.logging` = `async_sampled` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: event loop lag per service and gateway p99.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Event loop lag climbs on every service; the gateway (4–5 log entries per page) worst
- p50 and p99 rise together at peak while CPU is NOT pegged — the process is waiting, not working
- Huge `docker compose logs` volume; a request log file growing in /tmp of each container

## Where to look

- Service grid → event loop lag and CPU%
- Gateway p99 and customer latency per step
- docker compose exec gateway ls -la /tmp

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `EventLoopLagHigh` | warning | {{ $labels.service }}: event loop lag p99 {{ $value \| humanizeDuration }} |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

platform.logging = sync_verbose (shared/sync-log.ts): every request, response and upstream call is pretty-printed with its body and appended to a log file with writeSync + fsyncSync, "so no log line is ever lost". fsync waits for the disk, and it runs on the event loop — so every request in the process stalls behind every log write. The same failure happens with any blocking log sink: a remote log driver in blocking mode, a slow NFS volume, a full disk.

</details>

<details>
<summary><strong>The fix</strong></summary>

Async, buffered structured logging (pino) with sampling for access logs and full logging only for errors. Never pretty-print in production.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `platform.logging` | `sync_verbose` (bug) | Pretty-print every request, response and upstream call (bodies included) and write it synchronously to a log file with fsync — every request waits for the disk on the event loop. |
| `platform.logging` | `async_sampled` (fix) | Async structured logger, 1% access-log sampling, errors always logged. |

## In the real world

Excessive or synchronous logging is a well-known self-inflicted outage; log pipelines also fill disks and saturate collectors at peak.

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
