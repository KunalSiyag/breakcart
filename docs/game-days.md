# Game days

Labs teach one failure at a time with a spoiler at the end. A game day is the real thing: several faults, a
timeline nobody announced, and a team that has to find and mitigate them with only telemetry.

## Roles

| Role | Does |
|---|---|
| **Game master** | Chooses the scenario and the hidden bugs, triggers extra faults, keeps time. Has the control plane. |
| **Incident commander** | Coordinates, decides, keeps a timeline in the incident doc. Does not debug. |
| **Responders** (2–4) | Investigate with the War Room, Grafana, Jaeger, Prometheus alerts, `docker compose logs`, `psql`. |
| **Comms** | Writes customer-facing status updates every 10 minutes ("Some customers can't pay…"). |

Responders may **mitigate** with operational levers only — flags that a real on-call would have (load shedding,
waiting room, breakers, rate limits, fail-open), tuning (pool sizes, timeouts, TTLs), restarting a service,
flushing caches. They may not read the game master's setup.

## Running one

1. Game master: `make up`, then secretly apply 2–3 broken flags, e.g.

   ```bash
   make preset P=hardened
   make flag F=catalog.cache M=naive_ttl
   make flag F=orders.paymentTimeout M=mark_failed
   make flag F=platform.retries M=naive_immediate
   ```

2. Start a game-day scenario (they have built-in fault timelines):

   ```bash
   make scenario S=gameday-psp-brownout X=1
   ```

3. Add surprise faults from the War Room's chaos panel or the API, e.g.

   ```bash
   curl -XPATCH localhost:3010/control/chaos -H 'content-type: application/json' \
        -d '{"services":{"inventory":{"dbSlowMs":250,"dbSlowPct":40}}}'
   curl -XPOST localhost:3010/control/actions/kill-service -H 'content-type: application/json' -d '{"target":"catalog"}'
   ```

4. The team works the incident. Suggested time box: 30 minutes.
5. Debrief using [the postmortem template](postmortem-template.md). Score:
   - time to detect (first alert or first human "something is wrong"),
   - time to mitigate (customer impact stops),
   - **business damage** from the War Room's invariants panel: oversold units, double charges, orphan charges,
     lost events, wrong prices. Latency recovers; these don't.

## Built-in game-day scenarios

| Scenario | Timeline |
|---|---|
| `gameday-psp-brownout` | T+60s PSP median 2.5 s, p99 9 s, 25% of charges answer after 12 s; T+180s recovery. |
| `gameday-redis-blip` | T+60s Redis unreachable from gateway, catalog, cart, orders; T+80s back. |
| `gameday-bad-deploy` | T+60s catalog restarts; T+61s cache flushed; T+140s orders crashes. |
| `gameday-slow-recs` | T+45s recommendations +8 s; T+165s recovery. |
| `gameday-db-degradation` | T+60s +300 ms on 30% of inventory/orders queries; T+160s recovery. |

## Suggested combinations

| Name | Setup | What the team should find |
|---|---|---|
| "Black Friday, startup edition" | `make preset P=naive` + `midnight-flash-sale` | Everything. Prioritise by customer impact and money lost. |
| "It's only recommendations" | `bff.nonCriticalDeps=blocking`, `platform.retries=naive_immediate` + `gameday-slow-recs` | Cascading failure amplified by retries. |
| "The money is wrong" | `orders.paymentTimeout=mark_failed`, `orders.idempotency=off` + `gameday-psp-brownout` | Orphan charges and duplicate charges while dashboards look merely "slow". |
| "Silent data loss" | `orders.eventPublishing=dual_write`, `workers.poisonMessages=retry_forever`, chaos `data.eventPublishFailPct=3`, `data.poisonPct=0.5` + `steady-peak` | Nothing is red on latency; shipments quietly stop. |
| "Midnight at scale" | `gateway.waitingRoom=off`, `gateway.loadShedding=off`, `catalog.cache=naive_ttl` + `singles-day` with `X=1.5` | Overload, then stampede on recovery. |

## Ground rules that make game days useful

- Write the timeline as you go (UTC timestamps). The War Room timeline helps but is not the whole story.
- Name the **customer impact** before the cause.
- Prefer mitigation over diagnosis while customers are hurting: shed, queue, fail open, roll back the flag.
- Afterwards, reconcile: how many customers were charged without an order? The auditor knows.
