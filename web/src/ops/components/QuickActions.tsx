import { useId, useState, type FormEvent } from 'react';
import type { ControlAction } from '../../api/types';
import { opsStore, useOps } from '../store';
import { Modal } from './Modal';
import { failMessage, useToast } from './Toasts';

type Dialog = null | 'reset' | 'price' | 'kill';

export function QuickActions() {
  const toast = useToast();
  const services = useOps((s) => s.defs?.services ?? null);
  const [busy, setBusy] = useState<ControlAction | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [productId, setProductId] = useState('1');
  const [rupees, setRupees] = useState('');
  const [target, setTarget] = useState('');
  const ids = { pid: useId(), price: useId(), target: useId() };

  const killable = (services ?? []).filter((s) => s !== 'control-plane');

  const run = async (action: ControlAction, label: string, body: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const r = await opsStore.action(action, body);
      toast.push(r?.ok === false ? 'error' : 'ok', r?.message || `${label}: done`);
      setDialog(null);
    } catch (e) {
      toast.push('error', failMessage(label, e));
    } finally {
      setBusy(null);
    }
  };

  const submitPrice = (e: FormEvent) => {
    e.preventDefault();
    const pid = Number(productId);
    const price = Number(rupees);
    if (!Number.isInteger(pid) || pid < 1 || !Number.isFinite(price) || price <= 0) {
      toast.push('error', 'Enter a product id (≥ 1) and a positive deal price in ₹.');
      return;
    }
    void run('price-change', 'Price change', { productId: pid, dealPriceCents: Math.round(price * 100) });
  };

  const submitKill = (e: FormEvent) => {
    e.preventDefault();
    const t = target || killable[0];
    if (!t) return;
    void run('kill-service', `Kill ${t}`, { target: t });
  };

  const btn = (action: ControlAction, icon: string, label: string, hint: string) => (
    <button
      type="button"
      className="action-btn"
      onClick={() => void run(action, label)}
      disabled={busy !== null}
      aria-busy={busy === action}
      title={hint}
    >
      <span aria-hidden="true">{icon}</span> {busy === action ? `${label}…` : label}
    </button>
  );

  return (
    <div className="quick-actions" role="group" aria-label="Quick actions">
      {btn('flush-cache', '🧹', 'Flush cache', 'Drop every cache entry — watch the stampede (or the single-flight)')}
      {btn('restock', '📦', 'Restock', 'Refill deal stock')}
      {btn('inject-poison', '☠️', 'Inject poison', 'Publish a malformed order event onto the fulfillment stream')}
      <button type="button" className="action-btn" onClick={() => setDialog('price')} disabled={busy !== null}>
        <span aria-hidden="true">🏷️</span> Price change…
      </button>
      <button
        type="button"
        className="action-btn"
        onClick={() => {
          setTarget((t) => t || killable[0] || '');
          setDialog('kill');
        }}
        disabled={busy !== null || killable.length === 0}
      >
        <span aria-hidden="true">💀</span> Kill service…
      </button>
      <button type="button" className="action-btn action-danger" onClick={() => setDialog('reset')} disabled={busy !== null}>
        <span aria-hidden="true">⚠️</span> Reset data…
      </button>

      <Modal
        open={dialog === 'reset'}
        title="Reset all data?"
        tone="danger"
        onClose={() => setDialog(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void run('reset-data', 'Reset data')}
              disabled={busy !== null}
              aria-busy={busy === 'reset-data'}
            >
              {busy === 'reset-data' ? 'Resetting…' : 'Yes, reset everything'}
            </button>
          </>
        }
      >
        <p>
          Resets the store back to its seeded state — orders, payments, reservations, coupon redemptions and stock
          levels.
        </p>
        <p className="muted">Use it to start a lab from a clean slate. It can’t be undone.</p>
      </Modal>

      <Modal open={dialog === 'price'} title="Change a deal price" onClose={() => setDialog(null)}>
        <form onSubmit={submitPrice} className="form-stack">
          <p className="muted">
            Simulates a merchandiser editing a price mid-sale. With <code>catalog.priceInvalidation = ttl_only</code>{' '}
            caches keep serving the old price, and <code>orders.pricing = cart_quote</code> charges it.
          </p>
          <div className="field">
            <label htmlFor={ids.pid}>Product id</label>
            <input
              id={ids.pid}
              className="input"
              type="number"
              min={1}
              step={1}
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              required
            />
            <p className="field-help">Hot flash-deal products are ids 1–12.</p>
          </div>
          <div className="field">
            <label htmlFor={ids.price}>New deal price (₹)</label>
            <input
              id={ids.price}
              className="input"
              type="number"
              min={1}
              step="0.01"
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              placeholder="e.g. 9999"
              required
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy !== null} aria-busy={busy === 'price-change'}>
              {busy === 'price-change' ? 'Applying…' : 'Change price'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={dialog === 'kill'} title="Kill a service" tone="danger" onClose={() => setDialog(null)}>
        <form onSubmit={submitKill} className="form-stack">
          <p className="muted">
            Abruptly terminates the service’s process, like a crash or an OOM kill. Watch how its callers cope —
            breakers, retries, timeouts — and how long it takes to come back.
          </p>
          <div className="field">
            <label htmlFor={ids.target}>Service</label>
            <select id={ids.target} className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {killable.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy !== null} aria-busy={busy === 'kill-service'}>
              {busy === 'kill-service' ? 'Killing…' : `Kill ${target || 'service'}`}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
