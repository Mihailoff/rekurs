/**
 * The layer must not fail exactly when it is needed (design §8).
 *
 * createGuardedDecider(inner) wraps a (remote, slow, costly) decider so that a flood of failures
 * during an outage keeps the wrapper at full throughput with flat memory:
 *   cache (per-fingerprint, TTL + LRU) → single-flight → sampling under load → breaker on the
 *   decider → token-bucket rate limit → timeout on the inner call.
 * Any guard that blocks the call throws DeciderGuardError; the wrapper falls closed to
 * site.default with rule `decider-unavailable:<code>`.
 */
import { fingerprint } from '../fingerprint.js';
import { createBreaker } from '../state/dependency.js';

export const GUARD_CODES = Object.freeze(['rate-limited', 'breaker-open', 'timeout', 'sampled-out']);

export class DeciderGuardError extends Error {
  constructor(code, message = `decider guard: ${code}`) {
    super(message);
    this.name = 'DeciderGuardError';
    this.code = code;
  }
}

/** A Map-backed LRU with per-entry expiry. Map iteration order is insertion order. */
function createLruCache({ max, ttlMs, now }) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt <= now()) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // refresh recency
      return hit.value;
    },
    set(key, value) {
      if (max <= 0) return;
      map.delete(key);
      map.set(key, { value, expiresAt: now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
    clear() { map.clear(); },
  };
}

function createTokenBucket({ perSecond, burst, now }) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + (Math.max(0, t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    reset() { tokens = burst; last = now(); },
  };
}

/** Events per second over a sliding window, in fixed memory (a ring of time buckets). */
function createRateMeter({ windowMs, buckets = 10, now }) {
  const width = Math.max(1, Math.floor(windowMs / buckets));
  const counts = new Array(buckets).fill(0);
  const stamps = new Array(buckets).fill(-1);
  return {
    record() {
      const idx = Math.floor(now() / width);
      const i = idx % buckets;
      if (stamps[i] !== idx) { stamps[i] = idx; counts[i] = 0; }
      counts[i] += 1;
    },
    perSecond() {
      const idx = Math.floor(now() / width);
      let sum = 0;
      for (let i = 0; i < buckets; i++) if (stamps[i] >= 0 && idx - stamps[i] < buckets) sum += counts[i];
      return sum / ((width * buckets) / 1000);
    },
    reset() { counts.fill(0); stamps.fill(-1); },
  };
}

export function createGuardedDecider(inner, {
  cacheTtlMs = 30_000,
  cacheMax = 1000,
  rateLimit = {},
  breaker: breakerOptions = {},
  timeoutMs = inner?.p99Ms > 0 ? inner.p99Ms * 2 : 1000,
  sampleAbove = 100,        // observed failures/s above which sampling kicks in
  sampleRate = 10,          // under load, only every Nth miss consults inner
  sampleWindowMs = 1000,
  key = fingerprint,
  now = Date.now,
  p99Ms = inner?.p99Ms ?? 0,
  name = `guarded(${inner?.name ?? 'decider'})`,
} = {}) {
  if (!inner || typeof inner.decide !== 'function') throw new TypeError('createGuardedDecider: inner decider required');
  const { perSecond = 20, burst = 40 } = rateLimit;

  const cache = createLruCache({ max: cacheMax, ttlMs: cacheTtlMs, now });
  const bucket = createTokenBucket({ perSecond, burst, now });
  const breaker = createBreaker({ failureThreshold: 5, cooldownMs: 10_000, now, ...breakerOptions });
  const load = createRateMeter({ windowMs: sampleWindowMs, now });
  const inflight = new Map();
  let missCounter = 0;
  const zero = () => ({
    hits: 0, misses: 0, joined: 0, innerCalls: 0, innerErrors: 0,
    blocks: Object.fromEntries(GUARD_CODES.map((c) => [c, 0])),
  });
  let counters = zero();

  const block = (code) => { counters.blocks[code] += 1; return new DeciderGuardError(code); };

  function callInner(err, site, ctx) {
    counters.innerCalls += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => { settled = true; reject(block('timeout')); }, Math.max(0, timeoutMs))
        : null;
      Promise.resolve()
        .then(() => inner.decide(err, site, ctx))
        .then(
          (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); },
          (e) => { if (settled) return; settled = true; clearTimeout(timer); counters.innerErrors += 1; reject(e); },
        );
    });
  }

  return {
    name,
    p99Ms,
    inner,

    async decide(err, site, ctx) {
      load.record(); // every decide() is an observed failure
      const k = key(err, site);

      const cached = cache.get(k);
      if (cached !== undefined) { counters.hits += 1; return cached; }
      counters.misses += 1;

      const pending = inflight.get(k);
      if (pending) { counters.joined += 1; return pending; }

      if (load.perSecond() > sampleAbove) {
        missCounter += 1;
        if (missCounter % Math.max(1, sampleRate) !== 0) throw block('sampled-out');
      }
      // Half-open admits a single probe; everything else waits for its verdict.
      if (breaker.isOpen() || (breaker.state() === 'half-open' && inflight.size > 0)) throw block('breaker-open');
      if (!bucket.take()) throw block('rate-limited');

      const p = callInner(err, site, ctx)
        .then(
          (axes) => {
            breaker.recordSuccess();
            if (axes) cache.set(k, axes);
            return axes;
          },
          (e) => { breaker.recordFailure(); throw e; },
        )
        .finally(() => { if (inflight.get(k) === p) inflight.delete(k); });
      inflight.set(k, p);
      return p;
    },

    breakerState: () => breaker.state(),

    stats() {
      return {
        ...counters,
        blocks: { ...counters.blocks },
        cacheSize: cache.size,
        inflight: inflight.size,
        breaker: breaker.state(),
        loadPerSecond: load.perSecond(),
      };
    },

    reset() {
      cache.clear();
      inflight.clear();
      bucket.reset();
      breaker.reset();
      load.reset();
      missCounter = 0;
      counters = zero();
    },
  };
}
