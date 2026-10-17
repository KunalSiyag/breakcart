import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { KnobRecord } from '../../api/types';
import { chaosServices } from '../fields';
import { useOps } from '../store';
import { ChaosPanel } from './ChaosPanel';
import { FlagsPanel } from './FlagsPanel';
import { Timeline } from './Timeline';
import { TuningPanel } from './TuningPanel';

type TabId = 'timeline' | 'flags' | 'chaos' | 'tuning';

function useBadges(): Record<TabId, ReactNode> {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const critical = useOps((s) => s.timeline.filter((e) => e.level === 'critical').length);
  if (!defs || !runtime) return { timeline: critical || null, flags: null, chaos: null, tuning: null };
  const bugs = Object.entries(defs.flags).filter(([k, d]) => runtime.flags[k] === d.naive).length;
  const svcDefaults = defs.serviceChaosDefaults as unknown as KnobRecord;
  let chaos = 0;
  for (const svc of chaosServices(defs.services)) {
    const cur = runtime.chaos.services[svc] as Partial<KnobRecord> | undefined;
    if (cur) chaos += Object.entries(svcDefaults).filter(([k, d]) => cur[k] !== undefined && cur[k] !== d).length;
  }
  for (const [defaults, cur] of [
    [defs.paymentsChaosDefaults, runtime.chaos.payments],
    [defs.dataChaosDefaults, runtime.chaos.data],
  ] as const) {
    const d = defaults as unknown as KnobRecord;
    const c = cur as unknown as Partial<KnobRecord>;
    chaos += Object.entries(d).filter(([k, v]) => c[k] !== undefined && c[k] !== v).length;
  }
  const tuningDefaults = defs.tuningDefaults as unknown as Record<string, number>;
  const tuning = Object.entries(tuningDefaults).filter(
    ([k, v]) => (runtime.tuning as unknown as Record<string, number>)[k] !== undefined &&
      (runtime.tuning as unknown as Record<string, number>)[k] !== v,
  ).length;
  return { timeline: critical || null, flags: bugs || null, chaos: chaos || null, tuning: tuning || null };
}

const TABS: { id: TabId; label: string; badgeTitle: string }[] = [
  { id: 'timeline', label: 'Incidents', badgeTitle: 'critical events' },
  { id: 'flags', label: 'Bug flags', badgeTitle: 'flags in bug mode' },
  { id: 'chaos', label: 'Chaos', badgeTitle: 'chaos knobs active' },
  { id: 'tuning', label: 'Tuning', badgeTitle: 'changed from default' },
];

/** The war room's control desk: incidents + every runtime knob, rendered from /control/state defs. */
export function ControlTabs() {
  const [tab, setTab] = useState<TabId>('timeline');
  const badges = useBadges();
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    refs.current[id]?.focus();
  };

  return (
    <div className="control-desk">
      <div className="tabs" role="tablist" aria-label="Control desk">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            {badges[t.id] != null && (
              <span className={`tab-badge${t.id === 'timeline' || t.id === 'flags' ? ' is-hot' : ''}`} title={`${badges[t.id]} ${t.badgeTitle}`}>
                {badges[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={tab !== t.id}
          className="tab-panel"
          tabIndex={0}
        >
          {t.id === 'timeline' && <Timeline />}
          {t.id === 'flags' && <FlagsPanel />}
          {t.id === 'chaos' && <ChaosPanel />}
          {t.id === 'tuning' && <TuningPanel />}
        </div>
      ))}
    </div>
  );
}
