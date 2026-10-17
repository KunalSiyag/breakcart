import { useId, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { KnobValue, RouteStats } from '../../api/types';
import { formatDuration, formatInt, formatMs, formatNum, formatPct, toMillis } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useOps } from '../store';
import { above, serviceLevels, type Level } from '../thresholds';
import { isServiceNode, NODE_BY_ID, storeTimedP99, storeTotals, type EdgeView, type NodeId, type TopologyView } from '../topology';
import { activeChaos, BREAKER_LABEL, BREAKER_LEVEL, PoolBar } from './ServiceGrid';
import { StatusPill } from './ui';

/** Side panel for one map node: every metric we have for it, plus its inbound / outbound edges. */

function Kv({ label, value, level = 'none' }: { label: string; value: ReactNode; level?: Level }) {
  const icon = level === 'crit' ? '■ ' : level === 'warn' || level === 'serious' ? '▲ ' : '';
  return (
    <div className={`lvl-${level}`}>
      <dt>{label}</dt>
      <dd>
        {icon && <span aria-hidden="true">{icon}</span>}
        {value}
      </dd>
    </div>
  );
}

const EDGE_STATE: Record<EdgeView['level'], { label: string; icon: string }> = {
  nodata: { label: 'not reported', icon: '·' },
  idle: { label: 'no traffic', icon: '○' },
  ok: { label: 'healthy', icon: '●' },
  warn: { label: 'degraded', icon: '▲' },
  crit: { label: 'failing', icon: '■' },
};

function EdgeTable({
  title,
  edges,
  peer,
  onSelect,
}: {
  title: string;
  edges: EdgeView[];
  peer: 'from' | 'to';
  onSelect: (id: NodeId) => void;
}) {
  if (!edges.length) return null;
  // The map's fixed order: sorting by the live rate swapped rows under the pointer every sample.
  const rows = edges;
  return (
    <div className="mc-details-section">
      <h4>{title}</h4>
      <div className="table-scroll">
        <table className="ops-table mc-details-table">
          <thead>
            <tr>
              <th scope="col">{peer === 'from' ? 'From' : 'To'}</th>
              <th scope="col" className="num">
                Rate
              </th>
              <th scope="col" className="num">
                p99
              </th>
              <th scope="col" className="num">
                <abbr title="Errors">Err</abbr>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const other = e[peer];
              const st = EDGE_STATE[e.breaker ? 'crit' : e.level];
              return (
                <tr key={e.key} className={`mc-edge-row is-${e.breaker ? 'crit' : e.level}`}>
                  <th scope="row">
                    <span className="mc-edge-state" title={st.label} aria-hidden="true">
                      {st.icon}
                    </span>{' '}
                    <button type="button" className="link-btn" onClick={() => onSelect(other)}>
                      {NODE_BY_ID[other].label}
                    </button>
                    <span className="sr-only"> ({st.label})</span>
                    {e.kind !== 'http' && <span className="muted small"> · {e.kind}</span>}
                    {e.breaker && (
                      <div>
                        <StatusPill level={BREAKER_LEVEL[e.breaker]} label={`breaker ${BREAKER_LABEL[e.breaker]}`} />
                      </div>
                    )}
                  </th>
                  <td className="num">{e.rps == null ? '—' : `${formatNum(e.rps)}/s`}</td>
                  <td className="num">{e.p99Ms == null ? '—' : formatMs(e.p99Ms)}</td>
                  <td className="num">{e.errorPct == null ? '—' : formatPct(e.errorPct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoutesTable({ routes }: { routes: RouteStats[] }) {
  // By name, not by rate (the summary sorts by rps): rows stay put between samples.
  const rows = [...routes].sort((a, b) => a.route.localeCompare(b.route));
  return (
    <div className="mc-details-section">
      <h4>Routes</h4>
      {rows.length === 0 ? (
        <p className="muted small">No route metrics yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="ops-table mc-details-table">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col" className="num">
                  RPS
                </th>
                <th scope="col" className="num">
                  p99
                </th>
                <th scope="col" className="num">
                  Errors
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const err = r.rps > 0 ? above(r.errorPct, 1, 10, 5) : 'none';
                const p99 = r.rps > 0 ? above(r.p99Ms, 1000, 5000, 2500) : 'none';
                return (
                  <tr key={r.route}>
                    <th scope="row" className="route-name">
                      <code>{r.route}</code>
                    </th>
                    <td className="num">{formatNum(r.rps)}</td>
                    <td className={`num lvl-${p99}`}>{formatMs(r.p99Ms)}</td>
                    <td className={`num lvl-${err}`}>{formatPct(r.errorPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChangedKnobs({ title, values, defaults }: { title: string; values: object | undefined; defaults: object | undefined }) {
  const list = activeChaos(values as Record<string, KnobValue | undefined> | undefined, defaults as Record<string, KnobValue> | undefined);
  if (!list.length) return null;
  return (
    <div className="mc-details-section">
      <h4>{title}</h4>
      <ul className="mc-chaos-list">
        {list.map((c) => (
          <li key={c}>
            <span aria-hidden="true">⚡</span> {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ServiceDetails({ id }: { id: NodeId }) {
  const stats = useOps((s) => s.summary?.services.find((x) => x.service === id));
  const health = useOps((s) => s.services?.find((x) => x.service === id));
  const breakers = useOps((s) => s.summary?.breakers);
  const runtime = useOps((s) => s.runtime);
  const defs = useOps((s) => s.defs);
  const now = useNow(5000);
  const up = stats?.up ?? health?.up ?? null;
  const started = toMillis(health?.startedAt ?? null);
  const instances = stats?.instances ?? health?.instances;
  const mine = (breakers ?? []).filter((b) => b.service === id && b.state !== 'closed');
  const active = (stats?.rps ?? 0) > 0;
  return (
    <>
      <div className="mc-details-status">
        {up == null ? (
          <span className="pill pill-none">no data</span>
        ) : up ? (
          <StatusPill level="ok" label="UP" />
        ) : (
          <StatusPill level="crit" label="DOWN" />
        )}
        {instances != null && <span className="chip">{plural(instances, 'instance')}</span>}
      </div>
      {stats ? (
        <dl className="mc-kv">
          <Kv label="Requests / s" value={formatNum(stats.rps)} />
          <Kv label="p99 latency" value={formatMs(stats.p99Ms)} level={active ? serviceLevels.p99Ms(stats.p99Ms) : 'none'} />
          <Kv label="Errors (5xx)" value={formatPct(stats.errorPct)} level={active ? serviceLevels.errorPct(stats.errorPct) : 'none'} />
          <Kv label="CPU" value={formatPct(stats.cpuPct)} level={serviceLevels.cpuPct(stats.cpuPct)} />
          <Kv label="Event-loop lag (p99)" value={formatMs(stats.eventLoopLagMs)} level={serviceLevels.loopLagMs(stats.eventLoopLagMs)} />
          <Kv label="In-flight requests" value={formatInt(stats.inflight)} />
          <Kv label="Memory (RSS)" value={`${formatInt(stats.memMb)} MB`} />
          {health && <Kv label="Restarts" value={formatInt(health.restarts)} level={health.restarts > 0 ? 'warn' : 'none'} />}
          {started != null && <Kv label="Up for" value={formatDuration((now - started) / 1000)} />}
          {health && <Kv label="Health check" value={formatMs(health.latencyMs)} />}
        </dl>
      ) : (
        <p className="muted small">No metrics for this service in the last summary.</p>
      )}
      {stats?.dbPool && <PoolBar pool={stats.dbPool} />}
      {mine.length > 0 && (
        <div className="mc-details-section">
          <h4>Circuit breakers</h4>
          <ul className="mc-chaos-list">
            {mine.map((b) => (
              <li key={b.target}>
                → {b.target} <StatusPill level={BREAKER_LEVEL[b.state]} label={BREAKER_LABEL[b.state]} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <ChangedKnobs title="Chaos on this service" values={runtime?.chaos.services[id]} defaults={defs?.serviceChaosDefaults} />
      {id === 'payments' && (
        <ChangedKnobs title="Payment provider (PSP) chaos" values={runtime?.chaos.payments} defaults={defs?.paymentsChaosDefaults} />
      )}
    </>
  );
}

const plural = (n: number, one: string) => `${formatInt(n)} ${one}${n === 1 ? '' : 's'}`;

function StoreDetails({ id }: { id: 'redis' | 'postgres' }) {
  const summary = useOps((s) => s.summary);
  const t = storeTotals(summary, id);
  const timedP99 = t ? storeTimedP99(t) : null;
  const pools = (summary?.services ?? []).filter((s) => s.dbPool && s.service !== 'control-plane');
  return (
    <>
      {t ? (
        <dl className="mc-kv">
          <Kv label={id === 'redis' ? 'Commands / s' : 'Queries / s'} value={formatNum(t.opsPerSec)} />
          <Kv label="Worst p99 (any client)" value={formatMs(t.p99Ms)} level={timedP99 == null ? 'none' : above(timedP99, 500, 2000)} />
          <Kv label="Errors" value={formatPct(t.errorPct)} level={t.opsPerSec > 0 ? above(t.errorPct, 1, 5) : 'none'} />
          <Kv label="Clients" value={formatInt(t.users.length)} />
        </dl>
      ) : (
        <p className="muted small">Per-store metrics need a newer control plane (summary.stores).</p>
      )}
      {id === 'postgres' && pools.length > 0 && (
        <div className="mc-details-section">
          <h4>Connection pools</h4>
          {pools.map((s) => (
            <div key={s.service} className="mc-pool-row">
              <span className="mc-pool-name">{s.service}</span>
              <PoolBar pool={s.dbPool!} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function StreamDetails() {
  const summary = useOps((s) => s.summary);
  const runtime = useOps((s) => s.runtime);
  const defs = useOps((s) => s.defs);
  const st = summary?.stream;
  return (
    <>
      {st ? (
        <dl className="mc-kv">
          <Kv label="Published / s" value={formatNum(st.producedPerSec)} />
          <Kv label="Processed / s" value={formatNum(st.consumedPerSec)} />
          <Kv label="Consumer lag" value={formatInt(st.lag)} level={above(st.lag, 100, 2000, 500)} />
          <Kv label="Dead-letter queue" value={formatInt(st.dlq)} level={st.dlq > 0 ? 'crit' : 'none'} />
          <Kv label="Outbox backlog" value={formatInt(summary?.business.outboxBacklog)} level={above(summary?.business.outboxBacklog ?? 0, 50, 1000, 250)} />
        </dl>
      ) : (
        <p className="muted small">Stream rates need a newer control plane (summary.stream).</p>
      )}
      {runtime && (
        <dl className="mc-kv">
          <Kv label="orders.eventPublishing" value={<code>{runtime.flags['orders.eventPublishing'] ?? '—'}</code>} />
          <Kv label="workers.poisonMessages" value={<code>{runtime.flags['workers.poisonMessages'] ?? '—'}</code>} />
        </dl>
      )}
      <ChangedKnobs title="Data-path chaos" values={runtime?.chaos.data} defaults={defs?.dataChaosDefaults} />
    </>
  );
}

function CustomerDetails() {
  const loadgen = useOps((s) => s.loadgen);
  const scenarios = useOps((s) => s.scenarios);
  if (!loadgen) return <p className="muted small">No load-generator data yet.</p>;
  const scenario = scenarios?.find((s) => s.id === loadgen.scenarioId);
  const s = loadgen.sessions;
  return (
    <>
      <p className="small">
        {loadgen.running ? (
          <>
            Running <b>{loadgen.scenarioName ?? loadgen.scenarioId}</b>
            {loadgen.phase ? ` · phase ${loadgen.phase}` : ''} · ×{formatNum(loadgen.multiplier)}
          </>
        ) : (
          'No scenario running — numbers are from the last run.'
        )}
      </p>
      <dl className="mc-kv">
        <Kv label="Shoppers in the store" value={formatInt(loadgen.activeSessions)} />
        <Kv label="Arrivals / s (target)" value={`${formatNum(loadgen.actualArrivalPerSec)} (${formatNum(loadgen.targetArrivalPerSec)})`} />
        <Kv label="Dropped arrivals" value={formatInt(loadgen.droppedArrivals)} level={loadgen.droppedArrivals > 0 ? 'warn' : 'none'} />
        {scenario && <Kv label="Bot share" value={formatPct(scenario.botShare * 100)} />}
        {/* Idle, the SSE replay still carries the last run's final rate. */}
        <Kv label="Requests / s" value={loadgen.running ? formatNum(loadgen.rps) : '—'} />
        <Kv label="Sessions started" value={formatInt(s.started)} />
        <Kv label="Converted" value={formatInt(s.converted)} />
        <Kv label="Abandoned" value={formatInt(s.abandoned)} />
        <Kv label="Failed" value={formatInt(s.failed)} level={s.failed > 0 ? 'warn' : 'none'} />
        <Kv label="Sold out" value={formatInt(s.soldOut)} />
        <Kv label="Blocked (bots)" value={formatInt(s.blocked)} />
      </dl>
    </>
  );
}

export function NodeDetails({
  id,
  topo,
  onClose,
  onSelect,
  headingRef,
  side,
}: {
  id: NodeId;
  topo: TopologyView;
  onClose: () => void;
  onSelect: (id: NodeId) => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
  side: 'left' | 'right';
}) {
  const routes = useOps((s) => s.summary?.routes);
  const node = NODE_BY_ID[id];
  const hid = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  const inbound = topo.edges.filter((e) => e.to === id);
  const outbound = topo.edges.filter((e) => e.from === id);
  const pick = (other: NodeId) => {
    if (other !== id) onSelect(other);
  };
  // tabIndex -1: a click on panel text keeps focus in the panel, so Escape still closes it.
  return (
    <section
      className={`mc-details${side === 'left' ? ' is-left' : ''}`}
      aria-labelledby={hid}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="mc-details-head">
        <div className="mc-details-titles">
          <h3 id={hid} ref={headingRef} tabIndex={-1}>
            {node.label}
          </h3>
          <p className="mc-details-role">{node.role}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={`Close ${node.label} details`}>
          ✕
        </button>
      </header>
      <div className="mc-details-body">
        {isServiceNode(id) && <ServiceDetails id={id} />}
        {id === 'customers' && <CustomerDetails />}
        {id === 'stream' && <StreamDetails />}
        {(id === 'redis' || id === 'postgres') && <StoreDetails id={id} />}
        <EdgeTable title="Inbound" edges={inbound} peer="from" onSelect={pick} />
        <EdgeTable title="Outbound" edges={outbound} peer="to" onSelect={pick} />
        {id === 'gateway' && <RoutesTable routes={routes ?? []} />}
      </div>
    </section>
  );
}
