import { Link } from 'react-router';
import { shopApi } from '../../api/shop';
import type { Order } from '../../api/types';
import { formatDateTime, formatINR, plural } from '../../lib/format';
import { shortId } from '../../lib/ids';
import { useAsync, useDocumentTitle } from '../../lib/hooks';
import { EmptyState, ErrorNotice, Loading } from '../components/feedback';
import { canPay, OrderStatusPill } from '../components/order';
import { ProductArt } from '../components/product';

function OrderCard({ o }: { o: Order }) {
  const items = Array.isArray(o.items) ? o.items : [];
  const first = items[0];
  return (
    <li className="order-card card">
      <Link to={`/orders/${encodeURIComponent(o.id)}`} className="order-card-link">
        <div className="order-card-art">
          {first ? <ProductArt productId={first.productId} size="xs" /> : <span aria-hidden="true">📦</span>}
        </div>
        <div className="order-card-main">
          <div className="order-card-top">
            <strong>#{shortId(o.id)}</strong>
            <OrderStatusPill status={o.status} />
          </div>
          <div className="muted small">
            {formatDateTime(o.createdAt)} · {plural(items.reduce((n, it) => n + it.qty, 0), 'item')}
          </div>
          <div className="order-card-items">{items.map((it) => it.name).join(', ')}</div>
        </div>
        <div className="order-card-total">{formatINR(o.totalCents)}</div>
      </Link>
      {canPay(o) && (
        <Link to={`/checkout?order=${encodeURIComponent(o.id)}`} className="btn btn-sm btn-primary order-card-pay">
          Pay now
        </Link>
      )}
    </li>
  );
}

export default function OrdersPage() {
  useDocumentTitle('Your orders — BreakCart');
  const res = useAsync(async (signal) => {
    const { data } = await shopApi.orders(signal);
    const items = Array.isArray(data?.items) ? data.items : [];
    return [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, []);

  return (
    <div className="container page narrow">
      <div className="page-head">
        <h1>Your orders</h1>
        <button type="button" className="btn btn-sm btn-secondary" onClick={res.reload} disabled={res.loading}>
          {res.loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {res.error && <ErrorNotice error={res.error} context="orders" onRetry={res.reload} />}
      {res.loading && !res.data && <Loading label="Loading your orders" startedAt={res.startedAt} />}
      {res.data &&
        (res.data.length === 0 ? (
          <EmptyState emoji="📦" title="No orders yet" action={{ to: '/', label: 'Start shopping' }}>
            Just placed one? It can take a moment to appear here.
          </EmptyState>
        ) : (
          <ul className={`orders${res.loading ? ' is-refetching' : ''}`}>
            {res.data.map((o) => (
              <OrderCard key={o.id} o={o} />
            ))}
          </ul>
        ))}
    </div>
  );
}
