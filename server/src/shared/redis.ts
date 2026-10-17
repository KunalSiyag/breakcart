import Redis from 'ioredis';
import { config } from './config';
import { emitEvent } from './events';
import { logger } from './logger';
import { m } from './metrics';
import { runtime } from './runtime';
import { sleep } from './util';

export class RedisUnavailableError extends Error {
  constructor(message = 'redis unavailable') {
    super(message);
  }
}

/**
 * The data-path Redis client. Every command goes through `run()` so that
 * chaos (latency / outage) and metrics apply uniformly.
 */
export class DataRedis {
  readonly client: Redis;

  constructor(url = config.redisUrl) {
    this.client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 2000,
      connectTimeout: 3000,
    });
    this.client.on('error', (err) => {
      logger.warn({ err: err.message }, 'redis error');
      emitEvent('warn', 'redis-error', `Redis client error: ${err.message}`);
    });
  }

  async connect() {
    await this.client.connect();
  }

  /**
   * Register a Lua script once; calls then use EVALSHA (falling back to EVAL after a
   * Redis restart) instead of shipping the script text on every request.
   */
  script(name: string, numberOfKeys: number, lua: string): (keys: string[], args: (string | number)[]) => Promise<unknown> {
    this.client.defineCommand(name, { numberOfKeys, lua });
    const fn = (this.client as unknown as Record<string, (...a: (string | number)[]) => Promise<unknown>>)[name].bind(this.client);
    return (keys, args) => fn(...keys, ...args);
  }

  async run<T>(op: string, fn: (r: Redis) => Promise<T>): Promise<T> {
    const chaos = runtime.chaos();
    const end = m.redisCmd.startTimer({ op });
    try {
      if (chaos.redisDown) {
        await sleep(25);
        throw new RedisUnavailableError('redis unavailable (chaos: redisDown)');
      }
      if (chaos.redisLatencyMs > 0) await sleep(chaos.redisLatencyMs);
      const out = await fn(this.client);
      end({ outcome: 'ok' });
      return out;
    } catch (err) {
      end({ outcome: 'error' });
      if (err instanceof RedisUnavailableError) throw err;
      throw new RedisUnavailableError((err as Error).message);
    }
  }

  disconnect() {
    this.client.disconnect();
  }
}

/** Redis connection for blocking or subscribe use (no chaos wrapper). */
export function rawRedis(name: string): Redis {
  const r = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
  r.on('error', (err) => logger.warn({ err: err.message, name }, 'redis error'));
  return r;
}
