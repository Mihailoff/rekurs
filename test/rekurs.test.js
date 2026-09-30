import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRekurs, retry, RETRY, RekursError, TimeoutError } from '../src/rekurs.js';
import { createFixedDecider } from '../src/decider/fixed.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE, certain } from '../src/axes.js';

const transient = () => ({
  persistence: certain(PERSISTENCE, 'transient', 0.8), locus: certain(LOCUS, 'dependency', 0.8),
  outcome: certain(OUTCOME, 'did_not_happen', 0.9), overload: { p: 0.1 }, scope: certain(SCOPE, 'this_call', 0.7),
});
const fresh = (opts = {}) => createRekurs({ registry: createDependencyRegistry(), ...opts });
const noSleep = () => Promise.resolve();

test('success returns an envelope with action none', async () => {
  const r = fresh();
  const out = await r(async () => 42, { idempotent: true, actions: {} });
  assert.deepEqual(out, { value: 42, action: 'none', attempts: [], degraded: false });
});

test('rules decider: ECONNREFUSED retries then succeeds', async () => {
  const r = fresh();
  let n = 0;
  const out = await r(async () => { if (n++ < 2) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); return 'ok'; },
    { idempotent: true, dependency: 'svc', actions: { retry: retry({ sleep: noSleep }) } });
  assert.equal(out.value, 'ok');
  assert.equal(out.attempts.length, 2);
  assert.equal(out.attempts[0].rule, 'transient-retry');
});

test('rules decider: timeout on a side-effecting call reconciles, does not retry', async () => {
  const r = fresh();
  let calls = 0;
  const out = await r(async () => { calls++; await new Promise((res) => setTimeout(res, 50)); },
    { deadlineMs: 10, dependency: 'pay', actions: { retry: retry({ sleep: noSleep }), reconcile: () => 'looked-up' } });
  assert.equal(calls, 1);
  assert.equal(out.action, 'reconcile');
  assert.equal(out.degraded, true);
  assert.ok(out.attempts[0].error instanceof TimeoutError);
});

test('401 aborts and the thrown error carries the trail', async () => {
  const r = fresh();
  await assert.rejects(
    r(async () => { throw Object.assign(new Error('nope'), { status: 401 }); }, { actions: { retry: retry({ sleep: noSleep }) } }),
    (e) => e instanceof RekursError && e.action === 'abort' && e.trail.length === 1 && e.cause.status === 401,
  );
});

test('decider unavailable falls closed to default', async () => {
  const decider = createFixedDecider(new Error('jev down'));
  const r = fresh({ decider });
  const out = await r(async () => { throw new Error('x'); }, { default: 'degrade', actions: { degrade: () => 'cached' } });
  assert.equal(out.value, 'cached');
  assert.equal(out.attempts[0].rule, 'decider-unavailable');
});

test('thin deadline skips the decider', async () => {
  const decider = createFixedDecider(transient(), { p99Ms: 500 });
  const r = fresh({ decider });
  const out = await r(async () => { throw new Error('x'); }, { deadlineMs: 100, default: 'degrade', actions: { degrade: () => 'd' } });
  assert.equal(decider.calls, 0);
  assert.equal(out.attempts[0].rule, 'deadline');
});

test('retry helper gives up after max and rethrows', async () => {
  const r = fresh({ decider: createFixedDecider(transient()) });
  await assert.rejects(
    r(async () => { throw new Error('always'); }, { idempotent: true, actions: { retry: retry({ max: 2, sleep: noSleep }) } }),
    (e) => e instanceof RekursError && e.trail.length === 3,
  );
});

test('onDecision receives an audit record with flattened axes', async () => {
  const records = [];
  const r = fresh({ decider: createFixedDecider(transient()), onDecision: (x) => records.push(x) });
  await r(async () => { throw new Error('x'); }, { idempotent: true, dependency: 'd', actions: { retry: async () => 'gave-up' } });
  assert.equal(records.length, 1);
  assert.equal(records[0].rule, 'transient-retry');
  assert.equal(records[0].axes['persistence.pick'], 'transient');
});

test('max attempts guard ends the loop', async () => {
  const r = fresh({ decider: createFixedDecider(transient()) });
  let n = 0;
  await assert.rejects(
    r(async () => { n++; throw new Error('x'); }, { idempotent: true, maxAttempts: 3, actions: { retry: async () => RETRY } }),
    (e) => e.trail.at(-1).rule === 'max-attempts',
  );
  assert.equal(n, 4);
});
