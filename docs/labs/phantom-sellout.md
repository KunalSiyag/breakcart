# "Sold out" — with 40% of the stock still in the warehouse

> **Lab `phantom-sellout`** · Inventory & consistency · beginner · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

Reservations from abandoned checkouts never expire, so stock is held by nobody.

## The story

The ₹1 Mystery Box sold out in 20 seconds. Customer care is flooded: "it said sold out but my friend got one an hour later". Finance says only 12 of 20 boxes were paid for.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=phantom-sellout VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=phantom-sellout VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `inventory.reservationTtl` = `never_expire` | flag `inventory.reservationTtl` = `expire_and_sweep` |
| tuning `reservationTtlSec` = `30` | tuning `reservationTtlSec` = `30` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: phantom held units and the hot SKU stock bars after the peak.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Storefront shows SOLD OUT while units sold < total
- Integrity → "Phantom held units" (holds older than 90s) grows
- Many orders stuck in AWAITING_PAYMENT

## Where to look

- Business invariants → phantom held units
- inventory_expired_reservations_total (fixed run)
- Hot SKU available vs sold

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityPhantomHeldUnits` | warning | {{ $value }} units held by abandoned reservations |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

Checkout reserves stock before payment (correct!) but with inventory.reservationTtl = never_expire nothing ever returns stock from shoppers who abandon the payment page (~20% in this scenario).

</details>

<details>
<summary><strong>The fix</strong></summary>

Give holds a TTL (reservationTtlSec) and run a sweeper that returns expired holds. Before charging, extend/confirm the hold (orders → /reservations/:id/extend) so a hold cannot expire mid-payment.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `inventory.reservationTtl` | `never_expire` (bug) | Abandoned checkouts hold stock forever → "Sold out" while units sit unsold. |
| `inventory.reservationTtl` | `expire_and_sweep` (fix) | HELD reservations expire after reservationTtlSec and a sweeper returns the stock. |

## In the real world

Every ticketing and flash-sale system has a "your items are held for 10:00" timer for exactly this reason.

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
