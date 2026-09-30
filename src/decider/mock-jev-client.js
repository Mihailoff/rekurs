/**
 * A deterministic stand-in for the Jev HTTP client, implementing the contract documented in
 * ./jev.js. It reads keywords from the state text only (as Jev would), so the whole pipeline
 * — render → ask → normalize → policy — runs end to end without Jev access.
 *
 * It is a test double, not a classifier: a handful of keyword profiles, first match wins.
 */

const PROFILES = [
  {
    name: 'overload',
    match: /\b429\b|rate.?limit|too many requests|throttl/i,
    persistence: ['transient', 0.7], locus: ['dependency', 0.8], outcome: ['did_not_happen', 0.9],
    overload: 0.95, scope: ['this_dependency', 0.7],
  },
  {
    name: 'auth',
    match: /\b40[13]\b|unauthori[sz]ed|forbidden/i,
    persistence: ['persistent', 0.9], locus: ['my_input', 0.85], outcome: ['did_not_happen', 0.95],
    overload: 0.02, scope: ['this_dependency', 0.6],
  },
  {
    name: 'timeout',
    match: /time.?out|timed out|ETIMEDOUT/i,
    persistence: ['transient', 0.7], locus: ['network', 0.5], outcome: ['may_have_happened', 0.85],
    overload: 0.3, scope: ['this_call', 0.6],
  },
  {
    name: 'unavailable',
    match: /ECONNREFUSED|ECONNRESET|\b50[23]\b|service unavailable|bad gateway/i,
    persistence: ['transient', 0.75], locus: ['dependency', 0.7], outcome: ['did_not_happen', 0.85],
    overload: 0.3, scope: ['this_dependency', 0.6],
  },
];

const UNKNOWN = {
  name: 'unknown',
  persistence: ['unknown', 0.34], locus: ['unknown', 0.3], outcome: ['may_have_happened', 0.4],
  overload: 0.1, scope: ['this_call', 0.4],
};

function spread(options, pick, conf) {
  if (!options.includes(pick)) return Object.fromEntries(options.map((o) => [o, 1 / options.length]));
  const rest = options.length > 1 ? (1 - conf) / (options.length - 1) : 0;
  return Object.fromEntries(options.map((o) => [o, o === pick ? conf : rest]));
}

/**
 * createMockJevClient({ nouls, latencyMs })
 * - nouls: (statement, state) → p, or { [statement]: p }, for non-axis Noul questions (default 0.5).
 * - latencyMs: optional artificial delay.
 * The client records every call in `calls` ({ state, questions }).
 */
export function createMockJevClient({ nouls = null, latencyMs = 0 } = {}) {
  const noulFor = (statement, state) => {
    if (typeof nouls === 'function') return nouls(statement, state);
    if (nouls && typeof nouls === 'object' && statement in nouls) return nouls[statement];
    return 0.5;
  };

  return {
    calls: [],
    profileFor(state) {
      return PROFILES.find((p) => p.match.test(state)) ?? UNKNOWN;
    },
    async ask(state, questions) {
      this.calls.push({ state, questions });
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const profile = this.profileFor(String(state ?? ''));
      const out = {};
      for (const [key, q] of Object.entries(questions)) {
        const hit = profile[key];
        if (q.type === 'noul') {
          out[key] = { p: typeof hit === 'number' ? hit : noulFor(q.statement, state) };
        } else if (q.type === 'choice') {
          const [pick, conf] = Array.isArray(hit) ? hit : [q.options[0], 1 / q.options.length];
          const p = spread(q.options, pick, conf);
          out[key] = { pick: q.options.includes(pick) ? pick : q.options[0], p, conf: p[pick] ?? p[q.options[0]] };
        } else if (q.type === 'score') {
          const [level, conf] = Array.isArray(hit) ? hit : [q.levels[0], 1 / q.levels.length];
          const p = spread(q.levels, level, conf);
          out[key] = { level: q.levels.includes(level) ? level : q.levels[0], p, conf: p[level] ?? p[q.levels[0]] };
        }
      }
      return out;
    },
  };
}
