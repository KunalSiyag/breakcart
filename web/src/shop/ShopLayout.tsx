import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, ScrollRestoration, useLocation, useNavigate, useSearchParams } from 'react-router';
import { shopApi } from '../api/shop';
import type { Category } from '../api/types';
import { useAsync } from '../lib/hooks';
import { CartProvider, useCart } from './CartContext';
import { useCheckoutState } from './checkout';
import { RequestInspector } from './components/RequestInspector';
import { SaleBanner } from './components/SaleBanner';
import { SaleProvider } from './SaleContext';

let categoriesCache: Category[] | null = null;

/** Inside Mission Control's preview frame, ops links open in the full window instead of nesting. */
const opsTarget = (() => {
  try {
    return window.self !== window.top ? '_top' : undefined;
  } catch {
    return '_top';
  }
})();

function Logo() {
  return (
    <Link to="/" className="logo" aria-label="BreakCart home">
      <svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="var(--brand)" />
        <path
          d="M14 18h6l5 22h21l5-15H23"
          fill="none"
          stroke="#fff"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="28" cy="48" r="3.6" fill="#fff" />
        <circle cx="43" cy="48" r="3.6" fill="#fff" />
        <path d="M37 9l-6 10h6l-4 8 9-12h-6l3-6z" fill="#ffd23f" />
      </svg>
      <span className="logo-word">
        Break<span>Cart</span>
      </span>
    </Link>
  );
}

function SearchBox() {
  const location = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const urlQ = location.pathname === '/search' ? (params.get('q') ?? '') : '';
  const [q, setQ] = useState(urlQ);
  useEffect(() => setQ(urlQ), [urlQ]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <form className="search" role="search" onSubmit={submit}>
      <label htmlFor="site-search" className="sr-only">
        Search products
      </label>
      <input
        id="site-search"
        type="search"
        placeholder="Search for phones, shoes, headphones…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      <button type="submit" className="search-btn" aria-label="Search">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
    </form>
  );
}

function CartLink() {
  const { count } = useCart();
  return (
    <NavLink to="/cart" className="nav-link nav-cart">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path
          d="M3 4h2.2l2.2 10.2h10.4L20 7H6.3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="9.5" cy="19" r="1.6" fill="currentColor" />
        <circle cx="16.5" cy="19" r="1.6" fill="currentColor" />
      </svg>
      <span className="nav-label">Cart</span>
      {count > 0 && (
        <span className="cart-count">
          {count > 99 ? '99+' : count}
          <span className="sr-only"> item{count === 1 ? '' : 's'}</span>
        </span>
      )}
    </NavLink>
  );
}

/** A small reminder when a checkout is running in the background (queue, payment). */
function CheckoutBeacon() {
  const s = useCheckoutState();
  const { pathname } = useLocation();
  if (pathname === '/checkout') return null;
  let text: string | null = null;
  if (s.phase === 'queue') text = s.queue?.position != null ? `🎟️ In line · #${s.queue.position}` : '🎟️ In line';
  else if (s.phase === 'confirming') text = '⏳ Confirming payment';
  else if (s.phase === 'pay' || s.phase === 'paying') text = '💳 Finish payment';
  else if (s.phase === 'placing') text = '⏳ Placing order';
  if (!text) return null;
  return (
    <Link to="/checkout" className="beacon">
      {text}
    </Link>
  );
}

function CategoryBar() {
  const { data } = useAsync(async (signal) => {
    if (categoriesCache) return categoriesCache;
    const { data: res } = await shopApi.categories(signal);
    const items = Array.isArray(res?.items) ? res.items : [];
    if (items.length) categoriesCache = items;
    return items;
  }, []);
  if (!data || data.length === 0) return null;
  return (
    <nav className="catbar" aria-label="Categories">
      <div className="container catbar-inner">
        {data.map((c) => (
          <NavLink key={c.name} to={`/c/${encodeURIComponent(c.name)}`} className="cat-chip" title={`${c.count} products`}>
            {c.name}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

function Header() {
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Logo />
        <SearchBox />
        <nav className="topnav" aria-label="Account">
          <CheckoutBeacon />
          <NavLink to="/orders" className="nav-link">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinejoin="round"
              />
              <path d="M9 8h6M9 12h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            <span className="nav-label">Orders</span>
          </NavLink>
          <CartLink />
          <Link
            to="/live"
            className="warroom-link mission-link"
            target={opsTarget}
            title="Mission Control — the store and the system behind it, live"
          >
            <span className="mission-icon" aria-hidden="true">
              ◎
            </span>
            <span className="nav-label">Mission Control</span>
          </Link>
          <Link to="/warroom" className="warroom-link" target={opsTarget}>
            <span className="warroom-dot" aria-hidden="true" />
            War Room
          </Link>
        </nav>
      </div>
    </header>
  );
}

export default function ShopLayout() {
  useEffect(() => {
    document.documentElement.dataset.area = 'shop';
  }, []);
  return (
    <SaleProvider>
      <CartProvider>
        <div className="shop">
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <Header />
          <SaleBanner />
          <CategoryBar />
          <main id="main" className="shop-main">
            <Outlet />
          </main>
          <footer className="shop-footer">
            <div className="container footer-inner">
              <p>
                <strong>BreakCart</strong> is a learning lab: this store is built to break on sale day. Every bug is
                intentional — and switchable.
              </p>
              <p className="footer-links">
                <Link to="/warroom" target={opsTarget}>
                  War Room
                </Link>
                <Link to="/live" target={opsTarget}>
                  Mission Control
                </Link>
                <Link to="/labs" target={opsTarget}>
                  Labs
                </Link>
                <Link to="/orders">Your orders</Link>
              </p>
            </div>
          </footer>
          <RequestInspector />
        </div>
        <ScrollRestoration />
      </CartProvider>
    </SaleProvider>
  );
}
