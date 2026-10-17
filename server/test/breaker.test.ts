import { describe, expect, it } from 'vitest';
import { backoffMs, CircuitBreaker, RetryBudget } from '../src/shared/breaker';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('stays closed below the minimum call volume even if everything fails', () => {
    const c = clock();
    const b = new CircuitBreaker({ minCalls: 20, now: c.now });
    for (let i = 0; i < 19; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.onFailure();
    }
    expect(b.state).toBe('closed');
  });

  it('opens when the failure ratio crosses the threshold, then fails fast', () => {
    const c = clock();
    const transitions: string[] = [];
    const b = new CircuitBreaker({ minCalls: 10, failureRatio: 0.5, now: c.now, onTransition: (f, t) => transitions.push(`${f}->${t}`) });
    for (let i = 0; i < 5; i++) {
      b.tryAcquire();
      b.onSuccess();
    }
    for (let i = 0; i < 5; i++) {
      b.tryAcquire();
      b.onFailure();
    }
    expect(b.state).toBe('open');
    expect(transitions).toEqual(['closed->open']);
    expect(b.tryAcquire()).toBe(false);
  });

  it('half-opens after openMs, closes after successful probes', () => {
    const c = clock();
    const b = new CircuitBreaker({ minCalls: 2, openMs: 5000, halfOpenProbes: 2, now: c.now });
    b.tryAcquire();
    b.onFailure();
    b.tryAcquire();
    b.onFailure();
    expect(b.state).toBe('open');
    c.advance(4999);
    expect(b.tryAcquire()).toBe(false);
    c.advance(1);
    expect(b.tryAcquire()).toBe(true);
    expect(b.state).toBe('half_open');
    expect(b.tryAcquire()).toBe(true);
    // Only `halfOpenProbes` concurrent probes allowed.
    expect(b.tryAcquire()).toBe(false);
    b.onSuccess();
    b.onSuccess();
    expect(b.state).toBe('closed');
  });

  it('re-opens if a half-open probe fails', () => {
    const c = clock();
    const b = new CircuitBreaker({ minCalls: 1, openMs: 1000, now: c.now });
    b.tryAcquire();
    b.onFailure();
    c.advance(1000);
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
    expect(b.state).toBe('open');
  });

  it('forgets failures older than the window', () => {
    const c = clock();
    const b = new CircuitBreaker({ minCalls: 4, windowMs: 10_000, now: c.now });
    for (let i = 0; i < 3; i++) {
      b.tryAcquire();
      b.onFailure();
    }
    c.advance(15_000);
    for (let i = 0; i < 3; i++) {
      b.tryAcquire();
      b.onSuccess();
    }
    b.tryAcquire();
    b.onFailure();
    expect(b.totals()).toEqual({ ok: 3, fail: 1 });
    expect(b.state).toBe('closed');
  });
});

describe('RetryBudget', () => {
  it('caps retries to roughly ratio x requests once the initial burst is spent', () => {
    const budget = new RetryBudget(0.1, 5);
    let retries = 0;
    for (let i = 0; i < 1000; i++) {
      budget.deposit();
      if (budget.trySpend()) retries++;
    }
    // 5 initial tokens + 10% of 1000 requests.
    expect(retries).toBeGreaterThanOrEqual(100);
    expect(retries).toBeLessThanOrEqual(106);
  });
});

describe('backoffMs', () => {
  it('uses full jitter bounded by the exponential cap', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let i = 0; i < 50; i++) {
        const d = backoffMs(attempt, 50, 1000);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.min(1000, 50 * 2 ** attempt));
      }
    }
  });
});
