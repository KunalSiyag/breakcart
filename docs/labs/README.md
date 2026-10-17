# Labs

27 reproducible production incidents. Each lab runs the same traffic twice — once with a real-world bug, once with the fix — so you can see the failure, diagnose it from telemetry, and watch the fix work.

Generated from `server/src/shared/labs.ts` by `npm run gen:docs` (do not edit by hand).

## Inventory & consistency

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [We had 100 phones. We sold more than 100.](oversell-race.md) | beginner | A read-modify-write race in stock reservation oversells the hottest deal. | 3 |
| [Two carts, two SKUs, one deadlock](deadlocks.md) | intermediate | Multi-item carts lock stock rows in cart order; opposite orders deadlock under load. | 2 |
| ["Sold out" — with 40% of the stock still in the warehouse](phantom-sellout.md) | beginner | Reservations from abandoned checkouts never expire, so stock is held by nobody. | 1 |
| [A 200-use coupon, redeemed more than 200 times](coupon-overrun.md) | beginner | Check-then-act on a limited-use coupon lets concurrent redemptions race past the cap. | 1 |

## Caching

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [The cache expired, and so did the database](cache-stampede.md) | intermediate | Hot keys expire together under load; thousands of requests rebuild them at once. | 2 |
| [Customers charged yesterday's price](stale-price.md) | intermediate | Price changes do not invalidate caches; checkout trusts the cached quote. | 2 |

## Database

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [Connection pool exhausted: the hot row ate all the connections](pool-exhaustion.md) | intermediate | Long row locks on one hot SKU hold every pooled connection; unrelated reads time out. | 4 |
| [N+1: fine in dev, 25x the queries in prod](n-plus-one.md) | beginner | Listing pages issue one query per product; carts call catalog once per line. | 1 |
| [Search took down the product pages](slow-search.md) | beginner | An unindexed ILIKE scan monopolises the shared catalog connection pool. | 2 |

## Resilience

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [The non-critical service that took down the home page](cascading-failure.md) | beginner | A slow recommendations service drags the home page and product pages down with it. | 4 |
| [Retry storm: how three retries became a 4x DDoS](retry-storm.md) | intermediate | Immediate retries at every layer multiply load on a struggling dependency. | 5 |
| [Connection churn: paying the TCP handshake on every call](connection-churn.md) | advanced | Service-to-service calls without keep-alive pay connection setup each time and pile up TIME_WAIT sockets. | 1 |

## Runtime

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [The logs were the outage](logging-meltdown.md) | intermediate | Synchronous, pretty-printed per-request logging blocks the event loop at peak. | 1 |
| [OOMKilled every four minutes](memory-leak.md) | beginner | Catalog leaks memory until the container hits its limit and is killed mid-request. | 3 |
| [p50 is fine, p99 is on fire](gc-pauses.md) | intermediate | Periodic stop-the-world pauses in the gateway destroy tail latency. | 2 |
| [The sale started two minutes early (on one server)](clock-skew.md) | advanced | One service's clock is ahead; it shows and charges deal prices before the sale. | 1 |

## Edge & traffic

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [Congestive collapse: 100% busy, 0% useful](overload-collapse.md) | intermediate | Without load shedding, queues grow until every request times out — goodput falls to zero. | 6 |
| [Thundering herd at 00:00:00](thundering-herd.md) | intermediate | Everyone pays in the same second; the payment provider throttles. A virtual waiting room meters them in. | 3 |
| [The bots bought everything](bot-army.md) | intermediate | Scalper bots skip browsing and hammer add-to-cart; humans get nothing. | 3 |
| [The site stayed down after the outage ended](shedding-death-spiral.md) | advanced | Abandoned requests leak load-shedding slots; after the incident the gateway still believes it is full. | 1 |
| [Rate limits that reset in lockstep](rate-limit-bursts.md) | advanced | A per-second fixed-window limiter resets every client at the same instant: bursts at each boundary, up to 2× the limit across one. | 1 |
| [Redis blinked; the whole site went dark](redis-blip.md) | intermediate | A 20-second Redis outage becomes a 100% outage because the rate limiter fails closed. | 5 |

## Payments & money

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [Charged twice for one phone](double-charge.md) | intermediate | Double clicks and automatic retries create duplicate orders and duplicate charges. | 3 |
| [Money taken, no order](payment-limbo.md) | advanced | A PSP timeout is treated as a failure — but the customer was charged. | 7 |

## Async & events

| Lab | Difficulty | What breaks | Alerts |
|---|---|---|---|
| [Paid, but never shipped](lost-events.md) | intermediate | The dual-write problem: committing to the DB and publishing to a broker are not atomic. | 3 |
| [One bad message stopped all shipping](poison-pill.md) | intermediate | A malformed event is retried forever at the head of the queue; consumer lag grows without bound. | 2 |
| ["Where is my order?" — read-after-write on a lagging replica](replica-lag.md) | intermediate | Order history reads from a replica that is seconds behind; customers pay again. | 2 |

## Suggested path

1. **Start with what healthy looks like**: run scenario `normal-day` and learn the dashboards.
2. Beginner labs in order: `oversell-race`, `cascading-failure`, `n-plus-one`, `slow-search`, `phantom-sellout`, `coupon-overrun`, `memory-leak`.
3. Intermediate: `cache-stampede`, `retry-storm`, `pool-exhaustion`, `deadlocks`, `double-charge`, `thundering-herd`, `overload-collapse`, `lost-events`, `poison-pill`.
4. Advanced: `payment-limbo`, `clock-skew`, `shedding-death-spiral`, `connection-churn`, `rate-limit-bursts`.
5. Then the **game days** in [`../game-days.md`](../game-days.md): several bugs and faults at once, no hints.
