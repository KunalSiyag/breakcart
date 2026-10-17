/**
 * Rate-limit probe: one client sends requests as fast as it can for a few seconds and we
 * record which were allowed, in 100ms buckets. A fixed-window limiter shows a sawtooth —
 * a burst at the start of every second, then nothing — because every client's window
 * resets at the same instant. A token bucket shows a smooth trickle at the refill rate.
 *
 *   npm run probe:ratelimit                       # through the web edge (http://localhost:8080)
 *   BASE_URL=http://localhost:3000 npm run probe:ratelimit -- --seconds=5
 */
import { Agent, request } from 'undici';

export interface ProbeResult {
  buckets: { atMs: number; allowed: number; limited: number }[];
  /** Max allowed in any 100ms bucket after the first 1.5s (the initial burst is excluded). */
  steadyMaxPer100ms: number;
  /** Max allowed in any sliding 1000ms window. */
  maxPerSecond: number;
  allowed: number;
  limited: number;
}

export async function probeRateLimit(baseUrl: string, seconds = 4, concurrency = 8): Promise<ProbeResult> {
  const agent = new Agent({ connections: concurrency });
  const auth = await request(`${baseUrl}/api/auth/guest`, { method: 'POST', dispatcher: agent, headers: { 'x-forwarded-for': '198.51.100.7' } });
  const { token } = (await auth.body.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.7' };
  const t0 = Date.now();
  const end = t0 + seconds * 1000;
  const events: { t: number; ok: boolean }[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (Date.now() < end) {
        try {
          const res = await request(`${baseUrl}/api/cart`, { dispatcher: agent, headers });
          await res.body.dump();
          if (res.statusCode === 200 || res.statusCode === 429) events.push({ t: Date.now() - t0, ok: res.statusCode === 200 });
        } catch {
          /* ignore */
        }
      }
    }),
  );
  await agent.close();
  const n = Math.ceil((seconds * 1000) / 100);
  const buckets = Array.from({ length: n }, (_, i) => ({ atMs: i * 100, allowed: 0, limited: 0 }));
  for (const e of events) {
    const b = buckets[Math.min(n - 1, Math.floor(e.t / 100))];
    if (e.ok) b.allowed++;
    else b.limited++;
  }
  const okTimes = events.filter((e) => e.ok).map((e) => e.t).sort((a, b) => a - b);
  let maxPerSecond = 0;
  for (let i = 0, j = 0; i < okTimes.length; i++) {
    while (okTimes[i] - okTimes[j] >= 1000) j++;
    maxPerSecond = Math.max(maxPerSecond, i - j + 1);
  }
  return {
    buckets,
    steadyMaxPer100ms: Math.max(0, ...buckets.filter((b) => b.atMs >= 1500).map((b) => b.allowed)),
    maxPerSecond,
    allowed: okTimes.length,
    limited: events.length - okTimes.length,
  };
}

async function main() {
  const base = process.env.BASE_URL ?? 'http://localhost:8080';
  const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 4);
  const r = await probeRateLimit(base, seconds);
  console.log(`allowed ${r.allowed}, limited ${r.limited}; max allowed in any 1s window: ${r.maxPerSecond}; steady-state max per 100ms: ${r.steadyMaxPer100ms}\n`);
  for (const b of r.buckets) {
    console.log(`${String(b.atMs).padStart(5)}ms ${'█'.repeat(b.allowed)}${'·'.repeat(Math.min(40, b.limited))}`);
  }
  console.log('\n█ allowed  · rate-limited (429)');
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
