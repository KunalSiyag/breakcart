import { useMemo } from 'react';
import { formatTime } from '../../lib/format';
import { SERIES, STATUS } from '../palette';
import { useOps } from '../store';
import { KPIS, type KpiDef, type Level } from '../thresholds';
import { Panel, Sparkline, StatusPill } from './ui';

export const TREND_POINTS = 45; // ~90s at the 2s poll

function accentFor(level: Level): string {
  switch (level) {
    case 'crit':
      return STATUS.critical;
    case 'serious':
      return STATUS.serious;
    case 'warn':
      return STATUS.warning;
    default:
      return SERIES[0];
  }
}

/** One KPI tile. Shared with Mission Control's KPI strip, which mixes summary and loadgen values. */
export function KpiCard({
  label,
  hint,
  value,
  level = 'none',
  trend,
}: {
  label: string;
  hint?: string;
  /** Formatted value; null renders the "no data yet" tile. */
  value: string | null;
  level?: Level;
  /** Sparkline values; omit for the compact tile. */
  trend?: readonly (number | null)[];
}) {
  if (value == null) {
    return (
      <div className="kpi kpi-none">
        <div className="kpi-top">
          <span className="kpi-label">{label}</span>
        </div>
        <div className="kpi-value kpi-value-empty">—</div>
      </div>
    );
  }
  return (
    <div className={`kpi kpi-${level}`} title={hint}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        {level !== 'none' && level !== 'ok' && <StatusPill level={level} />}
        {level === 'ok' && (
          <span className="kpi-dot" aria-label="Within normal range" title="Within normal range">
            ●
          </span>
        )}
      </div>
      <div className="kpi-value">{value}</div>
      {trend && <Sparkline values={trend} width={140} height={24} accent={accentFor(level)} label={`${label} trend`} />}
    </div>
  );
}

function KpiTile({ def, compact }: { def: KpiDef; compact: boolean }) {
  const summary = useOps((s) => s.summary);
  const runtime = useOps((s) => s.runtime);
  const history = useOps((s) => s.history);
  const trend = useMemo(
    () => history.slice(-TREND_POINTS).map((p) => def.get(p.summary)),
    [history, def],
  );
  if (!summary) return <KpiCard label={def.label} value={null} />;
  const v = def.get(summary);
  const level: Level = def.level ? def.level(v, summary, runtime) : 'none';
  return <KpiCard label={def.label} hint={def.hint} value={def.format(v)} level={level} trend={compact ? undefined : trend} />;
}

export function KpiGrid({ ids, compact = false, title = 'Vital signs' }: { ids?: string[]; compact?: boolean; title?: string }) {
  const summaryAt = useOps((s) => s.summaryAt);
  const defs = ids ? KPIS.filter((k) => ids.includes(k.id)) : KPIS;
  return (
    <Panel
      title={title}
      subtitle={summaryAt ? `GET /control/summary · every 2s · ${formatTime(summaryAt)}` : 'waiting for first sample…'}
      className="kpi-panel"
    >
      <div className={`kpi-grid${compact ? ' kpi-grid-compact' : ''}`}>
        {defs.map((d) => (
          <KpiTile key={d.id} def={d} compact={compact} />
        ))}
      </div>
    </Panel>
  );
}
