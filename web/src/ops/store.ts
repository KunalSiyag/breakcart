import { useEffect, useSyncExternalStore } from 'react';
import { controlApi } from '../api/control';
import { asArray, isAbortError, toApiError } from '../api/http';
import type {
  ActionResponse,
  ChaosPatch,
  ControlAction,
  ControlDefs,
  Integrity,
  IntegrityViolations,
  Journey,
  LabVariant,
  LoadgenSessions,
  LoadgenStats,
  PresetId,
  PromQueryRangeResponse,
  RuntimeState,
  ScenarioSummary,
  ServiceHealth,
  Summary,
  TimelineEvent,
} from '../api/types';
import { toMillis } from '../lib/format';
import {
  normalizeDefs,
  normalizeScenario,
  normalizeEvent,
  normalizeIntegrity,
  normalizeJourney,
  normalizeLoadgen,
  normalizeRuntime,
  normalizeServices,
  normalizeSummary,
} from './normalize';

/**
 * The war room's data layer. One instance per tab, started while any ops page is
 * mounted (ref-counted) so the war room and the labs pages share the same rolling
 * 10-minute buffers and the same SSE connection.
 *
 *   polling   GET /control/summary every 2s (KPIs, charts, services)
 *             GET /control/services every 5s, GET /control/state as a safety resync
 *   SSE       /control/events: timeline · loadgen (1/s) · runtime · integrity (5s) · journey (~4/s)
 *   fallback  while SSE is down, poll /control/loadgen and /control/integrity instead
 *   backfill  on first load, /control/prom/query_range fills the gateway charts and
 *             /control/journeys/recent the shopper feed (SSE only streams new journeys)
 */

export const WINDOW_MS = 10 * 60_000;
const MAX_TIMELINE = 400;
const ROUTE_SPARK = 30;
/** Newest sampled shopper journeys kept for Mission Control. */
export const MAX_JOURNEYS = 60;
/** Receive times kept for the "journeys / min" readout. */
export const JOURNEY_RATE_WINDOW_MS = 60_000;

export type SseStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

export interface GatewayPoint {
  t: number;
  rps: number | null;
  errorPct: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface SummaryPoint {
  t: number;
  summary: Summary;
}

export interface SessionRates {
  converted: number;
  abandoned: number;
  failed: number;
  blocked: number;
  soldOut: number;
}

export interface LoadPoint {
  t: number;
  running: boolean;
  target: number;
  actual: number;
  rps: number;
  active: number;
  cum: LoadgenSessions;
  rates: SessionRates | null;
  /** p95 latency by funnel step. */
  steps: Record<string, number>;
}

export interface IntegrityPoint {
  t: number;
  v: IntegrityViolations;
}

export interface OpsState {
  reachable: boolean | null;
  lastError: string | null;
  lastOkAt: number | null;
  sse: SseStatus;
  sseSince: number | null;
  defs: ControlDefs | null;
  runtime: RuntimeState | null;
  summary: Summary | null;
  summaryAt: number | null;
  history: SummaryPoint[];
  backfill: GatewayPoint[];
  routeHistory: Record<string, number[]>;
  loadgen: LoadgenStats | null;
  loadgenAt: number | null;
  loadHistory: LoadPoint[];
  stepOrder: string[];
  integrity: Integrity | null;
  integrityAt: number | null;
  integrityHistory: IntegrityPoint[];
  timeline: TimelineEvent[];
  services: ServiceHealth[] | null;
  scenarios: ScenarioSummary[] | null;
  /** Sampled shopper journeys of the current (or last) run, newest first. */
  journeys: Journey[];
  /** null until known; false when the control plane has no /control/journeys/recent (older build). */
  journeysSupported: boolean | null;
  /** When SSE journeys arrived, last minute only. */
  journeyArrivals: number[];
}

function initialState(): OpsState {
  return {
    reachable: null,
    lastError: null,
    lastOkAt: null,
    sse: 'idle',
    sseSince: null,
    defs: null,
    runtime: null,
    summary: null,
    summaryAt: null,
    history: [],
    backfill: [],
    routeHistory: {},
    loadgen: null,
    loadgenAt: null,
    loadHistory: [],
    stepOrder: [],
    integrity: null,
    integrityAt: null,
    integrityHistory: [],
    timeline: [],
    services: null,
    scenarios: null,
    journeys: [],
    journeysSupported: null,
    journeyArrivals: [],
  };
}

function eventKey(e: TimelineEvent): string {
  return String(e.id);
}

function mergeEvents(current: TimelineEvent[], incoming: TimelineEvent[]): TimelineEvent[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map(eventKey));
  const fresh = incoming.filter((e) => !seen.has(eventKey(e)));
  if (!fresh.length) return current;
  return [...fresh, ...current]
    .sort((a, b) => (toMillis(b.ts) ?? 0) - (toMillis(a.ts) ?? 0))
    .slice(0, MAX_TIMELINE);
}

const journeyEnd = (j: Journey) => j.startedAt + j.durationMs;

function mergeJourneys(current: Journey[], incoming: Journey[]): Journey[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map((j) => j.id));
  const fresh = incoming.filter((j) => !seen.has(j.id));
  if (!fresh.length) return current;
  return [...fresh, ...current].sort((a, b) => journeyEnd(b) - journeyEnd(a)).slice(0, MAX_JOURNEYS);
}

function parseSse(ev: Event): unknown {
  try {
    return JSON.parse((ev as MessageEvent<string>).data) as unknown;
  } catch {
    return null;
  }
}

/**
 * Each query_range call may be evaluated on a slightly different time grid (start is
 * "now - minutes" per request), so snap timestamps to the step to line the series up.
 */
function promSeries(resp: PromQueryRangeResponse | null, stepSec: number): [number, number | null][] {
  const first = resp?.status === 'success' ? resp.data?.result?.[0] : undefined;
  if (!first || !Array.isArray(first.values)) return [];
  return first.values.map(([ts, v]) => {
    const n = Number(v);
    return [Math.round(Number(ts) / stepSec) * stepSec * 1000, Number.isFinite(n) ? n : null];
  });
}

class OpsStore {
  private state: OpsState = initialState();
  private listeners = new Set<() => void>();
  private refs = 0;
  private running = false;
  private stopTimer: number | undefined;
  private timers = new Set<number>();
  private ctrl = new AbortController();
  private es: EventSource | null = null;
  private sseAttempts = 0;
  private sseRetryTimer: number | undefined;
  private backfilled = false;
  private runtimeAppliedAt = 0;
  private journeysFetchedAt = 0;

  getState = (): OpsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<OpsState> | ((s: OpsState) => Partial<OpsState>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  /** Start polling/SSE while at least one ops page is mounted. */
  retain(): () => void {
    this.refs += 1;
    window.clearTimeout(this.stopTimer);
    if (!this.running) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs <= 0) {
        window.clearTimeout(this.stopTimer);
        this.stopTimer = window.setTimeout(() => {
          if (this.refs <= 0) this.stop();
        }, 3000);
      }
    };
  }

  private start() {
    this.running = true;
    this.ctrl = new AbortController();
    this.loop(() => this.fetchSummary(), () => 2000);
    this.loop(() => this.fetchState(), () => (this.state.sse === 'open' ? 30_000 : 5000));
    this.loop(() => this.fetchServices(), () => 5000);
    this.loop(() => this.fallbackPoll(), () => (this.state.sse === 'open' ? 20_000 : 2000));
    this.loop(() => this.fetchScenarios(), () => (this.state.scenarios ? 120_000 : 5000));
    void this.fetchJourneys();
    this.connectSse();
  }

  private stop() {
    this.running = false;
    this.ctrl.abort();
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    window.clearTimeout(this.sseRetryTimer);
    this.es?.close();
    this.es = null;
    this.sseAttempts = 0;
    this.set({ sse: 'idle' });
  }

  /** Poll `task` forever (until stop), backing off exponentially while it fails. */
  private loop(task: () => Promise<void>, interval: () => number) {
    let failures = 0;
    const schedule = (ms: number) => {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        void tick();
      }, ms);
      this.timers.add(id);
    };
    const tick = async () => {
      if (!this.running) return;
      try {
        await task();
        failures = 0;
      } catch (e) {
        if (!this.running || isAbortError(e)) return;
        failures += 1;
      }
      if (!this.running) return;
      const base = interval();
      schedule(failures ? Math.min(30_000, base * 2 ** Math.min(failures, 4)) : base);
    };
    void tick();
  }

  private markOk() {
    if (this.state.reachable !== true || this.state.lastError !== null) {
      this.set({ reachable: true, lastError: null, lastOkAt: Date.now() });
    }
  }

  private markFailed(e: unknown) {
    const err = toApiError(e);
    if (err.code === 'ABORTED') return;
    this.set({ reachable: false, lastError: `${err.code}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}` });
  }

  /* ------------------------------------------------------------------ fetchers */

  private async fetchSummary() {
    try {
      const raw = await controlApi.summary(this.ctrl.signal);
      const summary = normalizeSummary(raw);
      if (!summary) throw new Error('Malformed /control/summary payload');
      const t = Date.now();
      this.set((st) => {
        const cutoff = t - WINDOW_MS;
        const routeHistory: Record<string, number[]> = {};
        for (const r of summary.routes) {
          const prev = st.routeHistory[r.route] ?? [];
          routeHistory[r.route] = [...prev, r.p99Ms].slice(-ROUTE_SPARK);
        }
        return {
          summary,
          summaryAt: t,
          history: [...st.history.filter((p) => p.t >= cutoff), { t, summary }],
          backfill: st.backfill.length ? st.backfill.filter((p) => p.t >= cutoff) : st.backfill,
          routeHistory,
          reachable: true,
          lastError: null,
          lastOkAt: t,
        };
      });
      if (!this.backfilled) {
        this.backfilled = true;
        void this.backfill();
      }
    } catch (e) {
      this.markFailed(e);
      throw e;
    }
  }

  private async fetchState() {
    try {
      const raw = await controlApi.state(this.ctrl.signal);
      const defs = normalizeDefs(raw?.defs);
      const runtime = normalizeRuntime(raw?.runtime);
      this.set({ ...(defs ? { defs } : {}) });
      if (runtime) this.applyRuntime(runtime, true);
      this.markOk();
    } catch (e) {
      this.markFailed(e);
      throw e;
    }
  }

  private async fetchServices() {
    const raw = await controlApi.services(this.ctrl.signal);
    this.set({ services: normalizeServices(raw) });
  }

  private async fetchScenarios() {
    const list = await controlApi.scenarios(this.ctrl.signal);
    this.set({ scenarios: list.map(normalizeScenario).filter((x): x is ScenarioSummary => x !== null) });
  }

  private async fetchRecent() {
    try {
      const raw = await controlApi.recentEvents(this.ctrl.signal);
      const items = asArray<unknown>(raw)
        .map(normalizeEvent)
        .filter((e): e is TimelineEvent => e !== null);
      this.set((st) => ({ timeline: mergeEvents(st.timeline, items) }));
    } catch {
      /* the timeline will fill from SSE */
    }
  }

  /** One-shot backfill of the shopper feed; new journeys then arrive over SSE. */
  private async fetchJourneys() {
    this.journeysFetchedAt = Date.now();
    try {
      const raw = await controlApi.recentJourneys(this.ctrl.signal);
      const items = asArray<unknown>(raw)
        .map(normalizeJourney)
        .filter((j): j is Journey => j !== null);
      this.set((st) => ({ journeys: mergeJourneys(st.journeys, items), journeysSupported: true }));
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'ABORTED') return;
      // 404 = a control plane from before journeys existed; anything else stays "unknown".
      if (err.status === 404) this.set({ journeysSupported: false });
      this.journeysFetchedAt = 0;
    }
  }

  /** Integrity + loadgen come over SSE; poll them only while SSE is down (and rarely otherwise). */
  private async fallbackPoll() {
    const sseUp = this.state.sse === 'open';
    const jobs: Promise<void>[] = [];
    if (!sseUp || !this.state.integrity) {
      jobs.push(
        controlApi.integrity(this.ctrl.signal).then((raw) => {
          this.onIntegrity(raw);
        }),
      );
    }
    if (!sseUp || !this.state.loadgen) {
      jobs.push(
        controlApi.loadgen(this.ctrl.signal).then((raw) => {
          this.onLoadgen(raw);
        }),
      );
    }
    if (!sseUp) jobs.push(this.fetchRecent());
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && failed.status === 'rejected') throw failed.reason;
  }

  private async backfill() {
    const step = 2;
    const q = (expr: string) =>
      controlApi.promRange(expr, 10, step, this.ctrl.signal).then(
        (r) => promSeries(r, step),
        () => [] as [number, number | null][],
      );
    // Same expressions the control plane uses for /control/summary, so history and live
    // samples line up.
    const window = '[15s]';
    const count = 'http_server_request_duration_seconds_count{service="gateway",route!="unmatched"}';
    const errors = 'http_server_request_duration_seconds_count{service="gateway",status=~"5.."}';
    const bucket = 'http_server_request_duration_seconds_bucket{service="gateway"}';
    const quant = (p: number) => `1000 * histogram_quantile(${p}, sum by (le) (rate(${bucket}${window})))`;
    const [rps, err, p50, p95, p99] = await Promise.all([
      q(`sum(rate(${count}${window}))`),
      q(`100 * sum(rate(${errors}${window})) / clamp_min(sum(rate(${count}${window})), 1e-9)`),
      q(quant(0.5)),
      q(quant(0.95)),
      q(quant(0.99)),
    ]);
    if (!rps.length || !this.running) return;
    const map = new Map<number, GatewayPoint>();
    const put = (series: [number, number | null][], key: keyof Omit<GatewayPoint, 't'>) => {
      for (const [t, v] of series) {
        const p = map.get(t) ?? { t, rps: null, errorPct: null, p50: null, p95: null, p99: null };
        p[key] = v;
        map.set(t, p);
      }
    };
    put(rps, 'rps');
    put(err, 'errorPct');
    put(p50, 'p50');
    put(p95, 'p95');
    put(p99, 'p99');
    const firstLive = this.state.history[0]?.t ?? Date.now();
    const cutoff = Date.now() - WINDOW_MS;
    const points = [...map.values()]
      .filter((p) => p.t < firstLive - 1000 && p.t >= cutoff)
      .sort((a, b) => a.t - b.t);
    if (points.length) this.set({ backfill: points });
  }

  /* ------------------------------------------------------------------ SSE */

  private connectSse() {
    if (!this.running) return;
    this.set({ sse: this.sseAttempts ? 'reconnecting' : 'connecting' });
    let es: EventSource;
    try {
      es = new EventSource('/control/events');
    } catch {
      this.scheduleSse();
      return;
    }
    this.es = es;
    es.onopen = () => {
      if (this.es !== es) return;
      this.sseAttempts = 0;
      this.set({ sse: 'open', sseSince: Date.now() });
      // Catch up on anything missed while disconnected.
      void this.fetchRecent();
      void this.fetchState().catch(() => undefined);
      if (Date.now() - this.journeysFetchedAt > 5000) void this.fetchJourneys();
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // Close and reconnect ourselves: EventSource gives up for good on HTTP errors
      // (e.g. 502 while the control plane restarts) and we want bounded back-off.
      es.close();
      this.es = null;
      this.scheduleSse();
    };
    es.addEventListener('timeline', (ev) => {
      const e = normalizeEvent(parseSse(ev));
      if (e) this.set((st) => ({ timeline: mergeEvents(st.timeline, [e]) }));
    });
    es.addEventListener('loadgen', (ev) => this.onLoadgen(parseSse(ev)));
    es.addEventListener('runtime', (ev) => {
      const rt = normalizeRuntime(parseSse(ev));
      if (rt) this.applyRuntime(rt);
    });
    es.addEventListener('integrity', (ev) => this.onIntegrity(parseSse(ev)));
    es.addEventListener('journey', (ev) => this.onJourney(parseSse(ev)));
  }

  private scheduleSse() {
    if (!this.running) return;
    this.sseAttempts += 1;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.sseAttempts - 1, 4)) + Math.random() * 400;
    this.set({ sse: 'reconnecting' });
    window.clearTimeout(this.sseRetryTimer);
    this.sseRetryTimer = window.setTimeout(() => this.connectSse(), delay);
  }

  /* ------------------------------------------------------------------ reducers */

  private applyRuntime(rt: RuntimeState, fromPoll = false) {
    const cur = this.state.runtime;
    if (cur) {
      if (rt.version === cur.version && rt.updatedAt === cur.updatedAt) return; // nothing new
      if (rt.version < cur.version) {
        // Usually a stale snapshot racing a newer push: skip it. But if a full /control/state
        // read still says "older" well after our last change, the store was reset — accept it.
        const settled = Date.now() - this.runtimeAppliedAt > 5000;
        if (!(fromPoll && settled)) return;
      }
    }
    this.runtimeAppliedAt = Date.now();
    this.set({ runtime: rt });
  }

  private onIntegrity(raw: unknown) {
    const i = normalizeIntegrity(raw);
    if (!i) return;
    const t = Date.now();
    this.set((st) => ({
      integrity: i,
      integrityAt: t,
      integrityHistory: [...st.integrityHistory.filter((p) => p.t >= t - WINDOW_MS), { t, v: i.violations }],
    }));
  }

  private onJourney(raw: unknown) {
    const j = normalizeJourney(raw);
    if (!j) return;
    const t = Date.now();
    this.set((st) => ({
      journeys: st.journeys.some((x) => x.id === j.id) ? st.journeys : [j, ...st.journeys].slice(0, MAX_JOURNEYS),
      journeysSupported: true,
      journeyArrivals: [...st.journeyArrivals.filter((x) => t - x < JOURNEY_RATE_WINDOW_MS), t].slice(-1000),
    }));
  }

  private onLoadgen(raw: unknown) {
    const t = Date.now();
    this.set((st) => {
      const lg = normalizeLoadgen(raw, st.loadgen);
      if (!lg) return {};
      // Journeys belong to one run (the control plane empties its buffer on start too).
      const was = st.loadgen;
      const newRun =
        was !== null &&
        lg.running &&
        (!was.running || lg.scenarioId !== was.scenarioId || lg.elapsedSec + 3 < was.elapsedSec);
      const prev = st.loadHistory[st.loadHistory.length - 1];
      // Session-end rates over a ~5s sliding window: smoother than point-to-point diffs and
      // immune to closely spaced samples (SSE tick + a command response).
      let rates: SessionRates | null = null;
      if (lg.running) {
        let base: LoadPoint | undefined;
        for (let i = st.loadHistory.length - 1; i >= 0; i--) {
          const p = st.loadHistory[i]!;
          if (!p.running || t - p.t > 6000 || p.cum.started > lg.sessions.started) break;
          base = p;
        }
        if (base && t - base.t >= 1500) {
          const dt = (t - base.t) / 1000;
          const from = base.cum;
          const d = (k: keyof LoadgenSessions) => Math.max(0, lg.sessions[k] - from[k]) / dt;
          rates = {
            converted: d('converted'),
            abandoned: d('abandoned'),
            failed: d('failed'),
            blocked: d('blocked'),
            soldOut: d('soldOut'),
          };
        }
      }
      const stepOrder = [...st.stepOrder];
      const steps: Record<string, number> = {};
      for (const s of lg.steps) {
        steps[s.step] = s.p95Ms;
        if (!stepOrder.includes(s.step)) stepOrder.push(s.step);
      }
      const cutoff = t - WINDOW_MS;
      const keep = st.loadHistory.filter((p) => p.t >= cutoff);
      const point: LoadPoint = {
        t,
        running: lg.running,
        target: lg.targetArrivalPerSec,
        actual: lg.actualArrivalPerSec,
        rps: lg.rps,
        active: lg.activeSessions,
        cum: lg.sessions,
        rates,
        steps,
      };
      // While idle, record one closing point and then stop adding flat zeros.
      const loadHistory = lg.running || prev?.running ? [...keep, point] : keep;
      return {
        loadgen: lg,
        loadgenAt: t,
        loadHistory,
        stepOrder: stepOrder.length === st.stepOrder.length ? st.stepOrder : stepOrder,
        ...(newRun ? { journeys: [], journeyArrivals: [] } : {}),
      };
    });
  }

  private mergeLoadgen(partial: unknown) {
    if (partial && typeof partial === 'object') this.onLoadgen({ ...(this.state.loadgen ?? {}), ...partial });
  }

  /* ------------------------------------------------------------------ commands */

  async patchFlags(patch: Record<string, string>) {
    const rt = normalizeRuntime(await controlApi.patchFlags(patch));
    if (rt) this.applyRuntime(rt);
  }

  async patchChaos(patch: ChaosPatch) {
    const rt = normalizeRuntime(await controlApi.patchChaos(patch));
    if (rt) this.applyRuntime(rt);
  }

  async patchTuning(patch: Record<string, number>) {
    const rt = normalizeRuntime(await controlApi.patchTuning(patch));
    if (rt) this.applyRuntime(rt);
  }

  async preset(id: PresetId) {
    const rt = normalizeRuntime(await controlApi.preset(id));
    if (rt) this.applyRuntime(rt);
  }

  async startScenario(id: string, multiplier?: number) {
    this.mergeLoadgen(await controlApi.startScenario(id, multiplier));
  }

  async stopScenario() {
    this.mergeLoadgen(await controlApi.stopScenario());
  }

  async setMultiplier(multiplier: number) {
    this.mergeLoadgen(await controlApi.patchLoadgen(multiplier));
  }

  async startLab(id: string, variant: LabVariant, multiplier?: number) {
    const r = await controlApi.startLab(id, variant, multiplier);
    const rt = normalizeRuntime(r?.runtime);
    if (rt) this.applyRuntime(rt);
    if (r?.loadgen) this.mergeLoadgen(r.loadgen);
    return r;
  }

  async action(action: ControlAction, body: Record<string, unknown> = {}): Promise<ActionResponse> {
    return controlApi.action(action, body);
  }

  /** Clear client-side buffers (e.g. after reset-data) without touching the backend. */
  clearBuffers() {
    this.set({ history: [], backfill: [], loadHistory: [], integrityHistory: [], routeHistory: {} });
  }
}

export const opsStore = new OpsStore();

export function useOps<T>(selector: (s: OpsState) => T): T {
  const get = () => selector(opsStore.getState());
  return useSyncExternalStore(opsStore.subscribe, get, get);
}

/** Mount once per ops layout: keeps polling + SSE alive while ops pages are open. */
export function useOpsConnection(): void {
  useEffect(() => opsStore.retain(), []);
}
