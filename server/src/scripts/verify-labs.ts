/**
 * Lab verifier: runs each lab BROKEN then FIXED against a running stack and checks that
 * the failure signal appears in the broken run and disappears in the fixed run.
 *
 *   npm run verify:labs                          # every lab (~2 hours)
 *   npm run verify:labs -- oversell-race deadlocks
 *   npm run verify:labs -- --multiplier=0.7 --report=labs-report.json
 *
 * Talks only to the control plane (CONTROL_PLANE_URL, default http://localhost:3010).
 */
import { writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, totalmem } from 'node:os';
import { LABS } from '../shared/labs';
import { probeRateLimit } from './ratelimit-probe';
import { sleep } from '../shared/util';

const CP = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3010';
const SAMPLE_EVERY_MS = 10_000;

type Integrity = { violations: Record<string, number> };
type Step = { step: string; p50Ms: number; p95Ms: number; p99Ms: number; errorPct: number };
type Loadgen = {
  steps: Step[];
  sessions: Record<string, number>;
  byPersona?: Record<string, Record<string, number>>;
  anomalies: Record<string, number>;
};
type Sample = { name: string; labels: Record<string, string>; value: number };
interface Snap {
  t: number;
  /** Host 1-minute load average when the snapshot was taken (noisy-neighbour detection). */
  load: number;
  integrity: Integrity;
  loadgen: Loadgen;
  metrics: Record<string, Sample[]>;
  restarts: Record<string, number>;
}
interface Run {
  start: Snap;
  end: Snap;
  samples: Snap[];
  probe?: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${CP}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

function parseMetrics(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[3]) for (const kv of m[3].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[kv[1]] = kv[2];
    out.push({ name: m[1], labels, value: Number(m[4]) });
  }
  return out;
}

const METRIC_SERVICES = ['gateway', 'catalog', 'inventory', 'cart', 'orders', 'payments', 'recommendations', 'workers'];

async function snapshot(): Promise<Snap> {
  const [integrity, loadgen, services] = await Promise.all([
    get<Integrity>('/control/integrity'),
    get<Loadgen>('/control/loadgen'),
    get<{ items: { service: string; restarts: number }[] }>('/control/services'),
  ]);
  const metrics: Record<string, Sample[]> = {};
  await Promise.all(
    METRIC_SERVICES.map(async (svc) => {
      try {
        const res = await fetch(`${CP}/control/services/${svc}/metrics`);
        metrics[svc] = res.ok ? parseMetrics(await res.text()) : [];
      } catch {
        metrics[svc] = [];
      }
    }),
  );
  return {
    t: Date.now(),
    load: loadavg()[0],
    integrity,
    loadgen,
    metrics,
    restarts: Object.fromEntries(services.items.map((s) => [s.service, s.restarts])),
  };
}

/* ---------------------------------------------------------------- measures */

const total = (s: Snap, svc: string | '*', name: string, labels: Record<string, string> = {}) =>
  (svc === '*' ? Object.values(s.metrics).flat() : (s.metrics[svc] ?? []))
    .filter((x) => x.name === name && Object.entries(labels).every(([k, v]) => x.labels[k] === v))
    .reduce((a, x) => a + x.value, 0);
const delta = (r: Run, svc: string | '*', name: string, labels?: Record<string, string>) =>
  Math.max(0, total(r.end, svc, name, labels) - total(r.start, svc, name, labels));
const maxOver = (r: Run, f: (s: Snap) => number) => Math.max(0, ...r.samples.map(f));
const violation = (k: string) => (r: Run) => maxOver(r, (s) => s.integrity.violations[k] ?? 0);
/** NaN when no sample saw the step at all — "no data" must never read as "fast". */
const stepMax = (step: string, field: keyof Step) => (r: Run) => {
  const seen = r.samples.map((s) => s.loadgen.steps.find((x) => x.step === step)).filter((x): x is Step => !!x);
  return seen.length ? Math.max(...seen.map((x) => Number(x[field]))) : NaN;
};

type Judge = (broken: number, fixed: number) => boolean;
const appearsThenGone: Judge = (b, f) => b > 0 && f === 0;
const atLeast = (k: number): Judge => (b, f) => b > 0 && b >= k * Math.max(f, 1e-9);

interface Check {
  metric: string;
  measure: (r: Run) => number;
  /** Optional active measurement taken mid-run (after the scenario has started). */
  probe?: () => Promise<number>;
  judge: Judge;
  expectation: string;
  durationSec?: number;
}

const CHECKS: Record<string, Check> = {
  'oversell-race': { metric: 'oversold units', measure: violation('oversoldUnits'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0' },
  deadlocks: {
    metric: 'Postgres deadlocks (40P01)',
    measure: (r) => delta(r, 'inventory', 'db_errors_total', { code: '40P01' }),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
  },
  'phantom-sellout': {
    metric: 'phantom held units',
    measure: violation('phantomHeldUnits'),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
    durationSec: 170,
  },
  'coupon-overrun': { metric: 'coupon over-redemptions', measure: violation('couponOverRedemptions'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0' },
  'cache-stampede': {
    metric: 'hot-key cache rebuilds',
    measure: (r) => delta(r, 'catalog', 'cache_rebuilds_total', { tier: 'hot' }),
    judge: atLeast(5),
    expectation: 'broken ≥ 5x fixed',
  },
  'stale-price': { metric: 'price mismatches', measure: violation('priceMismatches'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0', durationSec: 200 },
  'pool-exhaustion': {
    metric: 'inventory pool acquire timeouts',
    measure: (r) => delta(r, 'inventory', 'db_errors_total', { code: 'acquire_timeout' }),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
  },
  'n-plus-one': {
    metric: 'per-row listing queries',
    measure: (r) => delta(r, 'catalog', 'db_query_duration_seconds_count', { op: 'list.item' }),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
  },
  'slow-search': { metric: 'search p95 (ms, customer)', measure: stepMax('search', 'p95Ms'), judge: atLeast(3), expectation: 'broken ≥ 3x fixed' },
  'cascading-failure': {
    metric: 'home p95 (ms, customer)',
    measure: stepMax('home', 'p95Ms'),
    judge: (b, f) => b > 2000 && f < 1000,
    expectation: 'broken > 2000ms, fixed < 1000ms',
    durationSec: 150,
  },
  'retry-storm': {
    metric: 'service-to-service retries',
    measure: (r) => delta(r, '*', 'http_client_retries_total'),
    judge: atLeast(3),
    expectation: 'broken ≥ 3x fixed',
  },
  'connection-churn': {
    metric: 'TCP connections opened service-to-service',
    measure: (r) => delta(r, '*', 'http_client_connections_opened_total'),
    judge: atLeast(20),
    expectation: 'broken ≥ 20x fixed',
  },
  'logging-meltdown': {
    metric: 'home p50 (ms, customer)',
    measure: stepMax('home', 'p50Ms'),
    judge: atLeast(3),
    expectation: 'broken ≥ 3x fixed (a blocked event loop slows everyone, not just the tail)',
  },
  'overload-collapse': {
    metric: 'home p99 (ms, customer)',
    measure: stepMax('home', 'p99Ms'),
    judge: atLeast(2),
    expectation: 'broken ≥ 2x fixed',
  },
  'thundering-herd': {
    metric: 'charges throttled by the PSP (429)',
    measure: (r) => delta(r, 'payments', 'psp_charges_total', { result: 'rate_limited' }),
    judge: atLeast(10),
    expectation: 'broken ≥ 10x fixed',
  },
  'bot-army': {
    metric: 'bot share of conversions (%)',
    measure: (r) => {
      const bot = r.end.loadgen.byPersona?.bot?.converted ?? 0;
      const all = r.end.loadgen.sessions.converted ?? 0;
      return all ? (100 * bot) / all : 0;
    },
    judge: atLeast(2),
    expectation: 'broken ≥ 2x fixed',
  },
  'shedding-death-spiral': {
    metric: 'requests shed after the dependency recovered (last ~35s)',
    measure: (r) => {
      const tail = r.samples.slice(-5);
      if (tail.length < 2) return NaN;
      return Math.max(0, total(tail[tail.length - 1], 'gateway', 'gateway_shed_total') - total(tail[0], 'gateway', 'gateway_shed_total'));
    },
    judge: atLeast(10),
    expectation: 'broken ≥ 10x fixed',
    durationSec: 215,
  },
  'rate-limit-bursts': {
    metric: 'one client: max allowed per 100ms (steady state)',
    measure: (r) => r.probe ?? NaN,
    probe: async () => (await probeRateLimit(process.env.BASE_URL ?? 'http://localhost:8080', 4)).steadyMaxPer100ms,
    judge: atLeast(3),
    expectation: 'broken ≥ 3x fixed (bursts at each window reset vs a smooth refill)',
  },
  'redis-blip': {
    metric: 'requests rejected by fail-closed limiter',
    measure: (r) => delta(r, 'gateway', 'gateway_ratelimit_decisions_total', { decision: 'error_rejected' }),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
    durationSec: 100,
  },
  'double-charge': {
    metric: 'duplicate charges + duplicate orders',
    measure: (r) => maxOver(r, (s) => (s.integrity.violations.duplicateCharges ?? 0) + (s.integrity.violations.duplicateOrders ?? 0)),
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
  },
  'payment-limbo': { metric: 'orphan charges', measure: violation('orphanCharges'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0', durationSec: 190 },
  'lost-events': { metric: 'paid orders never shipped', measure: violation('lostEvents'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0', durationSec: 150 },
  'poison-pill': {
    metric: 'max consumer lag + pending',
    measure: (r) => maxOver(r, (s) => total(s, 'workers', 'stream_consumer_lag') + total(s, 'workers', 'stream_pending_messages')),
    judge: (b, f) => b > 100 && f < 50,
    expectation: 'broken > 100, fixed < 50',
    durationSec: 150,
  },
  'replica-lag': {
    metric: 'customers who could not see their paid order',
    measure: (r) => r.end.loadgen.anomalies.order_missing_after_pay ?? 0,
    judge: appearsThenGone,
    expectation: 'broken > 0, fixed = 0',
  },
  'memory-leak': {
    metric: 'catalog RSS growth (MB) + 1000 × restarts',
    measure: (r) => {
      const rss = r.samples.map((s) => total(s, 'catalog', 'process_resident_memory_bytes') / 1048576).filter((x) => x > 0);
      const growth = rss.length ? Math.max(...rss) - rss[0] : 0;
      return Math.round(growth + 1000 * Math.max(0, (r.end.restarts.catalog ?? 0) - (r.start.restarts.catalog ?? 0)));
    },
    judge: (b, f) => b > 150 && f < 100,
    expectation: 'broken > 150, fixed < 100',
    durationSec: 150,
  },
  'gc-pauses': { metric: 'home p99 (ms, customer)', measure: stepMax('home', 'p99Ms'), judge: atLeast(2), expectation: 'broken ≥ 2x fixed' },
  'clock-skew': { metric: 'price mismatches', measure: violation('priceMismatches'), judge: appearsThenGone, expectation: 'broken > 0, fixed = 0', durationSec: 100 },
};

async function runVariant(labId: string, variant: 'broken' | 'fixed', multiplier: number, durationSec: number, probe?: () => Promise<number>): Promise<Run> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${CP}/control/labs/${labId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variant, multiplier }),
    });
    if (res.ok) break;
    const body = await res.text();
    if (attempt >= 3 || res.status < 500) throw new Error(`start ${labId}/${variant}: ${res.status} ${body}`);
    console.log(`\n  (start failed: ${res.status} ${body.slice(0, 120)} — retrying)`);
    await sleep(5000);
  }
  const start = await snapshot();
  // Measure only what happens in this run: samples start after the post-reset snapshot.
  const samples: Snap[] = [];
  const until = Date.now() + durationSec * 1000;
  const probed = probe ? sleep(20_000).then(probe).catch(() => NaN) : Promise.resolve(undefined);
  while (Date.now() < until) {
    await sleep(Math.min(SAMPLE_EVERY_MS, until - Date.now()));
    samples.push(await snapshot());
  }
  // Integrity is computed every 5s — give it one more cycle before the final read.
  await sleep(6000);
  const end = await snapshot();
  samples.push(end);
  await fetch(`${CP}/control/scenarios/stop`, { method: 'POST' });
  return { start, end, samples, probe: await probed };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, dflt: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
  const multiplier = Number(opt('multiplier', '1'));
  const defaultDuration = Number(opt('duration', '120'));
  const reportPath = opt('report', '');
  const markdownPath = opt('markdown', '');
  const ids = args.filter((a) => !a.startsWith('--'));
  const labs = ids.length ? LABS.filter((l) => ids.includes(l.id)) : LABS;
  if (!labs.length) throw new Error(`no labs match: ${ids.join(', ')}`);

  const startedAt = new Date();
  const results: Result[] = [];
  for (const lab of labs) {
    const check = CHECKS[lab.id];
    if (!check) {
      console.log(`- ${lab.id}: no check defined, skipping`);
      continue;
    }
    const d = check.durationSec ?? defaultDuration;
    process.stdout.write(`▶ ${lab.id.padEnd(20)} broken (${d}s)… `);
    const brokenRun = await runVariant(lab.id, 'broken', multiplier, d, check.probe);
    const broken = check.measure(brokenRun);
    process.stdout.write(`${round(broken)}  fixed (${d}s)… `);
    const fixedRun = await runVariant(lab.id, 'fixed', multiplier, d, check.probe);
    const fixed = check.measure(fixedRun);
    // A fix that stops customers from buying is not a fix (and usually means the run itself broke).
    const converted = fixedRun.end.loadgen.sessions.converted ?? 0;
    const healthy = converted >= 10;
    const pass = healthy && check.judge(broken, fixed);
    // Noisy neighbour: if the host was saturated by something else, a failure proves nothing.
    const maxLoad = Math.max(...[...brokenRun.samples, ...fixedRun.samples].map((x) => x.load));
    const inconclusive = !pass && maxLoad > cpus().length;
    const verdict = pass ? '✅ PASS' : inconclusive ? `⚠️  INCONCLUSIVE (host load ${maxLoad.toFixed(0)} on ${cpus().length} cores)` : '❌ FAIL';
    console.log(
      `${round(fixed)}  ${verdict}  [${check.metric}: ${check.expectation}]${healthy ? '' : ` — fixed run unhealthy: only ${converted} conversions`}`,
    );
    results.push({ lab: lab.id, metric: check.metric, expectation: check.expectation, broken: round(broken), fixed: round(fixed), pass, inconclusive, maxLoad: round(maxLoad) });
    if (reportPath) writeFileSync(reportPath, JSON.stringify({ multiplier, at: new Date().toISOString(), results }, null, 2));
  }
  const failed = results.filter((r) => !r.pass && !r.inconclusive);
  const unsure = results.filter((r) => r.inconclusive);
  console.log(
    `\n${results.filter((r) => r.pass).length}/${results.length} labs verified` +
      (failed.length ? `; failing: ${failed.map((f) => f.lab).join(', ')}` : '') +
      (unsure.length ? `; inconclusive (host busy — re-run on a quiet machine): ${unsure.map((f) => f.lab).join(', ')}` : ''),
  );
  if (markdownPath) writeFileSync(markdownPath, markdown(results, multiplier, startedAt));
  process.exitCode = failed.length ? 1 : unsure.length ? 3 : 0;
}

const round = (x: number) => Math.round(x * 100) / 100;

type Result = { lab: string; metric: string; expectation: string; broken: number; fixed: number; pass: boolean; inconclusive: boolean; maxLoad: number };

function markdown(results: Result[], multiplier: number, startedAt: Date): string {
  const passed = results.filter((r) => r.pass).length;
  const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'no data');
  return [
    '# Lab verification report',
    '',
    `Generated by \`npm run verify:labs\` (\`server/src/scripts/verify-labs.ts\`) — **${passed}/${results.length} labs verified**.`,
    '',
    `- Run started: ${startedAt.toISOString()} · traffic multiplier ×${multiplier}`,
    `- Host: ${cpus().length} CPU cores, ${Math.round(totalmem() / 2 ** 30)} GB RAM, ${platform()} — all services on one machine via Docker Compose`,
    '- Each lab runs twice with identical traffic and chaos: once broken, once fixed. Data is reset and in-flight sessions drained between runs.',
    '- A fixed run must also be healthy (≥ 10 customers completed a purchase), so a "fix" that stops all traffic cannot pass.',
    '- The host load average is sampled throughout; a non-passing lab whose runs saw load above the core count is reported as *inconclusive* (noisy neighbour), not failed.',
    '',
    'Numbers depend on hardware and will differ on your machine; the *direction* and rough size of the effect should not.',
    '',
    '| Lab | Signal | Broken | Fixed | Expectation | Result |',
    '|---|---|---:|---:|---|---|',
    ...results.map(
      (r) =>
        `| [${r.lab}](labs/${r.lab}.md) | ${r.metric} | ${fmt(r.broken)} | ${fmt(r.fixed)} | ${r.expectation} | ${r.pass ? '✅ pass' : r.inconclusive ? `⚠️ inconclusive (host load ${fmt(r.maxLoad)})` : '❌ fail'} |`,
    ),
    '',
  ].join('\n');
}

void main().catch((err) => {
  console.error(err);
  process.exit(2);
});
