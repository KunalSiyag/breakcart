# k6 load scripts for BreakCart

BreakCart ships its own behavioural traffic generator (`loadgen`, driven from the control plane).
These [k6](https://grafana.com/docs/k6/latest/) scripts are an alternative driver for people who
already know k6 or want to script their own scenarios. They talk to the public API exactly like
the storefront does (`docs/contract.md` §2), so every Grafana dashboard except *Load Generator*
shows their traffic.

| Script | Workload | What it is for |
|---|---|---|
| `smoke.js` | 1 VU, 1 iteration | Walks every public endpoint once and checks the responses. Run it after `docker compose up`. |
| `flash-sale.js` | open, `ramping-arrival-rate` | Calm → spike at sale start → peak → sustained. Full funnel (home → product → cart → checkout → pay) with think times. Thresholds on checkout success and p95. |
| `bot-army.js` | open, `constant-arrival-rate` | Scalper bots: no browsing, straight to add-to-cart and checkout on hot SKUs, ignore `Retry-After`. Threshold on how often bots win. |
| `soak.js` | open, `constant-arrival-rate` | Moderate load for 30 minutes. Catches leaks: memory, phantom holds, outbox backlog, latency creep. |
| `lib.js` | – | Guest auth, API client, idempotency keys, the waiting-room protocol, checkout/pay retries, the shopper journey. |

## Running

The stack's network is `breakcart_default` and the gateway listens on `gateway:3000` inside it.
The scripts import `./lib.js`, so k6 needs that file next to the script. When you pipe a script
on stdin, k6 resolves `./lib.js` against `/`, so mount it there:

```bash
docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/smoke.js
docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" grafana/k6 run - < k6/flash-sale.js
```

You can also mount the whole folder:

```bash
docker run --rm --network breakcart_default -v "$PWD/k6:/scripts:ro" grafana/k6 run /scripts/flash-sale.js
```

Plain `docker run ... grafana/k6 run - < k6/flash-sale.js` with no mount fails with
`The moduleSpecifier "./lib.js" couldn't be found on local disk`.

From the host, with k6 installed locally, go through the web edge (the gateway runs as
replicas and has no host port): `BASE_URL=http://localhost:8080 k6 run k6/flash-sale.js`.

| Env var | Default | Used by |
|---|---|---|
| `BASE_URL` | `http://gateway:3000` | all |
| `MULTIPLIER` | `1` | flash-sale, bot-army, soak: scales every arrival rate |
| `MAX_VUS` | 1500 / 400 / 400 | flash-sale / bot-army / soak: VU ceiling (see Little's law below) |
| `DURATION` | `3m` / `30m` | bot-army / soak |
| `QTY` | `1` | bot-army: units per bot add-to-cart |
| `SPOOF_IPS` | `true` | all: give each session its own `X-Forwarded-For` address (see below) |

Tips:

- **The sale clock belongs to the server.** k6 does not start the sale. `GET /api/sale` says
  whether it is live, and `setup()` prints it. Start a scenario or lab from the control plane
  if you want the k6 spike to hit a live sale.
- **Don't double up by accident.** Stop the built-in loadgen (`POST /control/scenarios/stop`)
  unless you want both traffic sources at once.
- **Flip flags while k6 runs.** That is the point of the lab. Run `flash-sale.js`, switch a
  lab to `broken` in the war room, then compare `checkout_success` and the dashboards.
- **Client IPs.** The gateway rate-limits anonymous calls (guest sign-in) per client IP and
  trusts the first `X-Forwarded-For` hop. Every VU in one container shares one IP, so by
  default each shopper session gets a synthetic `10.x.y.z` address. Bots share a small pool of
  "proxy" addresses on purpose.

## What the scripts measure

`http_req_failed` counts only 5xx responses and transport errors. A 409 `OUT_OF_STOCK` or a 429
`RATE_LIMITED` is a correct answer from a healthy system, not a failure. Business outcomes have
their own metrics:

| Metric | Meaning |
|---|---|
| `checkout_success` (rate) | Checkout ended in a correct answer: an order, or an honest "sold out" / "sale not started". Errors, timeouts, shedding and bot false-positives count as failures. |
| `payment_success` (rate) | Payment for a created order ended `PAID` (including `202 PAYMENT_PENDING` that later resolved). |
| `orders_created`, `orders_paid`, `sold_out` | Counters. |
| `queue_wait` (trend) | Time spent in the virtual waiting room before getting a pass. |
| `journey_duration` (trend) | Length of one shopper session, tagged with how it ended. |
| `rate_limited`, `shed`, `bot_blocked`, `payment_pending` | How often each defence or degraded path was hit. |
| `bot_success`, `bot_attempts` | bot-army only: share of bot attempts that ended in a paid order. |

Requests are tagged with `endpoint` (`home`, `product`, `add_to_cart`, `checkout`, `pay`,
`queue_status`, ...), so thresholds can target one step: `http_req_duration{endpoint:checkout}`.

The client behaves like a careful real app:

- It sends an `Idempotency-Key` on checkout and pay, and reuses it when it retries the same
  operation.
- It honours `Retry-After` on 429 and 503.
- It joins the waiting room on `409 QUEUE_REQUIRED` and polls `/api/queue/status` about every
  2s until it gets a pass.
- It polls the order after `202 PAYMENT_PENDING`.

With `orders.idempotency=off`, those same safe-looking pay retries create duplicate charges.
That is the double-charge lab.

## Open vs closed workload models

A **closed** model has a fixed number of users. Each one sends a request, waits for the answer,
thinks, then sends the next. Examples: k6 `constant-vus`, a `for` loop in a script, most
benchmarking tools. When the system slows down, the users wait longer between requests, so the
load drops by itself. The test is politely backing off at exactly the moment a real sale would
not.

An **open** model schedules arrivals on a clock: "40 new shoppers per second", whatever the
response times. Examples: `constant-arrival-rate`, `ramping-arrival-rate`. Real launch traffic
is open. Thousands of people who hit refresh at 00:00:00 don't wait for each other. If the
system slows down, work piles up: queues grow, concurrency grows, timeouts start. That pile-up
is the failure mode BreakCart wants you to see, so every script here except the smoke test is
open.

**Little's law** sizes an open test: `concurrency = arrival rate × time in system`. Say 40
shoppers/s each spend ~20s in a session (think times, waiting room). That needs about 800 VUs,
and more when the site slows down. If k6 runs out of VUs (`MAX_VUS`) it cannot start scheduled
arrivals and reports them as `dropped_iterations`. The scripts set a threshold on it, because a
test that silently applied less load than planned is lying.

## Coordinated omission

A closed-loop client only sends the next request after the previous one returns. Picture a
server that stalls for 10 seconds. A user who would have sent 10 requests in that window sends
one, which reports 10 seconds, and the other 9 slow experiences are never measured. The tool
has "coordinated" with the server to omit the bad samples, so percentiles look far better than
reality.

Arrival-rate executors avoid most of this: requests are scheduled independently of how long
earlier ones took. Two things still hide latency:

- dropped iterations (watch `dropped_iterations`), and
- time spent queued *before* the gateway (watch the customer vs server latency panel on the
  *Load Generator* dashboard: customer-measured p95 well above server-measured p95 is exactly
  this gap).

## Seeing k6 in Grafana

k6 traffic goes through the gateway, so the War Room, Services, Data and Business dashboards
all show it. The *Load Generator* dashboard only shows the built-in loadgen.

To get k6's own metrics into Prometheus, Prometheus has to accept remote writes. Its command in
`docker-compose.yml` needs `--web.enable-remote-write-receiver`, which is off by default. Then:

```bash
docker run --rm -i --network breakcart_default -v "$PWD/k6/lib.js:/lib.js:ro" \
  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
  -e K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99) \
  grafana/k6 run -o experimental-prometheus-rw - < k6/flash-sale.js
```
