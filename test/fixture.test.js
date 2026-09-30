import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordingDecider, createFixtureDecider, FixtureMissError, relaxedKey } from '../src/decider/fixture.js';
import { createJevDecider } from '../src/decider/jev.js';
import { createMockJevClient } from '../src/decider/mock-jev-client.js';
import { createFixedDecider } from '../src/decider/fixed.js';
import { createRekurs, retry, RekursError } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { fingerprint } from '../src/fingerprint.js';
import { unknownAxes } from '../src/axes.js';

const noSleep = () => Promise.resolve();
const http = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
// the error is constructed inside each thrower, so its top stack frame names that function
function throwHere(status) { throw Object.assign(new Error(`HTTP ${status}`), { status }); }
function throwElsewhere(status) { throw Object.assign(new Error(`HTTP ${status}`), { status }); }

const tmp = () => mkdtempSync(join(tmpdir(), 'rekurs-fixture-'));
const sites = {
  inv: { describe: 'GET /inventory', idempotent: true, dependency: 'inv', actions: { retry: async () => 'retried', degrade: () => 'stale' } },
  api: { describe: 'GET /me', idempotent: true, dependency: 'api', actions: { degrade: () => 'x' } },
  search: { describe: 'GET /search', idempotent: true, dependency: 'search', actions: { retry: retry({ sleep: noSleep }), degrade: () => 'cached' } },
};

async function outcome(r, status, site, thrower = throwHere) {
  try { const out = await r(async () => thrower(status), site); return { action: out.action, rule: out.attempts[0].rule }; }
  catch (e) { assert.ok(e instanceof RekursError); return { action: e.action, rule: e.trail[0].rule }; }
}

test('recording writes one JSONL line per decision and returns axes unchanged', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'nested', 'decisions.jsonl');
    const axes = unknownAxes();
    const rec = createRecordingDecider(createFixedDecider(axes, { name: 'fixed', p99Ms: 7 }), { path, now: () => 'T0' });
    assert.equal(rec.p99Ms, 7);
    const err = Object.assign(new Error('nope'), { code: 'EX', status: 418 });
    const site = { describe: 'op', dependency: 'd', idempotent: false, sideEffects: true };
    const out = await rec.decide(err, site, {});
    assert.equal(out, axes);
    await rec.decide(err, site, {});
    const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      fingerprint: fingerprint(err, site),
      error: { name: 'Error', message: 'nope', code: 'EX', status: 418 },
      site: { describe: 'op', dependency: 'd', idempotent: false, sideEffects: true },
      axes,
      decider: 'fixed',
      at: 'T0',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('record through rekurs, then replay from the file: same decisions', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'decisions.jsonl');
    const client = createMockJevClient();
    const recorder = createRecordingDecider(createJevDecider({ client }), { path });
    const live = createRekurs({ registry: createDependencyRegistry(), decider: recorder });
    const recorded = [
      await outcome(live, 503, sites.inv),
      await outcome(live, 401, sites.api),
      await outcome(live, 429, sites.search),
    ];
    assert.deepEqual(recorded.map((o) => o.action), ['retry', 'abort', 'degrade']);
    const callsAfterRecording = client.calls.length;

    const fixture = createFixtureDecider({ path });
    assert.equal(fixture.size(), 3);
    const replay = createRekurs({ registry: createDependencyRegistry(), decider: fixture });
    const replayed = [
      await outcome(replay, 503, sites.inv),
      await outcome(replay, 401, sites.api),
      await outcome(replay, 429, sites.search),
    ];
    assert.deepEqual(replayed, recorded);
    assert.equal(client.calls.length, callsAfterRecording, 'replay never touches the client');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exact match first, then relaxed key without the top frame', async () => {
  const errHere = (() => { try { throwHere(503); } catch (e) { return e; } })();
  const errThere = (() => { try { throwElsewhere(503); } catch (e) { return e; } })();
  const site = { dependency: 'inv' };
  const fpHere = fingerprint(errHere, site);
  assert.notEqual(fpHere, fingerprint(errThere, site));
  assert.equal(relaxedKey(fpHere), relaxedKey(fingerprint(errThere, site)));

  const a = { ...unknownAxes(), tag: 'a' };
  const fixture = createFixtureDecider({ records: [{ fingerprint: fpHere, axes: a }] });
  assert.equal(fixture.lookup(errHere, site).match, 'exact');
  assert.equal(fixture.lookup(errThere, site).match, 'relaxed');
  assert.deepEqual(await fixture.decide(errThere, site, {}), a);
  const other = http(404);
  assert.equal(fixture.lookup(other, site).match, null);
});

test('exact match wins over a relaxed one; later records win', async () => {
  const err = (() => { try { throwHere(500); } catch (e) { return e; } })();
  const site = { dependency: 'x' };
  const fp = fingerprint(err, site);
  const fixture = createFixtureDecider({
    records: [
      { fingerprint: `${relaxedKey(fp)}|someOtherFrame`, axes: { tag: 'relaxed' } },
      { fingerprint: fp, axes: { tag: 'old' } },
      { fingerprint: fp, axes: { tag: 'new' } },
    ],
  });
  assert.deepEqual(await fixture.decide(err, site, {}), { tag: 'new' });
});

test('fixture miss delegates to fallback, else throws FixtureMissError', async () => {
  const fallback = createFixedDecider(unknownAxes(), { name: 'fb' });
  const withFb = createFixtureDecider({ records: [], fallback });
  assert.deepEqual(await withFb.decide(http(418), {}, {}), unknownAxes());
  assert.equal(fallback.calls, 1);

  const strict = createFixtureDecider({ records: [] });
  await assert.rejects(strict.decide(http(418), { dependency: 'd' }, {}), (e) => e instanceof FixtureMissError && e.fingerprint.startsWith('d|Error||418|'));
});

test('a fixture miss inside rekurs falls closed to the site default', async () => {
  const r = createRekurs({ registry: createDependencyRegistry(), decider: createFixtureDecider({ records: [] }) });
  const out = await r(async () => { throw http(418); }, { default: 'degrade', actions: { degrade: () => 'd' } });
  assert.equal(out.value, 'd');
  assert.equal(out.attempts[0].rule, 'decider-unavailable');
});

test('file loading is lazy, tolerates torn lines and a missing file', async () => {
  const dir = tmp();
  try {
    const path = join(dir, 'f.jsonl');
    const fixture = createFixtureDecider({ path }); // file does not exist yet: no throw
    const err = http(503);
    writeFileSync(path, `${JSON.stringify({ fingerprint: fingerprint(err, {}), axes: { tag: 1 } })}\n{torn\n\n`);
    assert.deepEqual(await fixture.decide(err, {}, {}), { tag: 1 });
    assert.equal(createFixtureDecider({ path: join(dir, 'absent.jsonl') }).size(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replayed axes are copies, not shared references', async () => {
  const err = http(503);
  const fixture = createFixtureDecider({ records: [{ fingerprint: fingerprint(err, {}), axes: { overload: { p: 0.1 } } }] });
  const a = await fixture.decide(err, {}, {});
  a.overload.p = 0.9;
  assert.equal((await fixture.decide(err, {}, {})).overload.p, 0.1);
});

test('constructors validate their arguments', () => {
  assert.throws(() => createFixtureDecider({}), TypeError);
  assert.throws(() => createRecordingDecider(null, { path: 'x' }), TypeError);
  assert.throws(() => createRecordingDecider(createFixedDecider({}), {}), TypeError);
});
