import { useSyncExternalStore } from 'react';
import { ApiError, sleep, toApiError } from '../api/http';
import { shopApi } from '../api/shop';
import type { Order, PaymentMethod } from '../api/types';
import { uuid } from '../lib/ids';
import { session } from '../lib/storage';

/**
 * Checkout state machine, kept outside React so that remounts (StrictMode, navigation)
 * can never fire a second POST /api/checkout or /pay by accident.
 *
 *   review ──place──▶ placing ──201──▶ pay ──pay──▶ paying ──200──▶ success
 *                        │ 409 QUEUE_REQUIRED            │ 202 PAYMENT_PENDING
 *                        ▼                               ▼
 *                      queue ──admitted──▶ placing     confirming ──PAID──▶ success
 *
 * Idempotency: one `checkoutKey` per order attempt and one `payKey` per payment
 * attempt. Retries after transient failures reuse the key (so the server can dedupe);
 * a deliberately new attempt (after a decline, a price change, dropping a coupon)
 * gets a fresh key.
 */

export type CheckoutPhase =
  | 'idle'
  | 'review'
  | 'placing'
  | 'queue'
  | 'resuming'
  | 'pay'
  | 'paying'
  | 'confirming'
  | 'success'
  | 'closed';

export interface QueueView {
  ticket: number | null;
  position: number | null;
  etaSec: number | null;
  initialPosition: number | null;
  joinedAt: number;
  admitted: boolean;
  lastError: ApiError | null;
}

export interface CheckoutState {
  phase: CheckoutPhase;
  checkoutKey: string;
  couponCode: string | null;
  order: Order | null;
  payKey: string | null;
  method: PaymentMethod;
  error: ApiError | null;
  errorAt: 'checkout' | 'queue' | 'payment' | 'resume' | null;
  queue: QueueView | null;
  queuePass: string | null;
  confirmingSince: number | null;
  /** Soft status line ("still processing…", "order not visible yet…"). */
  note: string | null;
  /** Retry-After: earliest time the retry button should be enabled. */
  retryAt: number | null;
  checkoutAttempts: number;
  payAttempts: number;
  /** Orders that are EXPIRED / REJECTED can't continue. */
  closedReason: string | null;
  /** Order being (re)loaded — lets the UI retry a failed load. */
  resumeOrderId: string | null;
  /** This attempt went through the virtual waiting room (keeps the step visible). */
  usedQueue: boolean;
}

interface Persisted {
  checkoutKey: string;
  couponCode: string | null;
  orderId: string | null;
  payKey: string | null;
  method: PaymentMethod;
  queueTicket: number | null;
  queueInitial: number | null;
  queuePass: string | null;
  phase: CheckoutPhase;
}

const SESSION_KEY = 'breakcart.checkout.v2';
const BUSY: readonly CheckoutPhase[] = ['placing', 'queue', 'resuming', 'paying', 'confirming'];

function fresh(): CheckoutState {
  return {
    phase: 'idle',
    checkoutKey: uuid(),
    couponCode: null,
    order: null,
    payKey: null,
    method: 'card',
    error: null,
    errorAt: null,
    queue: null,
    queuePass: null,
    confirmingSince: null,
    note: null,
    retryAt: null,
    checkoutAttempts: 0,
    payAttempts: 0,
    closedReason: null,
    resumeOrderId: null,
    usedQueue: false,
  };
}

/**
 * Can this failure be retried with the SAME Idempotency-Key? The orders service stores the
 * outcome of every non-5xx response under the key and replays it, so only failures that
 * never reached it (edge rejections, network) or were released (5xx) qualify.
 */
export function sameKeyRetryable(err: ApiError): boolean {
  if (err.status === 0 || err.status >= 500 || err.status === 429) return true;
  return ['RATE_LIMITED', 'OVERLOADED', 'QUEUE_REQUIRED', 'REQUEST_IN_PROGRESS', 'BOT_SUSPECTED'].includes(err.code);
}

function retryAtFor(err: ApiError): number | null {
  return err.retryAfterSec != null && err.retryAfterSec > 0 ? Date.now() + err.retryAfterSec * 1000 : null;
}

class CheckoutMachine {
  private s: CheckoutState = fresh();
  private listeners = new Set<() => void>();
  /** Bumped to cancel whatever loop (queue polling, payment confirmation) is running. */
  private loop = 0;
  private loopCtrl = new AbortController();
  private admittedRequeues = 0;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.s;

  private set(patch: Partial<CheckoutState>) {
    this.s = { ...this.s, ...patch };
    this.persist();
    for (const l of this.listeners) l();
  }

  private persist() {
    const s = this.s;
    if (s.phase === 'idle') return;
    const p: Persisted = {
      checkoutKey: s.checkoutKey,
      couponCode: s.couponCode,
      orderId: s.order?.id ?? null,
      payKey: s.payKey,
      method: s.method,
      queueTicket: s.phase === 'queue' ? (s.queue?.ticket ?? null) : null,
      queueInitial: s.queue?.initialPosition ?? null,
      queuePass: s.queuePass,
      phase: s.phase,
    };
    session.setJSON(SESSION_KEY, p);
  }

  private newLoop(): number {
    this.loop += 1;
    this.loopCtrl.abort();
    this.loopCtrl = new AbortController();
    return this.loop;
  }

  private alive(token: number) {
    return token === this.loop;
  }

  isBusy(): boolean {
    return BUSY.includes(this.s.phase);
  }

  /** "Place order" from the cart: a brand-new attempt with a fresh Idempotency-Key. */
  begin(couponCode: string | null) {
    if (this.isBusy()) return;
    this.newLoop();
    this.admittedRequeues = 0;
    this.s = { ...fresh(), phase: 'placing', couponCode: couponCode?.trim() || null };
    this.set({});
    void this.place(null);
  }

  /** /checkout opened directly (refresh, deep link): pick up where this tab left off. */
  restore() {
    if (this.s.phase !== 'idle') return;
    const p = session.getJSON<Persisted>(SESSION_KEY);
    if (!p || typeof p.checkoutKey !== 'string') {
      this.set({ phase: 'review' });
      return;
    }
    this.s = {
      ...fresh(),
      checkoutKey: p.checkoutKey,
      couponCode: p.couponCode ?? null,
      payKey: p.payKey ?? null,
      method: p.method === 'upi' ? 'upi' : 'card',
      queuePass: typeof p.queuePass === 'string' ? p.queuePass : null,
    };
    if (p.orderId) {
      void this.loadOrder(p.orderId);
    } else if (p.phase === 'placing') {
      // Reloaded while the order was being placed: re-send with the SAME key, so the server
      // replays the result (or reports it's still in progress) instead of creating another order.
      void this.place(this.s.queuePass);
    } else if (p.phase === 'queue' && p.queueTicket != null) {
      const token = this.newLoop();
      this.set({
        phase: 'queue',
        usedQueue: true,
        queue: {
          ticket: p.queueTicket,
          position: null,
          etaSec: null,
          initialPosition: p.queueInitial,
          joinedAt: Date.now(),
          admitted: false,
          lastError: null,
        },
      });
      void this.pollQueue(token, p.queueTicket);
    } else {
      this.set({ phase: 'review' });
    }
  }

  /** /checkout?order=<id>: pay for an existing order (e.g. from the order page). */
  resume(orderId: string) {
    if (this.s.order?.id === orderId && this.s.phase !== 'idle' && this.s.phase !== 'review') return;
    if (this.s.phase === 'resuming' && this.s.resumeOrderId === orderId) return;
    this.newLoop();
    this.s = { ...fresh(), phase: 'resuming', resumeOrderId: orderId };
    void this.loadOrder(orderId);
  }

  /** Retry the same attempt (same Idempotency-Key) after a transient failure. */
  retryCheckout() {
    if (this.isBusy()) return;
    void this.place(this.s.queuePass);
  }

  /** Start over with a new Idempotency-Key, optionally without the coupon. */
  newAttempt(opts: { dropCoupon?: boolean } = {}) {
    if (this.isBusy()) return;
    this.newLoop();
    this.admittedRequeues = 0;
    this.set({
      checkoutKey: uuid(),
      couponCode: opts.dropCoupon ? null : this.s.couponCode,
      queuePass: null,
      error: null,
      errorAt: null,
    });
    void this.place(null);
  }

  setMethod(method: PaymentMethod) {
    if (this.s.phase === 'pay') this.set({ method });
  }

  async pay() {
    const order = this.s.order;
    if (this.s.phase !== 'pay' || !order) return;
    const token = this.newLoop();
    const payKey = this.s.payKey ?? uuid();
    this.set({
      phase: 'paying',
      payKey,
      error: null,
      errorAt: null,
      note: null,
      retryAt: null,
      payAttempts: this.s.payAttempts + 1,
    });
    try {
      const r = await shopApi.pay(order.id, payKey, this.s.method);
      if (!this.alive(token)) return;
      const o = r.data?.order;
      if (!o) throw new ApiError({ status: r.status, code: 'BAD_RESPONSE', message: 'Payment response had no order', retryable: true });
      if (r.status === 202 || o.status === 'PAYMENT_PENDING' || o.status === 'PAYMENT_IN_PROGRESS') {
        this.set({ order: o, phase: 'confirming', confirmingSince: Date.now() });
        void this.pollConfirm(token, o.id);
        return;
      }
      this.applyOrder(o);
    } catch (e) {
      if (!this.alive(token)) return;
      const err = toApiError(e);
      switch (err.code) {
        case 'PAYMENT_PENDING':
        case 'REQUEST_IN_PROGRESS':
          this.set({ phase: 'confirming', confirmingSince: Date.now(), note: null });
          void this.pollConfirm(token, order.id);
          return;
        case 'PAYMENT_DECLINED':
          // A decline is final for that attempt: the next try is a new payment attempt.
          this.set({ phase: 'pay', payKey: uuid(), error: err, errorAt: 'payment' });
          return;
        case 'INVALID_STATE':
        case 'ORDER_EXPIRED':
          // The order moved on (paid elsewhere, expired, failed): show where it ended up.
          this.set({ error: err, errorAt: 'payment' });
          await this.loadOrder(order.id, true);
          return;
        default:
          // Timeouts, overload, 5xx, network: retrying with the SAME key is safe. Any other
          // 4xx was stored under this key and would just be replayed, so rotate it.
          this.set({
            phase: 'pay',
            error: err,
            errorAt: 'payment',
            retryAt: retryAtFor(err),
            payKey: sameKeyRetryable(err) ? payKey : uuid(),
          });
      }
    }
  }

  /** "Check payment status" after a timeout, or re-arm confirmation polling. */
  checkStatus() {
    const id = this.s.order?.id;
    if (!id) return;
    if (this.s.phase === 'confirming') {
      const token = this.newLoop();
      this.set({ note: null, confirmingSince: Date.now() });
      void this.pollConfirm(token, id);
      return;
    }
    if (!this.isBusy()) void this.loadOrder(id, true);
  }

  reset() {
    this.newLoop();
    this.s = fresh();
    session.remove(SESSION_KEY);
    for (const l of this.listeners) l();
  }

  /* ---------------------------------------------------------------- internals */

  private applyOrder(o: Order, keepError = false) {
    const err = keepError ? { error: this.s.error, errorAt: this.s.errorAt } : { error: null, errorAt: null };
    switch (o.status) {
      case 'PAID':
        this.newLoop();
        this.set({ order: o, phase: 'success', error: null, errorAt: null, note: null });
        return;
      case 'PAYMENT_PENDING':
      case 'PAYMENT_IN_PROGRESS': {
        const token = this.newLoop();
        this.set({ order: o, phase: 'confirming', confirmingSince: Date.now(), ...err });
        void this.pollConfirm(token, o.id);
        return;
      }
      case 'PAYMENT_FAILED':
        // Terminal: the reservation was released (declines go back to AWAITING_PAYMENT instead).
        this.newLoop();
        this.set({
          order: o,
          phase: 'closed',
          closedReason: `The payment for this order failed${o.failureReason ? ` (${o.failureReason})` : ''} and the reserved stock was released. If money was debited it will be refunded — please place a new order.`,
          ...err,
        });
        return;
      case 'EXPIRED':
      case 'REJECTED':
        this.newLoop();
        this.set({
          order: o,
          phase: 'closed',
          closedReason:
            o.status === 'EXPIRED'
              ? 'This order expired before it was paid, so the reserved stock was released.'
              : `This order was rejected${o.failureReason ? `: ${o.failureReason}` : '.'}`,
          ...err,
        });
        return;
      default:
        this.set({ order: o, phase: 'pay', payKey: this.s.payKey ?? uuid(), note: null, ...err });
    }
  }

  private async loadOrder(orderId: string, keepError = false) {
    const token = this.newLoop();
    this.set({ phase: 'resuming', note: null, resumeOrderId: orderId });
    try {
      const { data } = await shopApi.order(orderId, this.loopCtrl.signal);
      if (!this.alive(token)) return;
      if (!data?.order) throw new ApiError({ status: 200, code: 'BAD_RESPONSE', message: 'No order in response', retryable: true });
      this.applyOrder(data.order, keepError);
    } catch (e) {
      if (!this.alive(token)) return;
      const err = toApiError(e);
      if (err.code === 'ABORTED') return;
      // Keep the order we had (if any) so the customer can try again.
      this.set({
        phase: this.s.order ? 'pay' : 'review',
        error: err,
        errorAt: 'resume',
        retryAt: retryAtFor(err),
      });
    }
  }

  private async place(queuePass: string | null) {
    const token = this.newLoop();
    this.set({
      phase: 'placing',
      error: null,
      errorAt: null,
      note: null,
      retryAt: null,
      checkoutAttempts: this.s.checkoutAttempts + 1,
    });
    for (let inProgressTries = 0; ; inProgressTries++) {
      try {
        const r = await shopApi.checkout(this.s.checkoutKey, this.s.couponCode, queuePass);
        if (!this.alive(token)) return;
        const order = r.data?.order;
        if (!order) throw new ApiError({ status: r.status, code: 'BAD_RESPONSE', message: 'Checkout returned no order', retryable: true });
        this.admittedRequeues = 0;
        this.set({ queue: null, queuePass: null, payKey: uuid() });
        this.applyOrder(order);
        return;
      } catch (e) {
        if (!this.alive(token)) return;
        const err = toApiError(e);
        if (err.code === 'QUEUE_REQUIRED') {
          if (queuePass) this.admittedRequeues += 1;
          if (this.admittedRequeues > 2) {
            this.set({ phase: 'review', error: err, errorAt: 'checkout', note: 'The queue pass was not accepted.' });
            return;
          }
          void this.joinQueue(token);
          return;
        }
        if (err.code === 'REQUEST_IN_PROGRESS' && inProgressTries < 8) {
          // The first attempt with this key is still running server-side; wait for its result.
          this.set({ note: 'Your order is still being processed — waiting for the result…' });
          try {
            await sleep(1500, this.loopCtrl.signal);
          } catch {
            return;
          }
          if (!this.alive(token)) return;
          continue;
        }
        this.set({ phase: 'review', error: err, errorAt: 'checkout', note: null, retryAt: retryAtFor(err) });
        return;
      }
    }
  }

  private async joinQueue(token: number) {
    const joinedAt = Date.now();
    this.set({
      phase: 'queue',
      usedQueue: true,
      queue: {
        ticket: null,
        position: null,
        etaSec: null,
        initialPosition: null,
        joinedAt,
        admitted: false,
        lastError: null,
      },
      queuePass: null,
      error: null,
      errorAt: null,
      note: null,
    });
    for (let failures = 0; this.alive(token); ) {
      try {
        const { data } = await shopApi.queueJoin();
        if (!this.alive(token)) return;
        this.set({
          queue: {
            ticket: data.ticket,
            position: data.position,
            etaSec: data.etaSec,
            initialPosition: data.position,
            joinedAt,
            admitted: false,
            lastError: null,
          },
        });
        void this.pollQueue(token, data.ticket);
        return;
      } catch (e) {
        if (!this.alive(token)) return;
        const err = toApiError(e);
        failures += 1;
        if (this.s.queue) this.set({ queue: { ...this.s.queue, lastError: err } });
        if (failures >= 8) {
          this.set({ phase: 'review', error: err, errorAt: 'queue' });
          return;
        }
        try {
          await sleep(Math.min(15_000, 1000 * 2 ** failures), this.loopCtrl.signal);
        } catch {
          return;
        }
      }
    }
  }

  private async pollQueue(token: number, ticket: number) {
    let failures = 0;
    const started = Date.now();
    while (this.alive(token)) {
      try {
        await sleep(failures ? Math.min(15_000, 2000 * 2 ** failures) : 2000, this.loopCtrl.signal);
      } catch {
        return;
      }
      if (!this.alive(token)) return;
      try {
        const { data } = await shopApi.queueStatus(ticket, this.loopCtrl.signal);
        if (!this.alive(token)) return;
        failures = 0;
        const q = this.s.queue;
        const base: QueueView = q ?? {
          ticket,
          position: null,
          etaSec: null,
          initialPosition: null,
          joinedAt: started,
          admitted: false,
          lastError: null,
        };
        if (data.admitted && data.pass) {
          this.set({ queue: { ...base, admitted: true, position: 0, etaSec: 0, lastError: null }, queuePass: data.pass });
          await this.place(data.pass);
          return;
        }
        this.set({
          queue: {
            ...base,
            ticket,
            position: data.position,
            etaSec: data.etaSec,
            initialPosition: base.initialPosition ?? data.position,
            lastError: null,
          },
        });
      } catch (e) {
        if (!this.alive(token)) return;
        const err = toApiError(e);
        if (err.code === 'ABORTED') return;
        if (err.code === 'NOT_FOUND') {
          // Ticket expired or unknown (e.g. the queue was reset): take a new place in line.
          void this.joinQueue(token);
          return;
        }
        failures += 1;
        if (this.s.queue) this.set({ queue: { ...this.s.queue, lastError: err } });
      }
      if (Date.now() - started > 20 * 60_000) {
        this.set({
          phase: 'review',
          error: new ApiError({ status: 0, code: 'TIMEOUT', message: 'Waited 20 minutes in the queue', retryable: true }),
          errorAt: 'queue',
        });
        return;
      }
    }
  }

  private async pollConfirm(token: number, orderId: string) {
    const since = Date.now();
    let failures = 0;
    while (this.alive(token)) {
      const elapsed = Date.now() - since;
      try {
        await sleep(failures ? Math.min(15_000, 2000 * 2 ** failures) : elapsed > 60_000 ? 5000 : 2000, this.loopCtrl.signal);
      } catch {
        return;
      }
      if (!this.alive(token)) return;
      try {
        const { data } = await shopApi.order(orderId, this.loopCtrl.signal);
        if (!this.alive(token)) return;
        failures = 0;
        const o = data.order;
        if (o.status === 'PAYMENT_PENDING' || o.status === 'PAYMENT_IN_PROGRESS') {
          this.set({ order: o, note: null });
        } else {
          this.applyOrder(o);
          return;
        }
      } catch (e) {
        if (!this.alive(token)) return;
        const err = toApiError(e);
        if (err.code === 'ABORTED') return;
        failures += 1;
        this.set({
          note:
            err.code === 'NOT_FOUND'
              ? 'We can’t see your order yet — it may take a few seconds to show up. Please don’t pay again.'
              : 'Having trouble reaching the store — still checking…',
        });
      }
      if (Date.now() - since > 5 * 60_000) {
        this.set({ note: 'We stopped checking automatically. Your order page will show the final status.' });
        return;
      }
    }
  }
}

export const checkout = new CheckoutMachine();

export function useCheckoutState(): CheckoutState {
  return useSyncExternalStore(checkout.subscribe, checkout.getSnapshot, checkout.getSnapshot);
}
