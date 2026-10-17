/**
 * Defensive normalisers for control-plane payloads. The war room must never crash on a
 * partial or slightly different payload (a service restarting mid-scrape, an older
 * control-plane build), so every field is coerced to the shape the UI expects.
 */
import type {
  Lab,
  LabDifficulty,
  ScenarioSummary,
  BreakerState,
  BreakerStats,
  BusinessStats,
  ControlDefs,
  EdgeStats,
  HotStockLevel,
  Integrity,
  IntegrityTotals,
  IntegrityViolations,
  Journey,
  JourneyResult,
  JourneyStep,
  LoadgenSessions,
  LoadgenStats,
  LoadgenStep,
  RouteStats,
  RuntimeState,
  ServiceHealth,
  ServiceStats,
  StoreStats,
  StreamStats,
  Summary,
  TimelineEvent,
  TimelineLevel,
} from '../api/types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const BUSINESS_KEYS: (keyof BusinessStats)[] = [
  'checkoutsPerMin',
  'paidPerMin',
  'gmvPerMinCents',
  'paymentSuccessPct',
  'waitingRoomLength',
  'consumerLag',
  'dlqDepth',
  'cacheHitPct',
  'rateLimitedPerSec',
  'shedPerSec',
  'botBlockedPerSec',
  'dbDeadlocksPerMin',
  'retriesPerSec',
  'outboxBacklog',
];

export const VIOLATION_KEYS: (keyof IntegrityViolations)[] = [
  'oversoldUnits',
  'negativeStockSkus',
  'duplicateOrders',
  'duplicateCharges',
  'orphanCharges',
  'couponOverRedemptions',
  'priceMismatches',
  'stuckOrders',
  'lostEvents',
  'phantomHeldUnits',
  'paidUncommitted',
];

const TOTAL_KEYS: (keyof IntegrityTotals)[] = [
  'orders',
  'paidOrders',
  'gmvCents',
  'charges',
  'shipments',
  'unitsSold',
  'dlqDepth',
];

function normRoute(v: unknown): RouteStats | null {
  if (!isObj(v) || v.route == null) return null;
  return {
    route: str(v.route),
    rps: num(v.rps),
    p95Ms: num(v.p95Ms),
    p99Ms: num(v.p99Ms),
    errorPct: num(v.errorPct),
  };
}

function normService(v: unknown): ServiceStats | null {
  if (!isObj(v) || v.service == null) return null;
  const pool = isObj(v.dbPool)
    ? {
        total: num(v.dbPool.total),
        idle: num(v.dbPool.idle),
        waiting: num(v.dbPool.waiting),
        ...(typeof v.dbPool.max === 'number' && v.dbPool.max > 0 ? { max: v.dbPool.max } : {}),
      }
    : null;
  return {
    service: str(v.service),
    up: Boolean(v.up),
    rps: num(v.rps),
    p99Ms: num(v.p99Ms),
    errorPct: num(v.errorPct),
    eventLoopLagMs: num(v.eventLoopLagMs),
    inflight: num(v.inflight),
    dbPool: pool,
    memMb: num(v.memMb),
    cpuPct: num(v.cpuPct),
    ...instancesOf(v),
  };
}

/** `instances` only when the control plane reports it (older builds don't). */
function instancesOf(v: Obj): { instances?: number } {
  return typeof v.instances === 'number' && Number.isFinite(v.instances) && v.instances >= 0
    ? { instances: Math.round(v.instances) }
    : {};
}

function normEdge(v: unknown): EdgeStats | null {
  if (!isObj(v) || v.from == null || v.to == null) return null;
  return { from: str(v.from), to: str(v.to), rps: num(v.rps), p99Ms: num(v.p99Ms), errorPct: num(v.errorPct) };
}

function normStore(v: unknown): StoreStats | null {
  if (!isObj(v) || v.service == null) return null;
  const store = str(v.store).toLowerCase();
  if (store !== 'postgres' && store !== 'redis') return null;
  return { service: str(v.service), store, opsPerSec: num(v.opsPerSec), p99Ms: num(v.p99Ms), errorPct: num(v.errorPct) };
}

function normStream(v: unknown): StreamStats | undefined {
  if (!isObj(v)) return undefined;
  return {
    producedPerSec: num(v.producedPerSec),
    consumedPerSec: num(v.consumedPerSec),
    lag: num(v.lag),
    dlq: num(v.dlq),
  };
}

function normHotStock(v: unknown): HotStockLevel | null {
  if (!isObj(v) || v.sku == null) return null;
  return { sku: str(v.sku), available: num(v.available) };
}

/** Topology fields stay absent (not empty) when an older control plane doesn't send them. */
function topologyOf(raw: Obj): Pick<Summary, 'edges' | 'stores' | 'stream' | 'hotStock'> {
  const out: Pick<Summary, 'edges' | 'stores' | 'stream' | 'hotStock'> = {};
  if (Array.isArray(raw.edges)) out.edges = raw.edges.map(normEdge).filter((e): e is EdgeStats => e !== null);
  if (Array.isArray(raw.stores)) out.stores = raw.stores.map(normStore).filter((s): s is StoreStats => s !== null);
  const stream = normStream(raw.stream);
  if (stream) out.stream = stream;
  if (Array.isArray(raw.hotStock)) {
    out.hotStock = raw.hotStock.map(normHotStock).filter((h): h is HotStockLevel => h !== null);
  }
  return out;
}

function normBreakerState(v: unknown): BreakerState {
  const s = str(v).toLowerCase().replace('-', '_');
  if (s === 'open' || s === '2') return 'open';
  if (s === 'half_open' || s === 'halfopen' || s === '1') return 'half_open';
  return 'closed';
}

function normBreaker(v: unknown): BreakerStats | null {
  if (!isObj(v)) return null;
  return { service: str(v.service, '?'), target: str(v.target, '?'), state: normBreakerState(v.state) };
}

export function normalizeSummary(raw: unknown): Summary | null {
  if (!isObj(raw)) return null;
  const g = isObj(raw.gateway) ? raw.gateway : {};
  const b = isObj(raw.business) ? raw.business : {};
  const business = {} as BusinessStats;
  for (const k of BUSINESS_KEYS) business[k] = num(b[k]);
  return {
    ts: num(raw.ts, Date.now()),
    gateway: {
      rps: num(g.rps),
      errorPct: num(g.errorPct),
      p50Ms: num(g.p50Ms),
      p95Ms: num(g.p95Ms),
      p99Ms: num(g.p99Ms),
      inflight: num(g.inflight),
    },
    routes: arr(raw.routes).map(normRoute).filter((r): r is RouteStats => r !== null),
    services: arr(raw.services).map(normService).filter((s): s is ServiceStats => s !== null),
    breakers: arr(raw.breakers).map(normBreaker).filter((x): x is BreakerStats => x !== null),
    business,
    sale: isObj(raw.sale)
      ? {
          name: str(raw.sale.name, 'Sale'),
          startsAt: str(raw.sale.startsAt),
          endsAt: str(raw.sale.endsAt),
          now: str(raw.sale.now),
          live: Boolean(raw.sale.live),
        }
      : null,
    ...topologyOf(raw),
  };
}

function normStep(v: unknown): LoadgenStep | null {
  if (!isObj(v) || v.step == null) return null;
  const codes: Record<string, number> = {};
  if (isObj(v.codes)) for (const [k, c] of Object.entries(v.codes)) codes[k] = num(c);
  return {
    step: str(v.step),
    rps: num(v.rps),
    p50Ms: num(v.p50Ms),
    p95Ms: num(v.p95Ms),
    p99Ms: num(v.p99Ms),
    errorPct: num(v.errorPct),
    codes,
  };
}

export const EMPTY_SESSIONS: LoadgenSessions = {
  started: 0,
  converted: 0,
  abandoned: 0,
  failed: 0,
  blocked: 0,
  soldOut: 0,
};

export function normalizeLoadgen(raw: unknown, prev?: LoadgenStats | null): LoadgenStats | null {
  if (!isObj(raw)) return null;
  const base = prev ?? null;
  const s = isObj(raw.sessions) ? raw.sessions : null;
  const anomalies: Record<string, number> = {};
  const rawAnom = isObj(raw.anomalies) ? raw.anomalies : base?.anomalies;
  if (rawAnom) for (const [k, c] of Object.entries(rawAnom)) anomalies[k] = num(c);
  const pick = <K extends keyof LoadgenStats>(k: K, f: (v: unknown) => LoadgenStats[K], d: LoadgenStats[K]) =>
    k in raw ? f(raw[k]) : base ? base[k] : d;
  return {
    running: pick('running', Boolean, false),
    scenarioId: pick('scenarioId', (v) => (v == null ? null : str(v)), null),
    scenarioName: pick('scenarioName', (v) => (v == null ? null : str(v)), null),
    elapsedSec: pick('elapsedSec', (v) => num(v), 0),
    durationSec: pick('durationSec', (v) => num(v), 0),
    phase: pick('phase', (v) => (v == null ? null : str(v)), null),
    multiplier: pick('multiplier', (v) => num(v, 1), 1),
    targetArrivalPerSec: pick('targetArrivalPerSec', (v) => num(v), 0),
    actualArrivalPerSec: pick('actualArrivalPerSec', (v) => num(v), 0),
    activeSessions: pick('activeSessions', (v) => num(v), 0),
    droppedArrivals: pick('droppedArrivals', (v) => num(v), 0),
    rps: pick('rps', (v) => num(v), 0),
    steps:
      'steps' in raw
        ? arr(raw.steps).map(normStep).filter((x): x is LoadgenStep => x !== null)
        : (base?.steps ?? []),
    sessions: s
      ? {
          started: num(s.started),
          converted: num(s.converted),
          abandoned: num(s.abandoned),
          failed: num(s.failed),
          blocked: num(s.blocked),
          soldOut: num(s.soldOut),
        }
      : (base?.sessions ?? EMPTY_SESSIONS),
    anomalies,
  };
}

export function normalizeIntegrity(raw: unknown): Integrity | null {
  if (!isObj(raw)) return null;
  const v = isObj(raw.violations) ? raw.violations : {};
  const t = isObj(raw.totals) ? raw.totals : {};
  const violations = {} as IntegrityViolations;
  for (const k of VIOLATION_KEYS) violations[k] = num(v[k]);
  const totals = {} as IntegrityTotals;
  for (const k of TOTAL_KEYS) totals[k] = num(t[k]);
  return {
    checkedAt: str(raw.checkedAt, new Date().toISOString()),
    violations,
    oversoldSkus: arr(raw.oversoldSkus)
      .filter(isObj)
      .map((o) => ({ sku: str(o.sku), name: str(o.name), total: num(o.total), claimed: num(o.claimed) })),
    totals,
  };
}

const LEVELS: TimelineLevel[] = ['info', 'warn', 'critical'];

function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function normalizeEvent(raw: unknown): TimelineEvent | null {
  if (!isObj(raw)) return null;
  const message = str(raw.message ?? raw.msg ?? raw.kind, '');
  if (!message) return null;
  let level = str(raw.level, 'info').toLowerCase();
  if (level === 'warning') level = 'warn';
  if (level === 'error' || level === 'crit') level = 'critical';
  const ts = typeof raw.ts === 'number' || typeof raw.ts === 'string' ? raw.ts : Date.now();
  const id =
    typeof raw.id === 'string' || typeof raw.id === 'number'
      ? raw.id
      : `${String(ts)}-${hashString(`${str(raw.kind)}|${message}`)}`;
  return {
    id,
    ts,
    level: (LEVELS as string[]).includes(level) ? (level as TimelineLevel) : 'info',
    source: str(raw.source, 'system'),
    kind: str(raw.kind, 'event'),
    message,
    data: raw.data,
  };
}

export function normalizeRuntime(raw: unknown): RuntimeState | null {
  if (!isObj(raw) || !isObj(raw.flags)) return null;
  const chaos = isObj(raw.chaos) ? raw.chaos : {};
  const flags: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.flags)) flags[k] = str(v);
  return {
    version: num(raw.version),
    updatedAt: str(raw.updatedAt),
    flags,
    chaos: {
      services: (isObj(chaos.services) ? chaos.services : {}) as RuntimeState['chaos']['services'],
      payments: (isObj(chaos.payments) ? chaos.payments : {}) as unknown as RuntimeState['chaos']['payments'],
      data: (isObj(chaos.data) ? chaos.data : {}) as unknown as RuntimeState['chaos']['data'],
    },
    tuning: (isObj(raw.tuning) ? raw.tuning : {}) as unknown as RuntimeState['tuning'],
  };
}

export function normalizeDefs(raw: unknown): ControlDefs | null {
  if (!isObj(raw) || !isObj(raw.flags)) return null;
  const flags: ControlDefs['flags'] = {};
  for (const [k, v] of Object.entries(raw.flags)) {
    if (!isObj(v)) continue;
    const modes = arr(v.modes).map((m) => str(m));
    const help: Record<string, string> = {};
    if (isObj(v.modeHelp)) for (const [m, h] of Object.entries(v.modeHelp)) help[m] = str(h);
    flags[k] = {
      description: str(v.description),
      modes,
      naive: str(v.naive, modes[0] ?? ''),
      hardened: str(v.hardened, modes[modes.length - 1] ?? ''),
      lab: str(v.lab),
      modeHelp: help,
    };
  }
  const obj = <T,>(v: unknown) => (isObj(v) ? v : {}) as unknown as T;
  const tuningHelp: Record<string, string> = {};
  if (isObj(raw.tuningHelp)) for (const [k, h] of Object.entries(raw.tuningHelp)) tuningHelp[k] = str(h);
  return {
    flags,
    serviceChaosDefaults: obj(raw.serviceChaosDefaults),
    paymentsChaosDefaults: obj(raw.paymentsChaosDefaults),
    dataChaosDefaults: obj(raw.dataChaosDefaults),
    tuningDefaults: obj(raw.tuningDefaults),
    tuningHelp,
    services: arr(raw.services).map((s) => str(s)),
  };
}

export function normalizeServices(raw: unknown): ServiceHealth[] {
  const items = isObj(raw) ? arr(raw.items) : arr(raw);
  return items.filter(isObj).map((o) => ({
    service: str(o.service, '?'),
    up: Boolean(o.up),
    latencyMs: num(o.latencyMs),
    startedAt: o.startedAt == null ? null : str(o.startedAt),
    restarts: num(o.restarts),
    ...instancesOf(o),
  }));
}

const JOURNEY_RESULTS: JourneyResult[] = ['converted', 'abandoned', 'failed', 'blocked', 'sold_out'];
const MAX_JOURNEY_STEPS = 40;

function normJourneyStep(v: unknown): JourneyStep | null {
  if (!isObj(v) || v.step == null) return null;
  return {
    step: str(v.step),
    atMs: Math.max(0, num(v.atMs)),
    ms: Math.max(0, num(v.ms)),
    status: Math.round(num(v.status)),
    code: v.code == null || v.code === '' ? null : str(v.code),
  };
}

export function normalizeJourney(raw: unknown): Journey | null {
  if (!isObj(raw) || raw.id == null || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .map(normJourneyStep)
    .filter((s): s is JourneyStep => s !== null)
    .slice(0, MAX_JOURNEY_STEPS);
  const result = str(raw.result) as JourneyResult;
  const product =
    isObj(raw.product) && raw.product.name != null
      ? { id: num(raw.product.id), name: str(raw.product.name) }
      : null;
  const spanMs = steps.reduce((m, s) => Math.max(m, s.atMs + s.ms), 0);
  const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    id: str(raw.id),
    persona: raw.persona === 'bot' ? 'bot' : 'shopper',
    startedAt: num(raw.startedAt, Date.now()),
    durationMs: Math.max(0, num(raw.durationMs, spanMs)),
    result: JOURNEY_RESULTS.includes(result) ? result : 'abandoned',
    steps,
    ...(raw.truncated === true ? { truncated: true } : {}),
    product,
    amountCents: optNum(raw.amountCents),
    queueWaitMs: optNum(raw.queueWaitMs),
  };
}

export function normalizeScenario(raw: unknown): ScenarioSummary | null {
  if (!isObj(raw) || raw.id == null) return null;
  return {
    id: str(raw.id),
    name: str(raw.name, str(raw.id)),
    description: str(raw.description),
    durationSec: num(raw.durationSec),
    saleStartsAtSec: raw.saleStartsAtSec == null ? null : num(raw.saleStartsAtSec),
    botShare: num(raw.botShare),
    phases: arr(raw.phases)
      .filter(isObj)
      .map((p) => ({
        name: str(p.name),
        durationSec: num(p.durationSec),
        fromRate: num(p.fromRate),
        toRate: num(p.toRate),
      })),
    timeline: arr(raw.timeline)
      .filter(isObj)
      .map((t) => ({ atSec: num(t.atSec), description: str(t.description) })),
  };
}

const DIFFICULTIES: LabDifficulty[] = ['beginner', 'intermediate', 'advanced'];

export function normalizeLab(raw: unknown): Lab | null {
  if (!isObj(raw) || raw.id == null) return null;
  const strings = (v: unknown) => arr(v).map((x) => str(x)).filter(Boolean);
  const difficulty = str(raw.difficulty, 'intermediate').toLowerCase() as LabDifficulty;
  return {
    id: str(raw.id),
    title: str(raw.title, str(raw.id)),
    category: str(raw.category, 'General'),
    difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : 'intermediate',
    summary: str(raw.summary),
    story: str(raw.story),
    symptoms: strings(raw.symptoms),
    watch: strings(raw.watch),
    rootCause: str(raw.rootCause),
    fix: str(raw.fix),
    realWorld: str(raw.realWorld),
    flags: strings(raw.flags),
    scenario: str(raw.scenario),
    steps: strings(raw.steps),
    brokenPatch: isObj(raw.brokenPatch) ? raw.brokenPatch : {},
    fixedPatch: isObj(raw.fixedPatch) ? raw.fixedPatch : {},
  };
}
