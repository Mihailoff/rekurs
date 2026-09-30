# rekurs

Failure as a decision point: perceive the fault, let policy pick the recourse.
rekurs does not recurse — every retry charges a deadline and a per-dependency budget.

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
