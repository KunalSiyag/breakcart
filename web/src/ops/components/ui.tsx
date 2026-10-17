import { useId, type ReactNode } from 'react';
import { CHROME, SERIES } from '../palette';
import { LEVEL_META, type Level } from '../thresholds';

/** Status is never colour-alone: icon + label + colour. */
export function StatusPill({ level, label, title }: { level: Exclude<Level, 'none'>; label?: string; title?: string }) {
  const meta = LEVEL_META[level];
  return (
    <span className={`pill pill-${level}`} title={title}>
      <span className="pill-icon" aria-hidden="true">
        {meta.icon}
      </span>
      {label ?? meta.label}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  id,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const autoId = useId();
  const headingId = `${id ?? autoId}-title`;
  return (
    <section className={`panel${className ? ` ${className}` : ''}`} aria-labelledby={headingId} id={id}>
      <header className="panel-head">
        <div className="panel-titles">
          <h2 id={headingId}>{title}</h2>
          {subtitle && <span className="panel-sub">{subtitle}</span>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * Inline SVG sparkline: de-emphasis line, current value marked in the accent.
 * `null` values leave gaps.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  accent = SERIES[0],
  min,
  label,
}: {
  values: readonly (number | null)[];
  width?: number;
  height?: number;
  accent?: string;
  min?: number;
  label?: string;
}) {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) {
    return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  }
  const lo = min ?? Math.min(0, ...nums);
  const hi = Math.max(...nums, lo + 1e-9);
  const pad = 3;
  const x = (i: number) => (values.length <= 1 ? width : (i / (values.length - 1)) * (width - pad * 2) + pad);
  const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);
  const segments: string[] = [];
  let current = '';
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    current += `${current ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (current) segments.push(current);
  let lastIdx = values.length - 1;
  while (lastIdx >= 0 && (values[lastIdx] == null || !Number.isFinite(values[lastIdx] as number))) lastIdx--;
  const last = lastIdx >= 0 ? (values[lastIdx] as number) : null;
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      preserveAspectRatio="none"
    >
      {segments.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={CHROME.quiet}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {last != null && (
        <circle cx={x(lastIdx)} cy={y(last)} r={2.75} fill={accent} stroke={CHROME.surface} strokeWidth={1.5} />
      )}
    </svg>
  );
}

/** Tiny bar sparkline (route table): de-emphasis bars, latest bar in the accent. */
export function SparkBars({
  values,
  width = 96,
  height = 22,
  accent = SERIES[0],
  label,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  accent?: string;
  label?: string;
}) {
  if (!values.length) return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  const n = Math.max(values.length, 12);
  const gap = 1;
  const bw = Math.max(1, (width - gap * (n - 1)) / n);
  const hi = Math.max(...values, 1e-9);
  const offset = n - values.length;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = Math.max(1, (v / hi) * (height - 2));
        const x = (i + offset) * (bw + gap);
        return (
          <rect
            key={i}
            x={x}
            y={height - h}
            width={bw}
            height={h}
            rx={Math.min(1.5, bw / 2)}
            fill={i === values.length - 1 ? accent : CHROME.quiet}
          />
        );
      })}
    </svg>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <label className="toggle" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={description ? `${id}-desc` : undefined}
        />
        <span className="toggle-track" aria-hidden="true">
          <span className="toggle-thumb" />
        </span>
        <span className="toggle-label">{label}</span>
      </label>
      {description && (
        <p id={`${id}-desc`} className="field-help">
          {description}
        </p>
      )}
    </div>
  );
}

export function Spinner({ small = false }: { small?: boolean }) {
  return <span className={`spinner${small ? ' spinner-sm' : ''}`} aria-hidden="true" />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="ops-empty">{children}</p>;
}
