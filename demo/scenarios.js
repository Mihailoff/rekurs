/**
 * The scenario table shared by the demo, the fixture recorder and the CI eval.
 *
 * SITES are the static declarations of the two call sites (menus are listed by name; the demo
 * binds real handlers, the eval binds stubs). SCENARIOS pair an injected fault with the site it
 * hits and the decision the pipeline must make on the FIRST failure (`expected`), plus how the
 * invocation must end in the live demo (`final`: ok | cached | reconciled | aborted).
 *
 * `expected` is the regression contract: changing labels, thresholds or preference tables so
 * that any of these flips must fail CI (test/eval.test.js replays test/fixtures/decisions.jsonl
 * against it).
 *
 * Why malformed → degrade: a 200 carrying `{"error":"upstream exploded"}` is a gray failure.
 * Neither the rules decider nor the Jev stand-in can place it on the persistence axis with
 * confidence (it is not a timeout, not a status, not bad input), so the policy's low-confidence
 * band falls through to the site's explicit, exercised degrade (the cached value) instead of
 * retrying a response that did arrive or aborting a read that has a safe fallback. It stays
 * loud: the event and the decision are captured with the body attached as untrusted text.
 */

export const DEPENDENCY = 'fault-server';

export const SITES = {
  getWork: {
    description: 'GET /work: read the work queue',
    dependency: DEPENDENCY,
    idempotent: true,
    sideEffects: false,
    deadlineMs: 2_000,
    default: 'degrade',
    actions: ['retry', 'degrade', 'abort'],
  },
  charge: {
    description: 'POST /charge: charge the customer card',
    dependency: DEPENDENCY,
    idempotent: false,
    sideEffects: true,
    deadlineMs: 2_000,
    default: 'abort',
    actions: ['retry', 'reconcile', 'abort'],
  },
};

export const SCENARIOS = [
  { name: 'timeout GET', site: 'getWork', fault: { mode: 'timeout', n: 1 },
    expected: { action: 'retry', rule: 'transient-retry' }, final: 'ok' },
  { name: 'timeout POST', site: 'charge', fault: { mode: 'timeout', n: 1 },
    expected: { action: 'reconcile', rule: 'side-effects-unknown-outcome' }, final: 'reconciled' },
  { name: '503', site: 'getWork', fault: { mode: '503' },
    expected: { action: 'retry', rule: 'transient-retry' }, final: 'cached' }, // retries until the budget gate degrades
  { name: '429', site: 'getWork', fault: { mode: '429' },
    expected: { action: 'degrade', rule: 'overload' }, final: 'cached' },
  { name: '401', site: 'getWork', fault: { mode: '401' },
    expected: { action: 'abort', rule: 'bad-input' }, final: 'aborted' },
  { name: 'malformed', site: 'getWork', fault: { mode: 'malformed' },
    expected: { action: 'degrade', rule: 'low-confidence' }, final: 'cached' },
  { name: 'reset', site: 'getWork', fault: { mode: 'reset', n: 1 },
    expected: { action: 'retry', rule: 'transient-retry' }, final: 'ok' },
  { name: 'flap', site: 'getWork', fault: { mode: 'flap', n: 2 },
    expected: { action: 'retry', rule: 'transient-retry' }, final: 'ok' },
];

/** The four core faults of the prototype scope (design §13), used by the fast pipeline test. */
export const CORE = ['timeout GET', 'timeout POST', '503', '401', 'malformed'];

export const scenario = (name) => SCENARIOS.find((s) => s.name === name);

/** Declarations for a site with its menu bound to `handlers` ({ name: fn }). */
export function declare(siteName, handlers) {
  const { actions, ...rest } = SITES[siteName];
  const bound = {};
  for (const a of actions) {
    if (a === 'abort' && !(a in handlers)) continue; // rekurs provides abort
    if (!(a in handlers)) throw new TypeError(`declare(${siteName}): no handler for action "${a}"`);
    bound[a] = handlers[a];
  }
  return { ...rest, actions: bound };
}
