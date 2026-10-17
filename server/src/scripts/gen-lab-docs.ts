/**
 * Generates docs/labs/*.md (one runbook per lab + an index) from src/shared/labs.ts,
 * the flag definitions, the scenarios and the Prometheus alert rules.
 *
 *   npm run gen:docs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FLAGS, type FlagKey } from '../shared/defs';
import { LABS, type Lab } from '../shared/labs';
import { scenarioById, scenarioDuration, type RuntimePatch } from '../shared/scenarios';

const ROOT = path.resolve(__dirname, '../../..');
const OUT = path.join(ROOT, 'docs/labs');

interface Alert {
  name: string;
  severity: string;
  lab: string;
  summary: string;
}

/** Minimal line-based reader for our own alerts.yml (no YAML dependency needed). */
function readAlerts(): Alert[] {
  let text = '';
  try {
    text = readFileSync(path.join(ROOT, 'infra/prometheus/rules/alerts.yml'), 'utf8');
  } catch {
    return [];
  }
  const alerts: Alert[] = [];
  let cur: Alert | null = null;
  for (const line of text.split('\n')) {
    const a = /^\s*- alert:\s*(\S+)/.exec(line);
    if (a) {
      if (cur) alerts.push(cur);
      cur = { name: a[1], severity: '', lab: '', summary: '' };
      continue;
    }
    if (!cur) continue;
    const sev = /^\s+severity:\s*(\S+)/.exec(line);
    if (sev) cur.severity = sev[1];
    const lab = /^\s+lab:\s*(\S+)/.exec(line);
    if (lab) cur.lab = lab[1];
    const sum = /^\s+summary:\s*"?(.*?)"?\s*$/.exec(line);
    if (sum && !cur.summary) cur.summary = sum[1];
  }
  if (cur) alerts.push(cur);
  return alerts;
}

function patchLines(p: RuntimePatch): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p.flags ?? {})) out.push(`flag \`${k}\` = \`${v}\``);
  for (const [svc, c] of Object.entries(p.chaos?.services ?? {})) for (const [k, v] of Object.entries(c ?? {})) out.push(`chaos \`${svc}.${k}\` = \`${v}\``);
  for (const [k, v] of Object.entries(p.chaos?.payments ?? {})) out.push(`chaos \`payments.${k}\` = \`${v}\``);
  for (const [k, v] of Object.entries(p.chaos?.data ?? {})) out.push(`chaos \`data.${k}\` = \`${v}\``);
  for (const [k, v] of Object.entries(p.tuning ?? {})) out.push(`tuning \`${k}\` = \`${v}\``);
  return out.length ? out : ['(hardened baseline, no changes)'];
}

function labDoc(lab: Lab, alerts: Alert[]): string {
  const sc = scenarioById(lab.scenario)!;
  const myAlerts = alerts.filter((a) => a.lab === lab.id);
  const lines: string[] = [
    `# ${lab.title}`,
    '',
    `> **Lab \`${lab.id}\`** · ${lab.category} · ${lab.difficulty} · scenario [\`${sc.id}\`](#scenario) · [all labs](README.md)`,
    '',
    lab.summary,
    '',
    '## The story',
    '',
    lab.story,
    '',
    '## Run it',
    '',
    'From the UI: **Labs → this lab → Run broken**, then **Run fixed**. Or from a terminal:',
    '',
    '```bash',
    `make lab LAB=${lab.id} VARIANT=broken     # reset data, apply the bug, start traffic`,
    `make lab LAB=${lab.id} VARIANT=fixed      # same traffic, hardened implementation`,
    '```',
    '',
    'Starting a lab resets orders, payments, stock and caches, applies the hardened baseline, then the variant below.',
    '',
    '| Broken variant | Fixed variant |',
    '|---|---|',
  ];
  const b = patchLines(lab.brokenPatch);
  const f = patchLines(lab.fixedPatch);
  for (let i = 0; i < Math.max(b.length, f.length); i++) lines.push(`| ${b[i] ?? ''} | ${f[i] ?? ''} |`);
  lines.push('', '## Steps', '');
  lab.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('', '## Symptoms', '');
  for (const s of lab.symptoms) lines.push(`- ${s}`);
  lines.push('', '## Where to look', '');
  for (const w of lab.watch) lines.push(`- ${w}`);
  if (myAlerts.length) {
    lines.push('', '### Alerts that fire', '', '| Alert | Severity | Meaning |', '|---|---|---|');
    for (const a of myAlerts) lines.push(`| \`${a.name}\` | ${a.severity} | ${a.summary.replace(/\|/g, '\\|')} |`);
    lines.push('', 'Firing alerts: Prometheus <http://localhost:9091/alerts> and the Grafana war room.');
  }
  lines.push(
    '',
    '## Diagnose before you peek',
    '',
    'Write down your hypothesis, then confirm it with data: which panel moved first, which service is the bottleneck, ',
    'and whether the business invariants (not just latency/errors) are violated. Traces for slow requests are in Jaeger ',
    '(<http://localhost:16686>, 5% head sampling).',
    '',
    '<details>',
    '<summary><strong>Root cause (spoiler)</strong></summary>',
    '',
    lab.rootCause,
    '',
    '</details>',
    '',
    '<details>',
    '<summary><strong>The fix</strong></summary>',
    '',
    lab.fix,
    '',
    '</details>',
    '',
  );
  if (lab.flags.length) {
    lines.push('## Flags involved', '', '| Flag | Mode | What it does |', '|---|---|---|');
    for (const key of lab.flags) {
      const def = FLAGS[key as FlagKey];
      for (const mode of def.modes) {
        const tag = mode === def.naive ? ' (bug)' : mode === def.hardened ? ' (fix)' : '';
        lines.push(`| \`${key}\` | \`${mode}\`${tag} | ${(def.modeHelp as Record<string, string>)[mode]} |`);
      }
    }
    lines.push('');
  }
  lines.push(
    '## In the real world',
    '',
    lab.realWorld,
    '',
    '## Scenario',
    '',
    `<a id="scenario"></a>**${sc.name}** (\`${sc.id}\`, ${scenarioDuration(sc)}s${sc.botShare ? `, ${Math.round(sc.botShare * 100)}% bots` : ''}) — ${sc.description}`,
    '',
    '| Phase | Duration | Sessions/s (×1) |',
    '|---|---|---|',
    ...sc.phases.map((p) => `| ${p.name} | ${p.durationSec}s | ${p.fromRate} → ${p.toRate} |`),
  );
  if (sc.timeline.length) {
    lines.push('', 'Timeline:', '');
    for (const e of sc.timeline) lines.push(`- **T+${e.atSec}s** — ${e.description}`);
  }
  lines.push(
    '',
    '## Exercises',
    '',
    '1. Flip only the involved flag(s) back and forth *during* a run and note how long the system takes to recover — and whether the damage (e.g. oversold units) is undone (it is not: data corruption outlives the bug).',
    '2. Write the alert you wish had paged you first, then compare with `infra/prometheus/rules/alerts.yml`.',
    '3. Write a short postmortem using [`docs/postmortem-template.md`](../postmortem-template.md).',
    '',
  );
  return lines.join('\n');
}

function indexDoc(alerts: Alert[]): string {
  const cats = [...new Set(LABS.map((l) => l.category))];
  const lines = [
    '# Labs',
    '',
    `${LABS.length} reproducible production incidents. Each lab runs the same traffic twice — once with a real-world bug, once with the fix — so you can see the failure, diagnose it from telemetry, and watch the fix work.`,
    '',
    'Generated from `server/src/shared/labs.ts` by `npm run gen:docs` (do not edit by hand).',
    '',
  ];
  for (const c of cats) {
    lines.push(`## ${c}`, '', '| Lab | Difficulty | What breaks | Alerts |', '|---|---|---|---|');
    for (const l of LABS.filter((x) => x.category === c)) {
      const n = alerts.filter((a) => a.lab === l.id).length;
      lines.push(`| [${l.title}](${l.id}.md) | ${l.difficulty} | ${l.summary} | ${n} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Suggested path',
    '',
    '1. **Start with what healthy looks like**: run scenario `normal-day` and learn the dashboards.',
    '2. Beginner labs in order: `oversell-race`, `cascading-failure`, `n-plus-one`, `slow-search`, `phantom-sellout`, `coupon-overrun`, `memory-leak`.',
    '3. Intermediate: `cache-stampede`, `retry-storm`, `pool-exhaustion`, `deadlocks`, `double-charge`, `thundering-herd`, `overload-collapse`, `lost-events`, `poison-pill`.',
    '4. Advanced: `payment-limbo`, `clock-skew`, `shedding-death-spiral`, `connection-churn`, `rate-limit-bursts`.',
    '5. Then the **game days** in [`../game-days.md`](../game-days.md): several bugs and faults at once, no hints.',
    '',
  );
  return lines.join('\n');
}

const alerts = readAlerts();
mkdirSync(OUT, { recursive: true });
for (const lab of LABS) writeFileSync(path.join(OUT, `${lab.id}.md`), labDoc(lab, alerts));
writeFileSync(path.join(OUT, 'README.md'), indexDoc(alerts));
console.log(`wrote ${LABS.length} lab docs + index to ${path.relative(process.cwd(), OUT)} (${alerts.length} alerts parsed)`);
