import type { BreakerState, KnobValue, ServiceHealth, ServiceStats } from '../../api/types';
import { formatDuration, formatInt, formatMs, formatNum, formatPct, toMillis } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { fieldLabel } from '../fields';
import { useOps } from '../store';
import { serviceLevels, type Level } from '../thresholds';
import { Empty, Panel, StatusPill } from './ui';

function Metric({ label, value, level = 'none' }: { label: string; value: string; level?: Level }) {
  return (
    <div className={`svc-metric lvl-${level}`}>
      <dt>{label}</dt>
      <dd>
        {level === 'crit' ? (
          <span aria-label="critical">■ </span>
        ) : level === 'warn' || level === 'serious' ? (
          <span aria-label="warning">▲ </span>
        ) : null}
        {value}
      </dd>
    </div>
  );
}

export function PoolBar({ pool }: { pool: NonNullable<ServiceStats['dbPool']> }) {
  const busy = Math.max(0, pool.total - pool.idle);
  // Size the bar against the configured maximum when known (pools open connections lazily).
  const capacity = Math.max(pool.max ?? 0, pool.total);
  const pct = capacity > 0 ? Math.min(100, (busy / capacity) * 100) : 0;
  const level: Level = pool.waiting > 0 ? 'crit' : pct >= 90 ? 'warn' : 'ok';
  return (
    <div className={`pool lvl-${level}`} title={`${busy} busy · ${pool.idle} idle · ${pool.total} open${pool.max ? ` · max ${pool.max}` : ''}`}>
      <div className="pool-head">
        <span>DB pool</span>
        <span>
          {formatInt(busy)}/{formatInt(capacity)} busy
          {pool.waiting > 0 && (
            <strong className="pool-waiting">
              {' '}
              · <span aria-hidden="true">■</span> {formatInt(pool.waiting)} waiting
            </strong>
          )}
        </span>
      </div>
      <div
        className="pool-bar"
        role="meter"
        aria-label="DB connections in use"
        aria-valuemin={0}
        aria-valuemax={capacity}
        aria-valuenow={busy}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function activeChaos(raw: Record<string, KnobValue | undefined> | undefined, defaults: Record<string, KnobValue> | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const d = defaults?.[k];
    if (d !== undefined && v === d) continue;
    if (d === undefined && (v === 0 || v === false)) continue;
    const { label, unit } = fieldLabel(k);
    out.push(typeof v === 'boolean' ? label : `${label} ${v}${unit && unit !== '%' ? ` ${unit}` : unit ?? ''}`);
  }
  return out;
}

export const BREAKER_LEVEL: Record<BreakerState, Exclude<Level, 'none'>> = { closed: 'ok', half_open: 'warn', open: 'crit' };
export const BREAKER_LABEL: Record<BreakerState, string> = { closed: 'closed', half_open: 'half-open', open: 'OPEN' };

function ServiceCard({
  name,
  stats,
  health,
  now,
}: {
  name: string;
  stats: ServiceStats | undefined;
  health: ServiceHealth | undefined;
  now: number;
}) {
  const runtime = useOps((s) => s.runtime);
  const defs = useOps((s) => s.defs);
  const breakers = useOps((s) => s.summary?.breakers);
  const up = stats?.up ?? health?.up ?? null;
  const chaos = activeChaos(
    runtime?.chaos.services[name] as Record<string, KnobValue | undefined> | undefined,
    defs?.serviceChaosDefaults as unknown as Record<string, KnobValue> | undefined,
  );
  const started = toMillis(health?.startedAt ?? null);
  const myBreakers = (breakers ?? []).filter((b) => b.service === name && b.state !== 'closed');
  return (
    <article className={`svc${up === false ? ' is-down' : ''}${chaos.length ? ' has-chaos' : ''}`} aria-label={`Service ${name}`}>
      <header className="svc-head">
        <h3>{name}</h3>
        {up === null ? (
          <span className="pill pill-none">no data</span>
        ) : up ? (
          <StatusPill level="ok" label="UP" />
        ) : (
          <StatusPill level="crit" label="DOWN" />
        )}
      </header>
      {stats ? (
        <dl className="svc-metrics">
          <Metric label="RPS" value={formatNum(stats.rps)} />
          <Metric label="p99" value={formatMs(stats.p99Ms)} level={stats.rps > 0 ? serviceLevels.p99Ms(stats.p99Ms) : 'none'} />
          <Metric label="Errors" value={formatPct(stats.errorPct)} level={stats.rps > 0 ? serviceLevels.errorPct(stats.errorPct) : 'none'} />
          <Metric label="Loop lag" value={formatMs(stats.eventLoopLagMs)} level={serviceLevels.loopLagMs(stats.eventLoopLagMs)} />
          <Metric label="In-flight" value={formatInt(stats.inflight)} />
          <Metric label="Memory" value={`${formatInt(stats.memMb)} MB`} />
          <Metric label="CPU" value={formatPct(stats.cpuPct)} level={serviceLevels.cpuPct(stats.cpuPct)} />
        </dl>
      ) : (
        <p className="ops-empty">No metrics.</p>
      )}
      {stats?.dbPool && <PoolBar pool={stats.dbPool} />}
      <div className="svc-foot">
        {health && (
          <>
            <span className={health.restarts > 0 ? 'svc-restarts' : undefined}>
              ↻ {formatInt(health.restarts)} restart{health.restarts === 1 ? '' : 's'}
            </span>
            {started && <span>up {formatDuration((now - started) / 1000)}</span>}
            <span>health {formatMs(health.latencyMs)}</span>
          </>
        )}
      </div>
      {myBreakers.length > 0 && (
        <ul className="svc-breakers">
          {myBreakers.map((b) => (
            <li key={b.target}>
              → {b.target} <StatusPill level={BREAKER_LEVEL[b.state]} label={BREAKER_LABEL[b.state]} />
            </li>
          ))}
        </ul>
      )}
      {chaos.length > 0 && (
        <p className="svc-chaos" title={chaos.join(', ')}>
          <span aria-hidden="true">⚡</span> chaos: {chaos.join(', ')}
        </p>
      )}
    </article>
  );
}

export function ServiceGrid() {
  const summary = useOps((s) => s.summary);
  const services = useOps((s) => s.services);
  const defs = useOps((s) => s.defs);
  const now = useNow(5000);

  const statsByName = new Map((summary?.services ?? []).map((s) => [s.service, s]));
  const healthByName = new Map((services ?? []).map((s) => [s.service, s]));
  const names: string[] = [];
  for (const n of [...(defs?.services ?? []), ...statsByName.keys(), ...healthByName.keys()]) {
    if (!names.includes(n)) names.push(n);
  }
  const down = names.filter((n) => (statsByName.get(n)?.up ?? healthByName.get(n)?.up) === false).length;

  return (
    <Panel
      title="Service map"
      subtitle={names.length ? `${names.length} services · ${down ? `${down} down` : 'all up'}` : undefined}
      className="services-panel"
    >
      {names.length === 0 ? (
        <Empty>No service data yet.</Empty>
      ) : (
        <div className="svc-grid">
          {names.map((n) => (
            <ServiceCard key={n} name={n} stats={statsByName.get(n)} health={healthByName.get(n)} now={now} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function BreakersPanel() {
  const breakers = useOps((s) => s.summary?.breakers);
  const list = [...(breakers ?? [])].sort((a, b) => {
    const rank = { open: 0, half_open: 1, closed: 2 } as const;
    return rank[a.state] - rank[b.state] || a.service.localeCompare(b.service);
  });
  const open = list.filter((b) => b.state === 'open').length;
  return (
    <Panel title="Circuit breakers" subtitle={list.length ? `${open} open of ${list.length}` : undefined} className="breakers-panel">
      {list.length === 0 ? (
        <Empty>No breakers reported (platform.circuitBreaker may be off).</Empty>
      ) : (
        <ul className="breakers">
          {list.map((b) => (
            <li key={`${b.service}->${b.target}`} className={`breaker breaker-${b.state}`}>
              <span className="breaker-path">
                <code>{b.service}</code> <span aria-hidden="true">→</span>
                <span className="sr-only"> calling </span> <code>{b.target}</code>
              </span>
              <StatusPill level={BREAKER_LEVEL[b.state]} label={BREAKER_LABEL[b.state]} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
