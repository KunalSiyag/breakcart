import { humanizeKey } from '../lib/format';

/**
 * Presentation hints for chaos fields. The set of fields itself comes from
 * GET /control/state → defs.*ChaosDefaults; anything not listed here still renders,
 * with ranges inferred from its name suffix and default value.
 */
export interface NumberFieldMeta {
  min: number;
  max: number;
  step: number;
  help?: string;
}

const KNOWN: Record<string, NumberFieldMeta> = {
  latencyMs: { min: 0, max: 10_000, step: 50, help: 'Added latency on a share of requests.' },
  latencyJitterMs: { min: 0, max: 5000, step: 50, help: 'Random extra latency on top of latencyMs.' },
  latencyPct: { min: 0, max: 100, step: 1, help: 'Share of requests that get the added latency.' },
  errorPct: { min: 0, max: 100, step: 1, help: 'Share of requests answered with HTTP 500.' },
  hangPct: { min: 0, max: 100, step: 1, help: 'Share of requests that hang for hangMs, then 504.' },
  hangMs: { min: 0, max: 120_000, step: 1000, help: 'How long a hanging request hangs.' },
  cpuBurnMs: { min: 0, max: 500, step: 5, help: 'Synchronous CPU work per request — blocks the event loop.' },
  leakMbPerMin: {
    min: 0,
    max: 200,
    step: 5,
    help: 'Retained memory growth. The container is memory-limited, so this ends in an OOM kill.',
  },
  gcPauseMs: { min: 0, max: 5000, step: 50, help: 'Stop-the-world pause every gcPauseEverySec seconds.' },
  gcPauseEverySec: { min: 1, max: 60, step: 1, help: 'Interval between simulated GC pauses.' },
  clockSkewMs: { min: -300_000, max: 300_000, step: 1000, help: "Offset added to this service's wall clock." },
  dbSlowMs: { min: 0, max: 10_000, step: 50, help: 'pg_sleep before a share of DB queries, on the same connection.' },
  dbSlowPct: { min: 0, max: 100, step: 1, help: 'Share of DB queries that get the pg_sleep.' },
  redisLatencyMs: { min: 0, max: 2000, step: 10, help: 'Extra latency on every Redis command.' },
  medianMs: { min: 0, max: 5000, step: 10, help: 'Median PSP latency (log-normal).' },
  p99Ms: { min: 0, max: 30_000, step: 100, help: 'p99 PSP latency (log-normal tail).' },
  declinePct: { min: 0, max: 100, step: 1, help: 'Share of charges the bank declines.' },
  lateResponsePct: {
    min: 0,
    max: 100,
    step: 1,
    help: 'Charges that succeed at the PSP but whose response arrives after lateResponseMs.',
  },
  lateResponseMs: { min: 0, max: 60_000, step: 500, help: 'Delay of the late PSP responses.' },
  rateLimitPerSec: { min: 0, max: 1000, step: 5, help: 'PSP-side rate limit (0 = unlimited) → 429.' },
  replicaLagMs: { min: 0, max: 30_000, step: 250, help: 'Simulated replica lag for order-history reads.' },
  eventPublishFailPct: { min: 0, max: 100, step: 1, help: 'Order events that fail to publish in dual_write mode.' },
  poisonPct: { min: 0, max: 100, step: 1, help: 'Order events published malformed (poison pills).' },
  consumerSlowMs: { min: 0, max: 5000, step: 10, help: 'Extra processing time per fulfillment event.' },
};

const BOOL_HELP: Record<string, string> = {
  redisDown: 'Full Redis failure for this service.',
  outage: 'Full PSP outage → 503 on every charge.',
  consumerPaused: 'Pause the fulfillment stream consumer.',
};

export function numberMeta(key: string, defaultValue: number): NumberFieldMeta {
  const known = KNOWN[key];
  if (known) return known;
  const d = Math.abs(defaultValue);
  if (/Pct$/.test(key)) return { min: 0, max: 100, step: 1 };
  if (/Ms$/.test(key)) return { min: 0, max: Math.max(10_000, d * 4), step: d >= 1000 ? 100 : 10 };
  return { min: 0, max: Math.max(100, d * 4), step: 1 };
}

export function boolHelp(key: string): string | undefined {
  return BOOL_HELP[key];
}

export function fieldLabel(key: string): { label: string; unit: string | null } {
  return humanizeKey(key);
}

/** Services whose chaos knobs are meaningful (the control plane and load generator are excluded). */
export function chaosServices(services: readonly string[]): string[] {
  return services.filter((s) => s !== 'control-plane' && s !== 'loadgen');
}
