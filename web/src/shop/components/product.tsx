import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router';
import type { ProductCard, StockInfo } from '../../api/types';
import { knownProduct, productArt } from '../../lib/art';
import { discountPct, formatINR, formatInt } from '../../lib/format';

/**
 * Pass `imageSeed` + `category` when known (product cards). Cart lines and order items
 * pass `productId` and fall back to what we remembered from earlier product cards.
 */
export function ProductArt({
  imageSeed,
  category,
  productId,
  size = 'md',
  children,
  label,
}: {
  imageSeed?: number;
  category?: string | null;
  productId?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  children?: ReactNode;
  label?: string;
}) {
  const known = productId != null && (imageSeed == null || category == null) ? knownProduct(productId) : null;
  const art = productArt(imageSeed ?? known?.imageSeed ?? productId ?? 0, category ?? known?.category ?? null);
  const style = { background: art.background } as CSSProperties;
  return (
    <div className={`art art-${size}`} style={style} role={label ? 'img' : undefined} aria-label={label}>
      <span className="art-emoji" style={{ transform: `rotate(${art.rotateDeg}deg)` }} aria-hidden="true">
        {art.emoji}
      </span>
      {children}
    </div>
  );
}

export function Stars({ rating, reviewCount }: { rating: number; reviewCount: number }) {
  if (!Number.isFinite(rating) || rating <= 0) return null;
  return (
    <span
      className="rating"
      role="img"
      aria-label={`Rated ${rating.toFixed(1)} out of 5 by ${formatInt(reviewCount)} shoppers`}
    >
      <span className="rating-pill" aria-hidden="true">
        {rating.toFixed(1)} ★
      </span>
      <span className="rating-count" aria-hidden="true">
        ({formatInt(reviewCount)})
      </span>
    </span>
  );
}

export function PriceBlock({ p, size = 'md' }: { p: ProductCard; size?: 'md' | 'lg' }) {
  const off = discountPct(p.priceCents, p.mrpCents);
  const upcomingDeal = p.isDeal && !p.dealLive && p.dealPriceCents != null && p.dealPriceCents < p.priceCents;
  return (
    <div className={`price price-${size}`}>
      <div className="price-row">
        <span className="price-now">{formatINR(p.priceCents)}</span>
        {p.mrpCents > p.priceCents && (
          <span className="price-mrp">
            <span className="sr-only">MRP </span>
            <s>{formatINR(p.mrpCents)}</s>
          </span>
        )}
        {off > 0 && <span className="price-off">{off}% off</span>}
      </div>
      {upcomingDeal && (
        <div className="price-upcoming">
          ⚡ Deal price <strong>{formatINR(p.dealPriceCents)}</strong> when the sale starts
        </div>
      )}
    </div>
  );
}

export function StockMeter({ stock, compact = false }: { stock: StockInfo; compact?: boolean }) {
  const total = Math.max(0, stock.total);
  const available = Math.max(0, stock.available);
  const claimed = total > 0 ? Math.min(100, Math.max(0, Math.round(((total - available) / total) * 100))) : 100;
  const soldOut = available <= 0;
  const hot = !soldOut && claimed >= 75;
  return (
    <div className={`stock${soldOut ? ' is-out' : ''}${hot ? ' is-hot' : ''}${compact ? ' stock-compact' : ''}`}>
      <div
        className="stock-bar"
        role="progressbar"
        aria-label="Share of deal stock already claimed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={claimed}
      >
        <span className="stock-fill" style={{ width: `${claimed}%` }} />
      </div>
      <div className="stock-label">
        <span>{soldOut ? 'All claimed' : `${claimed}% claimed`}</span>
        <span className="stock-left">
          {soldOut ? 'Sold out' : available <= 10 ? `Only ${available} left!` : `${formatInt(available)} left`}
        </span>
      </div>
    </div>
  );
}

export function ProductTile({ p, stock, compact = false }: { p: ProductCard; stock?: StockInfo | null; compact?: boolean }) {
  const soldOut = stock != null && stock.available <= 0;
  const off = discountPct(p.priceCents, p.mrpCents);
  return (
    <article className={`tile${soldOut ? ' is-soldout' : ''}${compact ? ' tile-compact' : ''}`}>
      <Link to={`/p/${p.id}`} className="tile-link">
        <ProductArt imageSeed={p.imageSeed} category={p.category} size={compact ? 'sm' : 'md'}>
          <div className="art-badges">
            {off > 0 && <span className="badge badge-off">−{off}%</span>}
            {p.isDeal && <span className="badge badge-deal">{p.dealLive ? '⚡ Deal' : 'Deal soon'}</span>}
          </div>
          {soldOut && <span className="soldout">Sold out</span>}
        </ProductArt>
        <div className="tile-body">
          <div className="tile-brand">{p.brand}</div>
          <h3 className="tile-name">{p.name}</h3>
          {!compact && <Stars rating={p.rating} reviewCount={p.reviewCount} />}
          <PriceBlock p={p} />
          {stock && <StockMeter stock={stock} compact={compact} />}
        </div>
      </Link>
    </article>
  );
}

export function ProductGrid({ children, dense = false }: { children: ReactNode; dense?: boolean }) {
  return <div className={`grid${dense ? ' grid-dense' : ''}`}>{children}</div>;
}

export function ProductRow({ title, products, note }: { title: string; products: ProductCard[]; note?: ReactNode }) {
  if (!products.length && !note) return null;
  return (
    <section className="row-section" aria-label={title}>
      <div className="section-head">
        <h2>{title}</h2>
        {note}
      </div>
      {products.length > 0 && (
        <div className="row-scroll">
          {products.map((p) => (
            <ProductTile key={p.id} p={p} compact />
          ))}
        </div>
      )}
    </section>
  );
}

export function QtyStepper({
  value,
  min = 1,
  max = 10,
  onChange,
  disabled = false,
  label,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  label: string;
}) {
  const clampQty = (v: number) => Math.max(min, Math.min(max, Math.floor(v) || min));
  return (
    <div className="qty" role="group" aria-label={label}>
      <button
        type="button"
        className="qty-btn"
        onClick={() => onChange(clampQty(value - 1))}
        disabled={disabled || value <= min}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <input
        className="qty-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        aria-label="Quantity"
        onChange={(e) => onChange(clampQty(Number(e.target.value)))}
      />
      <button
        type="button"
        className="qty-btn"
        onClick={() => onChange(clampQty(value + 1))}
        disabled={disabled || value >= max}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
}
