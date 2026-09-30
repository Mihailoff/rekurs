/**
 * Context gathering with the Sentry Node SDK, offline: keep the gatherer, swap the transport.
 *
 *   const sentry = await createSentryGather({ jsonlPath: '.rekurs/events.jsonl' });
 *   const run = sentry.wrap(createRekurs({ gather: sentry.gather, onDecision: sentry.annotate }));
 *   await run(fn, declarations);
 *
 * @sentry/node is an optional dependency, loaded lazily; the rest of rekurs never imports it.
 *
 * ── Coexistence with a host app that already runs Sentry ──────────────────────────────────
 * We always capture through OUR OWN client (custom transport → sink/JSONL, never the network),
 * bound to a cloned scope that we pass to `client.captureException(err, hint, scope)`.
 *
 *  - No host client (`Sentry.getClient()` is undefined): we call `Sentry.init` with
 *    `defaultIntegrations: false` and an explicit list (http + fetch + console breadcrumbs,
 *    context lines, node contexts, linked errors; local variables opt-in). This is the only
 *    supported way to get the SDK's async-context strategy (needed for isolation scopes) and
 *    the breadcrumb instrumentation. Our client becomes the process's global client; no
 *    uncaught-exception / unhandled-rejection handlers, no sessions, no tracing are installed.
 *
 *  - Host client exists: we do NOT re-init or touch its transport, DSN, or options. We build an
 *    isolated `new NodeClient` (event-processing integrations only, no instrumentation) and
 *    capture with a scope bound to it. Breadcrumbs still come from the host's instrumentation,
 *    because the SDK merges the active isolation scope into every captured event.
 *    Tradeoff: breadcrumb coverage is whatever the host enabled (we add no instrumentation of
 *    our own), host `beforeSend`/`beforeBreadcrumb` hooks do not see our events (they do see
 *    the breadcrumbs we add), and host events are not copied into our sink. We chose this over
 *    a host-side event processor because a processor would run on every host event and
 *    couple our fixtures to the host's sampling and scrubbing configuration.
 *
 * Isolation: `wrap(rekursFn)` runs each invocation inside `Sentry.withIsolationScope`, so
 * breadcrumbs recorded during one call never appear in another concurrent call's event.
 * Without `wrap`, events carry whatever the caller's isolation scope holds (per incoming
 * request if the host's HTTP server integration is active).
 *
 * Capture once per failure: the first failure of an invocation (keyed by its rekurs `ctx`)
 * produces the event; later failures become `rekurs.attempt` breadcrumbs. `annotate(record)`
 * writes the decision back: onto the in-memory copy of the event (tags + contexts) and as a
 * `{ type: 'decision', eventId, ...record }` JSONL line, since the event is already in the sink.
 */
import { createSink } from './sink.js';
import { fingerprint } from '../fingerprint.js';
import { statusOf } from '../decider/rules.js';

const FAKE_DSN = 'https://rekurs@rekurs.invalid/0'; // required for the SDK to build a transport; never dialled
const BODY_KEEP_BYTES = 4_096;

export async function createSentryGather(options = {}) {
  const {
    jsonlPath = null,
    maxEvents = 100,
    localVariables = false,
    captureTimeoutMs = 2_000,
    mode = 'auto', // 'auto' | 'init' | 'isolated'
    environment,
    release,
  } = options;

  const Sentry = options.sentry ?? await loadSentry();
  const sink = createSink({ maxEvents, jsonlPath });

  const transport = () => ({
    send(envelope) {
      try {
        for (const [header, payload] of envelope?.[1] ?? []) {
          if (header?.type === 'event' && payload && typeof payload === 'object') sink.addEvent(payload);
        }
      } catch { /* the sink never breaks the SDK */ }
      return Promise.resolve({ statusCode: 200 });
    },
    flush: () => sink.flush().then(() => true),
  });

  const base = {
    dsn: FAKE_DSN,
    transport,
    sendDefaultPii: false,
    sendClientReports: false,
    environment,
    release,
  };
  const eventIntegrations = () => [
    Sentry.linkedErrorsIntegration(),
    Sentry.contextLinesIntegration(),
    Sentry.nodeContextIntegration(),
    ...(localVariables ? [Sentry.localVariablesIntegration()] : []),
  ];

  const host = Sentry.getClient();
  const isolated = mode === 'isolated' || (mode === 'auto' && host);
  let client;
  if (isolated) {
    client = new Sentry.NodeClient({
      ...base,
      integrations: eventIntegrations(),
      stackParser: Sentry.defaultStackParser,
      includeLocalVariables: localVariables,
    });
    client.init();
  } else {
    Sentry.init({
      ...base,
      defaultIntegrations: false,
      includeLocalVariables: localVariables,
      integrations: [
        Sentry.httpIntegration({ spans: false }),
        Sentry.nativeNodeFetchIntegration({ spans: false }),
        Sentry.consoleIntegration(),
        ...eventIntegrations(),
      ],
    });
    client = Sentry.getClient();
  }

  const byCtx = new WeakMap();     // rekurs ctx → invocation state
  const byScope = new WeakMap();   // isolation scope created by wrap() → invocation state
  const wrapScopes = new WeakSet();

  function currentWrapScope() {
    try {
      const iso = Sentry.getIsolationScope();
      return wrapScopes.has(iso) ? iso : null;
    } catch { return null; }
  }

  function scopeBreadcrumbs() {
    try {
      return [
        ...(Sentry.getIsolationScope().getScopeData().breadcrumbs ?? []),
        ...(Sentry.getCurrentScope().getScopeData().breadcrumbs ?? []),
      ];
    } catch { return []; }
  }

  function syncBreadcrumbs(state) {
    const known = new Set(state.breadcrumbs.map(crumbKey));
    for (const b of scopeBreadcrumbs()) {
      if ((b.timestamp ?? 0) < state.since) continue;
      const k = crumbKey(b);
      if (!known.has(k)) { known.add(k); state.breadcrumbs.push(b); }
    }
    state.breadcrumbs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  async function firstFailure(err, site, ctx) {
    const scope = Sentry.getCurrentScope().clone();
    scope.setClient(client);
    scope.setTag('rekurs.dependency', site?.dependency ?? 'default');
    scope.setTag('rekurs.idempotent', String(!!site?.idempotent));
    scope.setTag('rekurs.side_effects', String(!!site?.sideEffects));
    scope.setTag('rekurs.fingerprint', fingerprint(err, site));
    scope.setContext('rekurs', {
      description: site?.description ?? '',
      dependency: site?.dependency ?? 'default',
      idempotent: !!site?.idempotent,
      sideEffects: !!site?.sideEffects,
      deadlineMs: Number.isFinite(site?.deadlineMs) ? site.deadlineMs : null,
      criticality: site?.criticality ?? null,
    });
    const code = err?.code ?? null;
    const status = statusOf(err);
    if (code != null || status != null) scope.setContext('error', { code, status });

    const eventId = client.captureException(err, { mechanism: { type: 'rekurs', handled: true } }, scope);
    const event = await sink.waitFor(eventId, captureTimeoutMs);
    return {
      eventId,
      event,
      breadcrumbs: [...(event?.breadcrumbs ?? [])],
      since: nowSeconds(),
      decisions: [],
      tags: {},
    };
  }

  async function gather(err, site, ctx) {
    try {
      let state = ctx && byCtx.get(ctx);
      const attempt = (ctx?.attempts?.length ?? 0) + 1;
      if (!state) {
        state = await firstFailure(err, site, ctx);
        if (ctx) byCtx.set(ctx, state);
        const iso = currentWrapScope();
        if (iso) byScope.set(iso, state);
      } else {
        const prev = ctx.attempts.at(-1);
        const crumb = {
          type: 'default',
          category: 'rekurs.attempt',
          level: 'warning',
          message: `attempt ${attempt} failed after ${prev?.action ?? '?'} (${prev?.rule ?? '?'}): ${summaryLine(err)}`,
          data: { attempt, action: prev?.action ?? null, rule: prev?.rule ?? null, error: errorSummary(err) },
          timestamp: nowSeconds(),
        };
        syncBreadcrumbs(state);
        state.breadcrumbs.push(crumb);
        try { Sentry.addBreadcrumb(crumb); } catch { /* scope is best effort */ }
        sink.addBreadcrumb(state.eventId, crumb);
      }
      return {
        eventId: state.eventId,
        event: state.event,
        breadcrumbs: [...state.breadcrumbs],
        attempts: [
          ...(ctx?.attempts ?? []).map((a, i) => ({ attempt: i + 1, action: a.action, rule: a.rule, at: a.at, error: errorSummary(a.error) })),
          { attempt, action: null, rule: null, at: Date.now(), error: errorSummary(err) },
        ],
        error: { ...errorSummary(err), body: upstreamBody(err) },
      };
    } catch {
      return null; // gathering never throws into the recovery path
    }
  }

  function resolveState(record, ctx) {
    if (ctx && byCtx.has(ctx)) return byCtx.get(ctx);
    const iso = currentWrapScope();
    return iso ? byScope.get(iso) ?? null : null;
  }

  /** onDecision hook: write the decision back onto the invocation's event. */
  function annotate(record, ctx) {
    try {
      const state = resolveState(record, ctx);
      const eventId = state?.eventId ?? record?.eventId ?? null;
      if (state) {
        state.decisions.push(record);
        const tags = {
          'rekurs.action': record.action,
          'rekurs.rule': record.rule ?? '',
          'rekurs.attempts': String(state.decisions.length),
        };
        for (const [k, v] of Object.entries(record.axes ?? {})) tags[`rekurs.axis.${k}`] = String(v);
        Object.assign(state.tags, tags);
        if (state.event) {
          state.event.tags = { ...(state.event.tags ?? {}), ...tags };
          state.event.contexts = { ...(state.event.contexts ?? {}), rekurs_decisions: { decisions: [...state.decisions] } };
        }
      }
      sink.addDecision(eventId, record);
    } catch { /* audit never breaks recovery */ }
  }

  /** Record how an invocation ended (wrap() does this for you). */
  function outcome(ctxOrEventId, result) {
    try {
      const state = typeof ctxOrEventId === 'string' ? sink.get(ctxOrEventId) : byCtx.get(ctxOrEventId);
      if (!state?.eventId) return;
      const ev = state.event ?? sink.get(state.eventId)?.event;
      if (ev) ev.tags = { ...(ev.tags ?? {}), 'rekurs.outcome': result.status };
      sink.setOutcome(state.eventId, result);
    } catch { /* ignore */ }
  }

  /** Run every invocation of a rekurs function in its own isolation scope; records outcome. */
  function wrap(rekursFn) {
    return (fn, declarations) => Sentry.withIsolationScope(async (iso) => {
      wrapScopes.add(iso);
      const settle = (result) => {
        const state = byScope.get(iso);
        if (state) outcome(state.eventId, result);
      };
      try {
        const env = await rekursFn(fn, declarations);
        const status = env.attempts.length === 0 ? 'ok' : env.action === 'none' ? 'recovered' : 'handled';
        settle({ status, action: env.action, degraded: !!env.degraded, attempts: env.attempts.length });
        return env;
      } catch (e) {
        settle({ status: 'failed', action: e?.action ?? null, attempts: e?.trail?.length ?? null, error: errorSummary(e?.cause ?? e) });
        throw e;
      }
    });
  }

  return {
    gather,
    annotate,
    outcome,
    wrap,
    sink,
    client,
    mode: isolated ? 'isolated' : 'init',
    async flush(timeoutMs = 2_000) {
      try { await client.flush(timeoutMs); } catch { /* ignore */ }
      await sink.flush();
      return true;
    },
    async close(timeoutMs = 2_000) {
      try { await client.close(timeoutMs); } catch { /* ignore */ }
      await sink.flush();
      return true;
    },
  };
}

async function loadSentry() {
  try {
    return await import('@sentry/node');
  } catch (e) {
    const err = new Error('rekurs: createSentryGather needs the optional dependency @sentry/node (npm i @sentry/node)');
    err.cause = e;
    err.code = 'REKURS_SENTRY_MISSING';
    throw err;
  }
}

const nowSeconds = () => Date.now() / 1000;
const crumbKey = (b) => `${b.timestamp}|${b.category}|${b.message}|${JSON.stringify(b.data ?? null)}`;

export function errorSummary(err) {
  return { name: err?.name ?? null, message: err?.message ?? String(err), code: err?.code ?? null, status: statusOf(err) };
}

function summaryLine(err) {
  const e = errorSummary(err);
  return [e.name, e.code, e.status, e.message].filter((x) => x != null && x !== '').join(' ');
}

/** The upstream response body, if the error carries one (kept raw; the renderer caps + labels it). */
export function upstreamBody(err) {
  const raw = err?.response?.body ?? err?.response?.data ?? err?.body ?? err?.responseText ?? null;
  if (raw == null) return null;
  let s;
  if (typeof raw === 'string') s = raw;
  else if (raw instanceof Uint8Array) s = Buffer.from(raw).toString('utf8');
  else { try { s = JSON.stringify(raw); } catch { return null; } }
  return Buffer.byteLength(s) > BODY_KEEP_BYTES ? Buffer.from(s).subarray(0, BODY_KEEP_BYTES).toString('utf8') : s;
}
