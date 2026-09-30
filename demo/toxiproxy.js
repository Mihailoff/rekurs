/**
 * Optional network-level harness: the demo call sites through real network faults.
 *
 *   toxiproxy-server &            # brew install toxiproxy   (or the docker image, see below)
 *   node demo/toxiproxy.js [--decider=mock-jev|rules|fixture] [--no-sentry]
 *
 * A Toxiproxy proxy is put in front of the in-process fault server (which stays in `ok` mode);
 * each scenario applies one toxic, calls the site once, and removes it. The injected toxic is
 * the label. Env:
 *   TOXIPROXY_URL            API (default http://localhost:8474)
 *   TOXIPROXY_LISTEN         proxy listen address (default 127.0.0.1:26474)
 *   TOXIPROXY_UPSTREAM_HOST  how Toxiproxy reaches this process (default 127.0.0.1;
 *                            host.docker.internal when Toxiproxy runs in docker)
 * If Toxiproxy is not reachable, prints install hints and exits 0.
 */
import { createGuardedDecider } from '../src/decider/guarded.js';
import { startFaultServer } from './fault-server.js';
import { buildDecider, tableRow, formatTable, TABLE_COLUMNS } from './app.js';
import { runSuite, startSentry } from './index.js';

const API = (process.env.TOXIPROXY_URL ?? 'http://localhost:8474').replace(/\/$/, '');
const LISTEN = process.env.TOXIPROXY_LISTEN ?? '127.0.0.1:26474';
const UPSTREAM_HOST = process.env.TOXIPROXY_UPSTREAM_HOST ?? '127.0.0.1';
const PROXY = 'rekurs-demo';

/** Network-level scenarios: one toxic each, on the downstream (response) stream. */
export const TOXIC_SCENARIOS = [
  { name: 'latency 1s GET', site: 'getWork', toxic: { type: 'latency', attributes: { latency: 1_000, jitter: 0 } } },
  { name: 'blackhole GET', site: 'getWork', toxic: { type: 'timeout', attributes: { timeout: 0 } } },
  { name: 'blackhole POST', site: 'charge', toxic: { type: 'timeout', attributes: { timeout: 0 } } },
  { name: 'reset_peer GET', site: 'getWork', toxic: { type: 'reset_peer', attributes: { timeout: 0 } } },
  { name: 'slicer GET', site: 'getWork', toxic: { type: 'slicer', attributes: { average_size: 16, size_variation: 4, delay: 20_000 } } },
  { name: 'limit_data GET', site: 'getWork', toxic: { type: 'limit_data', attributes: { bytes: 60 } } },
];

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2_000),
  });
  const text = await res.text();
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(`toxiproxy ${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function reachable() {
  try { await api('GET', '/version'); return true; } catch { return false; }
}

function printInstallHelp() {
  console.log(`Toxiproxy is not reachable at ${API}; skipping the network-level harness.`);
  console.log('');
  console.log('Install and start it, then re-run `npm run demo:toxiproxy`:');
  console.log('  macOS:  brew install toxiproxy && toxiproxy-server');
  console.log('  docker: docker run --rm -p 8474:8474 -p 26474:26474 ghcr.io/shopify/toxiproxy');
  console.log('          TOXIPROXY_UPSTREAM_HOST=host.docker.internal TOXIPROXY_LISTEN=0.0.0.0:26474 npm run demo:toxiproxy');
  console.log('Set TOXIPROXY_URL if the API listens elsewhere.');
}

async function main() {
  if (!(await reachable())) { printInstallHelp(); return 0; }
  const args = process.argv.slice(2);
  const kind = args.find((a) => a.startsWith('--decider='))?.slice('--decider='.length) ?? 'mock-jev';

  const server = await startFaultServer({ host: UPSTREAM_HOST === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0' });
  await api('DELETE', `/proxies/${PROXY}`);
  await api('POST', '/proxies', { name: PROXY, listen: LISTEN, upstream: `${UPSTREAM_HOST}:${server.port}`, enabled: true });
  const proxyUrl = `http://${LISTEN.replace(/^0\.0\.0\.0/, '127.0.0.1')}`;

  let applied = false;
  const setFault = async (f) => {
    if (applied) { await api('DELETE', `/proxies/${PROXY}/toxics/fault`); applied = false; }
    if (f?.toxic) {
      await api('POST', `/proxies/${PROXY}/toxics`, { name: 'fault', stream: 'downstream', toxicity: 1, ...f.toxic });
      applied = true;
    }
  };

  const decider = createGuardedDecider(buildDecider(kind));
  const sentry = args.includes('--no-sentry') ? null : await startSentry('.rekurs/toxiproxy.jsonl');
  try {
    const results = await runSuite({
      baseUrl: proxyUrl,
      setFault,
      decider,
      sentry,
      scenarios: TOXIC_SCENARIOS.map((s) => ({ ...s, fault: { toxic: s.toxic } })),
      appOptions: { reconcileUrl: server.url }, // the lookup goes out of band, past the proxy
    });
    const rows = results.map(({ summary }) => tableRow(summary, null, decider.name));
    console.log(`rekurs × Toxiproxy · proxy ${proxyUrl} → fault server ${server.url} · decider ${decider.name}`);
    console.log('');
    console.log(formatTable(rows, TABLE_COLUMNS.filter((c) => c !== 'check')));
  } finally {
    await setFault(null).catch(() => {});
    await api('DELETE', `/proxies/${PROXY}`).catch(() => {});
    await sentry?.close();
    await server.close();
  }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
