import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, NavLink, Outlet, ScrollRestoration } from 'react-router';
import { relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import '../styles/ops.css';
import { ToastProvider } from './components/Toasts';
import { useOps, useOpsConnection, type SseStatus } from './store';

const SSE_LABEL: Record<SseStatus, { text: string; cls: string; icon: string }> = {
  idle: { text: 'Live feed off', cls: 'conn-off', icon: '○' },
  connecting: { text: 'Connecting…', cls: 'conn-wait', icon: '◌' },
  open: { text: 'Live', cls: 'conn-live', icon: '●' },
  reconnecting: { text: 'Reconnecting…', cls: 'conn-wait', icon: '▲' },
};

function ConnectionStatus() {
  const sse = useOps((s) => s.sse);
  const reachable = useOps((s) => s.reachable);
  const meta = SSE_LABEL[sse];
  return (
    <div className="conn" aria-live="polite">
      <span
        className={`conn-item ${reachable === false ? 'conn-down' : reachable ? 'conn-live' : 'conn-wait'}`}
        title="Control plane HTTP API (/control)"
      >
        <span aria-hidden="true">{reachable === false ? '■' : reachable ? '●' : '◌'}</span> API{' '}
        {reachable === false ? 'down' : reachable ? 'ok' : '…'}
      </span>
      <span className={`conn-item ${meta.cls}`} title="Server-sent events stream (/control/events)">
        <span aria-hidden="true" className={sse === 'open' ? 'pulse-dot' : undefined}>
          {meta.icon}
        </span>{' '}
        {meta.text}
      </span>
    </div>
  );
}

function UnreachableBanner() {
  const reachable = useOps((s) => s.reachable);
  const lastError = useOps((s) => s.lastError);
  const lastOkAt = useOps((s) => s.lastOkAt);
  const now = useNow(5000);
  if (reachable !== false) return null;
  return (
    <div className="ops-banner" role="alert">
      <strong>
        <span aria-hidden="true">■</span> Control plane unreachable
      </strong>
      <span>
        The war room can’t reach <code>/control</code>. Is the stack running (<code>docker compose up</code>)? Retrying
        with back-off{lastOkAt ? ` · last data ${relativeTime(lastOkAt, now)}` : ''}.
      </span>
      {lastError && <code className="ops-banner-err">{lastError}</code>}
    </div>
  );
}

export default function OpsLayout() {
  useOpsConnection();
  useEffect(() => {
    document.documentElement.dataset.area = 'ops';
  }, []);

  // The sticky header's real height (it wraps on narrow screens), for scroll-padding-top in ops.css:
  // keyboard focus and in-page links must not land underneath it.
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--ops-header-h', `${el.offsetHeight}px`);
    set();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(set);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty('--ops-header-h');
    };
  }, []);

  return (
    <ToastProvider>
      <div className="ops">
        <a href="#ops-main" className="skip-link">
          Skip to content
        </a>
        <header ref={headerRef} className="ops-header">
          <Link to="/warroom" className="ops-logo" aria-label="BreakCart War Room">
            <span className="ops-logo-mark" aria-hidden="true">
              ⚡
            </span>
            <span>
              BreakCart <b>War Room</b>
            </span>
          </Link>
          <nav className="ops-nav" aria-label="Ops">
            <NavLink to="/warroom">War Room</NavLink>
            <NavLink to="/live">Mission Control</NavLink>
            <NavLink to="/labs">Labs</NavLink>
            <Link to="/">Storefront ↗</Link>
          </nav>
          <ConnectionStatus />
        </header>
        <UnreachableBanner />
        <main id="ops-main" className="ops-main">
          <Outlet />
        </main>
      </div>
      <ScrollRestoration />
    </ToastProvider>
  );
}
