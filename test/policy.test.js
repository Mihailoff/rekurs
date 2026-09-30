import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/policy.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE, certain } from '../src/axes.js';

const site = (over = {}) => ({
  idempotent: false, sideEffects: true, default: 'abort',
  actions: { retry: () => {}, reconcile: () => {}, degrade: () => {}, abort: () => {} },
  ...over,
});
const axes = (over = {}) => ({
  persistence: certain(PERSISTENCE, 'transient', 0.8),
  locus: certain(LOCUS, 'dependency', 0.8),
  outcome: certain(OUTCOME, 'did_not_happen', 0.9),
  overload: { p: 0.1 },
  scope: certain(SCOPE, 'this_call', 0.7),
  ...over,
});
const dep = () => createDependencyRegistry().get('x');

test('transient + did-not-happen on a side-effecting op retries', () => {
  const r = createPolicy()(axes(), site(), dep());
  assert.deepEqual(r, { action: 'retry', rule: 'transient-retry' });
});

test('unknown outcome on a side-effecting op reconciles, never retries', () => {
  const r = createPolicy()(axes({ outcome: certain(OUTCOME, 'may_have_happened', 0.9) }), site(), dep());
  assert.equal(r.action, 'reconcile');
  assert.equal(r.rule, 'side-effects-unknown-outcome');
});

test('unknown outcome on an idempotent op still retries', () => {
  const r = createPolicy()(axes({ outcome: certain(OUTCOME, 'may_have_happened', 0.9) }), site({ idempotent: true, sideEffects: false }), dep());
  assert.equal(r.action, 'retry');
});

test('overload sheds and trips the breaker when scope is wider than the call', () => {
  const d = dep();
  const r = createPolicy()(axes({ overload: { p: 0.9 }, scope: certain(SCOPE, 'this_dependency', 0.8) }), site(), d);
  assert.equal(r.action, 'degrade');
  assert.equal(r.rule, 'overload');
  assert.equal(d.breaker.isOpen(), true);
});

test('open breaker short-circuits before any perception is read', () => {
  const d = dep();
  d.breaker.trip();
  const r = createPolicy()(axes(), site(), d);
  assert.equal(r.rule, 'breaker-open');
  assert.equal(r.action, 'degrade');
});

test('exhausted retry budget blocks retry', () => {
  const d = dep();
  for (let i = 0; i < 3; i++) d.budget.spend();
  const r = createPolicy()(axes(), site(), d);
  assert.equal(r.rule, 'budget-exhausted');
});

test('bad input aborts', () => {
  const r = createPolicy()(axes({ locus: certain(LOCUS, 'my_input', 0.9), persistence: certain(PERSISTENCE, 'persistent', 0.9) }), site(), dep());
  assert.deepEqual(r, { action: 'abort', rule: 'bad-input' });
});

test('low confidence falls through to default', () => {
  const r = createPolicy()(axes({ persistence: certain(PERSISTENCE, 'transient', 0.3) }), site({ actions: { retry: () => {}, abort: () => {} } }), dep());
  assert.deepEqual(r, { action: 'abort', rule: 'low-confidence' });
});

test('persistent at dependency scope trips the breaker', () => {
  const d = dep();
  const r = createPolicy()(axes({ persistence: certain(PERSISTENCE, 'persistent', 0.9), scope: certain(SCOPE, 'this_dependency', 0.8) }), site(), d);
  assert.equal(r.rule, 'persistent-dependency');
  assert.equal(d.breaker.isOpen(), true);
});

test('preference lists are data', () => {
  const p = createPolicy({ preferences: { unknownOutcome: ['degrade'] } });
  const r = p(axes({ outcome: certain(OUTCOME, 'may_have_happened', 0.9) }), site(), dep());
  assert.equal(r.action, 'degrade');
});
