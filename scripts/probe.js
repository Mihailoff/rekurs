#!/usr/bin/env node
/**
 * Probe: ONE failure through the full pipeline (Sentry gather → render → real Jev → policy),
 * with everything printed so you can learn what Jev saw and what it answered.
 *
 *   node scripts/probe.js <scenario>            one demo scenario by name (503, "timeout POST", flap…)
 *   node scripts/probe.js --state=file.txt      ask Jev about a hand-written state (no server)
 *   node scripts/probe.js --list                list scenario names
 *
 * Flags: --labels=examples   --no-gather   --site=getWork|charge (with --state)   --noul="statement" (repeatable)
 *        --save=file.txt (write the rendered state so you can edit it and re-probe with --state)
 *        --model=jev-latest  --raw (dump raw wire answers)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createJevHttpClient, toWire } from '../src/decider/jev-http-client.js';
import { createJevDecider, buildQuestions, normalizeResponse } from '../src/decider/jev.js';
import { classify } from '../src/decider/rules.js';
import { createPolicy } from '../src/policy.js';
import { normalizeSite } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { renderState } from '../src/gather/render.js';
import { startFaultServer } from '../demo/fault-server.js';
import { runSuite, startSentry } from '../demo/index.js';
import { SCENARIOS, SITES } from '../demo/scenarios.js';

try { process.loadEnvFile('.env'); } catch { /* no .env */ }
const argv = process.argv.slice(2);
const flags = {}; const nouls = []; const positional = [];
for (const a of argv) {
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [k, v = true] = a.slice(2).split(/=(.*)/s);
  if (k === 'noul') nouls.push(v); else flags[k] = v;
}
if (flags.list) { console.log(SCENARIOS.map((s) => `${s.name}  (${s.site}, ${JSON.stringify(s.fault)})`).join('\n')); process.exit(0); }

const LABELS = {
  examples: {
    persistence: {
      transient: 'a passing condition such as a timeout, a connection reset, a 5xx service error, or rate limiting: the same call is likely to succeed if repeated shortly',
      persistent: 'a standing condition such as bad input, missing credentials, a wrong URL, or a broken configuration: repeating the same call will keep failing until something changes',
      unknown: 'the failure fits neither pattern and could go either way',
    },
  },
};
const labels = LABELS[flags.labels] ?? {};
const siteNouls = Object.fromEntries(nouls.map((s, i) => [`n${i + 1}`, s]));

// ── capturing client ──
const http = createJevHttpClient({ model: flags.model ?? 'jev-latest' });
const calls = [];
const client = {
  async ask(state, questions) {
    const answers = await http.ask(state, questions);
    calls.push({ state, questions, answers, ...http.last });
    return answers;
  },
};

const hr = (t) => console.log(`\n══ ${t} ${'═'.repeat(Math.max(0, 70 - t.length))}`);
const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '·');
function printAxes(axes, rules) {
  for (const ax of ['persistence', 'locus', 'outcome', 'scope']) {
    console.log(`${ax.padEnd(12)} → ${axes[ax].pick}  (conf ${axes[ax].conf.toFixed(2)})${rules ? `   rules: ${rules[ax].pick}` : ''}`);
    for (const [opt, p] of Object.entries(axes[ax].p).sort((a, b) => b[1] - a[1])) console.log(`               ${bar(p)} ${p.toFixed(2)}  ${opt}`);
  }
  console.log(`${'overload'.padEnd(12)} → ${bar(axes.overload.p)} ${axes.overload.p.toFixed(2)}${rules ? `   rules: ${rules.overload.p.toFixed(2)}` : ''}`);
  for (const [k, v] of Object.entries(axes.nouls ?? {})) console.log(`${('noul:' + k).padEnd(12)} → ${bar(v.p)} ${v.p.toFixed(2)}  "${siteNouls[k]}"`);
}
function printCall(c) {
  console.log(`model ${c.model} · ${c.latencyMs}ms · ${c.usage?.input_tokens ?? '?'} input tokens`);
  if (flags.raw) console.log(JSON.stringify(c.raw?.answers ?? c.answers, null, 2));
}

// ── mode A: hand-written state ──
if (flags.state) {
  const state = readFileSync(flags.state, 'utf8');
  const stub = (names) => Object.fromEntries(names.map((n) => [n, () => n]));
  const siteDecl = flags.site ? normalizeSite({ ...SITES[flags.site], actions: stub(SITES[flags.site].actions) }) : normalizeSite({ actions: {} });
  siteDecl.nouls = siteNouls;
  const questions = buildQuestions(siteDecl, labels);
  hr('state'); console.log(state.trimEnd());
  hr('questions (wire)'); console.log(JSON.stringify(toWire(questions), null, 2));
  const answers = await client.ask(state, questions);
  const axes = normalizeResponse(answers, questions);
  hr('jev'); printCall(calls[0]); printAxes(axes, null);
  if (flags.site) {
    const dep = createDependencyRegistry().get(siteDecl.dependency);
    const { action, rule } = createPolicy()(axes, siteDecl, dep);
    hr('policy'); console.log(`${action}  (rule: ${rule})  site=${flags.site} idempotent=${siteDecl.idempotent} sideEffects=${siteDecl.sideEffects}`);
  }
  process.exit(0);
}

// ── mode B: one live scenario ──
const name = positional.join(' ');
const scenario = SCENARIOS.find((s) => s.name === name);
if (!scenario) { console.error(`unknown scenario "${name}" — try --list`); process.exit(2); }

mkdirSync('.rekurs', { recursive: true });
const sentry = flags['no-gather'] ? null : await startSentry('.rekurs/probe.jsonl');
const jev = createJevDecider({ client, render: renderState, p99Ms: 0, labels });
// extra --noul statements ride along as site nouls (advisory)
const decider = { ...jev, decide: (err, site, ctx) => jev.decide(err, { ...site, nouls: { ...(site.nouls ?? {}), ...siteNouls } }, ctx) };
const decisions = [];
const server = await startFaultServer();
try {
  const results = await runSuite({
    baseUrl: server.url, setFault: (f) => server.setMode(f.mode, f), decider, sentry,
    scenarios: [scenario], sleep: () => Promise.resolve(),
    onDecision: (rec, ctx) => decisions.push({ rec, err: ctx.attempts.at(-1)?.error, call: calls.at(-1) }),
  });
  const { summary } = results.at(-1);

  hr(`scenario: ${scenario.name}`);
  console.log(`site ${scenario.site} ${JSON.stringify(SITES[scenario.site])}`);
  console.log(`fault ${JSON.stringify(scenario.fault)} · gather ${sentry ? 'sentry (offline → .rekurs/probe.jsonl)' : 'none'} · labels ${flags.labels ?? 'default'}`);

  decisions.forEach((d, i) => {
    hr(`attempt ${i + 1}: state text sent to jev`);
    console.log(d.call?.state?.trimEnd() ?? '(no call — decider skipped)');
    if (!d.rec.axes) { hr(`attempt ${i + 1}: decision`); console.log(`${d.rec.action}  (rule: ${d.rec.rule})`); return; }
    hr(`attempt ${i + 1}: jev answers`);
    printCall(d.call);
    const axes = unflatten(d.rec.axes, d.call);
    printAxes(axes, classify(d.err));
    hr(`attempt ${i + 1}: decision`);
    console.log(`${d.rec.action}  (rule: ${d.rec.rule})`);
  });

  hr('outcome');
  console.log(`trail: ${summary.trail.map((a) => `${a.action}/${a.rule}`).join(' → ')}`);
  console.log(`result: ${summary.result} · expected first: ${scenario.expected.action}/${scenario.expected.rule} · expected final: ${scenario.final}`);
  if (flags.save && decisions[0]?.call) { writeFileSync(flags.save, decisions[0].call.state); console.log(`state saved → ${flags.save}`); }
} finally {
  await server.close();
  await sentry?.close?.();
}

/** rebuild the full axes (with distributions) from the captured call rather than the flattened record */
function unflatten(flat, call) {
  return normalizeResponse(call.answers, call.questions);
}
