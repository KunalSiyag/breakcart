# The sale started two minutes early (on one server)

> **Lab `clock-skew`** · Runtime · advanced · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

One service's clock is ahead; it shows and charges deal prices before the sale.

## The story

Before midnight, a few hundred customers bought the Nimbus X15 at the deal price. Finance asks how.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=clock-skew VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=clock-skew VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.pricing` = `cart_quote` | flag `orders.pricing` = `authoritative` |
| chaos `catalog.clockSkewMs` = `120000` | chaos `catalog.clockSkewMs` = `120000` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: price mismatches during the first 60 seconds (before the sale is live).
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → price mismatches before sale start
- Storefront shows deal prices before the countdown hits zero
- Clock skew chaos active on catalog

## Where to look

- Business invariants → price mismatches
- Sale countdown vs product prices

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ClockSkew` | warning | {{ $labels.service }} clock is off by {{ $value \| humanizeDuration }} |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

catalog decides "is the sale live?" using its own wall clock (skewed +120s). Orders (orders.pricing = cart_quote) trusts the cart's price, so the early deal price gets charged.

</details>

<details>
<summary><strong>The fix</strong></summary>

Make time-based business decisions from one authoritative clock (the database's now() in /prices) and re-validate prices at checkout; monitor NTP offset on every host.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.pricing` | `cart_quote` (bug) | Charge whatever (possibly stale, cached) price the cart showed. |
| `orders.pricing` | `authoritative` (fix) | Re-read the price from the source of truth; reject with PRICE_CHANGED if it moved. |

## In the real world

Clock problems cause real outages: Cloudflare's 2017 leap-second incident came from code assuming time never goes backwards.

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
