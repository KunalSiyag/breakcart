import { useEffect, useId, useState } from 'react';
import { inspector, useInspectorEntries, type InspectorEntry } from '../../api/inspector';
import { formatMs, formatTime } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { local } from '../../lib/storage';

const OPEN_KEY = 'breakcart.inspector.open';
const SHOWN = 30;

/** Requests the page itself cancelled (navigation, superseded search) aren't failures. */
const isAborted = (e: InspectorEntry) => e.code === 'ABORTED';
const isFailure = (e: InspectorEntry) => e.status !== null && !isAborted(e) && (e.status === 0 || e.status >= 400);

function statusClass(e: InspectorEntry): string {
  if (e.status === null) return 'is-pending';
  if (isAborted(e)) return 'is-aborted';
  if (e.status === 0 || e.status >= 500) return 'is-error';
  if (e.status >= 400) return 'is-warn';
  if (e.status === 202) return 'is-info';
  return 'is-ok';
}

/** Log-scaled width so 20 ms and 20 s are both visible. */
function latencyWidth(ms: number): number {
  const clamped = Math.max(1, Math.min(60_000, ms));
  return Math.max(3, Math.round((Math.log10(clamped) / Math.log10(60_000)) * 100));
}

function Row({ e, now }: { e: InspectorEntry; now: number }) {
  const ms = e.ms ?? now - e.startedAt;
  return (
    <li className={`ri-row ${statusClass(e)}`}>
      <details>
        <summary>
          <span className="ri-method">{e.method}</span>
          <span className="ri-path" title={e.path}>
            {e.path}
          </span>
          <span className="ri-status">{e.status === null ? '…' : isAborted(e) ? '—' : e.status === 0 ? 'ERR' : e.status}</span>
          <span className="ri-ms">
            {formatMs(ms)}
            <span className="ri-bar" style={{ width: `${latencyWidth(ms)}%` }} aria-hidden="true" />
          </span>
          <span className="ri-code">{isAborted(e) ? 'cancelled' : (e.code ?? (e.status === null ? 'pending' : ''))}</span>
        </summary>
        <div className="ri-detail">
          <div>
            Started {formatTime(e.startedAt)}
            {e.background ? ' · background poll' : ''}
          </div>
          {e.message && <div>Message: {e.message}</div>}
          {e.notes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </div>
      </details>
    </li>
  );
}

function InspectorPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const entries = useInspectorEntries();
  const [hideBackground, setHideBackground] = useState(true);
  const shown = (hideBackground ? entries.filter((e) => !e.background) : entries).slice(0, SHOWN);
  const hasPending = shown.some((e) => e.status === null);
  const now = useNow(hasPending ? 200 : 1000);
  const errors = shown.filter(isFailure).length;
  const done = shown.filter((e) => e.ms != null);
  const avg = done.length ? done.reduce((s, e) => s + (e.ms ?? 0), 0) / done.length : null;

  return (
    <aside id={id} className="ri-panel" aria-label="Request inspector">
      <header className="ri-head">
        <div>
          <h2>Request inspector</h2>
          <p>
            What this browser experienced · last {shown.length} calls · {errors} failed
            {avg != null && ` · avg ${formatMs(avg)}`}
          </p>
        </div>
        <button type="button" className="ri-close" onClick={onClose} aria-label="Close request inspector">
          ✕
        </button>
      </header>
      <div className="ri-tools">
        <label className="ri-check">
          <input type="checkbox" checked={hideBackground} onChange={(e) => setHideBackground(e.target.checked)} />
          Hide background polling
        </label>
        <button type="button" className="ri-clear" onClick={() => inspector.clear()}>
          Clear
        </button>
      </div>
      <div className="ri-cols" aria-hidden="true">
        <span>Method</span>
        <span>Path</span>
        <span>Status</span>
        <span>Latency</span>
        <span>Code</span>
      </div>
      {shown.length === 0 ? (
        <p className="ri-empty">No API calls yet. Browse the store and they’ll show up here.</p>
      ) : (
        <ol className="ri-list">
          {shown.map((e) => (
            <Row key={e.id} e={e} now={now} />
          ))}
        </ol>
      )}
    </aside>
  );
}

export function RequestInspector() {
  const [open, setOpen] = useState(() => local.get(OPEN_KEY) === '1');
  const entries = useInspectorEntries();
  const panelId = useId();
  const recent = entries.filter((e) => !e.background).slice(0, SHOWN);
  const errorCount = recent.filter(isFailure).length;
  const pending = entries.some((e) => e.status === null && !e.background);

  useEffect(() => {
    local.set(OPEN_KEY, open ? '1' : '0');
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="ri">
      {open && <InspectorPanel id={panelId} onClose={() => setOpen(false)} />}
      <button
        type="button"
        className={`ri-toggle${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{pending ? '⏳' : '🔍'}</span> Requests
        {errorCount > 0 && (
          <span className="ri-badge" aria-label={`${errorCount} failed`}>
            {errorCount}
          </span>
        )}
      </button>
    </div>
  );
}
