import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, toApiError } from '../../api/http';
import { shopApi } from '../../api/shop';
import { rememberProducts } from '../../lib/art';
import { formatInt } from '../../lib/format';
import { useAsync, useDocumentTitle } from '../../lib/hooks';
import { useCart } from '../CartContext';
import { ErrorNotice, Loading } from '../components/feedback';
import { PriceBlock, ProductArt, ProductRow, QtyStepper, Stars, StockMeter } from '../components/product';

/** Flash deals are capped per customer by the cart service (2 units). */
const DEAL_LIMIT_PER_CUSTOMER = 2;

export default function ProductPage() {
  const { id = '' } = useParams();
  const cart = useCart();
  const res = useAsync(
    async (signal) => {
      const { data } = await shopApi.product(id, signal);
      const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
      rememberProducts([data, ...recommendations]);
      return { ...data, recommendations, degraded: Array.isArray(data?.degraded) ? data.degraded : [] };
    },
    [id],
  );
  const p = res.data;
  useDocumentTitle(p ? `${p.name} — BreakCart` : 'BreakCart');

  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<ApiError | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  useEffect(() => {
    setQty(1);
    setAddError(null);
    setAdded(null);
  }, [id]);

  if (!p) {
    return (
      <div className="container page">
        {res.error ? (
          <ErrorNotice error={res.error} onRetry={res.reload} />
        ) : (
          <Loading label="Loading product" startedAt={res.startedAt} />
        )}
      </div>
    );
  }

  const available = p.stock ? Math.max(0, p.stock.available) : null;
  const soldOut = available === 0;
  const perCustomer = p.isDeal ? DEAL_LIMIT_PER_CUSTOMER : 10;
  const maxQty = Math.max(1, Math.min(perCustomer, available ?? perCustomer));

  const addToCart = async () => {
    setAdding(true);
    setAddError(null);
    setAdded(null);
    try {
      await cart.add(p.id, qty);
      setAdded(qty);
    } catch (e) {
      setAddError(toApiError(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="container page">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/">Home</Link> <span aria-hidden="true">›</span>{' '}
        <Link to={`/c/${encodeURIComponent(p.category)}`}>{p.category}</Link> <span aria-hidden="true">›</span>{' '}
        <span>{p.name}</span>
      </nav>
      {res.error && <ErrorNotice error={res.error} onRetry={res.reload} compact />}

      <div className={`pdp${res.loading ? ' is-refetching' : ''}`}>
        <div className="pdp-art">
          <ProductArt imageSeed={p.imageSeed} category={p.category} size="lg" label={`Illustration of ${p.name}`}>
            {soldOut && <span className="soldout">Sold out</span>}
          </ProductArt>
        </div>

        <div className="pdp-info">
          <div className="pdp-brand">{p.brand}</div>
          <h1 className="pdp-name">{p.name}</h1>
          <Stars rating={p.rating} reviewCount={p.reviewCount} />
          <PriceBlock p={p} size="lg" />
          <p className="pdp-meta">
            Inclusive of all taxes · SKU <code>{p.sku}</code> · price v{p.priceVersion}
          </p>

          <div className="pdp-stock">
            {p.stock ? (
              <>
                <StockMeter stock={p.stock} />
                <p className="muted small">
                  {soldOut
                    ? 'Every unit of this deal has been claimed.'
                    : `${formatInt(p.stock.available)} of ${formatInt(p.stock.total)} units still available.`}
                </p>
              </>
            ) : (
              <p className="in-stock">✓ In stock</p>
            )}
          </div>

          <div className="pdp-buy">
            <QtyStepper value={qty} max={maxQty} onChange={setQty} disabled={soldOut || adding} label="Quantity" />
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={addToCart}
              disabled={soldOut || adding}
              aria-busy={adding}
            >
              {soldOut ? 'Sold out' : adding ? 'Adding…' : 'Add to cart'}
            </button>
          </div>
          {p.isDeal && !soldOut && (
            <p className="muted small">Limit {DEAL_LIMIT_PER_CUSTOMER} per customer on flash deals.</p>
          )}
          <div aria-live="polite">
            {added != null && (
              <p className="added-ok">
                ✓ Added {added} to your cart. <Link to="/cart">Go to cart →</Link>
              </p>
            )}
          </div>
          {addError && <ErrorNotice error={addError} context="cart" compact />}

          <ul className="perks">
            <li>🚚 Free delivery on sale orders</li>
            <li>↩️ 7-day easy returns</li>
            <li>🔒 Secure payments (card / UPI)</li>
          </ul>

          {p.description && (
            <section className="pdp-desc">
              <h2>About this item</h2>
              <p>{p.description}</p>
            </section>
          )}
        </div>
      </div>

      <ProductRow
        title="Customers also viewed"
        products={p.recommendations}
        note={
          p.degraded.length > 0 ? (
            <span className="muted">Some suggestions are unavailable right now ({p.degraded.join(', ')}).</span>
          ) : undefined
        }
      />
    </div>
  );
}
