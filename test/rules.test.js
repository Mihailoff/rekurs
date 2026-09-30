import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/decider/rules.js';
import { TimeoutError } from '../src/rekurs.js';

const http = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('timeout: transient, outcome unknown', () => {
  const a = classify(new TimeoutError(100));
  assert.equal(a.persistence.pick, 'transient');
  assert.equal(a.outcome.pick, 'may_have_happened');
});
test('ECONNREFUSED: transient, did not happen', () => {
  const a = classify(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
  assert.equal(a.persistence.pick, 'transient');
  assert.equal(a.outcome.pick, 'did_not_happen');
});
test('429: overload', () => assert.ok(classify(http(429)).overload.p > 0.9));
test('503: transient dependency', () => assert.equal(classify(http(503)).locus.pick, 'dependency'));
test('401: persistent, my input', () => {
  const a = classify(http(401));
  assert.equal(a.persistence.pick, 'persistent');
  assert.equal(a.locus.pick, 'my_input');
});
test('unknown error: low confidence everywhere', () => {
  const a = classify(new Error('???'));
  assert.ok(a.persistence.conf < 0.5);
});
