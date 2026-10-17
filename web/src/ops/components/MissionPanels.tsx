import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { shopApi } from '../../api/shop';
import type { ControlDefs, KnobRecord, LoadgenStats, RuntimeState, Summary } from '../../api/types';
import { formatInt, formatNum, formatPct, formatTime } from '../../lib/format';
import { usePolling } from '../../lib/hooks';
import { useOps, type SseStatus } from '../store';
import { KPIS, type KpiDef, type Level } from '../thresholds';
import { KpiCard, TREND_POINTS } from './KpiGrid';
import { Empty, Panel } from './ui';

/* ------------------------------------------------------------------ header */

const SSE_META: Record<SseStatus, { icon: string; text: string; cls: string }> = {
  idle: { icon: '○', text: 'Live feed off', cls: 'conn-off' },
  connecting: { icon: '◌', text: 'Connecting…', cls: 'conn-wait' },
  open: { icon: '●', text: 'Live', cls: 'conn-live' },
  reconnecting: { icon: '▲', text: 'Reconnecting…', cls: 'conn-wait' },
};

/** Grafana from docker compose, on whatever host this page was opened from. */
function grafanaUrl(): string {
  try {
    return `${window.location.protocol}//${window.location.hostname}:3300`;
  } catch {
    return 'http://localhost:3300';
  }
}

export function MissionHeader() {
  const sse = useOps((s) => s.sse);
  const reachable = useOps((s) => s.reachable);
  const meta = reachable === false ? { icon: '■', text: 'Control plane unreachable', cls: 'conn-down' } : SSE_META[sse];
  return (
    <header className="mc-head">
      <div className="mc-head-titles">
        <h1>Mission Control</h1>
        <p>The storefront and the system behind it, side by side.</p>
      </div>
      <div className="mc-head-meta">
        <span className={`conn-item ${meta.cls}`} title="Server-sent events (/control/events)">
          <span aria-hidden="true" className={sse === 'open' && reachable !== false ? 'pulse-dot' : undefined}>
            {meta.icon}
          </span>{' '}
          {meta.text}
        </span>
        <nav className="mc-head-links" aria-label="Related tools">
          <Link to="/warroom">War Room</Link>
          <Link to="/labs">Labs</Link>
          <a href={grafanaUrl()} target="_blank" rel="noopener noreferrer">
            Grafana <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ right now */

interface NowChip {
  key: string;
  kind: 'bug' | 'flag' | 'chaos';
  name: string;
  value: string;
  help?: string;
  lab?: string;
}

/** Flags not in their hardened mode, and chaos knobs away from their defaults. */
export function rightNowChips(runtime: RuntimeState, defs: ControlDefs): NowChip[] {
  const out: NowChip[] = [];
  for (const [key, def] of Object.entries(defs.flags)) {
    const mode = runtime.flags[key];
    if (mode === undefined || mode === def.hardened) continue;
    out.push({
      key: `flag:${key}`,
      kind: mode === def.naive ? 'bug' : 'flag',
      name: key,
      value: mode,
      help: def.modeHelp[mode] ?? def.description,
      lab: def.lab || undefined,
    });
  }
  const changed = (group: string, values: object | undefined, defaults: object | undefined) => {
    if (!values) return;
    const d = (defaults ?? {}) as KnobRecord;
    for (const [k, v] of Object.entries(values as Partial<KnobRecord>)) {
      if (v === undefined) continue;
      if (k in d ? v === d[k] : v === 0 || v === false) continue;
      out.push({ key: `chaos:${group}.${k}`, kind: 'chaos', name: `${group}.${k}`, value: String(v) });
    }
  };
  for (const [svc, values] of Object.entries(runtime.chaos.services)) changed(svc, values, defs.serviceChaosDefaults);
  changed('payments', runtime.chaos.payments, defs.paymentsChaosDefaults);
  changed('data', runtime.chaos.data, defs.dataChaosDefaults);
  return out;
}

const CHIP_TAG = { bug: 'BUG', flag: 'FLAG', chaos: 'CHAOS' } as const;

export function RightNow() {
  const runtime = useOps((s) => s.runtime);
  const defs = useOps((s) => s.defs);
  const chips = useMemo(() => (runtime && defs ? rightNowChips(runtime, defs) : null), [runtime, defs]);
  const titleId = useId();
  return (
    <section className="mc-now" aria-labelledby={titleId}>
      <h2 id={titleId} className="mc-now-title">
        Right now
      </h2>
      {chips == null ? (
        <span className="muted small">loading the runtime state…</span>
      ) : chips.length === 0 ? (
        <span className="chip chip-live">
          <span aria-hidden="true">✓</span> All systems hardened, no chaos
        </span>
      ) : (
        <ul className="mc-now-list">
          {chips.map((c) => {
            const body = (
              <>
                <b className="mc-now-tag">{CHIP_TAG[c.kind]}</b> <code>{c.name}</code> = <code>{c.value}</code>
              </>
            );
            return (
              <li key={c.key}>
                {c.kind === 'bug' && c.lab ? (
                  <Link to={`/labs/${encodeURIComponent(c.lab)}`} className={`mc-now-chip is-${c.kind}`} title={`${c.help ?? ''} — open the lab`}>
                    {body}
                  </Link>
                ) : (
                  <span className={`mc-now-chip is-${c.kind}`} title={c.help}>
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/warroom" className="mc-now-link">
        Change in the War Room →
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------ KPI strip */

const kpi = (id: string): KpiDef => KPIS.find((k) => k.id === id)!;
const SUMMARY_KPIS = ['rps', 'p95', 'errorPct', 'checkouts', 'paid', 'gmv'].map(kpi);

const conversionOf = (s: { started: number; converted: number }) => (s.started > 0 ? (100 * s.converted) / s.started : null);

export function MissionKpis() {
  const summary = useOps((s) => s.summary);
  const runtime = useOps((s) => s.runtime);
  const history = useOps((s) => s.history);
  const loadgen = useOps((s) => s.loadgen);
  const loadHistory = useOps((s) => s.loadHistory);
  const loadTrend = useMemo(() => loadHistory.slice(-TREND_POINTS), [loadHistory]);
  const summaryTrend = useMemo(() => history.slice(-TREND_POINTS).map((p) => p.summary), [history]);

  const tile = (def: KpiDef, s: Summary | null) => {
    if (!s) return <KpiCard key={def.id} label={def.label} value={null} />;
    const v = def.get(s);
    const level: Level = def.level ? def.level(v, s, runtime) : 'none';
    return (
      <KpiCard key={def.id} label={def.label} hint={def.hint} value={def.format(v)} level={level} trend={summaryTrend.map(def.get)} />
    );
  };
  const lg = (label: string, hint: string, value: (l: LoadgenStats) => string, trend: (number | null)[]) =>
    loadgen ? <KpiCard key={label} label={label} hint={hint} value={value(loadgen)} trend={trend} /> : <KpiCard key={label} label={label} value={null} />;

  const conversion = loadgen ? conversionOf(loadgen.sessions) : null;
  return (
    <section className="mc-kpis" aria-label="Key numbers">
      <div className="kpi-grid mc-kpi-grid">
        {lg(
          'Live shoppers',
          'Simulated sessions currently in the store (load generator).',
          (l) => formatInt(l.activeSessions),
          loadTrend.map((p) => p.active),
        )}
        {lg(
          'Arrivals / s',
          'New shopper sessions per second (actual, vs the scenario target).',
          (l) => formatNum(l.actualArrivalPerSec),
          loadTrend.map((p) => p.actual),
        )}
        {SUMMARY_KPIS.map((d) => tile(d, summary))}
        {loadgen ? (
          <KpiCard
            label={loadgen.running ? 'Conversion' : 'Conversion (last run)'}
            hint={
              loadgen.running
                ? 'Sessions of this run that bought something (converted / started — in-flight sessions count as not yet).'
                : 'Sessions of the last run that bought something (converted / started). No scenario is running.'
            }
            value={conversion == null ? '—' : formatPct(conversion)}
            trend={loadTrend.map((p) => conversionOf(p.cum))}
          />
        ) : (
          <KpiCard label="Conversion" value={null} />
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ funnel */

const FUNNEL_STEPS: { step: string; label: string }[] = [
  { step: 'home', label: 'Home' },
  { step: 'product', label: 'Product page' },
  { step: 'add_to_cart', label: 'Add to cart' },
  { step: 'checkout', label: 'Checkout' },
  { step: 'pay', label: 'Pay' },
];

export function FunnelCard() {
  const loadgen = useOps((s) => s.loadgen);
  const loadHistory = useOps((s) => s.loadHistory);
  const convertedPerSec = loadHistory[loadHistory.length - 1]?.rates?.converted ?? null;
  const stages = useMemo(() => {
    if (!loadgen) return [];
    const rps = new Map(loadgen.steps.map((s) => [s.step, s.rps]));
    return [
      { key: 'arrivals', label: 'Arrivals', value: loadgen.actualArrivalPerSec, unit: 'sessions' },
      ...FUNNEL_STEPS.map((f) => ({ key: f.step, label: f.label, value: rps.get(f.step) ?? 0, unit: 'requests' })),
      { key: 'converted', label: 'Converted', value: convertedPerSec ?? 0, unit: 'sessions' },
    ];
  }, [loadgen, convertedPerSec]);
  const max = Math.max(1e-9, ...stages.map((s) => s.value));
  // Rates only mean something while a run is on: idle, the SSE replay still carries the last run's final window.
  const idle = !loadgen?.running;
  return (
    <Panel title="Conversion funnel" subtitle="per second · steps count requests (retries included)" className="mc-funnel-panel">
      {!loadgen || idle ? (
        <Empty>The funnel fills while a scenario runs.</Empty>
      ) : (
        <ol className="mc-funnel">
          {stages.map((s, i) => {
            const prev = i > 0 ? stages[i - 1]!.value : null;
            const pct = prev != null && prev > 0 ? (100 * s.value) / prev : null;
            return (
              <li key={s.key} className={`mc-funnel-row is-${s.key}`}>
                <span className="mc-funnel-label">{s.label}</span>
                <span className="mc-funnel-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(s.value > 0 ? 1.5 : 0, (100 * s.value) / max)}%` }} />
                </span>
                <span className="mc-funnel-val">
                  {formatNum(s.value)}/s<span className="sr-only"> {s.unit}</span>
                </span>
                <span className="mc-funnel-pct" title="Of the previous stage">
                  {/* Retries can make a stage bigger than the one before it: show it, don't cap at 100%. */}
                  {pct == null ? '' : pct >= 100 ? `${formatInt(pct)}%` : formatPct(pct)}
                  {pct != null && <span className="sr-only"> of the previous stage</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ hot deal stock */

interface DealInfo {
  name: string;
  total: number | null;
  available: number | null;
}

const DRAIN_WINDOW_MS = 30_000;

export function HotStockCard() {
  const hot = useOps((s) => s.summary?.hotStock);
  const history = useOps((s) => s.history);
  const [deals, setDeals] = useState<{ bySku: Map<string, DealInfo>; at: number } | null>(null);

  // Names and totals from the storefront API, refreshed at most once a minute (stock itself
  // comes live from the summary).
  usePolling(
    async (signal) => {
      const { data } = await shopApi.home(signal);
      const bySku = new Map<string, DealInfo>();
      for (const d of Array.isArray(data?.deals) ? data.deals : []) {
        if (d?.sku) bySku.set(d.sku, { name: d.name, total: d.stock?.total ?? null, available: d.stock?.available ?? null });
      }
      setDeals({ bySku, at: Date.now() });
    },
    60_000,
    { maxBackoffMs: 120_000 },
  );

  const drain = useMemo(() => {
    const out = new Map<string, number>();
    const last = history[history.length - 1];
    if (!last?.summary.hotStock) return out;
    const base = [...history].reverse().find((p) => last.t - p.t >= DRAIN_WINDOW_MS && p.summary.hotStock);
    if (!base?.summary.hotStock) return out;
    const before = new Map(base.summary.hotStock.map((h) => [h.sku, h.available]));
    const minutes = (last.t - base.t) / 60_000;
    for (const h of last.summary.hotStock) {
      const b = before.get(h.sku);
      if (b != null && b > h.available) out.set(h.sku, (b - h.available) / minutes);
    }
    return out;
  }, [history]);

  const live = hot != null;
  const rows = live
    ? hot.map((h) => ({ sku: h.sku, available: h.available, info: deals?.bySku.get(h.sku) }))
    : [...(deals?.bySku.entries() ?? [])]
        .sort((x, y) => (x[0] < y[0] ? -1 : 1))
        .map(([sku, info]) => ({ sku, available: info.available ?? 0, info }));
  const maxAvail = Math.max(1, ...rows.map((r) => r.available));

  return (
    <Panel
      title="Hot deal stock"
      subtitle={live ? 'live from inventory · draining as shoppers buy' : deals ? `from /api/home at ${formatTime(deals.at)}` : 'loading…'}
      className="mc-stock-panel"
    >
      {!live && deals && (
        <p className="mc-note" role="note">
          <span aria-hidden="true">ℹ</span> Live stock needs a newer control plane (summary.hotStock) — refreshed once a minute
          instead.
        </p>
      )}
      {rows.length === 0 ? (
        <Empty>{deals || live ? 'No hot deals.' : 'Loading deals…'}</Empty>
      ) : (
        <ul className="mc-stock">
          {rows.map((r) => {
            const total = r.info?.total ?? null;
            const frac = total && total > 0 ? Math.min(1, r.available / total) : r.available / maxAvail;
            const tone = r.available <= 0 ? 'out' : frac < 0.1 ? 'low' : 'ok';
            const perMin = drain.get(r.sku);
            return (
              <li key={r.sku} className={`mc-stock-row is-${tone}`}>
                <span className="mc-stock-name" title={r.info?.name ? `${r.info.name} (${r.sku})` : r.sku}>
                  {r.info?.name ?? r.sku}
                </span>
                <span className="mc-stock-bar" aria-hidden="true">
                  <span style={{ width: `${frac * 100}%` }} />
                </span>
                <span className="mc-stock-val">
                  {tone === 'out' ? (
                    <b className="crit-text">
                      <span aria-hidden="true">■</span> SOLD OUT
                    </b>
                  ) : (
                    <>
                      {tone === 'low' && <span aria-hidden="true" className="warn-text">▲ </span>}
                      <b>{formatInt(r.available)}</b>
                      {total != null && <span className="muted"> / {formatInt(total)}</span>}
                    </>
                  )}
                  {perMin != null && perMin >= 0.5 && <span className="mc-stock-drain"> −{formatNum(perMin)}/min</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
