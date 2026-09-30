/**
 * The full in-process pipeline: fault server → fetch → rekurs (rules decider) → policy →
 * actions, for the core faults of the prototype scope. No Sentry, loopback only, no real sleeps.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRekurs } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createRulesDecider } from '../src/decider/rules.js';
import { startFaultServer } from '../demo/fault-server.js';
import { createApp, runScenario } from '../demo/app.js';
import { CORE, SCENARIOS, scenario } from '../demo/scenarios.js';

let server;
const cache = {};
const noSleep = () => Promise.resolve();

const appFor = () => createApp({
  baseUrl: server.url,
  run: createRekurs({ decider: createRulesDecider(), registry: createDependencyRegistry() }),
  cache,
  sleep: noSleep,
  attemptTimeoutMs: 100,
});

before(async () => {
  server = await startFaultServer();
  const warm = await runScenario({ app: appFor(), server, scenario: { name: 'warm', site: 'getWork', fault: { mode: 'ok' } } });
  assert.equal(warm.result, 'ok');
});
after(() => server.close());

for (const name of CORE) {
  test(`pipeline: ${name}`, async () => {
    const sc = scenario(name);
    const s = await runScenario({ app: appFor(), server, scenario: sc });
    assert.deepEqual(s.first, sc.expected);
    assert.equal(s.result, sc.final);
  });
}

test('pipeline: GET timeout retries, then returns the live value', async () => {
  const s = await runScenario({ app: appFor(), server, scenario: scenario('timeout GET') });
  assert.equal(s.action, 'none');
  assert.ok(Array.isArray(s.value.items) && !s.value.stale);
});

test('pipeline: POST timeout reconciles to the charge the server recorded, never charges twice', async () => {
  const n = server.charges.size;
  const s = await runScenario({ app: appFor(), server, scenario: scenario('timeout POST') });
  assert.equal(s.value.status, 'captured');
  assert.equal(server.charges.size, n + 1);
});

test('pipeline: malformed 200 degrades to the cached value', async () => {
  const s = await runScenario({ app: appFor(), server, scenario: scenario('malformed') });
  assert.equal(s.value.stale, true);
  assert.equal(s.trail[0].rule, 'low-confidence');
});

test('pipeline: every scenario in the table matches on the rules decider', async () => {
  for (const sc of SCENARIOS) {
    const s = await runScenario({ app: appFor(), server, scenario: sc });
    assert.deepEqual({ first: s.first, result: s.result }, { first: sc.expected, result: sc.final }, sc.name);
  }
});
