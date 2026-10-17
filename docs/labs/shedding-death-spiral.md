# The site stayed down after the outage ended

> **Lab `shedding-death-spiral`** · Edge & traffic · advanced · scenario [`gameday-slow-recs`](#scenario) · [all labs](README.md)

Abandoned requests leak load-shedding slots; after the incident the gateway still believes it is full.

## The story

Recommendations slowed down for two minutes and the home page hung. Annoying — but then recommendations recovered, and the site did not: the gateway kept answering 503 "very high demand" to almost everyone. Restarting the gateways fixed it instantly. Nobody could say why.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=shedding-death-spiral VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=shedding-death-spiral VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.inflightAccounting` = `on_response` | flag `gateway.inflightAccounting` = `on_close` |
| flag `bff.nonCriticalDeps` = `blocking` | flag `bff.nonCriticalDeps` = `blocking` |
| tuning `gatewayMaxInflight` = `300` | tuning `gatewayMaxInflight` = `300` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: shed/s and the admission counter after recommendations recover at T+165s.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Shedding continues after the dependency recovers, at low traffic
- gateway_admission_inflight stays high while http_server_inflight_requests is near zero
- A restart "fixes" it (the classic signature of a leak)

## Where to look

- Summary → shed/s after T+165s
- Grafana → compare gateway_admission_inflight with http_server_inflight_requests{service="gateway"}
- http_server_request_duration_seconds_count{status="499"} — clients that gave up

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `AdmissionCounterLeak` | critical | Gateway admission counter is {{ $value \| humanize }} slots above real in-flight requests |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway/main.ts with gateway.inflightAccounting = on_response releases admission slots in Fastify's onResponse hook. When a client gives up and closes the connection before the response is sent (here: home pages blocked 8s on recommendations, customers patient for 6s), onResponse never runs — the slot is never returned. Every abandoned request ratchets the counter up until normal-priority traffic is shed permanently.

</details>

<details>
<summary><strong>The fix</strong></summary>

Release on the response's close event (fires exactly once per request, finished or aborted — unlike onResponse, which needs a response to have been sent, and unlike the socket's close, which a keep-alive connection fires once for many requests), clamp at zero, export the counter as a metric and alert when it diverges from the real in-flight count. Count aborted requests (status 499) so they stay visible in latency histograms too.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.inflightAccounting` | `on_response` (bug) | Release in the onResponse hook — which never runs when the client hangs up first. Every abandoned request leaks a slot. |
| `gateway.inflightAccounting` | `on_close` (fix) | Release on the response's close event: exactly once per request, whether the response finished or the client left. |

## In the real world

Leaked semaphores, connection slots and concurrency permits on error or cancellation paths are a recurring cause of "it only recovers after a restart". This one was found in BreakCart itself while building these labs: the first version of the gateway had exactly this bug.

## Scenario

<a id="scenario"></a>**Game day — recommendations slow down** (`gameday-slow-recs`, 220s) — The recommendations service starts taking 8 seconds per call. It is "non-critical". Is it?

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 20s | 20 → 100 |
| peak | 200s | 100 → 100 |

Timeline:

- **T+45s** — recommendations: +8s latency
- **T+165s** — recommendations recovered

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
