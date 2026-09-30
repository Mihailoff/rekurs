/**
 * A generic JSON-over-HTTP client for the demo: fetch plus error normalization. This is the
 * transport adapter every call site shares, not per-error handling: it only turns what fetch
 * reports into errors that carry their facts (status, code, body) so rekurs can perceive them.
 *
 *   - non-2xx                 → HttpError { status, body, retryAfter }
 *   - per-attempt timeout     → RequestTimeoutError (name TimeoutError, code ETIMEDOUT)
 *   - socket-level failure    → NetworkError { code } (fetch hides the code in err.cause)
 *   - 2xx that fails validate → InvalidResponseError { status, body }  (gray failure)
 */

export class HttpError extends Error {
  constructor(method, path, status, body, retryAfter = null) {
    super(`${method} ${path} → HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends Error {
  constructor(method, path, code, cause) {
    super(`${method} ${path}: ${cause?.message ?? 'network failure'} (${code})`);
    this.name = 'NetworkError';
    this.code = code;
    this.cause = cause;
  }
}

export class RequestTimeoutError extends Error {
  constructor(method, path, ms) {
    super(`${method} ${path} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeoutMs = ms;
  }
}

export class InvalidResponseError extends Error {
  constructor(method, path, status, body, reason) {
    super(`${method} ${path}: invalid response (${reason})`);
    this.name = 'InvalidResponseError';
    this.status = status;
    this.body = body;
  }
}

/** Throws unless the value is a non-error-shaped object; returns it otherwise. */
export function assertPayload(value, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload is not an object');
  if ('error' in value) throw new Error('payload is error-shaped');
  for (const key of required) if (!(key in value)) throw new Error(`payload lacks "${key}"`);
  return value;
}

export async function requestJson(baseUrl, path, {
  method = 'GET', body, headers = {}, signal, timeoutMs = 250, validate = null,
} = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  let text;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signals,
    });
    text = await res.text();
  } catch (err) {
    if (timeout.aborted) throw new RequestTimeoutError(method, path, timeoutMs);
    if (err?.name === 'AbortError') throw err;
    const cause = err?.cause ?? err;
    throw new NetworkError(method, path, cause?.code ?? 'UND_ERR_SOCKET', cause);
  }

  if (!res.ok) throw new HttpError(method, path, res.status, text, res.headers.get('retry-after'));

  let value;
  try { value = JSON.parse(text); } catch { throw new InvalidResponseError(method, path, res.status, text, 'body is not JSON'); }
  if (validate) {
    try { value = validate(value) ?? value; } catch (e) { throw new InvalidResponseError(method, path, res.status, text, e?.message ?? 'rejected'); }
  }
  return value;
}
