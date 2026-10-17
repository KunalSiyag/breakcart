# One bad message stopped all shipping

> **Lab `poison-pill`** · Async & events · intermediate · scenario [`steady-peak`](#scenario) · [all labs](README.md)

A malformed event is retried forever at the head of the queue; consumer lag grows without bound.

## The story

A producer change shipped a malformed event. Since then no order has been fulfilled and the stream lag graph is a straight line up.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=poison-pill VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=poison-pill VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `workers.poisonMessages` = `retry_forever` | flag `workers.poisonMessages` = `dead_letter` |
| chaos `data.poisonPct` = `1` | chaos `data.poisonPct` = `1` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: consumer lag and DLQ depth.
3. If no poison arrives quickly, press "Inject poison" in the War Room.
4. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
5. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
6. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- stream_consumer_lag rising linearly
- Timeline: "consumer stuck on message"
- Lost events (unshipped paid orders) climb

## Where to look

- Summary → consumer lag, DLQ depth
- Business invariants → lost events

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ConsumerLagGrowing` | warning | Consumer group {{ $labels.group }} on {{ $labels.stream }} is {{ $value }} messages behind and falling further |
| `DeadLetterQueueNotEmpty` | warning | {{ $value }} messages parked in the dead-letter queue |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

workers.poisonMessages = retry_forever: on failure the consumer re-reads its pending list from the start, retrying the same message forever (head-of-line blocking).

</details>

<details>
<summary><strong>The fix</strong></summary>

Bounded retries then a dead-letter queue (with alerting and a replay tool); keep consumers moving.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `workers.poisonMessages` | `retry_forever` (bug) | Retry the failing message in place → head-of-line blocking, consumer lag grows without bound. |
| `workers.poisonMessages` | `dead_letter` (fix) | After 3 attempts move the message to a DLQ and continue. |

## In the real world

Poison messages are a standard failure mode in Kafka/SQS/RabbitMQ consumers; DLQs and max-receive counts are the standard defence.

## Scenario

<a id="scenario"></a>**Sustained peak (soak)** (`steady-peak`, 600s, 2% bots) — Ten minutes at a high, flat rate. Slow leaks, unbounded queues and pool creep show up here, not in short spikes.

| Phase | Duration | Sessions/s (×1) |
|---|---|---|
| ramp | 30s | 20 → 140 |
| soak | 570s | 140 → 140 |

## Exercises

1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).
2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.
3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).
