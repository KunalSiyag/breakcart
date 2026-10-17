import type { Chaos, Flags, Tuning, ServiceChaos, ServiceName, PaymentsChaos, DataChaos } from './defs';

/** A partial runtime change (applied by the control plane). */
export interface RuntimePatch {
  flags?: Partial<Flags>;
  chaos?: {
    services?: Partial<Record<ServiceName, Partial<ServiceChaos>>>;
    payments?: Partial<PaymentsChaos>;
    data?: Partial<DataChaos>;
  };
  tuning?: Partial<Tuning>;
}

export interface Phase {
  name: string;
  durationSec: number;
  /** Session arrival rate (new visitors per second) at multiplier 1, linearly interpolated. */
  fromRate: number;
  toRate: number;
}

export interface Behaviour {
  /** Probability a shopper goes straight for a flash deal (vs browsing the catalog). */
  hotFocus: number;
  searchProb: number;
  addToCartProb: number;
  /** Probability a shopper adds a second (hot) item — two hot SKUs in random order fuels deadlocks. */
  multiItemProb: number;
  checkoutProb: number;
  /** Probability the shopper completes payment after checkout (the rest abandon with stock held). */
  payProb: number;
  couponProb: number;
  /** Double-click on "Place order"/"Pay" (two identical concurrent requests). */
  doubleClickProb: number;
  /** Refresh immediately when a page is slow or errors. */
  rageRetryProb: number;
  /** Median think time between steps. */
  thinkMs: number;
  /** A shopper gives up on a page after this long. */
  patienceMs: number;
  /** Share of returning visitors (reuse an existing session token). */
  returningProb: number;
  /** Restrict "hot" picks to these deal ids (default: all 12, weighted by demand). */
  hotProducts?: number[];
  /** Probability of a third item when a second was added. */
  thirdItemProb?: number;
}

export const DEFAULT_BEHAVIOUR: Behaviour = {
  hotFocus: 0.5,
  searchProb: 0.35,
  addToCartProb: 0.55,
  multiItemProb: 0.15,
  checkoutProb: 0.7,
  payProb: 0.8,
  couponProb: 0.25,
  doubleClickProb: 0.08,
  rageRetryProb: 0.5,
  thinkMs: 1800,
  patienceMs: 12_000,
  returningProb: 0.6,
};

export interface TimelineEvent {
  atSec: number;
  description: string;
  patch?: RuntimePatch;
  action?: { name: string; body?: Record<string, unknown> };
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  phases: Phase[];
  /** Sale goes live this many seconds after the scenario starts (null = already live). */
  saleStartsAtSec: number | null;
  /** Share of arriving sessions that are scalper bots. */
  botShare: number;
  behaviour?: Partial<Behaviour>;
  timeline: TimelineEvent[];
}

const steady = (sec: number, rate: number, name = 'steady'): Phase => ({ name, durationSec: sec, fromRate: rate, toRate: rate });

export const SCENARIOS: Scenario[] = [
  {
    id: 'normal-day',
    name: 'A normal Tuesday',
    description: 'Baseline traffic with no sale frenzy. Use it to learn what "healthy" looks like on every dashboard before breaking anything.',
    phases: [steady(300, 15)],
    saleStartsAtSec: null,
    botShare: 0,
    behaviour: { hotFocus: 0.15, thinkMs: 2500 },
    timeline: [],
  },
  {
    id: 'midnight-flash-sale',
    name: 'Big Billion Day — midnight drop',
    description:
      'Shoppers gather before midnight refreshing the home page, then everyone hits the same dozen deals the second the sale goes live. Arrival rate jumps from 60 to 260 new shoppers a second in 30 seconds.',
    phases: [
      { name: 'pre-sale crowd', durationSec: 60, fromRate: 25, toRate: 60 },
      { name: 'midnight spike', durationSec: 30, fromRate: 60, toRate: 260 },
      { name: 'peak', durationSec: 120, fromRate: 260, toRate: 200 },
      { name: 'long tail', durationSec: 90, fromRate: 200, toRate: 60 },
    ],
    saleStartsAtSec: 60,
    botShare: 0.05,
    behaviour: { hotFocus: 0.75, thinkMs: 1200, patienceMs: 10_000 },
    timeline: [{ atSec: 60, description: '00:00:00 — sale is live, deal prices switch on' }],
  },
  {
    id: 'lightning-deals',
    name: 'Prime Day — lightning deals',
    description: 'Calm periods punctuated by 20-second waves when a lightning deal drops its price. Each wave changes a price live — caches must keep up.',
    phases: [
      steady(40, 40, 'calm'),
      { name: 'deal wave 1', durationSec: 20, fromRate: 220, toRate: 180 },
      steady(40, 40, 'calm'),
      { name: 'deal wave 2', durationSec: 20, fromRate: 220, toRate: 180 },
      steady(40, 40, 'calm'),
      { name: 'deal wave 3', durationSec: 20, fromRate: 220, toRate: 180 },
      steady(30, 40, 'cool-down'),
    ],
    saleStartsAtSec: null,
    botShare: 0.03,
    behaviour: { hotFocus: 0.8, thinkMs: 1500 },
    timeline: [
      { atSec: 40, description: 'Lightning deal: Aurora Buds drop to ₹6,999', action: { name: 'price-change', body: { productId: 6, dealPriceCents: 699_900 } } },
      { atSec: 100, description: 'Lightning deal: Air Fryer drops to ₹2,999', action: { name: 'price-change', body: { productId: 8, dealPriceCents: 299_900 } } },
      { atSec: 160, description: 'Lightning deal: Aurora Buds drop to ₹5,999', action: { name: 'price-change', body: { productId: 6, dealPriceCents: 599_900 } } },
    ],
  },
  {
    id: 'singles-day',
    name: "Singles' Day 11.11 — the wall",
    description: 'A near-vertical step: 20 → 450 sessions/s in ten seconds at 00:00. Nothing autoscales that fast; only admission control survives.',
    phases: [
      steady(30, 20, 'warm-up'),
      { name: 'the wall', durationSec: 10, fromRate: 20, toRate: 450 },
      steady(90, 400, 'peak'),
      { name: 'decay', durationSec: 50, fromRate: 400, toRate: 80 },
    ],
    saleStartsAtSec: 30,
    botShare: 0.05,
    behaviour: { hotFocus: 0.85, thinkMs: 900, patienceMs: 8000 },
    timeline: [{ atSec: 30, description: '11.11 00:00 — sale live' }],
  },
  {
    id: 'bot-army',
    name: 'Sneaker drop — bot army',
    description: 'A limited drop where 60% of arrivals are scalper bots that skip browsing and hammer add-to-cart and checkout for the hottest SKUs.',
    phases: [steady(20, 40, 'pre-drop'), { name: 'drop', durationSec: 120, fromRate: 160, toRate: 120 }, steady(40, 40, 'aftermath')],
    saleStartsAtSec: 20,
    botShare: 0.6,
    behaviour: { hotFocus: 0.95, thinkMs: 1400 },
    timeline: [{ atSec: 20, description: 'Drop is live' }],
  },
  {
    id: 'festival-combos',
    name: 'Festival combo rush',
    description:
      'Diwali-style bundle offers: shoppers put two or three of the same high-stock deals in their cart, in whatever order they click. Sustained contention on a handful of stock rows.',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 80 }, steady(160, 80, 'rush')],
    saleStartsAtSec: null,
    botShare: 0,
    behaviour: { hotFocus: 0.95, multiItemProb: 0.85, thirdItemProb: 0.5, addToCartProb: 0.85, checkoutProb: 0.9, hotProducts: [6, 7, 8, 9], thinkMs: 900 },
    timeline: [],
  },
  {
    id: 'steady-peak',
    name: 'Sustained peak (soak)',
    description: 'Ten minutes at a high, flat rate. Slow leaks, unbounded queues and pool creep show up here, not in short spikes.',
    phases: [{ name: 'ramp', durationSec: 30, fromRate: 20, toRate: 140 }, steady(570, 140, 'soak')],
    saleStartsAtSec: null,
    botShare: 0.02,
    behaviour: { hotFocus: 0.5 },
    timeline: [],
  },
  /* ------------------------------------------------------------ game days */
  {
    id: 'gameday-psp-brownout',
    name: 'Game day — payment provider brownout',
    description: 'At T+60s the PSP slows to a crawl and 25% of charges respond after your timeout (but still charge the card). At T+180s it recovers.',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 100 }, steady(220, 100, 'peak')],
    saleStartsAtSec: null,
    botShare: 0,
    behaviour: { hotFocus: 0.6, checkoutProb: 0.85, payProb: 0.95 },
    timeline: [
      {
        atSec: 60,
        description: 'PSP brownout: median 2.5s, p99 9s, 25% late responses',
        patch: { chaos: { payments: { medianMs: 2500, p99Ms: 9000, lateResponsePct: 25, lateResponseMs: 12_000 } } },
      },
      { atSec: 180, description: 'PSP recovers', patch: { chaos: { payments: { medianMs: 120, p99Ms: 600, lateResponsePct: 0 } } } },
    ],
  },
  {
    id: 'gameday-redis-blip',
    name: 'Game day — Redis blip',
    description: 'Redis becomes unreachable for 20 seconds at peak. What does each dependency do: fail open, fail closed, or fall over?',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 100 }, steady(160, 100, 'peak')],
    saleStartsAtSec: null,
    botShare: 0,
    timeline: [
      {
        atSec: 60,
        description: 'Redis unreachable from gateway, catalog, cart, orders',
        patch: { chaos: { services: { gateway: { redisDown: true }, catalog: { redisDown: true }, cart: { redisDown: true }, orders: { redisDown: true } } } },
      },
      {
        atSec: 80,
        description: 'Redis back',
        patch: { chaos: { services: { gateway: { redisDown: false }, catalog: { redisDown: false }, cart: { redisDown: false }, orders: { redisDown: false } } } },
      },
    ],
  },
  {
    id: 'gameday-bad-deploy',
    name: 'Game day — bad deploy at peak',
    description: 'Someone ships during the sale: catalog restarts (cold caches), then orders crashes mid-payment.',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 120 }, steady(220, 120, 'peak')],
    saleStartsAtSec: null,
    botShare: 0.02,
    behaviour: { hotFocus: 0.7 },
    timeline: [
      { atSec: 60, description: 'Deploy: catalog restarts', action: { name: 'kill-service', body: { target: 'catalog' } } },
      { atSec: 61, description: 'Cache cluster flushed by the deploy script', action: { name: 'flush-cache' } },
      { atSec: 140, description: 'orders crashes (OOM)', action: { name: 'kill-service', body: { target: 'orders' } } },
    ],
  },
  {
    id: 'gameday-slow-recs',
    name: 'Game day — recommendations slow down',
    description: 'The recommendations service starts taking 8 seconds per call. It is "non-critical". Is it?',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 100 }, steady(200, 100, 'peak')],
    saleStartsAtSec: null,
    botShare: 0,
    timeline: [
      { atSec: 45, description: 'recommendations: +8s latency', patch: { chaos: { services: { recommendations: { latencyMs: 8000 } } } } },
      { atSec: 165, description: 'recommendations recovered', patch: { chaos: { services: { recommendations: { latencyMs: 0 } } } } },
    ],
  },
  {
    id: 'gameday-db-degradation',
    name: 'Game day — database degradation',
    description: 'A noisy neighbour / vacuum / failover makes 30% of queries on inventory and orders take +300ms. Watch pools drain.',
    phases: [{ name: 'ramp', durationSec: 20, fromRate: 20, toRate: 100 }, steady(200, 100, 'peak')],
    saleStartsAtSec: null,
    botShare: 0,
    timeline: [
      {
        atSec: 60,
        description: 'DB degradation: +300ms on 30% of inventory & orders queries',
        patch: { chaos: { services: { inventory: { dbSlowMs: 300, dbSlowPct: 30 }, orders: { dbSlowMs: 300, dbSlowPct: 30 } } } },
      },
      {
        atSec: 160,
        description: 'DB recovered',
        patch: { chaos: { services: { inventory: { dbSlowMs: 0, dbSlowPct: 0 }, orders: { dbSlowMs: 0, dbSlowPct: 0 } } } },
      },
    ],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function scenarioDuration(s: Scenario): number {
  return s.phases.reduce((t, p) => t + p.durationSec, 0);
}

/** Target arrival rate (sessions/s, multiplier 1) and phase at `t` seconds into the scenario. */
export function rateAt(s: Scenario, t: number): { rate: number; phase: string | null } {
  let start = 0;
  for (const p of s.phases) {
    if (t < start + p.durationSec) {
      const f = p.durationSec > 0 ? (t - start) / p.durationSec : 0;
      return { rate: p.fromRate + (p.toRate - p.fromRate) * f, phase: p.name };
    }
    start += p.durationSec;
  }
  return { rate: 0, phase: null };
}

export function summarizeScenario(s: Scenario) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    durationSec: scenarioDuration(s),
    saleStartsAtSec: s.saleStartsAtSec,
    botShare: s.botShare,
    phases: s.phases,
    timeline: s.timeline.map((e) => ({ atSec: e.atSec, description: e.description })),
  };
}

// Re-exported for convenience in patches.
export type { Chaos };
