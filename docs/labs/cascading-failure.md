# The non-critical service that took down the home page

> **Lab `cascading-failure`** · Resilience · beginner · scenario [`gameday-slow-recs`](#scenario) · [all labs](README.md)

A slow recommendations service drags the home page and product pages down with it.

## The story

Recommendations started taking 8 seconds. It is "just a carousel". Yet the home page is timing out and gateway inflight requests pile up.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=cascading-failure VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=cascading-failure VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `bff.nonCriticalDeps` = `blocking` | flag `bff.nonCriticalDeps` = `isolated` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: home page p99, gateway inflight, and the "degraded" banner on the storefront.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- /api/home and /api/products/:id p99 ≈ recs latency
- gateway inflight climbs (Little's law)
- Customers abandon on the home page

## Where to look

- Route table p99
- Gateway inflight
- Loadgen: home step p95, sessions abandoned

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ServiceDown` | critical | {{ $labels.service }} is not answering /metrics |
| `ServiceErrorRateHigh` | warning | {{ $labels.service }}: {{ $value \| humanizePercentage }} of requests return 5xx |
| `UpstreamTimeouts` | warning | {{ $labels.service }} -> {{ $labels.target }}: {{ $value \| humanizePercentage }} of calls time out |
| `DependencyFailing` | warning | {{ $labels.service }} -> {{ $labels.target }}: {{ $value \| humanizePercentage }} of calls fail |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway/main.ts `recommendations` with bff.nonCriticalDeps = blocking awaits recs with a 30s timeout and no fallback, so every page waits for the slowest dependency.

</details>

<details>
<summary><strong>The fix</strong></summary>

Treat non-critical dependencies as optional: tight timeout (250ms), circuit breaker, fallback content, and report `degraded` instead of failing.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `bff.nonCriticalDeps` | `blocking` (bug) | Await recommendations with the default 30s timeout. A slow recs service takes down the home page. |
| `bff.nonCriticalDeps` | `isolated` (fix) | Short timeout + circuit breaker + static fallback. Home page degrades gracefully. |

## In the real world

Google's SRE book ("Addressing Cascading Failures") and Netflix's Hystrix were built around this exact failure: one slow dependency consuming all request capacity.

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
