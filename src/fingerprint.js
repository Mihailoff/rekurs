/**
 * Extended fingerprint: the decision-cache key. Sentry's default grouping (type + stack)
 * collides across statuses thrown from one line, so this adds the discriminating fields.
 */
import { statusOf } from './decider/rules.js';

export function topFrame(err) {
  const line = (err?.stack ?? '').split('\n').find((l) => /^\s+at /.test(l) && !l.includes('node:internal'));
  return line ? line.trim().replace(/^at /, '').replace(/:\d+:\d+\)?$/, '') : '';
}

export function fingerprint(err, site = {}) {
  return [
    site.dependency ?? 'default',
    err?.name ?? 'Error',
    err?.code ?? '',
    statusOf(err) ?? '',
    topFrame(err),
  ].join('|');
}
