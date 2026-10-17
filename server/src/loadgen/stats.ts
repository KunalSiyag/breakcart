/**
 * Tiny log-bucketed latency histogram (~5% relative precision from 0.5ms to ~2 minutes).
 * Good enough for live p50/p95/p99 without a dependency.
 */
const GROWTH = 1.05;
const LOG_G = Math.log(GROWTH);
const MIN_MS = 0.5;
const BUCKETS = Math.ceil(Math.log(120_000 / MIN_MS) / LOG_G) + 1;

export class Histogram {
  counts = new Uint32Array(BUCKETS);
  total = 0;

  record(ms: number) {
    const i = ms <= MIN_MS ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms / MIN_MS) / LOG_G));
    this.counts[i]++;
    this.total++;
  }

  merge(other: Histogram) {
    for (let i = 0; i < BUCKETS; i++) this.counts[i] += other.counts[i];
    this.total += other.total;
  }

  percentile(p: number): number {
    if (this.total === 0) return 0;
    const target = Math.ceil((p / 100) * this.total);
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= target) return MIN_MS * Math.pow(GROWTH, i);
    }
    return MIN_MS * Math.pow(GROWTH, BUCKETS - 1);
  }
}

export interface StepWindow {
  hist: Histogram;
  count: number;
  errors: number;
  codes: Record<string, number>;
}

const newWindow = (): StepWindow => ({ hist: new Histogram(), count: 0, errors: 0, codes: {} });

/**
 * Per-step stats in 1-second slots; reads aggregate the last `windowSec` complete seconds.
 */
export class StepStats {
  private slots = new Map<number, Map<string, StepWindow>>();

  record(step: string, ms: number, code: string, isError: boolean) {
    const sec = Math.floor(Date.now() / 1000);
    let slot = this.slots.get(sec);
    if (!slot) {
      slot = new Map();
      this.slots.set(sec, slot);
      for (const k of this.slots.keys()) if (k < sec - 30) this.slots.delete(k);
    }
    let w = slot.get(step);
    if (!w) {
      w = newWindow();
      slot.set(step, w);
    }
    w.hist.record(ms);
    w.count++;
    if (isError) w.errors++;
    w.codes[code] = (w.codes[code] ?? 0) + 1;
  }

  snapshot(windowSec = 5) {
    const now = Math.floor(Date.now() / 1000);
    const agg = new Map<string, StepWindow>();
    for (let s = now - windowSec; s < now; s++) {
      const slot = this.slots.get(s);
      if (!slot) continue;
      for (const [step, w] of slot) {
        let a = agg.get(step);
        if (!a) {
          a = newWindow();
          agg.set(step, a);
        }
        a.hist.merge(w.hist);
        a.count += w.count;
        a.errors += w.errors;
        for (const [c, n] of Object.entries(w.codes)) a.codes[c] = (a.codes[c] ?? 0) + n;
      }
    }
    return [...agg.entries()].map(([step, w]) => ({
      step,
      rps: w.count / windowSec,
      p50Ms: Math.round(w.hist.percentile(50)),
      p95Ms: Math.round(w.hist.percentile(95)),
      p99Ms: Math.round(w.hist.percentile(99)),
      errorPct: w.count ? (100 * w.errors) / w.count : 0,
      codes: w.codes,
    }));
  }

  clear() {
    this.slots.clear();
  }
}
