/**
 * The offline sink: a bounded in-memory store of Sentry events (+ the decisions joined onto
 * them) and an optional append-only JSONL file — the fixture set later phases replay.
 * No SDK here; the Sentry transport in ./sentry.js feeds it.
 *
 * JSONL line types:
 *   { type: 'event',      eventId, event }             one per failing rekurs invocation
 *   { type: 'breadcrumb', eventId, breadcrumb }        a later attempt on the same invocation
 *   { type: 'decision',   eventId, ...record }         an onDecision record (annotate)
 *   { type: 'outcome',    eventId, outcome }           how the invocation finally ended
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function createSink({ maxEvents = 100, jsonlPath = null } = {}) {
  const entries = new Map(); // eventId → { eventId, event, decisions: [], breadcrumbs: [], outcome }
  const waiters = new Map(); // eventId → [resolve]
  const stats = { events: 0, evicted: 0, lines: 0, writeErrors: 0 };
  let queue = Promise.resolve();
  let dirReady = null;

  function entry(eventId) {
    let e = entries.get(eventId);
    if (!e) {
      e = { eventId, event: null, decisions: [], breadcrumbs: [], outcome: null };
      entries.set(eventId, e);
      while (entries.size > maxEvents) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
        stats.evicted += 1;
      }
    }
    return e;
  }

  function write(line) {
    if (!jsonlPath) return;
    let text;
    try { text = safeStringify(line) + '\n'; } catch { stats.writeErrors += 1; return; }
    dirReady ??= mkdir(dirname(jsonlPath), { recursive: true }).catch(() => {});
    queue = queue
      .then(() => dirReady)
      .then(() => appendFile(jsonlPath, text))
      .then(() => { stats.lines += 1; }, () => { stats.writeErrors += 1; });
  }

  return {
    stats,
    jsonlPath,

    /** Store an event as the transport delivered it; resolves anyone waiting on its id. */
    addEvent(event) {
      const eventId = event?.event_id;
      if (!eventId) return;
      const e = entry(eventId);
      e.event = event;
      stats.events += 1;
      write({ type: 'event', eventId, event });
      for (const resolve of waiters.get(eventId) ?? []) resolve(event);
      waiters.delete(eventId);
    },

    addBreadcrumb(eventId, breadcrumb) {
      if (eventId) entry(eventId).breadcrumbs.push(breadcrumb);
      write({ type: 'breadcrumb', eventId, breadcrumb });
    },

    addDecision(eventId, record) {
      if (eventId) entry(eventId).decisions.push(record);
      write({ ...record, type: 'decision', eventId });
    },

    setOutcome(eventId, outcome) {
      if (eventId) entry(eventId).outcome = outcome;
      write({ type: 'outcome', eventId, outcome });
    },

    /** Resolve with the event once the transport has it, or null after timeoutMs. */
    waitFor(eventId, timeoutMs = 2_000) {
      const have = entries.get(eventId)?.event;
      if (have) return Promise.resolve(have);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const list = waiters.get(eventId) ?? [];
          const i = list.indexOf(done);
          if (i >= 0) list.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        function done(ev) { clearTimeout(timer); resolve(ev); }
        if (!waiters.has(eventId)) waiters.set(eventId, []);
        waiters.get(eventId).push(done);
      });
    },

    get: (eventId) => entries.get(eventId) ?? null,
    events: () => [...entries.values()].filter((e) => e.event).map((e) => e.event),
    entries: () => [...entries.values()],
    decisions: (eventId) => entries.get(eventId)?.decisions ?? [],
    clear() { entries.clear(); },
    /** Resolves once every queued JSONL line is on disk (or failed). */
    flush: () => queue,
  };
}

/** JSON.stringify that survives cycles, BigInt, and Errors. */
export function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, code: v.code, status: v.status };
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}
