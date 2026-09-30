/**
 * The deterministic policy: axes × site declarations × dependency state → action.
 * Hard gates never depend on a probability. Preference lists are data.
 * Returns { action, rule } — the matched rule is the structured "evaluation reason".
 */

export const DEFAULT_PREFERENCES = {
  breakerOpen: ['degrade', 'abort'],
  budgetExhausted: ['degrade', 'abort'],
  unknownOutcome: ['reconcile', 'abort'],
  overload: ['degrade', 'abort'],
  badInput: ['abort'],
  transient: ['retry'],
  fallthrough: ['degrade'],
};

export const DEFAULT_THRESHOLDS = {
  confidenceMin: 0.5,
  overloadMin: 0.6,
};

export function createPolicy({ preferences = {}, thresholds = {} } = {}) {
  const prefs = { ...DEFAULT_PREFERENCES, ...preferences };
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const pick = (site, list) => list.find((a) => a in site.actions) ?? site.default;
  const low = (ax) => ax.conf < th.confidenceMin;

  return function policy(axes, site, dep) {
    // ── hard gates: declarations + shared state, no probabilities ──
    if (dep.breaker.isOpen()) return { action: pick(site, prefs.breakerOpen), rule: 'breaker-open' };
    if (!dep.budget.canRetry()) return { action: pick(site, prefs.budgetExhausted), rule: 'budget-exhausted' };

    if (site.sideEffects && axes.outcome.pick !== 'did_not_happen') {
      return { action: pick(site, prefs.unknownOutcome), rule: 'side-effects-unknown-outcome' };
    }

    // ── perception-driven band ──
    if (axes.overload.p >= th.overloadMin) {
      if (axes.scope.pick !== 'this_call') dep.breaker.trip();
      return { action: pick(site, prefs.overload), rule: 'overload' };
    }

    if (axes.locus.pick === 'my_input' && !low(axes.locus)) {
      return { action: pick(site, prefs.badInput), rule: 'bad-input' };
    }

    const retrySafe = site.idempotent || axes.outcome.pick === 'did_not_happen';
    if (axes.persistence.pick === 'transient' && !low(axes.persistence) && retrySafe && 'retry' in site.actions) {
      dep.budget.spend();
      return { action: pick(site, prefs.transient), rule: 'transient-retry' };
    }

    if (axes.persistence.pick === 'persistent' && !low(axes.persistence) && axes.scope.pick !== 'this_call') {
      dep.breaker.trip();
      return { action: pick(site, [...prefs.fallthrough, site.default]), rule: 'persistent-dependency' };
    }

    const rule = low(axes.persistence) ? 'low-confidence' : 'fallthrough';
    return { action: pick(site, [...prefs.fallthrough, site.default]), rule };
  };
}
