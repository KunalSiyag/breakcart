import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { local } from '../../lib/storage';
import { Panel } from './ui';

/**
 * "The store, live": the real storefront in an iframe (same origin), so you feel what a
 * customer feels while the system map shows why. Quick-nav buttons navigate the frame;
 * whatever the customer clicks inside it is tracked in the address strip.
 */

type Device = 'desktop' | 'phone';

const DEVICE_KEY = 'breakcart.mc.device.v1';

const QUICK_NAV: { label: string; path: string; hint: string }[] = [
  { label: 'Home', path: '/', hint: 'Deals and the sale countdown' },
  { label: 'Hottest deal', path: '/p/1', hint: 'Product 1 — the most contended SKU' },
  { label: '₹1 box', path: '/p/12', hint: 'Product 12 — 20 units for the whole crowd' },
  { label: 'Cart', path: '/cart', hint: 'This browser’s cart' },
  { label: 'Orders', path: '/orders', hint: 'This browser’s orders' },
];

/** True when this page is itself inside a frame (e.g. Mission Control opened from the preview). */
export function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function framePath(frame: HTMLIFrameElement | null): string | null {
  try {
    const loc = frame?.contentWindow?.location;
    if (!loc || loc.href === 'about:blank') return null;
    return `${loc.pathname}${loc.search}`;
  } catch {
    return null;
  }
}

export function StorePreview() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [device, setDevice] = useState<Device>(() => (local.get(DEVICE_KEY) === 'phone' ? 'phone' : 'desktop'));
  const [path, setPath] = useState('/');
  const [loading, setLoading] = useState(true);

  // Follow the customer's in-app navigation (pushState doesn't fire load events).
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = framePath(frame.current);
      if (p) setPath((cur) => (cur === p ? cur : p));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Mirror Mission Control's "Pause motion" (data-motion on <html>) into the same-origin frame,
  // so the storefront's own animations stop too.
  const syncMotion = () => {
    try {
      const doc = frame.current?.contentDocument;
      if (!doc) return;
      const v = document.documentElement.getAttribute('data-motion');
      if (v) doc.documentElement.setAttribute('data-motion', v);
      else doc.documentElement.removeAttribute('data-motion');
    } catch {
      /* not same-origin (shouldn't happen) */
    }
  };
  useEffect(() => {
    const obs = new MutationObserver(syncMotion);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => obs.disconnect();
  }, []);

  const pickDevice = (d: Device) => {
    setDevice(d);
    local.set(DEVICE_KEY, d);
  };

  const go = (p: string) => {
    setLoading(true);
    setPath(p);
    const el = frame.current;
    try {
      // replace(): don't grow this tab's history with every quick-nav click
      el?.contentWindow?.location.replace(p);
    } catch {
      if (el) el.src = p;
    }
  };

  const framed = isFramed();

  return (
    <Panel
      title="The store, live"
      subtitle="the real storefront — what a customer sees right now"
      className="mc-store-panel"
      actions={
        <div className="chip-group" role="group" aria-label="Preview device">
          {(['desktop', 'phone'] as const).map((d) => (
            <button key={d} type="button" className="chip-btn" aria-pressed={device === d} onClick={() => pickDevice(d)}>
              <span aria-hidden="true">{d === 'desktop' ? '🖥' : '📱'}</span> {d === 'desktop' ? 'Desktop' : 'Phone'}
            </button>
          ))}
        </div>
      }
    >
      <div className="mc-store-bar">
        <nav className="mc-quicknav" aria-label="Storefront pages">
          {QUICK_NAV.map((q) => (
            <button
              key={q.path}
              type="button"
              className="chip-btn"
              aria-pressed={path === q.path}
              title={q.hint}
              onClick={() => go(q.path)}
              disabled={framed}
            >
              {q.label}
            </button>
          ))}
        </nav>
        <div className="mc-address">
          <code className="mc-address-path" title="Page shown in the preview">
            {loading && <span className="spinner spinner-sm" aria-hidden="true" />} {path}
          </code>
          <a href={path} target="_blank" rel="noopener noreferrer" className="mc-newtab">
            Open in new tab <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
      {framed ? (
        <div className="mc-store-framed">
          <p>
            This Mission Control is itself running inside a preview frame, so it doesn’t embed another storefront.
          </p>
          <Link to="/live" target="_top" className="btn btn-sm btn-secondary">
            Open Mission Control in the full window
          </Link>
        </div>
      ) : (
        <>
          {/* The framed storefront is ~50 Tab stops: let keyboard users jump past it. */}
          <a href="#mc-system" className="skip-link">
            Skip to the system map
          </a>
          <div className={`mc-device mc-device-${device}`}>
            <iframe
              ref={frame}
              src="/"
              title="BreakCart storefront — live preview"
              className="mc-frame"
              onLoad={() => {
                setLoading(false);
                syncMotion();
                const p = framePath(frame.current);
                if (p) setPath(p);
              }}
            />
          </div>
        </>
      )}
    </Panel>
  );
}
