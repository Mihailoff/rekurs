/**
 * The demo application: two call sites against the fault server, wrapped once each, with no
 * per-error code. Plus the shared scenario runner used by the demo, the recorder, the
 * Toxiproxy harness and the tests.
 */
import { fileURLToPath } from 'node:url';
import { retry } from '../src/rekurs.js';
import { createRulesDecider } from '../src/decider/rules.js';
import { createJevDecider } from '../src/decider/jev.js';
import { createMockJevClient } from '../src/decider/mock-jev-client.js';
import { createFixtureDecider } from '../src/decider/fixture.js';
import { renderState } from '../src/gather/render.js';
import { requestJson, assertPayload } from './http.js';
import { declare, SCENARIOS } from './scenarios.js';

export const FIXTURE_PATH = fileURLToPath(new URL('../test/fixtures/decisions.jsonl', import.meta.url));
export const DECIDERS = ['mock-jev', 'rules', 'fixture'];

/** The perception provider behind the --decider switch (unguarded; callers add the guard). */
export function buildDecider(kind = 'mock-jev', { fixturePath = FIXTURE_PATH } = {}) {
  switch (kind) {
    case 'rules': return createRulesDecider();
    case 'mock-jev': return createJevDecider({ client: createMockJevClient(), render: renderState, p99Ms: 50 });
    case 'fixture': return createFixtureDecider({ path: fixturePath, fallback: createRulesDecider() });
    default: throw new TypeError(`unknown decider "${kind}" (${DECIDERS.join(' | ')})`);
  }
}

/**
 * createApp({ baseUrl, run, cache }) — `run` is a configured rekurs function.
 * `cache` holds the last good /work payload; it is what degrade serves. `reconcileUrl` is where
 * the charge lookup goes (the Toxiproxy harness points it past the proxy, out of band).
 */
export function createApp({ baseUrl, run, cache = {}, attemptTimeoutMs = 250, sleep, retryMax = 3, reconcileUrl = baseUrl }) {
  const retryAction = retry({ max: retryMax, baseMs: 20, capMs: 200, ...(sleep ? { sleep } : {}) });
  let seq = 0;

  function getWork() {
    return run(
      (signal) => requestJson(baseUrl, '/work', {
        signal,
        timeoutMs: attemptTimeoutMs,
        validate: (v) => assertPayload(v, ['items']),
      }).then((v) => { cache.work = v; return v; }),
      declare('getWork', {
        retry: retryAction,
        degrade: (err) => { if (!cache.work) throw err; return { ...cache.work, stale: true }; },
      }),
    );
  }

  function charge(amount) {
    const key = `charge-${Date.now().toString(36)}-${++seq}`;
    return run(
      (signal) => requestJson(baseUrl, '/charge', {
        method: 'POST', body: { amount }, headers: { 'idempotency-key': key }, signal, timeoutMs: attemptTimeoutMs,
      }),
      declare('charge', {
        retry: retryAction,
        // Unknown outcome: ask the dependency whether the charge happened, never charge twice.
        reconcile: () => requestJson(reconcileUrl, `/charges/${encodeURIComponent(key)}`, { timeoutMs: attemptTimeoutMs }),
      }),
    );
  }

  return { getWork, charge, cache };
}

/** Run one scenario: inject the fault, call the site once, summarize the envelope/trail. */
export async function runScenario({ app, server, scenario, setFault = null }) {
  const inject = setFault ?? ((f) => server.setMode(f.mode, f));
  await inject(scenario.fault);
  let env = null;
  let error = null;
  try {
    env = await (scenario.site === 'charge' ? app.charge(42) : app.getWork());
  } catch (e) {
    error = e;
  } finally {
    await inject({ mode: 'ok' });
  }
  const trail = env?.attempts ?? error?.trail ?? [];
  const action = env ? env.action : (error?.action ?? 'throw');
  const result = env
    ? ({ none: 'ok', degrade: 'cached', reconcile: 'reconciled' }[action] ?? action)
    : (action === 'abort' ? 'aborted' : `failed:${action}`);
  const first = trail[0] ?? null;
  return {
    name: scenario.name,
    site: scenario.site,
    trail: trail.map((a) => ({ action: a.action, rule: a.rule })),
    first: first ? { action: first.action, rule: first.rule } : null,
    action,
    result,
    attempts: trail.length + (result === 'ok' ? 1 : 0),
    degraded: action === 'degrade',
    value: env?.value,
    error: error ? (error.cause ?? error) : null,
  };
}

/** Check a summary against the scenario table. */
export function verdict(summary, scenario) {
  const firstOk = summary.first
    && summary.first.action === scenario.expected.action
    && summary.first.rule === scenario.expected.rule;
  return firstOk && summary.result === scenario.final;
}

/** retry, retry, retry, degrade → "retry×3 → degrade" */
export function compress(list) {
  const out = [];
  for (const x of list) {
    const last = out.at(-1);
    if (last && last.v === x) last.n += 1;
    else out.push({ v: x, n: 1 });
  }
  return out.map(({ v, n }) => (n > 1 ? `${v}×${n}` : v)).join(' → ') || '-';
}

export function formatTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c])))].join('\n');
}

export function tableRow(summary, scenario, deciderName) {
  return {
    scenario: summary.name,
    action: summary.trail.length ? compress(summary.trail.map((a) => a.action)) + (summary.result === 'ok' ? ' → ok' : '') : 'none',
    rule: compress(summary.trail.map((a) => a.rule)),
    attempts: summary.attempts,
    decider: deciderName,
    degraded: summary.degraded ? 'yes' : 'no',
    result: summary.result,
    check: scenario ? (verdict(summary, scenario) ? 'pass' : 'FAIL') : '',
  };
}

export const TABLE_COLUMNS = ['scenario', 'action', 'rule', 'attempts', 'decider', 'degraded', 'result', 'check'];

export { SCENARIOS };
