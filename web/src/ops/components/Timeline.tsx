import { useMemo, useState } from 'react';
import type { TimelineEvent, TimelineLevel } from '../../api/types';
import { formatTime, relativeTime, toMillis } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { useOps } from '../store';
import { Empty, Panel } from './ui';

const LEVELS: { id: TimelineLevel; label: string; icon: string }[] = [
  { id: 'critical', label: 'Critical', icon: '■' },
  { id: 'warn', label: 'Warn', icon: '▲' },
  { id: 'info', label: 'Info', icon: '●' },
];

function EventRow({ e, now }: { e: TimelineEvent; now: number }) {
  const ms = toMillis(e.ts);
  const meta = LEVELS.find((l) => l.id === e.level) ?? LEVELS[2]!;
  const hasData = e.data !== undefined && e.data !== null && !(typeof e.data === 'object' && Object.keys(e.data as object).length === 0);
  return (
    <li className={`tl-item tl-${e.level}`}>
      <span className="tl-icon" aria-label={meta.label}>
        {meta.icon}
      </span>
      <div className="tl-body">
        <div className="tl-meta">
          <time dateTime={ms ? new Date(ms).toISOString() : undefined} title={formatTime(ms)}>
            {relativeTime(ms, now)}
          </time>
          <span className="tl-source">
            {e.source}
            {e.kind ? ` · ${e.kind}` : ''}
          </span>
        </div>
        <p className="tl-msg">{e.message}</p>
        {hasData && (
          <details className="tl-data">
            <summary>details</summary>
            <pre>{JSON.stringify(e.data, null, 2)}</pre>
          </details>
        )}
      </div>
    </li>
  );
}

export function Timeline({ limit, compact = false }: { limit?: number; compact?: boolean }) {
  const events = useOps((s) => s.timeline);
  const sse = useOps((s) => s.sse);
  const reachable = useOps((s) => s.reachable);
  const now = useNow(5000);
  const [enabled, setEnabled] = useState<Record<TimelineLevel, boolean>>({ critical: true, warn: true, info: true });
  const counts = useMemo(() => {
    const c: Record<TimelineLevel, number> = { critical: 0, warn: 0, info: 0 };
    for (const e of events) c[e.level] += 1;
    return c;
  }, [events]);
  const shown = events.filter((e) => enabled[e.level]).slice(0, limit ?? 200);

  return (
    <Panel
      title="Incident timeline"
      subtitle={sse === 'open' ? 'live · newest first' : 'live updates paused — reconnecting'}
      className={`timeline-panel${compact ? ' timeline-compact' : ''}`}
      actions={
        <div className="chip-group" role="group" aria-label="Filter by level">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`chip-btn chip-${l.id}`}
              aria-pressed={enabled[l.id]}
              onClick={() => setEnabled((s) => ({ ...s, [l.id]: !s[l.id] }))}
            >
              <span aria-hidden="true">{l.icon}</span> {l.label} {counts[l.id]}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <Empty>
          {events.length
            ? 'No events match the filter.'
            : reachable === false
              ? 'No events — the control plane is unreachable.'
              : 'No incidents yet. Things are calm… for now.'}
        </Empty>
      ) : (
        // Focusable: below 1060px the list is a scroll container, and keyboards must be able to scroll it.
        <ol className="tl-list" aria-live="off" tabIndex={0} aria-label="Incidents, newest first">
          {shown.map((e) => (
            <EventRow key={String(e.id)} e={e} now={now} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** One-line "latest incident" ticker for the war-room header. */
export function LatestIncident() {
  const events = useOps((s) => s.timeline);
  const now = useNow(5000);
  const latest = events.find((e) => e.level !== 'info');
  if (!latest) return null;
  const ms = toMillis(latest.ts);
  if (ms != null && now - ms > 5 * 60_000) return null;
  return (
    <p className={`ticker tl-${latest.level}`} role="status">
      <span aria-hidden="true">{latest.level === 'critical' ? '■' : '▲'}</span>
      <strong>{relativeTime(ms, now)}</strong> {latest.message}
    </p>
  );
}
