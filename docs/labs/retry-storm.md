# Retry storm: how three retries became a 4x DDoS

> **Lab `retry-storm`** · Resilience · intermediate · scenario [`steady-peak`](#scenario) · [all labs](README.md)

Immediate retries at every layer multiply load on a struggling dependency.

## The story

Inventory started failing 30% of requests. Within a minute it was failing 90%: its traffic had quadrupled though customer traffic was flat.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=retry-storm VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=retry-storm VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `platform.retries` = `naive_immediate` | flag `platform.retries` = `budgeted_backoff` |
| flag `platform.circuitBreaker` = `off` | flag `platform.circuitBreaker` = `on` |
| chaos `inventory.errorPct` = `30` | chaos `inventory.errorPct` = `30` |
| chaos `inventory.latencyMs` = `150` | chaos `inventory.latencyMs` = `150` |
| chaos `inventory.latencyJitterMs` = `100` | chaos `inventory.latencyJitterMs` = `100` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: retries/s, inventory RPS, and breaker states.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- http_client_retries_total ≈ 3x requests
- Inventory RPS ≫ checkout RPS
- Breakers absent / stuck closed

## Where to look

- Summary → retries/s
- Service grid → inventory RPS vs gateway RPS
- Breaker pills

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityPaidUncommitted` | critical | {{ $value }} paid orders whose stock was never committed |
| `CircuitBreakerOpen` | warning | {{ $labels.service }} -> {{ $labels.target }} circuit breaker is OPEN |
| `CircuitBreakerFlapping` | info | {{ $labels.service }} -> {{ $labels.target }} breaker opened {{ $value \| humanize }} times in 5m |
| `RetryStorm` | warning | {{ $labels.service }} -> {{ $labels.target }}: retries add {{ $value \| humanizePercentage }} extra load |
| `RetryBudgetExhausted` | info | {{ $labels.service }} -> {{ $labels.target }}: retry budget exhausted |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

platform.retries = naive_immediate retries every failure (including POSTs) 3 times with no delay, and platform.circuitBreaker = off never stops calling a failing dependency.

</details>

<details>
<summary><strong>The fix</strong></summary>

Retry only idempotent requests, with exponential backoff + full jitter and a retry budget (~10% of traffic); add circuit breakers so callers fail fast while the dependency recovers.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `platform.retries` | `none` | Never retry. |
| `platform.retries` | `naive_immediate` (bug) | Retry everything (incl. POSTs) 3x immediately. Multiplies load on a struggling dependency. |
| `platform.retries` | `budgeted_backoff` (fix) | Retry only idempotent calls, exponential backoff + full jitter, retry budget of ~10%. |
| `platform.circuitBreaker` | `off` (bug) | Keep calling a dead dependency; every caller waits for its timeout. |
| `platform.circuitBreaker` | `on` (fix) | Open after ≥50% failures (min 20 calls), fail fast, probe in half-open. |

## In the real world

AWS's Builders' Library article "Timeouts, retries, and backoff with jitter" describes retry amplification across layers; many large outage post-mortems cite retry storms prolonging recovery.

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
