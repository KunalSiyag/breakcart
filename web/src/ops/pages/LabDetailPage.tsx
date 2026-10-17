import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Lab, LabVariant } from '../../api/types';
import { formatDuration, formatTime } from '../../lib/format';
import { useDocumentTitle, useNow } from '../../lib/hooks';
import { FlagRow, useFlagSetter } from '../components/FlagsPanel';
import { IntegrityPanel } from '../components/IntegrityPanel';
import { KpiGrid } from '../components/KpiGrid';
import { DifficultyBadge } from '../components/LabBits';
import { ScenarioBar } from '../components/ScenarioBar';
import { Timeline } from '../components/Timeline';
import { failMessage, useToast } from '../components/Toasts';
import { LatencyCard } from '../components/TrafficCharts';
import { useLabs } from '../labs';
import { opsStore, useOps } from '../store';

const MINI_KPIS = ['rps', 'errorPct', 'p99', 'checkouts', 'paid', 'paySuccess'];

function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {parts.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

function InvolvedFlags({ lab }: { lab: Lab }) {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const { pending, setMode } = useFlagSetter();
  const ns = useId();
  if (!lab.flags.length) return null;
  return (
    <section className="lab-section" aria-labelledby={`${ns}-h`}>
      <h2 id={`${ns}-h`}>Flags involved</h2>
      <p className="muted small">
        Live from the control plane — flipping one here applies immediately, mid-scenario.
      </p>
      {lab.flags.map((f) => {
        const def = defs?.flags[f];
        if (!def) {
          return (
            <p key={f} className="muted">
              <code>{f}</code> — {defs ? 'not defined in /control/state' : 'loading…'}
            </p>
          );
        }
        return (
          <FlagRow
            key={f}
            flagKey={f}
            def={def}
            current={runtime?.flags[f]}
            pending={pending[f]}
            onSelect={(m) => void setMode(f, m)}
            nameSpace={ns}
            showLab={false}
          />
        );
      })}
    </section>
  );
}

function RunPanel({ lab }: { lab: Lab }) {
  const toast = useToast();
  const scenarios = useOps((s) => s.scenarios);
  const loadgen = useOps((s) => s.loadgen);
  const [starting, setStarting] = useState<LabVariant | null>(null);
  const [lastRun, setLastRun] = useState<{ variant: LabVariant; at: number } | null>(null);
  const scenario = scenarios?.find((s) => s.id === lab.scenario);
  const runningThis = Boolean(loadgen?.running && lab.scenario && loadgen.scenarioId === lab.scenario);

  const run = async (variant: LabVariant) => {
    setStarting(variant);
    try {
      // Same traffic for both variants, as the steps promise: keep the current load multiplier
      // (the one the Load slider shows) instead of letting the control plane default to ×1.
      const m = loadgen?.multiplier;
      await opsStore.startLab(lab.id, variant, typeof m === 'number' && m > 0 ? m : undefined);
      setLastRun({ variant, at: Date.now() });
      toast.push('ok', `Lab “${lab.title}” running ${variant === 'broken' ? 'BROKEN' : 'FIXED'}`);
    } catch (e) {
      toast.push('error', failMessage(`Starting the lab (${variant})`, e));
    } finally {
      setStarting(null);
    }
  };

  return (
    <section className="panel lab-run" aria-label="Run this lab">
      <div className="lab-run-buttons">
        <button
          type="button"
          className="btn btn-danger btn-lg"
          onClick={() => void run('broken')}
          disabled={starting !== null}
          aria-busy={starting === 'broken'}
        >
          <span aria-hidden="true">💥</span> {starting === 'broken' ? 'Starting…' : 'Run broken'}
        </button>
        <button
          type="button"
          className="btn btn-ok btn-lg"
          onClick={() => void run('fixed')}
          disabled={starting !== null}
          aria-busy={starting === 'fixed'}
        >
          <span aria-hidden="true">🛠️</span> {starting === 'fixed' ? 'Starting…' : 'Run fixed'}
        </button>
      </div>
      {starting && (
        <p className="info-line" role="status">
          <span className="spinner spinner-sm" aria-hidden="true" /> Stopping the previous run, draining in-flight
          shoppers and resetting data — this can take up to ~20s…
        </p>
      )}
      <p className="muted small">
        Each button applies the lab’s broken or fixed runtime patch (flags, chaos, tuning) and starts scenario{' '}
        <code>{lab.scenario || '—'}</code>
        {scenario ? ` — ${scenario.name}, ${formatDuration(scenario.durationSec)}` : ''}.
        {lastRun && (
          <>
            {' '}
            Last run: <b>{lastRun.variant}</b> at {formatTime(lastRun.at)}
            {runningThis ? ' (running)' : ''}.
          </>
        )}
      </p>
    </section>
  );
}

function MiniWarRoom() {
  const now = useNow(2000);
  return (
    <div className="mini-warroom" aria-label="Mini war room">
      <ScenarioBar compact />
      <KpiGrid ids={MINI_KPIS} compact title="Vital signs" />
      <IntegrityPanel compact />
      <LatencyCard now={now} height={180} />
      <Timeline limit={25} compact />
    </div>
  );
}

export default function LabDetailPage() {
  const { id = '' } = useParams();
  const labs = useLabs();
  const lab = labs.data?.find((l) => l.id === id) ?? null;
  const [revealed, setRevealed] = useState(false);
  const rootId = useId();
  useDocumentTitle(lab ? `${lab.title} — BreakCart Labs` : 'Lab — BreakCart');

  if (!lab) {
    return (
      <div className="labs-page">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/labs">Labs</Link> <span aria-hidden="true">›</span> <span>{id}</span>
        </nav>
        {labs.loading && (
          <p className="ops-empty" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" /> Loading lab…
          </p>
        )}
        {labs.error && (
          <div className="ops-banner" role="alert">
            <strong>
              <span aria-hidden="true">■</span> Couldn’t load labs
            </strong>
            <span>
              {labs.error.code}: {labs.error.message}
            </span>
            <button type="button" className="btn btn-sm btn-secondary" onClick={labs.reload}>
              Try again
            </button>
          </div>
        )}
        {labs.data && <p className="ops-empty">No lab with id “{id}”.</p>}
      </div>
    );
  }

  return (
    <div className="labs-page lab-detail">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/labs">Labs</Link> <span aria-hidden="true">›</span> <span>{lab.category}</span>
      </nav>
      <header className="lab-head">
        <div className="lab-head-meta">
          <DifficultyBadge lab={lab} />
          <span className="chip chip-muted">{lab.category}</span>
          <code className="muted">{lab.id}</code>
        </div>
        <h1>{lab.title}</h1>
        <p className="lab-summary">{lab.summary}</p>
      </header>

      <div className="lab-layout">
        <article className="lab-content">
          {lab.story && (
            <section className="lab-section">
              <h2>The story</h2>
              <Paragraphs text={lab.story} />
            </section>
          )}
          {lab.symptoms.length > 0 && (
            <section className="lab-section">
              <h2>Symptoms</h2>
              <ul>
                {lab.symptoms.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}
          {lab.watch.length > 0 && (
            <section className="lab-section">
              <h2>What to watch</h2>
              <ul className="watch-list">
                {lab.watch.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </section>
          )}
          {lab.steps.length > 0 && (
            <section className="lab-section">
              <h2>Steps</h2>
              <ol className="steps">
                {lab.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </section>
          )}

          <InvolvedFlags lab={lab} />

          <section className="lab-section">
            <h2>Root cause</h2>
            {revealed ? (
              <div id={rootId} className="spoiler-open">
                <Paragraphs text={lab.rootCause || 'No root cause written for this lab.'} />
              </div>
            ) : (
              <button
                type="button"
                className="spoiler"
                aria-expanded={false}
                aria-controls={rootId}
                onClick={() => setRevealed(true)}
              >
                <span aria-hidden="true">🔒</span> Reveal root cause
                <span className="muted small"> — try to diagnose it from the war room first</span>
              </button>
            )}
          </section>

          {lab.fix && (
            <section className="lab-section">
              <h2>The fix</h2>
              <details className="fix-details">
                <summary>Show the fix</summary>
                <Paragraphs text={lab.fix} />
              </details>
            </section>
          )}

          {lab.realWorld && (
            <section className="lab-section real-world">
              <h2>In the real world</h2>
              <Paragraphs text={lab.realWorld} />
            </section>
          )}
        </article>

        <aside className="lab-side">
          <RunPanel lab={lab} />
          <MiniWarRoom />
          <p className="muted small">
            Want the full picture? <Link to="/warroom">Open the war room →</Link>
          </p>
        </aside>
      </div>
    </div>
  );
}
