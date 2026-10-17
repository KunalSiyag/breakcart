# Redis blinked; the whole site went dark

> **Lab `redis-blip`** · Edge & traffic · intermediate · scenario [`gameday-redis-blip`](#scenario) · [all labs](README.md)

A 20-second Redis outage becomes a 100% outage because the rate limiter fails closed.

## The story

A Redis failover took 20 seconds. Catalog (cache) and carts degraded as expected — but every single request got 503 from the gateway.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=redis-blip VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=redis-blip VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.rateLimitFailMode` = `fail_closed` | flag `gateway.rateLimitFailMode` = `fail_open` |
| flag `gateway.rateLimit` = `token_bucket` | flag `gateway.rateLimit` = `token_bucket` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: gateway error % during the 20-second blip at T+60s.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- gateway_ratelimit_decisions_total{decision="error_rejected"}
- 100% 503 during the blip
- Timeline: "failing CLOSED"

## Where to look

- Gateway error %
- Timeline
- Rate limiter decisions

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `RateLimiterFailingClosed` | critical | Rate limiter cannot reach Redis and is rejecting traffic ({{ $value \| humanize }}/s) |
| `RateLimiterFailingOpen` | warning | Rate limiter cannot reach Redis and is allowing traffic unchecked |
| `RedisCommandErrors` | warning | {{ $labels.service }}: Redis commands failing ({{ $value \| humanize }}/s) |
| `RedisSlow` | warning | {{ $labels.service }}: Redis p99 {{ $value \| humanizeDuration }} |
| `RedisDown` | critical | redis-exporter cannot reach Redis |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway.rateLimitFailMode = fail_closed: when the limiter cannot reach Redis it rejects the request. A protective, non-critical control became a single point of failure.

</details>

<details>
<summary><strong>The fix</strong></summary>

Fail open for protective controls (with load shedding as the backstop), add local fallbacks (in-process limiter), and alert loudly.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.rateLimitFailMode` | `fail_closed` (bug) | Redis error → reject request. A Redis blip becomes a full outage. |
| `gateway.rateLimitFailMode` | `fail_open` (fix) | Redis error → allow request (protected by load shedding instead). |

## In the real world

Dependencies of the request path that are "only" for protection (rate limiting, feature flags, auth caches) are frequent hidden single points of failure.

## Scenario

<a id="scenario"></a>**Game day — Redis blip** (`gameday-redis-blip`, 180s) — Redis becomes unreachable for 20 seconds at peak. What does each dependency do: fail open, fail closed, or fall over?

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 20s | 20 → 100 |
| peak | 160s | 100 → 100 |

Timeline:

- **T+60s** — Redis unreachable from gateway, catalog, cart, orders
- **T+80s** — Redis back

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
