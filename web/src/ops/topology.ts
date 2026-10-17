import type { BreakerState, ServiceStats, StoreStats, Summary } from '../api/types';

/**
 * Mission Control's system map. The layout is FIXED (hand-placed, never force-directed),
 * so nothing moves between samples and a learner can build a mental model of where the
 * traffic goes. Coordinates are SVG viewBox units; the map scales to its container.
 *
 *   row A   customers → gateway                                  payments (external PSP)
 *   row B   recommendations · catalog · cart · inventory · orders     (gateway fans out)
 *           intra-service calls arc underneath row B
 *   row C   Redis · Postgres · workers ← order events (stream) ← orders
 *
 * Store links are S-curves from each service down to its store; their end points are
 * ordered by source position so they cross as little as possible.
 */

export const MAP_W = 840;
export const MAP_H = 616;

/** Traffic below this is a probe or a straggler (the control plane drops such edges too). */
export const MIN_RATE = 0.05;

export type NodeId =
  | 'customers'
  | 'gateway'
  | 'payments'
  | 'recommendations'
  | 'catalog'
  | 'cart'
  | 'inventory'
  | 'orders'
  | 'redis'
  | 'postgres'
  | 'workers'
  | 'stream';

export type NodeKind = 'client' | 'service' | 'external' | 'queue' | 'store';

export interface MapNode {
  id: NodeId;
  kind: NodeKind;
  label: string;
  /** Label for the compact (phone) rendering. */
  short: string;
  /** One-line role, shown in the details panel and the accessible name. */
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ROW_B = 190;
const ROW_C = 476;

export const NODES: readonly MapNode[] = [
  { id: 'customers', kind: 'client', label: 'Customers', short: 'Shoppers', role: 'Simulated shoppers and bots (load generator)', x: 14, y: 24, w: 152, h: 76 },
  { id: 'gateway', kind: 'service', label: 'gateway', short: 'gateway', role: 'Edge / BFF: auth, rate limits, waiting room, fan-out', x: 292, y: 12, w: 196, h: 100 },
  { id: 'payments', kind: 'external', label: 'payments', short: 'payments', role: 'Payment provider (external PSP, simulated)', x: 636, y: 12, w: 192, h: 100 },
  { id: 'recommendations', kind: 'service', label: 'recommendations', short: 'recs', role: 'Non-critical “you may also like”', x: 10, y: ROW_B, w: 150, h: 100 },
  { id: 'catalog', kind: 'service', label: 'catalog', short: 'catalog', role: 'Products, deals, prices, search (cached)', x: 177, y: ROW_B, w: 150, h: 100 },
  { id: 'cart', kind: 'service', label: 'cart', short: 'cart', role: 'Shopping carts (Redis), priced via catalog', x: 345, y: ROW_B, w: 150, h: 100 },
  { id: 'inventory', kind: 'service', label: 'inventory', short: 'inventory', role: 'Stock and reservations', x: 513, y: ROW_B, w: 150, h: 100 },
  { id: 'orders', kind: 'service', label: 'orders', short: 'orders', role: 'Checkout + payment orchestration', x: 680, y: ROW_B, w: 150, h: 100 },
  { id: 'redis', kind: 'store', label: 'Redis', short: 'Redis', role: 'Cache, sessions, carts, rate limits, queue', x: 20, y: ROW_C, w: 182, h: 100 },
  { id: 'postgres', kind: 'store', label: 'Postgres', short: 'Postgres', role: 'Orders, stock, catalog — the source of truth', x: 240, y: ROW_C, w: 182, h: 100 },
  { id: 'workers', kind: 'service', label: 'workers', short: 'workers', role: 'Fulfillment consumers of order events', x: 468, y: ROW_C, w: 152, h: 100 },
  { id: 'stream', kind: 'queue', label: 'order events', short: 'events', role: 'Redis stream between orders and workers', x: 668, y: ROW_C, w: 162, h: 100 },
];

export const NODE_BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<NodeId, MapNode>;

export function isNodeId(v: string): v is NodeId {
  return Object.prototype.hasOwnProperty.call(NODE_BY_ID, v);
}

/** Nodes backed by a `summary.services[]` entry of the same name. */
export function isServiceNode(id: NodeId): boolean {
  const k = NODE_BY_ID[id].kind;
  return k === 'service' || k === 'external';
}

/* ------------------------------------------------------------------ routes */

type Side = 'top' | 'bottom' | 'left' | 'right';
type Dir = 'up' | 'down' | 'left' | 'right';
type Vec = readonly [number, number];

interface Anchor {
  side: Side;
  /** 0..1 along the side (left → right, top → bottom). */
  at: number;
}

interface RouteSpec {
  from: Anchor;
  to: Anchor;
  /** Way points (with the travel direction there) to thread a link through a gap. */
  via?: { x: number; y: number; dir: Dir }[];
  /** Handle length for U-shaped arcs (both ends on the same side). */
  bend?: number;
  /** Label position as a fraction of the path length, and its offset / alignment. */
  labelAt?: number;
  labelDx?: number;
  labelDy?: number;
  labelAnchor?: 'start' | 'middle' | 'end';
}

export type EdgeKind = 'http' | 'store' | 'stream';

interface TopoEdge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  route: RouteSpec;
  /** Only one flag mode uses this link: drawn while it reports traffic, never as an idle line. */
  optional?: boolean;
}

const a = (side: Side, at: number): Anchor => ({ side, at });

/** The gaps in row B that long links are threaded through. */
const GAP_RECS_CATALOG = 168.5;
const GAP_INVENTORY_ORDERS = 671.5;

const TOPOLOGY: readonly TopoEdge[] = [
  // the request path
  { from: 'customers', to: 'gateway', kind: 'http', route: { from: a('right', 0.5), to: a('left', 0.4), labelDy: -9 } },
  { from: 'gateway', to: 'recommendations', kind: 'http', route: { from: a('bottom', 0.1), to: a('top', 0.62), labelAt: 0.5, labelDx: -7, labelAnchor: 'end' } },
  { from: 'gateway', to: 'catalog', kind: 'http', route: { from: a('bottom', 0.3), to: a('top', 0.6), labelAt: 0.62, labelDx: -6, labelAnchor: 'end' } },
  { from: 'gateway', to: 'cart', kind: 'http', route: { from: a('bottom', 0.5), to: a('top', 0.5), labelAt: 0.55, labelDx: 6, labelAnchor: 'start' } },
  { from: 'gateway', to: 'inventory', kind: 'http', route: { from: a('bottom', 0.7), to: a('top', 0.4), labelAt: 0.62, labelDx: 6, labelAnchor: 'start' } },
  { from: 'gateway', to: 'orders', kind: 'http', route: { from: a('bottom', 0.9), to: a('top', 0.3), labelAt: 0.25, labelDx: 7, labelDy: -7, labelAnchor: 'start' } },
  { from: 'orders', to: 'payments', kind: 'http', route: { from: a('top', 0.75), to: a('bottom', 0.815), labelAt: 0.6, labelDx: -8, labelAnchor: 'end' } },
  // service → service calls, nested arcs under row B (outer arcs are deeper, so none cross)
  { from: 'cart', to: 'catalog', kind: 'http', route: { from: a('bottom', 0.25), to: a('bottom', 0.76), bend: 36, labelDy: 13 } },
  { from: 'orders', to: 'inventory', kind: 'http', route: { from: a('bottom', 0.25), to: a('bottom', 0.75), bend: 36, labelAt: 0.5, labelDx: 7, labelAnchor: 'start' } },
  { from: 'orders', to: 'cart', kind: 'http', route: { from: a('bottom', 0.45), to: a('bottom', 0.6), bend: 66, labelDy: 13 } },
  { from: 'orders', to: 'catalog', kind: 'http', route: { from: a('bottom', 0.62), to: a('bottom', 0.4), bend: 100, labelDy: 13 } },
  // async: orders → stream → workers
  { from: 'orders', to: 'stream', kind: 'stream', route: { from: a('bottom', 0.88), to: a('top', 0.889), labelAt: 0.7, labelDx: -7, labelAnchor: 'end' } },
  { from: 'stream', to: 'workers', kind: 'stream', route: { from: a('left', 0.5), to: a('right', 0.5), labelDy: -8 } },
  // Redis users (end points ordered by source x)
  { from: 'recommendations', to: 'redis', kind: 'store', route: { from: a('bottom', 0.3), to: a('top', 0.2) } },
  {
    from: 'gateway',
    to: 'redis',
    kind: 'store',
    route: {
      from: a('left', 0.85),
      to: a('top', 0.4),
      via: [
        { x: GAP_RECS_CATALOG, y: ROW_B, dir: 'down' },
        { x: GAP_RECS_CATALOG, y: ROW_B + 112, dir: 'down' },
      ],
      // below row B, beside its own line (at 0.5 it sat on catalog's card)
      labelAt: 0.65,
      labelDx: 6,
      labelAnchor: 'start',
    },
  },
  { from: 'catalog', to: 'redis', kind: 'store', route: { from: a('bottom', 0.12), to: a('top', 0.55) } },
  { from: 'cart', to: 'redis', kind: 'store', route: { from: a('bottom', 0.08), to: a('top', 0.72) } },
  // inventory uses Redis only with inventory.reserve = redis_lua
  { from: 'inventory', to: 'redis', kind: 'store', optional: true, route: { from: a('bottom', 0.1), to: a('top', 0.81) } },
  { from: 'orders', to: 'redis', kind: 'store', route: { from: a('bottom', 0.04), to: a('top', 0.9) } },
  { from: 'workers', to: 'redis', kind: 'store', route: { from: a('bottom', 0.2), to: a('bottom', 0.8), bend: 30, labelDy: 12 } },
  // Postgres users
  { from: 'recommendations', to: 'postgres', kind: 'store', route: { from: a('bottom', 0.75), to: a('top', 0.1) } },
  { from: 'catalog', to: 'postgres', kind: 'store', route: { from: a('bottom', 0.58), to: a('top', 0.3) } },
  { from: 'inventory', to: 'postgres', kind: 'store', route: { from: a('bottom', 0.3), to: a('top', 0.52), labelAt: 0.5, labelDy: 13 } },
  {
    from: 'payments',
    to: 'postgres',
    kind: 'store',
    route: {
      from: a('bottom', (GAP_INVENTORY_ORDERS - 636) / 192),
      to: a('top', 0.72),
      via: [
        { x: GAP_INVENTORY_ORDERS, y: ROW_B, dir: 'down' },
        { x: GAP_INVENTORY_ORDERS, y: ROW_B + 112, dir: 'down' },
      ],
      // Near the Postgres end: at the default 0.5 it lands on the parallel orders → Postgres label.
      labelAt: 0.9,
    },
  },
  // label at 0.4: clear of the orders → catalog arc's label
  { from: 'orders', to: 'postgres', kind: 'store', route: { from: a('bottom', 0.13), to: a('top', 0.9), labelAt: 0.4 } },
  { from: 'workers', to: 'postgres', kind: 'store', route: { from: a('left', 0.4), to: a('right', 0.4), labelDy: -8 } },
];

/* ------------------------------------------------------------------ geometry */

export interface EdgeGeometry {
  d: string;
  length: number;
  /** `stack`: extra label lines go above (labels over a line), below (under an arc) or around a side label. */
  label: { x: number; y: number; anchor: 'start' | 'middle' | 'end'; stack: 'up' | 'down' | 'center' };
}

const NORMAL: Record<Side, Vec> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const DIRS: Record<Dir, Vec> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function anchorPoint(n: MapNode, an: Anchor): Vec {
  switch (an.side) {
    case 'top':
      return [n.x + n.w * an.at, n.y];
    case 'bottom':
      return [n.x + n.w * an.at, n.y + n.h];
    case 'left':
      return [n.x, n.y + n.h * an.at];
    case 'right':
      return [n.x + n.w, n.y + n.h * an.at];
  }
}

const f = (v: number) => (Math.round(v * 10) / 10).toString();

function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return [b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]];
}

/**
 * A chain of cubic Béziers through the anchors and way points. Each handle follows the
 * travel direction at its point, sized by the distance covered along that direction, so
 * S-curves stay smooth and straight runs stay straight.
 */
function buildGeometry(from: MapNode, to: MapNode, r: RouteSpec): EdgeGeometry {
  const start = anchorPoint(from, r.from);
  const end = anchorPoint(to, r.to);
  const endNormal = NORMAL[r.to.side];
  const points: { p: Vec; dir: Vec }[] = [
    { p: start, dir: NORMAL[r.from.side] },
    ...(r.via ?? []).map((v) => ({ p: [v.x, v.y] as Vec, dir: DIRS[v.dir] })),
    { p: end, dir: [-endNormal[0], -endNormal[1]] as Vec },
  ];
  const segments: [Vec, Vec, Vec, Vec][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i]!;
    const e = points[i + 1]!;
    const dx = e.p[0] - s.p[0];
    const dy = e.p[1] - s.p[1];
    const along = (dir: Vec) => Math.abs(dx * dir[0] + dy * dir[1]);
    const handle = (dir: Vec) =>
      points.length === 2 && r.bend != null ? r.bend : Math.min(170, Math.max(10, along(dir) * 0.6));
    const ks = handle(s.dir);
    const ke = handle(e.dir);
    segments.push([
      s.p,
      [s.p[0] + s.dir[0] * ks, s.p[1] + s.dir[1] * ks],
      [e.p[0] - e.dir[0] * ke, e.p[1] - e.dir[1] * ke],
      e.p,
    ]);
  }
  let d = `M${f(start[0])},${f(start[1])}`;
  const samples: Vec[] = [start];
  for (const [p0, p1, p2, p3] of segments) {
    d += ` C${f(p1[0])},${f(p1[1])} ${f(p2[0])},${f(p2[1])} ${f(p3[0])},${f(p3[1])}`;
    for (let i = 1; i <= 32; i++) samples.push(cubicAt(p0, p1, p2, p3, i / 32));
  }
  const cum: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]!;
    const q = samples[i]!;
    cum.push(cum[i - 1]! + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const length = cum[cum.length - 1] ?? 0;
  const pointAt = (frac: number): Vec => {
    const target = length * frac;
    const i = Math.max(1, cum.findIndex((c) => c >= target));
    const lo = cum[i - 1]!;
    const hi = cum[i] ?? lo;
    const t = hi > lo ? (target - lo) / (hi - lo) : 0;
    const p = samples[i - 1]!;
    const q = samples[i] ?? p;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const lp = pointAt(r.labelAt ?? 0.5);
  const dy = r.labelDy ?? 0;
  return {
    d,
    length,
    label: {
      x: lp[0] + (r.labelDx ?? 0),
      y: lp[1] + dy,
      anchor: r.labelAnchor ?? 'middle',
      stack: dy < 0 ? 'up' : dy > 0 ? 'down' : 'center',
    },
  };
}

const edgeKey = (from: string, to: string) => `${from}>${to}`;

/** The layout never changes, so every path is computed once. */
const GEOMETRY = new Map<string, EdgeGeometry>(
  TOPOLOGY.map((e) => [edgeKey(e.from, e.to), buildGeometry(NODE_BY_ID[e.from], NODE_BY_ID[e.to], e.route)]),
);

/** Route for a call the fixed topology doesn't know about (a new dependency). */
function autoGeometry(from: MapNode, to: MapNode): EdgeGeometry {
  const fy = from.y + from.h / 2;
  const ty = to.y + to.h / 2;
  if (to.y > from.y + from.h) return buildGeometry(from, to, { from: a('bottom', 0.5), to: a('top', 0.5) });
  if (to.y + to.h < from.y) return buildGeometry(from, to, { from: a('top', 0.5), to: a('bottom', 0.5) });
  return to.x > from.x
    ? buildGeometry(from, to, { from: a('right', 0.5), to: a('left', 0.5), labelDy: fy === ty ? -8 : 0 })
    : buildGeometry(from, to, { from: a('left', 0.5), to: a('right', 0.5), labelDy: fy === ty ? -8 : 0 });
}

/* ------------------------------------------------------------------ live edges */

export type EdgeLevel = 'nodata' | 'idle' | 'ok' | 'warn' | 'crit';

export interface EdgeView {
  key: string;
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  /** null = not reported (older control plane); 0 = no traffic. */
  rps: number | null;
  p99Ms: number | null;
  errorPct: number | null;
  level: EdgeLevel;
  breaker: Exclude<BreakerState, 'closed'> | null;
  /** Not part of the fixed topology (drawn with a generic route). */
  extra: boolean;
  geo: EdgeGeometry;
}

export interface TopologyView {
  edges: EdgeView[];
  /** Which summary blocks this control plane sends. */
  has: { edges: boolean; stores: boolean; stream: boolean };
}

/** Below this a p99 is just the slowest of a handful of requests: colour by errors only. */
const MIN_RATE_FOR_P99 = 0.5;

/**
 * Edge colour. Red when errors ≥ 5% or p99 ≥ 2 s; amber when errors ≥ 1% or p99 ≥ 500 ms;
 * green otherwise. (Thresholds read as bands, so a fast edge that fails half its calls is red.)
 */
export function callLevel(rps: number | null, p99Ms: number | null, errorPct: number | null): EdgeLevel {
  if (rps == null) return 'nodata';
  if (rps < MIN_RATE) return 'idle';
  const err = errorPct ?? 0;
  const p99 = rps >= MIN_RATE_FOR_P99 ? (p99Ms ?? 0) : 0;
  if (err >= 5 || p99 >= 2000) return 'crit';
  if (err >= 1 || p99 >= 500) return 'warn';
  return 'ok';
}

/** Stream health follows the consumer lag (same bands as the war room's KPI); DLQ entries warn. */
export function streamLevel(rps: number | null, lag: number, dlq: number): EdgeLevel {
  if (rps == null) return 'nodata';
  if (lag >= 2000) return 'crit';
  if (lag >= 100 || dlq > 0) return 'warn';
  return rps < MIN_RATE ? 'idle' : 'ok';
}

export function deriveTopology(summary: Summary | null): TopologyView {
  const has = {
    edges: Array.isArray(summary?.edges),
    stores: Array.isArray(summary?.stores),
    stream: summary?.stream != null,
  };
  const calls = new Map((summary?.edges ?? []).map((e) => [edgeKey(e.from, e.to), e]));
  const stores = new Map((summary?.stores ?? []).map((s) => [edgeKey(s.service, s.store), s]));
  const breakers = new Map<string, Exclude<BreakerState, 'closed'>>();
  for (const b of summary?.breakers ?? []) if (b.state !== 'closed') breakers.set(edgeKey(b.service, b.target), b.state);
  const stream = summary?.stream;
  const edges: EdgeView[] = [];

  for (const t of TOPOLOGY) {
    const key = edgeKey(t.from, t.to);
    if (t.optional && !(t.kind === 'store' ? stores : calls).has(key)) continue;
    const geo = GEOMETRY.get(key)!;
    let rps: number | null = null;
    let p99Ms: number | null = null;
    let errorPct: number | null = null;
    let level: EdgeLevel = 'nodata';
    if (t.kind === 'http') {
      const c = calls.get(key);
      if (c) ({ rps, p99Ms, errorPct } = c);
      else if (has.edges) rps = 0;
      else if (summary && key === 'customers>gateway') {
        // An older control plane: the front door can still be drawn from the gateway's own metrics.
        rps = summary.gateway.rps;
        p99Ms = summary.gateway.p99Ms;
        errorPct = summary.gateway.errorPct;
      }
      level = callLevel(rps, p99Ms, errorPct);
    } else if (t.kind === 'store') {
      const s = stores.get(key);
      if (s) {
        rps = s.opsPerSec;
        p99Ms = s.p99Ms;
        errorPct = s.errorPct;
      } else if (has.stores) rps = 0;
      level = callLevel(rps, p99Ms, errorPct);
    } else if (stream) {
      rps = t.from === 'orders' ? stream.producedPerSec : stream.consumedPerSec;
      level = streamLevel(rps, stream.lag, t.to === 'workers' ? stream.dlq : 0);
    }
    const breaker = t.kind === 'http' ? (breakers.get(key) ?? null) : null;
    edges.push({ key, from: t.from, to: t.to, kind: t.kind, rps, p99Ms, errorPct, level, breaker, extra: false, geo });
  }

  // Calls the fixed topology doesn't know (a dependency added later) still get drawn.
  for (const [key, c] of calls) {
    if (GEOMETRY.has(key) || !isNodeId(c.from) || !isNodeId(c.to) || c.from === c.to) continue;
    edges.push({
      key,
      from: c.from,
      to: c.to,
      kind: 'http',
      rps: c.rps,
      p99Ms: c.p99Ms,
      errorPct: c.errorPct,
      level: callLevel(c.rps, c.p99Ms, c.errorPct),
      breaker: breakers.get(key) ?? null,
      extra: true,
      geo: autoGeometry(NODE_BY_ID[c.from], NODE_BY_ID[c.to]),
    });
  }
  // Same for store clients it doesn't know: drawn only while they report traffic.
  for (const [key, s] of stores) {
    if (GEOMETRY.has(key) || !isNodeId(s.service) || !isNodeId(s.store) || s.service === s.store) continue;
    edges.push({
      key,
      from: s.service,
      to: s.store,
      kind: 'store',
      rps: s.opsPerSec,
      p99Ms: s.p99Ms,
      errorPct: s.errorPct,
      level: callLevel(s.opsPerSec, s.p99Ms, s.errorPct),
      breaker: null,
      extra: true,
      geo: autoGeometry(NODE_BY_ID[s.service], NODE_BY_ID[s.store]),
    });
  }
  return { edges, has };
}

/** Line width grows with log(traffic): 1 → 2.6, 10 → 3.6, 100 → 5.4, 1000 → 7.1. */
export function edgeWidth(rps: number | null): number {
  if (rps == null || rps < MIN_RATE) return 1.25;
  return Math.min(9, Math.max(1.75, 2.1 + 1.7 * Math.log10(1 + rps)));
}

/** Flow particles: count and lap time from a traffic bucket (one bucket per doubling). */
export interface Flow {
  bucket: number;
  count: number;
  durSec: number;
}

export function flowBucket(rps: number, prev: number | undefined): number {
  const raw = Math.log2(1 + rps);
  // Hysteresis: keep the previous bucket until traffic clearly leaves it, so particles
  // don't restart every sample when a rate hovers around a boundary.
  if (prev != null && raw > prev - 0.3 && raw < prev + 1.3) return prev;
  return Math.max(0, Math.min(9, Math.floor(raw)));
}

export function flowFor(bucket: number, length: number): Flow {
  const count = bucket < 1 ? 1 : bucket < 3 ? 2 : bucket < 6 ? 3 : 4;
  const speed = 60 + 34 * bucket; // viewBox units per second
  const durSec = Math.round(Math.min(8, Math.max(0.7, length / speed)) * 10) / 10;
  return { bucket, count, durSec };
}

/* ------------------------------------------------------------------ node aggregates */

export interface StoreTotals {
  opsPerSec: number;
  p99Ms: number;
  errorPct: number;
  users: StoreStats[];
}

/** Total load on one store across services (error % weighted by ops). */
export function storeTotals(summary: Summary | null, store: 'postgres' | 'redis'): StoreTotals | null {
  if (!summary?.stores) return null;
  const users = summary.stores.filter((s) => s.store === store).sort((x, y) => y.opsPerSec - x.opsPerSec);
  const opsPerSec = users.reduce((n, s) => n + s.opsPerSec, 0);
  const errOps = users.reduce((n, s) => n + (s.opsPerSec * s.errorPct) / 100, 0);
  return {
    opsPerSec,
    p99Ms: users.reduce((m, s) => Math.max(m, s.p99Ms), 0),
    errorPct: opsPerSec > 0 ? (100 * errOps) / opsPerSec : 0,
    users,
  };
}

/**
 * Worst p99 among the store's clients busy enough for a p99 to mean something (the floor the
 * store edges use); null when none is. Colour a store's p99 by this, with the edge bands.
 */
export function storeTimedP99(t: StoreTotals): number | null {
  const timed = t.users.filter((u) => u.opsPerSec >= MIN_RATE_FOR_P99);
  return timed.length ? Math.max(...timed.map((u) => u.p99Ms)) : null;
}

/** Connections waiting for a Postgres pool slot, summed over services. */
export function poolWaiting(services: readonly ServiceStats[]): { total: number; worst: ServiceStats | null } {
  let total = 0;
  let worst: ServiceStats | null = null;
  for (const s of services) {
    const w = s.dbPool?.waiting ?? 0;
    total += w;
    if (w > 0 && (!worst || w > (worst.dbPool?.waiting ?? 0))) worst = s;
  }
  return { total, worst };
}
