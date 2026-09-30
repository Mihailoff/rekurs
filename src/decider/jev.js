/**
 * The Jev decider: renders the failure as state text and asks Jev (TypeSafe AI's
 * non-generative decision model) the five fault-axis questions in one parallel request.
 * Jev perceives; the policy decides. Jev never sees the action menu.
 *
 * ── Client contract (injected; the real HTTP client is wrapped to fit this) ──
 *
 *   client.ask(state, questions) → Promise<answers>
 *
 *   state: string — the rendered failure context (untrusted text, ~2 KB).
 *
 *   questions: { [key: string]: Question }, where Question is one of
 *     { type: 'choice', question?: string, options: string[], describe?: { [option]: string } }
 *         pick one of up to 255 options
 *     { type: 'noul', statement: string }
 *         probability (0–1) that the statement is true of the state
 *     { type: 'score', question?: string, levels: string[], describe?: { [level]: string } }
 *         place the state on an ordered ladder, levels listed low → high
 *
 *   answers: { [key: string]: Answer }, one per question key, where Answer is
 *     choice → { pick: string, p: { [option]: number }, conf: number }
 *     noul   → { p: number }
 *     score  → { level: string | number (index), p?: { [level]: number }, conf?: number }
 *
 * Keys: the five axes use their axis names (persistence, locus, outcome, overload, scope);
 * site-declared Nouls use `noul:<key>`.
 *
 * Responses are normalized defensively (see normalizeChoice); a structurally malformed
 * response throws JevResponseError, which rekurs treats as decider-unavailable and so falls
 * closed to the site default.
 */
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE } from '../axes.js';
import { statusOf } from './rules.js';

export class JevResponseError extends Error {
  constructor(message, response) {
    super(`jev: ${message}`);
    this.name = 'JevResponseError';
    this.response = response;
  }
}

/** Situation-describing labels. They describe what happened, never what to do about it. */
export const DEFAULT_LABELS = {
  persistence: {
    transient: 'the same call is likely to succeed if repeated shortly',
    persistent: 'repeating the same call will keep failing until something changes',
    unknown: 'there is not enough information to tell whether the failure will recur',
  },
  locus: {
    my_input: 'the request itself is wrong: bad input, credentials, or permissions',
    dependency: 'the remote service failed or refused to serve the request',
    network: 'the connection between caller and service failed',
    environment: 'the local runtime or configuration is broken (DNS, TLS, disk, config)',
    unknown: 'the source of the failure cannot be determined',
  },
  outcome: {
    did_not_happen: 'the operation definitely did not take effect on the remote side',
    may_have_happened: 'the operation may or may not have taken effect on the remote side',
    happened: 'the operation took effect but the response was lost or unusable',
  },
  scope: {
    this_call: 'only this one request is affected',
    this_dependency: 'every request to this service is affected',
    everything: 'many services or the whole system are affected',
  },
  overload: 'the failure is caused by too much load: rate limiting, saturation, or queue overflow',
};

const QUESTIONS = {
  persistence: 'Will the same call succeed if repeated soon?',
  locus: 'Where does the fault lie?',
  outcome: 'Did the operation take effect?',
  scope: 'How widely does the failure reach?',
};

const CHOICE_AXES = { persistence: PERSISTENCE, locus: LOCUS, outcome: OUTCOME };
export const NOUL_PREFIX = 'noul:';

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function mergeLabels(labels) {
  const out = {};
  for (const [axis, base] of Object.entries(DEFAULT_LABELS)) {
    const over = labels?.[axis];
    if (typeof base === 'string') out[axis] = typeof over === 'string' ? over : base;
    else out[axis] = { ...base, ...(over && typeof over === 'object' ? over : {}) };
  }
  return out;
}

const only = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

/** Build the question set for one failure. Exported for tests and inspection. */
export function buildQuestions(site = {}, labels = {}) {
  const L = mergeLabels(labels);
  const q = {};
  for (const [axis, options] of Object.entries(CHOICE_AXES)) {
    q[axis] = { type: 'choice', question: QUESTIONS[axis], options: [...options], describe: only(L[axis], options) };
  }
  q.overload = { type: 'noul', statement: L.overload };
  q.scope = { type: 'score', question: QUESTIONS.scope, levels: [...SCOPE], describe: only(L.scope, SCOPE) };
  for (const [key, statement] of Object.entries(site?.nouls ?? {})) {
    if (typeof statement === 'string' && statement) q[NOUL_PREFIX + key] = { type: 'noul', statement };
  }
  return q;
}

/**
 * Normalize a distribution over `options`: unknown keys dropped, non-numbers → 0,
 * clamped to [0,1], renormalized; all-zero or missing → uniform.
 */
export function normalizeDistribution(p, options) {
  const raw = options.map((o) => (p && typeof p === 'object' && isNum(p[o]) ? clamp01(p[o]) : 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  const vals = sum > 0 ? raw.map((x) => x / sum) : options.map(() => 1 / options.length);
  return Object.fromEntries(options.map((o, i) => [o, vals[i]]));
}

function argmax(p) {
  let best = null;
  let bp = -1;
  for (const [k, v] of Object.entries(p)) if (v > bp) { bp = v; best = k; }
  return best;
}

/**
 * Normalize a choice answer into { pick, p, conf }.
 * - p missing: if a valid pick and numeric conf are given, conf goes on pick and the rest
 *   is spread uniformly; otherwise the distribution is uniform.
 * - pick missing or not an option: argmax of p.
 * - conf missing: p[pick]. Always clamped to [0,1].
 */
export function normalizeChoice(answer, options, key = 'choice') {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new JevResponseError(`answer "${key}" missing or not an object`, answer);
  }
  const validPick = typeof answer.pick === 'string' && options.includes(answer.pick) ? answer.pick : null;
  const hasConf = isNum(answer.conf);
  let p;
  if (answer.p && typeof answer.p === 'object') p = normalizeDistribution(answer.p, options);
  else if (validPick && hasConf && options.length > 1) {
    const c = clamp01(answer.conf);
    p = Object.fromEntries(options.map((o) => [o, o === validPick ? c : (1 - c) / (options.length - 1)]));
  } else p = normalizeDistribution(null, options);
  const chosen = validPick ?? argmax(p);
  const conf = hasConf ? clamp01(answer.conf) : p[chosen];
  return { pick: chosen, p, conf };
}

/** Normalize a Score answer back into the choice shape { pick, p, conf } the policy reads. */
export function normalizeScore(answer, levels, key = 'score') {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new JevResponseError(`answer "${key}" missing or not an object`, answer);
  }
  let level = answer.level ?? answer.pick;
  if (Number.isInteger(level)) level = levels[level];
  return normalizeChoice({ pick: level, p: answer.p, conf: answer.conf }, levels, key);
}

/** Normalize a Noul answer into { p }. A bare number is accepted; a missing p → 0.5. */
export function normalizeNoul(answer, key = 'noul') {
  if (isNum(answer)) return { p: clamp01(answer) };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new JevResponseError(`answer "${key}" missing or not an object`, answer);
  }
  return { p: isNum(answer.p) ? clamp01(answer.p) : 0.5 };
}

/** Normalize a full response into an axis vector (+ advisory `nouls`). */
export function normalizeResponse(response, questions) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new JevResponseError('response is not an object', response);
  }
  const axes = {};
  for (const axis of Object.keys(CHOICE_AXES)) axes[axis] = normalizeChoice(response[axis], questions[axis].options, axis);
  axes.overload = normalizeNoul(response.overload, 'overload');
  axes.scope = normalizeScore(response.scope, questions.scope.levels, 'scope');

  const nouls = {};
  for (const key of Object.keys(questions)) {
    if (!key.startsWith(NOUL_PREFIX)) continue;
    try { nouls[key.slice(NOUL_PREFIX.length)] = normalizeNoul(response[key], key); }
    catch { /* advisory: a missing or broken site noul is not fatal */ }
  }
  if (Object.keys(nouls).length) axes.nouls = nouls;
  return axes;
}

/**
 * Fallback state renderer, used until the Sentry-backed renderer (src/gather/render.js)
 * is injected. Fixed order: exception → operation → attempts.
 */
export function fallbackRender(err, site = {}, ctx = {}, { budgetBytes = 2048 } = {}) {
  const lines = [`exception: ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`];
  if (err?.code) lines.push(`code: ${err.code}`);
  const status = statusOf(err);
  if (status !== null && status !== undefined) lines.push(`http status: ${status}`);
  if (site?.describe) lines.push(`operation: ${site.describe}`);
  if (site?.dependency) lines.push(`dependency: ${site.dependency}`);
  const n = ctx?.attempts?.length ?? 0;
  lines.push(`attempt: ${n + 1} (${n} prior failure${n === 1 ? '' : 's'})`);
  const text = lines.join('\n');
  return text.length > budgetBytes ? text.slice(0, budgetBytes) : text;
}

/**
 * createJevDecider({ client, render, p99Ms, labels, budgetBytes })
 * render(context, site, ctx, { budgetBytes, error }) → string; if absent, throws, or returns
 * an empty/non-string value, the fallback renderer is used.
 */
export function createJevDecider({ client, render = null, p99Ms = 300, labels = {}, budgetBytes = 2048, name = 'jev' } = {}) {
  if (!client || typeof client.ask !== 'function') throw new TypeError('createJevDecider: client with ask(state, questions) required');
  return {
    name,
    p99Ms,
    async decide(err, site, ctx = {}) {
      let state = null;
      if (render) {
        try { state = render(ctx?.context, site, ctx, { budgetBytes, error: err }); } catch { state = null; }
      }
      if (typeof state !== 'string' || !state) state = fallbackRender(err, site, ctx, { budgetBytes });
      const questions = buildQuestions(site, labels);
      const response = await client.ask(state, questions);
      return normalizeResponse(response, questions);
    },
  };
}
