# GI Agent Integration Plan

## Goal

Unify the useful parts of:

- `@gi-tcg/agent`
- `@gi-tcg/tactic-search`
- `@gi-tcg/eval-char-comb`

into one practical iteration loop for Genius Invokation AI development.

The target is not a "multi-agent system" in the abstract. The target is:

1. a stable runtime policy that can choose actions,
2. a reliable offline benchmark that can tell whether a change is better,
3. an offline learning and analysis pipeline that can produce the next policy.

---

## Core Diagnosis

The current work failed to converge mainly because the repository has built pieces of three different systems, but none of them forms a full end-to-end improvement loop by itself:

- `gi-agent` has a runtime orchestration shell, but weak evaluation and incomplete training integration.
- `tactic-search` has a real simulator adapter and local search, but its value function is not trustworthy enough to be the final judge.
- `eval-char-comb` has useful static priors and profiling, but its handcrafted compatibility score is too far away from actual match win rate.

As a result, the codebase contains:

- multiple partial scoring systems,
- multiple partial search systems,
- no single benchmark gate for promotion,
- no single runtime policy stack that all experiments feed into.

The fix is to treat these packages as sources of reusable components, not as parallel products.

---

## Target Architecture

```text
packages/gi-agent/
├── runtime/
│   ├── policy/              # action selection at battle time
│   ├── search/              # optional bounded local search
│   └── adapters/            # state/action simulation adapters
│
├── evaluation/
│   ├── benchmark/           # fixed matchups and regression suites
│   └── reports/             # win rate / matchup / scenario reports
│
├── learning/
│   ├── features/            # state, action, deck-level features
│   ├── training/            # logistic or later models
│   └── analysis/            # failure mining, rule proposal inputs
│
└── knowledge/
    ├── character-profiles/  # imported static priors
    └── deck-priors/         # imported compatibility/card affinity priors
```

Operationally, the loop should become:

1. runtime policy plays games,
2. games are stored as samples,
3. benchmark compares old policy vs new policy,
4. only benchmark-approved changes move back into runtime.

---

## Package Triage

### Keep

These parts have clear long-term value and should survive.

#### From `@gi-tcg/agent`

- `src/learning/scoring/feature-extractor.ts`
- `src/learning/scoring/logistic-reg.ts`
- `src/db/data-lake.ts`
- `src/sandbox/runner.ts`

Reason:

- They are aligned with the desired long-term loop.
- They already point toward data-backed evaluation instead of prompt-only behavior.

#### From `@gi-tcg/tactic-search`

- `src/sim-adapter.ts`
- `src/bounded-searcher.ts`
- the idea of mutation-based delta extraction

Reason:

- This is the strongest existing bridge between engine state and local tactical exploration.
- It is reusable both for runtime lookahead and offline scenario testing.

#### From `@gi-tcg/eval-char-comb`

- `src/profiler/types.ts`
- `src/profiler/CharacterProfileExtractor.ts`
- card affinity and compatibility feature generation

Reason:

- These are useful as priors and features.
- They should inform search-space reduction, deck seeding, and feature engineering.

### Migrate

These parts are useful only after their role is narrowed.

#### `gi-agent` battle graph

Current role:

- LLM-centered runtime orchestrator

New role:

- optional developer tool for analysis or explanation
- not the main production runtime policy

Reason:

- runtime action selection in GI TCG is too constrained and repetitive to justify LLM-first control on every step.

#### `tactic-search` state evaluator

Current role:

- primary score source for local search

New role:

- reusable delta extractor
- temporary heuristic baseline only

Reason:

- its current composite score should not be treated as truth until validated against match outcomes.

#### `eval-char-comb` deck score

Current role:

- final deck ranking proxy

New role:

- candidate generation and prior features only

Reason:

- handcrafted compatibility scores are too brittle to serve as final deck selection criteria.

### Retire

These ideas should stop being first-class goals.

- "multi-agent" as a product objective
- LLM-generated runtime fragments as the default action-selection path
- handcrafted static compatibility score as the final deck-strength metric
- standalone combo-mining output as proof that a tactic is strong

Reason:

- all of them can still exist as tooling,
- none of them should be the authoritative decision layer.

---

## Why The Older Attempts Failed

## 1. `eval-char-comb` failed because it optimized plausible structure, not observed strength

The package is directionally smart. It captures:

- elemental interaction,
- cost conflict,
- burst cadence,
- role clarity,
- phase-dependent value.

But the final score is still a hand-built proxy. Even when the proxy is thoughtful, it can drift from real match win rate for several reasons:

- the weight direction can be wrong,
- character synergy and 30-card construction are only partially modeled together,
- matchup dependence is mostly absent,
- a deck that looks efficient in isolation can still be fragile in live play.

So this package should become a feature/prior generator, not a final deck judge.

## 2. `tactic-search` failed because local value estimation was not trustworthy enough

The package is closer to real play because it simulates legal actions and state transitions. That part is worth keeping.

But a search system is only as good as its evaluator. The current evaluator uses handcrafted nonlinear weights over local deltas such as:

- damage,
- reactions,
- kills,
- dice spent,
- energy gain,
- tempo cost.

That can be useful as a baseline, but not as a final truth source. Once the evaluator drifts from actual win probability, deeper search just amplifies the wrong preference signal.

So this package should become a tactical expansion module under a benchmarked policy stack, not a separate strategy discovery product.

## 3. `gi-agent` stalled because its runtime and learning loops were not connected tightly enough

The package has the right ambition, but the current implementation mixes:

- runtime LLM prompting,
- calibration scaffolding,
- data storage,
- sandbox ambitions,

without a single benchmark gate that determines whether a change is promotable.

This made iteration ambiguous:

- a cleaner prompt feels better, but may not increase win rate,
- a better feature extractor feels principled, but may not improve action ranking,
- a better local search may improve short-term score but hurt match outcomes.

Without a benchmark loop, these cannot be resolved objectively.

---

## Recommended Integration

## Layer 1: Runtime Policy

`gi-agent` should own the runtime policy stack.

Recommended runtime order:

1. enumerate legal candidates,
2. apply hard constraints,
3. apply lightweight heuristic or learned evaluator,
4. optionally run bounded local search on top candidates,
5. choose final action.

Important rule:

- LLM should not be the default first-order selector for every action.

Possible use of LLM at runtime:

- explanation,
- logging,
- debugging,
- rare fallback experimentation.

### What to import

- Move or copy `tactic-search/src/sim-adapter.ts` into `gi-agent/runtime/adapters`
- Move or copy `tactic-search/src/bounded-searcher.ts` into `gi-agent/runtime/search`
- Keep `gi-agent` feature extraction and logistic model in `gi-agent/learning`

---

## Layer 2: Offline Benchmark

This is the highest-priority missing piece.

`gi-agent` should own a benchmark harness built on top of the sandbox runner.

The benchmark should support:

- fixed deck matchups,
- fixed seeds,
- scenario suites for opening hand, lethal, defensive switch, burst timing,
- policy-vs-policy comparisons,
- regression reporting.

Promotion rule:

- no runtime policy change ships unless it improves or at least preserves benchmark results.

This is where the old packages should be judged:

- `eval-char-comb` outputs candidate deck sets
- `tactic-search` outputs tactical policy variants
- benchmark decides if any of them are worth keeping

---

## Layer 3: Offline Learning

`gi-agent` should own the learning loop.

Inputs:

- battle logs from runtime,
- sandbox self-play,
- benchmark replays,
- scenario replay datasets.

Outputs:

- action-level evaluator weights,
- deck-level prior features,
- tactical search priors,
- failure-type reports.

### Role of `eval-char-comb`

Use it to generate:

- deck-level feature vectors,
- character synergy priors,
- card affinity priors,
- initial candidate pool for deck search.

Do not use it to directly declare that a deck is strong.

### Role of `tactic-search`

Use it to generate:

- candidate tactical continuations,
- rollout samples,
- local state deltas for learning features.

Do not use it to directly declare that a combo is strong unless benchmark-backed.

---

## Concrete Migration Table

| Source package | Component | Action | Destination |
|---|---|---|---|
| `gi-agent` | `ml/feature-extractor.ts` | keep | `gi-agent/learning/features` |
| `gi-agent` | `ml/logistic-reg.ts` | keep | `gi-agent/learning/training` |
| `gi-agent` | `db/data-lake.ts` | keep | `gi-agent/learning/data` |
| `gi-agent` | `sandbox/runner.ts` | keep and expand | `gi-agent/evaluation/benchmark` |
| `gi-agent` | `graphs/battle-graph.ts` | downgrade to optional tooling | `gi-agent/analysis/llm-runtime-experiments` |
| `tactic-search` | `sim-adapter.ts` | migrate | `gi-agent/runtime/adapters` |
| `tactic-search` | `bounded-searcher.ts` | migrate | `gi-agent/runtime/search` |
| `tactic-search` | `state-evaluator.ts` | split and rewrite | `gi-agent/runtime/eval-baselines` |
| `eval-char-comb` | profiler types/extractor | migrate | `gi-agent/knowledge/character-profiles` |
| `eval-char-comb` | compatibility/deck scoring | reduce to priors | `gi-agent/learning/deck-priors` |

---

## Suggested Delivery Stages

## Stage 1: Build The Benchmark Gate

Deliverables:

- fixed benchmark definitions,
- policy-vs-policy runner,
- saved JSON reports,
- regression comparison script.

Success criterion:

- every policy change can be judged by the same test suite.

## Stage 2: Build A Non-LLM Runtime Baseline

Deliverables:

- simple deterministic policy,
- optional bounded search on top-N actions,
- no dependency on runtime fragment generation.

Success criterion:

- the agent can play stably and be benchmarked repeatedly.

## Stage 3: Connect Data Collection To Learning

Deliverables:

- action samples written from runtime and sandbox,
- training command for evaluator weights,
- evaluator loading in runtime.

Success criterion:

- one command can produce a new evaluator and benchmark it against the old one.

## Stage 4: Reintroduce Higher-Level Research Tooling

Deliverables:

- failure clustering,
- deck candidate generation using static priors,
- scenario mining for tactical search,
- optional LLM-assisted analysis reports.

Success criterion:

- research tooling proposes candidate improvements, but benchmark remains the final judge.

---

## Recommended Principle Set

Use these rules to avoid repeating the current failure mode:

1. Only one package owns the authoritative runtime policy: `gi-agent`.
2. Only one system decides if a change is better: the benchmark harness.
3. Static compatibility scores are priors, not verdicts.
4. Local tactical scores are rollout heuristics, not truth.
5. LLM output is advisory unless benchmark-proven.
6. Every new heuristic must either:
   - improve benchmark performance, or
   - be removed or demoted to analysis-only tooling.

---

## Bottom Line

The old work is not wasted.

- `eval-char-comb` contains reusable profiling and prior-generation machinery.
- `tactic-search` contains reusable simulation and tactical expansion machinery.
- `gi-agent` should become the single integration surface that absorbs both.

The key change is not more abstraction. The key change is to enforce one improvement loop:

runtime policy -> data -> benchmark -> learning -> next runtime policy

Anything that does not plug into that loop should no longer define the architecture.
