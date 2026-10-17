# A 200-use coupon, redeemed more than 200 times

> **Lab `coupon-overrun`** · Inventory & consistency · beginner · scenario [`festival-combos`](#scenario) · [all labs](README.md)

Check-then-act on a limited-use coupon lets concurrent redemptions race past the cap.

## The story

Marketing launched BIGSALE500 for the festival combo rush: ₹500 off for the first 200 orders. Within seconds thousands of carts applied it. Finance found extra discounts the next morning — more redemptions than the cap allowed.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=coupon-overrun VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=coupon-overrun VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.coupon` = `check_then_act` | flag `orders.coupon` = `atomic` |
| flag `gateway.waitingRoom` = `off` | flag `gateway.waitingRoom` = `off` |
| tuning `raceWindowMs` = `250` | tuning `raceWindowMs` = `250` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: the coupon over-redemption tile.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → coupon over-redemptions > 0
- orders.coupons.used > max_uses

## Where to look

- Business invariants → coupon over-redemptions
- orders_coupon_redemptions_total

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityCouponOverRedemption` | warning | Limited coupon redeemed {{ $value }} times past its cap |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

orders/main.ts `redeemCoupon` (check_then_act): SELECT used < max_uses, then an eligibility check (raceWindowMs — here 250ms, like a call to a fraud service at peak), then UPDATE used = used + 1. Every request that passed the check before the 200th increment landed also redeems: overrun ≈ attempt rate × window. (Orders that later fail — e.g. out of stock — give their coupon back, which can hide the overrun; that is why this lab uses deals that stay in stock.)

</details>

<details>
<summary><strong>The fix</strong></summary>

UPDATE coupons SET used = used + 1 WHERE code = $1 AND used < max_uses RETURNING … — the database enforces the cap. Compensate (un-redeem) if the order later fails.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.coupon` | `check_then_act` (bug) | SELECT used < max, then UPDATE used = used + 1. Races past the cap. |
| `orders.coupon` | `atomic` (fix) | UPDATE … WHERE used < max_uses RETURNING. |

## In the real world

Race conditions on gift cards and promo codes are a well-known class of bug; a 2015 write-up showed a check-then-act race that let gift-card balances be transferred twice.

## Scenario

<a id="scenario"></a>**Festival combo rush** (`festival-combos`, 180s) — Diwali-style bundle offers: shoppers put two or three of the same high-stock deals in their cart, in whatever order they click. Sustained contention on a handful of stock rows.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 20s | 20 → 80 |
| rush | 160s | 80 → 80 |

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
