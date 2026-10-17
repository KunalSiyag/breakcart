import { useMemo, useState, type ReactNode } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import { formatTime } from '../../lib/format';
import { CHROME } from '../palette';
import { WINDOW_MS } from '../store';

/**
 * Live time-series primitives for the war room. Conventions (data-viz guide):
 * one y-axis per chart (never dual), 2px lines, ~10% area wash, hairline solid grid,
 * crosshair tooltip listing every series with the value first, a legend for ≥2 series,
 * and a table view behind every chart.
 */

export type Row = { t: number } & Record<string, number | null>;

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  area?: boolean;
  dashed?: boolean;
  icon?: string;
}

const hhmm = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

function timeTicks(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push(t);
  return out;
}

/** Break lines where samples are missing (backend down) instead of drawing across the gap. */
export function withGaps(rows: Row[], keys: string[], maxGapMs: number): Row[] {
  if (rows.length < 2) return rows;
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const prev = rows[i - 1];
    if (prev && r.t - prev.t > maxGapMs) {
      const gap: Row = { t: prev.t + 1 };
      for (const k of keys) gap[k] = null;
      out.push(gap);
    }
    out.push(r);
  }
  return out;
}

export function lastValue(rows: readonly Row[], key: string): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]![key];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

function ChartTooltip({
  props,
  series,
  format,
}: {
  props: TooltipContentProps<number, string>;
  series: SeriesDef[];
  format: (v: number) => string;
}) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-time">{formatTime(Number(label))}</div>
      {series.map((s) => {
        const v = row[s.key];
        return (
          <div key={s.key} className="chart-tip-row">
            <span
              className={`key-line${s.dashed ? ' key-dashed' : ''}`}
              style={{ borderColor: s.color }}
              aria-hidden="true"
            />
            <strong>{v == null ? '—' : format(v)}</strong>
            <span className="chart-tip-label">
              {s.icon ? `${s.icon} ` : ''}
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TimeChart({
  rows,
  series,
  now,
  height = 170,
  yFormat,
  valueFormat,
  yMax,
  empty = 'Waiting for data…',
}: {
  rows: Row[];
  series: SeriesDef[];
  now: number;
  height?: number;
  yFormat: (v: number) => string;
  valueFormat: (v: number) => string;
  yMax?: number;
  empty?: string;
}) {
  const start = now - WINDOW_MS;
  const ticks = useMemo(() => timeTicks(start, now, 2 * 60_000), [start, now]);
  const visible = useMemo(() => rows.filter((r) => r.t >= start - 5000), [rows, start]);
  const hasData = visible.some((r) => series.some((s) => r[s.key] != null));
  return (
    <div className="chart" style={{ height }}>
      <ComposedChart
        responsive
        style={{ width: '100%', height: '100%' }}
        data={visible}
        margin={{ top: 8, right: 10, bottom: 0, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke={CHROME.grid} strokeWidth={1} />
        <XAxis
          dataKey="t"
          type="number"
          scale="time"
          domain={[start, now]}
          ticks={ticks}
          tickFormatter={(t: number) => hhmm.format(t)}
          allowDataOverflow
          stroke={CHROME.axis}
          tick={{ fill: CHROME.muted, fontSize: 11 }}
          tickLine={false}
          height={22}
        />
        <YAxis
          width={54}
          tickFormatter={(v: number) => yFormat(v)}
          stroke={CHROME.axis}
          axisLine={false}
          tickLine={false}
          tick={{ fill: CHROME.muted, fontSize: 11 }}
          domain={[0, yMax ?? 'auto']}
          tickCount={4}
        />
        <Tooltip
          content={(p) => <ChartTooltip props={p as TooltipContentProps<number, string>} series={series} format={valueFormat} />}
          cursor={{ stroke: CHROME.ink2, strokeWidth: 1 }}
          isAnimationActive={false}
        />
        {series.map((s) =>
          s.area ? (
            <Area
              key={s.key}
              type="monotoneX"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              fill={s.color}
              fillOpacity={0.1}
              dot={false}
              activeDot={{ r: 4, stroke: CHROME.surface, strokeWidth: 2, fill: s.color }}
              isAnimationActive={false}
              connectNulls={false}
            />
          ) : (
            <Line
              key={s.key}
              type="monotoneX"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dashed ? '5 4' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, stroke: CHROME.surface, strokeWidth: 2, fill: s.color }}
              isAnimationActive={false}
              connectNulls={false}
            />
          ),
        )}
      </ComposedChart>
      {!hasData && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

/** Legend with the latest value of each series (values in ink, colour on the key only). */
export function Legend({
  series,
  rows,
  format,
}: {
  series: SeriesDef[];
  rows: readonly Row[];
  format: (v: number) => string;
}) {
  return (
    <ul className="legend">
      {series.map((s) => {
        const v = lastValue(rows, s.key);
        return (
          <li key={s.key}>
            {s.area ? (
              <span className="key-rect" style={{ background: s.color }} aria-hidden="true" />
            ) : (
              <span className={`key-line${s.dashed ? ' key-dashed' : ''}`} style={{ borderColor: s.color }} aria-hidden="true" />
            )}
            <span className="legend-label">
              {s.icon ? `${s.icon} ` : ''}
              {s.label}
            </span>
            <strong className="legend-value">{v == null ? '—' : format(v)}</strong>
          </li>
        );
      })}
    </ul>
  );
}

/** Chart container with a table-view twin (the accessible equivalent of the chart). */
export function ChartCard({
  title,
  subtitle,
  children,
  table,
  className,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  table: { rows: readonly Row[]; series: SeriesDef[]; format: (v: number) => string }[];
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`panel chart-card${className ? ` ${className}` : ''}`} aria-label={title}>
      <header className="panel-head">
        <div className="panel-titles">
          <h2>{title}</h2>
          {subtitle && <span className="panel-sub">{subtitle}</span>}
        </div>
        <div className="panel-actions">
          <button type="button" className="chip-btn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </header>
      {asTable ? <ChartTable groups={table} /> : children}
    </section>
  );
}

function ChartTable({ groups }: { groups: { rows: readonly Row[]; series: SeriesDef[]; format: (v: number) => string }[] }) {
  return (
    <div className="chart-table-wrap">
      {groups.map((g, gi) => {
        const recent = g.rows.filter((r) => g.series.some((s) => r[s.key] != null)).slice(-15).reverse();
        return (
          <table key={gi} className="ops-table chart-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                {g.series.map((s) => (
                  <th key={s.key} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={g.series.length + 1} className="muted">
                    No samples yet
                  </td>
                </tr>
              ) : (
                recent.map((r) => (
                  <tr key={r.t}>
                    <td>{formatTime(r.t)}</td>
                    {g.series.map((s) => {
                      const v = r[s.key];
                      return (
                        <td key={s.key} className="num">
                          {v == null ? '—' : g.format(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        );
      })}
    </div>
  );
}
