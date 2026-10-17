/**
 * Single source of truth for every runtime knob in BreakCart.
 *
 *  - FLAGS   : implementation switches. Each flag has a fragile ("naive") mode that
 *              reproduces a real production bug and a "hardened" mode that fixes it.
 *  - CHAOS   : fault injection, per service. All zero by default.
 *  - TUNING  : capacity / timeout knobs (pool sizes, rate limits, TTLs...).
 *
 * The control plane persists the live values in Redis; every service subscribes and
 * applies changes within milliseconds, so you can flip a bug on/off mid-sale.
 */

export const SERVICES = [
  'gateway',
  'catalog',
  'inventory',
  'cart',
  'orders',
  'payments',
  'recommendations',
  'workers',
  'control-plane',
  'loadgen',
] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface FlagDef {
  description: string;
  modes: readonly string[];
  naive: string;
  hardened: string;
  /** Lab id that teaches this flag. */
  lab: string;
  modeHelp: Record<string, string>;
}

export const FLAGS = {
  'inventory.reserve': {
    description: 'How stock is reserved at checkout.',
    modes: ['naive_read_modify_write', 'select_for_update', 'atomic_conditional_update', 'redis_lua'],
    naive: 'naive_read_modify_write',
    hardened: 'atomic_conditional_update',
    lab: 'oversell-race',
    modeHelp: {
      naive_read_modify_write: 'SELECT stock, check in app, UPDATE with computed value. Lost updates → oversell.',
      select_for_update: 'Pessimistic row lock. Correct, but hot SKUs serialize and hold DB connections.',
      atomic_conditional_update: 'UPDATE … SET available = available - n WHERE available >= n. Correct and short locks.',
      redis_lua: 'Atomic Lua gate in Redis, then DB write. Fastest; Redis becomes the source of truth for the hot path.',
    },
  },
  'inventory.lockOrdering': {
    description: 'Order in which multi-item carts lock SKU rows.',
    modes: ['cart_order', 'sorted_by_sku'],
    naive: 'cart_order',
    hardened: 'sorted_by_sku',
    lab: 'deadlocks',
    modeHelp: {
      cart_order: 'Lock rows in whatever order the cart lists them → two carts with A,B and B,A deadlock.',
      sorted_by_sku: 'Always lock in a global order → no lock cycles.',
    },
  },
  'inventory.reservationTtl': {
    description: 'Whether unpaid reservations expire.',
    modes: ['never_expire', 'expire_and_sweep'],
    naive: 'never_expire',
    hardened: 'expire_and_sweep',
    lab: 'phantom-sellout',
    modeHelp: {
      never_expire: 'Abandoned checkouts hold stock forever → "Sold out" while units sit unsold.',
      expire_and_sweep: 'HELD reservations expire after reservationTtlSec and a sweeper returns the stock.',
    },
  },
  'catalog.cache': {
    description: 'Product / deals caching strategy.',
    modes: ['none', 'naive_ttl', 'hardened'],
    naive: 'naive_ttl',
    hardened: 'hardened',
    lab: 'cache-stampede',
    modeHelp: {
      none: 'Every read hits Postgres.',
      naive_ttl: 'Cache-aside with a fixed TTL. Hot keys expire together → thousands of concurrent rebuilds (stampede).',
      hardened: 'In-process L1 for hot keys + single-flight + distributed rebuild lock + jittered TTL + stale-while-revalidate.',
    },
  },
  'catalog.priceInvalidation': {
    description: 'How caches learn about price changes.',
    modes: ['ttl_only', 'pubsub_invalidate'],
    naive: 'ttl_only',
    hardened: 'pubsub_invalidate',
    lab: 'stale-price',
    modeHelp: {
      ttl_only: 'Caches keep serving the old price until TTL expiry.',
      pubsub_invalidate: 'Price writes publish an invalidation; L1 and Redis entries are evicted immediately.',
    },
  },
  'catalog.listQuery': {
    description: 'How the category listing loads products.',
    modes: ['n_plus_one', 'batched'],
    naive: 'n_plus_one',
    hardened: 'batched',
    lab: 'n-plus-one',
    modeHelp: {
      n_plus_one: 'One query for ids, then one query per product (ORM lazy loading).',
      batched: 'One query with = ANY($1).',
    },
  },
  'catalog.search': {
    description: 'Search implementation.',
    modes: ['ilike_scan', 'fts_index'],
    naive: 'ilike_scan',
    hardened: 'fts_index',
    lab: 'slow-search',
    modeHelp: {
      ilike_scan: "WHERE name ILIKE '%q%' OR description ILIKE '%q%' → sequential scan, holds a connection for long.",
      fts_index: 'tsvector + GIN index.',
    },
  },
  'bff.nonCriticalDeps': {
    description: 'How the gateway (BFF) calls non-critical dependencies (recommendations).',
    modes: ['blocking', 'isolated'],
    naive: 'blocking',
    hardened: 'isolated',
    lab: 'cascading-failure',
    modeHelp: {
      blocking: 'Await recommendations with the default 30s timeout. A slow recs service takes down the home page.',
      isolated: 'Short timeout + circuit breaker + static fallback. Home page degrades gracefully.',
    },
  },
  'platform.retries': {
    description: 'Service-to-service retry policy (all HTTP clients).',
    modes: ['none', 'naive_immediate', 'budgeted_backoff'],
    naive: 'naive_immediate',
    hardened: 'budgeted_backoff',
    lab: 'retry-storm',
    modeHelp: {
      none: 'Never retry.',
      naive_immediate: 'Retry everything (incl. POSTs) 3x immediately. Multiplies load on a struggling dependency.',
      budgeted_backoff: 'Retry only idempotent calls, exponential backoff + full jitter, retry budget of ~10%.',
    },
  },
  'platform.circuitBreaker': {
    description: 'Circuit breakers on service-to-service calls.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'retry-storm',
    modeHelp: {
      off: 'Keep calling a dead dependency; every caller waits for its timeout.',
      on: 'Open after ≥50% failures (min 20 calls), fail fast, probe in half-open.',
    },
  },
  'platform.keepAlive': {
    description: 'HTTP keep-alive between services.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'connection-churn',
    modeHelp: {
      off: 'New TCP connection per request → handshake cost, TIME_WAIT pile-up, ephemeral port pressure.',
      on: 'Pooled persistent connections.',
    },
  },
  'platform.logging': {
    description: 'Request logging strategy.',
    modes: ['sync_verbose', 'async_sampled'],
    naive: 'sync_verbose',
    hardened: 'async_sampled',
    lab: 'logging-meltdown',
    modeHelp: {
      sync_verbose: 'Pretty-print every request, response and upstream call (bodies included) and write it synchronously to a log file with fsync — every request waits for the disk on the event loop.',
      async_sampled: 'Async structured logger, 1% access-log sampling, errors always logged.',
    },
  },
  'gateway.rateLimit': {
    description: 'Per-user/IP rate limiting at the edge.',
    modes: ['off', 'fixed_window', 'token_bucket'],
    naive: 'fixed_window',
    hardened: 'token_bucket',
    lab: 'rate-limit-bursts',
    modeHelp: {
      off: 'No rate limiting.',
      fixed_window: 'INCR per 1s window. Allows 2x burst at window edges.',
      token_bucket: 'Atomic Lua token bucket — smooth rate with bounded burst.',
    },
  },
  'gateway.rateLimitFailMode': {
    description: 'What the rate limiter does when Redis is unreachable.',
    modes: ['fail_closed', 'fail_open'],
    naive: 'fail_closed',
    hardened: 'fail_open',
    lab: 'redis-blip',
    modeHelp: {
      fail_closed: 'Redis error → reject request. A Redis blip becomes a full outage.',
      fail_open: 'Redis error → allow request (protected by load shedding instead).',
    },
  },
  'gateway.loadShedding': {
    description: 'Priority-aware concurrency limit at the gateway.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'overload-collapse',
    modeHelp: {
      off: 'Accept everything; queues grow until every request times out (congestive collapse).',
      on: 'Shed low-priority routes first (search, recs, browse) when in-flight requests or queueing delay (event-loop lag) cross per-priority limits; checkout is shed last.',
    },
  },
  'gateway.inflightAccounting': {
    description: 'When the gateway gives back an admission slot (load-shedding counter).',
    modes: ['on_response', 'on_close'],
    naive: 'on_response',
    hardened: 'on_close',
    lab: 'shedding-death-spiral',
    modeHelp: {
      on_response: 'Release in the onResponse hook — which never runs when the client hangs up first. Every abandoned request leaks a slot.',
      on_close: 'Release on the response\'s close event: exactly once per request, whether the response finished or the client left.',
    },
  },
  'gateway.waitingRoom': {
    description: 'Virtual waiting room in front of checkout for hot sales.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'thundering-herd',
    modeHelp: {
      off: 'Everyone hits checkout at 00:00:00.',
      on: 'FIFO tickets; admit waitingRoomAdmitPerSec users per second into checkout.',
    },
  },
  'gateway.botProtection': {
    description: 'Scalper / bot mitigation for hot SKUs.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'bot-army',
    modeHelp: {
      off: 'Bots that skip browsing and hammer add-to-cart win most hot stock.',
      on: 'Hot SKUs: per-IP add-to-cart velocity, account older than 1s, product viewed ≥400ms before add-to-cart, and a per-user checkout velocity cap.',
    },
  },
  'orders.idempotency': {
    description: 'Idempotency keys on checkout and pay.',
    modes: ['off', 'on'],
    naive: 'off',
    hardened: 'on',
    lab: 'double-charge',
    modeHelp: {
      off: 'Double clicks and client retries create duplicate orders and duplicate charges.',
      on: 'Idempotency-Key stored in Redis with the response; state transitions use compare-and-set; PSP gets an idempotency key.',
    },
  },
  'orders.paymentTimeout': {
    description: 'What happens when the payment provider times out.',
    modes: ['mark_failed', 'pending_reconcile'],
    naive: 'mark_failed',
    hardened: 'pending_reconcile',
    lab: 'payment-limbo',
    modeHelp: {
      mark_failed: 'Treat timeout as failure and release stock. The PSP may have charged → "money taken, no order".',
      pending_reconcile: 'Mark PAYMENT_PENDING; a reconciler asks the PSP for the truth.',
    },
  },
  'orders.eventPublishing': {
    description: 'How order events reach fulfillment.',
    modes: ['dual_write', 'outbox'],
    naive: 'dual_write',
    hardened: 'outbox',
    lab: 'lost-events',
    modeHelp: {
      dual_write: 'Commit to Postgres then XADD to Redis. If the second write fails the order is never shipped.',
      outbox: 'Write event to an outbox table in the same transaction; a relay publishes it at-least-once.',
    },
  },
  'orders.coupon': {
    description: 'Limited-use coupon redemption.',
    modes: ['check_then_act', 'atomic'],
    naive: 'check_then_act',
    hardened: 'atomic',
    lab: 'coupon-overrun',
    modeHelp: {
      check_then_act: 'SELECT used < max, then UPDATE used = used + 1. Races past the cap.',
      atomic: 'UPDATE … WHERE used < max_uses RETURNING.',
    },
  },
  'orders.pricing': {
    description: 'Which price checkout charges.',
    modes: ['cart_quote', 'authoritative'],
    naive: 'cart_quote',
    hardened: 'authoritative',
    lab: 'stale-price',
    modeHelp: {
      cart_quote: 'Charge whatever (possibly stale, cached) price the cart showed.',
      authoritative: 'Re-read the price from the source of truth; reject with PRICE_CHANGED if it moved.',
    },
  },
  'orders.readConsistency': {
    description: 'Where "My Orders" reads from.',
    modes: ['replica', 'read_your_writes'],
    naive: 'replica',
    hardened: 'read_your_writes',
    lab: 'replica-lag',
    modeHelp: {
      replica: 'Always read the (lagging) replica. Users don\'t see the order they just paid for and pay again.',
      read_your_writes: 'Route reads to primary for a user for a few seconds after they write.',
    },
  },
  'workers.poisonMessages': {
    description: 'How the fulfillment consumer handles messages it cannot process.',
    modes: ['retry_forever', 'dead_letter'],
    naive: 'retry_forever',
    hardened: 'dead_letter',
    lab: 'poison-pill',
    modeHelp: {
      retry_forever: 'Retry the failing message in place → head-of-line blocking, consumer lag grows without bound.',
      dead_letter: 'After 3 attempts move the message to a DLQ and continue.',
    },
  },
  'cart.pricing': {
    description: 'How the cart fetches prices.',
    modes: ['per_item_calls', 'batch_call'],
    naive: 'per_item_calls',
    hardened: 'batch_call',
    lab: 'n-plus-one',
    modeHelp: {
      per_item_calls: 'One HTTP call to catalog per cart line (fan-out amplification).',
      batch_call: 'One batch call per cart.',
    },
  },
} as const satisfies Record<string, FlagDef>;

export type FlagKey = keyof typeof FLAGS;
export type FlagMode<K extends FlagKey> = (typeof FLAGS)[K]['modes'][number];
export type Flags = { [K in FlagKey]: FlagMode<K> };

export function flagPreset(kind: 'naive' | 'hardened'): Flags {
  const out: Record<string, string> = {};
  for (const [k, def] of Object.entries(FLAGS)) out[k] = def[kind];
  return out as Flags;
}

/* ------------------------------------------------------------------ chaos */

export interface ServiceChaos {
  /** Added latency on a % of requests. */
  latencyMs: number;
  latencyJitterMs: number;
  latencyPct: number;
  /** % of requests answered with HTTP 500. */
  errorPct: number;
  /** % of requests that hang for hangMs before 504. */
  hangPct: number;
  hangMs: number;
  /** Synchronous CPU work per request (blocks the event loop). */
  cpuBurnMs: number;
  /** Retained memory growth (MB per minute) — container is memory-limited, so this ends in an OOM kill. */
  leakMbPerMin: number;
  /** Stop-the-world pause of gcPauseMs every gcPauseEverySec seconds. */
  gcPauseMs: number;
  gcPauseEverySec: number;
  /** Offset added to this service's wall clock. */
  clockSkewMs: number;
  /** % of DB queries preceded by pg_sleep(dbSlowMs) on the same connection. */
  dbSlowMs: number;
  dbSlowPct: number;
  /** Extra latency on every Redis command, or full Redis failure. */
  redisLatencyMs: number;
  redisDown: boolean;
}

export const SERVICE_CHAOS_DEFAULTS: ServiceChaos = {
  latencyMs: 0,
  latencyJitterMs: 0,
  latencyPct: 100,
  errorPct: 0,
  hangPct: 0,
  hangMs: 60_000,
  cpuBurnMs: 0,
  leakMbPerMin: 0,
  gcPauseMs: 0,
  gcPauseEverySec: 5,
  clockSkewMs: 0,
  dbSlowMs: 0,
  dbSlowPct: 0,
  redisLatencyMs: 0,
  redisDown: false,
};

export interface PaymentsChaos {
  /** Median / p99 PSP latency (log-normal). */
  medianMs: number;
  p99Ms: number;
  declinePct: number;
  /** % of charges that succeed at the PSP but whose response arrives after lateResponseMs. */
  lateResponsePct: number;
  lateResponseMs: number;
  /** PSP-side rate limit (0 = unlimited) → 429. */
  rateLimitPerSec: number;
  /** Full PSP outage → 503. */
  outage: boolean;
}

export const PAYMENTS_CHAOS_DEFAULTS: PaymentsChaos = {
  medianMs: 120,
  p99Ms: 600,
  declinePct: 3,
  lateResponsePct: 0,
  lateResponseMs: 15_000,
  rateLimitPerSec: 0,
  outage: false,
};

export interface DataChaos {
  /** Simulated replica lag for order history reads. */
  replicaLagMs: number;
  /** % of order events that fail to publish in dual_write mode. */
  eventPublishFailPct: number;
  /** % of order events published malformed (poison). */
  poisonPct: number;
  /** Fulfillment consumer paused. */
  consumerPaused: boolean;
  /** Extra processing time per fulfillment event. */
  consumerSlowMs: number;
}

export const DATA_CHAOS_DEFAULTS: DataChaos = {
  replicaLagMs: 0,
  eventPublishFailPct: 0,
  poisonPct: 0,
  consumerPaused: false,
  consumerSlowMs: 0,
};

export interface Chaos {
  services: Partial<Record<ServiceName, Partial<ServiceChaos>>>;
  payments: PaymentsChaos;
  data: DataChaos;
}

/* ------------------------------------------------------------------ tuning */

export interface Tuning {
  dbPoolSize: number;
  dbAcquireTimeoutMs: number;
  dbStatementTimeoutMs: number;
  upstreamTimeoutMs: number;
  upstreamConnections: number;
  paymentTimeoutMs: number;
  gatewayMaxInflight: number;
  rateLimitPerSec: number;
  rateLimitBurst: number;
  waitingRoomAdmitPerSec: number;
  cacheTtlSec: number;
  /** Artificial cost of rebuilding a product cache entry (pricing engine call, joins...). */
  cacheRebuildCostMs: number;
  reservationTtlSec: number;
  /** Delay between the read and the write in naive read-modify-write paths (app logic, fraud checks...). */
  raceWindowMs: number;
}

export const TUNING_DEFAULTS: Tuning = {
  dbPoolSize: 20,
  dbAcquireTimeoutMs: 3000,
  dbStatementTimeoutMs: 10_000,
  upstreamTimeoutMs: 5000,
  upstreamConnections: 128,
  paymentTimeoutMs: 4000,
  gatewayMaxInflight: 600,
  rateLimitPerSec: 10,
  rateLimitBurst: 20,
  waitingRoomAdmitPerSec: 40,
  cacheTtlSec: 30,
  cacheRebuildCostMs: 40,
  reservationTtlSec: 60,
  raceWindowMs: 8,
};

export const TUNING_HELP: Record<keyof Tuning, string> = {
  dbPoolSize: 'Max Postgres connections per service process.',
  dbAcquireTimeoutMs: 'How long a request waits for a free pool connection before failing.',
  dbStatementTimeoutMs: 'Postgres statement_timeout.',
  upstreamTimeoutMs: 'Default timeout for service-to-service calls.',
  upstreamConnections: 'Max sockets per upstream in each HTTP client pool.',
  paymentTimeoutMs: 'How long orders waits for the PSP.',
  gatewayMaxInflight: 'Concurrency limit used by load shedding.',
  rateLimitPerSec: 'Per-user sustained request rate.',
  rateLimitBurst: 'Per-user burst size.',
  waitingRoomAdmitPerSec: 'Users admitted from the waiting room per second.',
  cacheTtlSec: 'Base cache TTL.',
  cacheRebuildCostMs: 'Extra DB time to rebuild one product cache entry.',
  reservationTtlSec: 'Unpaid reservation lifetime (when expiry is enabled).',
  raceWindowMs: 'Gap between read and write in naive check-then-act code.',
};

export interface RuntimeState {
  version: number;
  updatedAt: string;
  flags: Flags;
  chaos: Chaos;
  tuning: Tuning;
}

export function defaultRuntimeState(): RuntimeState {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    flags: flagPreset('hardened'),
    chaos: {
      services: {},
      payments: { ...PAYMENTS_CHAOS_DEFAULTS },
      data: { ...DATA_CHAOS_DEFAULTS },
    },
    tuning: { ...TUNING_DEFAULTS },
  };
}

/* ------------------------------------------------------------------ keys */

export const KEYS = {
  runtime: 'bc:runtime',
  runtimeChannel: 'bc:runtime:changed',
  commandChannel: 'bc:cmd',
  eventsChannel: 'bc:events',
  eventsLog: 'bc:events:log',
  loadgenStatsChannel: 'bc:loadgen:stats',
  /** One message per sampled loadgen session as it ends (loadgen/journey.ts). */
  journeysChannel: 'bc:journeys',
  sale: 'bc:sale',
  hotSkus: 'bc:hot-skus',
  orderStream: 'bc:stream:orders',
  orderDlq: 'bc:stream:orders:dlq',
  invalidationChannel: 'bc:cache:invalidate',
} as const;

/** Hot flash-deal products are ids 1..12 (seeded in infra/postgres/init). */
export const HOT_PRODUCT_IDS = Array.from({ length: 12 }, (_, i) => i + 1);
export const COUPON_CODE = 'BIGSALE500';
