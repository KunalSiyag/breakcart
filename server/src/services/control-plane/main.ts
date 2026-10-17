import { lookup } from 'node:dns/promises';
import Redis from 'ioredis';
import { request } from 'undici';
import { config } from '../../shared/config';
import { db } from '../../shared/db';
import {
  DATA_CHAOS_DEFAULTS,
  FLAGS,
  KEYS,
  PAYMENTS_CHAOS_DEFAULTS,
  SERVICE_CHAOS_DEFAULTS,
  SERVICES,
  TUNING_DEFAULTS,
  TUNING_HELP,
} from '../../shared/defs';
import { emitEvent, type TimelineEvent } from '../../shared/events';
import type { Journey } from '../../loadgen/journey';
import { labById, LABS } from '../../shared/labs';
import { logger } from '../../shared/logger';
import { m } from '../../shared/metrics';
import { isLive, type SaleState } from '../../shared/sale';
import { scenarioById, SCENARIOS, summarizeScenario, type RuntimePatch, type TimelineEvent as ScenarioEvent } from '../../shared/scenarios';
import { runService } from '../../shared/server';
import { HttpError, sleep } from '../../shared/util';
import { checkIntegrity, publishIntegrity, resetIntegrityBaseline, type Integrity } from './integrity';
import { RuntimeStore } from './store';
import { buildSummary, promRaw, type ServiceHealth } from './summary';

// The control plane talks to Redis directly — it must keep working while chaos breaks the data path.
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
const sub = new Redis(config.redisUrl);
const store = new RuntimeStore(redis);

const SERVICE_PORTS: Record<string, string> = {
  gateway: config.urls.gateway,
  catalog: config.urls.catalog,
  inventory: config.urls.inventory,
  cart: config.urls.cart,
  orders: config.urls.orders,
  payments: config.urls.payments,
  recommendations: config.urls.recommendations,
  workers: config.urls.workers,
  loadgen: config.urls.loadgen,
};
const KILLABLE = new Set(['gateway', 'catalog', 'inventory', 'cart', 'orders', 'payments', 'recommendations', 'workers']);

/** Every instance of a service (Docker DNS returns one A record per replica). */
async function instancesOf(baseUrl: string): Promise<string[]> {
  const u = new URL(baseUrl);
  try {
    const addrs = await lookup(u.hostname, { all: true, family: 4 });
    const uniq = [...new Set(addrs.map((a) => a.address))];
    return uniq.map((ip) => `${u.protocol}//${ip}:${u.port}`);
  } catch {
    return [baseUrl];
  }
}

/* ------------------------------------------------------------------ SSE fan-out */

type Send = (event: string, data: unknown) => void;
const clients = new Set<Send>();
function broadcast(event: string, data: unknown) {
  for (const send of clients) send(event, data);
}

/* ------------------------------------------------------------------ cached views */

let lastIntegrity: Integrity | null = null;
let lastSummary: unknown = null;
let lastLoadgen: unknown = { running: false, scenarioId: null };
const health = new Map<string, ServiceHealth & { startedAt?: string; restarts?: number }>();
/** Last sampled shopper journeys of the current (or last) run, newest first. */
const JOURNEY_BUFFER = 100;
const journeys: Journey[] = [];

/* ------------------------------------------------------------------ sale window */

async function getSale(): Promise<SaleState | null> {
  const raw = await redis.get(KEYS.sale);
  return raw ? (JSON.parse(raw) as SaleState) : null;
}

async function setSale(sale: SaleState) {
  // Close any open window at "now" so history stays truthful for the price auditor.
  await db.query('sale.close', 'UPDATE catalog.sale_windows SET ends_at = LEAST(ends_at, now()) WHERE ends_at > now()');
  await db.query('sale.insert', 'INSERT INTO catalog.sale_windows (name, starts_at, ends_at) VALUES ($1, $2, $3)', [sale.name, sale.startsAt, sale.endsAt]);
  await redis.set(KEYS.sale, JSON.stringify(sale));
}

async function ensureLiveSale() {
  const s = await getSale();
  if (s && isLive(s, Date.now())) return;
  await setSale({
    name: 'Big Billion Sale',
    startsAt: new Date(Date.now() - 1000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  });
}

/* ------------------------------------------------------------------ actions */

async function scanDelete(pattern: string): Promise<number> {
  let cursor = '0';
  let n = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 2000);
    cursor = next;
    if (keys.length) n += await redis.unlink(...keys);
  } while (cursor !== '0');
  return n;
}

async function resetData() {
  // Background work (TTL sweeper, outbox relay, a late request) can hold row locks the reset
  // needs; TRUNCATE + bulk UPDATE can then deadlock. Bound the waits and retry.
  for (let attempt = 1; ; attempt++) {
    try {
      await resetTables();
      break;
    } catch (err) {
      const code = (err as { pgCode?: string }).pgCode;
      if (attempt >= 5 || (code !== '40P01' && code !== '55P03')) throw err;
      logger.warn({ code, attempt }, 'reset hit a lock conflict, retrying');
      await sleep(200 * attempt);
    }
  }
  return resetRedis();
}

async function resetTables() {
  await db.tx('reset', async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query(`TRUNCATE orders.order_items, orders.orders, orders.outbox, orders.coupon_redemptions, payments.charges,
                    fulfillment.shipments, fulfillment.notifications, inventory.reservations`);
    await tx.query('UPDATE orders.coupons SET used = 0');
    await tx.query(`UPDATE inventory.stock s SET total = ss.total, available = ss.total, reserved = 0, sold = 0, updated_at = now()
                      FROM inventory.stock_seed ss
                     WHERE ss.sku = s.sku AND (s.available <> ss.total OR s.reserved <> 0 OR s.sold <> 0 OR s.total <> ss.total)`);
    await tx.query(`UPDATE catalog.products p SET price_cents = ph.price_cents, deal_price_cents = ph.deal_price_cents, price_version = 1
                      FROM catalog.price_history ph
                     WHERE ph.product_id = p.id AND ph.price_version = 1 AND p.price_version <> 1`);
    await tx.query('DELETE FROM catalog.price_history WHERE price_version > 1');
  });
}

async function resetRedis() {
  let keys = 0;
  for (const p of ['bc:cache:*', 'bc:cart:*', 'bc:idem:*', 'bc:stock:*', 'bc:wr:*', 'bc:rl:*', 'bc:pv:*', 'bc:bv:*', 'bc:ryw:*', 'bc:ipv:*', 'bc:commit-retry']) {
    keys += await scanDelete(p);
  }
  await redis.del(KEYS.orderStream, KEYS.orderDlq);
  await redis.publish(KEYS.commandChannel, JSON.stringify({ action: 'flush-l1' }));
  await ensureLiveSale();
  resetIntegrityBaseline();
  // Recompute now so nobody (UI, verifier) reads the previous run's violations from the 5s cache.
  lastIntegrity = await checkIntegrity(redis).catch(() => null);
  if (lastIntegrity) broadcast('integrity', lastIntegrity);
  return keys;
}

async function runAction(name: string, body: Record<string, unknown> = {}): Promise<string> {
  switch (name) {
    case 'flush-cache': {
      const n = await scanDelete('bc:cache:*');
      await redis.publish(KEYS.commandChannel, JSON.stringify({ action: 'flush-l1' }));
      emitEvent('warn', 'cache-flush', `Cache flushed (${n} keys + every in-process L1)`, undefined, { throttleMs: 0 });
      return `flushed ${n} keys`;
    }
    case 'kill-service': {
      const target = String(body.target ?? '');
      if (!KILLABLE.has(target)) throw new HttpError(400, 'BAD_REQUEST', `cannot kill ${target}`);
      await redis.publish(KEYS.commandChannel, JSON.stringify({ action: 'kill', target }));
      return `kill signal sent to ${target}`;
    }
    case 'reset-data': {
      await stopScenario('reset');
      await drainLoadgen();
      const keys = await resetData();
      emitEvent('info', 'reset', `Data reset: orders, payments, reservations, stock and ${keys} Redis keys`, undefined, { throttleMs: 0 });
      return 'data reset';
    }
    case 'inject-poison': {
      await redis.xadd(KEYS.orderStream, '*', 'type', 'OrderPaid', 'orderId', 'poison', 'payload', '{"orderId": "oops", "totalCents": NaN');
      emitEvent('warn', 'poison-injected', 'Injected a malformed OrderPaid event into the orders stream', undefined, { throttleMs: 0 });
      return 'poison message injected';
    }
    case 'price-change': {
      const res = await request(`${config.urls.catalog}/admin/price`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: body.productId, dealPriceCents: body.dealPriceCents, priceCents: body.priceCents }),
        headersTimeout: 5000,
      });
      const out = (await res.body.json()) as { error?: { message: string } };
      if (res.statusCode >= 400) throw new HttpError(res.statusCode, 'BAD_REQUEST', out.error?.message ?? 'price change failed');
      return `price changed for #${body.productId}`;
    }
    case 'restock': {
      const units = Math.max(1, Math.min(10_000, Number(body.units ?? 50)));
      const ids = body.productId ? [Number(body.productId)] : Array.from({ length: 12 }, (_, i) => i + 1);
      await db.query('restock', 'UPDATE inventory.stock SET total = total + $2, available = available + $2, updated_at = now() WHERE product_id = ANY($1::bigint[])', [
        ids,
        units,
      ]);
      await scanDelete('bc:stock:*');
      emitEvent('info', 'restock', `Restocked ${units} units on ${ids.length} SKU(s)`, undefined, { throttleMs: 0 });
      return `restocked ${units} units`;
    }
    default:
      throw new HttpError(404, 'NOT_FOUND', `unknown action ${name}`);
  }
}

/* ------------------------------------------------------------------ scenarios */

let timers: NodeJS.Timeout[] = [];

async function loadgen(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await request(`${config.urls.loadgen}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    headersTimeout: 5000,
  });
  const out = await res.body.json();
  if (res.statusCode >= 400) throw new HttpError(res.statusCode, 'UPSTREAM_UNAVAILABLE', `loadgen: ${JSON.stringify(out)}`);
  return out;
}

async function applyTimelineEvent(ev: ScenarioEvent) {
  try {
    if (ev.patch) await store.apply(ev.patch, `scenario T+${ev.atSec}s`);
    if (ev.action) await runAction(ev.action.name, ev.action.body);
    emitEvent('info', 'scenario-event', `T+${ev.atSec}s — ${ev.description}`, undefined, { throttleMs: 0 });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'timeline event failed');
  }
}

async function startScenario(id: string, multiplier = 1, behaviour: Record<string, unknown> = {}) {
  const sc = scenarioById(id);
  if (!sc) throw new HttpError(404, 'NOT_FOUND', `unknown scenario ${id}`);
  await stopScenario('restart');
  if (sc.saleStartsAtSec !== null) {
    const startsAt = Date.now() + sc.saleStartsAtSec * 1000;
    await setSale({ name: sc.name, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + 6 * 3600_000).toISOString() });
  } else {
    await ensureLiveSale();
  }
  journeys.length = 0; // journeys belong to one run (the loadgen drops stragglers too)
  const status = await loadgen('POST', '/start', { scenarioId: id, multiplier, behaviour });
  timers = sc.timeline.map((ev) => setTimeout(() => void applyTimelineEvent(ev), ev.atSec * 1000));
  emitEvent('info', 'scenario-start', `Scenario started: ${sc.name} (x${multiplier})`, undefined, { throttleMs: 0 });
  return status;
}

/**
 * Wait until the load generator has no sessions in flight. Resetting data while old
 * sessions are still mid-request lets their stale reads land after the reset.
 */
async function drainLoadgen(maxMs = 35_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const st = (await loadgen('GET', '/status').catch(() => ({ activeSessions: 0 }))) as { activeSessions: number };
    if (st.activeSessions === 0) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Wait until no service has DB work queued or running. Callers that gave up do not cancel
 * the work they started (no deadline propagation), so queued queries keep running — and
 * timing out — for seconds after the traffic stops.
 */
async function quiesceDatabases(maxMs = 20_000) {
  const deadline = Date.now() + maxMs;
  const dbServices = ['catalog', 'inventory', 'orders', 'payments', 'recommendations', 'workers'];
  while (Date.now() < deadline) {
    let busy = 0;
    await Promise.all(
      dbServices.map(async (svc) => {
        for (const inst of await instancesOf(SERVICE_PORTS[svc])) {
          try {
            const res = await request(`${inst}/metrics`, { headersTimeout: 2000, bodyTimeout: 2000 });
            const text = await res.body.text();
            const val = (state: string) => Number(new RegExp(`^db_pool_connections\\{state="${state}"[^}]*\\} (\\S+)`, 'm').exec(text)?.[1] ?? 0);
            busy += val('waiting') + Math.max(0, val('total') - val('idle'));
          } catch {
            /* a restarting service has no queued work */
          }
        }
      }),
    );
    if (busy === 0) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Wait until every instance of every service answers its health check promptly. A server that
 * was flooded keeps working through its backlog after the traffic stops.
 */
async function waitResponsive(maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  let streak = 0;
  while (Date.now() < deadline) {
    let ok = true;
    await Promise.all(
      Object.values(SERVICE_PORTS).map(async (url) => {
        for (const inst of await instancesOf(url)) {
          const t0 = performance.now();
          try {
            const res = await request(`${inst}/health`, { headersTimeout: 1000, bodyTimeout: 1000 });
            await res.body.dump();
            if (res.statusCode !== 200 || performance.now() - t0 > 250) ok = false;
          } catch {
            ok = false;
          }
        }
      }),
    );
    streak = ok ? streak + 1 : 0;
    if (streak >= 2) return true;
    await sleep(500);
  }
  return false;
}

async function stopScenario(reason = 'operator') {
  for (const t of timers) clearTimeout(t);
  timers = [];
  try {
    const status = (await loadgen('POST', '/stop')) as { wasRunning?: boolean };
    if (status.wasRunning) emitEvent('info', 'scenario-stop', `Scenario stopped (${reason})`, undefined, { throttleMs: 0 });
    return status;
  } catch {
    return { running: false };
  }
}

/* ------------------------------------------------------------------ background loops */

async function healthLoop() {
  for (;;) {
    await Promise.all(
      Object.entries(SERVICE_PORTS).map(async ([svc, url]) => {
        const t0 = performance.now();
        // Up = every instance answers its health check.
        const targets = await instancesOf(url);
        const results = await Promise.all(
          targets.map(async (t) => {
            try {
              const res = await request(`${t}/health`, { headersTimeout: 1500, bodyTimeout: 1500 });
              await res.body.dump();
              return res.statusCode === 200;
            } catch {
              return false;
            }
          }),
        );
        const up = results.length > 0 && results.every(Boolean);
        const meta = await redis.hgetall(`bc:svc:${svc}`).catch(() => ({}) as Record<string, string>);
        const perInstance = await redis.hgetall(`bc:boots:${svc}`).catch(() => ({}) as Record<string, string>);
        const restarts = Object.values(perInstance).reduce((sum, n) => sum + Math.max(0, Number(n) - 1), 0);
        const prev = health.get(svc);
        if (prev && prev.up !== up) {
          emitEvent(up ? 'info' : 'critical', `health-${svc}`, up ? `${svc} is back up` : `${svc} is DOWN (health check failing)`, undefined, { throttleMs: 0 });
        }
        // Running replicas = DNS answers; bc:boots also remembers containers that are long gone.
        health.set(svc, { service: svc, up, latencyMs: performance.now() - t0, startedAt: meta.startedAt, restarts, instances: targets.length });
      }),
    );
    health.set('control-plane', { service: 'control-plane', up: true, latencyMs: 0 });
    await sleep(2000);
  }
}

async function integrityLoop() {
  for (;;) {
    try {
      lastIntegrity = await checkIntegrity(redis);
      publishIntegrity(lastIntegrity);
      broadcast('integrity', lastIntegrity);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'integrity check failed');
    }
    await sleep(5000);
  }
}

async function summaryLoop() {
  for (;;) {
    try {
      const sale = await getSale();
      lastSummary = await buildSummary(health, sale ? { ...sale, now: new Date().toISOString(), live: isLive(sale, Date.now()) } : null);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'summary failed');
    }
    await sleep(2000);
  }
}

/* ------------------------------------------------------------------ service */

void runService({
  name: 'control-plane',
  db: true,
  noChaos: true,
  ready: async () => {
    await redis.ping();
  },
  routes: async (app) => {
    await store.get();
    if (!(await getSale())) await ensureLiveSale();

    await sub.subscribe(KEYS.eventsChannel, KEYS.loadgenStatsChannel, KEYS.runtimeChannel, KEYS.journeysChannel);
    sub.on('message', (channel, msg) => {
      if (channel === KEYS.eventsChannel) {
        try {
          broadcast('timeline', JSON.parse(msg) as TimelineEvent);
        } catch {
          /* ignore */
        }
      } else if (channel === KEYS.loadgenStatsChannel) {
        try {
          lastLoadgen = JSON.parse(msg);
          broadcast('loadgen', lastLoadgen);
        } catch {
          /* ignore */
        }
      } else if (channel === KEYS.runtimeChannel) {
        void store.get().then((s) => broadcast('runtime', s));
      } else if (channel === KEYS.journeysChannel) {
        try {
          const j = JSON.parse(msg) as Journey;
          if (!j || typeof j.id !== 'string' || !Array.isArray(j.steps)) return;
          journeys.unshift(j);
          if (journeys.length > JOURNEY_BUFFER) journeys.length = JOURNEY_BUFFER;
          broadcast('journey', j);
        } catch {
          /* ignore */
        }
      }
    });

    app.get('/control/state', async () => ({
      runtime: await store.get(),
      defs: {
        flags: FLAGS,
        serviceChaosDefaults: SERVICE_CHAOS_DEFAULTS,
        paymentsChaosDefaults: PAYMENTS_CHAOS_DEFAULTS,
        dataChaosDefaults: DATA_CHAOS_DEFAULTS,
        tuningDefaults: TUNING_DEFAULTS,
        tuningHelp: TUNING_HELP,
        services: SERVICES.filter((s) => s !== 'control-plane' && s !== 'loadgen'),
      },
    }));

    app.patch<{ Body: Record<string, string> }>('/control/flags', async (req) => store.apply({ flags: req.body ?? {} } as RuntimePatch));
    app.patch<{ Body: RuntimePatch['chaos'] }>('/control/chaos', async (req) => store.apply({ chaos: req.body ?? {} }));
    app.patch<{ Body: RuntimePatch['tuning'] }>('/control/tuning', async (req) => store.apply({ tuning: req.body ?? {} }));

    app.post<{ Params: { id: string } }>('/control/presets/:id', async (req) => {
      const id = req.params.id;
      let s;
      if (id === 'hardened' || id === 'naive') s = await store.reset(id, { keepChaos: true });
      else if (id === 'calm-chaos') s = await store.clearChaos();
      else throw new HttpError(404, 'NOT_FOUND', `unknown preset ${id}`);
      emitEvent(id === 'naive' ? 'warn' : 'info', 'preset', `Preset applied: ${id}`, undefined, { throttleMs: 0 });
      return s;
    });

    app.post<{ Params: { action: string }; Body: Record<string, unknown> }>('/control/actions/:action', async (req) => ({
      ok: true,
      message: await runAction(req.params.action, req.body ?? {}),
    }));

    app.get('/control/scenarios', async () => SCENARIOS.map(summarizeScenario));
    app.post<{ Params: { id: string }; Body: { multiplier?: number } }>('/control/scenarios/:id/start', async (req) =>
      startScenario(req.params.id, Number(req.body?.multiplier ?? 1) || 1),
    );
    app.post('/control/scenarios/stop', async () => stopScenario());
    app.get('/control/loadgen', async () => loadgen('GET', '/status').catch(() => lastLoadgen));
    app.patch<{ Body: { multiplier: number } }>('/control/loadgen', async (req) => loadgen('PATCH', '/multiplier', { multiplier: Number(req.body?.multiplier) }));

    app.get('/control/labs', async () => LABS);
    app.post<{ Params: { id: string }; Body: { variant?: 'broken' | 'fixed'; multiplier?: number } }>('/control/labs/:id/start', async (req) => {
      const lab = labById(req.params.id);
      if (!lab) throw new HttpError(404, 'NOT_FOUND', 'unknown lab');
      const variant = req.body?.variant === 'fixed' ? 'fixed' : 'broken';
      await stopScenario('lab start');
      if (!(await drainLoadgen())) emitEvent('warn', 'lab-drain', 'Previous sessions still in flight after 35s — results may be noisy', undefined, { throttleMs: 0 });
      if (!(await quiesceDatabases())) emitEvent('warn', 'lab-drain', 'Database work from the previous run still queued after 20s — results may be noisy', undefined, { throttleMs: 0 });
      if (!(await waitResponsive())) emitEvent('warn', 'lab-drain', 'Some services still slow to respond after 90s — results may be noisy', undefined, { throttleMs: 0 });
      await resetData();
      // Start every lab with clean edge state (a leaked admission counter would survive otherwise).
      await redis.publish(KEYS.commandChannel, JSON.stringify({ action: 'reset-inflight' }));
      await store.reset('hardened');
      const runtime = await store.apply(variant === 'fixed' ? lab.fixedPatch : lab.brokenPatch, `lab "${lab.id}" (${variant})`);
      emitEvent(variant === 'broken' ? 'warn' : 'info', 'lab-start', `Lab started: ${lab.title} — ${variant.toUpperCase()}`, undefined, { throttleMs: 0 });
      // Give services a moment to pick up the new runtime before traffic arrives.
      await sleep(500);
      const loadgenStatus = await startScenario(lab.scenario, Number(req.body?.multiplier ?? 1) || 1, lab.behaviour ?? {});
      return { ok: true, runtime, loadgen: loadgenStatus };
    });

    app.get('/control/integrity', async () => lastIntegrity ?? checkIntegrity(redis));
    app.get('/control/summary', async () => {
      // The summary is rebuilt every 2s; stamp the sale clock when it is served, or countdowns
      // run up to 2s behind and jump.
      const s = (lastSummary ?? (await buildSummary(health, await getSale()))) as { sale?: SaleState | null };
      if (!s.sale) return s;
      const now = Date.now();
      return { ...s, sale: { ...s.sale, now: new Date(now).toISOString(), live: isLive(s.sale, now) } };
    });
    app.get('/control/services', async () => ({
      items: [...health.values()].map((h) => ({ ...h, restarts: h.restarts ?? 0 })),
    }));

    // Raw Prometheus exposition of every instance of one service, concatenated (used by the lab
    // verifier, which sums samples — so counters add up across replicas; works without Prometheus).
    app.get<{ Params: { name: string } }>('/control/services/:name/metrics', async (req, reply) => {
      const url = SERVICE_PORTS[req.params.name];
      if (!url) throw new HttpError(404, 'NOT_FOUND', 'unknown service');
      const texts = await Promise.all(
        (await instancesOf(url)).map(async (t) => {
          const res = await request(`${t}/metrics`, { headersTimeout: 3000, bodyTimeout: 3000 });
          return res.body.text();
        }),
      );
      reply.header('content-type', 'text/plain; version=0.0.4');
      return texts.join('\n');
    });

    app.get('/control/events/recent', async () => ({
      items: (await redis.lrange(KEYS.eventsLog, 0, 199)).map((s) => JSON.parse(s) as TimelineEvent),
    }));

    // SSE streams only new journeys; a fresh client loads these once.
    app.get('/control/journeys/recent', async () => ({ items: journeys.slice() }));

    app.get('/control/events', (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send: Send = (event, data) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      clients.add(send);
      reply.raw.write('retry: 2000\n\n');
      void store.get().then((s) => send('runtime', s));
      // Live status, not the last broadcast: after a run ends that is a frame from its final window.
      void loadgen('GET', '/status').then(
        (st) => send('loadgen', st),
        () => send('loadgen', lastLoadgen),
      );
      if (lastIntegrity) send('integrity', lastIntegrity);
      const hb = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      req.raw.on('close', () => {
        clearInterval(hb);
        clients.delete(send);
      });
    });

    app.get<{ Querystring: { query?: string; minutes?: string; step?: string } }>('/control/prom/query_range', async (req) => {
      const minutes = Math.min(180, Math.max(1, Number(req.query.minutes ?? 10)));
      const end = Date.now() / 1000;
      return promRaw('query_range', {
        query: String(req.query.query ?? ''),
        start: String(end - minutes * 60),
        end: String(end),
        step: String(Math.max(1, Number(req.query.step ?? 2))),
      });
    });
    app.get<{ Querystring: { query?: string } }>('/control/prom/query', async (req) => promRaw('query', { query: String(req.query.query ?? '') }));
  },
  background: () => {
    // Info gauge of flag modes, so dashboards can annotate "flag flipped".
    const exportFlags = async () => {
      const s = await store.get().catch(() => null);
      if (!s) return;
      for (const [flag, def] of Object.entries(FLAGS)) {
        for (const mode of def.modes) m.runtimeFlag.set({ flag, mode }, s.flags[flag as keyof typeof s.flags] === mode ? 1 : 0);
      }
    };
    void exportFlags();
    setInterval(() => void exportFlags(), 2000).unref();
    void healthLoop();
    void integrityLoop();
    void summaryLoop();
  },
  shutdown: async () => {
    redis.disconnect();
    sub.disconnect();
  },
});
