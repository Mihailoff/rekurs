/**
 * Self-resilience under an outage flood (design §8): a stalled remote decider behind the guard
 * must not slow the wrapper, must not be hammered, and must not grow memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRekurs } from '../src/rekurs.js';
import { createGuardedDecider } from '../src/decider/guarded.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createBoundedSink, createDecisionStats } from '../src/audit/sink.js';

function getGc() {
  if (typeof globalThis.gc === 'function') return globalThis.gc;
  try { v8.setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); } catch { return () => {}; }
}

const TOTAL = 20_000;
const DEPS = 50;
const WAVE = 1_000;

test('20k failing invocations across 50 dependencies with a stalled decider', async () => {
  const gc = getGc();

  // A remote decider in trouble: every call stalls for 5s (timer unref'd so the test can exit).
  const inner = {
    name: 'stalled-jev',
    p99Ms: 50,
    calls: 0,
    decide() {
      this.calls += 1;
      return new Promise((resolve) => { setTimeout(() => resolve(null), 5_000).unref(); });
    },
  };
  const guarded = createGuardedDecider(inner, { cacheMax: 1000 }); // defaults: 20/s burst 40, timeout 100ms
  const sink = createBoundedSink({ max: 10_000 });
  const stats = createDecisionStats({ windowMs: 60_000 });
  const r = createRekurs({
    decider: guarded,
    registry: createDependencyRegistry(),
    onDecision: (rec) => { sink.push(rec); stats.push(rec); },
  });

  const sites = Array.from({ length: DEPS }, (_, i) => ({
    description: `call dep${i}`,
    dependency: `dep${i}`,
    default: 'degrade',
    actions: { degrade: () => 'fallback' },
  }));
  const failing = (i) => async () => { throw Object.assign(new Error(`dep${i} unavailable`), { code: 'ECONNREFUSED' }); };

  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  const t0 = performance.now();

  let nonDefault = 0;
  const rules = new Map();
  for (let start = 0; start < TOTAL; start += WAVE) {
    const wave = [];
    for (let j = start; j < Math.min(TOTAL, start + WAVE); j++) {
      const d = j % DEPS;
      wave.push(r(failing(d), sites[d]));
    }
    for (const out of await Promise.all(wave)) {
      if (out.value !== 'fallback' || out.action !== 'degrade') nonDefault += 1;
      const rule = out.attempts[0].rule;
      rules.set(rule, (rules.get(rule) ?? 0) + 1);
    }
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
  }

  const wallMs = performance.now() - t0;
  gc();
  const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  const peakMb = (heapPeak - heapBefore) / 1024 / 1024;
  const s = guarded.stats();

  console.log(`# load: wall=${wallMs.toFixed(0)}ms innerCalls=${inner.calls} heapGrowth=${heapGrowthMb.toFixed(2)}MB peak=+${peakMb.toFixed(2)}MB`);
  console.log(`# load: blocks=${JSON.stringify(s.blocks)} hits=${s.hits} joined=${s.joined} cache=${s.cacheSize} sink=${sink.size()} dropped=${sink.dropped()}`);
  console.log(`# load: rules=${JSON.stringify(Object.fromEntries(rules))}`);

  // (a) full throughput
  assert.ok(wallMs < 3_000, `wall time ${wallMs}ms`);
  // (b) the decider is consulted a small bounded number of times (≤ burst + a few refills/probes)
  assert.ok(inner.calls <= 60, `inner calls ${inner.calls}`);
  // (c) every invocation fell closed to the default
  assert.equal(nonDefault, 0);
  for (const rule of rules.keys()) assert.match(rule, /^decider-unavailable:(rate-limited|breaker-open|timeout|sampled-out)$/);
  // (d) flat memory: bounded sink + capped cache
  assert.ok(heapGrowthMb < 50, `heap growth ${heapGrowthMb}MB`);
  assert.equal(sink.size(), 10_000);
  assert.equal(sink.dropped(), TOTAL - 10_000);
  assert.ok(s.cacheSize <= 1000);
  assert.equal(s.inflight, 0);

  // The decision distribution is a metric: every dependency shows up, all degraded.
  const snap = stats.snapshot();
  assert.equal(Object.keys(snap).length, DEPS);
  for (const d of Object.values(snap)) {
    assert.equal(d.total, TOTAL / DEPS);
    assert.equal(d.actions.degrade, TOTAL / DEPS);
  }
});
