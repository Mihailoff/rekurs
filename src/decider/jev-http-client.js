/**
 * Real Jev client: POST https://api.typesafe.ai/v1/systemone, mapped to the adapter contract
 * documented in ./jev.js (client.ask(state, questions) → answers).
 *
 * Wire format (docs.typesafe.ai/introduction/quickstart):
 *   request  { model, state, questions: { key: { type, instructions, criteria } } }
 *     choice criteria = { option: description }, score criteria = [level descriptions], noul has none
 *   response { model, answers: { key: choice → { choice, confidence, probabilities }
 *                                       score  → { score, confidence, probabilities: {"0":..}, legend }
 *                                       noul   → { noul } }, usage }
 */
export class JevHttpError extends Error {
  constructor(status, body) {
    super(`jev http ${status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    this.name = 'JevHttpError';
    this.status = status;
    this.body = body;
    this.code = status === 429 ? 'rate-limited' : 'http';
  }
}

export function toWire(questions) {
  const out = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      out[key] = {
        type: 'choice',
        instructions: q.question ?? 'Pick the option that best describes the state.',
        criteria: Object.fromEntries(q.options.map((o) => [o, q.describe?.[o] ?? o])),
      };
    } else if (q.type === 'score') {
      out[key] = {
        type: 'score',
        instructions: q.question ?? 'Place the state on the ladder.',
        criteria: q.levels.map((l) => q.describe?.[l] ?? l),
      };
    } else if (q.type === 'noul') {
      out[key] = { type: 'noul', instructions: q.statement };
    } else {
      throw new TypeError(`jev: unknown question type "${q.type}" for "${key}"`);
    }
  }
  return out;
}

export function fromWire(answers, questions) {
  const out = {};
  for (const [key, q] of Object.entries(questions)) {
    const a = answers?.[key];
    if (!a) continue;
    if (q.type === 'choice') out[key] = { pick: a.choice, p: a.probabilities, conf: a.confidence };
    else if (q.type === 'noul') out[key] = { p: a.noul };
    else if (q.type === 'score') {
      const p = Object.fromEntries(q.levels.map((l, i) => [l, a.probabilities?.[String(i)] ?? 0]));
      const idx = Number.isFinite(a.score) ? Math.round(a.score) : null;
      const level = q.levels.reduce((best, l) => (p[l] > (p[best] ?? -1) ? l : best), q.levels[idx] ?? q.levels[0]);
      out[key] = { level, p, conf: a.confidence, score: a.score };
    }
  }
  return out;
}

export function createJevHttpClient({
  apiKey = process.env.JEV_KEY ?? process.env.TYPESAFE_API_KEY,
  baseUrl = 'https://api.typesafe.ai',
  model = 'jev-latest',
  fetch = globalThis.fetch,
  timeoutMs = 5_000,
} = {}) {
  if (!apiKey) throw new Error('jev: API key required (JEV_KEY or TYPESAFE_API_KEY)');
  const client = {
    name: 'jev-http',
    last: null, // { model, usage, latencyMs, raw } of the most recent call
    async ask(state, questions) {
      const body = { model, state, questions: toWire(questions) };
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep text */ }
      if (!res.ok) throw new JevHttpError(res.status, json ?? text);
      const answers = json?.answers ?? json;
      client.last = { model: json?.model, usage: json?.usage, latencyMs: Math.round(performance.now() - t0), raw: json };
      return fromWire(answers, questions);
    },
  };
  return client;
}
