import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Resp } from '../src/loadgen/client';
import { JOURNEY_MAX_STEPS, journeySampleProbability, JourneyRecorder, JOURNEYS_PER_SEC } from '../src/loadgen/journey';

const ok = (body: unknown = {}, ms = 10, status = 200): Resp => ({ status, code: String(status), error: null, body, ms, retryAfterMs: null });
const fail = (status: number, error: string, ms = 10): Resp => ({ status, code: String(status), error, body: { error: { code: error } }, ms, retryAfterMs: null });
const timeout = (ms = 15_000): Resp => ({ status: 0, code: 'timeout', error: null, body: null, ms, retryAfterMs: null });

/** A recorder whose session started at performance.now() = 1000. */
function recorder(persona: 'shopper' | 'bot' = 'shopper') {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const rec = new JourneyRecorder(persona);
  const at = (ms: number) => 1000 + ms;
  return { rec, at };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('journey sampling', () => {
  it('samples everything at low load', () => {
    for (const rate of [0, 0.5, 1, 2, JOURNEYS_PER_SEC]) expect(journeySampleProbability(rate)).toBe(1);
  });

  it('keeps ~4 journeys/s at any arrival rate', () => {
    for (const rate of [5, 8, 140, 1400, 25_000]) expect(rate * journeySampleProbability(rate)).toBeCloseTo(JOURNEYS_PER_SEC, 9);
    expect(journeySampleProbability(8)).toBe(0.5);
  });

  it('never returns a probability outside [0, 1]', () => {
    for (const rate of [NaN, -5, Infinity, -Infinity]) {
      const p = journeySampleProbability(rate);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    expect(journeySampleProbability(NaN)).toBe(1);
  });
});

describe('journey truncation', () => {
  it('keeps every step up to the limit', () => {
    const { rec, at } = recorder();
    for (let i = 0; i < JOURNEY_MAX_STEPS; i++) rec.record('queue', at(i * 100), ok());
    const j = rec.finish('converted');
    expect(j.steps).toHaveLength(JOURNEY_MAX_STEPS);
    expect(j).not.toHaveProperty('truncated');
  });

  it('keeps the first 39 steps and the last one, and flags it', () => {
    const { rec, at } = recorder();
    for (let i = 0; i < 99; i++) rec.record('queue', at(i * 100), ok({ admitted: false }));
    rec.record('checkout', at(99 * 100), fail(409, 'OUT_OF_STOCK'));
    const j = rec.finish('sold_out');
    expect(j.steps).toHaveLength(40);
    expect(j.truncated).toBe(true);
    expect(j.steps.slice(0, 39).map((s) => s.atMs)).toEqual(Array.from({ length: 39 }, (_, i) => i * 100));
    expect(j.steps[39]).toEqual({ step: 'checkout', atMs: 9900, ms: 10, status: 409, code: 'OUT_OF_STOCK' });
  });

  it('truncates exactly one step over the limit', () => {
    const { rec, at } = recorder();
    for (let i = 0; i <= JOURNEY_MAX_STEPS; i++) rec.record(`s${i}`, at(i), ok());
    const j = rec.finish('failed');
    expect(j.steps.map((s) => s.step)).toEqual([...Array.from({ length: 39 }, (_, i) => `s${i}`), 's40']);
    expect(j.truncated).toBe(true);
  });

  it('measures the waiting room across truncated polls', () => {
    const { rec, at } = recorder('bot');
    rec.record('queue', at(500), ok({ ticket: 7 }, 20)); // join
    for (let i = 1; i <= 200; i++) rec.record('queue', at(500 + i * 250), ok({ admitted: i === 200 }, 5));
    const j = rec.finish('abandoned');
    expect(j.truncated).toBe(true);
    expect(j.queueWaitMs).toBe(200 * 250 + 5);
  });
});

describe('journey contents', () => {
  it('records a shopper who queued, timed out once and paid', () => {
    const { rec, at } = recorder();
    rec.record('auth', at(0), ok({ token: 't' }, 8));
    rec.record('product', at(300), fail(503, 'OVERLOADED'));
    rec.record('product', at(900), ok({ id: 12, name: 'Galaxy S-Ultra' }, 240));
    rec.record('product', at(4000), ok({ id: 3, name: 'Earbuds' }, 200));
    rec.record('checkout', at(6000), fail(409, 'QUEUE_REQUIRED', 40));
    rec.record('queue', at(6050), ok({ ticket: 1 }, 15));
    rec.record('queue', at(8070), ok({ admitted: true, pass: 'p' }, 30));
    rec.record('checkout', at(8110), ok({ order: { id: 'o1', totalCents: 4_999_00 } }, 180, 201));
    rec.record('pay', at(9000), timeout(15_000));
    rec.record('pay', at(24_000), ok({ order: { id: 'o1', status: 'PAID', totalCents: 4_999_00 } }, 600));
    vi.mocked(performance.now).mockReturnValue(1000 + 25_000);
    const j = rec.finish('converted');

    expect(j.id).toMatch(/^[0-9a-f]{8}$/);
    expect(j.persona).toBe('shopper');
    expect(j.durationMs).toBe(25_000);
    expect(j.product).toEqual({ id: 12, name: 'Galaxy S-Ultra' });
    expect(j.amountCents).toBe(4_999_00);
    expect(j.queueWaitMs).toBe(8070 + 30 - 6050);
    expect(j.steps.map((s) => s.code)).toEqual([null, 'OVERLOADED', null, null, 'QUEUE_REQUIRED', null, null, null, 'timeout', null]);
    expect(j.steps[8]).toEqual({ step: 'pay', atMs: 9000, ms: 15_000, status: 0, code: 'timeout' });
    expect(j).not.toHaveProperty('truncated');
  });

  it('takes the amount from the order that became PAID while polling', () => {
    const { rec, at } = recorder();
    rec.record('checkout', at(0), ok({ order: { id: 'o1', totalCents: 1500 } }, 100, 201));
    rec.record('pay', at(200), ok({ order: { id: 'o1', status: 'PAYMENT_PENDING', totalCents: 1500 } }, 100, 202));
    rec.record('order_status', at(2300), ok({ order: { id: 'o1', status: 'PAYMENT_PENDING', totalCents: 1500 } }));
    rec.record('order_status', at(4300), ok({ order: { id: 'o1', status: 'PAID', totalCents: 1500 } }));
    expect(rec.finish('converted').amountCents).toBe(1500);
  });

  it('falls back to the checkout total for a converted session that never saw PAID (bot, 202)', () => {
    const { rec, at } = recorder('bot');
    rec.record('checkout', at(0), ok({ order: { id: 'o1', totalCents: 2 * 9900 } }, 100, 201));
    rec.record('pay', at(150), ok({ order: { id: 'o1', status: 'PAYMENT_PENDING', totalCents: 2 * 9900 } }, 100, 202));
    expect(rec.finish('converted').amountCents).toBe(2 * 9900);
  });

  it('has no amount, product or queue time when the session never got there', () => {
    const { rec, at } = recorder();
    rec.record('home', at(0), ok({ deals: [] }));
    rec.record('checkout', at(500), ok({ order: { id: 'o1', totalCents: 1500 } }, 100, 201));
    const j = rec.finish('abandoned');
    expect(j.amountCents).toBeNull();
    expect(j.product).toBeNull();
    expect(j.queueWaitMs).toBeNull();
  });

  it('lists double clicks in click order, not completion order', () => {
    const { rec, at } = recorder();
    rec.record('checkout', at(1100), fail(409, 'REQUEST_IN_PROGRESS', 20)); // second click, answered first
    rec.record('checkout', at(1000), ok({ order: { id: 'o1', totalCents: 100 } }, 400, 201));
    expect(rec.finish('abandoned').steps.map((s) => s.atMs)).toEqual([1000, 1100]);
  });
});
