import { useMemo } from 'react';
import { formatMs, formatNum, formatPct } from '../../lib/format';
import { CHROME, PERCENTILE, seriesColor, SERIES, STATUS } from '../palette';
import { useOps } from '../store';
import { ChartCard, Legend, TimeChart, withGaps, type Row, type SeriesDef } from './charts';

const GATEWAY_KEYS = ['rps', 'errorPct', 'p50', 'p95', 'p99'];

/** Gateway samples: Prometheus backfill (older) + live 2s polling. */
function useGatewayRows(): Row[] {
  const backfill = useOps((s) => s.backfill);
  const history = useOps((s) => s.history);
  return useMemo(() => {
    const rows: Row[] = [
      ...backfill.map((p) => ({ t: p.t, rps: p.rps, errorPct: p.errorPct, p50: p.p50, p95: p.p95, p99: p.p99 })),
      ...history.map((h) => ({
        t: h.t,
        rps: h.summary.gateway.rps,
        errorPct: h.summary.gateway.errorPct,
        p50: h.summary.gateway.p50Ms,
        p95: h.summary.gateway.p95Ms,
        p99: h.summary.gateway.p99Ms,
      })),
    ];
    return withGaps(rows, GATEWAY_KEYS, 8000);
  }, [backfill, history]);
}

const RPS_SERIES: SeriesDef[] = [{ key: 'rps', label: 'Requests / s', color: SERIES[0], area: true }];
const ERR_SERIES: SeriesDef[] = [{ key: 'errorPct', label: 'Error rate', color: STATUS.critical, area: true }];
const LATENCY_SERIES: SeriesDef[] = [
  { key: 'p99', label: 'p99', color: PERCENTILE.p99 },
  { key: 'p95', label: 'p95', color: PERCENTILE.p95 },
  { key: 'p50', label: 'p50', color: PERCENTILE.p50 },
];

export function GatewayTrafficCard({ now }: { now: number }) {
  const rows = useGatewayRows();
  const backfilled = useOps((s) => s.backfill.length > 0);
  return (
    <ChartCard
      title="Gateway traffic"
      subtitle={`last 10 min${backfilled ? ' · history backfilled from Prometheus' : ''}`}
      table={[
        { rows, series: RPS_SERIES, format: formatNum },
        { rows, series: ERR_SERIES, format: formatPct },
      ]}
    >
      <div className="mini-chart-title">
        <span>Requests / s</span>
        <strong>{formatNum(lastOf(rows, 'rps'))}</strong>
      </div>
      <TimeChart rows={rows} series={RPS_SERIES} now={now} height={130} yFormat={formatNum} valueFormat={formatNum} />
      <div className="mini-chart-title">
        <span>
          <span className="crit-mark" aria-hidden="true">
            ■
          </span>{' '}
          Error rate
        </span>
        <strong>{formatPct(lastOf(rows, 'errorPct'))}</strong>
      </div>
      <TimeChart rows={rows} series={ERR_SERIES} now={now} height={110} yFormat={formatPct} valueFormat={formatPct} />
    </ChartCard>
  );
}

function lastOf(rows: Row[], key: string): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]![key];
    if (v != null) return v;
  }
  return null;
}

export function LatencyCard({ now, height = 200 }: { now: number; height?: number }) {
  const rows = useGatewayRows();
  return (
    <ChartCard title="Gateway latency" subtitle="p50 · p95 · p99" table={[{ rows, series: LATENCY_SERIES, format: formatMs }]}>
      <Legend series={LATENCY_SERIES} rows={rows} format={formatMs} />
      <TimeChart rows={rows} series={LATENCY_SERIES} now={now} height={height} yFormat={formatMs} valueFormat={formatMs} />
    </ChartCard>
  );
}

export function FunnelLatencyCard({ now }: { now: number }) {
  const loadHistory = useOps((s) => s.loadHistory);
  const stepOrder = useOps((s) => s.stepOrder);
  // Colours follow the step (first-seen order), never its rank, so they stay stable.
  const shownKey = stepOrder.slice(0, SERIES.length).join('\u0000');
  const shown = useMemo(() => (shownKey ? shownKey.split('\u0000') : []), [shownKey]);
  const series = useMemo<SeriesDef[]>(
    () => shown.map((step, i) => ({ key: step, label: step, color: seriesColor(i) ?? CHROME.quiet })),
    [shown],
  );
  const rows = useMemo(() => {
    const r: Row[] = loadHistory.map((p) => {
      const row: Row = { t: p.t };
      for (const s of shown) row[s] = p.running ? (p.steps[s] ?? null) : null;
      return row;
    });
    return withGaps(r, shown, 5000);
  }, [loadHistory, shown]);
  return (
    <ChartCard
      title="What customers feel"
      subtitle={`p95 latency by funnel step (load generator)${stepOrder.length > shown.length ? ` · ${stepOrder.length - shown.length} more in the table` : ''}`}
      table={[{ rows, series, format: formatMs }]}
    >
      <Legend series={series} rows={rows} format={formatMs} />
      <TimeChart
        rows={rows}
        series={series}
        now={now}
        height={200}
        yFormat={formatMs}
        valueFormat={formatMs}
        empty="No load running — start a scenario to see customer latency"
      />
    </ChartCard>
  );
}

const SESSION_SERIES: SeriesDef[] = [
  { key: 'converted', label: 'Converted', color: STATUS.good, icon: '✓' },
  { key: 'abandoned', label: 'Abandoned', color: STATUS.warning, icon: '↩' },
  { key: 'failed', label: 'Failed', color: STATUS.critical, icon: '✕' },
];

const ARRIVAL_SERIES: SeriesDef[] = [
  { key: 'actual', label: 'Actual', color: SERIES[0] },
  { key: 'target', label: 'Target', color: CHROME.muted, dashed: true },
];

const perSec = (v: number) => `${formatNum(v)}/s`;

/** Load generator: arrivals (target vs actual) and how shopper sessions end. */
export function LoadgenCard({ now }: { now: number }) {
  const loadHistory = useOps((s) => s.loadHistory);
  const arrivals = useMemo(
    () =>
      withGaps(
        loadHistory.map((p) => ({ t: p.t, target: p.target, actual: p.actual })),
        ['target', 'actual'],
        5000,
      ),
    [loadHistory],
  );
  const sessions = useMemo(
    () =>
      withGaps(
        loadHistory.map((p) => ({
          t: p.t,
          converted: p.rates?.converted ?? null,
          abandoned: p.rates?.abandoned ?? null,
          failed: p.rates?.failed ?? null,
        })),
        ['converted', 'abandoned', 'failed'],
        5000,
      ),
    [loadHistory],
  );
  return (
    <ChartCard
      title="Load generator"
      subtitle="shopper arrivals and how sessions end"
      table={[
        { rows: arrivals, series: ARRIVAL_SERIES, format: perSec },
        { rows: sessions, series: SESSION_SERIES, format: perSec },
      ]}
    >
      <div className="mini-chart-title">
        <span>New shoppers / s — actual below target means the generator (or the system) can’t keep up</span>
      </div>
      <Legend series={ARRIVAL_SERIES} rows={arrivals} format={perSec} />
      <TimeChart
        rows={arrivals}
        series={ARRIVAL_SERIES}
        now={now}
        height={120}
        yFormat={formatNum}
        valueFormat={perSec}
        empty="No load running — start a scenario"
      />
      <div className="mini-chart-title">
        <span>Sessions ending / s</span>
      </div>
      <Legend series={SESSION_SERIES} rows={sessions} format={perSec} />
      <TimeChart
        rows={sessions}
        series={SESSION_SERIES}
        now={now}
        height={120}
        yFormat={formatNum}
        valueFormat={perSec}
        empty="No load running"
      />
    </ChartCard>
  );
}
