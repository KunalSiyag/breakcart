# Rate limits that reset in lockstep

> **Lab `rate-limit-bursts`** · Edge & traffic · advanced · scenario [`bot-army`](#scenario) · [all labs](README.md)

A per-second fixed-window limiter resets every client at the same instant: bursts at each boundary, up to 2× the limit across one.

## The story

The limit is 10 requests/s per user. Yet the backends see a spike at the start of every second, scrapers get 20 requests through in a few milliseconds, and retries from rate-limited clients all land at :00.000.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=rate-limit-bursts VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=rate-limit-bursts VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.rateLimit` = `fixed_window` | flag `gateway.rateLimit` = `token_bucket` |

## Steps

1. Press "Run broken" (fixed window), then in a terminal: `cd server && npm run probe:ratelimit`. Note the sawtooth: a burst at the start of each second, then 429s.
2. Press "Run fixed" (token bucket) and run the probe again: after the initial burst, allowed requests trickle in smoothly at the refill rate.
3. Compare "max allowed in any 1s window" between the two — then reason about what an exact sliding-window log would allow.
4. Watch Grafana → Business → rate limiter decisions during both runs.

## Symptoms

- One client: a burst of `limit` requests at the start of each second, then 429s (sawtooth) — run the probe below
- Up to 2× the configured limit allowed across a window boundary
- Synchronised retries: everyone who was limited comes back at the same instant

## Where to look

- `npm run probe:ratelimit` (in server/) — allowed vs limited per 100ms for one client
- Grafana → Business → rate limiter decisions

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `RateLimitingHeavy` | info | {{ $value \| humanizePercentage }} of requests are rate limited |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway.rateLimit = fixed_window counts requests per wall-clock second (INCR key:<second>). All counters reset together at each second boundary, so a client can send `limit` at 0.999s and `limit` again at 1.000s, and every limited client is released at the same instant.

</details>

<details>
<summary><strong>The fix</strong></summary>

A token bucket (atomic Lua in Redis): tokens refill continuously at `rate`, and the burst is an explicit parameter — no global boundary, no synchronised release. If you need an exact "N in any window" guarantee, use a sliding-window log; either way, return Retry-After and expect clients to add jitter.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.rateLimit` | `off` | No rate limiting. |
| `gateway.rateLimit` | `fixed_window` (bug) | INCR per 1s window. Allows 2x burst at window edges. |
| `gateway.rateLimit` | `token_bucket` (fix) | Atomic Lua token bucket — smooth rate with bounded burst. |

## In the real world

Most API gateways (and Stripe, GitHub, AWS API Gateway) use token buckets or sliding windows precisely to avoid fixed-window boundary bursts and synchronised resets.

## Scenario

<a id="scenario"></a>**Sneaker drop — bot army** (`bot-army`, 180s, 60% bots) — A limited drop where 60% of arrivals are scalper bots that skip browsing and hammer add-to-cart and checkout for the hottest SKUs.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| pre-drop | 20s | 40 → 40 |
| drop | 120s | 160 → 120 |
| aftermath | 40s | 40 → 40 |

Timeline:

- **T+20s** — Drop is live

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
