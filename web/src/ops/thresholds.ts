import type { RuntimeState, Summary } from '../api/types';
import { formatINRCompact, formatInt, formatMs, formatNum, formatPct } from '../lib/format';

export type Level = 'none' | 'ok' | 'warn' | 'serious' | 'crit';

export const LEVEL_META: Record<Exclude<Level, 'none'>, { icon: string; label: string }> = {
  ok: { icon: '●', label: 'OK' },
  warn: { icon: '▲', label: 'Warn' },
  serious: { icon: '◆', label: 'High' },
  crit: { icon: '■', label: 'Critical' },
};

/** Higher-is-worse threshold helper: [warn, serious?, crit]. */
export function above(v: number, warn: number, crit: number, serious?: number): Level {
  if (v >= crit) return 'crit';
  if (serious != null && v >= serious) return 'serious';
  if (v >= warn) return 'warn';
  return 'ok';
}

/** Lower-is-worse threshold helper. */
export function below(v: number, warn: number, crit: number): Level {
  if (v <= crit) return 'crit';
  if (v <= warn) return 'warn';
  return 'ok';
}

export interface KpiDef {
  id: string;
  label: string;
  hint: string;
  get: (s: Summary) => number;
  format: (v: number) => string;
  level?: (v: number, s: Summary, rt: RuntimeState | null) => Level;
}

const hasTraffic = (s: Summary) => s.gateway.rps >= 0.5;

export const KPIS: KpiDef[] = [
  {
    id: 'rps',
    label: 'Gateway RPS',
    hint: 'Requests per second through the edge gateway.',
    get: (s) => s.gateway.rps,
    format: formatNum,
  },
  {
    id: 'errorPct',
    label: 'Error rate',
    hint: 'Share of gateway responses that were errors.',
    get: (s) => s.gateway.errorPct,
    format: formatPct,
    level: (v, s) => (hasTraffic(s) ? above(v, 1, 10, 5) : 'none'),
  },
  {
    id: 'p50',
    label: 'p50 latency',
    hint: 'Median gateway response time.',
    get: (s) => s.gateway.p50Ms,
    format: formatMs,
    level: (v, s) => (hasTraffic(s) ? above(v, 250, 1000, 500) : 'none'),
  },
  {
    id: 'p95',
    label: 'p95 latency',
    hint: '95th percentile gateway response time.',
    get: (s) => s.gateway.p95Ms,
    format: formatMs,
    level: (v, s) => (hasTraffic(s) ? above(v, 750, 3000, 1500) : 'none'),
  },
  {
    id: 'p99',
    label: 'p99 latency',
    hint: '99th percentile gateway response time — the slowest 1% of customers.',
    get: (s) => s.gateway.p99Ms,
    format: formatMs,
    level: (v, s) => (hasTraffic(s) ? above(v, 1000, 5000, 2500) : 'none'),
  },
  {
    id: 'inflight',
    label: 'In-flight',
    hint: 'Requests currently being processed by the gateway (vs gatewayMaxInflight).',
    get: (s) => s.gateway.inflight,
    format: formatInt,
    level: (v, _s, rt) => {
      const max = rt?.tuning?.gatewayMaxInflight;
      return typeof max === 'number' && max > 0 ? above(v / max, 0.6, 0.95, 0.8) : 'none';
    },
  },
  {
    id: 'checkouts',
    label: 'Checkouts / min',
    hint: 'Orders created per minute.',
    get: (s) => s.business.checkoutsPerMin,
    format: formatNum,
  },
  {
    id: 'paid',
    label: 'Paid / min',
    hint: 'Orders paid per minute.',
    get: (s) => s.business.paidPerMin,
    format: formatNum,
  },
  {
    id: 'gmv',
    label: 'GMV / min',
    hint: 'Gross merchandise value of paid orders per minute.',
    get: (s) => s.business.gmvPerMinCents,
    format: formatINRCompact,
  },
  {
    id: 'paySuccess',
    label: 'Payment success',
    hint: 'Share of payment attempts that succeeded.',
    get: (s) => s.business.paymentSuccessPct,
    format: formatPct,
    level: (v, s) => (s.business.checkoutsPerMin > 0 || s.business.paidPerMin > 0 ? below(v, 95, 80) : 'none'),
  },
  {
    id: 'cacheHit',
    label: 'Cache hit',
    hint: 'Share of catalog reads served from cache.',
    get: (s) => s.business.cacheHitPct,
    format: formatPct,
    level: (v, s) => (hasTraffic(s) ? below(v, 80, 40) : 'none'),
  },
  {
    id: 'waitingRoom',
    label: 'Waiting room',
    hint: 'Shoppers queued in the virtual waiting room.',
    get: (s) => s.business.waitingRoomLength,
    format: formatInt,
  },
  {
    id: 'consumerLag',
    label: 'Consumer lag',
    hint: 'Order events not yet processed by fulfillment.',
    get: (s) => s.business.consumerLag,
    format: formatInt,
    level: (v) => above(v, 100, 2000, 500),
  },
  {
    id: 'dlq',
    label: 'DLQ depth',
    hint: 'Messages parked in the dead-letter queue.',
    get: (s) => s.business.dlqDepth,
    format: formatInt,
    level: (v) => above(v, 1, 100),
  },
  {
    id: 'rateLimited',
    label: 'Rate-limited / s',
    hint: 'Requests rejected with 429 by the edge rate limiter.',
    get: (s) => s.business.rateLimitedPerSec,
    format: formatNum,
    level: (v) => above(v, 1, 50, 10),
  },
  {
    id: 'shed',
    label: 'Shed / s',
    hint: 'Requests rejected by load shedding (503 OVERLOADED).',
    get: (s) => s.business.shedPerSec,
    format: formatNum,
    level: (v) => above(v, 0.1, 25, 5),
  },
  {
    id: 'bots',
    label: 'Bots blocked / s',
    hint: 'Requests blocked by bot protection.',
    get: (s) => s.business.botBlockedPerSec,
    format: formatNum,
  },
  {
    id: 'deadlocks',
    label: 'Deadlocks / min',
    hint: 'Postgres deadlocks detected per minute.',
    get: (s) => s.business.dbDeadlocksPerMin,
    format: formatNum,
    level: (v) => above(v, 0.1, 5, 1),
  },
  {
    id: 'retries',
    label: 'Retries / s',
    hint: 'Service-to-service retries per second.',
    get: (s) => s.business.retriesPerSec,
    format: formatNum,
    level: (v) => above(v, 5, 100, 25),
  },
  {
    id: 'outbox',
    label: 'Outbox backlog',
    hint: 'Order events written to the outbox but not yet relayed.',
    get: (s) => s.business.outboxBacklog,
    format: formatInt,
    level: (v) => above(v, 50, 1000, 250),
  },
];

/** Service-card thresholds. */
export const serviceLevels = {
  errorPct: (v: number) => above(v, 1, 10, 5),
  p99Ms: (v: number) => above(v, 1000, 5000, 2500),
  loopLagMs: (v: number) => above(v, 50, 500, 200),
  cpuPct: (v: number) => above(v, 70, 95, 85),
};
