# The bots bought everything

> **Lab `bot-army`** · Edge & traffic · intermediate · scenario [`bot-army`](#scenario) · [all labs](README.md)

Scalper bots skip browsing and hammer add-to-cart; humans get nothing.

## The story

The sneaker drop sold out in 9 seconds. Social media is furious; resale listings appear minutes later.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=bot-army VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=bot-army VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `gateway.botProtection` = `off` | flag `gateway.botProtection` = `on` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: sessions converted by persona (shopper vs bot) and blocked reasons.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Loadgen: bot conversions ≫ shopper conversions for hot SKUs
- High add-to-cart rate with almost no product views
- Bursty per-user request rates

## Where to look

- Loadgen sessions by persona
- gateway_bot_blocked_total by reason (fixed run)

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `BotTrafficBlocked` | info | Bot protection is blocking {{ $value \| humanize }} requests/s |
| `ShoppersBlockedAsBots` | warning | Real shoppers are being blocked by bot protection |
| `BotsWinningStock` | warning | Bots complete {{ $value \| humanizePercentage }} of successful purchases |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

gateway.botProtection = off: no behavioural checks. Bots add hot SKUs without viewing the product, from minutes-old accounts, at machine speed.

</details>

<details>
<summary><strong>The fix</strong></summary>

Layer signals at the edge. Behavioural: require a real product view shortly before add-to-cart on hot SKUs, block seconds-old accounts, cap checkout velocity per user — "smart" bots (30% here) fake all of that. Network: bots run from a few datacenter IPs while customers spread over millions of addresses, so a per-IP velocity limit catches what behaviour misses. Expect an arms race (residential proxies are next) and watch false positives on fast humans and shared carrier-NAT IPs.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `gateway.botProtection` | `off` (bug) | Bots that skip browsing and hammer add-to-cart win most hot stock. |
| `gateway.botProtection` | `on` (fix) | Hot SKUs: per-IP add-to-cart velocity, account older than 1s, product viewed ≥400ms before add-to-cart, and a per-user checkout velocity cap. |

## In the real world

Ticketing and limited-drop retailers fight automated purchasing with bot management, queues and purchase limits; legislation like the US BOTS Act exists because of it.

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
