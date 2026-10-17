import { describe, expect, it } from 'vitest';
import { FLAGS, flagPreset, type FlagKey } from '../src/shared/defs';
import { LABS } from '../src/shared/labs';
import { rateAt, scenarioById, scenarioDuration, SCENARIOS } from '../src/shared/scenarios';
import { validatePatch } from '../src/services/control-plane/store';

describe('flag definitions', () => {
  it('naive and hardened modes are valid modes of each flag, and differ', () => {
    for (const [key, def] of Object.entries(FLAGS)) {
      expect(def.modes, key).toContain(def.naive);
      expect(def.modes, key).toContain(def.hardened);
      expect(def.naive, key).not.toBe(def.hardened);
      for (const mode of def.modes) expect(def.modeHelp, `${key}.${mode} help`).toHaveProperty(mode);
    }
  });

  it('every flag is taught by an existing lab', () => {
    const labIds = new Set(LABS.map((l) => l.id));
    for (const [key, def] of Object.entries(FLAGS)) expect(labIds.has(def.lab), `${key} → ${def.lab}`).toBe(true);
  });

  it('presets cover every flag', () => {
    expect(Object.keys(flagPreset('naive')).sort()).toEqual(Object.keys(FLAGS).sort());
  });
});

describe('labs', () => {
  it('have unique ids', () => {
    expect(new Set(LABS.map((l) => l.id)).size).toBe(LABS.length);
  });

  for (const lab of LABS) {
    describe(lab.id, () => {
      it('references a real scenario', () => {
        expect(scenarioById(lab.scenario)).toBeDefined();
      });

      it('has valid broken and fixed patches', () => {
        expect(() => validatePatch(lab.brokenPatch)).not.toThrow();
        expect(() => validatePatch(lab.fixedPatch)).not.toThrow();
      });

      it('lists only real flags', () => {
        for (const f of lab.flags) expect(FLAGS).toHaveProperty(f);
      });

      it('broken and fixed variants actually differ', () => {
        expect(JSON.stringify(lab.brokenPatch)).not.toBe(JSON.stringify(lab.fixedPatch));
      });

      it('for every flag the variants disagree on, fixed = hardened mode and broken ≠ hardened', () => {
        for (const [k, v] of Object.entries(lab.brokenPatch.flags ?? {})) {
          const def = FLAGS[k as FlagKey];
          // Flags shared with the fixed variant are context (e.g. waiting room off), not the bug.
          if (lab.fixedPatch.flags?.[k as FlagKey] === v) continue;
          expect(v, `${lab.id}: broken ${k}`).not.toBe(def.hardened);
          expect(lab.fixedPatch.flags?.[k as FlagKey], `${lab.id}: fixed ${k}`).toBe(def.hardened);
        }
      });

      it('has the teaching content filled in', () => {
        for (const field of ['title', 'summary', 'story', 'rootCause', 'fix', 'realWorld'] as const) expect(lab[field].length, field).toBeGreaterThan(20);
        expect(lab.symptoms.length).toBeGreaterThan(0);
        expect(lab.steps.length).toBeGreaterThan(2);
      });
    });
  }
});

describe('scenarios', () => {
  it('have unique ids and valid timelines', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      const d = scenarioDuration(s);
      expect(d, s.id).toBeGreaterThan(0);
      for (const ev of s.timeline) {
        expect(ev.atSec, `${s.id} event`).toBeLessThan(d);
        if (ev.patch) expect(() => validatePatch(ev.patch!)).not.toThrow();
        if (ev.action) expect(['price-change', 'kill-service', 'flush-cache', 'inject-poison', 'restock']).toContain(ev.action.name);
      }
      if (s.saleStartsAtSec !== null) expect(s.saleStartsAtSec).toBeLessThan(d);
    }
  });

  it('rateAt interpolates linearly within a phase and stops after the last one', () => {
    const s = scenarioById('midnight-flash-sale')!;
    expect(rateAt(s, 0)).toEqual({ rate: 25, phase: 'pre-sale crowd' });
    expect(rateAt(s, 30).rate).toBeCloseTo(42.5);
    expect(rateAt(s, 60)).toEqual({ rate: 60, phase: 'midnight spike' });
    expect(rateAt(s, 75).rate).toBeCloseTo(160);
    expect(rateAt(s, scenarioDuration(s))).toEqual({ rate: 0, phase: null });
  });
});

describe('validatePatch', () => {
  it('rejects unknown flags, modes, services and keys', () => {
    expect(() => validatePatch({ flags: { nope: 'x' } } as never)).toThrow(/unknown flag/);
    expect(() => validatePatch({ flags: { 'orders.coupon': 'yolo' } } as never)).toThrow(/invalid mode/);
    expect(() => validatePatch({ chaos: { services: { mainframe: { errorPct: 1 } } } } as never)).toThrow(/unknown service/);
    expect(() => validatePatch({ chaos: { services: { catalog: { explode: 1 } } } } as never)).toThrow(/unknown/);
    expect(() => validatePatch({ chaos: { services: { catalog: { redisDown: 'yes' } } } } as never)).toThrow(/boolean/);
    expect(() => validatePatch({ tuning: { dbPoolSize: 0 } })).toThrow(/dbPoolSize/);
    expect(() => validatePatch({ tuning: { cacheTtlSec: -1 } })).toThrow(/>= 0/);
  });

  it('accepts well-formed patches', () => {
    expect(() =>
      validatePatch({
        flags: { 'catalog.cache': 'hardened' },
        chaos: { services: { gateway: { latencyMs: 100 } }, payments: { outage: true }, data: { replicaLagMs: 10 } },
        tuning: { dbPoolSize: 30 },
      }),
    ).not.toThrow();
  });
});
