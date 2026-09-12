# V15 Agent/ML Code Review and Improvement Plan

> **⚠️ 状态：部分过时** — V15 代码评审。Task 1-6 大部分已在 V25 中实现（streaming ranker, per-deck ranker）。但包边界不安全等架构问题仍存在。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current `packages/gi-agent` and `packages/gi-ml` temporal-reasoning prototype into a verifiable, package-safe, data-backed decision subsystem.

**Architecture:** Stabilize contracts first: reward versioning, card temporal profiles, and package boundaries. Then replace heuristic temporal scoring with a measured `PortfolioEV(state_after) - PortfolioEV(state_before)` pipeline, backed by sentinel card tests and benchmark gates.

**Tech Stack:** Bun, TypeScript ESM, `@gi-tcg/core`, `@gi-tcg/data`, `@gi-tcg/gi-agent`, `@gi-tcg/gi-ml`, package-local `bun test`, package-local `bun run check`.

---

## 1. Scope

This report reviews the current state of:

- `packages/gi-agent/src/knowledge/temporal-profiles`
- `packages/gi-agent/src/runtime/policy`
- `packages/gi-agent/src/learning/rl`
- `packages/gi-ml/src/runtime`
- The package boundary between `@gi-tcg/agent` and `@gi-tcg/gi-ml`

It focuses on code architecture, temporal-reasoning correctness, training-data safety, and testability. It does not review UI packages, server packages, or card DSL correctness outside the subset needed to validate temporal profiles.

## 2. Verification Snapshot

Commands attempted during review:

```bash
cd packages/gi-ml
bun test src
```

Observed result: passed 42 tests.

```bash
cd packages/gi-agent
bun test src/knowledge/temporal-profiles/dsl-parser.test.ts
bun test src/learning/rl/export-dataset.test.ts
bun test src/learning/combat-windows/library-selector.test.ts src/learning/combat-windows/library-evaluator.test.ts src/learning/combat-windows/tree-validator.test.ts
```

Observed result: selected tests passed.

```bash
cd packages/gi-agent
bun test src/learning/rl/reward-config.test.ts
```

Observed result: failed. The implementation now uses `reward.v3` coefficients and terminal reward magnitude, while the tests still assert the older reward contract.

```bash
cd packages/gi-agent
bun run check
cd ../gi-ml
bun run check
```

Observed result: blocked because the workspace has no usable `node_modules/typescript/bin/tsc` entry.

Several `gi-agent` runtime and RL tests also hit `EACCES` while Bun attempted to read symlinked package dependencies such as `packages/core/node_modules/immer` and `packages/utils/node_modules/arktype`. That is an environment/package-installation blocker, but it currently prevents using the full test suite as a regression gate.

## 3. Executive Diagnosis

The latest changes moved the system in the right direction: there is now a recognizable temporal profile layer, a portfolio evaluator, RL reward configuration, and a `gi-ml` runtime bridge.

However, the system is not yet reliable enough to trust as a temporal-reasoning foundation:

1. The temporal card knowledge is produced by runtime source parsing, and the parser currently misreads numeric effects.
2. The reward contract changed without synchronized tests and dataset-version enforcement.
3. The portfolio evaluator is still mostly a heuristic wrapper around current-state features, not a real state-transition delta model.
4. `gi-ml` and `gi-agent` currently have an unsafe package boundary, including reverse dependency and deep imports.
5. The concept model's `window` scope is not actually modeling action windows.
6. Full verification is blocked by local dependency/test-runner issues.

The core recommendation is to stop adding more weights to the current path and first rebuild the semantic substrate: generated card profiles, stable reward manifests, clean package contracts, and measurable portfolio deltas.

## 4. High-Severity Findings

### F1: Reward Contract Drift

Affected files:

- `packages/gi-agent/src/learning/rl/reward-config.ts`
- `packages/gi-agent/src/learning/rl/reward-config.test.ts`
- `packages/gi-agent/src/learning/rl/export-dataset.ts`
- `packages/gi-agent/src/learning/rl/training-protocol.ts`

Current behavior:

- `DEFAULT_REWARD_CONFIG_V1.reward_version` is now `"reward.v3"`.
- Terminal win/loss reward has changed to `+2/-2`.
- Shaping coefficients changed, for example damage coefficient now yields `4 * 0.025 = 0.1`.
- Existing tests still expect old values such as terminal `+1` and damage reward `0.08`.

Why this matters:

Reward changes define a new training target. If old and new rollouts are mixed without a manifest gate, model evaluation becomes invalid. A ranking improvement may only reflect a reward-scale change rather than better play.

Required decision:

- If `reward.v3` is intentional, update tests, dataset manifests, artifact metadata, and benchmark names.
- If not intentional, revert coefficients to the tested reward contract.

Acceptance criteria:

- `bun test src/learning/rl/reward-config.test.ts` passes.
- Every exported RL dataset contains `reward_version`.
- Training refuses to load a dataset with a reward version different from the artifact target version.
- Benchmark output prints reward version next to model artifact version.

### F2: Runtime Source Parsing Can Silently Disable Temporal Profiles

Affected files:

- `packages/gi-agent/src/knowledge/temporal-profiles/profile-registry.ts`
- `packages/gi-agent/tsup.config.ts`

Current behavior:

- The registry reads source files such as `../../../../data/src/cards/support/ally.ts` at runtime.
- It resolves those paths relative to `import.meta.url`.
- It catches every error and continues.

Why this matters:

In source mode under Bun, this may work by accident. In bundled `dist/index.js`, `import.meta.url` points to `packages/gi-agent/dist/index.js`, so the relative path can resolve outside the intended package tree. If loading fails, the registry can become empty without a hard failure.

Required rewrite:

Runtime source parsing must be removed from the policy path. Temporal profiles should be generated at build time and imported as a stable artifact.

Acceptance criteria:

- Running the built package can load profiles without access to `packages/data/src`.
- Registry load failure is explicit: either throw in strict mode or emit a policy diagnostic with profile count `0`.
- A test imports the built registry entry point and asserts that sentinel profiles are present.

### F3: DSL Effect Parser Miscomputes Numeric Payoffs

Affected files:

- `packages/gi-agent/src/knowledge/temporal-profiles/dsl-parser.ts`
- `packages/gi-agent/src/knowledge/temporal-profiles/dsl-parser.test.ts`
- `packages/data/src/cards/support/*.ts`

Current behavior:

- The parser increments payoff counts by regex match count.
- It does not reliably use numeric arguments in calls like `.generateDice(DiceType.Omni, 2)`.
- Some generic patterns overlap with specific patterns, creating spurious payoff fields.

Observed examples:

- Paimon can be parsed as `generate_dice_omni: 1` when the source effect says `2`.
- Liben can get both `generate_dice_omni` and an accidental `generate_dice_elemental`.
- Liben's draw value passing as `2` is not strong evidence: it can pass because multiple regexes match the same source span.

Why this matters:

Temporal portfolio scores are only as good as their payoff vectors. A one-die error on recurring engines is large enough to change R1/R2 support-vs-skill decisions.

Required rewrite:

Replace count-by-regex extraction with one of these two approaches:

1. Preferred: builder-level serializable Effect IR emitted by `@gi-tcg/core/builder`.
2. Interim: AST parser over TypeScript source that extracts callee, arguments, enclosing trigger, and condition without overlapping regex matches.

Acceptance criteria:

- Exact sentinel tests for Paimon, Liben, Chang the Ninth, Katheryne, Timaeus, Wagner, Chef Mao, Tubby, Parametric Transformer.
- Each payoff assertion checks exact numeric values, not only `> 0`.
- Parser reports unknown effect forms with card id and source location.
- Source profiles include a confidence field: `exact`, `source_parsed`, `sim_inferred`, or `heuristic`.

### F4: Temporal Portfolio Is Not Yet a State-Transition Delta Model

Affected files:

- `packages/gi-agent/src/runtime/policy/temporal-portfolio.ts`
- `packages/gi-agent/src/runtime/policy/temporal-opportunity.ts`
- `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts`

Current behavior:

- `assessTemporalOpportunityForCandidate` appends the currently scored candidate into `digest.candidate_actions`.
- `buildOptionPortfolio` infers active/progressing/available options mostly from the current observation and candidates.
- `estimateCandidatePortfolioDelta` is still heuristic and does not evaluate `PortfolioEV(state_after_action) - PortfolioEV(state_before_action)`.
- `declareEnd` has no meaningful temporal risk/cashout implementation.
- Deferred support progress does not use observed entity variables.

Why this matters:

The model can explain why a card looks temporally valuable, but it cannot yet answer the actual policy question: "What option value changes if I take this action now?"

Required rewrite:

Split temporal reasoning into three components:

- `PortfolioSnapshot`: extracts active, progressing, ready, blocked, and available options from `ObservationV1`.
- `TransitionEstimator`: estimates candidate-induced changes to the snapshot.
- `OpportunityEvaluator`: converts before/after snapshots into a scored and logged delta.

Acceptance criteria:

- Current candidate is never duplicated while scoring.
- Liben-like variable progress can classify `progressing` versus `ready_to_cash`.
- `declareEnd` has tests for at least: safe early end, unsafe early end, forced end with no useful action, and end that cashes an engine.
- Candidate scoring logs before EV, after EV, delta EV, resource cost, slot pressure, and risk.

### F5: `gi-ml` and `gi-agent` Have an Unsafe Package Boundary

Affected files:

- `packages/gi-ml/src/runtime/bridge.ts`
- `packages/gi-ml/src/runtime/types.ts`
- `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts`

Current behavior:

- `gi-ml` imports `ObservationV1` from `@gi-tcg/agent`.
- `gi-agent` deep-imports implementation files from `gi-ml/src`.

Why this matters:

The ML runtime should be reusable and independently testable. A reverse dependency from `gi-ml` into `gi-agent` makes build order, package exports, and artifact runtime harder to reason about.

Required rewrite:

Move shared model-facing contracts into one stable boundary:

- Option A: `packages/gi-ml/src/runtime/types.ts` owns `ModelObservationV1`, `ModelCandidateV1`, and bridge input/output contracts.
- Option B: create a small `@gi-tcg/ai-contracts` package if multiple packages need the same contracts.

Acceptance criteria:

- `packages/gi-ml` has no import from `@gi-tcg/agent`.
- `packages/gi-agent` imports only public `@gi-tcg/gi-ml` exports, not `../../../../gi-ml/src/...`.
- `bun run build gi-ml gi-agent` succeeds after dependencies are installed.

### F6: `window` Scope Concept Model Is Not a Real Window Model

Affected files:

- `packages/gi-ml/src/runtime/concept-model.ts`
- `packages/gi-ml/src/runtime/concept-model.test.ts`
- `packages/gi-agent/src/learning/combat-windows/*`

Current behavior:

- `scope: "window"` filters out a few candidate tags and averages independent `state_action` concept probabilities.
- It does not model sequence order, resource constraints, pivot timing, opponent interruption, or multi-action payoff.

Why this matters:

Window reasoning is the core high-level structure missing from plain action ranking. Averaging per-action probabilities can dilute the one critical action that opens a kill line, or overvalue many individually plausible actions that do not compose.

Required rewrite:

Either rename this to an aggregate candidate concept, or rebuild it to consume explicit combat-window features.

Acceptance criteria:

- A synthetic test distinguishes "low immediate score but opens two-step lethal" from "high immediate score but breaks the line".
- Window output includes selected line id, horizon, required dice, required active character, expected payoff, and failure reason when no line exists.
- `gi-agent` can log the winning window explanation beside the selected action.

## 5. Target Architecture

The target decision stack should be:

```text
ObservationV1
  -> CandidateSemanticDigest
  -> PortfolioSnapshot(state_before)
  -> CandidateTransitionEstimate
  -> PortfolioSnapshot(state_after)
  -> PortfolioDelta
  -> ML feature vector
  -> Ranker / Value / Search fusion
  -> Action selection with explanation
```

Card knowledge should enter through generated artifacts:

```text
packages/data/src card DSL
  -> build-time profile generator
  -> generated temporal profile artifact
  -> runtime registry
  -> portfolio snapshot and transition estimator
```

RL data should enter through versioned manifests:

```text
self-play / replay
  -> observation + candidate export
  -> reward.vN computation
  -> dataset manifest with reward_version + schema_version
  -> trainer validates manifest
  -> model artifact records source manifest
```

## 6. Implementation Plan

### Task 1: Stabilize Reward Versioning

**Files:**

- Modify: `packages/gi-agent/src/learning/rl/reward-config.ts`
- Modify: `packages/gi-agent/src/learning/rl/reward-config.test.ts`
- Modify: `packages/gi-agent/src/learning/rl/export-dataset.ts`
- Modify: `packages/gi-agent/src/learning/rl/training-protocol.ts`

- [ ] **Step 1: Decide the canonical reward contract**

Use `reward.v3` if the new coefficients are intentional. Keep the current implementation values:

```ts
reward_version: "reward.v3"
terminal_win_reward: 2
terminal_loss_reward: -2
damage_coef: 0.025
```

- [ ] **Step 2: Update failing reward tests**

Change assertions in `reward-config.test.ts` so the tests describe the current contract exactly:

```ts
expect(breakdown.damage).toBeCloseTo(0.1)
expect(breakdown.terminal).toBe(2)
```

- [ ] **Step 3: Add reward manifest validation**

Dataset export must include:

```ts
{
  schema_version: "rl-dataset.v1",
  reward_version: DEFAULT_REWARD_CONFIG_V1.reward_version
}
```

Training protocol must reject mismatched versions before loading samples.

- [ ] **Step 4: Verify**

Run:

```bash
cd packages/gi-agent
bun test src/learning/rl/reward-config.test.ts src/learning/rl/export-dataset.test.ts src/learning/rl/training-protocol.test.ts
```

Expected: all tests pass and any reward mismatch test fails with a clear message containing both expected and actual reward versions.

### Task 2: Replace Runtime Source Profile Loading

**Files:**

- Create: `packages/gi-agent/src/knowledge/temporal-profiles/generated-profiles.ts`
- Create: `packages/gi-agent/src/knowledge/temporal-profiles/generate-profiles.ts`
- Modify: `packages/gi-agent/src/knowledge/temporal-profiles/profile-registry.ts`
- Modify: `packages/gi-agent/package.json`

- [ ] **Step 1: Add generated profile entry point**

The runtime registry should import static data:

```ts
import { GENERATED_TEMPORAL_PROFILES } from "./generated-profiles"
```

`profile-registry.ts` should never call `readFileSync` on `packages/data/src` during policy execution.

- [ ] **Step 2: Add a generator command**

Add a package script:

```json
{
  "scripts": {
    "generate:temporal-profiles": "bun src/knowledge/temporal-profiles/generate-profiles.ts"
  }
}
```

- [ ] **Step 3: Make empty profile registry visible**

If zero profiles are loaded, strict mode should throw:

```ts
throw new Error("Temporal profile registry is empty; run bun run generate:temporal-profiles")
```

Policy mode may degrade only if it records a diagnostic that profile count is zero.

- [ ] **Step 4: Verify built runtime behavior**

Run:

```bash
cd packages/gi-agent
bun run generate:temporal-profiles
bun test src/knowledge/temporal-profiles/dsl-parser.test.ts
```

Expected: generated profile count is nonzero and sentinel card ids exist.

### Task 3: Rewrite Profile Effect Extraction

**Files:**

- Modify: `packages/gi-agent/src/knowledge/temporal-profiles/dsl-parser.ts`
- Modify: `packages/gi-agent/src/knowledge/temporal-profiles/dsl-parser.test.ts`
- Optionally create: `packages/gi-agent/src/knowledge/temporal-profiles/source-ast.ts`

- [ ] **Step 1: Replace count-by-regex payoff extraction**

The parser must read numeric arguments from effect calls. For example:

```ts
generateDice(DiceType.Omni, 2) -> { generate_dice_omni: 2 }
drawCards(2) -> { draw: 2 }
```

It must not count the same source span twice.

- [ ] **Step 2: Add exact sentinel tests**

Use exact assertions:

```ts
expect(paimon.payoff.generate_dice_omni).toBe(2)
expect(liben.payoff.draw).toBe(2)
expect(liben.payoff.generate_dice_elemental ?? 0).toBe(0)
```

- [ ] **Step 3: Report unknown effects**

Unknown builder calls should be collected into profile diagnostics:

```ts
{
  definitionId: 322001,
  unknownEffects: ["someUnsupportedBuilderCall"],
  confidence: "source_parsed"
}
```

- [ ] **Step 4: Verify**

Run:

```bash
cd packages/gi-agent
bun test src/knowledge/temporal-profiles/dsl-parser.test.ts
```

Expected: exact payoff tests pass for at least nine sentinel support cards.

### Task 4: Rebuild Temporal Portfolio Around Snapshots and Transitions

**Files:**

- Create: `packages/gi-agent/src/runtime/policy/portfolio-snapshot.ts`
- Create: `packages/gi-agent/src/runtime/policy/portfolio-transition.ts`
- Modify: `packages/gi-agent/src/runtime/policy/temporal-portfolio.ts`
- Modify: `packages/gi-agent/src/runtime/policy/temporal-opportunity.ts`
- Modify: `packages/gi-agent/src/runtime/policy/temporal-opportunity.test.ts`

- [ ] **Step 1: Define snapshot responsibilities**

`PortfolioSnapshot` should include:

```ts
interface PortfolioSnapshot {
  active: TemporalOptionInstance[]
  progressing: TemporalOptionInstance[]
  readyToCash: TemporalOptionInstance[]
  available: TemporalOptionInstance[]
  blocked: TemporalOptionInstance[]
  slotPressure: number
  expectedFutureValue: number
}
```

- [ ] **Step 2: Use observation variables**

Entity variables must classify deferred options. For Liben-like supports:

```ts
collected >= 3 -> readyToCash
0 < collected && collected < 3 -> progressing
```

- [ ] **Step 3: Remove candidate duplication**

Do not append the scored candidate to `digest.candidate_actions`. If a fallback is needed, merge by stable key:

```ts
const key = candidate.candidate_id ?? `${candidate.action_case}:${candidate.sourceDefinitionId}`
```

- [ ] **Step 4: Implement declare-end evaluation**

Declare-end scoring must evaluate:

- engines that cash at end phase
- opponent tempo risk after ending early
- wasted dice and unspent active skill opportunities
- whether passing preserves a known next-round window

- [ ] **Step 5: Verify**

Run:

```bash
cd packages/gi-agent
bun test src/runtime/policy/temporal-opportunity.test.ts
```

Expected: tests cover support play, support cashout, saturated support slots, duplicate candidate prevention, and declare-end risk.

### Task 5: Fix `gi-ml` / `gi-agent` Package Boundary

**Files:**

- Modify: `packages/gi-ml/src/runtime/types.ts`
- Modify: `packages/gi-ml/src/runtime/bridge.ts`
- Modify: `packages/gi-ml/src/runtime/index.ts`
- Modify: `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts`
- Modify: `packages/gi-ml/package.json`

- [ ] **Step 1: Move model contracts into `gi-ml` public runtime types**

`gi-ml` should define model-facing types without importing `@gi-tcg/agent`:

```ts
export interface ModelObservationV1 {
  schema_version: string
  player: unknown
  opponent: unknown
  candidates: ModelCandidateV1[]
}
```

- [ ] **Step 2: Replace reverse imports**

Remove imports like:

```ts
import type { ObservationV1 } from "@gi-tcg/agent"
```

Use `ModelObservationV1` or a public shared contract instead.

- [ ] **Step 3: Replace deep imports from `gi-agent`**

`gi-agent` should import:

```ts
import { createRuntimeBridge } from "@gi-tcg/gi-ml/runtime"
```

It should not import from `../../../../gi-ml/src/...`.

- [ ] **Step 4: Verify**

Run:

```bash
bun run build gi-ml gi-agent
```

Expected: package graph builds without `gi-ml -> gi-agent` dependency.

### Task 6: Redefine Window Concepts

**Files:**

- Modify: `packages/gi-ml/src/runtime/concept-model.ts`
- Modify: `packages/gi-ml/src/runtime/concept-model.test.ts`
- Modify: `packages/gi-agent/src/learning/combat-windows/*` if additional exported features are needed.

- [ ] **Step 1: Choose the intended semantics**

Pick one:

- Rename the current behavior to `aggregate_candidate`.
- Or implement a true `window` scope backed by combat-window features.

- [ ] **Step 2: Implement true window input**

A true window concept input must include:

```ts
{
  lineId: string
  horizon: number
  requiredDice: number
  requiredActiveCharacterId?: number
  expectedDamage: number
  expectedReactionDamage: number
  failureReasons: string[]
}
```

- [ ] **Step 3: Add discriminating tests**

Add synthetic cases:

```ts
expect(twoStepLethalWindow.probability).toBeGreaterThan(singleActionGreedyWindow.probability)
expect(windowWithMissingDice.failureReasons).toContain("missing_dice")
```

- [ ] **Step 4: Verify**

Run:

```bash
cd packages/gi-ml
bun test src/runtime/concept-model.test.ts
```

Expected: window tests assert sequence-level behavior, not only averaged action probabilities.

### Task 7: Restore Verification Gates

**Files:**

- Inspect: root `package.json`
- Inspect: root `bun.lock`
- Inspect: package-local `package.json` files
- Modify only if dependency entries or scripts are actually stale.

- [ ] **Step 1: Repair TypeScript availability**

The root workspace must expose:

```text
node_modules/typescript/bin/tsc
```

After dependency repair, package-local checks should work:

```bash
cd packages/gi-agent
bun run check
cd ../gi-ml
bun run check
```

- [ ] **Step 2: Repair Bun symlink permission failures**

The test environment must allow Bun to resolve patched/symlinked package dependencies under package `node_modules`.

- [ ] **Step 3: Define a minimum review gate**

Use this gate before claiming the temporal stack is stable:

```bash
cd packages/gi-ml
bun test src
bun run check

cd ../gi-agent
bun test src/knowledge/temporal-profiles src/runtime/policy src/learning/rl src/learning/combat-windows
bun run check
```

Expected: all commands complete without timeout, permission errors, or reward-contract failures.

## 7. Benchmark Requirements

The implementation should not be considered successful solely because unit tests pass. Add a small benchmark report for each major change:

- Mirror match win rate over at least 100 games.
- R1 non-empty-action rate.
- Average number of skills used per game.
- Average number of support cards played before first skill.
- Declare-end frequency in R1 and R2 when usable skill exists.
- Temporal-profile coverage: parsed profiles / total support cards.
- Sentinel-card decision checks: Paimon, Liben, Chef Mao, Timaeus, Wagner, Katheryne.

Minimum acceptance thresholds for the first stable version:

- R1 declare-end with usable skill stays below 5%.
- Temporal profile coverage for support cards reaches at least 80%.
- Sentinel-card exact profile tests pass at 100%.
- No benchmark regression greater than 5 percentage points against the previous accepted artifact unless explained by a reward-version migration.

## 8. Suggested Execution Order

1. Reward contract and dataset manifest.
2. Generated temporal profile artifact.
3. Exact card-profile parser tests.
4. Portfolio snapshot/transition rewrite.
5. Package-boundary cleanup.
6. True window concept model or rename.
7. Full verification gate and benchmark report.

This order avoids training on unstable labels, then avoids policy behavior depending on unstable card semantics, then fixes the decision model itself.

## 9. Residual Risks

- Source parsing remains brittle even after AST cleanup because the builder DSL can express arbitrary closures. The long-term solution is still builder-level Effect IR or simulator-derived profile inference.
- `PortfolioEV` can become another hand-tuned heuristic if no benchmark and explanation artifacts are required.
- Reward changes can hide policy regressions unless every artifact records reward version and dataset origin.
- Package-boundary cleanup may require public export changes in `gi-ml`; this should be done before more runtime code deep-imports internal files.

## 10. Completion Definition

This work is complete only when all of the following are true:

- `gi-agent` and `gi-ml` type checks pass.
- `gi-ml` has no dependency on `@gi-tcg/agent`.
- `gi-agent` does not deep-import `gi-ml/src`.
- Temporal profiles are loaded from generated artifacts, not runtime source paths.
- Sentinel card payoff tests assert exact values.
- Reward version is present in exported datasets and model artifacts.
- Temporal portfolio explains selected actions with before EV, after EV, delta EV, and risk.
- Declare-end decisions are covered by unit tests and benchmark counters.
- A benchmark report shows no unexplained regression against the previous accepted artifact.
