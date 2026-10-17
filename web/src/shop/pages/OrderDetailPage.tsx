import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, isAbortError, sleep, toApiError } from '../../api/http';
import { shopApi } from '../../api/shop';
import type { Order } from '../../api/types';
import { formatDateTime, formatINR } from '../../lib/format';
import { shortId } from '../../lib/ids';
import { useDocumentTitle } from '../../lib/hooks';
import { ErrorNotice, Loading } from '../components/feedback';
import { ProductArt } from '../components/product';
import { canPay, OrderStatusPill } from '../components/order';

const LIVE_STATUSES = new Set(['CREATED', 'PAYMENT_IN_PROGRESS', 'PAYMENT_PENDING']);

/**
 * Loads the order and keeps polling while it is still settling. A 404 right after
 * checkout is retried a few times: with the replica-read bug the order genuinely
 * isn't visible yet — exactly what the customer would experience.
 */
function useOrder(id: string) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notFoundRetries, setNotFoundRetries] = useState(0);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    setOrder(null);
    setError(null);
    setNotFoundRetries(0);
    setStartedAt(Date.now());
    (async () => {
      let misses = 0;
      let failures = 0;
      for (;;) {
        try {
          const { data } = await shopApi.order(id, ctrl.signal);
          if (ctrl.signal.aborted) return;
          failures = 0;
          setOrder(data.order);
          setError(null);
          if (!LIVE_STATUSES.has(data.order.status)) return;
          await sleep(3000, ctrl.signal);
        } catch (e) {
          if (ctrl.signal.aborted || isAbortError(e)) return;
          const err = toApiError(e);
          setError(err);
          if (err.code === 'NOT_FOUND' && misses < 5) {
            misses += 1;
            setNotFoundRetries(misses);
            await sleep(1500 * misses, ctrl.signal).catch(() => undefined);
            continue;
          }
          failures += 1;
          // Keep refreshing a settling order through transient errors, but stop on a dead end.
          if (failures > 4 || err.code === 'NOT_FOUND') return;
          await sleep(3000 * failures, ctrl.signal).catch(() => undefined);
        }
        if (ctrl.signal.aborted) return;
      }
    })();
    return () => ctrl.abort();
  }, [id, nonce]);

  return { order, error, notFoundRetries, startedAt, reload: () => setNonce((n) => n + 1) };
}

export default function OrderDetailPage() {
  const { id = '' } = useParams();
  const { order, error, notFoundRetries, startedAt, reload } = useOrder(id);
  useDocumentTitle(`Order #${shortId(id)} — BreakCart`);
  const prevStatus = useRef<string | null>(null);
  const [justChanged, setJustChanged] = useState(false);

  useEffect(() => {
    if (!order) return;
    if (prevStatus.current && prevStatus.current !== order.status) setJustChanged(true);
    prevStatus.current = order.status;
  }, [order]);

  return (
    <div className="container page narrow">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/orders">Your orders</Link> <span aria-hidden="true">›</span> <span>#{shortId(id)}</span>
      </nav>

      {!order && error && (
        <ErrorNotice error={error} context="orders" onRetry={reload}>
          {error.code === 'NOT_FOUND' && notFoundRetries > 0 && notFoundRetries < 5 && (
            <span className="muted small">Checking again… (attempt {notFoundRetries + 1})</span>
          )}
        </ErrorNotice>
      )}
      {!order && !error && <Loading label="Loading order" startedAt={startedAt} />}

      {order && (
        <article className="card order-detail">
          <header className="order-detail-head">
            <div>
              <h1>Order #{shortId(order.id)}</h1>
              <p className="muted small">
                Placed {formatDateTime(order.createdAt)} · updated {formatDateTime(order.updatedAt)}
              </p>
            </div>
            <OrderStatusPill status={order.status} />
          </header>

          {justChanged && order.status === 'PAID' && (
            <p className="added-ok" role="status">
              ✓ Payment confirmed!
            </p>
          )}
          {LIVE_STATUSES.has(order.status) && (
            <p className="info-note" role="status">
              <span className="spinner spinner-inline" aria-hidden="true" /> We’re confirming this order with the payment
              provider. This page updates automatically — please don’t pay again.
            </p>
          )}
          {order.failureReason && (
            <p className="notice-inline">
              <strong>Reason:</strong> {order.failureReason}
            </p>
          )}
          {error && <ErrorNotice error={error} context="orders" compact onRetry={reload} />}

          <ul className="os-items">
            {(order.items ?? []).map((it) => (
              <li key={`${it.productId}-${it.sku}`}>
                <ProductArt productId={it.productId} size="xs" />
                <span className="os-name">
                  <Link to={`/p/${it.productId}`}>{it.name}</Link>
                  <span className="muted small">
                    {' '}
                    × {it.qty} · {formatINR(it.unitPriceCents)} each
                  </span>
                </span>
                <span className="os-price">{formatINR(it.unitPriceCents * it.qty)}</span>
              </li>
            ))}
          </ul>
          <dl className="summary-rows">
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

          <div className="order-detail-actions">
            {canPay(order) && (
              <Link to={`/checkout?order=${encodeURIComponent(order.id)}`} className="btn btn-primary">
                Pay now
              </Link>
            )}
            <Link to="/orders" className="btn btn-secondary">
              All orders
            </Link>
          </div>
          <p className="muted small">
            Order id <code>{order.id}</code>
          </p>
        </article>
      )}
    </div>
  );
}
