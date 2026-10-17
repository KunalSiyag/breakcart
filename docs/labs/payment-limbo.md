# Money taken, no order

> **Lab `payment-limbo`** · Payments & money · advanced · scenario [`gameday-psp-brownout`](#scenario) · [all labs](README.md)

A PSP timeout is treated as a failure — but the customer was charged.

## The story

The PSP browns out. Orders show "payment failed", stock is released and resold — and bank statements show the charge.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=payment-limbo VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=payment-limbo VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `orders.paymentTimeout` = `mark_failed` | flag `orders.paymentTimeout` = `pending_reconcile` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: orphan charges during the brownout (T+60s → T+180s).
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Integrity → orphan charges ("charged, no order") > 0
- orders_payments_total{result="timeout"}
- Oversold units can follow (stock released after capture)

## Where to look

- Business invariants → orphan charges
- Payments results
- Timeline: payment-timeout vs payment-pending

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `IntegrityOrphanCharges` | critical | {{ $value }} PSP charges have no paid order (money taken, no order) |
| `IntegrityStuckOrders` | warning | {{ $value }} orders stuck in a non-terminal payment state |
| `PaymentSuccessLow` | warning | Only {{ $value \| humanizePercentage }} of payment attempts succeed |
| `PaymentTimeouts` | warning | Payments timing out ({{ $value \| humanize }}/s) |
| `PaymentsPendingPileUp` | warning | {{ $value }} orders waiting in PAYMENT_PENDING |
| `PspErrorRateHigh` | warning | PSP rejecting {{ $value \| humanizePercentage }} of charges (rate_limited / outage) |
| `PspOutage` | critical | PSP outage: {{ $value \| humanizePercentage }} of charges fail with 503 |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

orders/main.ts `pay` with orders.paymentTimeout = mark_failed: a timeout means *unknown*, not *failed*. 25% of charges succeed at the PSP but answer after paymentTimeoutMs.

</details>

<details>
<summary><strong>The fix</strong></summary>

Park the order in PAYMENT_PENDING, tell the customer you are confirming, and reconcile: ask the PSP for the charge status by order (orders reconciler) before deciding PAID or FAILED.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `orders.paymentTimeout` | `mark_failed` (bug) | Treat timeout as failure and release stock. The PSP may have charged → "money taken, no order". |
| `orders.paymentTimeout` | `pending_reconcile` (fix) | Mark PAYMENT_PENDING; a reconciler asks the PSP for the truth. |

## In the real world

Every payment integration needs reconciliation for ambiguous outcomes (timeouts, network errors, webhooks out of order); UPI and card networks both expose status-check APIs for this.

## Scenario

<a id="scenario"></a>**Game day — payment provider brownout** (`gameday-psp-brownout`, 240s) — At T+60s the PSP slows to a crawl and 25% of charges respond after your timeout (but still charge the card). At T+180s it recovers.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 20s | 20 → 100 |
| peak | 220s | 100 → 100 |

Timeline:

- **T+60s** — PSP brownout: median 2.5s, p99 9s, 25% late responses
- **T+180s** — PSP recovers

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
