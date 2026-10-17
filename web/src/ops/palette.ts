/**
 * Chart colours for the dark ops console (surface #1a1a19). Values come from the
 * data-viz reference palette and were run through its validator:
 *  - categorical (identity): 8 dark-mode slots, fixed order, never cycled —
 *    worst adjacent CVD ΔE 8.4, normal-vision ΔE 19.3, all ≥ 3:1 on the surface;
 *  - latency percentiles are ordinal (p50 < p95 < p99): one blue hue stepped
 *    dark → light, p99 brightest — monotone L, ΔL ≥ 0.06, darkest step 2.63:1;
 *  - status colours are reserved for meaning (good / warning / serious / critical)
 *    and always ship with an icon + label.
 * Keep in sync with the custom properties in styles/ops.css.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;

export const PERCENTILE = { p50: '#1c5cab', p95: '#5598e7', p99: '#9ec5f4' } as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export const CHROME = {
  surface: '#1a1a19',
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781',
  ink: '#f0efec',
  ink2: '#c3c2b7',
  /** De-emphasis hue for sparklines / reference lines. */
  quiet: '#6f6e69',
} as const;

/** Categorical slot for the n-th entity (first-seen order). Past 8 → null (fold into "other"). */
export function seriesColor(index: number): string | null {
  return index >= 0 && index < SERIES.length ? (SERIES[index] ?? null) : null;
}
