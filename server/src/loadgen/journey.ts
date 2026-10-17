import { randomUUID } from 'node:crypto';
import type { Resp } from './client';
import type { Persona, SessionResult } from './vu';

/**
 * Shopper journeys: a few sampled sessions, recorded request by request, so the war room
 * can show what individual customers actually went through (docs/contract.md §3).
 */

export interface JourneyStep {
  /** Loadgen step label (auth, home, search, … order_status). */
  step: string;
  /** When the customer clicked, relative to the session start. */
  atMs: number;
  /** Latency as the customer felt it. */
  ms: number;
  /** HTTP status, 0 for timeout / network error. */
  status: number;
  /** Error code from the JSON error body, 'timeout' / 'network' when status is 0, else null. */
  code: string | null;
}

export interface Journey {
  id: string;
  persona: Persona;
  startedAt: number;
  durationMs: number;
  result: SessionResult;
  steps: JourneyStep[];
  truncated?: boolean;
  product: { id: number; name: string } | null;
  amountCents: number | null;
  queueWaitMs: number | null;
}

/** Journeys per second to emit, whatever the load. */
export const JOURNEYS_PER_SEC = 4;
/** Longer sessions keep their first MAX_STEPS - 1 steps and their last one. */
export const JOURNEY_MAX_STEPS = 40;

/** Probability of sampling a session that starts now, so that ~`perSec` journeys/s come out at any arrival rate. */
export function journeySampleProbability(arrivalPerSec: number, perSec = JOURNEYS_PER_SEC): number {
  const rate = Number.isFinite(arrivalPerSec) ? Math.max(1, arrivalPerSec) : 1;
  return Math.min(1, perSec / rate);
}

const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Records one sampled session. Unsampled sessions have no recorder at all, so their cost
 * is a null check per request.
 */
export class JourneyRecorder {
  readonly id = randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  private readonly t0 = performance.now();
  private steps: JourneyStep[] = [];
  private truncated = false;
  private product: Journey['product'] = null;
  private orderCents: number | null = null;
  private paidCents: number | null = null;
  private queueFrom: number | null = null;
  private queueTo = 0;

  constructor(readonly persona: Persona) {}

  /** One request; `clickedAt` is performance.now() when the customer clicked. */
  record(step: string, clickedAt: number, r: Resp) {
    const atMs = clickedAt - this.t0;
    const s: JourneyStep = { step, atMs: Math.round(atMs), ms: Math.round(r.ms), status: r.status, code: r.status === 0 ? r.code : r.error };
    // Bounded: once full, the last slot always holds the latest step.
    if (this.steps.length < JOURNEY_MAX_STEPS) {
      this.steps.push(s);
    } else {
      this.steps[JOURNEY_MAX_STEPS - 1] = s;
      this.truncated = true;
    }
    if (step === 'queue') {
      this.queueFrom ??= atMs;
      this.queueTo = Math.max(this.queueTo, atMs + r.ms);
    }
    if (r.status < 200 || r.status >= 300 || !r.body || typeof r.body !== 'object') return;
    const b = r.body;
    if (step === 'product') {
      if (!this.product && typeof b.id === 'number' && typeof b.name === 'string') this.product = { id: b.id, name: b.name };
    } else if (step === 'checkout') {
      this.orderCents = cents(b.order?.totalCents) ?? this.orderCents;
    } else if ((step === 'pay' || step === 'order_status') && b.order?.status === 'PAID') {
      this.paidCents ??= cents(b.order.totalCents);
    }
  }

  finish(result: SessionResult): Journey {
    // Steps are recorded as they complete; show them in click order (double clicks overlap).
    const byStart = (a: JourneyStep, b: JourneyStep) => a.atMs - b.atMs;
    const steps = this.truncated ? [...this.steps.slice(0, -1).sort(byStart), this.steps[this.steps.length - 1]] : [...this.steps].sort(byStart);
    return {
      id: this.id,
      persona: this.persona,
      startedAt: this.startedAt,
      durationMs: Math.round(performance.now() - this.t0),
      result,
      steps,
      ...(this.truncated ? { truncated: true } : {}),
      product: this.product,
      // A bot counts a pending (202) payment as a purchase without ever seeing PAID.
      amountCents: this.paidCents ?? (result === 'converted' ? this.orderCents : null),
      queueWaitMs: this.queueFrom === null ? null : Math.round(this.queueTo - this.queueFrom),
    };
  }
}
