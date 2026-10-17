import { useState } from 'react';
import { formatInt, formatMs, formatNum, formatPct } from '../../lib/format';
import { SERIES, STATUS } from '../palette';
import { useOps } from '../store';
import { above } from '../thresholds';
import { Empty, Panel, SparkBars } from './ui';

function LevelMark({ level }: { level: ReturnType<typeof above> }) {
  if (level === 'ok' || level === 'none') return null;
  const icon = level === 'crit' ? '■' : level === 'serious' ? '◆' : '▲';
  return (
    <span className={`lvl-mark lvl-${level}`} aria-label={level === 'crit' ? 'critical' : level === 'serious' ? 'high' : 'warning'}>
      {icon}
    </span>
  );
}

type RouteSort = 'p99' | 'rps' | 'err';

export function RouteTable() {
  const summary = useOps((s) => s.summary);
  const routeHistory = useOps((s) => s.routeHistory);
  const [sort, setSort] = useState<RouteSort>('p99');
  const routes = [...(summary?.routes ?? [])].sort((a, b) =>
    sort === 'rps' ? b.rps - a.rps : sort === 'err' ? b.errorPct - a.errorPct : b.p99Ms - a.p99Ms,
  );
  const sortBtn = (id: RouteSort, label: string) => (
    <button type="button" className="chip-btn" aria-pressed={sort === id} onClick={() => setSort(id)}>
      {label}
    </button>
  );
  return (
    <Panel
      title="Routes"
      subtitle="gateway, per route · trend = p99 over the last minute"
      actions={
        <div className="chip-group" role="group" aria-label="Sort routes by">
          {sortBtn('p99', 'p99')}
          {sortBtn('rps', 'RPS')}
          {sortBtn('err', 'Errors')}
        </div>
      }
      className="route-panel"
    >
      {routes.length === 0 ? (
        <Empty>No route metrics yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">Route</th>
                <th scope="col" className="num">
                  RPS
                </th>
                <th scope="col" className="num">
                  p95
                </th>
                <th scope="col" className="num">
                  p99
                </th>
                <th scope="col" className="num">
                  Errors
                </th>
                <th scope="col">p99 trend</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => {
                const p99Level = r.rps > 0 ? above(r.p99Ms, 1000, 5000, 2500) : 'none';
                const errLevel = r.rps > 0 ? above(r.errorPct, 1, 10, 5) : 'none';
                const hist = routeHistory[r.route] ?? [];
                return (
                  <tr key={r.route}>
                    <th scope="row" className="route-name">
                      <code>{r.route}</code>
                    </th>
                    <td className="num">{formatNum(r.rps)}</td>
                    <td className="num">{formatMs(r.p95Ms)}</td>
                    <td className="num">
                      <LevelMark level={p99Level} /> {formatMs(r.p99Ms)}
                    </td>
                    <td className="num">
                      <LevelMark level={errLevel} /> {formatPct(r.errorPct)}
                    </td>
                    <td>
                      <SparkBars
                        values={hist}
                        accent={p99Level === 'crit' ? STATUS.critical : p99Level === 'serious' || p99Level === 'warn' ? STATUS.warning : SERIES[0]}
                        label={`p99 of ${r.route} over the last minute, max ${formatMs(Math.max(0, ...hist))}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function topCodes(codes: Record<string, number>): [string, number][] {
  return Object.entries(codes)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
}

function isErrorCode(code: string): boolean {
  const n = Number(code);
  if (Number.isFinite(n)) return n === 0 || n >= 400;
  return !/^(OK|2\d\d|PAYMENT_PENDING)$/i.test(code);
}

export function FunnelTable() {
  const loadgen = useOps((s) => s.loadgen);
  const stepOrder = useOps((s) => s.stepOrder);
  const steps = [...(loadgen?.steps ?? [])].sort((a, b) => {
    const ia = stepOrder.indexOf(a.step);
    const ib = stepOrder.indexOf(b.step);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const anomalies = Object.entries(loadgen?.anomalies ?? {}).filter(([, n]) => n > 0);
  return (
    <Panel
      title="Funnel steps"
      subtitle={loadgen?.running ? 'what the simulated shoppers experienced, by step' : 'load generator idle'}
      className="funnel-panel"
    >
      {steps.length === 0 ? (
        <Empty>No step data yet — start a scenario.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="ops-table">
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col" className="num">
                  RPS
                </th>
                <th scope="col" className="num">
                  p50
                </th>
                <th scope="col" className="num">
                  p95
                </th>
                <th scope="col" className="num">
                  p99
                </th>
                <th scope="col" className="num">
                  Errors
                </th>
                <th scope="col">Responses</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => {
                const idx = stepOrder.indexOf(s.step);
                const color = idx >= 0 && idx < SERIES.length ? SERIES[idx] : undefined;
                const errLevel = s.rps > 0 ? above(s.errorPct, 1, 10, 5) : 'none';
                return (
                  <tr key={s.step}>
                    <th scope="row">
                      {color && <span className="key-line" style={{ borderColor: color }} aria-hidden="true" />} {s.step}
                    </th>
                    <td className="num">{formatNum(s.rps)}</td>
                    <td className="num">{formatMs(s.p50Ms)}</td>
                    <td className="num">{formatMs(s.p95Ms)}</td>
                    <td className="num">{formatMs(s.p99Ms)}</td>
                    <td className="num">
                      <LevelMark level={errLevel} /> {formatPct(s.errorPct)}
                    </td>
                    <td>
                      <span className="codes">
                        {topCodes(s.codes).map(([code, n]) => (
                          <span key={code} className={`code-chip${isErrorCode(code) ? ' is-error' : ''}`}>
                            {code} <b>{formatInt(n)}</b>
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {loadgen && (
        <dl className="totals totals-small">
          <div>
            <dt>Sessions started</dt>
            <dd>{formatInt(loadgen.sessions.started)}</dd>
          </div>
          <div>
            <dt>Converted</dt>
            <dd>{formatInt(loadgen.sessions.converted)}</dd>
          </div>
          <div>
            <dt>Abandoned</dt>
            <dd>{formatInt(loadgen.sessions.abandoned)}</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd>{formatInt(loadgen.sessions.failed)}</dd>
          </div>
          <div>
            <dt>Sold out</dt>
            <dd>{formatInt(loadgen.sessions.soldOut)}</dd>
          </div>
          <div>
            <dt>Bots blocked</dt>
            <dd>{formatInt(loadgen.sessions.blocked)}</dd>
          </div>
        </dl>
      )}
      {anomalies.length > 0 && (
        <div className="anomalies" role="status">
          <strong>
            <span aria-hidden="true">■</span> Anomalies seen by shoppers:
          </strong>{' '}
          {anomalies.map(([k, n]) => (
            <span key={k} className="code-chip is-error">
              {k.replace(/_/g, ' ')} <b>{formatInt(n)}</b>
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}
