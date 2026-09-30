/**
 * rekurs demo: one flaky dependency, two wrapped call sites, no per-error code.
 *
 *   node demo/index.js [--decider=mock-jev|rules|fixture] [--no-sentry]
 *
 * Pipeline: Sentry gather (offline, JSONL to .rekurs/demo.jsonl) → guarded → decider → policy
 * → actions. Each scenario injects one fault into the in-process fault server, calls the site
 * once, and reports what the pipeline did. Exits 1 if any scenario deviates from
 * demo/scenarios.js, so it doubles as a CI smoke test.
 */
import { pathToFileURL } from 'node:url';
import { createRekurs } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createGuardedDecider } from '../src/decider/guarded.js';
import { createBoundedSink, createDecisionStats } from '../src/audit/sink.js';
import { startFaultServer } from './fault-server.js';
import {
  buildDecider, createApp, runScenario, tableRow, formatTable, TABLE_COLUMNS, SCENARIOS, verdict,
} from './app.js';

export const JSONL_PATH = '.rekurs/demo.jsonl';

/** Try to start the offline Sentry gatherer; null if @sentry/node is not installed. */
export async function startSentry(jsonlPath = JSONL_PATH) {
  try {
    const { createSentryGather } = await import('../src/gather/sentry.js');
    return await createSentryGather({ jsonlPath });
  } catch (e) {
    if (e?.code === 'REKURS_SENTRY_MISSING') return null;
    throw e;
  }
}

/**
 * Run the scenario list against `baseUrl`. Each scenario gets fresh dependency state (breaker,
 * retry budget) so rows are independent; the decider (and its guard cache) is shared.
 */
export async function runSuite({
  baseUrl, setFault, decider, sentry = null, scenarios = SCENARIOS, sleep, attemptTimeoutMs = 250, onDecision = null, appOptions = {},
}) {
  const cache = {};
  const build = () => {
    const r = createRekurs({
      decider,
      registry: createDependencyRegistry(),
      gather: sentry?.gather ?? null,
      onDecision: (rec, ctx) => { sentry?.annotate(rec, ctx); onDecision?.(rec, ctx); },
    });
    return sentry ? sentry.wrap(r) : r;
  };

  // Warm-up: a healthy call fills the cache that degrade serves.
  const warm = await runScenario({
    app: createApp({ baseUrl, run: build(), cache, sleep, attemptTimeoutMs, ...appOptions }),
    setFault,
    scenario: { name: 'ok (warm-up)', site: 'getWork', fault: { mode: 'ok' } },
  });
  const results = [{ summary: warm, scenario: null }];
  for (const scenario of scenarios) {
    const app = createApp({ baseUrl, run: build(), cache, sleep, attemptTimeoutMs, ...appOptions });
    results.push({ summary: await runScenario({ app, setFault, scenario }), scenario });
  }
  return results;
}

/** 500 concurrent failing calls while the decider is stalled: everything must fall closed. */
export async function runStorm({ baseUrl, setFault, innerName, count = 500 }) {
  const stalled = {
    name: `stalled(${innerName})`,
    p99Ms: 50,
    decide: () => new Promise((resolve) => { setTimeout(() => resolve(null), 5_000).unref(); }),
  };
  const guarded = createGuardedDecider(stalled); // timeout 100ms, 20/s burst 40, sampling above 100/s
  const stats = createDecisionStats({ windowMs: 60_000 });
  const sink = createBoundedSink({ max: 1_000 });
  const run = createRekurs({
    decider: guarded,
    registry: createDependencyRegistry(),
    onDecision: (rec) => { stats.push(rec); sink.push(rec); },
  });
  const app = createApp({ baseUrl, run, cache: { work: { items: [], cached: true } } });

  await setFault({ mode: '503' });
  const t0 = performance.now();
  const outs = await Promise.all(Array.from({ length: count }, () => app.getWork().catch((e) => e)));
  const wallMs = performance.now() - t0;
  await setFault({ mode: 'ok' });

  const nonDefault = outs.filter((o) => !(o && o.action === 'degrade')).length;
  const rules = {};
  for (const o of outs) { const r = o?.attempts?.[0]?.rule ?? o?.trail?.[0]?.rule ?? 'none'; rules[r] = (rules[r] ?? 0) + 1; }
  const allUnavailable = Object.keys(rules).every((r) => r.startsWith('decider-unavailable:'));
  return { count, wallMs, nonDefault, rules, allUnavailable, guard: guarded.stats(), innerCalls: guarded.stats().innerCalls, distribution: stats.snapshot(), sink: { size: sink.size(), dropped: sink.dropped() } };
}

function parseArgs(argv) {
  const opts = { decider: 'mock-jev', sentry: true };
  for (const a of argv) {
    if (a.startsWith('--decider=')) opts.decider = a.slice('--decider='.length);
    else if (a === '--no-sentry') opts.sentry = false;
    else if (a === '-h' || a === '--help') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node demo/index.js [--decider=mock-jev|rules|fixture] [--no-sentry]');
    return 0;
  }
  const server = await startFaultServer();
  const setFault = (f) => server.setMode(f.mode, f);
  const inner = buildDecider(opts.decider);
  const decider = createGuardedDecider(inner);
  const sentry = opts.sentry ? await startSentry() : null;

  const t0 = performance.now();
  let failed = 0;
  try {
    const results = await runSuite({ baseUrl: server.url, setFault, decider, sentry });
    const rows = results.map(({ summary, scenario }) => tableRow(summary, scenario, decider.name));
    failed += results.filter(({ summary, scenario }) => scenario && !verdict(summary, scenario)).length;

    const storm = await runStorm({ baseUrl: server.url, setFault, innerName: inner.name });
    const stormOk = storm.nonDefault === 0 && storm.allUnavailable;
    if (!stormOk) failed += 1;
    rows.push({
      scenario: `storm ×${storm.count}`,
      action: `degrade ×${storm.count - storm.nonDefault}`,
      rule: Object.entries(storm.rules).map(([r, n]) => `${r.replace('decider-unavailable:', 'unavailable:')}×${n}`).join(' '),
      attempts: storm.count,
      decider: `guarded(${`stalled(${inner.name})`})`,
      degraded: 'yes',
      result: 'default',
      check: stormOk ? 'pass' : 'FAIL',
    });

    console.log(`rekurs demo · fault server ${server.url} · decider ${decider.name} · gather ${sentry ? `sentry (offline → ${JSONL_PATH})` : 'none'}`);
    console.log('');
    console.log(formatTable(rows, TABLE_COLUMNS));
    console.log('');
    console.log(`storm: ${storm.count} concurrent failing calls in ${storm.wallMs.toFixed(0)}ms, decider consulted ${storm.innerCalls}×`);
    const g = storm.guard;
    console.log(`  guard stats: hits=${g.hits} misses=${g.misses} joined=${g.joined} innerCalls=${g.innerCalls} innerErrors=${g.innerErrors} breaker=${g.breaker} blocks=${JSON.stringify(g.blocks)}`);
    for (const [dep, d] of Object.entries(storm.distribution)) {
      console.log(`  decision distribution [${dep}]: total=${d.total} actions=${JSON.stringify(d.actions)} rules=${JSON.stringify(d.rules)}`);
    }
    console.log('');
    console.log(`${failed === 0 ? 'all scenarios matched demo/scenarios.js' : `${failed} scenario(s) deviated from demo/scenarios.js`} · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  } finally {
    await sentry?.close();
    await server.close();
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
