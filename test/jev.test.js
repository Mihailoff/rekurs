import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJevDecider, JevResponseError, buildQuestions, normalizeResponse, fallbackRender, DEFAULT_LABELS,
} from '../src/decider/jev.js';
import { createMockJevClient } from '../src/decider/mock-jev-client.js';
import { createRekurs, retry, RekursError, TimeoutError } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE } from '../src/axes.js';
import * as index from '../src/index.js';

const http = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const noSleep = () => Promise.resolve();
const stubClient = (response) => ({ calls: [], async ask(state, questions) { this.calls.push({ state, questions }); return typeof response === 'function' ? response(questions) : response; } });

const good = {
  persistence: { pick: 'transient', p: { transient: 0.8, persistent: 0.1, unknown: 0.1 }, conf: 0.8 },
  locus: { pick: 'dependency', p: { my_input: 0.05, dependency: 0.8, network: 0.1, environment: 0.03, unknown: 0.02 }, conf: 0.8 },
  outcome: { pick: 'did_not_happen', p: { did_not_happen: 0.9, may_have_happened: 0.08, happened: 0.02 }, conf: 0.9 },
  overload: { p: 0.2 },
  scope: { level: 'this_dependency', p: { this_call: 0.2, this_dependency: 0.7, everything: 0.1 }, conf: 0.7 },
};

test('builds the five axis questions from axes.js constants', () => {
  const q = buildQuestions({});
  assert.deepEqual(Object.keys(q).sort(), ['locus', 'outcome', 'overload', 'persistence', 'scope']);
  assert.equal(q.persistence.type, 'choice');
  assert.deepEqual(q.persistence.options, PERSISTENCE);
  assert.deepEqual(q.locus.options, LOCUS);
  assert.deepEqual(q.outcome.options, OUTCOME);
  assert.equal(q.overload.type, 'noul');
  assert.equal(q.overload.statement, DEFAULT_LABELS.overload);
  assert.equal(q.scope.type, 'score');
  assert.deepEqual(q.scope.levels, ['this_call', 'this_dependency', 'everything']);
  assert.equal(q.persistence.describe.transient, 'the same call is likely to succeed if repeated shortly');
  for (const opt of LOCUS) assert.equal(typeof q.locus.describe[opt], 'string');
  for (const lvl of SCOPE) assert.equal(typeof q.scope.describe[lvl], 'string');
});

test('labels override individual option descriptions and the overload statement', () => {
  const q = buildQuestions({}, { persistence: { transient: 'blip' }, overload: 'too busy' });
  assert.equal(q.persistence.describe.transient, 'blip');
  assert.equal(q.persistence.describe.persistent, DEFAULT_LABELS.persistence.persistent);
  assert.equal(q.overload.statement, 'too busy');
});

test('decide sends rendered state + questions and returns a well-formed axis vector', async () => {
  const client = stubClient(good);
  const d = createJevDecider({ client });
  assert.equal(d.name, 'jev');
  assert.equal(d.p99Ms, 300);
  const axes = await d.decide(http(503), { describe: 'GET /inventory', dependency: 'inv' }, { attempts: [] });
  const { state } = client.calls[0];
  assert.match(state, /HTTP 503/);
  assert.match(state, /http status: 503/);
  assert.match(state, /operation: GET \/inventory/);
  assert.match(state, /attempt: 1/);
  assert.equal(axes.persistence.pick, 'transient');
  assert.equal(axes.overload.p, 0.2);
  assert.equal(axes.nouls, undefined);
});

test('Score is mapped back to { pick, p, conf }', () => {
  const q = buildQuestions({});
  const a = normalizeResponse({ ...good, scope: { level: 'everything', p: { this_call: 0.1, this_dependency: 0.2, everything: 0.7 }, conf: 0.7 } }, q);
  assert.deepEqual(a.scope, { pick: 'everything', p: { this_call: 0.1, this_dependency: 0.2, everything: 0.7 }, conf: 0.7 });
  const b = normalizeResponse({ ...good, scope: { level: 1, conf: 0.6 } }, q); // index form, no p
  assert.equal(b.scope.pick, 'this_dependency');
  assert.equal(b.scope.conf, 0.6);
  assert.ok(Math.abs(b.scope.p.this_call - 0.2) < 1e-9);
  const c = normalizeResponse({ ...good, scope: { p: { this_call: 0.1, this_dependency: 0.1, everything: 0.8 } } }, q);
  assert.equal(c.scope.pick, 'everything');
  assert.equal(c.scope.conf, 0.8);
});

test('normalizes sloppy responses: missing p → uniform, clamp, renormalize, argmax pick', () => {
  const q = buildQuestions({});
  const a = normalizeResponse({
    persistence: {},                                                           // nothing: uniform
    locus: { p: { dependency: 3, network: -1, bogus: 9, my_input: 'x' } },     // clamp + drop unknown
    outcome: { pick: 'not-an-option', p: { did_not_happen: 2, may_have_happened: 2 } },
    overload: { p: 7 },                                                        // clamp
    scope: { level: 'this_call' },                                             // no p, no conf
  }, q);
  for (const o of PERSISTENCE) assert.ok(Math.abs(a.persistence.p[o] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(a.persistence.conf - 1 / 3) < 1e-9);
  assert.equal(a.locus.pick, 'dependency');
  assert.equal(a.locus.p.dependency, 1);
  assert.equal(a.locus.p.network, 0);
  assert.equal(Object.keys(a.locus.p).length, LOCUS.length);
  assert.equal(a.outcome.pick, 'did_not_happen');
  assert.equal(a.outcome.p.did_not_happen, 0.5);
  assert.equal(a.overload.p, 1);
  assert.equal(a.scope.pick, 'this_call');
  const sum = Object.values(a.locus.p).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('malformed responses throw JevResponseError', () => {
  const q = buildQuestions({});
  assert.throws(() => normalizeResponse(null, q), JevResponseError);
  assert.throws(() => normalizeResponse([], q), JevResponseError);
  assert.throws(() => normalizeResponse({ ...good, locus: undefined }, q), JevResponseError);
  assert.throws(() => normalizeResponse({ ...good, overload: 'high' }, q), JevResponseError);
  assert.throws(() => normalizeResponse({ ...good, scope: 'this_call' }, q), JevResponseError);
});

test('a malformed response falls closed to the site default through rekurs', async () => {
  const r = createRekurs({ registry: createDependencyRegistry(), decider: createJevDecider({ client: stubClient('garbage') }) });
  let seen = null;
  const r2 = createRekurs({
    registry: createDependencyRegistry(),
    decider: createJevDecider({ client: stubClient({ nope: 1 }) }),
    onDecision: (x) => { seen = x; },
  });
  const out = await r(async () => { throw http(503); }, { idempotent: true, default: 'degrade', actions: { degrade: () => 'cached' } });
  assert.equal(out.value, 'cached');
  assert.equal(out.attempts[0].rule, 'decider-unavailable');
  await r2(async () => { throw http(503); }, { idempotent: true, default: 'degrade', actions: { degrade: () => 'cached' } });
  assert.equal(seen.rule, 'decider-unavailable');
});

test('site-declared nouls are asked and returned under axes.nouls', async () => {
  const client = stubClient((qs) => ({ ...good, 'noul:errorPayload': { p: 0.9 }, 'noul:auth': 0.1 }));
  const d = createJevDecider({ client });
  const site = { describe: 'x', nouls: { errorPayload: 'the response body is an error payload', auth: 'this is an authentication failure', missing: 'never answered' } };
  const axes = await d.decide(new Error('boom'), site, {});
  const { questions } = client.calls[0];
  assert.deepEqual(questions['noul:errorPayload'], { type: 'noul', statement: 'the response body is an error payload' });
  assert.ok(questions['noul:missing']);
  assert.deepEqual(axes.nouls, { errorPayload: { p: 0.9 }, auth: { p: 0.1 } });
});

test('injected render is used; a failing or empty render falls back', async () => {
  const client = stubClient(good);
  const seen = [];
  const d = createJevDecider({ client, render: (context, site, ctx, opts) => { seen.push({ context, opts }); return `RENDERED ${context.eventId}`; } });
  await d.decide(http(500), { describe: 'op' }, { context: { eventId: 'e1' }, attempts: [] });
  assert.equal(client.calls[0].state, 'RENDERED e1');
  assert.equal(seen[0].opts.budgetBytes, 2048);
  assert.equal(seen[0].opts.error.status, 500);

  const d2 = createJevDecider({ client, render: () => { throw new Error('render broke'); } });
  await d2.decide(http(500), { describe: 'op' }, {});
  assert.match(client.calls[1].state, /^exception: Error: HTTP 500/);
  const d3 = createJevDecider({ client, render: () => '' });
  await d3.decide(http(500), {}, {});
  assert.match(client.calls[2].state, /http status: 500/);
});

test('fallback renderer honours the byte budget and counts attempts', () => {
  const text = fallbackRender(Object.assign(new Error('x'.repeat(5000)), { code: 'E' }), {}, { attempts: [{}, {}] }, { budgetBytes: 100 });
  assert.equal(text.length, 100);
  assert.match(fallbackRender(new Error('y'), {}, { attempts: [{}, {}] }), /attempt: 3 \(2 prior failures\)/);
});

test('createJevDecider requires a client', () => {
  assert.throws(() => createJevDecider({}), TypeError);
});

test('index exports the phase 3 surface', () => {
  for (const k of ['createJevDecider', 'createRecordingDecider', 'createFixtureDecider', 'createMockJevClient', 'JevResponseError', 'FixtureMissError']) {
    assert.ok(k in index, k);
  }
});

// ── mock client + adapter + real policy, end to end ──

const jevRekurs = () => createRekurs({ registry: createDependencyRegistry(), decider: createJevDecider({ client: createMockJevClient() }) });

test('e2e: timeout on a side-effecting site → reconcile', async () => {
  const r = jevRekurs();
  let calls = 0;
  const out = await r(async () => { calls++; throw new TimeoutError(5000); },
    { describe: 'POST /charge', dependency: 'pay', actions: { retry: retry({ sleep: noSleep }), reconcile: () => 'looked-up' } });
  assert.equal(calls, 1);
  assert.equal(out.action, 'reconcile');
  assert.equal(out.attempts[0].rule, 'side-effects-unknown-outcome');
  assert.equal(out.attempts[0].axes.outcome.pick, 'may_have_happened');
});

test('e2e: 503 on an idempotent site → retry', async () => {
  const r = jevRekurs();
  let n = 0;
  const out = await r(async () => { if (n++ < 1) throw http(503); return 'ok'; },
    { idempotent: true, dependency: 'inv', actions: { retry: retry({ sleep: noSleep }), degrade: () => 'stale' } });
  assert.equal(out.value, 'ok');
  assert.equal(out.attempts[0].action, 'retry');
  assert.equal(out.attempts[0].rule, 'transient-retry');
});

test('e2e: 401 → abort', async () => {
  const r = jevRekurs();
  await assert.rejects(
    r(async () => { throw http(401); }, { idempotent: true, dependency: 'api', actions: { retry: retry({ sleep: noSleep }), degrade: () => 'x' } }),
    (e) => e instanceof RekursError && e.action === 'abort' && e.trail[0].rule === 'bad-input',
  );
});

test('e2e: 429 → degrade', async () => {
  const r = jevRekurs();
  const out = await r(async () => { throw http(429); },
    { idempotent: true, dependency: 'search', actions: { retry: retry({ sleep: noSleep }), degrade: () => 'cached' } });
  assert.equal(out.action, 'degrade');
  assert.equal(out.value, 'cached');
  assert.equal(out.attempts[0].rule, 'overload');
});

test('mock client: unrecognized text yields low confidence', async () => {
  const d = createJevDecider({ client: createMockJevClient() });
  const a = await d.decide(new Error('something odd'), {}, {});
  assert.equal(a.persistence.pick, 'unknown');
  assert.ok(a.persistence.conf < 0.5);
});

test('mock client answers site nouls via its nouls option', async () => {
  const client = createMockJevClient({ nouls: (statement) => (/payload/.test(statement) ? 0.8 : 0.2) });
  const d = createJevDecider({ client });
  const a = await d.decide(http(503), { nouls: { body: 'the body is an error payload', other: 'something else' } }, {});
  assert.deepEqual(a.nouls, { body: { p: 0.8 }, other: { p: 0.2 } });
});
