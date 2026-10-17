import { describe, expect, it } from 'vitest';
import { MIN_RATE, toEdges, toHotStock, toStores, type Vector } from '../src/services/control-plane/summary';

/** An instant vector as Prometheus returns it (values are strings, NaN / +Inf included). */
const vec = (...rows: [Record<string, string>, number | string][]): Vector => rows.map(([metric, v]) => ({ metric, value: [1_792_000_000, String(v)] }));
const none: Vector = [];

describe('summary edges', () => {
  const calls = {
    rate: vec(
      [{ service: 'orders', target: 'payments' }, 5],
      [{ service: 'gateway', target: 'catalog' }, 120],
      [{ service: 'cart', target: 'catalog' }, MIN_RATE / 2],
      [{ service: 'gateway', target: 'cart' }, 'NaN'],
    ),
    p99: vec([{ service: 'gateway', target: 'catalog' }, 0.25], [{ service: 'orders', target: 'payments' }, 'NaN']),
    err: vec([{ service: 'orders', target: 'payments' }, 12.5]),
  };

  it('joins rate, p99 and errors per caller → callee, led by customers → gateway', () => {
    expect(toEdges(calls, { rps: 300, p99Ms: 900, errorPct: 2 })).toEqual([
      { from: 'customers', to: 'gateway', rps: 300, p99Ms: 900, errorPct: 2 },
      { from: 'gateway', to: 'catalog', rps: 120, p99Ms: 250, errorPct: 0 },
      { from: 'orders', to: 'payments', rps: 5, p99Ms: 0, errorPct: 12.5 },
    ]);
  });

  it('drops idle edges, including an idle gateway, and never emits non-finite numbers', () => {
    const edges = toEdges(calls, { rps: 0.01, p99Ms: NaN, errorPct: NaN });
    expect(edges.map((e) => `${e.from}->${e.to}`)).toEqual(['gateway->catalog', 'orders->payments']);
    expect(toEdges({ rate: none, p99: none, err: none }, { rps: 50, p99Ms: NaN, errorPct: Infinity })).toEqual([
      { from: 'customers', to: 'gateway', rps: 50, p99Ms: 0, errorPct: 0 },
    ]);
  });

  it('ignores series without caller or callee labels', () => {
    expect(toEdges({ rate: vec([{ service: 'gateway' }, 10], [{ target: 'catalog' }, 10]), p99: none, err: none }, { rps: 0, p99Ms: 0, errorPct: 0 })).toEqual([]);
  });
});

describe('summary stores', () => {
  it('lists postgres then redis load per service, without the control plane', () => {
    const pg = {
      rate: vec([{ service: 'orders' }, 250], [{ service: 'control-plane' }, 2], [{ service: 'inventory' }, 310], [{ service: 'payments' }, 0.01]),
      p99: vec([{ service: 'orders' }, 0.2], [{ service: 'inventory' }, '+Inf'], [{ service: 'control-plane' }, 0.01]),
      err: vec([{ service: 'inventory' }, 1.8], [{ service: 'orders' }, 'NaN']),
    };
    const redis = { rate: vec([{ service: 'gateway' }, 900], [{ service: 'cart' }, 190]), p99: vec([{ service: 'gateway' }, 0.004]), err: none };
    expect(toStores(pg, redis)).toEqual([
      { service: 'inventory', store: 'postgres', opsPerSec: 310, p99Ms: 0, errorPct: 1.8 },
      { service: 'orders', store: 'postgres', opsPerSec: 250, p99Ms: 200, errorPct: 0 },
      { service: 'cart', store: 'redis', opsPerSec: 190, p99Ms: 0, errorPct: 0 },
      { service: 'gateway', store: 'redis', opsPerSec: 900, p99Ms: 4, errorPct: 0 },
    ]);
  });
});

describe('summary hot stock', () => {
  it('sorts by sku and reads missing values as 0', () => {
    expect(toHotStock(vec([{ sku: 'HOT-0012' }, 20], [{ sku: 'HOT-0001' }, 0], [{ sku: 'HOT-0002' }, 'NaN'], [{}, 5]))).toEqual([
      { sku: 'HOT-0001', available: 0 },
      { sku: 'HOT-0002', available: 0 },
      { sku: 'HOT-0012', available: 20 },
    ]);
  });
});
