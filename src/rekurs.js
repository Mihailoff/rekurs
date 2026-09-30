/**
 * rekurs(fn, site): run fn; on failure gather → decide → policy → act, and return an envelope.
 * rekurs does not recurse: every loop iteration charges the deadline and the dependency budget.
 */
import { createPolicy } from './policy.js';
import { createRulesDecider } from './decider/rules.js';
import { createDependencyRegistry } from './state/dependency.js';
import { flattenAxes } from './axes.js';

export const RETRY = Symbol('rekurs.retry');

export class TimeoutError extends Error {
  constructor(ms) { super(`operation exceeded ${ms}ms`); this.name = 'TimeoutError'; this.timeoutMs = ms; }
}

export class RekursError extends Error {
  constructor(cause, trail, action) {
    super(`rekurs: ${action} after ${trail.length} attempt(s): ${cause?.message ?? cause}`);
    this.name = 'RekursError';
    this.cause = cause;
    this.trail = trail;
    this.action = action;
  }
}

const defaultRegistry = createDependencyRegistry();
const defaultPolicy = createPolicy();
const defaultDecider = createRulesDecider();

const builtinActions = {
  abort: (err) => { throw err; },
};

/** Ready-made retry handler: sleeps with capped exponential backoff + jitter, then signals RETRY. */
export function retry({ max = 3, baseMs = 100, capMs = 2_000, jitter = true, sleep = defaultSleep } = {}) {
  return async (err, ctx) => {
    const n = ctx.attempts.filter((a) => a.action === 'retry').length; // includes this one
    if (n > max) throw err;
    let delay = Math.min(capMs, baseMs * 2 ** (n - 1));
    if (jitter) delay = Math.floor(delay * (0.5 + Math.random() * 0.5));
    if (delay >= ctx.remainingMs()) throw err;
    await sleep(delay);
    return RETRY;
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDeadline(fn, ms, signal) {
  if (!Number.isFinite(ms)) return fn(signal);
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); reject(new TimeoutError(ms)); }, Math.max(0, ms));
    Promise.resolve()
      .then(() => fn(ctrl.signal))
      .then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export function normalizeSite(site) {
  if (!site || typeof site !== 'object') throw new TypeError('rekurs: declarations object required');
  const actions = { ...builtinActions, ...(site.actions ?? {}) };
  const idempotent = site.idempotent === true;
  const out = {
    describe: site.describe ?? '',
    dependency: site.dependency ?? 'default',
    idempotent,
    sideEffects: site.sideEffects ?? !idempotent,
    deadlineMs: site.deadlineMs ?? Infinity,
    criticality: site.criticality ?? 'normal',
    nouls: site.nouls ?? {},
    default: site.default ?? 'abort',
    actions,
    maxAttempts: site.maxAttempts ?? 10,
  };
  if (!(out.default in actions)) throw new TypeError(`rekurs: default action "${out.default}" is not in actions`);
  return out;
}

export function createRekurs({
  decider = defaultDecider,
  policy = defaultPolicy,
  registry = defaultRegistry,
  gather = null,          // async (err, site, ctx) → context object (phase 2: Sentry)
  onDecision = null,      // (record) → void — audit hook
  now = Date.now,
} = {}) {
  async function decide(err, site, ctx, dep) {
    const remaining = ctx.remainingMs();
    let axes = null;
    let rule = null;
    let reason = null;

    if (decider.p99Ms > 0 && remaining < decider.p99Ms * 2) reason = 'deadline';
    else {
      try { axes = await decider.decide(err, site, ctx); }
      catch (e) { reason = typeof e?.code === 'string' ? `decider-unavailable:${e.code}` : 'decider-unavailable'; ctx.deciderError = e; }
    }

    let action;
    if (axes) ({ action, rule } = policy(axes, site, dep));
    else { action = site.default; rule = reason; }

    if (!(action in site.actions)) { action = site.default; rule = `${rule}→default`; }
    return { action, rule, axes };
  }

  return async function rekurs(fn, declarations) {
    const site = normalizeSite(declarations);
    const dep = registry.get(site.dependency);
    const startedAt = now();
    const ctx = {
      site,
      dependency: dep,
      attempts: [],
      startedAt,
      remainingMs: () => site.deadlineMs - (now() - startedAt),
    };

    for (;;) {
      dep.budget.recordCall();
      try {
        const value = await withDeadline(fn, ctx.remainingMs(), undefined);
        dep.breaker.recordSuccess();
        return { value, action: 'none', attempts: ctx.attempts, degraded: false };
      } catch (err) {
        dep.breaker.recordFailure();
        if (gather) { try { ctx.context = await gather(err, site, ctx); } catch { /* gathering never blocks recovery */ } }

        const { action, rule, axes } = ctx.attempts.length >= site.maxAttempts
          ? { action: site.default, rule: 'max-attempts', axes: null }
          : await decide(err, site, ctx, dep);

        const attempt = { at: now(), error: err, action, rule, axes };
        ctx.attempts.push(attempt);
        onDecision?.({ site: site.describe, dependency: site.dependency, action, rule, axes: axes && flattenAxes(axes), error: describeError(err) });

        let out;
        try { out = await site.actions[action](err, ctx); }
        catch (e) { throw wrap(e, ctx.attempts, action); }

        if (out === RETRY) continue;
        return { value: out, action, attempts: ctx.attempts, degraded: action !== 'none' };
      }
    }
  };
}

function wrap(e, trail, action) {
  if (e instanceof RekursError) return e;
  const err = new RekursError(e, trail, action);
  return err;
}

function describeError(err) {
  return { name: err?.name, message: err?.message, code: err?.code, status: err?.status ?? err?.statusCode ?? null };
}

/** Process-wide default instance. */
export const rekurs = createRekurs();
