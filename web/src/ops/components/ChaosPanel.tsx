import { useEffect, useId, useRef, useState } from 'react';
import type { ChaosPatch, KnobRecord, KnobValue } from '../../api/types';
import { clamp, formatNum } from '../../lib/format';
import { useDebouncedCallback } from '../../lib/hooks';
import { boolHelp, chaosServices, fieldLabel, numberMeta } from '../fields';
import { opsStore, useOps } from '../store';
import { failMessage, useToast } from './Toasts';
import { Empty, Toggle } from './ui';

type Section = 'services' | 'payments' | 'data';
/** Draft key: "services/gateway/latencyMs", "payments//declinePct", "data//poisonPct". */
type DraftMap = Record<string, KnobValue>;

const dkey = (section: Section, svc: string, field: string) => `${section}/${svc}/${field}`;

/** Text input that only commits parseable numbers, so typing "-" or "" never sends garbage. */
function NumberInput({
  value,
  min,
  max,
  step,
  onCommit,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <input
      className="input input-num"
      type="number"
      inputMode="decimal"
      min={min}
      step={step}
      value={text}
      aria-label={label}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(String(value));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(Math.max(min, Math.min(max * 10, n)));
      }}
    />
  );
}

function NumberField({
  field,
  value,
  defaultValue,
  onChange,
}: {
  field: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const meta = numberMeta(field, defaultValue);
  const { label, unit } = fieldLabel(field);
  const changed = value !== defaultValue;
  return (
    <div className={`knob${changed ? ' is-changed' : ''}`}>
      <div className="knob-head">
        <label htmlFor={id}>
          {label}
          {unit && <span className="unit"> {unit}</span>}
        </label>
        <NumberInput
          value={value}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          onCommit={onChange}
          label={`${label} value`}
        />
        {changed && (
          <button type="button" className="link-btn" onClick={() => onChange(defaultValue)} aria-label={`Reset ${label} to ${defaultValue}`}>
            reset
          </button>
        )}
      </div>
      <input
        id={id}
        type="range"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={clamp(value, meta.min, meta.max)}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${formatNum(value)}${unit ? ` ${unit}` : ''}`}
      />
      {meta.help && <p className="field-help">{meta.help}</p>}
    </div>
  );
}

function KnobList({
  section,
  svc,
  defaults,
  current,
  drafts,
  onChange,
}: {
  section: Section;
  svc: string;
  defaults: KnobRecord;
  current: Partial<KnobRecord>;
  drafts: DraftMap;
  onChange: (section: Section, svc: string, field: string, v: KnobValue) => void;
}) {
  return (
    <div className="knobs">
      {Object.entries(defaults).map(([field, def]) => {
        const draft = drafts[dkey(section, svc, field)];
        const cur = current[field];
        const value = draft ?? cur ?? def;
        if (typeof def === 'boolean') {
          const { label } = fieldLabel(field);
          return (
            <div key={field} className={`knob knob-bool${value !== def ? ' is-changed' : ''}`}>
              <Toggle
                checked={Boolean(value)}
                onChange={(v) => onChange(section, svc, field, v)}
                label={label}
                description={boolHelp(field)}
              />
            </div>
          );
        }
        return (
          <NumberField
            key={field}
            field={field}
            value={typeof value === 'number' ? value : Number(value) || 0}
            defaultValue={typeof def === 'number' ? def : 0}
            onChange={(v) => onChange(section, svc, field, v)}
          />
        );
      })}
    </div>
  );
}

function countActive(defaults: KnobRecord, current: Partial<KnobRecord> | undefined): number {
  if (!current) return 0;
  return Object.entries(defaults).filter(([k, d]) => current[k] !== undefined && current[k] !== d).length;
}

export function ChaosPanel() {
  const defs = useOps((s) => s.defs);
  const runtime = useOps((s) => s.runtime);
  const toast = useToast();
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [clearing, setClearing] = useState(false);
  const [openSvc, setOpenSvc] = useState<Record<string, boolean>>({});
  const pendingPatch = useRef<ChaosPatch>({});
  const pendingKeys = useRef<DraftMap>({});

  const send = async () => {
    const patch = pendingPatch.current;
    const sent = pendingKeys.current;
    pendingPatch.current = {};
    pendingKeys.current = {};
    if (!Object.keys(sent).length) return;
    try {
      await opsStore.patchChaos(patch);
    } catch (e) {
      toast.push('error', failMessage('Updating chaos', e));
    } finally {
      // Drop drafts that were sent (unless edited again since); the server state now rules.
      setDrafts((d) => {
        const next = { ...d };
        for (const [k, v] of Object.entries(sent)) if (next[k] === v) delete next[k];
        return next;
      });
    }
  };

  const { call: schedule, flush } = useDebouncedCallback(() => void send(), 400);
  useEffect(() => () => flush(), [flush]);

  const change = (section: Section, svc: string, field: string, v: KnobValue) => {
    const k = dkey(section, svc, field);
    setDrafts((d) => ({ ...d, [k]: v }));
    pendingKeys.current[k] = v;
    const p = pendingPatch.current;
    if (section === 'services') {
      p.services = { ...p.services, [svc]: { ...p.services?.[svc], [field]: v } };
    } else {
      p[section] = { ...p[section], [field]: v };
    }
    // Sliders and number inputs are debounced; toggles apply immediately.
    schedule();
    if (typeof v === 'boolean') flush();
  };

  const clearAll = async () => {
    setClearing(true);
    pendingPatch.current = {};
    pendingKeys.current = {};
    setDrafts({});
    try {
      await opsStore.preset('calm-chaos');
      toast.push('ok', 'All chaos cleared');
    } catch (e) {
      toast.push('error', failMessage('Clearing chaos', e));
    } finally {
      setClearing(false);
    }
  };

  if (!defs || !runtime) return <Empty>Loading chaos definitions from /control/state…</Empty>;

  const svcDefaults = defs.serviceChaosDefaults as unknown as KnobRecord;
  const payDefaults = defs.paymentsChaosDefaults as unknown as KnobRecord;
  const dataDefaults = defs.dataChaosDefaults as unknown as KnobRecord;
  const payCurrent = runtime.chaos.payments as unknown as Partial<KnobRecord>;
  const dataCurrent = runtime.chaos.data as unknown as Partial<KnobRecord>;
  const services = chaosServices(defs.services);
  const svcActive = (svc: string) => countActive(svcDefaults, runtime.chaos.services[svc] as Partial<KnobRecord> | undefined);
  const total =
    services.reduce((n, s) => n + svcActive(s), 0) + countActive(payDefaults, payCurrent) + countActive(dataDefaults, dataCurrent);

  return (
    <div className="chaos">
      <div className="panel-toolbar">
        <span className="toolbar-note">
          {total ? (
            <>
              <span aria-hidden="true">⚡</span> <b>{total}</b> chaos knob{total === 1 ? '' : 's'} active
            </>
          ) : (
            'No chaos injected — all calm'
          )}
        </span>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void clearAll()} disabled={clearing}>
          {clearing ? 'Clearing…' : 'Clear all chaos'}
        </button>
      </div>

      <h3 className="chaos-h">Services</h3>
      {services.map((svc) => {
        const active = svcActive(svc);
        return (
          <details
            key={svc}
            className={`chaos-svc${active ? ' is-active' : ''}`}
            open={openSvc[svc] ?? active > 0}
            onToggle={(e) => {
              const isOpen = e.currentTarget.open;
              setOpenSvc((o) => (o[svc] === isOpen ? o : { ...o, [svc]: isOpen }));
            }}
          >
            <summary>
              <span className="chaos-svc-name">{svc}</span>
              {active > 0 && (
                <span className="tag tag-bug">
                  <span aria-hidden="true">⚡</span> {active} active
                </span>
              )}
            </summary>
            <KnobList
              section="services"
              svc={svc}
              defaults={svcDefaults}
              current={(runtime.chaos.services[svc] ?? {}) as Partial<KnobRecord>}
              drafts={drafts}
              onChange={change}
            />
          </details>
        );
      })}

      <h3 className="chaos-h">Payment provider (PSP)</h3>
      <details className={`chaos-svc${countActive(payDefaults, payCurrent) ? ' is-active' : ''}`} open>
        <summary>
          <span className="chaos-svc-name">payments PSP</span>
          {countActive(payDefaults, payCurrent) > 0 && <span className="tag tag-bug">{countActive(payDefaults, payCurrent)} changed</span>}
        </summary>
        <KnobList section="payments" svc="" defaults={payDefaults} current={payCurrent} drafts={drafts} onChange={change} />
      </details>

      <h3 className="chaos-h">Data &amp; events</h3>
      <details className={`chaos-svc${countActive(dataDefaults, dataCurrent) ? ' is-active' : ''}`} open>
        <summary>
          <span className="chaos-svc-name">replica · outbox · stream</span>
          {countActive(dataDefaults, dataCurrent) > 0 && (
            <span className="tag tag-bug">{countActive(dataDefaults, dataCurrent)} changed</span>
          )}
        </summary>
        <KnobList section="data" svc="" defaults={dataDefaults} current={dataCurrent} drafts={drafts} onChange={change} />
      </details>
    </div>
  );
}
