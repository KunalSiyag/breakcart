import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Journey, JourneyResult, JourneyStep } from '../../api/types';
import { formatINR, formatInt, formatMs, formatNum, formatTime } from '../../lib/format';
import { useLatest, useNow } from '../../lib/hooks';
import { JOURNEY_RATE_WINDOW_MS, useOps } from '../store';
import { Empty, Panel } from './ui';

/**
 * "Live shoppers": sampled load-generator sessions (~4/s at any load), newest first, each
 * with a request waterfall. Rows expand into the full request log. The list holds still
 * while the pointer or keyboard focus is in it or a row is open, and Pause freezes it
 * outright; the store keeps buffering the newest 60 either way.
 */

const VISIBLE = 12;

/** How long the list waits before catching up once the user leaves it (a finger "leaves" as it lifts, before its tap lands). */
const RELEASE_MS = 600;

type Filter = 'all' | 'converted' | 'failed' | 'bots';

const FILTERS: { id: Filter; label: string; test: (j: Journey) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'converted', label: 'Converted', test: (j) => j.result === 'converted' },
  { id: 'failed', label: 'Failed', test: (j) => j.result === 'failed' },
  { id: 'bots', label: 'Bots', test: (j) => j.persona === 'bot' },
];

const RESULT_META: Record<JourneyResult, { label: string; icon: string }> = {
  converted: { label: 'Converted', icon: '✓' },
  abandoned: { label: 'Abandoned', icon: '↩' },
  failed: { label: 'Failed', icon: '✕' },
  blocked: { label: 'Blocked', icon: '⊘' },
  sold_out: { label: 'Sold out', icon: '∅' },
};

type Tone = 'ok' | 'warn' | 'bad' | 'queue';

const TONE_LABEL: Record<Tone, string> = { ok: '2xx', warn: '4xx', bad: '5xx / no response', queue: 'waiting room' };

/** Waterfall colour: 2xx green, 4xx amber, 5xx / timeout red, waiting room blue (a failed waiting-room call keeps its error colour). */
export function stepTone(s: JourneyStep): Tone {
  if (s.status === 0 || s.status >= 500) return 'bad';
  const ok = s.status >= 200 && s.status < 300;
  if (s.code === 'QUEUE_REQUIRED' || (s.step === 'queue' && ok)) return 'queue';
  return ok ? 'ok' : 'warn';
}

function statusText(s: JourneyStep): string {
  if (s.status === 0) return s.code ?? 'no response';
  return s.code ? `${s.status} ${s.code}` : String(s.status);
}

const stepTitle = (s: JourneyStep) => `${s.step} · ${statusText(s)} · ${formatMs(s.ms)}`;

function spanOf(j: Journey): number {
  return Math.max(1, j.durationMs, ...j.steps.map((s) => s.atMs + s.ms));
}

function Waterfall({ j }: { j: Journey }) {
  const span = spanOf(j);
  const counts: Record<Tone, number> = { ok: 0, warn: 0, bad: 0, queue: 0 };
  for (const s of j.steps) counts[stepTone(s)] += 1;
  const parts = (Object.keys(counts) as Tone[]).filter((t) => counts[t] > 0).map((t) => `${counts[t]} ${TONE_LABEL[t]}`);
  return (
    <span
      className="mc-wf"
      role="img"
      aria-label={`${j.steps.length} requests over ${formatMs(span)}: ${parts.join(', ')}`}
    >
      {j.steps.map((s, i) => (
        <span
          key={i}
          className={`mc-wf-seg tone-${stepTone(s)}`}
          style={{ left: `${(s.atMs / span) * 100}%`, width: `max(2px, ${(s.ms / span) * 100}%)` }}
          title={stepTitle(s)}
        />
      ))}
    </span>
  );
}

function StepTable({ j }: { j: Journey }) {
  return (
    <div className="mc-jr-steps">
      <p className="muted small">
        Session <code>{j.id}</code> · started {formatTime(j.startedAt)}
        {j.truncated ? ' · long session: first 39 requests and the last one' : ''}
      </p>
      <div className="table-scroll">
        <table className="ops-table">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col" className="num">
                At
              </th>
              <th scope="col">Response</th>
              <th scope="col" className="num">
                Latency
              </th>
            </tr>
          </thead>
          <tbody>
            {j.steps.map((s, i) => {
              const tone = stepTone(s);
              return (
                <tr key={i}>
                  <th scope="row">
                    <span className={`mc-wf-key tone-${tone}`} aria-hidden="true" /> {s.step}
                  </th>
                  <td className="num">+{formatMs(s.atMs)}</td>
                  <td>
                    <span className={`code-chip${tone === 'bad' || tone === 'warn' ? ' is-error' : ''}`}>{statusText(s)}</span>
                  </td>
                  <td className="num">{formatMs(s.ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Journeys are immutable, so a memoised row renders once, and its request log is mounted
 * only while open. `onOpen` tells the feed which rows are open, including one that goes
 * away while open (filtered out, or the list moved on).
 */
const JourneyRow = memo(function JourneyRow({ j, onOpen }: { j: Journey; onOpen: (id: string, open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    onOpen(j.id, true);
    return () => onOpen(j.id, false);
  }, [open, j.id, onOpen]);
  const meta = RESULT_META[j.result];
  const bot = j.persona === 'bot';
  return (
    <li className={`mc-jr res-${j.result}`}>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="mc-jr-line">
            <span className="mc-jr-persona" title={bot ? 'Bot' : 'Shopper'}>
              <span aria-hidden="true">{bot ? '🤖' : '🛍️'}</span>
              <span className="sr-only">{bot ? 'Bot' : 'Shopper'}</span>
            </span>
            <span className={`mc-res res-${j.result}`}>
              <span aria-hidden="true">{meta.icon}</span> {meta.label}
            </span>
            <span className="mc-jr-product" title={j.product?.name}>
              {j.product?.name ?? '—'}
            </span>
            <span className="mc-jr-meta">
              <span title="Session length">{formatMs(j.durationMs)}</span>
              {j.amountCents != null && <b title="Paid">{formatINR(j.amountCents)}</b>}
              {j.queueWaitMs != null && (
                <span title="Time in the waiting room">
                  <span aria-hidden="true">⏳</span>
                  <span className="sr-only">queued</span> {formatMs(j.queueWaitMs)}
                </span>
              )}
            </span>
          </span>
          <Waterfall j={j} />
        </summary>
        {open && <StepTable j={j} />}
      </details>
    </li>
  );
});

/**
 * The user is working in the list: a row is open, the pointer is over it, or keyboard focus
 * is in it (the focus a click or tap leaves behind doesn't count, or the list would stay held
 * until the user clicks somewhere else).
 */
function listInUse(list: HTMLElement | null, openRows: number): boolean {
  return openRows > 0 || (list != null && (list.matches(':hover') || list.querySelector(':focus-visible') != null));
}

export function JourneyFeed() {
  const journeys = useOps((s) => s.journeys);
  const supported = useOps((s) => s.journeysSupported);
  const arrivals = useOps((s) => s.journeyArrivals);
  const sseSince = useOps((s) => s.sseSince);
  const sse = useOps((s) => s.sse);
  const loadgen = useOps((s) => s.loadgen);
  const now = useNow(2000);
  const [filter, setFilter] = useState<Filter>('all');
  const [frozen, setFrozen] = useState<Journey[] | null>(null);
  const paused = frozen !== null;

  // While a scenario runs, new rows push the list down ~4×/s. While the user works in it,
  // it shows a snapshot instead, so the row they are reading (and its focus) stays put.
  const [hold, setHold] = useState<Journey[] | null>(null);
  const latest = useLatest(journeys);
  const listRef = useRef<HTMLOListElement>(null);
  const openIds = useRef(new Set<string>());
  const releaseTimer = useRef<number | undefined>(undefined);
  const grab = useCallback(() => {
    window.clearTimeout(releaseTimer.current);
    setHold((h) => h ?? latest.current);
  }, [latest]);
  const release = useCallback(() => {
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      if (!listInUse(listRef.current, openIds.current.size)) setHold(null);
    }, RELEASE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(releaseTimer.current), []);
  const onOpen = useCallback(
    (id: string, open: boolean) => {
      if (open) {
        openIds.current.add(id);
        grab();
      } else {
        openIds.current.delete(id);
        release();
      }
    },
    [grab, release],
  );

  const source = frozen ?? hold ?? journeys;
  const held = !paused && hold !== null;

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    for (const f of FILTERS) c[f.id] = source.filter(f.test).length;
    return c;
  }, [source]);
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]!;
  const shown = source.filter(active.test).slice(0, VISIBLE);
  const snapshot = frozen ?? hold;
  // New rows the current filter will show once the list catches up.
  const unseen = useMemo(() => {
    if (!snapshot) return 0;
    const seen = new Set(snapshot.map((j) => j.id));
    return journeys.filter((j) => active.test(j) && !seen.has(j.id)).length;
  }, [snapshot, journeys, active]);

  // Sampling readout: journeys received over the last minute (or since the stream opened).
  const windowStart = Math.max(sse === 'open' && sseSince ? sseSince : now, now - JOURNEY_RATE_WINDOW_MS);
  const windowMs = now - windowStart;
  const recent = arrivals.filter((t) => t >= windowStart).length;
  const perMin = windowMs >= 5000 ? (recent * 60_000) / windowMs : null;
  const running = Boolean(loadgen?.running);

  const subtitle = running
    ? `≈ ${perMin == null ? '…' : formatInt(perMin)} journeys/min sampled of ${formatNum(loadgen?.actualArrivalPerSec)} sessions/s`
    : source.length
      ? 'last run · no scenario running'
      : 'sampled shopper sessions';

  const togglePause = () => {
    if (!paused) {
      setFrozen(hold ?? journeys);
      return;
    }
    setFrozen(null);
    // Back to the newest, held there if the user is still in the list (say, a row is open).
    setHold(listInUse(listRef.current, openIds.current.size) ? journeys : null);
  };

  return (
    <Panel
      title="Live shoppers"
      subtitle={subtitle}
      className="mc-feed-panel"
      actions={
        <>
          <div className="chip-group" role="group" aria-label="Filter journeys">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip-btn" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span className="mc-count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          {/* The label names the action (Pause / Resume), so no aria-pressed: "Resume, pressed" contradicts itself. */}
          <button
            type="button"
            className={`chip-btn mc-pause${paused ? ' is-on' : ''}`}
            onClick={togglePause}
            title={
              paused
                ? 'Show the newest journeys again'
                : held
                  ? 'The list holds still while you point at it, focus it or have a row open; Pause keeps it frozen'
                  : 'Freeze the list (new journeys keep buffering)'
            }
          >
            <span aria-hidden="true">{paused ? '▶' : '⏸'}</span> {paused ? `Resume${unseen ? ` (${unseen} new)` : ''}` : 'Pause'}
          </button>
        </>
      }
    >
      {supported === false && journeys.length === 0 ? (
        <p className="mc-feed-empty">
          This control plane doesn’t publish shopper journeys yet — it needs <code>GET /control/journeys/recent</code> and
          the SSE <code>journey</code> event. Rows appear here as soon as it does.
        </p>
      ) : source.length === 0 ? (
        <div className="mc-feed-empty">
          {running ? (
            <p>
              <span className="spinner spinner-sm" aria-hidden="true" /> Waiting for the first sampled sessions to finish…
            </p>
          ) : (
            <p>
              Journeys appear here while a scenario runs: each row is one sampled shopper (or bot) and every request they
              made — with retries, waiting-room polls and the error codes they hit. Start a scenario above or in the{' '}
              <Link to="/warroom">War Room</Link>.
            </p>
          )}
        </div>
      ) : shown.length === 0 ? (
        <Empty>No {active.label.toLowerCase()} journeys among the last {formatInt(source.length)}.</Empty>
      ) : (
        <div className="mc-feed-wrap">
          {held && unseen > 0 && (
            <p className="mc-feed-held">
              <span aria-hidden="true">↑</span> {formatInt(unseen)} new · held while you read
            </p>
          )}
          <ol
            ref={listRef}
            className={`mc-feed${paused ? ' is-paused' : ''}`}
            aria-live="off"
            onPointerEnter={grab}
            onPointerLeave={release}
            onFocus={grab}
            onBlur={release}
          >
            {shown.map((j) => (
              <JourneyRow key={j.id} j={j} onOpen={onOpen} />
            ))}
          </ol>
        </div>
      )}
      <ul className="mc-wf-legend" aria-label="Waterfall colours">
        {(['ok', 'warn', 'bad', 'queue'] as Tone[]).map((t) => (
          <li key={t}>
            <span className={`mc-wf-key tone-${t}`} aria-hidden="true" /> {TONE_LABEL[t]}
          </li>
        ))}
        <li className="muted">bar = one request · position = when · width = how long</li>
      </ul>
    </Panel>
  );
}
