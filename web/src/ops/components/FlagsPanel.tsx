import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { FlagDef, PresetId } from '../../api/types';
import { opsStore, useOps } from '../store';
import { failMessage, useToast } from './Toasts';
import { Empty } from './ui';

export function FlagRow({
  flagKey,
  def,
  current,
  pending,
  onSelect,
  nameSpace,
  showLab = true,
}: {
  flagKey: string;
  def: FlagDef;
  current: string | undefined;
  pending: string | undefined;
  onSelect: (mode: string) => void;
  nameSpace: string;
  showLab?: boolean;
}) {
  const selected = pending ?? current;
  const state = selected === def.naive ? 'bug' : selected === def.hardened ? 'fix' : 'other';
  return (
    <fieldset className={`flag flag-${state}`}>
      <legend>
        <code>{flagKey}</code>
        {state === 'bug' && (
          <span className="tag tag-bug">
            <span aria-hidden="true">▲</span> bug active
          </span>
        )}
        {state === 'fix' && (
          <span className="tag tag-fix">
            <span aria-hidden="true">✓</span> hardened
          </span>
        )}
      </legend>
      <p className="flag-desc">{def.description}</p>
      <div className="seg">
        {def.modes.map((m) => (
          <label
            key={m}
            className={`seg-opt${selected === m ? ' is-selected' : ''}${pending === m ? ' is-pending' : ''}`}
          >
            <input
              type="radio"
              name={`${nameSpace}-${flagKey}`}
              value={m}
              checked={selected === m}
              onChange={() => onSelect(m)}
            />
            <span className="seg-text">{m}</span>
            {m === def.naive && <span className="mini-tag mini-bug">bug</span>}
            {m === def.hardened && <span className="mini-tag mini-fix">fix</span>}
          </label>
        ))}
      </div>
      {selected && def.modeHelp[selected] && <p className="flag-help">{def.modeHelp[selected]}</p>}
      {current === undefined && <p className="flag-help muted">Current mode unknown (runtime not loaded).</p>}
      {showLab && def.lab && (
        <Link to={`/labs/${encodeURIComponent(def.lab)}`} className="flag-lab">
          Lab: {def.lab} →
        </Link>
      )}
    </fieldset>
  );
}

export function useFlagSetter() {
  const toast = useToast();
  const [pending, setPending] = useState<Record<string, string>>({});
  const runtime = useOps((s) => s.runtime);
  const setMode = async (key: string, mode: string) => {
    if (runtime?.flags[key] === mode && !pending[key]) return;
    setPending((p) => ({ ...p, [key]: mode }));
    try {
      await opsStore.patchFlags({ [key]: mode });
    } catch (e) {
      toast.push('error', failMessage(`Setting ${key} = ${mode}`, e));
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
    }
  };
  return { pending, setMode };
}

export function FlagsPanel({ only, showPresets = true }: { only?: string[]; showPresets?: boolean }) {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const toast = useToast();
  const nameSpace = useId();
  const { pending, setMode } = useFlagSetter();
  const [presetBusy, setPresetBusy] = useState<PresetId | null>(null);

  if (!defs) return <Empty>Loading flag definitions from /control/state…</Empty>;

  const keys = Object.keys(defs.flags).filter((k) => !only || only.includes(k));
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    const g = k.includes('.') ? k.split('.')[0]! : 'other';
    groups.set(g, [...(groups.get(g) ?? []), k]);
  }
  const bugs = keys.filter((k) => runtime?.flags[k] === defs.flags[k]?.naive).length;

  const applyPreset = async (id: PresetId) => {
    setPresetBusy(id);
    try {
      await opsStore.preset(id);
      toast.push('ok', id === 'naive' ? 'All flags set to their naive (buggy) modes' : 'All flags set to hardened modes');
    } catch (e) {
      toast.push('error', failMessage(`Preset ${id}`, e));
    } finally {
      setPresetBusy(null);
    }
  };

  return (
    <div className="flags">
      {showPresets && (
        <div className="panel-toolbar">
          <span className="toolbar-note">
            {runtime ? (
              <>
                <b>{bugs}</b> of {keys.length} flags in bug mode
              </>
            ) : (
              'runtime loading…'
            )}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-warn"
            onClick={() => void applyPreset('naive')}
            disabled={presetBusy !== null}
            aria-busy={presetBusy === 'naive'}
          >
            All naive (bugs on)
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ok"
            onClick={() => void applyPreset('hardened')}
            disabled={presetBusy !== null}
            aria-busy={presetBusy === 'hardened'}
          >
            All hardened
          </button>
        </div>
      )}
      {[...groups.entries()].map(([group, flagKeys]) => (
        <section key={group} className="flag-group" aria-label={`${group} flags`}>
          {groups.size > 1 && <h3 className="flag-group-title">{group}</h3>}
          {flagKeys.map((k) => (
            <FlagRow
              key={k}
              flagKey={k}
              def={defs.flags[k]!}
              current={runtime?.flags[k]}
              pending={pending[k]}
              onSelect={(m) => void setMode(k, m)}
              nameSpace={nameSpace}
            />
          ))}
        </section>
      ))}
      {keys.length === 0 && <Empty>No flags defined.</Empty>}
    </div>
  );
}
