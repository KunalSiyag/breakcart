import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { FastifyRequest } from 'fastify';
import { HOT_PRODUCT_IDS } from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import { m } from '../../shared/metrics';
import type { DataRedis } from '../../shared/redis';
import { runtime } from '../../shared/runtime';
import { HttpError } from '../../shared/util';

const SECRET = process.env.SESSION_SECRET ?? 'breakcart-dev-secret-change-me';
const HOT = new Set(HOT_PRODUCT_IDS);

export type Priority = 'critical' | 'high' | 'normal' | 'low';

/* ------------------------------------------------------------------ auth (stateless, HMAC-signed) */

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

function verify(data: string, sig: string): boolean {
  const expected = Buffer.from(sign(data));
  const got = Buffer.from(sig);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export function issueToken(): { token: string; userId: string } {
  const userId = `u_${randomBytes(6).toString('hex')}`;
  const payload = Buffer.from(`${userId}.${Date.now()}`).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, userId };
}

export interface Identity {
  userId: string;
  issuedAt: number;
}

export function readToken(req: FastifyRequest): Identity | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const [payload, sig] = h.slice(7).split('.');
  if (!payload || !sig || !verify(payload, sig)) return null;
  const [userId, issued] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!userId || !issued) return null;
  return { userId, issuedAt: Number(issued) };
}

export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.ip;
}

/* ------------------------------------------------------------------ load shedding */

let inflight = 0;
const SHED_AT: Record<Priority, number> = { low: 0.5, normal: 0.75, high: 0.9, critical: 1.0 };

/**
 * Queueing delay, CoDel-style. When this process itself is saturated, requests wait in the
 * event loop *before* they are counted as in flight — an in-flight limit never trips. The
 * event-loop delay is that wait, so shed on it too (Envoy's adaptive concurrency and
 * Netflix's concurrency-limits work on the same signal).
 */
const LAG_SHED_MS: Record<Priority, number> = { low: 50, normal: 150, high: 300, critical: Number.POSITIVE_INFINITY };
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let queueDelayMs = 0;
setInterval(() => {
  queueDelayMs = loopDelay.percentile(90) / 1e6;
  loopDelay.reset();
}, 500).unref();

/** Returns false if the request must be shed. Callers must call `release()` iff this returned true. */
export function admit(priority: Priority): boolean {
  if (runtime.flag('gateway.loadShedding') === 'on') {
    const max = runtime.tuning.gatewayMaxInflight;
    const reason = inflight >= max * SHED_AT[priority] ? 'inflight' : queueDelayMs >= LAG_SHED_MS[priority] ? 'queue_delay' : null;
    if (reason) {
      m.shed.inc({ priority, reason });
      emitEvent(
        'warn',
        'load-shedding',
        `Gateway shedding ${priority}-priority traffic (${reason === 'inflight' ? `inflight ${inflight}/${max}` : `queueing delay ${Math.round(queueDelayMs)}ms`})`,
        undefined,
        { throttleMs: 5000 },
      );
      return false;
    }
  }
  inflight++;
  m.admissionInflight.set(inflight);
  return true;
}

export function release() {
  inflight = Math.max(0, inflight - 1);
  m.admissionInflight.set(inflight);
}

/** Operator reset (after draining traffic) — what a restart would do. */
export function resetInflight() {
  inflight = 0;
  m.admissionInflight.set(0);
}

export const gatewayInflight = () => inflight;

/* ------------------------------------------------------------------ rate limiting */

const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local s = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(s[1])
local ts = tonumber(s[2])
if tokens == nil then tokens = burst; ts = now end
tokens = math.min(burst, tokens + (now - ts) / 1000 * rate)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', key, 't', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst / rate * 1000) + 1000)
return allowed
`;

let tokenBucket: ReturnType<DataRedis['script']> | undefined;

export async function rateLimit(redis: DataRedis, id: string): Promise<void> {
  const mode = runtime.flag('gateway.rateLimit');
  if (mode === 'off') return;
  const { rateLimitPerSec: rate, rateLimitBurst: burst } = runtime.tuning;
  let allowed: boolean;
  try {
    if (mode === 'fixed_window') {
      // Counter per wall-clock second: a client can send `rate` at 0.999s and `rate` again at 1.000s.
      const key = `bc:rl:fw:${id}:${Math.floor(Date.now() / 1000)}`;
      const n = await redis.run('ratelimit_fw', async (r) => {
        const [[, count]] = (await r.multi().incr(key).expire(key, 2).exec()) as [[null, number], [null, number]];
        return count;
      });
      allowed = n <= rate;
    } else {
      tokenBucket ??= redis.script('bcTokenBucket', 1, TOKEN_BUCKET_LUA);
      const tb = tokenBucket;
      const res = await redis.run('ratelimit_tb', () => tb([`bc:rl:tb:${id}`], [rate, burst, Date.now()]));
      allowed = res === 1;
    }
  } catch {
    if (runtime.flag('gateway.rateLimitFailMode') === 'fail_open') {
      m.rateLimit.inc({ decision: 'error_allowed' });
      emitEvent('warn', 'ratelimit-fail-open', 'Rate limiter cannot reach Redis — failing OPEN (allowing traffic)', undefined, { throttleMs: 10_000 });
      return;
    }
    m.rateLimit.inc({ decision: 'error_rejected' });
    emitEvent('critical', 'ratelimit-fail-closed', 'Rate limiter cannot reach Redis — failing CLOSED (rejecting ALL traffic)', undefined, {
      throttleMs: 10_000,
    });
    throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'rate limiter unavailable', true, { 'retry-after': '1' });
  }
  if (!allowed) {
    m.rateLimit.inc({ decision: 'limited' });
    throw new HttpError(429, 'RATE_LIMITED', 'too many requests', true, { 'retry-after': '1' });
  }
  m.rateLimit.inc({ decision: 'allowed' });
}

/* ------------------------------------------------------------------ bot protection */

export async function recordProductView(redis: DataRedis, userId: string, productId: number) {
  if (!HOT.has(productId) || runtime.flag('gateway.botProtection') !== 'on') return;
  await redis.run('pv_set', (r) => r.set(`bc:pv:${userId}:${productId}`, String(Date.now()), 'EX', 900, 'NX')).catch(() => undefined);
}

export async function checkAddToCart(redis: DataRedis, ident: Identity, productId: number, ip: string) {
  if (!HOT.has(productId) || runtime.flag('gateway.botProtection') !== 'on') return;
  // Network signal: scalper fleets run from a few datacenter IPs; customers are spread over
  // millions of residential/mobile addresses. (Carrier NAT shares IPs — keep the limit generous.)
  const ipKey = `bc:ipv:${ip}:${Math.floor(Date.now() / 60_000)}`;
  const perIp = await redis
    .run('ip_velocity', async (r) => {
      const [[, count]] = (await r.multi().incr(ipKey).expire(ipKey, 120).exec()) as [[null, number], [null, number]];
      return count;
    })
    .catch(() => 0);
  if (perIp > 30) {
    m.botBlocked.inc({ reason: 'ip_velocity' });
    throw new HttpError(403, 'BOT_SUSPECTED', 'unusual activity detected');
  }
  // Thresholds trade bot catch-rate against false positives on fast humans (see lab bot-army).
  if (Date.now() - ident.issuedAt < 1000) {
    m.botBlocked.inc({ reason: 'fresh_account' });
    throw new HttpError(403, 'BOT_SUSPECTED', 'please try again in a moment');
  }
  const viewed = await redis.run('pv_get', (r) => r.get(`bc:pv:${ident.userId}:${productId}`)).catch(() => 'unknown');
  if (viewed === 'unknown') return; // fail open
  if (!viewed) {
    m.botBlocked.inc({ reason: 'no_product_view' });
    throw new HttpError(403, 'BOT_SUSPECTED', 'unusual activity detected');
  }
  if (Date.now() - Number(viewed) < 400) {
    m.botBlocked.inc({ reason: 'too_fast' });
    throw new HttpError(403, 'BOT_SUSPECTED', 'unusual activity detected');
  }
}

export async function checkCheckoutVelocity(redis: DataRedis, userId: string) {
  if (runtime.flag('gateway.botProtection') !== 'on') return;
  const key = `bc:bv:${userId}:${Math.floor(Date.now() / 60_000)}`;
  const n = await redis
    .run('velocity', async (r) => {
      const [[, count]] = (await r.multi().incr(key).expire(key, 120).exec()) as [[null, number], [null, number]];
      return count;
    })
    .catch(() => 0);
  // A legitimate checkout can take several attempts (queue pass, coupon gone, retries,
  // double clicks); scalper bots make dozens. 10/min separates them with margin.
  if (n > 10) {
    m.botBlocked.inc({ reason: 'checkout_velocity' });
    throw new HttpError(403, 'BOT_SUSPECTED', 'too many checkout attempts');
  }
}

/* ------------------------------------------------------------------ waiting room */

const ADMIT_LUA = `
local seq = tonumber(redis.call('GET', KEYS[1]) or '0')
local admitted = tonumber(redis.call('GET', KEYS[2]) or '0')
local nextv = math.min(seq, admitted + tonumber(ARGV[1]))
redis.call('SET', KEYS[2], nextv)
return {nextv - admitted, seq - nextv}
`;

const WR_SEQ = 'bc:wr:seq';
const WR_ADMITTED = 'bc:wr:admitted';

export async function joinQueue(redis: DataRedis, userId: string) {
  const [ticket, admitted] = await redis.run('wr_join', async (r) => {
    const t = await r.incr(WR_SEQ);
    const a = Number((await r.get(WR_ADMITTED)) ?? 0);
    return [t, a] as const;
  });
  const position = Math.max(0, ticket - admitted);
  return { ticket, position, etaSec: Math.ceil(position / Math.max(1, runtime.tuning.waitingRoomAdmitPerSec)), userId };
}

export async function queueStatus(redis: DataRedis, userId: string, ticket: number) {
  const admitted = Number((await redis.run('wr_status', (r) => r.get(WR_ADMITTED))) ?? 0);
  if (ticket <= admitted) {
    const exp = Date.now() + 120_000;
    const data = `${ticket}.${userId}.${exp}`;
    return { admitted: true, position: 0, etaSec: 0, pass: `${Buffer.from(data).toString('base64url')}.${sign(data)}` };
  }
  const position = ticket - admitted;
  return { admitted: false, position, etaSec: Math.ceil(position / Math.max(1, runtime.tuning.waitingRoomAdmitPerSec)) };
}

export function checkPass(req: FastifyRequest, userId: string) {
  const raw = req.headers['x-queue-pass'];
  if (typeof raw === 'string') {
    const [b64, sig] = raw.split('.');
    if (b64 && sig) {
      const data = Buffer.from(b64, 'base64url').toString();
      const [, uid, exp] = data.split('.');
      if (verify(data, sig) && uid === userId && Number(exp) > Date.now()) return;
    }
  }
  m.waitingRoomRejected.inc();
  throw new HttpError(409, 'QUEUE_REQUIRED', 'high demand — please join the queue', true);
}

let admitScript: ReturnType<DataRedis['script']> | undefined;

/** Admit N users per second. One gateway instance wins each tick via SET NX. */
export async function admissionTick(redis: DataRedis) {
  const sec = Math.floor(Date.now() / 1000);
  const won = await redis.run('wr_tick', (r) => r.set(`bc:wr:tick:${sec}`, '1', 'EX', 5, 'NX')).catch(() => null);
  if (won !== 'OK') return;
  admitScript ??= redis.script('bcAdmit', 2, ADMIT_LUA);
  const admitFn = admitScript;
  const [admittedNow, waiting] = (await redis
    .run('wr_admit', () => admitFn([WR_SEQ, WR_ADMITTED], [runtime.tuning.waitingRoomAdmitPerSec]))
    .catch(() => [0, 0])) as [number, number];
  if (admittedNow > 0) m.waitingRoomAdmitted.inc(admittedNow);
  m.waitingRoomLength.set(waiting);
}
