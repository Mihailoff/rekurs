import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedSink, createDecisionStats } from '../src/audit/sink.js';
import { createRekurs } from '../src/rekurs.js';
import { createFixedDecider } from '../src/decider/fixed.js';
import { createDependencyRegistry } from '../src/state/dependency.js';

function clock(t = 1_000_000) {
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('bounded sink buffers in order and drains', () => {
  const s = createBoundedSink({ max: 3 });
  s.push(1); s.push(2);
  assert.equal(s.size(), 2);
  assert.deepEqual(s.drain(), [1, 2]);
  assert.equal(s.size(), 0);
  assert.deepEqual(s.drain(), []);
});

test('bounded sink drops the oldest on overflow and reports it', () => {
  const dropped = [];
  const s = createBoundedSink({ max: 3, onDrop: (r) => dropped.push(r) });
  for (let i = 1; i <= 7; i++) s.push(i);
  assert.equal(s.size(), 3);
  assert.equal(s.dropped(), 4);
  assert.deepEqual(dropped, [1, 2, 3, 4]);
  assert.deepEqual(s.drain(), [5, 6, 7]);
  s.push(8);
  assert.deepEqual(s.drain(), [8]);
});

test('bounded sink: a throwing onDrop never reaches the caller', () => {
  const s = createBoundedSink({ max: 1, onDrop: () => { throw new Error('bad'); } });
  s.push(1);
  assert.doesNotThrow(() => s.push(2));
  assert.deepEqual(s.drain(), [2]);
});

test('bounded sink rejects a non-positive max', () => {
  assert.throws(() => createBoundedSink({ max: 0 }), TypeError);
});

test('bounded sink works as an onDecision target', async () => {
  const sink = createBoundedSink({ max: 2 });
  const r = createRekurs({ decider: createFixedDecider(new Error('down')), registry: createDependencyRegistry(), onDecision: sink.push });
  for (let i = 0; i < 5; i++) await r(async () => { throw new Error('x'); }, { dependency: 'db', default: 'degrade', actions: { degrade: () => null } });
  assert.equal(sink.size(), 2);
  assert.equal(sink.dropped(), 3);
  const [rec] = sink.drain();
  assert.equal(rec.dependency, 'db');
  assert.equal(rec.action, 'degrade');
  assert.equal(rec.rule, 'decider-unavailable');
});

test('decision stats fold actions and rules per dependency', () => {
  const now = clock();
  const st = createDecisionStats({ windowMs: 10_000, now });
  st.push({ dependency: 'db', action: 'retry', rule: 'transient-retry' });
  st.push({ dependency: 'db', action: 'degrade', rule: 'decider-unavailable:breaker-open' });
  st.push({ dependency: 'db', action: 'degrade', rule: 'decider-unavailable:breaker-open' });
  st.push({ dependency: 'pay', action: 'abort', rule: 'my-input' });
  assert.deepEqual(st.snapshot(), {
    db: { total: 3, actions: { retry: 1, degrade: 2 }, rules: { 'transient-retry': 1, 'decider-unavailable:breaker-open': 2 } },
    pay: { total: 1, actions: { abort: 1 }, rules: { 'my-input': 1 } },
  });
});

test('decision stats slide: old records age out of the window', () => {
  const now = clock(0);
  const st = createDecisionStats({ windowMs: 1000, buckets: 10, now });
  st.push({ dependency: 'db', action: 'retry', rule: 'r' });
  now.advance(600);
  st.push({ dependency: 'db', action: 'degrade', rule: 'd' });
  assert.equal(st.snapshot().db.total, 2);
  now.advance(500); // first record is now 1100ms old
  assert.deepEqual(st.snapshot().db, { total: 1, actions: { degrade: 1 }, rules: { d: 1 } });
  now.advance(1000);
  assert.deepEqual(st.snapshot(), {});
});

test('decision stats memory is bounded by buckets, not volume', () => {
  const now = clock(0);
  const st = createDecisionStats({ windowMs: 1000, buckets: 4, now });
  for (let i = 0; i < 50_000; i++) { st.push({ dependency: `d${i % 5}`, action: 'degrade', rule: 'x' }); if (i % 1000 === 0) now.advance(10); }
  const snap = st.snapshot();
  assert.equal(Object.keys(snap).length, 5);
  st.reset();
  assert.deepEqual(st.snapshot(), {});
});
