/**
 * A tiny in-process fault server: the flaky dependency the demo, the eval and the Toxiproxy
 * harness all talk to. Zero deps (node:http).
 *
 *   GET  /work              the call site under test; behaviour set by the current fault mode
 *   POST /charge            same fault modes; a charge is recorded by idempotency-key. In
 *                           `timeout` mode the charge IS recorded before the server goes silent
 *                           (the operation happened, the response was lost).
 *   GET  /charges/:key      lookup for reconcile (never faulted)
 *   GET  /__fault           current mode + request counters
 *   POST /__fault           { mode, n?, ms? } set the global mode
 *
 * A request header `x-fault: <mode>[:<ms>]` overrides the global mode for that one request.
 *
 * Modes: ok · timeout (never responds, or responds after `ms`) · 503 · 502 · 500 · 401 ·
 * 429 (Retry-After) · malformed (200 with an error-shaped body) · reset (socket destroyed) ·
 * slow (200 after `ms`, a gray failure) · flap (fail `n` times with 502, succeed once, repeat).
 * For every mode except flap, `n` limits the fault to the next n requests, then back to ok.
 *
 *   startFaultServer({ port = 0 }) → { url, port, setMode(mode, { n, ms }), state(), close() }
 *   CLI: node demo/fault-server.js [--port 8099]
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const MODES = ['ok', 'timeout', '503', '502', '500', '401', '429', 'malformed', 'reset', 'slow', 'flap'];

const ERROR_BODIES = {
  503: { error: 'service unavailable' },
  502: { error: 'bad gateway' },
  500: { error: 'internal error' },
  401: { error: 'unauthorized: token expired' },
  429: { error: 'too many requests' },
};

export async function startFaultServer({ port = 0, host = '127.0.0.1' } = {}) {
  let fault = { mode: 'ok', n: null, ms: null };
  let flapCount = 0;
  const counts = { requests: 0, byMode: {} };
  const charges = new Map();
  const timers = new Set();

  function setMode(mode, { n = null, ms = null } = {}) {
    if (!MODES.includes(mode)) throw new TypeError(`fault-server: unknown mode "${mode}" (${MODES.join(', ')})`);
    fault = { mode, n: Number.isInteger(n) && n > 0 ? n : null, ms: Number.isFinite(ms) ? ms : null };
    flapCount = 0;
    return { ...fault };
  }

  /** Resolve the mode for one request: header override, else the global mode (consuming n). */
  function modeFor(req) {
    const header = req.headers['x-fault'];
    if (typeof header === 'string' && header) {
      const [mode, ms] = header.split(':');
      if (MODES.includes(mode)) return { mode, ms: ms ? Number(ms) : null, n: null };
    }
    const current = { ...fault };
    if (fault.mode === 'flap') {
      const k = fault.n ?? 2;
      const fail = flapCount % (k + 1) < k;
      flapCount += 1;
      return { ...current, mode: fail ? '502' : 'ok' };
    }
    if (fault.n !== null && fault.mode !== 'ok') {
      fault.n -= 1;
      if (fault.n <= 0) fault = { mode: 'ok', n: null, ms: null };
    }
    return current;
  }

  const later = (ms, fn) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  };

  function json(res, status, body, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/__fault') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { return json(res, 200, setMode(body.mode, body)); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 200, { ...fault, counts });
    }

    const lookup = url.pathname.match(/^\/charges\/([^/]+)$/);
    if (lookup && req.method === 'GET') {
      const charge = charges.get(decodeURIComponent(lookup[1]));
      return charge ? json(res, 200, charge) : json(res, 404, { error: 'no such charge' });
    }

    const isWork = url.pathname === '/work' && (req.method === 'GET' || req.method === 'POST');
    const isCharge = url.pathname === '/charge' && req.method === 'POST';
    if (!isWork && !isCharge) return json(res, 404, { error: 'not found' });

    const body = isCharge ? await readBody(req) : null;
    const { mode, ms } = modeFor(req);
    counts.requests += 1;
    counts.byMode[mode] = (counts.byMode[mode] ?? 0) + 1;

    const record = () => {
      const key = req.headers['idempotency-key'] ?? `auto-${charges.size + 1}`;
      if (!charges.has(key)) charges.set(key, { id: key, amount: body?.amount ?? 0, status: 'captured' });
      return charges.get(key);
    };
    const success = () => (isCharge
      ? json(res, 201, record())
      : json(res, 200, { items: [{ id: 1, task: 'ship it' }, { id: 2, task: 'measure the residual' }], servedAt: Date.now() }));

    switch (mode) {
      case 'ok': return success();
      case 'timeout':
        if (isCharge) record(); // the side effect happened; only the response is lost
        if (Number.isFinite(ms)) later(ms, success);
        return; // otherwise hold the socket open until the client gives up
      case 'slow': return later(Number.isFinite(ms) ? ms : 1_000, success);
      case '429': return json(res, 429, ERROR_BODIES[429], { 'retry-after': '1' });
      case '503': case '502': case '500': case '401':
        return json(res, Number(mode), ERROR_BODIES[mode]);
      case 'malformed': return json(res, 200, { error: 'upstream exploded' });
      case 'reset':
        if (typeof req.socket.resetAndDestroy === 'function') req.socket.resetAndDestroy();
        else req.socket.destroy();
        return;
      default: return json(res, 500, { error: `unhandled mode ${mode}` });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { json(res, 500, { error: 'fault-server bug' }); } catch { /* ignore */ } });
  });
  server.keepAliveTimeout = 1_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    setMode,
    state: () => ({ ...fault, counts: structuredClone(counts), charges: charges.size }),
    charges,
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = process.argv.find((a) => a.startsWith('--port'));
  const port = arg ? Number(arg.split('=')[1] ?? process.argv[process.argv.indexOf(arg) + 1]) : 8099;
  const srv = await startFaultServer({ port });
  console.log(`fault-server listening on ${srv.url}`);
  console.log(`  curl ${srv.url}/work`);
  console.log(`  curl -X POST ${srv.url}/__fault -d '{"mode":"503","n":2}'`);
  console.log(`  curl -H 'x-fault: timeout:500' ${srv.url}/work`);
  console.log(`modes: ${MODES.join(', ')}`);
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
