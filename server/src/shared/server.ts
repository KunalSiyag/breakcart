import { hostname } from 'node:os';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import Redis from 'ioredis';
import { applyRequestChaos, startProcessChaos } from './chaos';
import { config } from './config';
import { db } from './db';
import type { ServiceName } from './defs';
import { closeEvents, emitEvent } from './events';
import { flushLogs, logger } from './logger';
import { m, metricsText } from './metrics';
import { runtime, type Command } from './runtime';
import { syncLog } from './sync-log';
import { HttpError, sleep, uuid } from './util';

declare module 'fastify' {
  interface FastifyRequest {
    startedAt: number;
    responsePayload?: unknown;
  }
}

export interface ServiceSpec {
  name: ServiceName;
  /** Connect the shared Postgres pool. */
  db?: boolean;
  /** Skip request-level chaos (control plane, loadgen). */
  noChaos?: boolean;
  routes: (app: FastifyInstance) => void | Promise<void>;
  /** Start background loops after the server is listening. */
  background?: () => void | Promise<void>;
  /** Readiness check. Throw to report not ready. */
  ready?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

const INFRA_ROUTES = new Set(['/health', '/ready', '/metrics']);

export async function waitFor(name: string, fn: () => Promise<unknown>, attempts = 60): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn({ err: (err as Error).message, attempt: i }, `waiting for ${name}`);
      await sleep(1000);
    }
  }
}

export function buildApp(spec: ServiceSpec): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    keepAliveTimeout: 65_000,
    requestIdHeader: 'x-request-id',
    genReqId: () => uuid(),
    disableRequestLogging: true,
  });

  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = performance.now();
    // A request can sit in a backlog (busy event loop, full socket buffers) until long after its
    // client gave up. Doing the work anyway is how an overloaded server stays overloaded after
    // the traffic is gone — check before starting.
    if (req.raw.socket?.destroyed) {
      m.httpDuration.observe({ method: req.method, route: req.routeOptions.url ?? 'unmatched', status: '499' }, 0);
      reply.hijack();
      return;
    }
    m.httpInflight.inc();
    // 'close' fires exactly once — after the response finished OR when the client hung up.
    // onResponse does NOT run for aborted requests, so decrementing there leaks the gauge
    // every time a caller times out (and anything built on it, like load shedding, drifts).
    reply.raw.once('close', () => {
      m.httpInflight.dec();
      if (!reply.raw.writableFinished) {
        // nginx's 499 "client closed request": without this, server-side latency histograms
        // silently drop the slowest requests — the ones customers gave up on.
        const route = req.routeOptions.url ?? 'unmatched';
        if (!INFRA_ROUTES.has(route) && req.url !== '/control/events') {
          m.httpDuration.observe({ method: req.method, route, status: '499' }, (performance.now() - req.startedAt) / 1000);
        }
      }
    });
    reply.header('x-request-id', req.id);
    reply.header('x-served-by', config.service);
  });

  if (!spec.noChaos) {
    app.addHook('preHandler', async (req) => {
      if (INFRA_ROUTES.has(req.url.split('?')[0])) return;
      await applyRequestChaos();
    });
  }

  app.addHook('onSend', async (req, _reply, payload) => {
    if (runtime.flag('platform.logging') === 'sync_verbose') req.responsePayload = payload;
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (INFRA_ROUTES.has(route)) return;
    const seconds = (performance.now() - req.startedAt) / 1000;
    m.httpDuration.observe({ method: req.method, route, status: String(reply.statusCode) }, seconds);
    logRequest(req, reply, route, seconds);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown; code?: string }, req, reply) => {
    m.httpErrors.inc({ route: req.routeOptions.url ?? 'unmatched', code: err instanceof HttpError ? err.code : err.validation ? 'BAD_REQUEST' : 'INTERNAL' });
    if (err instanceof HttpError) {
      for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, retryable: err.retryable } });
    }
    if (err.validation || (err.statusCode && err.statusCode < 500)) {
      return reply.status(err.statusCode ?? 400).send({ error: { code: 'BAD_REQUEST', message: err.message, retryable: false } });
    }
    logger.error({ err, url: req.url, reqId: req.id }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error', retryable: true } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: `no route ${req.method} ${req.url}`, retryable: false } });
  });

  const startedAt = new Date().toISOString();
  app.get('/health', async () => ({ status: 'ok', service: config.service, startedAt, uptimeSec: Math.round(process.uptime()) }));
  app.get('/ready', async (_req, reply) => {
    try {
      await spec.ready?.();
      return { status: 'ready', service: config.service };
    } catch (err) {
      return reply.status(503).send({ status: 'not_ready', reason: (err as Error).message });
    }
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return metricsText();
  });

  return app;
}

function logRequest(req: FastifyRequest, reply: FastifyReply, route: string, seconds: number) {
  if (runtime.flag('platform.logging') === 'sync_verbose') {
    // The naive way: pretty-printed, everything, written synchronously and fsync'd (see sync-log.ts).
    let response: unknown = req.responsePayload;
    if (typeof response === 'string') {
      try {
        response = JSON.parse(response);
      } catch {
        /* keep string */
      }
    }
    syncLog({
      ts: new Date().toISOString(),
      service: config.service,
      reqId: req.id,
      method: req.method,
      url: req.url,
      route,
      status: reply.statusCode,
      ms: Math.round(seconds * 1000),
      headers: req.headers,
      body: req.body,
      response,
    });
    return;
  }
  if (reply.statusCode >= 500) {
    logger.warn({ reqId: req.id, method: req.method, route, status: reply.statusCode, ms: Math.round(seconds * 1000) }, 'request failed');
  } else if (Math.random() < 0.01) {
    logger.info({ reqId: req.id, method: req.method, route, status: reply.statusCode, ms: Math.round(seconds * 1000) }, 'request (1% sample)');
  }
}

/** Headers to forward on service-to-service calls. */
export function fwd(req: FastifyRequest, extra: Record<string, string | undefined> = {}) {
  return {
    'x-request-id': req.id,
    'x-user-id': req.headers['x-user-id'] as string | undefined,
    ...extra,
  };
}

export async function runService(spec: ServiceSpec): Promise<FastifyInstance> {
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));

  await waitFor('redis', () => runtime.start());
  if (spec.db) {
    db.start();
    await waitFor('postgres', () => db.query('boot', 'SELECT 1'));
  }
  startProcessChaos();

  const app = buildApp(spec);
  await spec.routes(app);
  await app.listen({ host: config.host, port: config.port });

  // Boot bookkeeping per instance (hostname = container id), so the control plane can show
  // restarts (e.g. after an OOM kill) without confusing replicas with restarts.
  const r = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  const instance = hostname();
  const boots = await r.hincrby(`bc:boots:${spec.name}`, instance, 1).catch(() => 1);
  await r.hset(`bc:svc:${spec.name}`, { startedAt: new Date().toISOString(), lastInstance: instance }).catch(() => undefined);
  r.disconnect();
  emitEvent(boots > 1 ? 'warn' : 'info', `service-started-${spec.name}`, `${spec.name} started${boots > 1 ? ` (boot #${boots})` : ''}`, undefined, {
    throttleMs: 0,
  });
  logger.info({ port: config.port }, `${spec.name} listening`);

  runtime.on('command', (cmd: Command) => {
    if (cmd.action === 'kill' && (cmd.target === spec.name || cmd.target === 'all')) {
      emitEvent('critical', `service-killed-${spec.name}`, `${spec.name} killed by operator (simulated crash / bad deploy)`, undefined, { throttleMs: 0 });
      flushLogs();
      setTimeout(() => process.exit(1), 100);
    }
  });

  await spec.background?.();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      await spec.shutdown?.();
      if (spec.db) await db.end();
      await runtime.stop();
      closeEvents();
    } finally {
      flushLogs();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  return app;
}
