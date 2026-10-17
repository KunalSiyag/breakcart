# Charged twice for one phone

> **Lab `double-charge`** · Payments & money · intermediate · scenario [`midnight-flash-sale`](#scenario) · [all labs](README.md)

Double clicks and automatic retries create duplicate orders and duplicate charges.

## The story

Payments are slow tonight. Support tickets: "I was charged twice", "I have two orders".

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=double-charge VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=double-charge VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.idempotency` = `off` | flag `orders.idempotency` = `on` |
| flag `platform.retries` = `naive_immediate` | flag `platform.retries` = `budgeted_backoff` |
| chaos `payments.medianMs` = `1200` | chaos `payments.medianMs` = `1200` |
| chaos `payments.p99Ms` = `5000` | chaos `payments.p99Ms` = `5000` |
| tuning `paymentTimeoutMs` = `2000` | tuning `paymentTimeoutMs` = `2000` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: duplicate charges and duplicate orders.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → duplicate charges and duplicate orders > 0
- PSP charges > paid orders

## Where to look

- Business invariants → duplicate charges / orders
- psp_charges_total vs orders_payments_total{result="paid"}

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityDuplicateCharges` | critical | {{ $value }} customers were charged more than once |
| `IntegrityDuplicateOrders` | warning | {{ $value }} duplicate orders created |
| `CustomersSeeDuplicateCharges` | critical | Shoppers observed duplicate charges ({{ $value \| humanize }} in 1m) |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

orders.idempotency = off: /checkout and /pay accept duplicates; pay reads the status, then writes it (two concurrent requests both see AWAITING_PAYMENT); the PSP gets no idempotency key; platform.retries = naive_immediate re-sends a timed-out charge POST.

</details>

<details>
<summary><strong>The fix</strong></summary>

Idempotency-Key on every mutating request, stored with the response (replay on duplicates); compare-and-set state transitions; pass an idempotency key to the PSP; never auto-retry non-idempotent calls. And make the steps resumable: derive the order id from (customer, key) so a retry after a half-finished attempt (order created, then a timeout before the answer) finds and resumes that order instead of creating a second one — the hardened checkout does exactly this, with idempotent reservations and coupon redemptions per order.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.idempotency` | `off` (bug) | Double clicks and client retries create duplicate orders and duplicate charges. |
| `orders.idempotency` | `on` (fix) | Idempotency-Key stored in Redis with the response; state transitions use compare-and-set; PSP gets an idempotency key. |
| `platform.retries` | `none` | Never retry. |
| `platform.retries` | `naive_immediate` (bug) | Retry everything (incl. POSTs) 3x immediately. Multiplies load on a struggling dependency. |
| `platform.retries` | `budgeted_backoff` (fix) | Retry only idempotent calls, exponential backoff + full jitter, retry budget of ~10%. |

## In the real world

Stripe's "Designing robust and predictable APIs with idempotency" is the canonical write-up; every major PSP supports idempotency keys for this reason.

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
