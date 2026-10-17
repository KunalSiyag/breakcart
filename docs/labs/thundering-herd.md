# Thundering herd at 00:00:00

> **Lab `thundering-herd`** · Edge & traffic · intermediate · scenario [`singles-day`](#scenario) · [all labs](README.md)

Everyone pays in the same second; the payment provider throttles. A virtual waiting room meters them in.

## The story

The sale starts and a wall of shoppers reaches "Pay" within seconds. Our payment provider allows 15 charges per second for our merchant account. It answers the rest with 429 Too Many Requests, customers see "payment provider busy", retry, and make it worse. The lucky ones are the fastest retriers.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=thundering-herd VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=thundering-herd VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.waitingRoom` = `off` | flag `gateway.waitingRoom` = `on` |
| chaos `payments.rateLimitPerSec` = `15` | chaos `payments.rateLimitPerSec` = `15` |
|  | tuning `waitingRoomAdmitPerSec` = `12` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: PSP rate-limited charges at the wall, then waiting room length and admitted/s in the fixed run.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- psp_charges_total{result="rate_limited"} spikes right after the sale starts
- orders_payments_total{result="rate_limited"} and 503 "payment provider busy" on /api/orders/:id/pay
- Unfair outcomes: retry-spammers win

## Where to look

- Grafana → Business → PSP charges by result
- Loadgen → pay step codes
- Waiting room length and admitted/s (fixed run)

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `CheckoutAvailabilityFastBurn` | critical | Checkout is burning its 99.5% availability budget at >14.4x |
| `CheckoutAvailabilitySlowBurn` | warning | Checkout availability budget is burning at >6x |
| `CheckoutLatencyHigh` | warning | Checkout p99 is {{ $value \| humanizeDuration }} |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway.waitingRoom = off: checkout admission is unbounded at the exact moment demand is highest, so the downstream with the hardest limit — the PSP, 15 TPS here (chaos payments.rateLimitPerSec) — receives up to twice its capacity in bursts.

</details>

<details>
<summary><strong>The fix</strong></summary>

A FIFO virtual waiting room in front of checkout: tickets on arrival, admit waitingRoomAdmitPerSec (12/s here, under the PSP limit) with a signed, expiring pass. Admit at the rate your tightest downstream can sustain; capacity is protected and order is fair.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.waitingRoom` | `off` (bug) | Everyone hits checkout at 00:00:00. |
| `gateway.waitingRoom` | `on` (fix) | FIFO tickets; admit waitingRoomAdmitPerSec users per second into checkout. |

## In the real world

Payment providers enforce per-merchant throughput limits; big sales negotiate temporary increases and still meter traffic. Ticketing and sneaker sites use waiting rooms (Queue-it, Cloudflare Waiting Room); Ticketmaster reported ~3.5 billion system requests during the 2022 Eras Tour presale.

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
