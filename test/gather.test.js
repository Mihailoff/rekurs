import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRekurs, retry } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createFixedDecider } from '../src/decider/fixed.js';
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE, certain } from '../src/axes.js';
import { createSentryGather } from '../src/gather/sentry.js';
import { renderState } from '../src/gather/render.js';

let Sentry = null;
try { Sentry = await import('@sentry/node'); } catch { /* optional dependency */ }
const skip = Sentry ? false : '@sentry/node is not installed (optional dependency) — skipping Sentry gather tests';

const transient = () => ({
  persistence: certain(PERSISTENCE, 'transient', 0.8), locus: certain(LOCUS, 'dependency', 0.8),
  outcome: certain(OUTCOME, 'did_not_happen', 0.9), overload: { p: 0.1 }, scope: certain(SCOPE, 'this_call', 0.7),
});
const noSleep = () => Promise.resolve();
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let dir;
let sentry;
let run;
let contexts;

before(async () => {
  if (skip) return;
  dir = await mkdtemp(join(tmpdir(), 'rekurs-gather-'));
  sentry = await createSentryGather({ jsonlPath: join(dir, 'events.jsonl'), sentry: Sentry });
  contexts = [];
  const r = createRekurs({
    registry: createDependencyRegistry({ budget: { minRetries: 1_000 } }),
    decider: createFixedDecider(transient()),
    gather: async (err, site, ctx) => { const c = await sentry.gather(err, site, ctx); contexts.push(c); return c; },
    onDecision: sentry.annotate,
  });
  run = sentry.wrap(r);
});

after(async () => {
  if (skip) return;
  await sentry.close();
  await rm(dir, { recursive: true, force: true });
});

const readLines = async () => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('runs without a host client: our client is initialised with PII off', { skip }, () => {
  assert.equal(sentry.mode, 'init');
  assert.equal(sentry.client.getOptions().sendDefaultPii, false);
});

test('one event per failing invocation; later attempts become breadcrumbs', { skip }, async () => {
  sentry.sink.clear();
  contexts.length = 0;
  let n = 0;
  const out = await run(async () => {
    n += 1;
    if (n <= 3) throw Object.assign(new Error(`upstream down #${n}`), { code: 'ECONNRESET' });
    return 'ok';
  }, { idempotent: true, dependency: 'svc', describe: 'GET /things', actions: { retry: retry({ sleep: noSleep, max: 5 }) } });

  assert.equal(out.value, 'ok');
  assert.equal(out.attempts.length, 3);
  const events = sentry.sink.events();
  assert.equal(events.length, 1, 'exactly one event for three failures');
  assert.equal(events[0].exception.values.at(-1).value, 'upstream down #1');
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every((c) => c.eventId === events[0].event_id), 'every attempt joins the same event');

  const attemptCrumbs = contexts[2].breadcrumbs.filter((b) => b.category === 'rekurs.attempt');
  assert.deepEqual(attemptCrumbs.map((b) => b.data.attempt), [2, 3]);
  assert.equal(attemptCrumbs[0].data.action, 'retry');
  assert.equal(attemptCrumbs[0].data.rule, 'transient-retry');
  assert.equal(attemptCrumbs[1].data.error.message, 'upstream down #3');
  assert.deepEqual(contexts[2].attempts.map((a) => a.action), ['retry', 'retry', null]);

  // The context is a plain object a renderer can use without the SDK.
  const text = renderState(contexts[2], { describe: 'GET /things', dependency: 'svc', idempotent: true, sideEffects: false }, { attempts: out.attempts });
  assert.match(text, /^## exception\nError: upstream down #1/);
  assert.match(text, /rekurs\.attempt/);
});

test('two invocations with N attempts each produce two events', { skip }, async () => {
  sentry.sink.clear();
  for (const tag of ['a', 'b']) {
    let n = 0;
    await run(async () => { if (n++ < 2) throw Object.assign(new Error(tag), { code: 'ECONNREFUSED' }); return tag; },
      { idempotent: true, dependency: 'svc', actions: { retry: retry({ sleep: noSleep }) } });
  }
  assert.deepEqual(sentry.sink.events().map((e) => e.exception.values.at(-1).value), ['a', 'b']);
});

test('breadcrumbs from two concurrent invocations do not cross', { skip }, async () => {
  sentry.sink.clear();
  contexts.length = 0;
  const call = (tag, delays) => {
    let n = 0;
    return run(async () => {
      for (const d of delays) { Sentry.addBreadcrumb({ category: 'test', message: `${tag}-${n}-${d}` }); await tick(d); }
      n += 1;
      throw Object.assign(new Error(tag), { code: 'ECONNRESET' });
    }, { idempotent: true, dependency: `svc-${tag}`, default: 'degrade', actions: { retry: retry({ sleep: noSleep, max: 1 }), degrade: () => `${tag}-degraded` } })
      .catch((e) => e);
  };
  await Promise.all([call('left', [5, 1, 7]), call('right', [2, 6, 1])]);

  const events = sentry.sink.events();
  assert.equal(events.length, 2);
  for (const ev of events) {
    const tag = ev.exception.values.at(-1).value;
    const other = tag === 'left' ? 'right' : 'left';
    const msgs = (ev.breadcrumbs ?? []).map((b) => b.message ?? '');
    assert.ok(msgs.some((m) => m.startsWith(`${tag}-`)), `${tag} sees its own breadcrumbs`);
    assert.ok(!msgs.some((m) => m.startsWith(`${other}-`)), `${tag} must not see ${other}'s breadcrumbs`);
  }
  for (const c of contexts) {
    const tag = sentry.sink.get(c.eventId).event.exception.values.at(-1).value;
    const other = tag === 'left' ? 'right' : 'left';
    assert.ok(!c.breadcrumbs.some((b) => (b.message ?? '').startsWith(`${other}-`) || (b.data?.error?.message === other)));
  }
});

test('annotate writes decision lines and joins them onto the event', { skip }, async () => {
  sentry.sink.clear();
  let n = 0;
  await run(async () => { if (n++ < 2) throw Object.assign(new Error('flaky'), { status: 503 }); return 1; },
    { idempotent: true, dependency: 'ann', actions: { retry: retry({ sleep: noSleep }) } });
  await sentry.flush();

  const [ev] = sentry.sink.events();
  const id = ev.event_id;
  assert.equal(sentry.sink.decisions(id).length, 2);
  assert.equal(ev.tags['rekurs.action'], 'retry');
  assert.equal(ev.tags['rekurs.rule'], 'transient-retry');
  assert.equal(ev.tags['rekurs.axis.persistence.pick'], 'transient');
  assert.equal(ev.tags['rekurs.outcome'], 'recovered');
  assert.equal(sentry.sink.get(id).outcome.status, 'recovered');

  const lines = (await readLines()).filter((l) => l.eventId === id);
  assert.deepEqual(lines.map((l) => l.type), ['event', 'decision', 'breadcrumb', 'decision', 'outcome']);
  const decision = lines.find((l) => l.type === 'decision');
  assert.equal(decision.action, 'retry');
  assert.equal(decision.axes['persistence.pick'], 'transient');
  assert.equal(lines[0].event.event_id, id);
});

test('JSONL event lines hold the full Sentry event; PII defaults stay off', { skip }, async () => {
  await sentry.flush();
  const events = (await readLines()).filter((l) => l.type === 'event');
  assert.ok(events.length >= 1);
  for (const { event } of events) {
    assert.ok(event.exception?.values?.length);
    assert.equal(event.user?.ip_address, undefined);
  }
});

test('gather never throws into the recovery path', { skip }, async () => {
  const c = await sentry.gather(new Error('no ctx'), undefined, undefined);
  assert.ok(c === null || typeof c.eventId === 'string');
  const weird = await sentry.gather(Object.create(null), null, { attempts: null });
  assert.ok(weird === null || typeof weird === 'object');
});
