/**
 * Recording and replay deciders: the fixture half of the feedback loop.
 *
 * createRecordingDecider(inner, { path }) — wraps any decider and appends every decision as
 *   one JSONL line: { fingerprint, error, site, axes, decider, at }.
 * createFixtureDecider({ path | records, fallback }) — replays recorded axes by fingerprint
 *   (exact match, then a relaxed key without the top frame); misses go to `fallback` or throw
 *   FixtureMissError.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint } from '../fingerprint.js';
import { statusOf } from './rules.js';

export class FixtureMissError extends Error {
  constructor(key) {
    super(`fixture: no recorded decision for ${key}`);
    this.name = 'FixtureMissError';
    this.fingerprint = key;
  }
}

/** The fingerprint without its last segment (the top stack frame). */
export function relaxedKey(fp) {
  const parts = String(fp).split('|');
  return parts.length > 1 ? parts.slice(0, -1).join('|') : parts[0];
}

export function createRecordingDecider(inner, { path, now = () => new Date().toISOString() } = {}) {
  if (!inner || typeof inner.decide !== 'function') throw new TypeError('createRecordingDecider: inner decider required');
  if (!path) throw new TypeError('createRecordingDecider: path required');
  let dirReady = false;
  return {
    name: `recording(${inner.name})`,
    p99Ms: inner.p99Ms ?? 0,
    async decide(err, site, ctx) {
      const axes = await inner.decide(err, site, ctx);
      const record = {
        fingerprint: fingerprint(err, site),
        error: { name: err?.name, message: err?.message, code: err?.code ?? null, status: statusOf(err) },
        site: { description: site?.description, dependency: site?.dependency, idempotent: site?.idempotent, sideEffects: site?.sideEffects },
        axes,
        decider: inner.name,
        at: now(),
      };
      try {
        if (!dirReady) { mkdirSync(dirname(path), { recursive: true }); dirReady = true; }
        appendFileSync(path, `${JSON.stringify(record)}\n`);
      } catch { /* recording never blocks recovery */ }
      return axes;
    },
  };
}

/** Parse JSONL text into records; blank and unparsable lines are skipped. */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

export function createFixtureDecider({ path = null, records = null, fallback = null } = {}) {
  if (!path && !records) throw new TypeError('createFixtureDecider: path or records required');
  let index = null;

  function load() {
    if (index) return index;
    const list = records ?? (existsSync(path) ? parseJsonl(readFileSync(path, 'utf8')) : []);
    const exact = new Map();
    const relaxed = new Map();
    for (const r of list) {
      if (!r || typeof r.fingerprint !== 'string' || !r.axes) continue;
      exact.set(r.fingerprint, r.axes); // later records win
      relaxed.set(relaxedKey(r.fingerprint), r.axes);
    }
    index = { exact, relaxed };
    return index;
  }

  return {
    name: 'fixture',
    p99Ms: 0,
    size: () => load().exact.size,
    lookup(err, site) {
      const { exact, relaxed } = load();
      const fp = fingerprint(err, site);
      if (exact.has(fp)) return { match: 'exact', axes: exact.get(fp) };
      const rk = relaxedKey(fp);
      if (relaxed.has(rk)) return { match: 'relaxed', axes: relaxed.get(rk) };
      return { match: null, fingerprint: fp };
    },
    async decide(err, site, ctx) {
      const hit = this.lookup(err, site);
      if (hit.match) return structuredClone(hit.axes);
      if (fallback) return fallback.decide(err, site, ctx);
      throw new FixtureMissError(hit.fingerprint);
    },
  };
}
