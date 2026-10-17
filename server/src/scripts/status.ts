/**
 * Terminal war room.
 *
 *   npm run status            # one snapshot
 *   npm run status -- --watch # refresh every 2s
 */
const CP = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3010';

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };
const color = (v: number, warn: number, crit: number, s: string) => (v >= crit ? C.red : v >= warn ? C.yellow : C.green) + s + C.reset;
const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${CP}${path}`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

async function render(): Promise<string> {
  const [summary, loadgen, integrity, events] = await Promise.all([
    get<any>('/control/summary'),
    get<any>('/control/loadgen'),
    get<any>('/control/integrity'),
    get<any>('/control/events/recent'),
  ]);
  if (!summary) return `${C.red}control plane unreachable at ${CP}${C.reset}`;
  const out: string[] = [];
  const g = summary.gateway;
  const b = summary.business;
  const sale = summary.sale;
  out.push(
    `${C.bold}BreakCart${C.reset}  ${new Date().toLocaleTimeString()}  sale: ${sale ? `${sale.name} ${sale.live ? `${C.green}LIVE${C.reset}` : `${C.yellow}starts ${new Date(sale.startsAt).toLocaleTimeString()}${C.reset}`}` : '-'}`,
  );
  if (loadgen?.running) {
    out.push(
      `scenario ${C.bold}${loadgen.scenarioName}${C.reset} [${loadgen.phase}] ${loadgen.elapsedSec}/${loadgen.durationSec}s  x${loadgen.multiplier}  arrivals ${f(loadgen.actualArrivalPerSec)}/${f(loadgen.targetArrivalPerSec)}/s  active ${loadgen.activeSessions}`,
    );
  } else out.push(`${C.dim}no scenario running${C.reset}`);
  out.push('');
  out.push(
    `gateway  rps ${f(g.rps)}  err ${color(g.errorPct, 1, 5, f(g.errorPct, 1) + '%')}  p50 ${f(g.p50Ms)}ms  p95 ${color(g.p95Ms, 500, 2000, f(g.p95Ms) + 'ms')}  p99 ${color(g.p99Ms, 1000, 5000, f(g.p99Ms) + 'ms')}  inflight ${f(g.inflight)}`,
  );
  out.push(
    `business checkouts/min ${f(b.checkoutsPerMin)}  paid/min ${f(b.paidPerMin)}  GMV/min ₹${f(b.gmvPerMinCents / 100)}  pay ok ${f(b.paymentSuccessPct, 1)}%  cache hit ${f(b.cacheHitPct, 1)}%`,
  );
  out.push(
    `edge     queue ${f(b.waitingRoomLength)}  limited/s ${f(b.rateLimitedPerSec, 1)}  shed/s ${f(b.shedPerSec, 1)}  bots/s ${f(b.botBlockedPerSec, 1)}  retries/s ${f(b.retriesPerSec, 1)}  deadlocks/min ${f(b.dbDeadlocksPerMin)}  lag ${f(b.consumerLag)}  dlq ${f(b.dlqDepth)}`,
  );
  out.push('');
  out.push(`${C.dim}${pad('service', 16)}${pad('up', 4)}${pad('rps', 8)}${pad('p99', 9)}${pad('err%', 7)}${pad('loop', 8)}${pad('mem', 7)}${pad('cpu%', 6)}pool${C.reset}`);
  for (const s of summary.services) {
    const pool = s.dbPool ? `${s.dbPool.total - s.dbPool.idle}/${s.dbPool.max} busy${s.dbPool.waiting ? ` ${C.red}${s.dbPool.waiting} waiting${C.reset}` : ''}` : '';
    out.push(
      `${pad(s.service, 16)}${s.up ? C.green + 'up' + C.reset + '  ' : C.red + 'DOWN' + C.reset}${pad(f(s.rps), 8)}${pad(f(s.p99Ms) + 'ms', 9)}${pad(f(s.errorPct, 1), 7)}${pad(f(s.eventLoopLagMs) + 'ms', 8)}${pad(f(s.memMb), 7)}${pad(f(s.cpuPct), 6)}${pool}`,
    );
  }
  const open = summary.breakers.filter((x: any) => x.state !== 'closed');
  if (open.length) out.push(`${C.red}breakers: ${open.map((x: any) => `${x.service}→${x.target} ${x.state}`).join(', ')}${C.reset}`);
  if (loadgen?.steps?.length) {
    out.push('', `${C.dim}${pad('customer step', 14)}${pad('rps', 8)}${pad('p50', 8)}${pad('p95', 8)}${pad('p99', 8)}${pad('err%', 7)}top codes${C.reset}`);
    for (const s of [...loadgen.steps].sort((a: any, b: any) => b.rps - a.rps)) {
      const codes = Object.entries(s.codes as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      out.push(`${pad(s.step, 14)}${pad(f(s.rps, 1), 8)}${pad(f(s.p50Ms), 8)}${pad(f(s.p95Ms), 8)}${pad(f(s.p99Ms), 8)}${pad(f(s.errorPct, 1), 7)}${codes}`);
    }
    const ss = loadgen.sessions;
    out.push(`sessions started ${ss.started}  converted ${ss.converted}  abandoned ${ss.abandoned}  failed ${ss.failed}  blocked ${ss.blocked}  sold out ${ss.soldOut}`);
  }
  if (integrity) {
    const v = Object.entries(integrity.violations as Record<string, number>).filter(([, n]) => n > 0);
    out.push(
      '',
      v.length ? `${C.red}${C.bold}INVARIANTS VIOLATED:${C.reset} ${v.map(([k, n]) => `${k}=${n}`).join('  ')}` : `${C.green}business invariants OK${C.reset}`,
      `${C.dim}orders ${integrity.totals.orders}  paid ${integrity.totals.paidOrders}  GMV ₹${f(integrity.totals.gmvCents / 100)}  units sold ${integrity.totals.unitsSold}  shipments ${integrity.totals.shipments}${C.reset}`,
    );
  }
  if (events?.items?.length) {
    out.push('');
    for (const e of events.items.slice(0, 6)) {
      const col = e.level === 'critical' ? C.red : e.level === 'warn' ? C.yellow : C.dim;
      out.push(`${col}${new Date(e.ts).toLocaleTimeString()} ${pad(e.source, 14)} ${e.message}${C.reset}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const watch = process.argv.includes('--watch');
  do {
    const text = await render();
    if (watch) process.stdout.write('\x1b[2J\x1b[H');
    console.log(text);
    if (watch) await new Promise((r) => setTimeout(r, 2000));
  } while (watch);
}

void main();
