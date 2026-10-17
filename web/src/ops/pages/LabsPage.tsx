import { Link } from 'react-router';
import type { Lab } from '../../api/types';
import { useDocumentTitle } from '../../lib/hooks';
import { DifficultyBadge } from '../components/LabBits';
import { DIFFICULTY_META, useLabs } from '../labs';
import { useOps } from '../store';

function LabCard({ lab }: { lab: Lab }) {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const bugsOn = lab.flags.filter((f) => defs?.flags[f] && runtime?.flags[f] === defs.flags[f]!.naive).length;
  return (
    <li className="lab-card">
      <Link to={`/labs/${encodeURIComponent(lab.id)}`} className="lab-card-link">
        <div className="lab-card-top">
          <DifficultyBadge lab={lab} />
          {bugsOn > 0 && (
            <span className="tag tag-bug" title="Flags of this lab currently in their buggy mode">
              <span aria-hidden="true">▲</span> bug live
            </span>
          )}
        </div>
        <h3>{lab.title}</h3>
        <p>{lab.summary}</p>
        {lab.flags.length > 0 && (
          <ul className="lab-flags" aria-label="Flags involved">
            {lab.flags.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
        )}
        <span className="lab-open">Open lab →</span>
      </Link>
    </li>
  );
}

export default function LabsPage() {
  useDocumentTitle('Labs — BreakCart');
  const labs = useLabs();

  const groups = new Map<string, Lab[]>();
  for (const lab of labs.data ?? []) groups.set(lab.category, [...(groups.get(lab.category) ?? []), lab]);
  const ordered = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cat, list]) => [
      cat,
      [...list].sort(
        (a, b) => DIFFICULTY_META[a.difficulty].rank - DIFFICULTY_META[b.difficulty].rank || a.title.localeCompare(b.title),
      ),
    ] as const);

  return (
    <div className="labs-page">
      <header className="labs-hero">
        <h1>Production-bug labs</h1>
        <p>
          Each lab is a real failure mode from sale day: a story, the symptoms, what to watch in the war room, and a
          one-click way to run it <em>broken</em> and then <em>fixed</em>. Reproduce it, find the root cause, flip the
          fix, watch it recover.
        </p>
      </header>

      {labs.error && !labs.data && (
        <div className="ops-banner" role="alert">
          <strong>
            <span aria-hidden="true">■</span> Couldn’t load labs
          </strong>
          <span>
            <code>GET /control/labs</code> failed ({labs.error.code}: {labs.error.message}).
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={labs.reload}>
            Try again
          </button>
        </div>
      )}
      {labs.loading && !labs.data && (
        <p className="ops-empty" role="status">
          <span className="spinner spinner-sm" aria-hidden="true" /> Loading labs…
        </p>
      )}
      {labs.data && labs.data.length === 0 && <p className="ops-empty">No labs defined yet.</p>}

      {ordered.map(([category, list]) => (
        <section key={category} className="lab-group" aria-labelledby={`cat-${category}`}>
          <h2 id={`cat-${category}`}>
            {category} <span className="muted">· {list.length}</span>
          </h2>
          <ul className="lab-grid">
            {list.map((lab) => (
              <LabCard key={lab.id} lab={lab} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
