# rekurs

Failure as a decision point: perceive the fault, let policy pick the recourse.
rekurs does not recurse — every retry charges a deadline and a per-dependency budget.

## Perception vs policy

A decider only perceives: it places the failure on five fault axes and never sees the action
menu. A deterministic policy turns those axes, the call site's static declarations and shared
dependency state into one action, and names the rule that matched. Hard gates (breaker,
retry budget, side effects with an unknown outcome) never depend on a probability.

## Quickstart: the demo

```sh
npm install
npm run demo                       # node demo/index.js
```

The demo starts an in-process fault server (`demo/fault-server.js`), wraps two call sites
(`GET /work`, idempotent; `POST /charge`, side-effecting) with no per-error code, and injects
one fault per scenario: timeout, 503, 429, 401, a malformed 200, a reset socket, a flapping
upstream, and a 500-call storm against a stalled decider. It prints one row per scenario
(action, matched rule, attempts, decider, degraded) and exits 1 if any row deviates from the
expectations in `demo/scenarios.js`. Sentry events go to `.rekurs/demo.jsonl`.

Switch the perception provider with `--decider=mock-jev` (default: the Jev decider with a
keyword-based mock client), `--decider=rules` (the lookup table) or `--decider=fixture`
(replay recorded decisions). `--no-sentry` skips context gathering.
`npm run demo:toxiproxy` runs the same call sites through real network faults (latency,
blackhole, reset_peer, slicer, limit_data) if a Toxiproxy server is reachable at
`TOXIPROXY_URL` (default `http://localhost:8474`); otherwise it prints install hints.

## Fixtures and the CI eval

`test/eval.test.js` replays `test/fixtures/decisions.jsonl` through the default policy and
asserts each scenario's first decision (`expected: { action, rule }` in `demo/scenarios.js`).
A change to labels, thresholds or preference tables that flips a decision fails CI.
After an intentional change, regenerate the fixtures and review the diff:

```sh
npm run demo:record                # rewrites test/fixtures/decisions.jsonl deterministically
```

## The wrapper

`rekurs(fn, declarations)` runs `fn`. On failure it gathers context, asks a decider to
classify the fault on five axes (persistence, locus, outcome, overload, scope), and lets a
deterministic policy pick one action from the menu the call site declares. It returns an
envelope `{ value, action, attempts, degraded }` or throws a `RekursError` carrying the trail.

Declarations are static facts about the call site: `idempotent`, `sideEffects`, `deadlineMs`,
`dependency`, `default`, and `actions`, the closed menu (`retry`, `degrade`, `reconcile`, ...).
`createRekurs({ decider, policy, registry, gather, onDecision })` builds a configured instance.

## Gathering context (Sentry SDK, offline)

`gather(err, site, ctx)` is an async hook that runs on every failure. Its result is stored
on `ctx.context`. `onDecision(record, ctx)` receives each decision as an audit record.
`createSentryGather` fills both hooks using the Sentry Node SDK (`@sentry/node`, an optional
dependency). It uses a custom transport that never touches the network: events go to a bounded
in-memory sink and, optionally, to a JSONL file that later phases replay as fixtures. rekurs
captures one event per failing invocation. Later attempts become breadcrumbs, and decisions and
the final outcome are joined onto the event as tags and appended as JSONL lines. If the host
app already runs Sentry, rekurs leaves its client alone and captures through its own isolated
client.

```js
import { createRekurs, createSentryGather, renderState, retry } from 'rekurs';

const sentry = await createSentryGather({ jsonlPath: '.rekurs/events.jsonl' });
const rekurs = sentry.wrap(createRekurs({ gather: sentry.gather, onDecision: sentry.annotate }));

const { value } = await rekurs(
  (signal) => fetch('https://api.example.com/things', { signal }).then((r) => r.json()),
  {
    describe: 'list things',
    dependency: 'example-api',
    idempotent: true,
    deadlineMs: 2_000,
    actions: { retry: retry({ max: 3 }), degrade: () => [] },
  },
);

// In a custom decider: a ~2 KB state text, no SDK needed (works with a null context too).
const text = renderState(ctx.context, ctx.site, ctx);
await sentry.close();
```

`wrap` runs each invocation in its own Sentry isolation scope, so concurrent calls never share
breadcrumbs. `renderState` renders the failure in a fixed order: exception, HTTP-first
breadcrumbs, attempts, operation, runtime. Any upstream body comes last, capped at 512 bytes
and labelled untrusted.

Requires Node >= 20. Tests: `npm test`.
