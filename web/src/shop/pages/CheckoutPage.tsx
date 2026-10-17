import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Order, PaymentMethod } from '../../api/types';
import { formatClock, formatDuration, formatINR, formatInt, plural } from '../../lib/format';
import { shortId } from '../../lib/ids';
import { useDocumentTitle, useElapsed, useNow } from '../../lib/hooks';
import { session } from '../../lib/storage';
import { useCart } from '../CartContext';
import { checkout, sameKeyRetryable, useCheckoutState, type CheckoutState } from '../checkout';
import { EmptyState, ErrorNotice } from '../components/feedback';
import { ProductArt } from '../components/product';

/* ------------------------------------------------------------------ pieces */

function Stepper({ s }: { s: CheckoutState }) {
  const showQueue = s.phase === 'queue' || s.usedQueue;
  const steps: { id: string; label: string }[] = [
    { id: 'review', label: 'Place order' },
    ...(showQueue ? [{ id: 'queue', label: 'Waiting room' }] : []),
    { id: 'pay', label: 'Payment' },
    { id: 'done', label: 'Confirmed' },
  ];
  const current =
    s.phase === 'queue'
      ? 'queue'
      : s.phase === 'pay' || s.phase === 'paying' || s.phase === 'confirming'
        ? 'pay'
        : s.phase === 'success'
          ? 'done'
          : 'review';
  const idx = steps.findIndex((x) => x.id === current);
  const finished = s.phase === 'success';
  return (
    <ol className="stepper" aria-label="Checkout progress">
      {steps.map((step, i) => {
        const done = i < idx || (finished && i === idx);
        return (
          <li
            key={step.id}
            className={done ? 'is-done' : i === idx ? 'is-current' : undefined}
            aria-current={i === idx ? 'step' : undefined}
          >
            <span className="stepper-dot" aria-hidden="true">
              {done ? '✓' : i + 1}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function OrderSummary({ order }: { order: Order }) {
  const items = Array.isArray(order.items) ? order.items : [];
  const subtotal = items.reduce((n, it) => n + it.unitPriceCents * it.qty, 0);
  return (
    <div className="order-summary">
      <ul className="os-items">
        {items.map((it) => (
          <li key={`${it.productId}-${it.sku}`}>
            <ProductArt productId={it.productId} size="xs" />
            <span className="os-name">
              {it.name}
              <span className="muted small"> × {it.qty}</span>
            </span>
            <span className="os-price">{formatINR(it.unitPriceCents * it.qty)}</span>
          </li>
        ))}
      </ul>
      <dl className="summary-rows">
        {subtotal > 0 && (
          <div>
            <dt>Items</dt>
            <dd>{formatINR(subtotal)}</dd>
          </div>
        )}
        {order.discountCents > 0 && (
          <div className="discount">
            <dt>Coupon {order.couponCode ? <code>{order.couponCode}</code> : null}</dt>
            <dd>−{formatINR(order.discountCents)}</dd>
          </div>
        )}
        <div>
          <dt>Delivery</dt>
          <dd className="free">FREE</dd>
        </div>
      </dl>
      <div className="summary-total">
        <span>Total</span>
        <strong>{formatINR(order.totalCents)}</strong>
      </div>
    </div>
  );
}

function UnderTheHood({ s }: { s: CheckoutState }) {
  return (
    <details className="under-hood">
      <summary>Under the hood</summary>
      <dl>
        <div>
          <dt>Checkout Idempotency-Key</dt>
          <dd>
            <code>{s.checkoutKey}</code>
          </dd>
        </div>
        <div>
          <dt>Checkout attempts with this key</dt>
          <dd>{s.checkoutAttempts}</dd>
        </div>
        {s.payKey && (
          <div>
            <dt>Payment Idempotency-Key</dt>
            <dd>
              <code>{s.payKey}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Payment attempts</dt>
          <dd>{s.payAttempts}</dd>
        </div>
        {s.queue?.ticket != null && (
          <div>
            <dt>Queue ticket</dt>
            <dd>
              <code>{s.queue.ticket}</code>
              {s.queuePass ? ' · pass received' : ''}
            </dd>
          </div>
        )}
        {s.order && (
          <div>
            <dt>Order</dt>
            <dd>
              <code>{s.order.id}</code> · {s.order.status}
            </dd>
          </div>
        )}
      </dl>
      <p className="muted small">
        Retries after timeouts and 5xx reuse the same key so the server can answer “already done” instead of creating a
        second order or charge. A new attempt (after a decline or a price change) gets a new key.
      </p>
    </details>
  );
}

function RetryButton({ retryAt, onClick, children }: { retryAt: number | null; onClick: () => void; children: ReactNode }) {
  const now = useNow(retryAt ? 250 : 60_000);
  const wait = retryAt ? Math.ceil((retryAt - now) / 1000) : 0;
  return (
    <button type="button" className="btn btn-sm btn-primary" onClick={onClick} disabled={wait > 0}>
      {wait > 0 ? `Try again in ${wait}s` : children}
    </button>
  );
}

function Working({ title, children, since }: { title: string; children?: ReactNode; since: number | null }) {
  const [mountedAt] = useState(() => Date.now());
  const elapsed = useElapsed(since ?? mountedAt, true);
  return (
    <div className="working" role="status" aria-live="polite">
      <span className="spinner spinner-lg" aria-hidden="true" />
      <h2>{title}</h2>
      {children}
      {elapsed >= 2 && (
        <p className="muted small" aria-hidden="true">
          {elapsed.toFixed(0)}s elapsed
        </p>
      )}
      {elapsed >= 10 && <p className="muted small">The store is very busy. Please keep this page open.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ steps */

function ReviewStep({ s }: { s: CheckoutState }) {
  const cart = useCart();
  const couponId = useId();
  const [coupon, setCoupon] = useState(() => s.couponCode ?? session.get('breakcart.coupon') ?? '');
  const items = cart.cart?.items ?? [];
  const err = s.error;

  const place = (e: FormEvent) => {
    e.preventDefault();
    const code = coupon.trim().toUpperCase();
    session.set('breakcart.coupon', code);
    checkout.begin(code || null);
  };

  let actions: ReactNode = null;
  if (err && s.errorAt === 'resume') {
    actions = s.resumeOrderId ? (
      <RetryButton retryAt={s.retryAt} onClick={() => checkout.resume(s.resumeOrderId!)}>
        Try again
      </RetryButton>
    ) : null;
  } else if (err) {
    switch (err.code) {
      case 'PRICE_CHANGED':
        actions = (
          <>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => checkout.newAttempt()}>
              Accept new price &amp; place order
            </button>
            <Link to="/cart" className="btn btn-sm btn-secondary">
              Review cart
            </Link>
          </>
        );
        break;
      case 'COUPON_EXHAUSTED':
      case 'INVALID_COUPON':
      case 'COUPON_NOT_APPLICABLE':
        actions = (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => checkout.newAttempt({ dropCoupon: true })}>
            Place order without coupon
          </button>
        );
        break;
      case 'OUT_OF_STOCK':
        actions = (
          <Link to="/cart" className="btn btn-sm btn-primary">
            Back to cart
          </Link>
        );
        break;
      case 'SALE_NOT_STARTED':
        actions = (
          <>
            <Link to="/" className="btn btn-sm btn-secondary">
              Back to deals
            </Link>
            <RetryButton retryAt={s.retryAt} onClick={() => checkout.newAttempt()}>
              Try again
            </RetryButton>
          </>
        );
        break;
      default:
        // Transient failures are retried with the same key (the server dedupes); anything
        // the orders service answered is stored under that key, so retry as a new attempt.
        actions = sameKeyRetryable(err) ? (
          <>
            <RetryButton retryAt={s.retryAt} onClick={() => checkout.retryCheckout()}>
              Try again
            </RetryButton>
            <span className="muted small">Same Idempotency-Key — a duplicate order is impossible.</span>
          </>
        ) : (
          <RetryButton retryAt={s.retryAt} onClick={() => checkout.newAttempt()}>
            Try again
          </RetryButton>
        );
    }
  }

  return (
    <div className="checkout-card card">
      {err && (
        <ErrorNotice error={err} context={s.errorAt === 'queue' ? 'queue' : s.errorAt === 'resume' ? 'orders' : 'checkout'}>
          {actions}
        </ErrorNotice>
      )}
      {s.note && <p className="info-note">{s.note}</p>}
      {items.length === 0 && !err ? (
        <EmptyState emoji="🛒" title="Nothing to check out" action={{ to: '/', label: 'Browse deals' }}>
          Add something to your cart first.
        </EmptyState>
      ) : items.length > 0 ? (
        <form onSubmit={place}>
          <h2>Review your order</h2>
          <ul className="os-items">
            {items.map((l) => (
              <li key={l.productId}>
                <ProductArt imageSeed={l.imageSeed} productId={l.productId} size="xs" />
                <span className="os-name">
                  {l.name}
                  <span className="muted small"> × {l.qty}</span>
                </span>
                <span className="os-price">{formatINR(l.unitPriceCents * l.qty)}</span>
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor={couponId}>Coupon code</label>
            <input
              id={couponId}
              className="input"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              placeholder="BIGSALE500"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="summary-total">
            <span>Subtotal</span>
            <strong>{formatINR(cart.cart?.subtotalCents ?? 0)}</strong>
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block">
            {err ? 'Start a new attempt' : 'Place order'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function QueueStep({ s }: { s: CheckoutState }) {
  const q = s.queue;
  const now = useNow(1000);
  if (!q) return null;
  const progress =
    q.initialPosition && q.position != null && q.initialPosition > 0
      ? Math.min(100, Math.max(2, ((q.initialPosition - q.position) / q.initialPosition) * 100))
      : q.admitted
        ? 100
        : 2;
  const waited = (now - q.joinedAt) / 1000;
  return (
    <div className="checkout-card card waiting-room">
      <div className="wr-emoji" aria-hidden="true">
        🎟️
      </div>
      <h2>{q.admitted ? 'It’s your turn!' : 'You’re in the virtual waiting room'}</h2>
      <p className="muted">
        {q.admitted
          ? 'Placing your order now…'
          : 'Thousands of shoppers are checking out at once. To keep the sale fair and the site up, we let people in a few at a time.'}
      </p>
      <p className="sr-only" role="status">
        {q.admitted ? 'It’s your turn — placing your order now.' : ''}
      </p>
      <div className="wr-stats">
        <div>
          <span className="wr-label">Your place in line</span>
          <span className="wr-value">{q.position != null ? `#${formatInt(q.position)}` : q.ticket != null ? '…' : 'Joining…'}</span>
        </div>
        <div>
          <span className="wr-label">Estimated wait</span>
          <span className="wr-value">{q.etaSec != null ? (q.etaSec <= 0 ? 'Any moment' : formatClock(q.etaSec)) : '—'}</span>
        </div>
        <div>
          <span className="wr-label">Waiting for</span>
          <span className="wr-value">{formatDuration(waited)}</span>
        </div>
      </div>
      <div
        className="wr-progress"
        role="progressbar"
        aria-label="Queue progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      {q.lastError && (
        <p className="wr-hiccup" role="status">
          Connection hiccup ({q.lastError.code}) — don’t worry, you keep your place. Retrying…
        </p>
      )}
      <ul className="wr-tips">
        <li>Keep this tab open — we’ll continue automatically when it’s your turn.</li>
        <li>Refreshing won’t lose your place.</li>
        <li>Once admitted, your checkout pass is valid for 2 minutes.</li>
      </ul>
      <p className="muted small">
        Ticket <code>{q.ticket ?? '—'}</code> · polling every 2s
      </p>
    </div>
  );
}

const METHODS: { id: PaymentMethod; title: string; detail: string; icon: string }[] = [
  { id: 'card', title: 'Credit / debit card', detail: 'Visa •••• 4242 (saved)', icon: '💳' },
  { id: 'upi', title: 'UPI', detail: 'shopper@okbank', icon: '📱' },
];

function PayStep({ s }: { s: CheckoutState }) {
  const order = s.order;
  const paying = s.phase === 'paying';
  if (!order) return null;
  const err = s.errorAt === 'payment' || s.errorAt === 'resume' ? s.error : null;

  let actions: ReactNode = null;
  if (err) {
    if (err.code === 'PAYMENT_TIMEOUT') {
      actions = (
        <>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => checkout.checkStatus()}>
            Check payment status
          </button>
          <RetryButton retryAt={s.retryAt} onClick={() => void checkout.pay()}>
            Retry payment (same key)
          </RetryButton>
        </>
      );
    } else if (err.code === 'INVALID_STATE') {
      actions = (
        <Link to={`/orders/${encodeURIComponent(order.id)}`} className="btn btn-sm btn-secondary">
          View order
        </Link>
      );
    } else if (err.code !== 'PAYMENT_DECLINED') {
      actions = (
        <RetryButton retryAt={s.retryAt} onClick={() => void checkout.pay()}>
          Try again
        </RetryButton>
      );
    }
  }

  return (
    <div className="checkout-grid">
      <div className="checkout-card card">
        <h2>Payment</h2>
        <p className="muted small">
          Order <code>#{shortId(order.id)}</code> · stock is reserved for you while you pay.
        </p>
        {err && <ErrorNotice error={err} context="payment">{actions}</ErrorNotice>}
        <fieldset className="methods" disabled={paying}>
          <legend className="sr-only">Payment method</legend>
          {METHODS.map((m) => (
            <label key={m.id} className={`method${s.method === m.id ? ' is-selected' : ''}`}>
              <input
                type="radio"
                name="method"
                value={m.id}
                checked={s.method === m.id}
                onChange={() => checkout.setMethod(m.id)}
              />
              <span className="method-icon" aria-hidden="true">
                {m.icon}
              </span>
              <span>
                <strong>{m.title}</strong>
                <span className="muted small">{m.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          onClick={() => void checkout.pay()}
          disabled={paying}
          aria-busy={paying}
        >
          {paying ? (
            <>
              <span className="spinner spinner-inline" aria-hidden="true" /> Processing payment…
            </>
          ) : (
            `Pay ${formatINR(order.totalCents)}`
          )}
        </button>
        {paying && <PayingHint />}
        <p className="muted small center">🔒 This is a mock payment provider. No real money moves.</p>
      </div>
      <aside className="checkout-card card">
        <h2>Order summary</h2>
        <OrderSummary order={order} />
      </aside>
    </div>
  );
}

function PayingHint() {
  const [since] = useState(() => Date.now());
  const elapsed = useElapsed(since, true);
  if (elapsed < 3) return null;
  return (
    <p className="muted small center" role="status">
      Waiting for your bank… <span aria-hidden="true">{elapsed.toFixed(0)}s</span> — please don’t close this page.
    </p>
  );
}

function ConfirmingStep({ s }: { s: CheckoutState }) {
  const elapsed = useElapsed(s.confirmingSince, true);
  const order = s.order;
  return (
    <div className="checkout-card card">
      <Working title="We’re confirming your payment…" since={s.confirmingSince}>
        <p className="muted">
          Your bank hasn’t given us a final answer yet. <strong>Please don’t pay again</strong> — we’re checking
          automatically.
        </p>
        {order && (
          <p className="small">
            Order <code>#{shortId(order.id)}</code> · {formatINR(order.totalCents)} · status{' '}
            <code>{order.status}</code>
          </p>
        )}
      </Working>
      {s.note && <p className="info-note">{s.note}</p>}
      {elapsed > 60 && order && (
        <p className="info-note">
          This is taking longer than usual. It’s safe to leave — your{' '}
          <Link to={`/orders/${encodeURIComponent(order.id)}`}>order page</Link> will show the result.
        </p>
      )}
      <div className="center">
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => checkout.checkStatus()}>
          Check again now
        </button>
      </div>
    </div>
  );
}

function SuccessStep({ s }: { s: CheckoutState }) {
  const navigate = useNavigate();
  const order = s.order;
  if (!order) return null;
  return (
    <div className="checkout-grid">
      <div className="checkout-card card success">
        <div className="success-emoji" aria-hidden="true">
          🎉
        </div>
        <h2>Payment successful!</h2>
        <p>
          Order <code>#{shortId(order.id)}</code> is confirmed. We’ll let you know when it ships.
        </p>
        <div className="success-actions">
          <Link to={`/orders/${encodeURIComponent(order.id)}`} className="btn btn-primary">
            View order
          </Link>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              checkout.reset();
              navigate('/');
            }}
          >
            Continue shopping
          </button>
        </div>
      </div>
      <aside className="checkout-card card">
        <h2>{plural(order.items?.length ?? 0, 'item')}</h2>
        <OrderSummary order={order} />
      </aside>
    </div>
  );
}

function ClosedStep({ s }: { s: CheckoutState }) {
  const navigate = useNavigate();
  return (
    <div className="checkout-card card">
      <EmptyState emoji="⌛" title="This order can’t be completed">
        {s.closedReason}
      </EmptyState>
      {s.error && <ErrorNotice error={s.error} context="payment" compact />}
      <div className="center">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            checkout.reset();
            navigate('/cart');
          }}
        >
          Back to cart
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function CheckoutPage() {
  useDocumentTitle('Checkout — BreakCart');
  const s = useCheckoutState();
  const [params] = useSearchParams();
  const cart = useCart();
  const orderParam = params.get('order');

  useEffect(() => {
    if (orderParam) checkout.resume(orderParam);
    else checkout.restore();
  }, [orderParam]);

  // The server may have converted the cart into the order; keep the badge honest.
  const { refresh } = cart;
  const lastOrderId = useRef<string | null>(null);
  useEffect(() => {
    const id = s.order?.id ?? null;
    if (id && id !== lastOrderId.current) {
      lastOrderId.current = id;
      void refresh();
    }
  }, [s.order?.id, refresh]);

  // Orders empties the cart once the payment succeeds; pick that up.
  const paidSeen = useRef<string | null>(null);
  useEffect(() => {
    if (s.phase === 'success' && s.order && paidSeen.current !== s.order.id) {
      paidSeen.current = s.order.id;
      void refresh();
    }
  }, [s.phase, s.order, refresh]);

  useEffect(() => {
    if (s.error?.code === 'PRICE_CHANGED') void refresh();
  }, [s.error, refresh]);

  let body: ReactNode;
  switch (s.phase) {
    case 'idle':
    case 'resuming':
      body = (
        <div className="checkout-card card">
          <Working title="Loading your order…" since={null} />
        </div>
      );
      break;
    case 'placing':
      body = (
        <div className="checkout-card card">
          <Working title="Placing your order & reserving stock…" since={null}>
            <p className="muted">Don’t refresh or click back — we’re holding your items.</p>
            {s.note && <p className="info-note">{s.note}</p>}
          </Working>
        </div>
      );
      break;
    case 'queue':
      body = <QueueStep s={s} />;
      break;
    case 'pay':
    case 'paying':
      body = <PayStep s={s} />;
      break;
    case 'confirming':
      body = <ConfirmingStep s={s} />;
      break;
    case 'success':
      body = <SuccessStep s={s} />;
      break;
    case 'closed':
      body = <ClosedStep s={s} />;
      break;
    default:
      body = <ReviewStep s={s} />;
  }

  return (
    <div className="container page checkout">
      <div className="page-head">
        <h1>Checkout</h1>
      </div>
      <Stepper s={s} />
      {body}
      <UnderTheHood s={s} />
    </div>
  );
}
