/**
 * Record the demo scenarios as decision fixtures: node demo/record.js
 *
 * Runs every scenario in demo/scenarios.js (not the storm) through the same pipeline as the
 * demo, with the mock Jev decider wrapped in createRecordingDecider, then rewrites
 * test/fixtures/decisions.jsonl deterministically: each line is tagged with its scenario,
 * absolute paths are stripped from fingerprints, timestamps dropped, duplicates removed.
 * The mock client is keyword-based, so re-recording yields the same file.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecordingDecider, parseJsonl } from '../src/decider/fixture.js';
import { startFaultServer } from './fault-server.js';
import { buildDecider, FIXTURE_PATH } from './app.js';
import { runSuite, startSentry } from './index.js';
import { SCENARIOS } from './scenarios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Remove machine-specific path prefixes from a fingerprint's top frame. */
export function portableFingerprint(fp) {
  const rootUrl = `file://${ROOT}/`;
  return String(fp).split(rootUrl).join('').split(`${ROOT}/`).join('');
}

async function main() {
  const path = process.argv[2] ?? FIXTURE_PATH;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);

  const server = await startFaultServer();
  const setFault = (f) => server.setMode(f.mode, f);
  const decider = createRecordingDecider(buildDecider('mock-jev'), { path, now: () => null });
  const sentry = await startSentry('.rekurs/record.jsonl');

  const tagged = [];
  try {
    for (const scenario of SCENARIOS) {
      const before = existsSync(path) ? parseJsonl(readFileSync(path, 'utf8')).length : 0;
      await runSuite({ baseUrl: server.url, setFault, decider, sentry, scenarios: [scenario] });
      const lines = parseJsonl(readFileSync(path, 'utf8')).slice(before);
      for (const r of lines) tagged.push({ scenario: scenario.name, ...r });
    }
  } finally {
    await sentry?.close();
    await server.close();
  }

  const seen = new Set();
  const out = [];
  for (const r of tagged) {
    const { at, ...rest } = r;
    const record = { ...rest, fingerprint: portableFingerprint(r.fingerprint) };
    const key = `${record.scenario}|${record.fingerprint}|${JSON.stringify(record.axes)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  writeFileSync(path, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const counts = {};
  for (const r of out) counts[r.scenario] = (counts[r.scenario] ?? 0) + 1;
  const perScenario = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log(`wrote ${out.length} fixture record(s) to ${relative(process.cwd(), path)}\n  ${perScenario}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
