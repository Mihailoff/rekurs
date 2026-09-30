/**
 * Audit sinks (design §8 bounded sink, §9 "decision distribution is a metric").
 * Pure data: no I/O, no alerting. Both expose `push(record)`, usable as an `onDecision` target.
 */

/** A ring buffer of audit records: never grows past `max`; overflow drops the oldest. */
export function createBoundedSink({ max = 10_000, onDrop = null } = {}) {
  if (!(max > 0)) throw new TypeError('createBoundedSink: max must be > 0');
  let buf = new Array(max);
  let head = 0;   // index of the oldest record
  let count = 0;
  let dropped = 0;

  function push(record) {
    if (count === max) {
      const old = buf[head];
      buf[head] = record;
      head = (head + 1) % max;
      dropped += 1;
      if (onDrop) { try { onDrop(old); } catch { /* a sink never throws into the caller */ } }
      return;
    }
    buf[(head + count) % max] = record;
    count += 1;
  }

  return {
    push,
    /** Remove and return all buffered records, oldest first. */
    drain() {
      const out = new Array(count);
      for (let i = 0; i < count; i++) {
        const j = (head + i) % max;
        out[i] = buf[j];
        buf[j] = undefined;
      }
      head = 0;
      count = 0;
      return out;
    },
    size: () => count,
    dropped: () => dropped,
    max,
    reset() { buf = new Array(max); head = 0; count = 0; dropped = 0; },
  };
}

/**
 * Per-dependency distribution of actions and rules over a sliding window. Memory is bounded by
 * buckets × dependencies × distinct actions/rules, not by record volume.
 */
export function createDecisionStats({ windowMs = 60_000, buckets = 12, now = Date.now } = {}) {
  const width = Math.max(1, Math.floor(windowMs / buckets));
  let ring = new Array(buckets).fill(null); // { idx, deps: Map<dep, { total, actions, rules }> }

  function bucketFor(t) {
    const idx = Math.floor(t / width);
    const i = idx % buckets;
    if (!ring[i] || ring[i].idx !== idx) ring[i] = { idx, deps: new Map() };
    return ring[i];
  }

  function push(record) {
    const dep = record?.dependency ?? 'default';
    const b = bucketFor(now());
    let d = b.deps.get(dep);
    if (!d) { d = { total: 0, actions: {}, rules: {} }; b.deps.set(dep, d); }
    d.total += 1;
    const action = String(record?.action ?? 'unknown');
    const rule = String(record?.rule ?? 'none');
    d.actions[action] = (d.actions[action] ?? 0) + 1;
    d.rules[rule] = (d.rules[rule] ?? 0) + 1;
  }

  return {
    push,
    snapshot() {
      const cur = Math.floor(now() / width);
      const out = {};
      for (const b of ring) {
        if (!b || b.idx > cur || cur - b.idx >= buckets) continue;
        for (const [dep, d] of b.deps) {
          const o = (out[dep] ??= { total: 0, actions: {}, rules: {} });
          o.total += d.total;
          for (const [k, v] of Object.entries(d.actions)) o.actions[k] = (o.actions[k] ?? 0) + v;
          for (const [k, v] of Object.entries(d.rules)) o.rules[k] = (o.rules[k] ?? 0) + v;
        }
      }
      return out;
    },
    reset() { ring = new Array(buckets).fill(null); },
  };
}
