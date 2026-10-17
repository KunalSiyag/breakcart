import type { FastifyReply, FastifyRequest } from 'fastify';
import { CircuitBreaker } from '../../shared/breaker';
import { HOT_PRODUCT_IDS } from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import { Upstream, type CallResult } from '../../shared/http-client';
import { m } from '../../shared/metrics';
import { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { isLive, SaleClock } from '../../shared/sale';
import { fwd, runService } from '../../shared/server';
import { HttpError, sleep } from '../../shared/util';
import {
  admissionTick,
  admit,
  checkAddToCart,
  checkCheckoutVelocity,
  checkPass,
  clientIp,
  issueToken,
  joinQueue,
  queueStatus,
  rateLimit,
  readToken,
  recordProductView,
  release,
  resetInflight,
  type Identity,
  type Priority,
} from './edge';

declare module 'fastify' {
  interface FastifyRequest {
    ident?: Identity;
    admitted?: boolean;
    releaseOnResponse?: boolean;
  }
  interface FastifyContextConfig {
    priority?: Priority;
    auth?: 'required' | 'optional' | 'none';
  }
}

const redis = new DataRedis();
const sale = new SaleClock(redis);
const catalog = Upstream.for('catalog');
const inventory = Upstream.for('inventory');
const cart = Upstream.for('cart');
const orders = Upstream.for('orders');
const recs = Upstream.for('recommendations');

/** Dedicated breaker for the "isolated" non-critical path (independent of platform.circuitBreaker). */
const recsBreaker = new CircuitBreaker({ minCalls: 10, openMs: 3000, onTransition: (_f, to) => emitEvent('warn', `recs-isolation-${to}`, `Recommendations isolation breaker → ${to}`) });

/** Pass an upstream response through untouched (bytes, status, the headers clients rely on). */
function relay(reply: FastifyReply, res: CallResult<unknown>) {
  const ra = res.headers['retry-after'];
  if (typeof ra === 'string') reply.header('retry-after', ra);
  const replayed = res.headers['idempotent-replayed'];
  if (typeof replayed === 'string') reply.header('idempotent-replayed', replayed);
  const type = res.headers['content-type'];
  if (typeof type === 'string' && type.includes('json')) {
    return reply.status(res.status).header('content-type', type).send(res.text);
  }
  return reply.status(res.status).send(res.body);
}

function user(req: FastifyRequest): Identity {
  if (!req.ident) throw new HttpError(401, 'UNAUTHENTICATED', 'sign in required');
  return req.ident;
}

/**
 * Non-critical dependency call. "blocking" is how most code is first written; "isolated"
 * bounds the blast radius with a short timeout, a breaker and a fallback.
 */
async function recommendations(req: FastifyRequest, query: Record<string, string | number | undefined>, degraded: string[]) {
  if (runtime.flag('bff.nonCriticalDeps') === 'blocking') {
    const res = await recs.json<{ items: unknown[] }>({ path: '/recs', query, headers: fwd(req), timeoutMs: 30_000 });
    return res.items;
  }
  if (!recsBreaker.tryAcquire()) {
    degraded.push('recommendations');
    return [];
  }
  try {
    const res = await recs.json<{ items: unknown[] }>({ path: '/recs', query, headers: fwd(req), timeoutMs: 250 });
    recsBreaker.onSuccess();
    return res.items;
  } catch {
    recsBreaker.onFailure();
    degraded.push('recommendations');
    return [];
  }
}

void runService({
  name: 'gateway',
  ready: async () => {
    await redis.run('ping', (r) => r.ping());
  },
  routes: async (app) => {
    await redis.connect();

    /* ---------------------------------------------- edge pipeline (order matters) */
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      // 1. Load shedding — cheapest check first, before parsing anything.
      const priority = req.routeOptions.config?.priority ?? 'normal';
      if (!admit(priority)) {
        reply.header('retry-after', '1');
        return reply.status(503).send({ error: { code: 'OVERLOADED', message: 'we are experiencing very high demand — please retry', retryable: true } });
      }
      req.admitted = true;
      if (runtime.flag('gateway.inflightAccounting') === 'on_close') {
        // The response's 'close' fires exactly once per request, whether it finished or the client
        // hung up (the socket's 'close' would fire once for all requests on a keep-alive connection).
        reply.raw.once('close', release);
      } else {
        req.releaseOnResponse = true;
      }
    });
    // The naive twin: onResponse never runs for a request whose client disconnected first,
    // so every abandoned request leaks an admission slot (lab: shedding-death-spiral).
    app.addHook('onResponse', async (req) => {
      if (req.releaseOnResponse) release();
    });
    runtime.on('command', (cmd) => {
      if (cmd.action === 'reset-inflight') resetInflight();
    });

    app.addHook('preHandler', async (req) => {
      if (!req.url.startsWith('/api/')) return;
      const auth = req.routeOptions.config?.auth ?? 'optional';
      // 2. Authentication (stateless signed token — no session-store round trip).
      const ident = readToken(req);
      if (ident) {
        req.ident = ident;
        req.headers['x-user-id'] = ident.userId;
      } else if (auth === 'required') {
        throw new HttpError(401, 'UNAUTHENTICATED', 'sign in required');
      }
      // 3. Rate limiting per user (or IP for anonymous traffic).
      if (auth !== 'none') await rateLimit(redis, ident?.userId ?? `ip:${clientIp(req)}`);
    });

    /* ---------------------------------------------- auth */
    app.post('/api/auth/guest', { config: { priority: 'high', auth: 'none' } }, async (req) => {
      await rateLimit(redis, `ip:${clientIp(req)}`);
      m.sessionsCreated.inc();
      return issueToken();
    });

    /* ---------------------------------------------- browse */
    app.get('/api/sale', { config: { priority: 'normal' } }, async () => sale.view());

    app.get('/api/home', { config: { priority: 'normal' } }, async (req) => {
      const degraded: string[] = [];
      const [saleView, deals, stock, recItems] = await Promise.all([
        sale.view(),
        catalog.json<{ items: { id: number }[] }>({ path: '/deals', headers: fwd(req) }),
        inventory
          .json<{ items: { productId: number; available: number; total: number }[] }>({
            path: '/stock',
            query: { productIds: HOT_PRODUCT_IDS.join(',') },
            headers: fwd(req),
            timeoutMs: 1500,
          })
          .catch(() => {
            degraded.push('stock');
            return { items: [] };
          }),
        recommendations(req, { userId: req.ident?.userId }, degraded),
      ]);
      const byId = new Map(stock.items.map((s) => [s.productId, { available: s.available, total: s.total }]));
      return {
        sale: saleView,
        deals: deals.items.map((d) => ({ ...d, stock: byId.get(d.id) ?? null })),
        recommendations: recItems,
        degraded,
      };
    });

    app.get('/api/products', { config: { priority: 'normal' } }, async (req, reply) =>
      relay(reply, await catalog.call({ path: '/products', query: req.query as Record<string, string>, headers: fwd(req) })),
    );

    app.get<{ Params: { id: string } }>('/api/products/:id', { config: { priority: 'normal' } }, async (req) => {
      const id = Number(req.params.id);
      const degraded: string[] = [];
      const [product, stock, recItems] = await Promise.all([
        catalog.json<{ id: number }>({ path: `/products/${id}`, headers: fwd(req) }),
        inventory
          .json<{ items: { available: number; total: number }[] }>({ path: '/stock', query: { productIds: id }, headers: fwd(req), timeoutMs: 1500 })
          .catch(() => {
            degraded.push('stock');
            return { items: [] };
          }),
        recommendations(req, { productId: id, userId: req.ident?.userId }, degraded),
      ]);
      if (req.ident) await recordProductView(redis, req.ident.userId, id);
      const s = stock.items[0];
      return { ...product, stock: s ? { available: s.available, total: s.total } : null, recommendations: recItems, degraded };
    });

    app.get('/api/categories', { config: { priority: 'low' } }, async (req, reply) => relay(reply, await catalog.call({ path: '/categories', headers: fwd(req) })));

    app.get('/api/search', { config: { priority: 'low' } }, async (req, reply) =>
      relay(reply, await catalog.call({ path: '/search', query: req.query as Record<string, string>, headers: fwd(req) })),
    );

    /* ---------------------------------------------- cart */
    app.get('/api/cart', { config: { priority: 'high', auth: 'required' } }, async (req, reply) =>
      relay(reply, await cart.call({ path: '/cart', headers: fwd(req) })),
    );

    app.post<{ Body: { productId: number; qty?: number } }>('/api/cart/items', { config: { priority: 'high', auth: 'required' } }, async (req, reply) => {
      await checkAddToCart(redis, user(req), Number(req.body?.productId), clientIp(req));
      return relay(reply, await cart.call({ method: 'POST', path: '/cart/items', body: req.body, headers: fwd(req) }));
    });

    app.delete<{ Params: { productId: string } }>('/api/cart/items/:productId', { config: { priority: 'high', auth: 'required' } }, async (req, reply) =>
      relay(reply, await cart.call({ method: 'DELETE', path: `/cart/items/${encodeURIComponent(req.params.productId)}`, headers: fwd(req) })),
    );

    app.delete('/api/cart', { config: { priority: 'high', auth: 'required' } }, async (req, reply) =>
      relay(reply, await cart.call({ method: 'DELETE', path: '/cart', headers: fwd(req) })),
    );

    /* ---------------------------------------------- checkout & orders */
    app.post('/api/checkout', { config: { priority: 'critical', auth: 'required' } }, async (req, reply) => {
      const ident = user(req);
      await checkCheckoutVelocity(redis, ident.userId);
      if (runtime.flag('gateway.waitingRoom') === 'on') {
        const s = await sale.get();
        if (!s || isLive(s, Date.now())) checkPass(req, ident.userId);
      }
      const key = req.headers['idempotency-key'] as string | undefined;
      return relay(
        reply,
        await orders.call({ method: 'POST', path: '/checkout', body: req.body ?? {}, headers: fwd(req, { 'idempotency-key': key }), idempotent: !!key }),
      );
    });

    app.post<{ Params: { id: string } }>('/api/orders/:id/pay', { config: { priority: 'critical', auth: 'required' } }, async (req, reply) => {
      const key = req.headers['idempotency-key'] as string | undefined;
      return relay(
        reply,
        await orders.call({
          method: 'POST',
          path: `/orders/${encodeURIComponent(req.params.id)}/pay`,
          body: req.body ?? {},
          headers: fwd(req, { 'idempotency-key': key }),
          // Must outlive the PSP timeout or the gateway gives up first and the client retries blind.
          timeoutMs: runtime.tuning.paymentTimeoutMs + 3000,
          idempotent: !!key,
        }),
      );
    });

    app.get('/api/orders', { config: { priority: 'high', auth: 'required' } }, async (req, reply) =>
      relay(reply, await orders.call({ path: '/orders', headers: fwd(req) })),
    );

    app.get<{ Params: { id: string } }>('/api/orders/:id', { config: { priority: 'high', auth: 'required' } }, async (req, reply) =>
      relay(reply, await orders.call({ path: `/orders/${encodeURIComponent(req.params.id)}`, headers: fwd(req) })),
    );

    /* ---------------------------------------------- waiting room */
    app.post('/api/queue/join', { config: { priority: 'critical', auth: 'required' } }, async (req) => {
      const { ticket, position, etaSec } = await joinQueue(redis, user(req).userId);
      return { ticket, position, etaSec };
    });

    app.get<{ Querystring: { ticket?: string } }>('/api/queue/status', { config: { priority: 'critical', auth: 'required' } }, async (req) => {
      const ticket = Number(req.query.ticket);
      if (!Number.isInteger(ticket) || ticket <= 0) throw new HttpError(400, 'BAD_REQUEST', 'ticket required');
      return queueStatus(redis, user(req).userId, ticket);
    });
  },
  background: () => {
    void (async () => {
      for (;;) {
        if (runtime.flag('gateway.waitingRoom') === 'on') await admissionTick(redis).catch(() => undefined);
        else m.waitingRoomLength.set(0);
        await sleep(1000 - (Date.now() % 1000) + 5);
      }
    })();
  },
  shutdown: async () => redis.disconnect(),
});
