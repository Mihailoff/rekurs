/**
 * The rules decider: a lookup table over error code and HTTP status → axis vector.
 * This is the deterministic tier — the baseline every smarter decider is measured against.
 */
import { PERSISTENCE, LOCUS, OUTCOME, SCOPE, certain, choice, unknownAxes } from '../axes.js';

const NET_TRANSIENT = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const NET_PERSISTENT = new Set(['ENOTFOUND', 'ECONNABORTED', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

export function statusOf(err) {
  return err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.cause?.status ?? null;
}

export function isTimeout(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'ETIMEDOUT'
    || err?.code === 'UND_ERR_HEADERS_TIMEOUT' || err?.code === 'UND_ERR_BODY_TIMEOUT';
}

export function classify(err) {
  const status = statusOf(err);
  const code = err?.code;

  if (isTimeout(err)) {
    return {
      persistence: certain(PERSISTENCE, 'transient', 0.7),
      locus: choice({ dependency: 0.5, network: 0.4, my_input: 0.02, environment: 0.05, unknown: 0.03 }),
      outcome: certain(OUTCOME, 'may_have_happened', 0.9),
      overload: { p: 0.3 },
      scope: certain(SCOPE, 'this_call', 0.6),
    };
  }

  if (code && NET_TRANSIENT.has(code)) {
    const sent = code === 'EPIPE' || code === 'ECONNRESET';
    return {
      persistence: certain(PERSISTENCE, 'transient', 0.8),
      locus: certain(LOCUS, 'network', 0.7),
      outcome: sent ? certain(OUTCOME, 'may_have_happened', 0.6) : certain(OUTCOME, 'did_not_happen', 0.9),
      overload: { p: code === 'ECONNREFUSED' ? 0.3 : 0.1 },
      scope: certain(SCOPE, 'this_dependency', 0.6),
    };
  }

  if (code && NET_PERSISTENT.has(code)) {
    return {
      persistence: certain(PERSISTENCE, 'persistent', 0.85),
      locus: certain(LOCUS, 'environment', 0.6),
      outcome: certain(OUTCOME, 'did_not_happen', 0.95),
      overload: { p: 0.02 },
      scope: certain(SCOPE, 'this_dependency', 0.8),
    };
  }

  if (typeof status === 'number') {
    if (status === 429) {
      return {
        persistence: certain(PERSISTENCE, 'transient', 0.7),
        locus: certain(LOCUS, 'dependency', 0.8),
        outcome: certain(OUTCOME, 'did_not_happen', 0.95),
        overload: { p: 0.95 },
        scope: certain(SCOPE, 'this_dependency', 0.7),
      };
    }
    if (status === 503 || status === 502 || status === 504) {
      return {
        persistence: certain(PERSISTENCE, 'transient', 0.65),
        locus: certain(LOCUS, 'dependency', 0.8),
        outcome: status === 504 ? certain(OUTCOME, 'may_have_happened', 0.7) : certain(OUTCOME, 'did_not_happen', 0.85),
        overload: { p: status === 503 ? 0.5 : 0.3 },
        scope: certain(SCOPE, 'this_dependency', 0.7),
      };
    }
    if (status >= 500) {
      return {
        persistence: choice({ transient: 0.4, persistent: 0.35, unknown: 0.25 }),
        locus: certain(LOCUS, 'dependency', 0.7),
        outcome: certain(OUTCOME, 'may_have_happened', 0.6),
        overload: { p: 0.2 },
        scope: certain(SCOPE, 'this_call', 0.5),
      };
    }
    if (status === 401 || status === 403) {
      return {
        persistence: certain(PERSISTENCE, 'persistent', 0.9),
        locus: certain(LOCUS, 'my_input', 0.85),
        outcome: certain(OUTCOME, 'did_not_happen', 0.98),
        overload: { p: 0.01 },
        scope: certain(SCOPE, 'this_dependency', 0.6),
      };
    }
    if (status === 408) {
      return {
        persistence: certain(PERSISTENCE, 'transient', 0.6),
        locus: certain(LOCUS, 'network', 0.5),
        outcome: certain(OUTCOME, 'did_not_happen', 0.8),
        overload: { p: 0.2 },
        scope: certain(SCOPE, 'this_call', 0.7),
      };
    }
    if (status >= 400) {
      return {
        persistence: certain(PERSISTENCE, 'persistent', 0.9),
        locus: certain(LOCUS, 'my_input', 0.9),
        outcome: certain(OUTCOME, 'did_not_happen', 0.98),
        overload: { p: 0.01 },
        scope: certain(SCOPE, 'this_call', 0.9),
      };
    }
  }

  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return {
      persistence: certain(PERSISTENCE, 'persistent', 0.85),
      locus: certain(LOCUS, 'my_input', 0.7),
      outcome: certain(OUTCOME, 'may_have_happened', 0.5),
      overload: { p: 0.01 },
      scope: certain(SCOPE, 'this_call', 0.8),
    };
  }

  return unknownAxes();
}

/** Decider interface: { name, p99Ms, decide(err, site, ctx) → Promise<axes> } */
export function createRulesDecider() {
  return {
    name: 'rules',
    p99Ms: 0,
    async decide(err) { return classify(err); },
  };
}
