import { useId, useState, type FormEvent } from 'react';
import { formatInt } from '../../lib/format';
import { fieldLabel } from '../fields';
import { opsStore, useOps } from '../store';
import { failMessage, useToast } from './Toasts';
import { Empty } from './ui';

function TuningRow({
  field,
  current,
  defaultValue,
  help,
  draft,
  onDraft,
}: {
  field: string;
  current: number | undefined;
  defaultValue: number;
  help: string | undefined;
  draft: string | undefined;
  onDraft: (v: string | undefined) => void;
}) {
  const id = useId();
  const { label, unit } = fieldLabel(field);
  const value = draft ?? (current != null ? String(current) : '');
  const invalid = draft !== undefined && (draft.trim() === '' || !Number.isFinite(Number(draft)) || Number(draft) < 0);
  const dirty = draft !== undefined && !invalid && Number(draft) !== current;
  const changedFromDefault = current != null && current !== defaultValue;
  return (
    <div className={`tuning-row${dirty ? ' is-dirty' : ''}${changedFromDefault ? ' is-changed' : ''}`}>
      <div className="tuning-head">
        <label htmlFor={id}>
          <code>{field}</code>
          <span className="tuning-label">
            {label}
            {unit ? ` (${unit})` : ''}
          </span>
        </label>
        <input
          id={id}
          className={`input input-num${invalid ? ' is-invalid' : ''}`}
          type="number"
          inputMode="numeric"
          min={0}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => onDraft(e.target.value === String(current) ? undefined : e.target.value)}
        />
      </div>
      <p id={`${id}-help`} className="field-help">
        {help}
        <span className="tuning-default">
          {' '}
          · default {formatInt(defaultValue)}
          {changedFromDefault && (
            <>
              {' '}
              ·{' '}
              <button type="button" className="link-btn" onClick={() => onDraft(String(defaultValue))}>
                use default
              </button>
            </>
          )}
        </span>
      </p>
    </div>
  );
}

export function TuningPanel() {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!defs || !runtime) return <Empty>Loading tuning from /control/state…</Empty>;

  const defaults = defs.tuningDefaults as unknown as Record<string, number>;
  const current = runtime.tuning as unknown as Record<string, number | undefined>;
  const keys = Object.keys(defaults);
  const dirty = Object.entries(drafts).filter(
    ([k, v]) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) !== current[k],
  );
  const nonDefault = keys.filter((k) => current[k] != null && current[k] !== defaults[k]);

  const apply = async (patch: Record<string, number>, label: string) => {
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      await opsStore.patchTuning(patch);
      setDrafts((d) => {
        const next = { ...d };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
      toast.push('ok', label);
    } catch (e) {
      toast.push('error', failMessage('Updating tuning', e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void apply(Object.fromEntries(dirty.map(([k, v]) => [k, Number(v)])), `Applied ${dirty.length} tuning change${dirty.length === 1 ? '' : 's'}`);
  };

  const resetAll = () =>
    void apply(Object.fromEntries(nonDefault.map((k) => [k, defaults[k]!])), 'Tuning reset to defaults');

  return (
    <form className="tuning" onSubmit={submit}>
      <div className="panel-toolbar">
        <span className="toolbar-note">
          {nonDefault.length ? `${nonDefault.length} changed from default` : 'All defaults'}
        </span>
        <button type="button" className="btn btn-sm btn-secondary" onClick={resetAll} disabled={busy || !nonDefault.length}>
          Reset to defaults
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !dirty.length}>
          {busy ? 'Applying…' : `Apply${dirty.length ? ` (${dirty.length})` : ''}`}
        </button>
      </div>
      {keys.map((k) => (
        <TuningRow
          key={k}
          field={k}
          current={current[k]}
          defaultValue={defaults[k]!}
          help={defs.tuningHelp[k]}
          draft={drafts[k]}
          onDraft={(v) =>
            setDrafts((d) => {
              const next = { ...d };
              if (v === undefined) delete next[k];
              else next[k] = v;
              return next;
            })
          }
        />
      ))}
      {dirty.length > 0 && (
        <div className="sticky-apply">
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Applying…' : `Apply ${dirty.length} change${dirty.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </form>
  );
}
