---
kanbento_id: d17680ac-98d4-46ac-bbd6-784b03ea5cff
title: Jev calibration check on RCAEval RE2
---

Plan written by phase 3 agent: scripts/rcaeval-calibration.md (state-text recipe, fault→axis label table, ECE/reliability/Brier + selective accuracy vs rules baseline, usability thresholds). Running it needs Jev API access and the RE2 download; blocked until a client exists. Adapter contract is in src/decider/jev.js.

One-shot eval against real Jev (jev-1.13.0) on 2026-09-30, scripts/jev-eval.js over the 8 demo scenarios, state rendered from the error only (no Sentry breadcrumbs). Default labels: 6/8 actions correct; 503 and 502 came back persistence=unknown (0.66) because the 'unknown' label ('not enough information to tell') is literally true of a 3-line state and Jev reads literally. Labels with concrete examples (--labels=examples): 8/8 actions correct, transient conf 0.93-1.00 on every transient case, 401 persistent 0.99, 429 overload 0.94, timeout POST outcome=may_have_happened 0.67 vs timeout GET did_not_happen 0.86 (it reads the sideEffects/POST line). Latency p50 ~70ms, ~780 input tokens per call. Recommendation: adopt the example-bearing labels as DEFAULT_LABELS; RCAEval calibration still open.
