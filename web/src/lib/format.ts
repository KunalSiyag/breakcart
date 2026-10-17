/** Formatting helpers. Money is always rupees (cents / 100) formatted for en-IN. */

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const inrExact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const inrCompact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});
const intIN = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const compactUS = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const timeFmt = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** ₹1,29,999 — paise are shown only when present. */
export function formatINR(cents: number | null | undefined): string {
  if (!isNum(cents)) return '—';
  const rupees = cents / 100;
  return Number.isInteger(rupees) ? inrWhole.format(rupees) : inrExact.format(rupees);
}

/** ₹12,345 below one lakh, ₹1.2L / ₹3.4Cr above — for dense tiles. */
export function formatINRCompact(cents: number | null | undefined): string {
  if (!isNum(cents)) return '—';
  const rupees = cents / 100;
  if (Math.abs(rupees) >= 100_000) return inrCompact.format(rupees);
  return inrWhole.format(Math.round(rupees));
}

/** Whole-number count with Indian digit grouping: 1,23,456. */
export function formatInt(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  return intIN.format(Math.round(v));
}

/** Rates and gauges: 0.25 · 12.3 · 123 · 12.3K. */
export function formatNum(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 10_000) return compactUS.format(v);
  if (a >= 100) return intIN.format(Math.round(v));
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a === 0) return '0';
  if (a < 0.01) return v > 0 ? '<0.01' : '>-0.01';
  return v.toFixed(2).replace(/\.?0+$/, '');
}

export function formatPct(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  if (v === 0) return '0%';
  if (v >= 100) return '100%';
  if (Math.abs(v) < 0.1) return '<0.1%';
  return `${v.toFixed(1).replace(/\.0$/, '')}%`;
}

/** 0.4 ms · 12 ms · 1.25 s · 1m 05s */
export function formatMs(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  if (v < 0) return `${Math.round(v)} ms`;
  if (v === 0) return '0 ms';
  if (v < 1) return '<1 ms';
  if (v < 10) return `${v.toFixed(1).replace(/\.0$/, '')} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 10_000) return `${(v / 1000).toFixed(2)} s`;
  // Round to whole seconds before splitting, so 119.6 s is "2m 00s", not "1m 60s".
  if (v < 59_950) return `${(v / 1000).toFixed(1)} s`;
  const t = Math.round(v / 1000);
  return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
}

/** Countdown clock: 04:59 · 1:02:03 · 2d 03:04:05 */
export function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  if (d > 0) return `${d}d ${String(h).padStart(2, '0')}:${mm}:${ss}`;
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/** Human duration: 45s · 3m 05s · 1h 02m */
export function formatDuration(totalSec: number | null | undefined): string {
  if (!isNum(totalSec)) return '—';
  const sec = Math.max(0, Math.round(totalSec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

/** Accepts ISO strings, epoch seconds or epoch milliseconds. */
export function toMillis(ts: string | number | null | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return null;
    return ts < 100_000_000_000 ? ts * 1000 : ts;
  }
  if (/^\d+(\.\d+)?$/.test(ts)) return toMillis(Number(ts));
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

export function relativeTime(thenMs: number | null, nowMs: number): string {
  if (thenMs == null) return '—';
  const diff = Math.round((nowMs - thenMs) / 1000);
  if (diff < 3) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return dateTimeFmt.format(thenMs);
}

export function formatTime(ms: number | null | undefined): string {
  if (!isNum(ms)) return '—';
  return timeFmt.format(ms);
}

export function formatDateTime(value: string | number | null | undefined): string {
  const ms = toMillis(value ?? null);
  return ms == null ? '—' : dateTimeFmt.format(ms);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** latencyJitterMs → "Latency jitter" (+ unit "ms"). */
export function humanizeKey(key: string): { label: string; unit: string | null } {
  const units: [RegExp, string][] = [
    [/PerMin$/, '/min'],
    [/PerSec$/, '/s'],
    [/Pct$/, '%'],
    [/Ms$/, 'ms'],
    [/Sec$/, 's'],
    [/Mb$/, 'MB'],
  ];
  let base = key;
  let unit: string | null = null;
  for (const [re, u] of units) {
    if (re.test(base)) {
      base = base.replace(re, '');
      unit = u;
      break;
    }
  }
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  const label = words.length ? words[0]!.toUpperCase() + words.slice(1) : key;
  return { label: label.replace(/\bdb\b/gi, 'DB').replace(/\bp(\d\d)\b/gi, 'p$1').replace(/\bgc\b/gi, 'GC'), unit };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function discountPct(priceCents: number, mrpCents: number): number {
  if (!(mrpCents > 0) || priceCents >= mrpCents) return 0;
  return Math.round((1 - priceCents / mrpCents) * 100);
}
