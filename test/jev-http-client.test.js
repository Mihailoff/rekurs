import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJevHttpClient, toWire, fromWire, JevHttpError } from '../src/decider/jev-http-client.js';
import { buildQuestions, normalizeResponse } from '../src/decider/jev.js';

test('questions map to the wire format', () => {
  const w = toWire(buildQuestions({ nouls: { rate_limited: 'the body mentions a rate limit' } }));
  assert.equal(w.persistence.type, 'choice');
  assert.ok(w.persistence.criteria.transient.length > 10);
  assert.equal(w.overload.type, 'noul');
  assert.ok(Array.isArray(w.scope.criteria) && w.scope.criteria.length === 3);
  assert.equal(w['noul:rate_limited'].instructions, 'the body mentions a rate limit');
});

test('wire answers map back and normalize into axes', async () => {
  const q = buildQuestions({});
  const fake = {
    model: 'jev-1.13.0',
    answers: {
      persistence: { type: 'choice', choice: 'transient', confidence: 0.8, probabilities: { transient: 0.8, persistent: 0.1, unknown: 0.1 } },
      locus: { type: 'choice', choice: 'dependency', confidence: 0.7, probabilities: { dependency: 0.7, network: 0.2, my_input: 0.05, environment: 0.03, unknown: 0.02 } },
      outcome: { type: 'choice', choice: 'did_not_happen', confidence: 0.9, probabilities: { did_not_happen: 0.9, may_have_happened: 0.1, happened: 0 } },
      overload: { type: 'noul', noul: 0.15 },
      scope: { type: 'score', score: 1.0, confidence: 0.6, probabilities: { 0: 0.3, 1: 0.6, 2: 0.1 } },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };
  const client = createJevHttpClient({ apiKey: 'k', fetch: async () => new Response(JSON.stringify(fake), { status: 200 }) });
  const axes = normalizeResponse(await client.ask('state', q), q);
  assert.equal(axes.persistence.pick, 'transient');
  assert.equal(axes.overload.p, 0.15);
  assert.equal(axes.scope.pick, 'this_dependency');
  assert.equal(client.last.model, 'jev-1.13.0');
});

test('non-2xx becomes JevHttpError with code', async () => {
  const client = createJevHttpClient({ apiKey: 'k', fetch: async () => new Response('slow down', { status: 429 }) });
  await assert.rejects(client.ask('s', buildQuestions({})), (e) => e instanceof JevHttpError && e.code === 'rate-limited');
});
