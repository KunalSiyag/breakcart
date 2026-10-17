import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, toApiError } from '../../api/http';
import type { CartLine } from '../../api/types';
import { formatINR, plural } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { session } from '../../lib/storage';
import { useCart } from '../CartContext';
import { checkout, useCheckoutState } from '../checkout';
import { EmptyState, ErrorNotice, Loading } from '../components/feedback';
import { ProductArt, QtyStepper } from '../components/product';

const COUPON_KEY = 'breakcart.coupon';
const COUPON_HINT = 'BIGSALE500';

function Line({
  line,
  busy,
  onQty,
  onRemove,
}: {
  line: CartLine;
  busy: boolean;
  onQty: (qty: number) => void;
  onRemove: () => void;
}) {
  return (
    <li className={`cart-line${busy ? ' is-busy' : ''}`}>
      <Link to={`/p/${line.productId}`} className="cart-line-art" tabIndex={-1} aria-hidden="true">
        <ProductArt imageSeed={line.imageSeed} productId={line.productId} size="xs" />
      </Link>
      <div className="cart-line-info">
        <Link to={`/p/${line.productId}`} className="cart-line-name">
          {line.name}
        </Link>
        <div className="muted small">
          SKU <code>{line.sku}</code> · {formatINR(line.unitPriceCents)} each
        </div>
        <div className="cart-line-actions">
          <QtyStepper value={line.qty} max={10} onChange={onQty} disabled={busy} label={`Quantity of ${line.name}`} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove} disabled={busy}>
            Remove
          </button>
        </div>
      </div>
      <div className="cart-line-total">{formatINR(line.unitPriceCents * line.qty)}</div>
    </li>
  );
}

export default function CartPage() {
  useDocumentTitle('Your cart — BreakCart');
  const cart = useCart();
  const navigate = useNavigate();
  const co = useCheckoutState();
  const couponId = useId();
  const [coupon, setCoupon] = useState(() => session.get(COUPON_KEY) ?? '');
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [mountedAt] = useState(() => Date.now());

  const { refresh } = cart;
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (productId: number, fn: () => Promise<unknown>) => {
    setBusyLine(productId);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(toApiError(e));
      void refresh();
    } finally {
      setBusyLine(null);
    }
  };

  const clearAll = async () => {
    setClearing(true);
    setError(null);
    try {
      await cart.clear();
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setClearing(false);
    }
  };

  const placeOrder = (e: FormEvent) => {
    e.preventDefault();
    const code = coupon.trim().toUpperCase();
    session.set(COUPON_KEY, code);
    checkout.begin(code || null);
    navigate('/checkout');
  };

  const items = cart.cart?.items ?? [];
  const busy = busyLine != null || clearing;
  const inProgress = ['placing', 'queue', 'paying', 'confirming', 'resuming'].includes(co.phase);

  if (!cart.cart) {
    return (
      <div className="container page">
        <h1>Your cart</h1>
        {cart.error ? (
          <ErrorNotice error={cart.error} context="cart" onRetry={() => void refresh()} />
        ) : (
          <Loading label="Loading your cart" startedAt={mountedAt} />
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="container page">
        <h1 className="sr-only">Your cart</h1>
        {error && <ErrorNotice error={error} context="cart" />}
        <EmptyState emoji="🛒" title="Your cart is empty" action={{ to: '/', label: 'Browse flash deals' }}>
          The best deals go fast on sale day — add something before it’s gone!
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="container page">
      <div className="page-head">
        <h1>Your cart</h1>
        <p className="muted">{plural(cart.count, 'item')}</p>
      </div>
      {error && <ErrorNotice error={error} context="cart" />}
      {cart.error && <ErrorNotice error={cart.error} context="cart" compact onRetry={() => void refresh()} />}
      {inProgress && (
        <p className="info-note">
          You have a checkout in progress. <Link to="/checkout">Continue it →</Link>
        </p>
      )}

      <div className="cart-layout">
        <ul className="cart-lines" aria-label="Items in your cart">
          {items.map((line) => (
            <Line
              key={line.productId}
              line={line}
              busy={busy}
              onQty={(qty) => void mutate(line.productId, () => cart.setQty(line, qty))}
              onRemove={() => void mutate(line.productId, () => cart.remove(line.productId))}
            />
          ))}
        </ul>

        <form className="summary card" onSubmit={placeOrder} aria-label="Order summary">
          <h2>Order summary</h2>
          <dl className="summary-rows">
            <div>
              <dt>Subtotal</dt>
              <dd>{formatINR(cart.cart.subtotalCents)}</dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd className="free">FREE</dd>
            </div>
          </dl>

          <div className="field">
            <label htmlFor={couponId}>Coupon code</label>
            <div className="coupon-row">
              <input
                id={couponId}
                className="input"
                value={coupon}
                onChange={(e) => setCoupon(e.target.value)}
                placeholder="Enter coupon"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={`${couponId}-hint`}
              />
              {coupon.trim().toUpperCase() !== COUPON_HINT && (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setCoupon(COUPON_HINT)}>
                  Use {COUPON_HINT}
                </button>
              )}
            </div>
            <p id={`${couponId}-hint`} className="muted small">
              Hint: <code>{COUPON_HINT}</code> — limited redemptions. The discount is applied when you place the order.
            </p>
          </div>

          <div className="summary-total">
            <span>Total</span>
            <strong>{formatINR(cart.cart.subtotalCents)}</strong>
          </div>
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || items.length === 0}>
            Place order
          </button>
          <button type="button" className="btn btn-ghost btn-sm btn-block" onClick={clearAll} disabled={busy}>
            {clearing ? 'Clearing…' : 'Clear cart'}
          </button>
        </form>
      </div>
    </div>
  );
}
