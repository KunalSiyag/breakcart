export type BreakerState = 'closed' | 'half_open' | 'open';

export interface BreakerOptions {
  /** Sliding window length in ms. */
  windowMs: number;
  /** Minimum calls in the window before the failure rate is evaluated. */
  minCalls: number;
  /** Failure ratio (0..1) that trips the breaker. */
  failureRatio: number;
  /** How long to stay open before probing. */
  openMs: number;
  /** Probes allowed concurrently in half-open. */
  halfOpenProbes: number;
  onTransition?: (from: BreakerState, to: BreakerState) => void;
  now?: () => number;
}

const DEFAULTS: BreakerOptions = {
  windowMs: 10_000,
  minCalls: 20,
  failureRatio: 0.5,
  openMs: 5000,
  halfOpenProbes: 3,
};

/**
 * Time-bucketed sliding-window circuit breaker (1s buckets).
 *
 * closed ──(failure ratio ≥ threshold)──▶ open ──(openMs)──▶ half_open
 *   ▲                                                        │
 *   └──────────────(all probes succeed)──────────────────────┘ (any probe fails → open)
 */
export class CircuitBreaker {
  private opts: BreakerOptions;
  private buckets = new Map<number, { ok: number; fail: number }>();
  state: BreakerState = 'closed';
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;

  constructor(opts: Partial<BreakerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private transition(to: BreakerState) {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    if (to === 'open') this.openedAt = this.now();
    if (to === 'half_open') {
      this.probesInFlight = 0;
      this.probeSuccesses = 0;
    }
    if (to === 'closed') this.buckets.clear();
    this.opts.onTransition?.(from, to);
  }

  /** Returns true if the call may proceed. Must be followed by onSuccess/onFailure when true. */
  tryAcquire(): boolean {
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.opts.openMs) this.transition('half_open');
      else return false;
    }
    if (this.state === 'half_open') {
      if (this.probesInFlight >= this.opts.halfOpenProbes) return false;
      this.probesInFlight++;
      return true;
    }
    return true;
  }

  onSuccess() {
    if (this.state === 'half_open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.probeSuccesses++;
      if (this.probeSuccesses >= this.opts.halfOpenProbes) this.transition('closed');
      return;
    }
    this.record(true);
  }

  onFailure() {
    if (this.state === 'half_open') {
      this.transition('open');
      return;
    }
    this.record(false);
    if (this.state === 'closed') {
      const { ok, fail } = this.totals();
      const calls = ok + fail;
      if (calls >= this.opts.minCalls && fail / calls >= this.opts.failureRatio) this.transition('open');
    }
  }

  private record(ok: boolean) {
    const sec = Math.floor(this.now() / 1000);
    let b = this.buckets.get(sec);
    if (!b) {
      b = { ok: 0, fail: 0 };
      this.buckets.set(sec, b);
      const oldest = sec - Math.ceil(this.opts.windowMs / 1000);
      for (const k of this.buckets.keys()) if (k <= oldest) this.buckets.delete(k);
    }
    if (ok) b.ok++;
    else b.fail++;
  }

  totals() {
    const oldest = Math.floor(this.now() / 1000) - Math.ceil(this.opts.windowMs / 1000);
    let ok = 0;
    let fail = 0;
    for (const [k, b] of this.buckets) {
      if (k <= oldest) continue;
      ok += b.ok;
      fail += b.fail;
    }
    return { ok, fail };
  }

  reset() {
    this.buckets.clear();
    this.transition('closed');
  }
}

/**
 * Retry budget: every request deposits `ratio` tokens, every retry spends one.
 * Caps retries at ~ratio × request volume so retries can't multiply load during an outage.
 */
export class RetryBudget {
  private tokens: number;

  constructor(
    private ratio = 0.1,
    private max = 20,
  ) {
    this.tokens = max;
  }

  deposit() {
    this.tokens = Math.min(this.max, this.tokens + this.ratio);
  }

  trySpend(): boolean {
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Exponential backoff with full jitter (AWS architecture blog, 2015). */
export function backoffMs(attempt: number, baseMs = 50, capMs = 1000): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}
