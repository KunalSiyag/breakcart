import { emitEvent } from './events';
import { m } from './metrics';
import { runtime } from './runtime';
import { burnCpu, chance, HttpError, sleep } from './util';

/**
 * Process-level chaos: memory leaks and stop-the-world pauses. Request-level chaos
 * (latency, errors, hangs, CPU burn) is applied by `applyRequestChaos` in the HTTP server.
 */
const leaked: Buffer[] = [];
let lastLeakTick = Date.now();
let lastPause = Date.now();
let leakedMb = 0;

export function startProcessChaos() {
  const t = setInterval(() => {
    const c = runtime.chaos();
    const now = Date.now();

    // Memory leak: retain `leakMbPerMin` MB per minute in a module-level array
    // (like an unbounded in-process cache or a listener that is never removed).
    if (c.leakMbPerMin > 0) {
      const mb = (c.leakMbPerMin * (now - lastLeakTick)) / 60_000;
      const bytes = Math.floor(mb * 1024 * 1024);
      if (bytes > 0) {
        const buf = Buffer.alloc(bytes, 1); // touch pages so RSS really grows
        leaked.push(buf);
        leakedMb += bytes / 1024 / 1024;
        if (Math.floor(leakedMb) % 50 === 0 && Math.floor(leakedMb) > 0) {
          emitEvent('warn', 'memory-leak', `Retained heap growing: ${Math.round(leakedMb)}MB leaked`, undefined, { throttleMs: 10_000 });
        }
      }
    } else if (leaked.length) {
      leaked.length = 0;
      leakedMb = 0;
    }
    lastLeakTick = now;

    // GC pause simulation: block the event loop.
    if (c.gcPauseMs > 0 && now - lastPause >= c.gcPauseEverySec * 1000) {
      lastPause = now;
      burnCpu(c.gcPauseMs);
    }

    m.chaosActive.set({ kind: 'latency' }, c.latencyMs > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'errors' }, c.errorPct > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'hang' }, c.hangPct > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'cpu_burn' }, c.cpuBurnMs > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'memory_leak' }, c.leakMbPerMin > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'gc_pause' }, c.gcPauseMs > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'clock_skew' }, c.clockSkewMs !== 0 ? 1 : 0);
    m.clockOffset.set(c.clockSkewMs / 1000);
    m.chaosActive.set({ kind: 'db_slow' }, c.dbSlowMs > 0 && c.dbSlowPct > 0 ? 1 : 0);
    m.chaosActive.set({ kind: 'redis' }, c.redisDown || c.redisLatencyMs > 0 ? 1 : 0);
  }, 100);
  t.unref();
}

/** Per-request fault injection. Returns normally or throws an HttpError. */
export async function applyRequestChaos(): Promise<void> {
  const c = runtime.chaos();
  if (c.cpuBurnMs > 0) burnCpu(c.cpuBurnMs);
  if (c.latencyMs > 0 && chance(c.latencyPct)) {
    await sleep(c.latencyMs + Math.random() * c.latencyJitterMs);
  }
  if (chance(c.hangPct)) {
    await sleep(c.hangMs);
    throw new HttpError(504, 'INJECTED_FAULT', 'request hung (chaos)', true);
  }
  if (chance(c.errorPct)) {
    throw new HttpError(500, 'INJECTED_FAULT', 'injected failure (chaos)', true);
  }
}
