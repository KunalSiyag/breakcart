# BreakCart web

React 19 + TypeScript + Vite 8 single-page app with four areas:

| Route | What it is |
|---|---|
| `/`, `/c/:category`, `/search?q=`, `/p/:id`, `/cart`, `/checkout`, `/orders`, `/orders/:id` | **Storefront**: the customer's view, where latency and glitches are *felt* |
| `/warroom` | **War Room**: the ops console (KPIs, business invariants, charts, service map, incidents, flags / chaos / tuning) |
| `/live` (`/mission-control` redirects here) | **Mission Control**: the real storefront and a live system map side by side, with sampled shopper journeys |
| `/labs`, `/labs/:id` | **Labs**: each production bug as a story, with "Run broken" / "Run fixed" and an embedded mini war room |

## Run it

```bash
cd web
npm install
npm run dev        # http://localhost:5180
npm run typecheck  # tsc -b (strict)
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve dist/ on :5180 with the same proxies
```

The dev and preview servers proxy `/api` → `http://localhost:3000` (gateway) and `/control` →
`http://localhost:3010` (control plane), including the SSE stream. Point them elsewhere with
`BREAKCART_GATEWAY_URL=… BREAKCART_CONTROL_URL=… npm run dev`. Against the full Docker stack (`make up`), the
gateway runs as replicas without a host port, so go through the web edge:
`BREAKCART_GATEWAY_URL=http://localhost:8080 npm run dev`.

In Docker (`docker compose up`), the `web` image is built from `web/Dockerfile`: Node 22 builds the
bundle, then `nginx:1.27-alpine` serves it on **:8080** using `web/nginx.conf`:

- `/api/` → `gateway:3000` and `/control/` → `control-plane:3010`, through keep-alive upstream pools.
  Upstreams use `server … resolve` plus Docker's DNS (`resolver 127.0.0.11 valid=10s`), so nginx starts
  even when the backends are down and follows containers that restart with a new IP.
- `/control/` has buffering and caching off and a 1h read timeout, so SSE events flush immediately.
  `text/event-stream` is never gzipped.
- When nginx itself cannot reach a backend it answers with the contract's JSON error
  (`UPSTREAM_UNAVAILABLE`). Backend 5xx bodies pass through untouched.
- Hashed `/assets/` are cached for a year, `index.html` is `no-cache`, and every other path falls back to
  `index.html`. `GET /healthz` is used by the container healthcheck.

## Layout

```
web/src/
  api/        types.ts (mirrors docs/contract.md + defs.ts), http.ts (fetch, ApiError, timeouts),
              shop.ts (the storefront api() wrapper), control.ts, inspector.ts, errors.ts (customer copy)
  shop/       ShopLayout, SaleContext (countdown driven by server time), CartContext,
              checkout.ts (the checkout state machine), components/, pages/
  ops/        store.ts (polling + SSE + rolling buffers), normalize.ts, thresholds.ts, palette.ts,
              fields.ts, labs.ts, topology.ts (Mission Control's fixed map layout), components/, pages/
  lib/        format (₹ via Intl en-IN), hooks (polling with back-off, useAsync…), viewport (reduced
              motion, element width), storage, art, ids
  styles/     base.css, shop.css (bright storefront), ops.css (dark console, loaded only with the ops chunk),
              mission.css (loaded only with the /live chunk)
```

The war room, Mission Control and labs are lazy-loaded, so recharts and the map never ship with the storefront
bundle (Mission Control itself doesn't use recharts).

## Design notes

**Storefront.**
- Every call goes through `api()` (`src/api/shop.ts`). It gets a guest token from `POST /api/auth/guest`,
  keeps it in localStorage (every storage access is guarded), re-authenticates once on a 401, records
  method, path, status, latency and error code for the **Request inspector** drawer, and turns every
  failure into an `ApiError` carrying the contract's code.
- Slow pages show a seconds counter, so a 30s blocking dependency is felt instead of hidden.
- Product images are deterministic gradient + emoji tiles built from `imageSeed` + category.

**Checkout.** `src/shop/checkout.ts` is a small state machine that lives outside React, so re-renders and
StrictMode can never send a second `POST /api/checkout` or `/pay`.
- There is one `Idempotency-Key` per order attempt and one per payment attempt. A retry after a transient
  failure (network error, 5xx, 429, edge rejection) reuses the key. Any other 4xx is stored and replayed by
  orders for that key, so retrying it starts a new attempt with a new key.
- `QUEUE_REQUIRED` opens the virtual waiting room: join, poll status every 2s, then retry checkout with
  `X-Queue-Pass`. The ticket survives a page refresh.
- A 202 `PAYMENT_PENDING` shows "We're confirming your payment…" and polls the order.
- The machine's state is mirrored to sessionStorage, so a refresh resumes where the customer left off.

**Ops layout** (`src/ops/OpsLayout.tsx`). The top bar is sticky from 801px. OpsLayout measures its height into
`--ops-header-h`, and `scroll-padding-top` uses it, so keyboard focus and in-page links never land underneath
it. At 800px and below, where it wraps to two or three rows (85-150px), it scrolls away with the page.

**War room data** (`src/ops/store.ts`). One ref-counted store is shared by the war room, Mission Control and
the labs.
- It polls `/control/summary` every 2s into a rolling 10-minute buffer.
- It listens to SSE `timeline` / `loadgen` / `runtime` / `integrity` / `journey` events, with its own
  exponential reconnect and a connection indicator.
- While SSE is down it falls back to polling `/control/loadgen` and `/control/integrity`.
- On first load it backfills the gateway charts from `/control/prom/query_range`, using the same PromQL
  as the summary.
- Every loop backs off exponentially when the control plane is unreachable. A banner explains the outage
  and nothing loops tightly.
- Payloads go through defensive normalisers, so a partial payload can't crash the page.

**Mission Control** (`/live`, `src/ops/pages/MissionControlPage.tsx`). One screen for the store and the backend.
It reads the same ops store as the war room and adds no controls of its own: the header reuses the war room's
`ScenarioBar` (start / stop / load multiplier); everything else links to the war room.
- *Header*: scenario status and sale clock (`ScenarioBar`), the SSE indicator, links to War Room, Labs and Grafana
  (`:3300` on the current host). The scenario picker follows the scenario the loadgen reports (a lab, another tab
  or a script may start one) until the user picks another, and a run starting or ending drops that pick, so
  Restart always restarts what is running; picking a different scenario mid-run turns the button into "Switch to
  this". *Right now* lists every flag that is not in its hardened mode (**BUG** = the naive
  mode, linking to its lab; **FLAG** = another non-hardened mode) and every chaos knob away from its
  `defs.*Defaults` value. A KPI strip (shared `KpiCard`) mixes loadgen numbers (live shoppers, arrivals/s,
  conversion = converted / started for this run, labelled *Conversion (last run)* while idle) with the summary
  KPIs. Placeholder tiles and the scenario plan keep their final height while data loads, so the page doesn't
  jump.
- *The store, live* (`StorePreview`): the storefront in a same-origin `<iframe>` with Desktop / Phone (a true
  390 CSS px viewport in a bezel) and quick-nav buttons. Navigation uses `location.replace` inside the frame, so it
  doesn't grow the tab's history. The address strip follows in-app navigation. Inside the frame the storefront's ops
  links get `target="_top"`, and a Mission Control that finds itself framed refuses to embed another storefront.
  The frame holds ~50 Tab stops, so a *Skip to the system map* link (shown only while focused) comes right before
  it.
- *Live shoppers* (`JourneyFeed`): the store keeps the newest 60 journeys. It loads `GET /control/journeys/recent`
  once on start (again after an SSE reconnect, to fill the gap), appends SSE `journey` events, and empties the
  buffer when a new run starts, as the control plane does. The feed renders 12 rows, filters All / Converted /
  Failed / Bots, and Pause freezes the list while buffering continues (the button's label names the action,
  Pause / Resume, so it has no `aria-pressed`). The list also holds still by itself while
  the pointer is over it, keyboard focus is in it or a row is open (new rows would otherwise push it down ~4×/s). A
  note over its top edge counts the new journeys waiting (only those the active filter will show, as does
  "Resume (N new)"), and the list catches up 0.6 s after the user leaves. Each
  row has a request waterfall (position = click time, width = latency, min 2px; 2xx green, 4xx amber, 5xx / no
  response red, successful `queue` calls and 409 `QUEUE_REQUIRED` blue; 2xx and waiting-room bars are half height,
  so success vs failure doesn't rely on hue alone) with a tooltip per request, and expands into
  the full request log (rendered only while open). Below 520px the timings wrap under the product name.
- *The system, live* (`SystemMap`, geometry in `src/ops/topology.ts`): a hand-placed SVG map, never
  force-directed. Row A: customers → gateway, and payments styled as an external PSP. Row B: recommendations,
  catalog, cart, inventory, orders, with service-to-service calls drawn as nested arcs that never cross each other.
  Row C: Redis, Postgres, workers and the order-event stream. Store links are S-curves with end points ordered to
  minimise crossings.
  - Edges come from `summary.edges` (+ customers → gateway), `summary.stores` and `summary.stream`. Width grows
    with log(rps). Colour is a band: red at ≥ 5% errors or p99 ≥ 2 s, amber at ≥ 1% or ≥ 500 ms, green below
    (a fast edge that fails half its calls is red, not amber). Below 0.5 rps a p99 is ignored (it's the slowest of
    a handful of requests). The stream is coloured by consumer lag (and DLQ > 0). inventory → Redis exists only
    with `inventory.reserve = redis_lua`, so it is drawn only while it reports traffic. Calls and store clients the
    fixed map doesn't know get a generic route.
  - Labels ("123/s · 45ms", a second line for errors ≥ 1%) show for calls ≥ 1 rps, and for store links only
    when unhealthy, to keep the busy store band readable. Every label shows on hover or focus. An open or
    half-open breaker turns its edge dashed red and leads its label with OPEN / HALF-OPEN.
  - Store cards colour their p99 with the edge bands (▲ ≥ 500 ms, ■ ≥ 2 s) and, like the edges, only from
    clients doing ≥ 0.5 ops/s. A service whose DB pool has waiters shows "■ N waiting" in place of its loop lag.
  - Flow particles are SMIL `<animateMotion>`: 1–4 dots per edge, with a lap time from a per-doubling traffic
    bucket (with hysteresis), so React only re-renders when a summary arrives. They ignore the pointer, and the
    SVG's animation clock is paused while the map is scrolled out of view. Under `prefers-reduced-motion` no
    particles are rendered. *Pause motion* in the panel header (remembered in localStorage) does the same on demand
    and also stops the page's blinking live dots (`data-motion="still"` on `<html>`).
  - Nodes are `role="button"`. Enter, Space or click opens a side panel with every metric, inbound and outbound
    edges, active chaos, breakers, and the gateway's route table. The panel opens on the side that hides less of
    the node; Escape returns focus to the node (it works from anywhere in the panel, including after a click on its
    text, and from a map node, where focus stays put). Nodes the open panel covers completely leave the Tab order.
    The Inbound / Outbound tables keep the map's order and Routes are sorted by name, so rows don't move under the
    pointer between samples. A node's accessible name is built from its live numbers but stays
    fixed while it has focus, so screen readers don't re-read it on every summary. A *Needs attention* list above
    the map spells out what is unhealthy, ordered by severity and then a fixed order (entries don't reshuffle with
    traffic), and each entry opens the relevant node. It shows seven entries and says how many more there are.
  - Below a 620px container the same geometry switches to big-text tiles (labels hidden, details in the panel;
    ▲ / ■ follow the same thresholds as the full cards). From 1200px the map column is sticky, so it stays in view
    while the store column scrolls. A column taller than the window pins once its bottom is in view, so there is
    no nested scrollbar.
- *Bottom row*: a conversion funnel (loadgen step rps from arrivals to pay, plus converted sessions/s, with
  stage-to-stage %, which goes past 100% when retries make a stage bigger than the one before it), hot-deal stock
  draining live from `summary.hotStock` (names and totals from `GET /api/home`, refreshed at most once a minute;
  every bar shares one track width), and the war room's `IntegrityPanel` and `Timeline` in compact mode. The funnel
  only fills while a scenario runs: idle, the SSE connect replay still carries the last run's final rates.
- *Older control planes* (no topology fields, no journeys endpoint): every node still renders with its service
  metrics. The architecture is drawn as dotted "not reported" edges, customers → gateway is computed from the
  gateway's own stats, and a note says edge metrics need a newer control plane. Hot-deal stock falls back to the
  `/api/home` snapshot, and the feed explains what is missing.

**Controls are data-driven.** Flags, chaos fields and tuning keys are rendered from `GET /control/state` →
`defs`. Each flag shows its modes, with the naive mode tagged *bug* and the hardened mode tagged *fix*, plus
the help text for the selected mode. Chaos sliders are debounced; toggles apply immediately. SSE `runtime`
events keep every panel in sync.

**Charts** follow one set of conventions:
- One y-axis per chart (gateway RPS and error rate are separate plots).
- 2px lines with a crosshair tooltip that lists every series, and a legend that shows the latest values.
- Every chart has a "Show table" twin.
- Identity colours come from a categorical palette that was CVD-checked for the dark surface.
- Latency percentiles use one ordinal blue ramp.
- Status colours (good / warning / serious / critical) are reserved for meaning and always come with an
  icon and a label.

**Contract interpretations** (where the contract was silent):
- `POST /api/cart/items` adds `qty` (the cart service HINCRBYs). The cart page adds the difference to
  increase a line, and removes and re-adds the line to decrease it.
- Timeline `ts` is accepted as epoch ms, epoch seconds or ISO.
- List endpoints may be bare arrays or `{ items }`.
- Errors that aren't in the contract's list but are emitted by the services (`BAD_REQUEST`,
  `INVALID_COUPON`, `COUPON_NOT_APPLICABLE`, `ORDER_EXPIRED`) have customer copy too.
- `PAYMENT_FAILED` is treated as terminal: declines return the order to `AWAITING_PAYMENT`.
