#!/usr/bin/env node
/**
 * One-shot eval: run the demo scenarios against the REAL Jev classifier and print, per failure,
 * what Jev perceived on each axis next to the rules baseline and the policy's decision.
 *
 *   JEV_KEY=... node scripts/jev-eval.js [--show-state] [--model=jev-latest]
 *
 * Reads .env if present. Writes every (state, questions, answers) triple to .rekurs/jev-eval.jsonl.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { createJevHttpClient } from '../src/decider/jev-http-client.js';
import { createJevDecider } from '../src/decider/jev.js';
import { classify } from '../src/decider/rules.js';
import { renderState } from '../src/gather/render.js';
import { startFaultServer } from '../demo/fault-server.js';
import { runSuite } from '../demo/index.js';
import { SCENARIOS } from '../demo/scenarios.js';
import { formatTable, verdict } from '../demo/app.js';

try { process.loadEnvFile('.env'); } catch { /* no .env */ }
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));

const OUT = '.rekurs/jev-eval.jsonl';
mkdirSync('.rekurs', { recursive: true });

const http = createJevHttpClient({ model: args.model ?? 'jev-latest' });
const calls = [];
const client = {
  async ask(state, questions) {
    const answers = await http.ask(state, questions);
    calls.push({ state, questions, answers, ...http.last });
    appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), state, questions, answers, model: http.last.model, usage: http.last.usage, latencyMs: http.last.latencyMs }) + '\n');
    return answers;
  },
};
const LABEL_VARIANTS = {
  examples: {
    persistence: {
      transient: 'a passing condition such as a timeout, a connection reset, a 5xx service error, or rate limiting: the same call is likely to succeed if repeated shortly',
      persistent: 'a standing condition such as bad input, missing credentials, a wrong URL, or a broken configuration: repeating the same call will keep failing until something changes',
      unknown: 'the failure fits neither pattern and could go either way',
    },
  },
};
const labels = LABEL_VARIANTS[args.labels] ?? {};
const decider = createJevDecider({ client, render: renderState, p99Ms: 0, labels });

// Pair each decision with the error it was about, so we can show the rules baseline beside it.
const decisions = [];
const onDecision = (rec, ctx) => decisions.push({ rec, err: ctx.attempts.at(-1)?.error, call: calls.at(-1) });

const server = await startFaultServer();
const fmt = (ax) => `${ax.pick} ${ax.conf.toFixed(2)}`;
try {
  const results = await runSuite({
    baseUrl: server.url, setFault: (f) => server.setMode(f.mode, f), decider, sentry: null,
    sleep: () => Promise.resolve(), onDecision,
  });

  const rows = [];
  let d = 0;
  for (const { summary, scenario } of results) {
    if (!scenario) continue;
    const first = decisions[d];
    // advance past all decisions this scenario produced
    d += summary.trail.length;
    if (!first?.rec.axes) {
      rows.push({ scenario: scenario.name, jev: '(no decision)' });
      continue;
    }
    const jev = first.call;
    const rules = classify(first.err);
    const a = first.rec.axes;
    const diff = ['persistence', 'locus', 'outcome', 'scope']
      .filter((ax) => a[`${ax}.pick`] !== rules[ax].pick)
      .map((ax) => `${ax}: rules=${rules[ax].pick}`)
      .concat(Math.abs(a['overload.p'] - rules.overload.p) > 0.3 ? [`overload: rules=${rules.overload.p.toFixed(2)}`] : [])
      .join(', ') || '-';
    rows.push({
      scenario: scenario.name,
      persistence: `${a['persistence.pick']} ${a['persistence.conf'].toFixed(2)}`,
      locus: `${a['locus.pick']} ${a['locus.conf'].toFixed(2)}`,
      outcome: `${a['outcome.pick']} ${a['outcome.conf'].toFixed(2)}`,
      overload: a['overload.p'].toFixed(2),
      scope: `${a['scope.pick']} ${a['scope.conf'].toFixed(2)}`,
      decision: `${first.rec.action}/${first.rec.rule}`,
      expected: `${scenario.expected.action}/${scenario.expected.rule}`,
      ok: verdict(summary, scenario) ? 'pass' : 'FAIL',
      'vs rules': diff,
      ms: jev?.latencyMs ?? '',
      tokens: jev?.usage?.input_tokens ?? '',
    });
  }

  console.log(`jev eval · model ${calls[0]?.model ?? '?'} · labels ${args.labels ?? 'default'} · ${calls.length} calls · log ${OUT}\n`);
  console.log(formatTable(rows, ['scenario', 'persistence', 'locus', 'outcome', 'overload', 'scope', 'decision', 'expected', 'ok', 'vs rules', 'ms', 'tokens']));

  const lat = calls.map((c) => c.latencyMs).sort((x, y) => x - y);
  const tok = calls.reduce((s, c) => s + (c.usage?.input_tokens ?? 0), 0);
  console.log(`\nlatency p50=${lat[Math.floor(lat.length / 2)]}ms max=${lat.at(-1)}ms · input tokens ${tok} total`);

  if (args['show-state']) {
    const sample = calls.find((c) => c.state.includes('/charge')) ?? calls[0];
    console.log('\n── state text sent to Jev (sample) ──\n' + sample.state + '\n── end ──');
  }
} finally {
  await server.close();
}
