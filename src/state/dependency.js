/**
 * Per-dependency shared state: a circuit breaker and a retry budget.
 * Per-call decisions without this view build the retry storm.
 */

export function createBreaker({ failureThreshold = 5, cooldownMs = 10_000, now = Date.now } = {}) {
  let state = 'closed';
  let failures = 0;
  let openedAt = 0;
  return {
    isOpen() {
      if (state === 'open' && now() - openedAt >= cooldownMs) state = 'half-open';
      return state === 'open';
    },
    state: () => state,
    trip() { state = 'open'; openedAt = now(); },
    recordFailure() {
      failures += 1;
      if (state === 'half-open' || failures >= failureThreshold) this.trip();
    },
    recordSuccess() { failures = 0; state = 'closed'; },
    reset() { failures = 0; state = 'closed'; openedAt = 0; },
  };
}

/**
 * Envoy-style retry budget: retries may not exceed `ratio` of calls in the window,
 * with a floor of `minRetries` so a cold dependency can still retry.
 */
export function createRetryBudget({ ratio = 0.2, minRetries = 3, windowMs = 10_000, now = Date.now } = {}) {
  let calls = [];
  let retries = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    calls = calls.filter((t) => t > cutoff);
    retries = retries.filter((t) => t > cutoff);
  };
  return {
    recordCall() { calls.push(now()); },
    spend() { retries.push(now()); },
    canRetry() {
      prune();
      return retries.length < Math.max(minRetries, Math.floor(calls.length * ratio));
    },
    stats() { prune(); return { calls: calls.length, retries: retries.length }; },
  };
}

/** A registry of dependency state keyed by name; one per process by default. */
export function createDependencyRegistry(options = {}) {
  const deps = new Map();
  return {
    get(name) {
      if (!deps.has(name)) {
        deps.set(name, { name, breaker: createBreaker(options.breaker), budget: createRetryBudget(options.budget) });
      }
      return deps.get(name);
    },
    reset() { deps.clear(); },
  };
}
