import { request } from 'undici';
import { config } from '../../shared/config';
import { SERVICES } from '../../shared/defs';

/**
 * War-room summary computed from Prometheus. One background loop runs ~40 instant
 * queries every 2s and caches the result, so any number of browser tabs cost nothing.
 */

export type Vector = { metric: Record<string, string>; value: [number, string] }[];

export async function promQuery(query: string): Promise<Vector> {
  const res = await request(`${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`, {
    headersTimeout: 3000,
    bodyTimeout: 3000,
  });
  const body = (await res.body.json()) as { status: string; data?: { result: Vector } };
  return body.data?.result ?? [];
}

export async function promRaw(path: 'query' | 'query_range', params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const res = await request(`${config.prometheusUrl}/api/v1/${path}?${qs}`, { headersTimeout: 5000, bodyTimeout: 5000 });
  return res.body.json();
}

/** Prometheus returns NaN for 0/0 quantiles and ratios: read anything non-finite as 0. */
const finite = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const num = (v: Vector, i = 0) => finite(v[i]?.value?.[1]);
const byLabel = (v: Vector, label: string) => {
  const out = new Map<string, number>();
  for (const s of v) out.set(s.metric[label] ?? '', finite(s.value[1]));
  return out;
};
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const W = '15s';
const REQ = 'http_server_request_duration_seconds';
const GW = `${REQ}_count{service="gateway",route!="unmatched"}`;
const CALL = 'http_client_request_duration_seconds';
const DB = 'db_query_duration_seconds';
const RCMD = 'redis_command_duration_seconds';

const Q = {
  gwRps: `sum(rate(${GW}[${W}]))`,
  gwErr: `100 * sum(rate(${REQ}_count{service="gateway",status=~"5.."}[${W}])) / clamp_min(sum(rate(${GW}[${W}])), 1e-9)`,
  gwP50: `histogram_quantile(0.5, sum by (le) (rate(${REQ}_bucket{service="gateway"}[${W}])))`,
  gwP95: `histogram_quantile(0.95, sum by (le) (rate(${REQ}_bucket{service="gateway"}[${W}])))`,
  gwP99: `histogram_quantile(0.99, sum by (le) (rate(${REQ}_bucket{service="gateway"}[${W}])))`,
  gwInflight: `sum(http_server_inflight_requests{service="gateway"})`,
  routeRps: `sum by (route) (rate(${GW}[${W}]))`,
  routeP95: `histogram_quantile(0.95, sum by (le, route) (rate(${REQ}_bucket{service="gateway"}[${W}])))`,
  routeP99: `histogram_quantile(0.99, sum by (le, route) (rate(${REQ}_bucket{service="gateway"}[${W}])))`,
  routeErr: `100 * sum by (route) (rate(${REQ}_count{service="gateway",status=~"5.."}[${W}])) / clamp_min(sum by (route) (rate(${GW}[${W}])), 1e-9)`,
  svcRps: `sum by (service) (rate(${REQ}_count[${W}]))`,
  svcP99: `histogram_quantile(0.99, sum by (le, service) (rate(${REQ}_bucket[${W}])))`,
  svcErr: `100 * sum by (service) (rate(${REQ}_count{status=~"5.."}[${W}])) / clamp_min(sum by (service) (rate(${REQ}_count[${W}])), 1e-9)`,
  svcLag: `max by (service) (nodejs_eventloop_lag_p99_seconds)`,
  svcInflight: `sum by (service) (http_server_inflight_requests)`,
  svcMem: `max by (service) (process_resident_memory_bytes)`,
  // Busiest replica, like lag and memory: a sum over 4 gateway replicas would read "100%" while each is at 30%.
  svcCpu: `100 * max by (service) (rate(process_cpu_seconds_total[${W}]))`,
  pool: `sum by (service, state) (db_pool_connections)`,
  breakers: `max by (service, target) (circuit_breaker_state)`,
  checkouts: `60 * sum(rate(orders_checkouts_total{result="created"}[30s]))`,
  paid: `60 * sum(rate(orders_payments_total{result="paid"}[30s]))`,
  gmv: `60 * sum(rate(orders_gmv_cents_total[30s]))`,
  payOk: `100 * sum(rate(orders_payments_total{result="paid"}[1m])) / clamp_min(sum(rate(orders_payments_total{result=~"paid|declined|timeout|pending|error|rate_limited|expired"}[1m])), 1e-9)`,
  waiting: `max(gateway_waiting_room_queue_length)`,
  lag: `sum(stream_consumer_lag) + sum(stream_pending_messages)`,
  dlq: `max(stream_dlq_length)`,
  cacheHit: `100 * sum(rate(cache_requests_total{result=~"hit|l1_hit|stale|coalesced"}[30s])) / clamp_min(sum(rate(cache_requests_total[30s])), 1e-9)`,
  limited: `sum(rate(gateway_ratelimit_decisions_total{decision=~"limited|error_rejected"}[${W}]))`,
  shed: `sum(rate(gateway_shed_total[${W}]))`,
  bots: `sum(rate(gateway_bot_blocked_total[${W}]))`,
  deadlocks: `sum(increase(db_errors_total{code="40P01"}[1m]))`,
  retries: `sum(rate(http_client_retries_total[${W}]))`,
  outbox: `max(outbox_unpublished)`,
  edgeRps: `sum by (service, target) (rate(${CALL}_count[${W}]))`,
  edgeP99: `histogram_quantile(0.99, sum by (le, service, target) (rate(${CALL}_bucket[${W}])))`,
  edgeErr: `100 * sum by (service, target) (rate(${CALL}_count{outcome!="ok"}[${W}])) / clamp_min(sum by (service, target) (rate(${CALL}_count[${W}])), 1e-9)`,
  pgOps: `sum by (service) (rate(${DB}_count[${W}]))`,
  pgP99: `histogram_quantile(0.99, sum by (le, service) (rate(${DB}_bucket[${W}])))`,
  pgErr: `100 * sum by (service) (rate(${DB}_count{outcome="error"}[${W}])) / clamp_min(sum by (service) (rate(${DB}_count[${W}])), 1e-9)`,
  redisOps: `sum by (service) (rate(${RCMD}_count[${W}]))`,
  redisP99: `histogram_quantile(0.99, sum by (le, service) (rate(${RCMD}_bucket[${W}])))`,
  redisErr: `100 * sum by (service) (rate(${RCMD}_count{outcome="error"}[${W}])) / clamp_min(sum by (service) (rate(${RCMD}_count[${W}])), 1e-9)`,
  // `or vector(0)`: a side with no series yet (dual_write never used since boot) would empty the whole sum.
  produced: `(sum(rate(orders_events_published_total{result="ok",mode="dual_write"}[${W}])) or vector(0)) + (sum(rate(outbox_relayed_total[${W}])) or vector(0))`,
  consumed: `sum(rate(stream_processed_total{result="ok"}[${W}]))`,
  hotStock: `max by (sku) (inventory_available_units)`,
} as const;

type Results = { [K in keyof typeof Q]: Vector };

export interface ServiceHealth {
  service: string;
  up: boolean;
  latencyMs: number;
  /** Running replicas (absent → 1). */
  instances?: number;
}

/* ------------------------------------------------------------------ topology (pure, unit-tested) */

/** Below this a series is a probe or a straggler, not a dependency worth drawing. */
export const MIN_RATE = 0.05;

/** Per label set: a rate (/s), a p99 (seconds) and an error %, as three instant vectors. */
export interface RateVectors {
  rate: Vector;
  p99: Vector;
  err: Vector;
}

export interface Edge {
  from: string;
  to: string;
  rps: number;
  p99Ms: number;
  errorPct: number;
}

export interface StoreLoad {
  service: string;
  store: 'postgres' | 'redis';
  opsPerSec: number;
  p99Ms: number;
  errorPct: number;
}

/** Joins the three vectors on `labels`: missing p99 / error series read as 0, rates under MIN_RATE are dropped. */
function joinRates(v: RateVectors, labels: readonly string[]) {
  const key = (m: Record<string, string>) => labels.map((l) => m[l] ?? '').join('\u0000');
  const index = (x: Vector) => new Map(x.map((s) => [key(s.metric), finite(s.value[1])]));
  const p99 = index(v.p99);
  const err = index(v.err);
  return v.rate
    .map((s) => ({ labels: s.metric, rate: finite(s.value[1]), p99Ms: (p99.get(key(s.metric)) ?? 0) * 1000, errorPct: err.get(key(s.metric)) ?? 0 }))
    .filter((x) => x.rate >= MIN_RATE && labels.every((l) => x.labels[l]));
}

/**
 * Service-to-service calls (caller `service` → callee `target`), led by the synthetic
 * customers → gateway edge built from the gateway's own server metrics.
 */
export function toEdges(calls: RateVectors, gateway: { rps: number; p99Ms: number; errorPct: number }): Edge[] {
  const edges = joinRates(calls, ['service', 'target'])
    .map((x) => ({ from: x.labels.service, to: x.labels.target, rps: x.rate, p99Ms: x.p99Ms, errorPct: x.errorPct }))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  const front: Edge = { from: 'customers', to: 'gateway', rps: finite(gateway.rps), p99Ms: finite(gateway.p99Ms), errorPct: finite(gateway.errorPct) };
  return front.rps >= MIN_RATE ? [front, ...edges] : edges;
}

/** Postgres and Redis load per service. The control plane's own bookkeeping queries are not traffic. */
export function toStores(pg: RateVectors, redis: RateVectors): StoreLoad[] {
  const rows = (store: StoreLoad['store'], v: RateVectors): StoreLoad[] =>
    joinRates(v, ['service'])
      .filter((x) => x.labels.service !== 'control-plane')
      .map((x) => ({ service: x.labels.service, store, opsPerSec: x.rate, p99Ms: x.p99Ms, errorPct: x.errorPct }))
      .sort((a, b) => cmp(a.service, b.service));
  return [...rows('postgres', pg), ...rows('redis', redis)];
}

export function toHotStock(v: Vector): { sku: string; available: number }[] {
  return v
    .filter((s) => s.metric.sku)
    .map((s) => ({ sku: s.metric.sku, available: finite(s.value[1]) }))
    .sort((a, b) => cmp(a.sku, b.sku));
}

/* ------------------------------------------------------------------ summary */

export async function buildSummary(health: Map<string, ServiceHealth>, sale: unknown) {
  const entries = Object.entries(Q) as [keyof typeof Q, string][];
  const vectors = await Promise.all(entries.map(([, q]) => promQuery(q).catch(() => [] as Vector)));
  const r = Object.fromEntries(entries.map(([k], i) => [k, vectors[i]])) as Results;

  const routeRps = byLabel(r.routeRps, 'route');
  const routeP95 = byLabel(r.routeP95, 'route');
  const routeP99 = byLabel(r.routeP99, 'route');
  const routeErr = byLabel(r.routeErr, 'route');
  const routes = [...new Set([...routeRps.keys(), ...routeP99.keys()])]
    .filter((x) => x && x !== '/health' && x !== '/ready' && x !== '/metrics')
    .map((route) => ({
      route,
      rps: routeRps.get(route) ?? 0,
      p95Ms: (routeP95.get(route) ?? 0) * 1000,
      p99Ms: (routeP99.get(route) ?? 0) * 1000,
      errorPct: routeErr.get(route) ?? 0,
    }))
    .sort((a, b) => b.rps - a.rps);

  const svcRps = byLabel(r.svcRps, 'service');
  const svcP99 = byLabel(r.svcP99, 'service');
  const svcErr = byLabel(r.svcErr, 'service');
  const svcLag = byLabel(r.svcLag, 'service');
  const svcInflight = byLabel(r.svcInflight, 'service');
  const svcMem = byLabel(r.svcMem, 'service');
  const svcCpu = byLabel(r.svcCpu, 'service');
  const pools = new Map<string, { total: number; idle: number; waiting: number; max: number }>();
  for (const s of r.pool) {
    const svc = s.metric.service;
    const p = pools.get(svc) ?? { total: 0, idle: 0, waiting: 0, max: 0 };
    const state = s.metric.state as 'total' | 'idle' | 'waiting' | 'max';
    if (state in p) p[state] = Number(s.value[1]) || 0;
    pools.set(svc, p);
  }

  const services = SERVICES.map((service) => ({
    service,
    up: health.get(service)?.up ?? false,
    rps: svcRps.get(service) ?? 0,
    p99Ms: (svcP99.get(service) ?? 0) * 1000,
    errorPct: svcErr.get(service) ?? 0,
    eventLoopLagMs: (svcLag.get(service) ?? 0) * 1000,
    inflight: svcInflight.get(service) ?? 0,
    dbPool: pools.get(service) ?? null,
    memMb: (svcMem.get(service) ?? 0) / 1024 / 1024,
    cpuPct: svcCpu.get(service) ?? 0,
    instances: health.get(service)?.instances ?? 1,
  }));

  const STATE = ['closed', 'half_open', 'open'] as const;
  const breakers = r.breakers.map((s) => ({
    service: s.metric.service,
    target: s.metric.target,
    state: STATE[Math.round(Number(s.value[1]))] ?? 'closed',
  }));

  const gateway = {
    rps: num(r.gwRps),
    errorPct: num(r.gwErr),
    p50Ms: num(r.gwP50) * 1000,
    p95Ms: num(r.gwP95) * 1000,
    p99Ms: num(r.gwP99) * 1000,
    inflight: num(r.gwInflight),
  };

  return {
    ts: Date.now(),
    gateway,
    routes,
    services,
    breakers,
    edges: toEdges({ rate: r.edgeRps, p99: r.edgeP99, err: r.edgeErr }, gateway),
    stores: toStores({ rate: r.pgOps, p99: r.pgP99, err: r.pgErr }, { rate: r.redisOps, p99: r.redisP99, err: r.redisErr }),
    stream: {
      producedPerSec: num(r.produced),
      consumedPerSec: num(r.consumed),
      lag: num(r.lag),
      dlq: num(r.dlq),
    },
    hotStock: toHotStock(r.hotStock),
    business: {
      checkoutsPerMin: num(r.checkouts),
      paidPerMin: num(r.paid),
      gmvPerMinCents: num(r.gmv),
      paymentSuccessPct: num(r.payOk),
      waitingRoomLength: num(r.waiting),
      consumerLag: num(r.lag),
      dlqDepth: num(r.dlq),
      cacheHitPct: num(r.cacheHit),
      rateLimitedPerSec: num(r.limited),
      shedPerSec: num(r.shed),
      botBlockedPerSec: num(r.bots),
      dbDeadlocksPerMin: num(r.deadlocks),
      retriesPerSec: num(r.retries),
      outboxBacklog: num(r.outbox),
    },
    sale,
  };
}
