import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../src/fingerprint.js';

test('same line, different status → different fingerprint', () => {
  const mk = (status) => Object.assign(new Error('http'), { status });
  const a = mk(503); const b = mk(401);
  assert.notEqual(fingerprint(a, { dependency: 'x' }), fingerprint(b, { dependency: 'x' }));
});
test('same error shape → same fingerprint', () => {
  const mk = () => Object.assign(new Error('x'), { code: 'ECONNRESET' });
  assert.equal(fingerprint(mk()).split('|').slice(0, 4).join('|'), fingerprint(mk()).split('|').slice(0, 4).join('|'));
});
