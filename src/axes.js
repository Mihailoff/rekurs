/**
 * The five fault axes — the answer space a decider fills in and the policy reads.
 * Each choice axis is { pick, p: {option: prob}, conf }; the noul axis is { p }.
 */
export const PERSISTENCE = ['transient', 'persistent', 'unknown'];
export const LOCUS = ['my_input', 'dependency', 'network', 'environment', 'unknown'];
export const OUTCOME = ['did_not_happen', 'may_have_happened', 'happened'];
export const SCOPE = ['this_call', 'this_dependency', 'everything'];

/** Build a choice axis from a distribution; pick = argmax, conf = its probability. */
export function choice(p) {
  let pick = null;
  let best = -1;
  for (const [option, prob] of Object.entries(p)) {
    if (prob > best) { best = prob; pick = option; }
  }
  return { pick, p, conf: best };
}

/** A choice axis with all mass on one option. */
export function certain(options, pick, conf = 1) {
  const rest = options.length > 1 ? (1 - conf) / (options.length - 1) : 0;
  const p = Object.fromEntries(options.map((o) => [o, o === pick ? conf : rest]));
  return { pick, p, conf };
}

/** The "we know nothing" vector: every axis unknown at low confidence. */
export function unknownAxes() {
  return {
    persistence: certain(PERSISTENCE, 'unknown', 0.34),
    locus: certain(LOCUS, 'unknown', 0.2),
    outcome: certain(OUTCOME, 'may_have_happened', 0.34),
    overload: { p: 0.1 },
    scope: certain(SCOPE, 'this_call', 0.34),
  };
}

/** Flatten an axis vector into scalar tags (for logs / event annotation). */
export function flattenAxes(axes) {
  const out = {};
  for (const [name, ax] of Object.entries(axes)) {
    if ('pick' in ax) { out[`${name}.pick`] = ax.pick; out[`${name}.conf`] = ax.conf; }
    else out[`${name}.p`] = ax.p;
  }
  return out;
}
