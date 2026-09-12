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
 * V31 F6 / V30 §6.3 Step 3 + Step 5 — neural leaf value, prior, and the
 * same-evaluator opponent.
 *
 * Bridges a raw `@gi-tcg/core` `GameState` to the Stage-3 encoder
 * (`V30NeuralPredictor`) so ISMCTS can use:
 *   - V(s) as the leaf value when "1 round" has been searched and V takes over
 *     (framework §4.1.1 / V30 §5.4), and
 *   - per-candidate Q / softmax(Q) as the PUCT prior.
 *
 * The opponent model inside rollouts is the *same evaluator* (framework §4.3):
 * `createSameEvaluatorOpponent` returns a `DecideActionFn` that picks the
 * opponent's action greedily by the encoder's Q from the opponent's own
 * perspective. Searching each sampled determinization with this opponent and
 * averaging over K worlds realises the probability-weighted minimax of §4.2.
 *
 * Conversion uses the engine's public `exposeState` / `exposeAction` (the same
 * redacted view the runtime policy sees) → `StateExporter`, so no hidden
 * information leaks and the encoder input layout exactly matches training.
 */

import { exposeState, type GameState } from "@gi-tcg/core"
import type { Action as RpcAction } from "@gi-tcg/typings"
import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"
import { StateExporter } from "../learning/encoder/state-exporter.js"
import type { V30NeuralPredictor } from "../learning/encoder/neural-predictor.js"
import type { NeuralPredictorOutput } from "../learning/encoder/neural-predictor.js"
import type { LeafEvaluator, ActionPriorFn } from "./ismcts.js"
import type { DecideActionFn } from "./engine-step.js"
import { legalActions } from "./engine-step.js"
import { exposeActionsForObservation } from "./expose-actions.js"

/** Sigmoid in logit-space → win-prob. */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

/**
 * Build a `StateObservation` for `who` from a raw GameState, scoring the given
 * legal actions. Returns null if the state is not in the action phase.
 *
 * V31 F6 / D7: `firstPlayer` optionally surfaces the coin-flip winner so the
 * exporter can set `SideObservation.is_first_player`. Defaults to the live
 * `state.currentTurn` (correct only at the very first action-phase view; for
 * self-play prefer the externally-latched value to keep the flag stable across
 * the trajectory).
 *
 * V31 F6 / D8b: `gameId` / `sampleIndex` must be provided by the self-play
 * collector so the Python trainer's per-trajectory grouping (TD(λ),
 * online-TD successor index, mirror-pair index) works. Default values of
 * `"ismcts"` and `0` are kept for backwards compatibility with runtime
 * scorers that don't need trajectory grouping (NeuralEvaluatorPolicy), but
 * any collector writing samples to the DataLake MUST pass real values.
 */
export function observationFromState(
  state: GameState,
  who: 0 | 1,
  actions: ActionInfoWithModification[],
  firstPlayer?: 0 | 1,
  gameId: string = "ismcts",
  sampleIndex: number = 0,
): ReturnType<typeof StateExporter.export> | null {
  if (state.phase !== "action") return null
  const pbState = exposeState(who, state)
  const validActions = exposeActionsForObservation(actions) as unknown as Array<{
    action: RpcAction;
    index: number;
  }>
  return StateExporter.export({
    notificationState: pbState as never,
    perspective: who,
    validActions,
    gameId,
    sampleIndex,
    firstPlayer: firstPlayer ?? ((state.currentTurn & 1) as 0 | 1),
  })
}

/**
 * Leaf evaluator backed by the encoder V(s) head. Returns win-prob in [0,1]
 * for `who`. Falls back to an HP-ratio heuristic when the state cannot be
 * encoded (e.g. terminal / non-action phase).
 */
export function createNeuralLeafEvaluator(
  predictor: V30NeuralPredictor,
): LeafEvaluator {
  return (state, who) => {
    // No legal actions needed for V(s); but the encoder also scores candidates.
    // We can pass an empty slate and still read V.
    try {
      const exported = observationFromState(state, who, [])
      if (!exported) return hpHeuristic(state, who)
      const out: NeuralPredictorOutput = predictor.predict({
        observation: exported.observation,
      })
      return sigmoid(out.v)
    } catch {
      return hpHeuristic(state, who)
    }
  }
}

/**
 * Async leaf evaluator that also fetches the legal actions so the encoder's
 * dueling head sees real candidates (sharper V via advantage baseline). Use
 * when latency budget allows; the sync variant above is cheaper.
 */
export function createNeuralLeafEvaluatorWithActions(
  predictor: V30NeuralPredictor,
): (state: GameState, who: 0 | 1) => Promise<number> {
  return async (state, who) => {
    try {
      if (state.phase !== "action") return hpHeuristic(state, who)
      const actions = await legalActions(state)
      const exported = observationFromState(state, who, actions)
      if (!exported) return hpHeuristic(state, who)
      const out = predictor.predict({ observation: exported.observation })
      return sigmoid(out.v)
    } catch {
      return hpHeuristic(state, who)
    }
  }
}

/** Encoder-Q softmax prior over the root action slate. */
export function createNeuralPrior(predictor: V30NeuralPredictor): ActionPriorFn {
  return (state, who, actions) => {
    try {
      const exported = observationFromState(state, who, actions)
      if (!exported) return actions.map(() => 1)
      const out = predictor.predict({ observation: exported.observation })
      // out.q is index-aligned with candidate_actions, which we built 1:1 with
      // `actions`. Softmax over Q → prior.
      const q = out.q.length === actions.length ? out.q : actions.map(() => 0)
      const maxQ = Math.max(...q, -1e9)
      const exps = q.map((x) => Math.exp(Math.min(x - maxQ, 20)))
      const sum = exps.reduce((a, b) => a + b, 0) || 1
      return exps.map((e) => e / sum)
    } catch {
      return actions.map(() => 1)
    }
  }
}

/**
 * Step 5 — same-evaluator opponent. Picks the opponent's action greedily by the
 * encoder's win-prob (from the *opponent's* perspective). This makes each
 * rollout a best-response minimax leaf; averaging over K determinizations gives
 * the probability-weighted minimax of framework §4.2.
 */
export function createSameEvaluatorOpponent(
  predictor: V30NeuralPredictor,
): DecideActionFn {
  return (state, who, actions) => {
    if (actions.length <= 1) return 0
    try {
      const exported = observationFromState(state, who, actions)
      if (!exported) return greedyDamageIndex(actions)
      const out = predictor.predict({ observation: exported.observation })
      if (out.winProb.length !== actions.length) return greedyDamageIndex(actions)
      let best = 0
      let bestP = -Infinity
      for (let i = 0; i < out.winProb.length; i++) {
        if (out.winProb[i] > bestP) {
          bestP = out.winProb[i]
          best = i
        }
      }
      return best
    } catch {
      return greedyDamageIndex(actions)
    }
  }
}

/** Fallback opponent: prefer the highest-preview-damage action, else declareEnd. */
function greedyDamageIndex(actions: ActionInfoWithModification[]): number {
  let best = -1
  let bestDmg = -1
  for (let i = 0; i < actions.length; i++) {
    const pv = (actions[i] as { preview?: unknown }).preview
    if (Array.isArray(pv) && pv.length > 0) {
      // crude: count mutation entries as a damage proxy
      const proxy = pv.length
      if (proxy > bestDmg) {
        bestDmg = proxy
        best = i
      }
    }
  }
  if (best >= 0) return best
  const end = actions.findIndex((a) => a.type === "declareEnd")
  return end >= 0 ? end : 0
}

/** HP-ratio win-prob heuristic used when encoding is unavailable. */
function hpHeuristic(state: GameState, who: 0 | 1): number {
  const me = state.players[who]
  const opp = state.players[(1 - who) as 0 | 1]
  const sum = (p: typeof me) =>
    p.characters.reduce(
      (s, c) => s + Math.max(0, (c.variables.alive ? c.variables.health : 0) ?? 0),
      0,
    )
  const aliveMe = me.characters.filter((c) => c.variables.alive).length
  const aliveOpp = opp.characters.filter((c) => c.variables.alive).length
  if (aliveOpp === 0) return 1
  if (aliveMe === 0) return 0
  const myHp = sum(me)
  const oppHp = sum(opp)
  const total = myHp + oppHp
  if (total <= 0) return 0.5
  return Math.max(0.02, Math.min(0.98, myHp / total))
}

/**
 * V31 F6 / D7 — first-mover tracker shared by both IO instances of one game.
 * Latches `state.currentTurn` at the earliest action-phase decision so each
 * `observationFromState` call produces a `SideObservation.is_first_player`
 * value that is stable across the whole trajectory and consistent on both
 * sides.
 */
export class FirstPlayerLatch {
  private value: 0 | 1 | null = null
  set(state: GameState): 0 | 1 {
    if (this.value === null && state.phase === "action") {
      this.value = (state.currentTurn & 1) as 0 | 1
    }
    return this.value ?? ((state.currentTurn & 1) as 0 | 1)
  }
  get(): 0 | 1 | null {
    return this.value
  }
}
