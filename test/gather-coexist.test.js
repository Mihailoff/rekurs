// A host app already runs Sentry: rekurs must not hijack its client (separate process per file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRekurs, retry } from '../src/rekurs.js';
import { createDependencyRegistry } from '../src/state/dependency.js';
import { createSentryGather } from '../src/gather/sentry.js';

let Sentry = null;
try { Sentry = await import('@sentry/node'); } catch { /* optional dependency */ }
const skip = Sentry ? false : '@sentry/node is not installed (optional dependency) — skipping Sentry coexistence tests';

test('host client keeps its transport; our events go only to our sink', { skip }, async () => {
  const hostSent = [];
  Sentry.init({
    dsn: 'https://host@host.invalid/1',
    defaultIntegrations: false,
    transport: () => ({ send: (env) => { hostSent.push(env); return Promise.resolve({}); }, flush: () => Promise.resolve(true) }),
  });
  const hostClient = Sentry.getClient();

  const sentry = await createSentryGather({ sentry: Sentry });
  assert.equal(sentry.mode, 'isolated');
  assert.equal(Sentry.getClient(), hostClient, 'global client untouched');
  assert.notEqual(sentry.client, hostClient);

  const run = sentry.wrap(createRekurs({ registry: createDependencyRegistry(), gather: sentry.gather, onDecision: sentry.annotate }));
  let n = 0;
  const out = await run(async () => {
    Sentry.addBreadcrumb({ category: 'host', message: `host crumb ${n}` });
    if (n++ < 2) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    return 'ok';
  }, { idempotent: true, dependency: 'coexist', actions: { retry: retry({ sleep: () => Promise.resolve() }) } });
  await sentry.flush();
  await Sentry.flush(500);

  assert.equal(out.value, 'ok');
  const events = sentry.sink.events();
  assert.equal(events.length, 1);
  assert.ok(events[0].breadcrumbs.some((b) => b.message === 'host crumb 0'), 'host breadcrumbs reach our event');
  assert.equal(hostSent.length, 0, 'host transport never saw our event');
  await sentry.close();
});
