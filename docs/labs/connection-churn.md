# Connection churn: paying the TCP handshake on every call

> **Lab `connection-churn`** · Resilience · advanced · scenario [`steady-peak`](#scenario) · [all labs](README.md)

Service-to-service calls without keep-alive pay connection setup each time and pile up TIME_WAIT sockets.

## The story

CPU is higher than last year at the same traffic, p50 is up a few ms on every hop, and someone mentions "ephemeral port exhaustion" in the incident channel.

## Run it

From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:

```bash
make lab LAB=connection-churn VARIANT=broken     # reset data, apply the bug, start traffic
make lab LAB=connection-churn VARIANT=fixed      # same traffic, hardened implementation
```

Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.

| Broken variant | Fixed variant |
|---|---|
| flag `platform.keepAlive` = `off` | flag `platform.keepAlive` = `on` |

## Steps

1. Open the War Room (or stay on this page) and press "Run broken". Data is reset and the scenario starts.
2. While it runs, watch: CPU% per service and internal call latency. Try `docker compose exec gateway sh -c "cat /proc/net/sockstat"`.
3. Before revealing the root cause, write down your hypothesis. Use Grafana (localhost:3300) and Jaeger (localhost:16686) to confirm it.
4. Press "Run fixed" — same traffic, same chaos, hardened implementation — and compare the same panels.
5. Read the code path named in the root cause. Then flip only the flag back and forth mid-run to see the effect live.

## Symptoms

- Higher p50 on every internal hop
- CPU% up on gateway and callers
- `ss -s` inside containers shows many TIME_WAIT sockets

## Where to look

- Service grid → CPU%
- Grafana → Services → client call latency

### Alerts that fire

| Alert | Severity | Meaning |
|---|---|---|
| `ConnectionChurn` | warning | {{ $labels.service }} -> {{ $labels.target }}: {{ printf \"%.2f\" $value }} new TCP connections per call |

Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.

## Diagnose before you peek

Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, 
and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger 
(<http://localhost:16686>, 5% head sampling).

<details>
<summary><strong>Root cause (spoiler)</strong></summary>

platform.keepAlive = off sends every undici request with reset=true, so each call opens and closes a TCP connection.

</details>

<details>
<summary><strong>The fix</strong></summary>

Keep pooled persistent connections (and, across the internet, reuse TLS sessions). Size pools per upstream.

</details>

## Flags involved

| Flag | Mode | What it does |
|---|---|---|
| `platform.keepAlive` | `off` (bug) | New TCP connection per request → handshake cost, TIME_WAIT pile-up, ephemeral port pressure. |
| `platform.keepAlive` | `on` (fix) | Pooled persistent connections. |

## In the real world

Ephemeral port exhaustion and TIME_WAIT build-up from connection churn are classic high-RPS failures behind proxies and NAT gateways.

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
