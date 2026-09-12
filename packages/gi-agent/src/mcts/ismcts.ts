// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * V31 F6 / V30 §6.3 Step 3 — Information-Set MCTS (ISMCTS).
 *
 * Engine-exact, hidden-information-aware search for the GI-TCG action phase.
 *
 * Design (matches V30 §6.3 / framework §4.1.1):
 *   ```
 *   ISMCTS(observed_state, who):
 *     for k in 1..K:                              # K determinizations
 *       det = randomize_unknowns(observed_state, who)
 *       for each root action a (after progressive widening):
 *         child = engine-step(det, a) + opponent's 1-round response  # depth = 1 round
 *         leafV[a] = terminal ? z : V(child)      # encoder leaf value (V30 §5.4)
 *       run N PUCT bandit iterations over the cached (prior, leafV) → visits_k
 *     π_root = mean_k visits_k
 *     return argmax π_root
 *   ```
 *
 * The expensive real-engine transition runs once per (determinization × root
 * action); the N "simulations" are cheap PUCT visit allocations over the cached
 * leaf values. This keeps K=16 / N=128 single-decision latency < 500 ms while
 * every transition is engine-exact (no hand-rolled apply).
 *
 * Hidden information is handled by determinization (`determinization.ts`); the
 * opponent inside each rollout uses the *same evaluator* (framework §4.3), so
 * the search is a probability-weighted minimax over sampled opponent worlds
 * (Step 5).
 *
 * This module is additive — it does not touch `mcts.ts` / `mcts-policy.ts` and
 * never modifies `packages/core`.
 */

import type { GameState } from "@gi-tcg/core"
import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"
import { legalActions, runEngineActions, type DecideActionFn } from "./engine-step.js"
import { randomizeUnknowns, makeLcg, type Rng } from "./determinization.js"
import { groupActions, progressiveWidth, type ActionGroupKey } from "./action-grouping.js"

/**
 * Leaf value: win probability in [0, 1] for player `who` at `state`.
 * Wrap the encoder V(s) head via `createNeuralLeafEvaluator` (neural-leaf.ts).
 */
export type LeafEvaluator = (state: GameState, who: 0 | 1) => number

/**
 * Per-candidate prior over the legal action slate (need not be normalised).
 * Defaults to a flat prior when not supplied.
 */
export type ActionPriorFn = (
  state: GameState,
  who: 0 | 1,
  actions: ActionInfoWithModification[],
) => number[]

export interface IsmctsConfig {
  /** Number of determinizations (framework: 8–16). */
  determinizations: number
  /** PUCT bandit iterations per determinization (framework: 64–128). */
  simulations: number
  /** PUCT exploration constant. */
  explorationConstant: number
  /**
   * Max initiative actions the engine applies for the opponent's response +
   * tail before V takes over (approximates "1 full round", framework §4.1.1).
   */
  roundActionBudget: number
  /** Progressive widening exponent α (children kept ≈ ceil(visits^α)). */
  pwAlpha: number
  /** Optional fixed seed for reproducible determinization. */
  seed?: number
  /** Hard wall-clock budget in ms; search stops sampling further determinizations. */
  timeBudgetMs?: number
}

export const DEFAULT_ISMCTS_CONFIG: IsmctsConfig = {
  determinizations: 16,
  simulations: 128,
  explorationConstant: 1.4,
  roundActionBudget: 4,
  pwAlpha: 0.5,
  timeBudgetMs: 500,
}

export interface IsmctsResult {
  /** Chosen action's index in the *original* state's VALID action slate. */
  bestActionIndex: number
  /** The chosen action info (from the original observed state). */
  bestAction: ActionInfoWithModification | null
  /** Mean visit counts per root candidate (the search policy π_root). */
  visitDistribution: number[]
  /** Root candidate actions (original observed state slate). */
  rootActions: ActionInfoWithModification[]
  /** Mean leaf-value Q per root candidate (win-prob estimate). */
  meanQ: number[]
  /** Determinizations actually searched (may be < config if time-bounded). */
  determinizationsRun: number
  /** Total real-engine transitions executed. */
  engineTransitions: number
  /** Wall-clock elapsed (ms). */
  elapsedMs: number
}

/** Internal accumulator across determinizations, keyed by the root action's
 *  *stable signature* (so the same conceptual action lines up across worlds). */
interface RootAccumulator {
  signature: string
  groupKey: ActionGroupKey
  prior: number
  totalVisits: number
  qSum: number
  qCount: number
  /** Index into the original observed state's action slate. */
  originalIndex: number
}

/**
 * Run ISMCTS from the observed state for player `who`.
 *
 * `opponentDecide` chooses the opponent's actions inside each rollout. Pass a
 * same-evaluator greedy chooser (Step 5) for probability-weighted minimax; the
 * default declares end (conservative, fast) when omitted.
 */
export async function ismctsSearch(
  observed: GameState,
  who: 0 | 1,
  leafValue: LeafEvaluator,
  opts: {
    config?: Partial<IsmctsConfig>
    prior?: ActionPriorFn
    opponentDecide?: DecideActionFn
    /** Greedy chooser for the perspective player's *tail* actions in a rollout. */
    selfTailDecide?: DecideActionFn
  } = {},
): Promise<IsmctsResult> {
  const cfg: IsmctsConfig = { ...DEFAULT_ISMCTS_CONFIG, ...opts.config }
  const t0 = Date.now()

  const rootActions = await legalActions(observed)
  if (rootActions.length === 0) {
    return {
      bestActionIndex: -1,
      bestAction: null,
      visitDistribution: [],
      rootActions: [],
      meanQ: [],
      determinizationsRun: 0,
      engineTransitions: 0,
      elapsedMs: Date.now() - t0,
    }
  }
  if (rootActions.length === 1) {
    return {
      bestActionIndex: 0,
      bestAction: rootActions[0],
      visitDistribution: [1],
      rootActions,
      meanQ: [leafValue(observed, who)],
      determinizationsRun: 0,
      engineTransitions: 0,
      elapsedMs: Date.now() - t0,
    }
  }

  const priorRaw = opts.prior
    ? opts.prior(observed, who, rootActions)
    : new Array(rootActions.length).fill(1)
  const prior = normalise(priorRaw)

  // Progressive widening (V30 §6.3 Step 3): group by fingerprint+preview-derived
  // family, keep a widened representative subset.
  const groups = groupActions(rootActions)
  const keptIndices = progressiveWidth(groups, prior, cfg.pwAlpha, cfg.simulations)

  // Build per-root accumulators keyed by stable signature.
  const acc: RootAccumulator[] = keptIndices.map((idx) => ({
    signature: actionSignature(rootActions[idx]),
    groupKey: groups[idx],
    prior: prior[idx],
    totalVisits: 0,
    qSum: 0,
    qCount: 0,
    originalIndex: idx,
  }))

  const rng: Rng = makeLcg(cfg.seed ?? ((Date.now() & 0x7fffffff) || 1))
  let engineTransitions = 0
  let detRun = 0

  const opponentDecide: DecideActionFn =
    opts.opponentDecide ?? defaultDeclareEndDecide
  const selfTailDecide: DecideActionFn =
    opts.selfTailDecide ?? defaultDeclareEndDecide

  for (let k = 0; k < cfg.determinizations; k++) {
    if (cfg.timeBudgetMs && Date.now() - t0 > cfg.timeBudgetMs) break
    const det = randomizeUnknowns(observed, who, { rng })
    const detActions = await legalActions(det)
    // Map kept root signatures → indices in this determinization's slate.
    const leafQ: number[] = new Array(acc.length).fill(0.5)
    let anyEvaluated = false
    for (let a = 0; a < acc.length; a++) {
      // Anytime: respect the wall-clock budget *between* engine transitions so
      // a single decision never blows past `timeBudgetMs` by more than one
      // (~100 ms) engine step (V30 §6.4 #2). Best-so-far is already accumulated.
      if (cfg.timeBudgetMs && Date.now() - t0 > cfg.timeBudgetMs) break
      const localIdx = findBySignature(detActions, acc[a].signature)
      if (localIdx < 0) {
        // Action not legal in this world (shouldn't happen — only public info
        // affects legality — but be safe): fall back to current-state V.
        leafQ[a] = leafValue(det, who)
        anyEvaluated = true
        continue
      }
      // Engine-exact child transition: apply my action, then opponent's
      // 1-round response, then V takes over.
      const child = await rolloutOneRound(
        det,
        who,
        localIdx,
        opponentDecide,
        selfTailDecide,
        cfg.roundActionBudget,
      )
      engineTransitions++
      anyEvaluated = true
      leafQ[a] = child.terminal
        ? child.winner === who
          ? 1
          : child.winner == null
            ? 0.5
            : 0
        : leafValue(child.state, who)
    }
    if (!anyEvaluated) break

    // Cheap PUCT bandit over fixed leaf Q (visit allocation = π for this world).
    const visits = puctVisits(
      leafQ,
      acc.map((x) => x.prior),
      cfg.simulations,
      cfg.explorationConstant,
    )
    for (let a = 0; a < acc.length; a++) {
      acc[a].totalVisits += visits[a]
      acc[a].qSum += leafQ[a]
      acc[a].qCount++
    }
    detRun++
  }

  // Assemble π_root over the *original* action slate (non-kept → 0).
  const visitDistribution = new Array(rootActions.length).fill(0)
  const meanQ = new Array(rootActions.length).fill(0)
  for (const a of acc) {
    visitDistribution[a.originalIndex] = a.totalVisits
    meanQ[a.originalIndex] = a.qCount > 0 ? a.qSum / a.qCount : 0.5
  }

  // argmax by visits, tie-break by meanQ.
  let bestIdx = acc.length > 0 ? acc[0].originalIndex : 0
  let bestScore = -Infinity
  for (const a of acc) {
    const score = a.totalVisits + meanQ[a.originalIndex] * 1e-3
    if (score > bestScore) {
      bestScore = score
      bestIdx = a.originalIndex
    }
  }

  return {
    bestActionIndex: bestIdx,
    bestAction: rootActions[bestIdx] ?? null,
    visitDistribution,
    rootActions,
    meanQ,
    determinizationsRun: detRun,
    engineTransitions,
    elapsedMs: Date.now() - t0,
  }
}

/** Apply player `who`'s root action then run ~1 round, returning the leaf state. */
async function rolloutOneRound(
  det: GameState,
  who: 0 | 1,
  myActionLocalIndex: number,
  opponentDecide: DecideActionFn,
  selfTailDecide: DecideActionFn,
  roundActionBudget: number,
): Promise<{ state: GameState; terminal: boolean; winner: 0 | 1 | null }> {
  let appliedRoot = false
  const decide: DecideActionFn = (s, w, actions) => {
    if (w === who && !appliedRoot) {
      appliedRoot = true
      return myActionLocalIndex < actions.length ? myActionLocalIndex : 0
    }
    return w === who
      ? selfTailDecide(s, w, actions)
      : opponentDecide(s, w, actions)
  }
  const res = await runEngineActions(det, decide, {
    maxActions: 1 + Math.max(0, roundActionBudget),
  })
  return { state: res.state, terminal: res.terminated, winner: res.winner }
}

/** Standard PUCT visit allocation over root children with fixed Q values. */
function puctVisits(
  q: number[],
  prior: number[],
  simulations: number,
  c: number,
): number[] {
  const n = q.length
  const visits = new Array(n).fill(0)
  const value = new Array(n).fill(0)
  let totalVisits = 0
  for (let it = 0; it < simulations; it++) {
    const sqrtTotal = Math.sqrt(totalVisits + 1)
    let best = 0
    let bestScore = -Infinity
    for (let i = 0; i < n; i++) {
      const meanV = visits[i] > 0 ? value[i] / visits[i] : q[i]
      const u = c * prior[i] * sqrtTotal / (1 + visits[i])
      const score = meanV + u
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    visits[best]++
    value[best] += q[best]
    totalVisits++
  }
  return visits
}

function normalise(xs: number[]): number[] {
  let s = 0
  for (const x of xs) s += Math.max(0, x)
  if (s <= 0) return xs.map(() => 1 / Math.max(1, xs.length))
  return xs.map((x) => Math.max(0, x) / s)
}

/** Stable signature so the "same" action lines up across determinizations. */
export function actionSignature(a: ActionInfoWithModification): string {
  switch (a.type) {
    case "useSkill":
      return `skill:${a.skill.definition.id}`
    case "playCard":
      return `card:${a.skill.caller.definition.id}`
    case "switchActive":
      return `switch:${a.to.definition.id}`
    case "elementalTuning":
      return `tune:${a.card.definition.id}`
    case "declareEnd":
      return "end"
    default:
      return "unknown"
  }
}

function findBySignature(
  actions: ActionInfoWithModification[],
  signature: string,
): number {
  for (let i = 0; i < actions.length; i++) {
    if (actionSignature(actions[i]) === signature) return i
  }
  return -1
}

/** Conservative default: always declare end (fast, no hidden assumptions). */
const defaultDeclareEndDecide: DecideActionFn = (_s, _w, actions) => {
  const i = actions.findIndex((a) => a.type === "declareEnd")
  return i >= 0 ? i : 0
}
