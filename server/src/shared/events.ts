import Redis from 'ioredis';
import { config } from './config';
import { KEYS } from './defs';
import { logger } from './logger';

export type EventLevel = 'info' | 'warn' | 'critical';

export interface TimelineEvent {
  id: string;
  ts: number;
  level: EventLevel;
  source: string;
  kind: string;
  message: string;
  data?: unknown;
}

let redis: Redis | undefined;
const lastByKind = new Map<string, number>();
let seq = 0;

function conn(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: true });
    redis.on('error', () => {
      /* reported via main client */
    });
  }
  return redis;
}

/**
 * Publish an incident-timeline event (war room feed). Throttled per kind so a
 * failure storm produces one line every few seconds instead of thousands.
 */
export function emitEvent(
  level: EventLevel,
  kind: string,
  message: string,
  data?: unknown,
  opts: { throttleMs?: number } = {},
): void {
  const throttleMs = opts.throttleMs ?? 3000;
  const now = Date.now();
  const key = `${kind}`;
  const last = lastByKind.get(key) ?? 0;
  if (throttleMs > 0 && now - last < throttleMs) return;
  lastByKind.set(key, now);
  const ev: TimelineEvent = {
    id: `${config.service}-${now}-${seq++}`,
    ts: now,
    level,
    source: config.service,
    kind,
    message,
    data,
  };
  const payload = JSON.stringify(ev);
  const r = conn();
  r.multi()
    .publish(KEYS.eventsChannel, payload)
    .lpush(KEYS.eventsLog, payload)
    .ltrim(KEYS.eventsLog, 0, 499)
    .exec()
    .catch((err) => logger.debug({ err }, 'emitEvent failed'));
  const logFn = level === 'critical' ? logger.error : level === 'warn' ? logger.warn : logger.info;
  logFn.call(logger, { kind, data }, message);
}

export function closeEvents() {
  redis?.disconnect();
}
