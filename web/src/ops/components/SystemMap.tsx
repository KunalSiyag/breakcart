import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LoadgenStats, ScenarioSummary, ServiceHealth, ServiceStats, Summary } from '../../api/types';
import { formatInt, formatMs, formatNum, formatPct, relativeTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { local } from '../../lib/storage';
import { useElementWidth, useReducedMotion } from '../../lib/viewport';
import { useOps } from '../store';
import { above, serviceLevels, type Level } from '../thresholds';
import {
  edgeWidth,
  flowBucket,
  flowFor,
  isNodeId,
  isServiceNode,
  MAP_H,
  MAP_W,
  MIN_RATE,
  NODE_BY_ID,
  NODES,
  poolWaiting,
  storeTimedP99,
  storeTotals,
  deriveTopology,
  type EdgeLevel,
  type EdgeView,
  type Flow,
  type MapNode,
  type NodeId,
  type TopologyView,
} from '../topology';
import { NodeDetails } from './SystemMapDetails';
import { Panel } from './ui';

/**
 * "The system, live": every service, store and the order-event stream on a fixed map.
 * Edges are coloured by health and sized by traffic; particles show the flow direction
 * (SMIL <animateMotion>, so the browser animates them — React only re-renders when a new
 * summary arrives). Nodes are buttons: Enter / click opens the details panel.
 */

type Density = 'full' | 'compact';

/** Below this container width the map switches to big-text tiles (same geometry). */
const COMPACT_BELOW = 620;

const LEVEL_ICON: Record<EdgeLevel, string> = { nodata: '', idle: '', ok: '', warn: '▲', crit: '■' };

const BREAKER_TAG = { open: 'OPEN', half_open: 'HALF-OPEN' } as const;

/** Rough advance width of system-ui glyphs, in em (bold names, semi-bold badges). */
const NAME_EM = 0.6;
const BADGE_EM = 0.62;

/** Fit the name (and its badge) into the card: shrink a long name, drop the badge if still too tight. */
function fitTitle(label: string, badge: string | null, w: number): { size: number; badge: string | null } {
  const inner = w - 24 - 9;
  const badgeW = badge ? badge.length * (badge === 'EXTERNAL PSP' ? 9.5 : 11) * BADGE_EM + 8 : 0;
  const per = label.length * NAME_EM;
  if (per * 14 <= inner - badgeW) return { size: 14, badge };
  const withBadge = (inner - badgeW) / per;
  if (withBadge >= 11.5) return { size: withBadge, badge };
  return { size: Math.max(11, Math.min(14, inner / per)), badge: null };
}

/* ------------------------------------------------------------------ node content */

interface Line {
  text: string;
  level?: Level;
  strong?: boolean;
}

interface NodeView {
  status: 'up' | 'down' | 'unknown';
  /** Small text right of the name: ×3, EXTERNAL, … */
  badge: string | null;
  rows: [Line | null, Line | null][];
  /** Compact (phone) rendering: one line. */
  compact: Line;
  pool: { busy: number; capacity: number; waiting: number } | null;
  alert: boolean;
  aria: string;
}

function hasCrit(rows: [Line | null, Line | null][]): boolean {
  return rows.some((r) => r.some((c) => c?.level === 'crit'));
}

/** Level for a compact tile, which only marks ■ (crit) and ▲ (warn or serious). */
const worst = (...ls: Level[]): Level =>
  ls.includes('crit') ? 'crit' : ls.some((l) => l === 'warn' || l === 'serious') ? 'warn' : 'none';

function serviceView(
  node: MapNode,
  stats: ServiceStats | undefined,
  health: ServiceHealth | undefined,
  hasSummary: boolean,
): NodeView {
  const up = stats?.up ?? health?.up ?? null;
  const status = up == null ? 'unknown' : up ? 'up' : 'down';
  const instances = stats?.instances ?? health?.instances;
  const external = node.kind === 'external';
  const badge = status === 'down' ? null : external ? 'EXTERNAL PSP' : instances && instances > 1 ? `×${instances}` : null;
  if (!stats) {
    const text = hasSummary ? 'no metrics' : 'waiting for data';
    return {
      status,
      badge,
      rows: [[{ text }, null]],
      compact: { text: status === 'down' ? 'DOWN' : '—', level: status === 'down' ? 'crit' : 'none' },
      pool: null,
      alert: status === 'down',
      aria: `${node.label}: ${status === 'unknown' ? 'status unknown' : status}, ${text}`,
    };
  }
  const busy = stats.dbPool ? Math.max(0, stats.dbPool.total - stats.dbPool.idle) : 0;
  const capacity = stats.dbPool ? Math.max(stats.dbPool.max ?? 0, stats.dbPool.total) : 0;
  const waiting = stats.dbPool?.waiting ?? 0;
  const active = stats.rps > 0;
  const p99: Level = active ? serviceLevels.p99Ms(stats.p99Ms) : 'none';
  const err: Level = active ? serviceLevels.errorPct(stats.errorPct) : 'none';
  const cpu = serviceLevels.cpuPct(stats.cpuPct);
  const lag = serviceLevels.loopLagMs(stats.eventLoopLagMs);
  const rows: [Line | null, Line | null][] = [
    [
      { text: `${formatNum(stats.rps)}/s`, strong: true },
      { text: `p99 ${formatMs(stats.p99Ms)}`, level: p99 },
    ],
    [
      { text: `err ${formatPct(stats.errorPct)}`, level: err },
      { text: `cpu ${formatPct(stats.cpuPct)}`, level: cpu },
    ],
    // Pool waiters take the lag's place: both don't fit on one row (lag stays in the details).
    [
      waiting > 0 ? { text: `${formatInt(waiting)} waiting`, level: 'crit' } : { text: `lag ${formatMs(stats.eventLoopLagMs)}`, level: lag },
      stats.dbPool
        ? { text: waiting > 0 ? `${formatInt(busy)}/${formatInt(capacity)}` : `pool ${formatInt(busy)}/${formatInt(capacity)}` }
        : null,
    ],
  ];
  const down = status === 'down';
  return {
    status,
    badge,
    rows,
    compact: down ? { text: 'DOWN', level: 'crit' } : { text: `${formatNum(stats.rps)}/s`, level: worst(err, p99) },
    pool: stats.dbPool ? { busy, capacity, waiting } : null,
    alert: down || hasCrit(rows),
    aria:
      `${node.label}${external ? ' (external payment provider)' : ''}: ${down ? 'DOWN' : status === 'up' ? 'up' : 'status unknown'}` +
      `${instances && instances > 1 ? `, ${instances} instances` : ''}, ${formatNum(stats.rps)} requests per second, ` +
      `p99 ${formatMs(stats.p99Ms)}, ${formatPct(stats.errorPct)} errors, CPU ${formatPct(stats.cpuPct)}, ` +
      `event-loop lag ${formatMs(stats.eventLoopLagMs)}` +
      (stats.dbPool ? `, DB pool ${busy} of ${capacity} busy${waiting ? `, ${waiting} waiting` : ''}` : ''),
  };
}

function customersView(loadgen: LoadgenStats | null, botShare: number | null): NodeView {
  if (!loadgen) {
    return {
      status: 'unknown',
      badge: null,
      rows: [[{ text: 'waiting for data' }, null]],
      compact: { text: '—' },
      pool: null,
      alert: false,
      aria: 'Customers: no load-generator data yet',
    };
  }
  const bots = botShare != null && botShare > 0 ? `${Math.round(botShare * 100)}% bots` : null;
  return {
    status: loadgen.running ? 'up' : 'unknown',
    badge: null,
    rows: [
      [{ text: `${formatInt(loadgen.activeSessions)} in store`, strong: true }, null],
      [{ text: `${formatNum(loadgen.actualArrivalPerSec)}/s arriving` }, bots ? { text: bots } : null],
    ],
    compact: { text: formatInt(loadgen.activeSessions), strong: true },
    pool: null,
    alert: false,
    aria:
      `Customers: ${formatInt(loadgen.activeSessions)} shoppers in the store, ${formatNum(loadgen.actualArrivalPerSec)} arriving per second` +
      (bots ? `, ${bots}` : '') +
      (loadgen.running ? '' : ' (no scenario running)'),
  };
}

function streamView(summary: Summary | null): NodeView {
  const s = summary?.stream;
  if (!s) {
    return {
      status: 'unknown',
      badge: null,
      rows: [[{ text: summary ? 'not reported' : 'waiting for data' }, null]],
      compact: { text: '—' },
      pool: null,
      alert: false,
      aria: 'Order events stream: no data',
    };
  }
  const lag = above(s.lag, 100, 2000, 500);
  const outbox = summary?.business.outboxBacklog ?? 0;
  const rows: [Line | null, Line | null][] = [
    [{ text: `in ${formatNum(s.producedPerSec)}/s`, strong: true }, { text: `out ${formatNum(s.consumedPerSec)}/s` }],
    [{ text: `lag ${formatInt(s.lag)}`, level: lag }, { text: `DLQ ${formatInt(s.dlq)}`, level: s.dlq > 0 ? 'crit' : 'none' }],
    [{ text: `outbox ${formatInt(outbox)}`, level: above(outbox, 50, 1000, 250) }, null],
  ];
  return {
    status: 'up',
    badge: null,
    rows,
    compact: { text: `lag ${formatInt(s.lag)}`, level: worst(lag) },
    pool: null,
    alert: hasCrit(rows),
    aria: `Order events stream: ${formatNum(s.producedPerSec)} in and ${formatNum(s.consumedPerSec)} out per second, lag ${formatInt(s.lag)}, ${formatInt(s.dlq)} in the dead-letter queue`,
  };
}

function storeView(node: MapNode, summary: Summary | null): NodeView {
  const store = node.id === 'redis' ? 'redis' : 'postgres';
  const t = storeTotals(summary, store);
  if (!t) {
    return {
      status: 'unknown',
      badge: store === 'redis' ? 'cache · queues' : 'SQL',
      rows: [[{ text: summary ? 'not reported' : 'waiting for data' }, null]],
      compact: { text: '—' },
      pool: null,
      alert: false,
      aria: `${node.label}: no data`,
    };
  }
  // Same rate floor and bands as the store edges and the legend (▲ ≥ 500 ms, ■ ≥ 2 s).
  const timedP99 = storeTimedP99(t);
  const p99 = timedP99 == null ? 'none' : above(timedP99, 500, 2000);
  const err = t.opsPerSec > 0 ? above(t.errorPct, 1, 5) : 'none';
  const top = t.users[0];
  const rows: [Line | null, Line | null][] = [
    [{ text: `${formatNum(t.opsPerSec)} ${store === 'redis' ? 'ops' : 'q'}/s`, strong: true }, { text: `p99 ${formatMs(t.p99Ms)}`, level: p99 }],
    [{ text: `err ${formatPct(t.errorPct)}`, level: err }, { text: `${t.users.length} client${t.users.length === 1 ? '' : 's'}` }],
  ];
  if (store === 'postgres') {
    const w = poolWaiting(summary?.services ?? []);
    rows.push([
      w.total > 0 ? { text: `${formatInt(w.total)} queries waiting`, level: 'crit' } : { text: 'no queries waiting' },
      null,
    ]);
  } else if (top && top.opsPerSec >= MIN_RATE) {
    rows.push([{ text: `busiest: ${top.service} ${formatNum(top.opsPerSec)}/s` }, null]);
  }
  return {
    status: 'up',
    badge: store === 'redis' ? 'cache · queues' : 'SQL',
    rows,
    compact: { text: `${formatNum(t.opsPerSec)}/s`, level: worst(err, p99) },
    pool: null,
    alert: hasCrit(rows),
    aria: `${node.label}: ${formatNum(t.opsPerSec)} operations per second from ${t.users.length} services, p99 ${formatMs(t.p99Ms)}, ${formatPct(t.errorPct)} errors`,
  };
}

/* ------------------------------------------------------------------ edges */

const fmtRate = (rps: number) => `${formatNum(rps)}/s`;

export function edgeSummary(e: EdgeView): string {
  const path = `${NODE_BY_ID[e.from].label} → ${NODE_BY_ID[e.to].label}`;
  if (e.rps == null) return `${path}: not reported by this control plane`;
  if (e.rps < MIN_RATE && e.level !== 'warn' && e.level !== 'crit') return `${path}: no traffic`;
  const parts = [fmtRate(e.rps)];
  if (e.p99Ms != null) parts.push(`p99 ${formatMs(e.p99Ms)}`);
  if (e.errorPct != null) parts.push(`${formatPct(e.errorPct)} errors`);
  if (e.breaker) parts.push(`circuit breaker ${BREAKER_TAG[e.breaker]}`);
  return `${path}: ${parts.join(' · ')}`;
}

/** "▲ 123/s · 45ms", plus "3.2% err" on a second line when errors are ≥ 1%. */
function edgeLabel(e: EdgeView): string[] {
  if (e.rps == null) return [];
  const parts = [fmtRate(e.rps)];
  if (e.p99Ms != null && e.rps >= MIN_RATE) parts.push(formatMs(e.p99Ms).replace(' ', ''));
  const icon = LEVEL_ICON[e.level];
  const lines = [`${icon ? `${icon} ` : ''}${parts.join(' · ')}`];
  if (e.errorPct != null && e.errorPct >= 1) lines.push(`${formatPct(e.errorPct)} err`);
  return e.breaker ? [`${BREAKER_TAG[e.breaker]} breaker`, ...lines] : lines;
}

const LABEL_LINE = 13;

function EdgeLabel({ e, hot }: { e: EdgeView; hot: boolean }) {
  const lines = edgeLabel(e);
  const { x, y, anchor, stack } = e.geo.label;
  const y0 = stack === 'up' ? y - (lines.length - 1) * LABEL_LINE : stack === 'center' ? y - ((lines.length - 1) * LABEL_LINE) / 2 + 4 : y;
  return (
    <text x={x} y={y0} textAnchor={anchor} className={`mc-edge-label lvl-${visualLevel(e)}${hot ? ' is-hot' : ''}`}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : LABEL_LINE} className={e.breaker && i === 0 ? 'mc-breaker-text' : undefined}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

const LEVEL_RANK: Record<EdgeLevel, number> = { nodata: 0, idle: 1, ok: 2, warn: 3, crit: 4 };

function visualLevel(e: EdgeView): EdgeLevel {
  return e.breaker ? 'crit' : e.level;
}

function Particles({ e, flow }: { e: EdgeView; flow: Flow }) {
  const r = Math.min(4, 1.6 + edgeWidth(e.rps) * 0.28);
  return (
    <g className={`mc-flow mc-flow-${visualLevel(e)}`}>
      {Array.from({ length: flow.count }, (_, i) => (
        <circle key={i} r={r} className="mc-particle">
          <animateMotion
            dur={`${flow.durSec}s`}
            begin={`${(-(i * flow.durSec) / flow.count).toFixed(2)}s`}
            repeatCount="indefinite"
            path={e.geo.d}
          />
        </circle>
      ))}
    </g>
  );
}

/* ------------------------------------------------------------------ map */

function NodeCard({
  node,
  view,
  density,
  selected,
  hot,
  dim,
  focusable,
  onSelect,
  onHover,
  register,
}: {
  node: MapNode;
  view: NodeView;
  density: Density;
  selected: boolean;
  hot: boolean;
  dim: boolean;
  /** False while the details panel covers the whole card: Tab would land on a hidden node. */
  focusable: boolean;
  onSelect: (id: NodeId) => void;
  onHover: (id: NodeId | null) => void;
  register: (id: NodeId, el: SVGGElement | null) => void;
}) {
  const { w, h } = node;
  // The name is built from live numbers. Keep it fixed while focused, or screen readers
  // re-read the whole label on every summary.
  const [focusAria, setFocusAria] = useState<string | null>(null);
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(node.id);
    }
  };
  const cls = [
    'mc-node',
    `mc-kind-${node.kind}`,
    view.status === 'down' ? 'is-down' : '',
    view.alert ? 'has-alert' : '',
    selected ? 'is-selected' : '',
    hot ? 'is-hot' : '',
    dim ? 'is-dim' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const down = view.status === 'down';
  const title = fitTitle(node.label, down ? null : view.badge, w);
  const statusMark =
    view.status === 'down' ? (
      <rect x={9} y={12} width={9} height={9} rx={1.5} className="mc-status mc-status-down" />
    ) : (
      <circle cx={13.5} cy={16.5} r={4.75} className={`mc-status mc-status-${view.status}`} />
    );
  const line = (l: Line | null, x: number, y: number, anchor: 'start' | 'end', key: string): ReactNode => {
    if (!l) return null;
    const icon = l.level === 'crit' ? '■ ' : l.level === 'warn' || l.level === 'serious' ? '▲ ' : '';
    return (
      <text key={key} x={x} y={y} textAnchor={anchor} className={`mc-node-metric lvl-${l.level ?? 'none'}${l.strong ? ' is-strong' : ''}`}>
        {icon}
        {l.text}
      </text>
    );
  };
  return (
    <g
      ref={(el) => register(node.id, el)}
      className={cls}
      transform={`translate(${node.x} ${node.y})`}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={`${density === 'compact' && node.short !== node.label ? `${node.short}, ` : ''}${focusAria ?? view.aria}. ${selected ? 'Details open.' : 'Press Enter for details.'}`}
      aria-pressed={selected}
      onClick={() => onSelect(node.id)}
      onKeyDown={onKey}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => {
        setFocusAria(view.aria);
        onHover(node.id);
      }}
      onBlur={() => {
        setFocusAria(null);
        onHover(null);
      }}
    >
      <rect className="mc-node-focus" x={-4} y={-4} width={w + 8} height={h + 8} rx={12} />
      <rect className="mc-node-card" width={w} height={h} rx={9} />
      {statusMark}
      {density === 'full' ? (
        <>
          <text x={24} y={21} className="mc-node-name" style={title.size < 14 ? { fontSize: `${title.size.toFixed(1)}px` } : undefined}>
            {node.label}
          </text>
          {!down && title.badge && (
            <text x={w - 9} y={20} textAnchor="end" className={`mc-node-badge${node.kind === 'external' ? ' is-external' : ''}`}>
              {title.badge}
            </text>
          )}
          {view.rows.map((r, i) => {
            const y = (node.kind === 'client' ? 44 : 42) + i * 18;
            return (
              <g key={i}>
                {line(r[0], 10, y, 'start', 'l')}
                {down && i === 0 ? null : line(r[1], w - 10, y, 'end', 'r')}
              </g>
            );
          })}
          {down && (
            <g transform={`translate(${w - 52} 29)`}>
              <rect width={44} height={18} rx={9} className="mc-down-tag" />
              <text x={22} y={13} textAnchor="middle" className="mc-down-text">
                DOWN
              </text>
            </g>
          )}
          {view.pool && (
            <g transform={`translate(10 ${h - 12})`} aria-hidden="true">
              <rect width={w - 20} height={5} rx={2.5} className="mc-pool-track" />
              <rect
                width={view.pool.capacity > 0 ? Math.min(1, view.pool.busy / view.pool.capacity) * (w - 20) : 0}
                height={5}
                rx={2.5}
                className={`mc-pool-fill${view.pool.waiting > 0 ? ' is-crit' : view.pool.capacity > 0 && view.pool.busy / view.pool.capacity >= 0.9 ? ' is-warn' : ''}`}
              />
            </g>
          )}
        </>
      ) : (
        <>
          <text x={26} y={30} className="mc-node-name is-compact">
            {node.short}
          </text>
          <text x={12} y={h - 22} className={`mc-node-metric is-compact lvl-${view.compact.level ?? 'none'}`}>
            {view.compact.level === 'crit' ? '■ ' : view.compact.level === 'warn' ? '▲ ' : ''}
            {view.compact.text}
          </text>
        </>
      )}
    </g>
  );
}

function Markers({ prefix }: { prefix: string }) {
  return (
    <defs>
      {(['nodata', 'idle', 'ok', 'warn', 'crit'] as const).map((l) => (
        <marker
          key={l}
          id={`${prefix}-arrow-${l}`}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={9}
          markerHeight={9}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0,1 L10,5 L0,9 z" className={`mc-arrow mc-arrow-${l}`} />
        </marker>
      ))}
    </defs>
  );
}

function useNodeViews(summary: Summary | null): Record<NodeId, NodeView> {
  const services = useOps((s) => s.services);
  const loadgen = useOps((s) => s.loadgen);
  const scenarios = useOps((s) => s.scenarios);
  return useMemo(() => {
    const stats = new Map((summary?.services ?? []).map((s) => [s.service, s]));
    const health = new Map((services ?? []).map((s) => [s.service, s]));
    const scenario: ScenarioSummary | undefined = loadgen?.running
      ? scenarios?.find((s) => s.id === loadgen.scenarioId)
      : undefined;
    const out = {} as Record<NodeId, NodeView>;
    for (const n of NODES) {
      if (isServiceNode(n.id)) out[n.id] = serviceView(n, stats.get(n.id), health.get(n.id), summary != null);
      else if (n.kind === 'client') out[n.id] = customersView(loadgen, scenario ? scenario.botShare : null);
      else if (n.kind === 'queue') out[n.id] = streamView(summary);
      else out[n.id] = storeView(n, summary);
    }
    return out;
  }, [summary, services, loadgen, scenarios]);
}

interface AttentionItem {
  /** Stable across samples, so a focused chip stays on its item when the list re-sorts. */
  key: string;
  id: NodeId;
  level: 'warn' | 'crit';
  text: string;
}

/** Plain-language list of what is unhealthy right now; each item opens that node. */
function attentionItems(topo: TopologyView, summary: Summary | null): AttentionItem[] {
  if (!summary) return [];
  const items: (AttentionItem & { rank: number })[] = [];
  for (const s of summary.services) {
    if (!isNodeId(s.service)) continue;
    const id = s.service;
    if (!s.up) items.push({ key: `svc:${id}:down`, id, level: 'crit', text: `${s.service} is DOWN`, rank: 100 });
    else {
      if ((s.dbPool?.waiting ?? 0) > 0) {
        items.push({ key: `svc:${id}:pool`, id, level: 'crit', text: `${s.service}: ${formatInt(s.dbPool!.waiting)} queries waiting for a DB connection`, rank: 60 });
      }
      if (serviceLevels.loopLagMs(s.eventLoopLagMs) === 'crit') {
        items.push({ key: `svc:${id}:lag`, id, level: 'crit', text: `${s.service}: event loop blocked (lag ${formatMs(s.eventLoopLagMs)})`, rank: 55 });
      }
      if (serviceLevels.cpuPct(s.cpuPct) === 'crit') items.push({ key: `svc:${id}:cpu`, id, level: 'warn', text: `${s.service}: CPU ${formatPct(s.cpuPct)}`, rank: 30 });
    }
  }
  for (const e of topo.edges) {
    const path = `${NODE_BY_ID[e.from].label} → ${NODE_BY_ID[e.to].label}`;
    if (e.breaker) {
      items.push({ key: `breaker:${e.key}`, id: e.from, level: e.breaker === 'open' ? 'crit' : 'warn', text: `breaker ${path} ${BREAKER_TAG[e.breaker]}`, rank: e.breaker === 'open' ? 90 : 50 });
    }
    if ((e.level === 'crit' || e.level === 'warn') && e.kind !== 'stream') {
      const bits = [];
      if (e.errorPct != null && e.errorPct >= 1) bits.push(`${formatPct(e.errorPct)} errors`);
      if (e.p99Ms != null && e.p99Ms >= 500) bits.push(`p99 ${formatMs(e.p99Ms)}`);
      // A slow call shows up on the callee; a slow store on the service that is waiting for it.
      items.push({ key: `edge:${e.key}`, id: e.kind === 'store' ? e.from : e.to, level: e.level, text: `${path}: ${bits.join(' · ')}`, rank: e.level === 'crit' ? 70 : 40 });
    }
  }
  const st = summary.stream;
  if (st && (st.lag >= 100 || st.dlq > 0)) {
    const level = st.lag >= 2000 ? 'crit' : 'warn';
    items.push({ key: 'stream', id: 'stream', level, text: `order events: lag ${formatInt(st.lag)}${st.dlq > 0 ? ` · ${formatInt(st.dlq)} in the DLQ` : ''}`, rank: level === 'crit' ? 65 : 35 });
  }
  // Severity, then a fixed order: items move only when their severity changes, not with traffic jitter.
  return items.sort((x, y) => y.rank - x.rank || x.key.localeCompare(y.key));
}

/** Needs attention shows this many items, then "+N more". */
const ATTENTION_SHOWN = 7;

/** Width of the map, in viewBox units, that the overlay panel covers. */
function panelCover(mapWidth: number | null): number {
  const w = mapWidth && mapWidth > 0 ? mapWidth : MAP_W;
  return (Math.min(PANEL_PX, w * PANEL_MAX_SHARE) / w) * MAP_W;
}

/** The overlay panel covers this share of the map; open it on the side that hides less of the node. */
function panelSide(id: NodeId, mapWidth: number | null): 'left' | 'right' {
  const n = NODE_BY_ID[id];
  const cover = panelCover(mapWidth);
  const overlapRight = Math.max(0, n.x + n.w - (MAP_W - cover));
  const overlapLeft = Math.max(0, cover - n.x);
  return overlapLeft < overlapRight ? 'left' : 'right';
}

/** A node the open panel hides completely (the panel's Inbound / Outbound links still reach it). */
function underPanel(n: MapNode, side: 'left' | 'right', cover: number): boolean {
  return side === 'right' ? n.x >= MAP_W - cover : n.x + n.w <= cover;
}

/** Keep in sync with .mc-details in mission.css. */
const PANEL_PX = 320;
const PANEL_MAX_SHARE = 0.46;

const STILL_KEY = 'breakcart.mc.still.v1';

export function SystemMap() {
  const summary = useOps((s) => s.summary);
  const summaryAt = useOps((s) => s.summaryAt);
  const reachable = useOps((s) => s.reachable);
  const reduced = useReducedMotion();
  const now = useNow(5000);
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const density: Density = width != null && width < COMPACT_BELOW ? 'compact' : 'full';
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [hoverNode, setHoverNode] = useState<NodeId | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  // "Pause motion": no flow particles, and (data-motion on <html>, mission.css) no blinking live dots.
  const [still, setStill] = useState(() => local.get(STILL_KEY) === '1');
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const nodeEls = useRef(new Map<NodeId, SVGGElement>());
  const buckets = useRef(new Map<string, number>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const topo = useMemo(() => deriveTopology(summary), [summary]);
  const views = useNodeViews(summary);
  const attention = useMemo(() => attentionItems(topo, summary), [topo, summary]);

  const flows = useMemo(() => {
    const out = new Map<string, Flow>();
    for (const e of topo.edges) {
      if (e.rps == null || e.rps < MIN_RATE) {
        buckets.current.delete(e.key);
        continue;
      }
      const b = flowBucket(e.rps, buckets.current.get(e.key));
      buckets.current.set(e.key, b);
      out.set(e.key, flowFor(b, e.geo.length));
    }
    return out;
  }, [topo]);

  const focusNode = hoverNode ?? selected;
  const edges = useMemo(
    () => [...topo.edges].sort((x, y) => LEVEL_RANK[visualLevel(x)] - LEVEL_RANK[visualLevel(y)]),
    [topo],
  );

  const register = useCallback((id: NodeId, el: SVGGElement | null) => {
    if (el) nodeEls.current.set(id, el);
    else nodeEls.current.delete(id);
  }, []);

  const select = useCallback((id: NodeId) => setSelected((cur) => (cur === id ? null : id)), []);

  const close = useCallback(() => {
    // Hand focus back to the node whose details were open.
    if (selected) nodeEls.current.get(selected)?.focus();
    setSelected(null);
  }, [selected]);

  useEffect(() => {
    if (selected) headingRef.current?.focus();
  }, [selected]);

  // Escape also works after a click on empty map space (which leaves focus on <body>). The node
  // and panel handlers stop propagation, so this never fires twice.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const a = document.activeElement;
      if (e.key === 'Escape' && (a === document.body || a?.closest('#mc-system'))) setSelected(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const toggleStill = () => {
    const v = !still;
    setStill(v);
    local.set(STILL_KEY, v ? '1' : '0');
  };

  useEffect(() => {
    const root = document.documentElement;
    if (still) root.dataset.motion = 'still';
    else delete root.dataset.motion;
    return () => {
      delete root.dataset.motion;
    };
  }, [still]);

  // Nodes the open panel hides completely leave the Tab order.
  const side = selected ? panelSide(selected, width) : null;
  const cover = panelCover(width);
  const focusable = (n: MapNode) => side == null || density !== 'full' || !underPanel(n, side, cover);

  // The particles animate every frame: stop the SVG's clock while the map is scrolled out of view.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1]?.isIntersecting) svg.unpauseAnimations();
      else svg.pauseAnimations();
    });
    io.observe(svg);
    return () => io.disconnect();
  }, []);

  const isHot = (e: EdgeView) => hoverEdge === e.key || (focusNode != null && (e.from === focusNode || e.to === focusNode));
  const showLabel = (e: EdgeView) => {
    if (density === 'compact' || e.rps == null) return false;
    if (isHot(e) || e.breaker) return true;
    if (e.kind === 'store') return e.level === 'warn' || e.level === 'crit';
    return e.rps >= 1;
  };

  const missing = !summary ? null : !topo.has.edges || !topo.has.stores || !topo.has.stream;
  const stale = summaryAt != null && now - summaryAt > 10_000;

  return (
    <Panel
      id="mc-system"
      title="The system, live"
      subtitle={
        summary
          ? `edges = calls/s · colour = health · dots = flow${stale ? ` · last sample ${relativeTime(summaryAt, now)}` : ''}`
          : 'waiting for /control/summary…'
      }
      className="mc-map-panel"
      actions={
        <button
          type="button"
          className="chip-btn"
          aria-pressed={still}
          onClick={toggleStill}
          title="Stop the flow dots on the map and the blinking live indicators"
        >
          Pause motion
        </button>
      }
    >
      {missing && (
        <p className="mc-note" role="note">
          <span aria-hidden="true">ℹ</span> Edge metrics need a newer control plane — showing the architecture with
          service metrics{topo.has.edges ? '' : '; only customers → gateway is live'}.
        </p>
      )}
      <section className="mc-attention" aria-labelledby={`${uid}-att`}>
        <h3 id={`${uid}-att`}>Needs attention</h3>
        {!summary ? (
          <span className="muted small">no data yet</span>
        ) : attention.length === 0 ? (
          <span className="mc-attention-ok">
            <span aria-hidden="true">✓</span>{' '}
            {summary.gateway.rps >= 0.5 ? 'every edge and service is healthy' : 'nothing unhealthy (and little traffic)'}
          </span>
        ) : (
          <ul>
            {attention.slice(0, ATTENTION_SHOWN).map((it) => (
              <li key={it.key}>
                <button type="button" className={`mc-attention-item lvl-${it.level}`} onClick={() => setSelected(it.id)}>
                  <span aria-hidden="true">{it.level === 'crit' ? '■' : '▲'}</span> {it.text}
                </button>
              </li>
            ))}
            {attention.length > ATTENTION_SHOWN && (
              <li className="mc-attention-more muted small">+{attention.length - ATTENTION_SHOWN} more — see the map</li>
            )}
          </ul>
        )}
      </section>
      <div
        className={`mc-map-wrap${selected ? ' has-details' : ''}`}
        onKeyDown={(e) => {
          // Escape on a map node closes the panel too, leaving focus where it is (the panel handles its own).
          if (e.key === 'Escape' && selected) {
            e.stopPropagation();
            setSelected(null);
          }
        }}
      >
        <div ref={measure} className="mc-map-measure">
          <svg
            ref={svgRef}
            className={`mc-map-svg is-${density}`}
            viewBox={`0 0 ${MAP_W} ${MAP_H}`}
            role="group"
            aria-labelledby={`${uid}-title`}
            aria-describedby={`${uid}-desc`}
          >
            <title id={`${uid}-title`}>System map</title>
            <desc id={`${uid}-desc`}>
              Customers reach the gateway, which calls recommendations, catalog, cart, inventory and orders. Orders calls
              catalog, cart, inventory and the external payment provider, and publishes order events that the workers
              consume. Services read and write Redis and Postgres. Line colour shows health, line width shows traffic.
              Each service is a button that opens its details.
            </desc>
            <Markers prefix={uid} />
            <g className="mc-edges">
              {edges.map((e) => {
                const level = visualLevel(e);
                const hot = isHot(e);
                return (
                  <g
                    key={e.key}
                    className={`mc-edge mc-edge-${level}${e.breaker ? ' is-broken' : ''}${hot ? ' is-hot' : ''}${focusNode && !hot ? ' is-dim' : ''}`}
                    onMouseEnter={() => setHoverEdge(e.key)}
                    onMouseLeave={() => setHoverEdge((k) => (k === e.key ? null : k))}
                  >
                    <title>{edgeSummary(e)}</title>
                    <path className="mc-edge-hit" d={e.geo.d} />
                    <path
                      className="mc-edge-line"
                      d={e.geo.d}
                      strokeWidth={edgeWidth(e.rps)}
                      markerEnd={`url(#${uid}-arrow-${level})`}
                    />
                  </g>
                );
              })}
            </g>
            {!(reduced || still) && (
              <g className={`mc-flows${focusNode ? ' is-focused' : ''}`} aria-hidden="true">
                {edges.map((e) => {
                  const flow = flows.get(e.key);
                  if (!flow) return null;
                  return (
                    <g key={`${e.key}-${flow.bucket}`} className={focusNode && !isHot(e) ? 'is-dim' : undefined}>
                      <Particles e={e} flow={flow} />
                    </g>
                  );
                })}
              </g>
            )}
            <g className="mc-nodes">
              {NODES.map((n) => (
                <NodeCard
                  key={n.id}
                  node={n}
                  view={views[n.id]}
                  density={density}
                  selected={selected === n.id}
                  hot={focusNode === n.id}
                  dim={focusNode != null && focusNode !== n.id && !topo.edges.some((e) => (e.from === focusNode && e.to === n.id) || (e.to === focusNode && e.from === n.id))}
                  focusable={focusable(n)}
                  onSelect={select}
                  onHover={setHoverNode}
                  register={register}
                />
              ))}
            </g>
            <g className="mc-labels" aria-hidden="true">
              {edges.map((e) => (showLabel(e) ? <EdgeLabel key={e.key} e={e} hot={isHot(e)} /> : null))}
            </g>
          </svg>
          {!summary && (
            <div className="mc-map-overlay" role="status">
              {reachable === false ? (
                <>
                  <strong>
                    <span aria-hidden="true">■</span> Control plane unreachable
                  </strong>
                  <span>The map lights up again as soon as /control/summary answers.</span>
                </>
              ) : (
                <span>
                  <span className="spinner spinner-sm" aria-hidden="true" /> Waiting for the first sample…
                </span>
              )}
            </div>
          )}
        </div>
        {selected && (
          <NodeDetails
            id={selected}
            topo={topo}
            onClose={close}
            headingRef={headingRef}
            onSelect={setSelected}
            side={side ?? 'right'}
          />
        )}
      </div>
      <MapLegend />
    </Panel>
  );
}

function MapLegend() {
  const item = (cls: string, label: string, dashed = false) => (
    <li>
      <svg width="26" height="10" aria-hidden="true">
        <line x1="1" y1="5" x2="25" y2="5" className={`mc-legend-line ${cls}`} strokeDasharray={dashed ? '5 3' : undefined} />
      </svg>
      {label}
    </li>
  );
  return (
    <ul className="mc-legend" aria-label="Map legend">
      {item('mc-edge-ok', 'healthy')}
      {item('mc-edge-warn', '▲ ≥ 1% errors or p99 ≥ 500 ms')}
      {item('mc-edge-crit', '■ ≥ 5% errors or p99 ≥ 2 s')}
      {item('mc-edge-crit', 'breaker open', true)}
      {item('mc-edge-idle', 'no traffic')}
      <li className="muted">width = traffic (log) · dots = direction</li>
    </ul>
  );
}
