import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { config } from './config';
import {
  DATA_CHAOS_DEFAULTS,
  defaultRuntimeState,
  KEYS,
  PAYMENTS_CHAOS_DEFAULTS,
  SERVICE_CHAOS_DEFAULTS,
  TUNING_DEFAULTS,
  type DataChaos,
  type FlagKey,
  type Flags,
  type PaymentsChaos,
  type RuntimeState,
  type ServiceChaos,
  type ServiceName,
  type Tuning,
} from './defs';
import { logger } from './logger';

export interface Command {
  action: 'kill' | 'flush-l1' | 'invalidate' | 'reset-inflight';
  target?: string;
  keys?: string[];
}

/**
 * Live view of flags / chaos / tuning. Loaded from Redis at boot, refreshed on
 * pub/sub notification and polled every 3s as a fallback (pub/sub is fire-and-forget).
 *
 * Uses its own Redis connections so that simulated Redis chaos never cuts a service
 * off from its control plane.
 */
class Runtime extends EventEmitter {
  state: RuntimeState = defaultRuntimeState();
  private redis?: Redis;
  private sub?: Redis;
  private timer?: NodeJS.Timeout;
  private mergedChaos?: ServiceChaos;

  async start(): Promise<void> {
    this.redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.sub = new Redis(config.redisUrl, { lazyConnect: true });
    await this.redis.connect();
    await this.sub.connect();
    await this.reload();
    await this.sub.subscribe(KEYS.runtimeChannel, KEYS.commandChannel);
    this.sub.on('message', (channel, message) => {
      if (channel === KEYS.runtimeChannel) {
        void this.reload();
      } else if (channel === KEYS.commandChannel) {
        try {
          this.emit('command', JSON.parse(message) as Command);
        } catch {
          /* ignore malformed command */
        }
      }
    });
    this.timer = setInterval(() => void this.reload(), 3000);
    this.timer.unref();
  }

  async reload(): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get(KEYS.runtime);
      if (!raw) return;
      const next = JSON.parse(raw) as RuntimeState;
      if (next.version === this.state.version) return;
      const prev = this.state;
      this.state = normalize(next);
      this.mergedChaos = undefined;
      this.emit('change', this.state, prev);
    } catch (err) {
      logger.warn({ err }, 'runtime reload failed');
    }
  }

  flag<K extends FlagKey>(key: K): Flags[K] {
    return this.state.flags[key];
  }

  get tuning(): Tuning {
    return this.state.tuning;
  }

  /** Chaos for this process' service (or another service when asked). */
  chaos(service: ServiceName = config.service): ServiceChaos {
    if (service === config.service) {
      if (!this.mergedChaos) {
        this.mergedChaos = { ...SERVICE_CHAOS_DEFAULTS, ...(this.state.chaos.services[service] ?? {}) };
      }
      return this.mergedChaos;
    }
    return { ...SERVICE_CHAOS_DEFAULTS, ...(this.state.chaos.services[service] ?? {}) };
  }

  get payments(): PaymentsChaos {
    return this.state.chaos.payments;
  }

  get data(): DataChaos {
    return this.state.chaos.data;
  }

  /** Wall clock as seen by this service (chaos can skew it). */
  now(): number {
    return Date.now() + this.chaos().clockSkewMs;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.sub?.disconnect();
    this.redis?.disconnect();
  }
}

function normalize(s: RuntimeState): RuntimeState {
  const d = defaultRuntimeState();
  return {
    version: s.version,
    updatedAt: s.updatedAt,
    flags: { ...d.flags, ...(s.flags ?? {}) },
    chaos: {
      services: s.chaos?.services ?? {},
      payments: { ...PAYMENTS_CHAOS_DEFAULTS, ...(s.chaos?.payments ?? {}) },
      data: { ...DATA_CHAOS_DEFAULTS, ...(s.chaos?.data ?? {}) },
    },
    tuning: { ...TUNING_DEFAULTS, ...(s.tuning ?? {}) },
  };
}

export const runtime = new Runtime();
