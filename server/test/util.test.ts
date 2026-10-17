import { describe, expect, it } from 'vitest';
import { Histogram, StepStats } from '../src/loadgen/stats';
import { isLive } from '../src/shared/sale';
import { deepMerge, logNormal, zipfIndex } from '../src/shared/util';

describe('Histogram', () => {
  it('reports percentiles within ~5% for a uniform distribution', () => {
    const h = new Histogram();
    for (let ms = 1; ms <= 1000; ms++) h.record(ms);
    expect(h.percentile(50)).toBeGreaterThan(475);
    expect(h.percentile(50)).toBeLessThan(530);
    expect(h.percentile(99)).toBeGreaterThan(940);
    expect(h.percentile(99)).toBeLessThan(1045);
  });

  it('merges', () => {
    const a = new Histogram();
    const b = new Histogram();
    a.record(10);
    b.record(1000);
    a.merge(b);
    expect(a.total).toBe(2);
    expect(a.percentile(100)).toBeGreaterThan(950);
  });

  it('returns 0 when empty', () => {
    expect(new Histogram().percentile(99)).toBe(0);
  });
});

describe('StepStats', () => {
  it('aggregates only complete seconds in the window', () => {
    const s = new StepStats();
    s.record('home', 10, '200', false);
    // The current second is excluded from snapshots (incomplete).
    expect(s.snapshot(5)).toEqual([]);
  });
});

describe('deepMerge', () => {
  it('merges nested objects without mutating inputs and replaces scalars/arrays', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 1 };
    const out = deepMerge(base, { a: { c: [3] }, e: 2 });
    expect(out).toEqual({ a: { b: 1, c: [3] }, d: 1, e: 2 });
    expect(base).toEqual({ a: { b: 1, c: [1, 2] }, d: 1 });
  });
});

describe('sampling helpers', () => {
  it('logNormal has roughly the requested median', () => {
    const xs = Array.from({ length: 20_000 }, () => logNormal(100, 600)).sort((a, b) => a - b);
    const median = xs[xs.length / 2];
    expect(median).toBeGreaterThan(90);
    expect(median).toBeLessThan(110);
    const p99 = xs[Math.floor(xs.length * 0.99)];
    expect(p99).toBeGreaterThan(450);
    expect(p99).toBeLessThan(800);
  });

  it('zipfIndex favours the head', () => {
    const counts = new Array(12).fill(0);
    for (let i = 0; i < 20_000; i++) counts[zipfIndex(12, 1.2)]++;
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[11]);
  });
});

describe('isLive', () => {
  const sale = { name: 'x', startsAt: '2026-11-11T00:00:00.000Z', endsAt: '2026-11-12T00:00:00.000Z' };
  it('is inclusive of the start and exclusive of the end', () => {
    expect(isLive(sale, Date.parse(sale.startsAt) - 1)).toBe(false);
    expect(isLive(sale, Date.parse(sale.startsAt))).toBe(true);
    expect(isLive(sale, Date.parse(sale.endsAt))).toBe(false);
    expect(isLive(null, Date.now())).toBe(false);
  });
});
