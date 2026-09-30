import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedDecider, DeciderGuardError } from '../src/decider/guarded.js';
import { createFixedDecider } from '../src/decider/fixed.js';
import { createRekurs } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE, certain } from '../src/axes.js';

const AXES = {
  persistence: certain(PERSISTENCE, 'transient', 0.8), locus: certain(LOCUS, 'dependency', 0.8),
  outcome: certain(OUTCOME, 'did_not_happen', 0.9), overload: { p: 0.1 }, scope: certain(SCOPE, 'this_call', 0.7),
};

function clock(t = 1_000_000) {
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const err = (code = 'ECONNRESET') => Object.assign(new Error('boom'), { code });
const site = (dependency = 'svc') => ({ dependency });
const isGuard = (code) => (e) => e instanceof DeciderGuardError && e.code === code;

/** An inner decider whose calls stay pending until resolved by hand. */
function manualInner({ p99Ms = 0 } = {}) {
  const pending = [];
  return {
    name: 'manual', p99Ms, calls: 0, pending,
    decide() { this.calls += 1; return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  };
}

// Generous defaults so each test exercises one guard in isolation.
const loose = { rateLimit: { perSecond: 1e6, burst: 1e6 }, sampleAbove: Infinity, timeoutMs: Infinity };

test('cache hit never calls inner', async () => {
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  assert.equal(await g.decide(err(), site()), AXES);
  assert.equal(await g.decide(err(), site()), AXES);
  assert.equal(await g.decide(err(), site()), AXES);
  assert.equal(inner.calls, 1);
  const s = g.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.innerCalls, 1);
  assert.equal(s.cacheSize, 1);
});

test('cache keys on the fingerprint: different dependency or code is a different key', async () => {
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  await g.decide(err('A'), site('x'));
  await g.decide(err('A'), site('y'));
  await g.decide(err('B'), site('x'));
  assert.equal(inner.calls, 3);
});

test('cache TTL expires entries', async () => {
  const now = clock();
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { ...loose, now, cacheTtlMs: 1000 });
  await g.decide(err(), site());
  now.advance(999);
  await g.decide(err(), site());
  assert.equal(inner.calls, 1);
  now.advance(1);
  await g.decide(err(), site());
  assert.equal(inner.calls, 2);
});

test('cache is LRU-capped', async () => {
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { ...loose, now: clock(), cacheMax: 2 });
  await g.decide(err(), site('a'));
  await g.decide(err(), site('b'));
  await g.decide(err(), site('a')); // touch a → b is now least recent
  await g.decide(err(), site('c')); // evicts b
  assert.equal(g.stats().cacheSize, 2);
  assert.equal(inner.calls, 3);
  await g.decide(err(), site('a'));
  assert.equal(inner.calls, 3, 'a survived');
  await g.decide(err(), site('b'));
  assert.equal(inner.calls, 4, 'b was evicted');
});

test('null/empty decisions are not cached', async () => {
  const inner = createFixedDecider(() => null);
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  assert.equal(await g.decide(err(), site()), null);
  await g.decide(err(), site());
  assert.equal(inner.calls, 2);
});

test('single-flight: concurrent misses for one key share one inner call', async () => {
  const inner = manualInner();
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  const ps = Array.from({ length: 25 }, () => g.decide(err(), site()));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(inner.calls, 1);
  inner.pending[0].resolve(AXES);
  const out = await Promise.all(ps);
  assert.ok(out.every((a) => a === AXES));
  assert.equal(g.stats().joined, 24);
  assert.equal(g.stats().inflight, 0);
  await g.decide(err(), site());
  assert.equal(inner.calls, 1, 'result was cached');
});

test('single-flight: a shared failure rejects every waiter, and the next miss retries', async () => {
  const inner = manualInner();
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  const ps = Array.from({ length: 3 }, () => g.decide(err(), site()));
  await Promise.resolve();
  await Promise.resolve();
  inner.pending[0].reject(new Error('jev 500'));
  for (const p of ps) await assert.rejects(p, /jev 500/);
  const p2 = g.decide(err(), site());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(inner.calls, 2);
  inner.pending[1].resolve(AXES);
  assert.equal(await p2, AXES);
});

test('rate limit: token bucket blocks inner calls beyond burst, refills over time', async () => {
  const now = clock();
  const inner = createFixedDecider(() => null); // never cached, so every call is a miss
  const g = createGuardedDecider(inner, { ...loose, now, rateLimit: { perSecond: 2, burst: 3 } });
  for (let i = 0; i < 3; i++) await g.decide(err(), site(`d${i}`));
  await assert.rejects(g.decide(err(), site('d3')), isGuard('rate-limited'));
  assert.equal(inner.calls, 3);
  now.advance(500); // +1 token
  await g.decide(err(), site('d4'));
  await assert.rejects(g.decide(err(), site('d5')), isGuard('rate-limited'));
  assert.equal(inner.calls, 4);
  assert.equal(g.stats().blocks['rate-limited'], 2);
});

test('breaker: inner errors open it; while open inner is not called; cooldown admits one probe', async () => {
  const now = clock();
  let fail = true;
  const inner = { name: 'flaky', p99Ms: 0, calls: 0, async decide() { this.calls += 1; if (fail) throw new Error('down'); return AXES; } };
  const g = createGuardedDecider(inner, { ...loose, now, breaker: { failureThreshold: 3, cooldownMs: 1000 } });
  for (let i = 0; i < 3; i++) await assert.rejects(g.decide(err(), site(`k${i}`)), /down/);
  assert.equal(g.stats().breaker, 'open');
  await assert.rejects(g.decide(err(), site('k9')), isGuard('breaker-open'));
  assert.equal(inner.calls, 3);
  now.advance(1000);
  fail = false;
  assert.equal(await g.decide(err(), site('k9')), AXES);
  assert.equal(inner.calls, 4);
  assert.equal(g.stats().breaker, 'closed');
});

test('breaker half-open admits a single probe while it is in flight', async () => {
  const now = clock();
  const inner = manualInner();
  const g = createGuardedDecider(inner, { ...loose, now, breaker: { failureThreshold: 1, cooldownMs: 100 } });
  const first = g.decide(err(), site('a'));
  await Promise.resolve(); await Promise.resolve();
  inner.pending[0].reject(new Error('down'));
  await assert.rejects(first);
  now.advance(100);
  const probe = g.decide(err(), site('b'));
  await assert.rejects(g.decide(err(), site('c')), isGuard('breaker-open'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(inner.calls, 2);
  inner.pending[1].resolve(AXES);
  assert.equal(await probe, AXES);
});

test('timeout: a stalled inner is abandoned with a timeout guard error and counts toward the breaker', async () => {
  const inner = manualInner({ p99Ms: 10 });
  const g = createGuardedDecider(inner, { rateLimit: { perSecond: 1e6, burst: 1e6 }, sampleAbove: Infinity, breaker: { failureThreshold: 2 } });
  const t0 = Date.now();
  await assert.rejects(g.decide(err(), site('a')), isGuard('timeout'));
  assert.ok(Date.now() - t0 < 500, 'default timeout is p99Ms * 2');
  await assert.rejects(g.decide(err(), site('b')), isGuard('timeout'));
  assert.equal(g.stats().breaker, 'open');
  await assert.rejects(g.decide(err(), site('c')), isGuard('breaker-open'));
  assert.equal(inner.calls, 2);
  assert.equal(g.stats().blocks.timeout, 2);
});

test('guarded decider keeps the decider interface (name, p99Ms from inner)', () => {
  const g = createGuardedDecider(createFixedDecider(AXES, { p99Ms: 300 }));
  assert.equal(g.p99Ms, 300);
  assert.equal(g.name, 'guarded(fixed)');
  assert.equal(typeof g.decide, 'function');
});

test('an explicit timeoutMs overrides the p99-derived default', async () => {
  const inner = manualInner({ p99Ms: 10_000 });
  const g = createGuardedDecider(inner, { ...loose, timeoutMs: 20 });
  await assert.rejects(g.decide(err(), site()), isGuard('timeout'));
});

test('sampling: above the failure-rate threshold only every Nth miss consults inner', async () => {
  const now = clock();
  const inner = createFixedDecider(() => null);
  const g = createGuardedDecider(inner, {
    now, rateLimit: { perSecond: 1e6, burst: 1e6 }, timeoutMs: Infinity,
    sampleAbove: 5, sampleRate: 4, sampleWindowMs: 1000,
  });
  // Below threshold: all consult inner.
  for (let i = 0; i < 5; i++) await g.decide(err(), site(`s${i}`));
  assert.equal(inner.calls, 5);
  // Above threshold: 1 in 4.
  let sampled = 0;
  for (let i = 0; i < 40; i++) {
    try { await g.decide(err(), site(`t${i}`)); } catch (e) { assert.ok(isGuard('sampled-out')(e)); sampled += 1; }
  }
  assert.equal(inner.calls, 5 + 10);
  assert.equal(sampled, 30);
  // Load subsides once the window slides past.
  now.advance(2000);
  await g.decide(err(), site('u'));
  assert.equal(inner.calls, 16);
});

test('cache hits bypass sampling and every other guard', async () => {
  const now = clock();
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { now, rateLimit: { perSecond: 0, burst: 1 }, sampleAbove: 0, sampleRate: 1, timeoutMs: Infinity });
  await g.decide(err(), site());
  for (let i = 0; i < 100; i++) assert.equal(await g.decide(err(), site()), AXES);
  assert.equal(inner.calls, 1);
});

test('reset clears cache, counters, and breaker', async () => {
  const inner = createFixedDecider(AXES);
  const g = createGuardedDecider(inner, { ...loose, now: clock() });
  await g.decide(err(), site());
  g.reset();
  const s = g.stats();
  assert.equal(s.cacheSize, 0);
  assert.equal(s.innerCalls, 0);
  assert.equal(s.breaker, 'closed');
  await g.decide(err(), site());
  assert.equal(inner.calls, 2);
});

test('wrapper falls closed with rule decider-unavailable:<code> on a guard block', async () => {
  const now = clock();
  const inner = createFixedDecider(() => null);
  const guarded = createGuardedDecider(inner, { ...loose, now, rateLimit: { perSecond: 0, burst: 0 } });
  const r = createRekurs({ decider: guarded, registry: createDependencyRegistry() });
  const out = await r(async () => { throw new Error('x'); }, { default: 'degrade', actions: { degrade: () => 'cached' } });
  assert.equal(out.value, 'cached');
  assert.equal(out.attempts[0].rule, 'decider-unavailable:rate-limited');
  assert.equal(inner.calls, 0);
});

test('requires an inner decider', () => {
  assert.throws(() => createGuardedDecider(null), TypeError);
});
