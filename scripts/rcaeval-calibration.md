# Jev calibration on RCAEval RE2: plan

Status: plan only. Nothing is downloaded or run yet. Source: github.com/phamquiluan/RCAEval.
Design refs: `.kanbento/notes/design.md` §4 (Jev usage), §10 (evaluation sources), §12 open question 2.

**Question.** When Jev reads telemetry text shaped like rekurs state text, are its axis
answers right, and are its probabilities honest? The policy gates on `conf >= 0.5` and
`overload.p >= 0.6`, so it depends on calibration as much as on accuracy.

**Input: state text per case.** RE2 has multi-source cases (metrics, logs, traces) from Online
Boutique, Sock Shop and Train Ticket. Check the file names against the repo README before
starting; expect per-case metrics, logs and traces CSVs plus an inject-time marker. For each
case, render one state (about 2 KB, same order as §5):
1. Error/warning log lines from the caller of the root-cause service, in a window after
   injection. This is the "exception" slot.
2. Failed or slow spans that touch the faulty service: status code, latency, peer. These fill
   the "breadcrumbs" slot.
3. A short metrics summary for the faulty service (CPU, memory, p99 latency, error rate, each
   against a pre-injection baseline) as `name: before → after` lines.
4. An operation line naming the calling endpoint.

Build a second, log-only variant of each case. It is closer to what rekurs sees at a catch
site and shows how much the metrics are doing. The service name must never appear next to
fault vocabulary. Remove the injection marker and file names, since they would leak the label.

**Labels: fault type → axis values.** Only the axes the fault actually determines are scored.
Everything else is left unlabeled.

| RE2 fault | persistence | locus | overload | scope |
|---|---|---|---|---|
| CPU hog | transient | dependency | high | this_dependency |
| MEM leak | persistent | dependency | high | this_dependency |
| DISK stress | transient | environment | high | this_dependency |
| SOCKET exhaustion | transient | environment | high | this_dependency |
| DELAY (network latency) | transient | network | low | this_dependency |
| LOSS (packet loss) | transient | network | low | this_call |

`outcome` cannot be labeled from RCAEval (no ground truth on side effects), so it is excluded.
`my_input` has no RE2 analogue. A small set of RE3 code-level faults (for example a wrong
parameter) can give a `locus = my_input` / `persistence = persistent` spot check. The
persistence and scope labels in the table are judgment calls, so have a second person review
the mapping before any runs.

**Metrics** (per axis, per text variant, per system):
- Accuracy and macro-F1 of `pick` against the label, with a confusion matrix. Sibling confusion
  (network vs dependency) is what would justify nested questions (§4).
- Calibration: 10-bin ECE on `conf` for choice axes and on `p` for the overload Noul, plus a
  reliability diagram and the Brier score.
- Selective accuracy at the policy thresholds: accuracy when `conf >= 0.5`, and precision and
  recall of `overload.p >= 0.6`, along with coverage (the share of cases that clear the gate).
- Baseline: the same metrics for the rules decider on the same text, using a regex extraction
  of status and error code. Jev only earns its place by doing better than that baseline.

**What "usable" means.**
- For overload and persistence, accuracy when `conf >= 0.5` is at least 0.8, with coverage of
  at least 0.5.
- ECE is at most 0.1 on each scored axis. Above that, the confidence gate means nothing without
  a recalibration layer (temperature or isotonic, fit on a split held out from the eval).
- Overload precision at 0.6 is at least 0.85. A false overload trips breakers, so precision
  matters more here than recall.
- Beats the rules baseline on at least one axis without being worse on the others.

If Jev is accurate but miscalibrated, add recalibration and keep going. If it is inaccurate on
the log-only variant, rekurs needs richer gathering before perception can pay off. If it is
inaccurate everywhere, §12 Q1 applies: the deterministic tier becomes the product.
