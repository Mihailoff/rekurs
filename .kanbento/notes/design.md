---
kanbento_id: 8257799b-a264-4040-a65e-c8a36542f4f6
title: rekurs design — Jev as resilience perception layer
revised: 2026-09-30
---
# rekurs — design

Status: prototype built 2026-09-30 — phases 1–5 of §13 are on main (116 tests, demo green:
`npm test`, `node demo/index.js`). Open: live Toxiproxy run, Jev calibration (needs API access),
residual measurement (needs real traffic), control plane, feedback loop, chaos selection.
Named rekurs on 2026-09-30 (was Exceptionist); see "Naming" below.

## 1. Thesis

Today an exception is a terminal event: catch, log, move on. rekurs turns failure into a
decision point. A wrapped operation declares a few static facts about itself and a closed menu
of recovery actions. When it fails, the failure context is gathered, classified, and a policy
picks the action. The classifier is Jev (TypeSafe AI's non-generative decision model). The
policy is code. Around both sits a feedback loop so handling improves because failures happened.

Three generations: **fragile** = catch & log (every failure a pure loss) · **robust** = static
retry/breaker policies (withstand anticipated shocks, unchanged by them) · **antifragile** =
handling that gets better from incidents. The recovery layer is robust; the loop is what makes
the system antifragile.

Thesis citation: Yuan et al., OSDI 2014 — 92% of catastrophic failures in 198 studied were bad
handling of non-fatal errors, often an empty or over-broad catch.

## 2. Why not static cases

- **Actions** are small, finite, and must be code: retry, back off, hedge, open circuit,
  degrade, shed, restart, compensate, escalate, abort. A static menu is not a limitation.
- **Mapping observation → action** is where static breaks: the observation space is open (new
  dependencies, error strings, compound situations); the right action is situational (the same
  503 wants retry at low load and shed at high load); gray failures never enter a catch block.

So: static actions, static per-site declarations, dynamic perception, deterministic policy.

## 3. Architecture: perception vs policy

```
failure ──► gather (Sentry SDK, offline) ──► render state text
        ──► Jev: classify on axes (Choice / Score / Noul, one request)
        ──► policy (deterministic): axes × site declarations × global state ──► action
        ──► execute (ordered, budgeted) ──► outcome envelope + annotated event
        ──► feedback loop: fixtures → eval → tuning / chaos selection
```

Jev does **perception**: what happened, on orthogonal axes. It does not choose the strategy.
Policy is deterministic code shared across call sites: testable, auditable, emits which rule
matched. Dangerous decisions never depend on a probability. Barbell: deterministic gates on one
end, probabilistic middle band on the other, nothing probabilistic near side effects.

### Fault axes (Jev's answer space)

| Axis | Question | Changes |
|---|---|---|
| Persistence | Will the same call succeed soon? | retry vs fail fast |
| Locus | My input, the dependency, the network, my environment? | fix request / wait / reroute / shed |
| Outcome knowledge | Did the operation definitely not happen? | retry vs reconcile |
| Overload | Is the failure caused by load? | back off + shed, never retry |
| Scope | This call, this dependency, everything? | local remedy vs circuit open / failover |

Sources: Gray (Heisenbug/Bohrbug, 1985); Avizienis & Laprie dependability taxonomy (2004);
Cristian's failure-model hierarchy (crash ⊂ omission ⊂ timing ⊂ arbitrary); gray failure (Huang
2017), fail-slow (Gunawi 2018); metastable failure (Bronson 2021); gRPC status codes as a
practical retryability vocabulary.

### Static declarations (per call site, never asked from text)

`idempotent` (retry safety is a code property, never derived from Jev) · `sideEffects`
(unknown-outcome failures need reconcile) · `deadline` (thin budget ⇒ skip Jev) ·
`criticality` · `default` (when Jev is unavailable, low-confidence, or skipped) · `dependency`
(key for shared state) · `actions` (the closed menu).

Placement rule: wrap dependency boundaries, not every call site. Systems are antifragile
because parts are allowed to fail.

### Global state (per dependency)

Breaker status, retry budget (gRPC/Envoy-style), recent decision distribution. Without a
dependency-level view the layer *builds* the retry storm metastable failure describes.

### Policy sketch

Hard gates first (breaker open, retry budget exhausted, side effects + outcome not
"did_not_happen" ⇒ reconcile/abort), then overload (shed, trip breaker if scope > this call),
then locus = my_input ⇒ abort, then transient + safe ⇒ retry charging the budget, then
persistent at dependency scope ⇒ trip breaker, else degrade/default. Low confidence falls
through to default. Preference lists per action come from config (see §7); guards stay code.

## 4. Jev usage

- One request per failure: Choice/Score per axis + declared Nouls, evaluated in parallel.
- Use the probability vector, not just the winner; confidence below threshold ⇒ default.
- Nouls answerable from text only ("transient", "auth failure", "body is an error payload").
  Static guards filter the menu before Jev; Jev never overrides them.
- Labels describe the *situation*, not the handler's mechanics.
- Decider behind an interface (provider): rule engine, recorded fixture, or another model can
  stand in. Needed for tests; avoids single-vendor core.
- Flat axis questions first; nest only if evals show sibling confusion.

## 5. Context gathering: Sentry SDK, offline

Keep the gatherer, swap the transport.

- Custom `transport` → in-memory sink + local JSONL (fixtures for free). `beforeSend`
  interceptor as fallback.
- Integrations: HTTP + console breadcrumbs (the failed call's URL/status is the best transient
  signal), exception with mechanism, contexts, context lines; local-variables opt-in.
- Fingerprint as cache key only when extended with status/error code — default collides
  across statuses thrown from one line.
- Capture once per failure; retries become breadcrumbs.
- PII scrubbing stays on: data leaves the process for Jev.
- Write the decision back as tags (action, probabilities, Nouls, outcome, matched rule) ⇒
  labeled dataset; annotated events if a real DSN is added later (multiplexed transport).
- Coexist with a host app already running Sentry (reuse client, add transport); never leak
  breadcrumbs across requests (isolation scope).

State text: fixed order, ~2 KB — exception → last breadcrumbs (HTTP first) → attempt history →
operation description → contexts. Upstream body last, capped, labeled untrusted
(attacker-controlled text can steer a classifier). Full data stays in JSONL.

## 6. Execution semantics

- Ordered by policy, each action budgeted, deadline-aware.
- Return an **outcome envelope**: value, producing action, attempt trail, matched rule.
- Trigger widens beyond exceptions: latency and result validity, so gray failures enter.
- "Fallback" is suspect as a default (rarely exercised paths fail when needed — AWS builders'
  library). Prefer explicit, tested, exercised degrade.

## 7. Control plane (lessons from feature flags)

Policy ≈ flag evaluation `rules(context) → variation` with a mandatory default, where part of
the context is machine-perceived. Borrow: kill switches (retries off / force action per
dependency, no deploy); local evaluation with streamed config and default on failure;
structured evaluation reasons; percentage rollouts with sticky bucketing (shadow mode as a
ramp); experimentation/bandits between candidate policies; lifecycle tooling (per-action fire
counts, never-fired handlers flagged); segments as dependency profiles; OpenFeature discipline
(provider interface, hooks, every evaluation takes a default).

Do not borrow: fully dynamic rules on the error path (hard gates stay code; only the preference
table is config, schema-validated); untested config (versioned, reviewed, replayed against
fixtures in CI); sprawl (generic action library + profiles).

Layering: local evaluation SDK · rules + kill-switch control plane · perception provider.

## 8. Self-resilience (test first)

The layer fails exactly when needed unless: per-fingerprint decision cache with TTL, rate
limit on Jev calls, breaker on Jev itself, sampling under load, bounded sink, fail-closed to
`default`, deadline-aware skip.

## 9. Feedback loop (first-class component)

- **Observability**: decision distribution is a metric with alerts — recovery must not hide
  outages; suppressing small failures stores up the big one. Log the rendered state text next
  to every decision. Some failures must stay loud.
- **Shadow mode**: Jev/new policy decides, program runs old behavior, log disagreements. A
  regression suite, not a training signal (only the taken path is observed).
- **CI eval**: replay JSONL fixtures, assert the chosen action, so descriptions and config
  don't rot. Drift detection, not only tuning — the policy must not overfit the last outage.
- **Bandits**: randomize between candidate policies on a slice to observe the path not taken.
- **Chaos, eval-driven**: chaos engineering is hypothesis-driven, not random (Netflix
  principles; lineage-driven fault injection prunes the fault space). Chaos injects a known
  fault → rekurs perceives + acts → injected fault = label. Select the next experiment
  where the policy has least evidence (never-fired handlers, lowest-confidence fingerprints,
  profiles without fixtures): active learning for the policy. Controlled experiments allow two
  policies vs the same fault. Scheduled exercise of degrade handlers in prod (hormesis).
- **Roles in chaos, same split as §3**: Jev perceives only — steady-state judgment (Noul over
  telemetry text; catches gray failures thresholds miss; a statistical detector is the honest
  tool for metrics) and outcome triage into the fault axes. Decisions are not classifier work:
  generating candidate experiments is open-ended reasoning (LLM or human); picking among them
  by least evidence is arithmetic (code); abort is a hard threshold in code with human/LLM in
  the loop beyond it. Blast radius, prod vs staging, caps: code only.
- Jev does not learn; all learning lives in policy config, thresholds, labels, cache, profiles.

Measurable pitch: policy accuracy on the fixture set rises after every incident.

## 10. Evaluation sources

No public dataset pairs runtime error context with the recovery that worked.

- **Thesis + taxonomy** (narrative): Yuan et al. OSDI 2014; Gunawi Cloud Outage Study (597
  outages) + Cloud Bug Study (3,655 tagged JIRA tickets, pullable text); fail-slow (101
  reports); the VOID (~10k reports, ~600 companies); danluu/post-mortems;
  kubernetes-failure-stories.
- **Perception** (text + label): RCAEval (735 cases, 11 injected fault types, logs/traces —
  use RE2 for Jev calibration); Loghub (labeled HDFS, OpenStack with injected failures);
  TrainTicket, DeathStarBench as fault catalogs / systems under test.
- **Policy end-to-end** (generate): Toxiproxy toxics between demo and dependency, injected
  toxic = label — first eval harness; Chaos Mesh / LitmusChaos / AWS FIS; own JSONL.

Sequence: Yuan + VOID sample → check axes; RCAEval RE2 → Jev calibration; Toxiproxy demo →
policy eval (also a proxy for "measure the residual" until real traffic exists).

## 11. Naming

**rekurs.** From Latin *recurrere*, "to run back" — the root shared by recourse (the remedy you
turn to) and recursive (running back into yourself). In German/Austrian legal usage *Rekurs* is
an appeal against a decision; Norwegian, Swedish, and Polish carry the recourse sense. An appeal
against a failure. The k keeps it searchable (recourse would fight a common noun) and free on
npm (`rekurs`, `rekurse` both unclaimed as of 2026-09-30 — reserve).

English readers will hear "recurse"; for a library whose central hazard is retry calling retry,
own the joke: rekurs does not recurse. Wrapper is `rekurs(fn, declarations)` — no `use` prefix,
this is not a React hook.

Rejected: Exceptionist (names the catch, not gray failures or the control plane); smartfail
(names failure not value, "smart" reads as AI-washing, "SmartFail is down" headline).

## 12. Open questions

1. Size of the residual a lookup table gets wrong — measure before over-building perception.
   If small, the deterministic tier is the product (via negativa).
2. Jev calibration on stack/breadcrumb/log text is unproven — RCAEval RE2 first.
3. Jev client shape / access — prototype stubs the decider behind the provider interface.

## 13. Prototype scope

TypeScript library `rekurs`: `rekurs(fn, declarations)` wrapper; Sentry offline transport + renderer; decider
interface with stub + Jev impl; deterministic policy over the five axes with config-driven
preference tables; ordered, budgeted execution with outcome envelope; shadow mode + JSONL;
CI eval over fixtures; Toxiproxy demo of a flaky HTTP dependency (timeout / 503 / 401 /
malformed 200 handled with no per-error code) plus a load-storm test.
