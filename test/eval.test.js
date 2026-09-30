/**
 * CI eval (design §9): replay the recorded decision fixtures through the real policy and
 * assert every scenario still gets the decision demo/scenarios.js expects. Changing labels,
 * thresholds or preference tables so that a decision flips fails here.
 * Regenerate the fixtures with `npm run demo:record` (see README).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRekurs, RekursError } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createFixtureDecider, parseJsonl } from '../src/decider/fixture.js';
import { createPolicy } from '../src/policy.js';
import { FIXTURE_PATH } from '../demo/app.js';
import { SCENARIOS, SITES, declare, scenario as byName } from '../demo/scenarios.js';

const records = parseJsonl(readFileSync(FIXTURE_PATH, 'utf8'));

/** Rebuild the recorded error: the fields the fingerprint and the policy read. */
function errorFrom(rec) {
  const err = new Error(rec.error.message);
  err.name = rec.error.name;
  if (rec.error.code != null) err.code = rec.error.code;
  if (rec.error.status != null) err.status = rec.error.status;
  return err;
}

/** Stub every menu entry: the first decision is the observation, so nothing loops. */
function stubbed(siteName) {
  const handlers = {};
  for (const a of SITES[siteName].actions) handlers[a] = () => ({ stub: a });
  return declare(siteName, handlers);
}

async function replay(rec, sc) {
  const run = createRekurs({
    // One record per decider: a fingerprint miss throws → decider-unavailable → the assertion fails.
    decider: createFixtureDecider({ records: [rec] }),
    policy: createPolicy(),
    registry: createDependencyRegistry(),
  });
  const err = errorFrom(rec);
  try {
    const out = await run(async () => { throw err; }, stubbed(sc.site));
    return { action: out.action, rule: out.attempts[0].rule };
  } catch (e) {
    assert.ok(e instanceof RekursError, `unexpected ${e}`);
    return { action: e.action, rule: e.trail[0].rule };
  }
}

test('fixtures exist and cover every scenario', () => {
  assert.ok(records.length > 0, 'no fixtures: run npm run demo:record');
  const covered = new Set(records.map((r) => r.scenario));
  for (const sc of SCENARIOS) assert.ok(covered.has(sc.name), `no fixture for scenario "${sc.name}"`);
  for (const r of records) assert.ok(byName(r.scenario), `fixture names unknown scenario "${r.scenario}"`);
});

test('recorded site declarations match the scenario table', () => {
  for (const r of records) {
    const site = SITES[byName(r.scenario).site];
    assert.equal(r.site.dependency, site.dependency, r.scenario);
    assert.equal(r.site.idempotent, site.idempotent, r.scenario);
    assert.equal(r.site.sideEffects, site.sideEffects, r.scenario);
  }
});

for (const [i, rec] of records.entries()) {
  test(`replay #${i + 1} ${rec.scenario}: ${rec.error.name} ${rec.error.status ?? rec.error.code ?? ''}`, async () => {
    const sc = byName(rec.scenario);
    assert.deepEqual(await replay(rec, sc), sc.expected);
  });
}
