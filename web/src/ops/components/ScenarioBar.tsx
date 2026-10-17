import { useEffect, useId, useRef, useState } from 'react';
import type { Sale } from '../../api/types';
import { formatClock, formatDuration, formatInt, formatNum } from '../../lib/format';
import { useDebouncedCallback, useNow } from '../../lib/hooks';
import { opsStore, useOps } from '../store';
import { failMessage, useToast } from './Toasts';
import { StatusPill } from './ui';

function SaleChip({ sale, summaryAt }: { sale: Sale | null; summaryAt: number | null }) {
  const now = useNow(1000);
  if (!sale) {
    // Before the first summary the sale is unknown: hold the chip's place, invisibly. Its own key makes the
    // real chip a new node, so a long live-sale chip that wraps doesn't count as this one jumping a line.
    if (summaryAt == null) {
      return (
        <span key="pending" className="chip chip-muted" style={{ visibility: 'hidden' }} aria-hidden="true">
          No sale scheduled
        </span>
      );
    }
    return <span className="chip chip-muted">No sale scheduled</span>;
  }
  const serverNow = Date.parse(sale.now);
  const offset = Number.isFinite(serverNow) && summaryAt ? serverNow - summaryAt : 0;
  const t = now + offset;
  const start = Date.parse(sale.startsAt);
  const end = Date.parse(sale.endsAt);
  if (Number.isFinite(start) && t < start) {
    return (
      <span className="chip chip-upcoming" title={sale.name}>
        <span aria-hidden="true">⏱</span> {sale.name} starts in <b className="tabular">{formatClock((start - t) / 1000)}</b>
      </span>
    );
  }
  if (Number.isFinite(end) && t >= end) return <span className="chip chip-muted">{sale.name} ended</span>;
  return (
    <span className="chip chip-live" title={sale.name}>
      <span className="live-dot" aria-hidden="true" /> {sale.name} LIVE
      {Number.isFinite(end) && (
        <>
          {' '}
          · ends in <b className="tabular">{formatClock((end - t) / 1000)}</b>
        </>
      )}
    </span>
  );
}

export function ScenarioBar({ compact = false }: { compact?: boolean }) {
  const loadgen = useOps((s) => s.loadgen);
  const scenarios = useOps((s) => s.scenarios);
  const sale = useOps((s) => s.summary?.sale ?? null);
  const summaryAt = useOps((s) => s.summaryAt);
  const toast = useToast();
  const selectId = useId();
  const sliderId = useId();
  const running = Boolean(loadgen?.running);

  // The picker follows the loadgen's scenario (a lab, another tab or a script may start one) until
  // the user picks another; a run starting or ending drops that pick, so Restart restarts what runs.
  const [picked, setPicked] = useState<string | null>(null);
  const runKey = loadgen?.running ? loadgen.scenarioId : null;
  useEffect(() => setPicked(null), [runKey]);
  const selected = picked ?? (scenarios?.length ? (loadgen?.scenarioId ?? scenarios[0]!.id) : '');
  const [multiplier, setMultiplier] = useState(1);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const dragging = useRef(false);

  const serverMultiplier = loadgen?.multiplier;
  useEffect(() => {
    if (!dragging.current && typeof serverMultiplier === 'number' && serverMultiplier > 0) setMultiplier(serverMultiplier);
  }, [serverMultiplier]);

  const { call: pushMultiplier } = useDebouncedCallback((m: number) => {
    dragging.current = false;
    if (!opsStore.getState().loadgen?.running) return;
    opsStore.setMultiplier(m).catch((e: unknown) => toast.push('error', failMessage('Changing the load multiplier', e)));
  }, 300);

  const start = async () => {
    if (!selected) return;
    setBusy('start');
    try {
      await opsStore.startScenario(selected, multiplier);
      const name = scenarios?.find((s) => s.id === selected)?.name ?? selected;
      toast.push('ok', `Scenario “${name}” started at ×${multiplier.toFixed(1)}`);
    } catch (e) {
      toast.push('error', failMessage('Starting the scenario', e));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await opsStore.stopScenario();
      toast.push('ok', 'Scenario stopped');
    } catch (e) {
      toast.push('error', failMessage('Stopping the scenario', e));
    } finally {
      setBusy(null);
    }
  };

  const scenario = scenarios?.find((s) => s.id === selected) ?? null;
  const elapsed = loadgen?.elapsedSec ?? 0;
  const duration = loadgen?.durationSec ?? 0;
  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <section className={`scenario-bar${compact ? ' scenario-compact' : ''}`} aria-label="Load scenario">
      <div className="sb-status">
        <div className="sb-title">
          {running ? (
            <StatusPill level="ok" label="RUNNING" />
          ) : (
            <span className="pill pill-none">
              <span aria-hidden="true">○</span> idle
            </span>
          )}
          <strong>{running ? (loadgen?.scenarioName ?? loadgen?.scenarioId ?? 'Scenario') : 'No scenario running'}</strong>
          {running && loadgen?.phase && <span className="chip chip-phase">phase: {loadgen.phase}</span>}
          {!compact && <SaleChip sale={sale} summaryAt={summaryAt} />}
        </div>
        {running && (
          <>
            <div
              className="sb-progress"
              role="progressbar"
              aria-label="Scenario progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="sb-stats">
              <span className="tabular">
                {formatDuration(elapsed)} / {formatDuration(duration)}
              </span>
              <span>
                arrivals <b>{formatNum(loadgen?.actualArrivalPerSec)}</b> / {formatNum(loadgen?.targetArrivalPerSec)} per s
              </span>
              <span>
                active shoppers <b>{formatInt(loadgen?.activeSessions)}</b>
              </span>
              <span>
                load RPS <b>{formatNum(loadgen?.rps)}</b>
              </span>
              {(loadgen?.droppedArrivals ?? 0) > 0 && (
                <span className="warn-text">
                  <span aria-hidden="true">▲</span> dropped arrivals {formatInt(loadgen?.droppedArrivals)}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="sb-controls">
        <div className="sb-mult">
          <label htmlFor={sliderId}>
            Load ×<b className="tabular">{multiplier.toFixed(1)}</b>
          </label>
          <input
            id={sliderId}
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={multiplier}
            onChange={(e) => {
              const m = Number(e.target.value);
              dragging.current = true;
              setMultiplier(m);
              pushMultiplier(m);
            }}
            aria-valuetext={`${multiplier.toFixed(1)} times`}
          />
        </div>
        {!compact && (
          <div className="sb-pick">
            <label htmlFor={selectId} className="sr-only">
              Scenario
            </label>
            <select
              id={selectId}
              className="select"
              value={selected}
              onChange={(e) => setPicked(e.target.value)}
              disabled={!scenarios?.length}
            >
              {!scenarios?.length && <option value="">{scenarios ? 'No scenarios' : 'Loading scenarios…'}</option>}
              {scenarios?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatDuration(s.durationSec)})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              onClick={start}
              disabled={!selected || busy !== null}
              aria-busy={busy === 'start'}
            >
              {busy === 'start' ? 'Starting…' : !running ? 'Start' : selected === loadgen?.scenarioId ? 'Restart' : 'Switch to this'}
            </button>
          </div>
        )}
        <button
          type="button"
          className="btn btn-danger"
          onClick={stop}
          disabled={!running || busy !== null}
          aria-busy={busy === 'stop'}
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
      </div>

      {/* Holds the plan's line while the scenario list loads, so the bar doesn't grow under the page. */}
      {!compact && !scenarios && <p className="sb-plan muted">Plan: loading…</p>}
      {!compact && scenario && (
        <details className="sb-plan">
          <summary>
            Plan: {scenario.description || scenario.name}
            {scenario.botShare > 0 && ` · ${Math.round(scenario.botShare * 100)}% bots`}
          </summary>
          <div className="sb-plan-body">
            {scenario.phases.length > 0 && (
              <ol className="sb-phases">
                {scenario.phases.map((p, i) => (
                  <li key={`${p.name}-${i}`}>
                    <b>{p.name}</b> · {formatDuration(p.durationSec)} · {formatNum(p.fromRate)} → {formatNum(p.toRate)} arrivals/s
                  </li>
                ))}
              </ol>
            )}
            {(scenario.timeline.length > 0 || scenario.saleStartsAtSec != null) && (
              <ul className="sb-events">
                {scenario.saleStartsAtSec != null && <li>{formatDuration(scenario.saleStartsAtSec)} — sale goes live</li>}
                {scenario.timeline.map((t, i) => (
                  <li key={i}>
                    {formatDuration(t.atSec)} — {t.description}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
