# Customers charged yesterday's price

> **Lab `stale-price`** · Caching · intermediate · scenario [`lightning-deals`](#scenario) · [all labs](README.md)

Price changes do not invalidate caches; checkout trusts the cached quote.

## The story

During lightning deals the price drops live. Some customers are charged the old (higher) price; when prices go back up others get the deal price after it ended.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=stale-price VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=stale-price VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `catalog.priceInvalidation` = `ttl_only` | flag `catalog.priceInvalidation` = `pubsub_invalidate` |
| flag `orders.pricing` = `cart_quote` | flag `orders.pricing` = `authoritative` |
| tuning `cacheTtlSec` = `60` | tuning `cacheTtlSec` = `60` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: price mismatches after each lightning-deal price change in the timeline.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → price mismatches > 0
- Timeline: "caches NOT invalidated (TTL only)" on price change
- Product page shows a different price than the War Room action set

## Where to look

- Business invariants → price mismatches
- Timeline price-change events

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityPriceMismatch` | warning | {{ $value }} orders charged a price that differs from the source of truth |
| `CustomersSeePriceChanges` | info | Shoppers hit a price change at checkout ({{ $value \| humanize }} in 1m) |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

Two bugs compound: catalog.priceInvalidation = ttl_only keeps old prices in L1/Redis until TTL; orders.pricing = cart_quote charges whatever price the (cached) cart showed instead of re-reading the source of truth.

</details>

<details>
<summary><strong>The fix</strong></summary>

Publish an invalidation on every price write (pubsub_invalidate) and, at checkout, re-read authoritative prices and reject with PRICE_CHANGED if they moved — the customer reviews the new total.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `catalog.priceInvalidation` | `ttl_only` (bug) | Caches keep serving the old price until TTL expiry. |
| `catalog.priceInvalidation` | `pubsub_invalidate` (fix) | Price writes publish an invalidation; L1 and Redis entries are evicted immediately. |
| `orders.pricing` | `cart_quote` (bug) | Charge whatever (possibly stale, cached) price the cart showed. |
| `orders.pricing` | `authoritative` (fix) | Re-read the price from the source of truth; reject with PRICE_CHANGED if it moved. |

## In the real world

Pricing errors during sales are costly both ways: overcharges become refunds and complaints, undercharges become losses. Checkout must validate against the pricing source of truth.

## Scenario

<a id="scenario"></a>**Prime Day — lightning deals** (`lightning-deals`, 210s, 3% bots) — Calm periods punctuated by 20-second waves when a lightning deal drops its price. Each wave changes a price live — caches must keep up.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| calm | 40s | 40 → 40 |
| deal wave 1 | 20s | 220 → 180 |
| calm | 40s | 40 → 40 |
| deal wave 2 | 20s | 220 → 180 |
| calm | 40s | 40 → 40 |
| deal wave 3 | 20s | 220 → 180 |
| cool-down | 30s | 40 → 40 |

Timeline:

- **T+40s** — Lightning deal: Aurora Buds drop to ₹6,999
- **T+100s** — Lightning deal: Air Fryer drops to ₹2,999
- **T+160s** — Lightning deal: Aurora Buds drop to ₹5,999

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
