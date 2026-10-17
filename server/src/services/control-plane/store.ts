import type Redis from 'ioredis';
import {
  DATA_CHAOS_DEFAULTS,
  defaultRuntimeState,
  FLAGS,
  KEYS,
  PAYMENTS_CHAOS_DEFAULTS,
  SERVICE_CHAOS_DEFAULTS,
  SERVICES,
  TUNING_DEFAULTS,
  type FlagKey,
  type RuntimeState,
} from '../../shared/defs';
import { emitEvent } from '../../shared/events';
import type { RuntimePatch } from '../../shared/scenarios';
import { deepMerge, HttpError } from '../../shared/util';

/**
 * The single writer of runtime state. Validates every patch against defs.ts, bumps the
 * version, persists to Redis and notifies all services.
 */
export class RuntimeStore {
  constructor(private redis: Redis) {}

  async get(): Promise<RuntimeState> {
    const raw = await this.redis.get(KEYS.runtime);
    if (!raw) {
      const s = defaultRuntimeState();
      await this.save(s);
      return s;
    }
    const parsed = JSON.parse(raw) as RuntimeState;
    const d = defaultRuntimeState();
    return {
      ...parsed,
      flags: { ...d.flags, ...parsed.flags },
      tuning: { ...d.tuning, ...parsed.tuning },
      chaos: {
        services: parsed.chaos?.services ?? {},
        payments: { ...d.chaos.payments, ...parsed.chaos?.payments },
        data: { ...d.chaos.data, ...parsed.chaos?.data },
      },
    };
  }

  private async save(s: RuntimeState) {
    await this.redis.set(KEYS.runtime, JSON.stringify(s));
    await this.redis.publish(KEYS.runtimeChannel, String(s.version));
  }

  async update(mutator: (s: RuntimeState) => RuntimeState | void): Promise<RuntimeState> {
    const cur = await this.get();
    const next = (mutator(structuredClone(cur)) ?? cur) as RuntimeState;
    next.version = cur.version + 1;
    next.updatedAt = new Date().toISOString();
    await this.save(next);
    return next;
  }

  async apply(patch: RuntimePatch, source = 'operator'): Promise<RuntimeState> {
    validatePatch(patch);
    const changes = describePatch(patch);
    const next = await this.update((s) => {
      if (patch.flags) s.flags = { ...s.flags, ...patch.flags } as RuntimeState['flags'];
      if (patch.tuning) s.tuning = { ...s.tuning, ...patch.tuning };
      if (patch.chaos) s.chaos = deepMerge(s.chaos, patch.chaos);
      return s;
    });
    if (changes.length) {
      const hasBug = Object.entries(patch.flags ?? {}).some(([k, v]) => FLAGS[k as FlagKey].naive === v);
      emitEvent(hasBug ? 'warn' : 'info', 'runtime-change', `${source}: ${changes.join(', ')}`, undefined, { throttleMs: 0 });
    }
    return next;
  }

  async reset(kind: 'hardened' | 'naive', opts: { keepChaos?: boolean } = {}): Promise<RuntimeState> {
    return this.update((s) => {
      const d = defaultRuntimeState();
      s.flags = Object.fromEntries(Object.entries(FLAGS).map(([k, def]) => [k, def[kind]])) as RuntimeState['flags'];
      if (!opts.keepChaos) s.chaos = d.chaos;
      s.tuning = d.tuning;
      return s;
    });
  }

  async clearChaos(): Promise<RuntimeState> {
    return this.update((s) => {
      s.chaos = defaultRuntimeState().chaos;
      return s;
    });
  }
}

function describePatch(p: RuntimePatch): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p.flags ?? {})) out.push(`${k} → ${v}`);
  for (const [svc, c] of Object.entries(p.chaos?.services ?? {})) {
    for (const [k, v] of Object.entries(c ?? {})) out.push(`chaos ${svc}.${k} = ${v}`);
  }
  for (const [k, v] of Object.entries(p.chaos?.payments ?? {})) out.push(`chaos payments.${k} = ${v}`);
  for (const [k, v] of Object.entries(p.chaos?.data ?? {})) out.push(`chaos data.${k} = ${v}`);
  for (const [k, v] of Object.entries(p.tuning ?? {})) out.push(`tuning ${k} = ${v}`);
  return out;
}

function checkNumbers(obj: Record<string, unknown>, defaults: Record<string, unknown>, where: string) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in defaults)) throw new HttpError(400, 'BAD_REQUEST', `unknown ${where} key: ${k}`);
    const want = typeof defaults[k];
    if (typeof v !== want) throw new HttpError(400, 'BAD_REQUEST', `${where}.${k} must be a ${want}`);
    if (want === 'number' && (!Number.isFinite(v as number) || (v as number) < -1e9 || (v as number) > 1e9)) {
      throw new HttpError(400, 'BAD_REQUEST', `${where}.${k} out of range`);
    }
  }
}

export function validatePatch(p: RuntimePatch) {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new HttpError(400, 'BAD_REQUEST', 'patch must be an object');
  for (const [k, v] of Object.entries(p.flags ?? {})) {
    const def = FLAGS[k as FlagKey];
    if (!def) throw new HttpError(400, 'BAD_REQUEST', `unknown flag ${k}`);
    if (!(def.modes as readonly string[]).includes(v as string)) throw new HttpError(400, 'BAD_REQUEST', `invalid mode ${v} for ${k}`);
  }
  if (p.tuning) {
    checkNumbers(p.tuning as Record<string, unknown>, TUNING_DEFAULTS as unknown as Record<string, unknown>, 'tuning');
    for (const [k, v] of Object.entries(p.tuning)) {
      if ((v as number) < 0) throw new HttpError(400, 'BAD_REQUEST', `tuning.${k} must be >= 0`);
    }
    if (p.tuning.dbPoolSize !== undefined && (p.tuning.dbPoolSize < 1 || p.tuning.dbPoolSize > 100)) {
      throw new HttpError(400, 'BAD_REQUEST', 'dbPoolSize must be 1..100');
    }
  }
  if (p.chaos) {
    for (const [svc, c] of Object.entries(p.chaos.services ?? {})) {
      if (!(SERVICES as readonly string[]).includes(svc)) throw new HttpError(400, 'BAD_REQUEST', `unknown service ${svc}`);
      checkNumbers((c ?? {}) as Record<string, unknown>, SERVICE_CHAOS_DEFAULTS as unknown as Record<string, unknown>, `chaos.${svc}`);
    }
    checkNumbers((p.chaos.payments ?? {}) as Record<string, unknown>, PAYMENTS_CHAOS_DEFAULTS as unknown as Record<string, unknown>, 'chaos.payments');
    checkNumbers((p.chaos.data ?? {}) as Record<string, unknown>, DATA_CHAOS_DEFAULTS as unknown as Record<string, unknown>, 'chaos.data');
  }
}
