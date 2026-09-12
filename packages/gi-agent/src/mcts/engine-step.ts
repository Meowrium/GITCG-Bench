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
 * V31 F6 / V30 §6.3 Step 1 — Engine-exact single-step transition.
 *
 * Replaces the hand-rolled `applyActionToEngineState` approximation in
 * `engine-continuation.ts` with a single step through the *real* `@gi-tcg/core`
 * engine. `GameState` is immutable and `new Game(state)` produces a fresh
 * mutator chain, so no manual deep clone is needed — the engine isolates
 * automatically (same pattern proven in `runtime/adapters/sim-adapter.ts`).
 *
 * The stepper drives the engine forward until either:
 *   - the perspective player must make their next *initiative* action decision,
 *   - the game ends, or
 *   - a budget of decision points is exhausted (depth = "double-round" for
 *     ISMCTS, per framework §4.1.1 "双方各完整 1 回合").
 *
 * Forced sub-decisions (chooseActive after defeat, reroll, switchHands,
 * selectCard) are resolved by deterministic stub IO so MCTS only branches on
 * initiative actions, which is the decision granularity that matters.
 *
 * Dependency direction: core → data → agent. This file only imports core/typings
 * and never mutates `packages/core` (V30 §9 invariant 1/2).
 */

import {
  Game,
  type GameState,
} from "@gi-tcg/core"
import {
  type RpcResponse,
  ActionValidity,
  DiceType,
} from "@gi-tcg/typings"
import { chooseDice } from "@gi-tcg/utils"
import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"
import { getCachedLegalActionsWithMeta } from "../runtime/adapters/legal-actions-cache.js"

/** A function that, given the legal action slate for a decision point, returns
 *  the chosen action index. Used to drive both the perspective player and the
 *  minimax opponent during ISMCTS rollout. */
export type DecideActionFn = (
  state: GameState,
  who: 0 | 1,
  actions: ActionInfoWithModification[],
) => number

export interface EngineStepResult {
  /** Resulting state at the next pause / decision point / terminal. */
  state: GameState
  /** True if the game reached `gameEnd`. */
  terminated: boolean
  /** Winner if terminated (else null). */
  winner: 0 | 1 | null
  /** Number of initiative actions actually applied during this step. */
  actionsApplied: number
}

/** Legal (VALID) initiative actions for the player whose turn it currently is. */
export async function legalActions(
  state: GameState,
): Promise<ActionInfoWithModification[]> {
  const entry = await getCachedLegalActionsWithMeta(state)
  return entry.valid
}

function rpcResp(method: string, value: Record<string, unknown>): RpcResponse {
  return { response: { $case: method as never, value: value as never } }
}

function autoSelectDice(
  availableDice: readonly DiceType[],
  actionInfo: ActionInfoWithModification,
): DiceType[] {
  if (actionInfo.autoSelectedDice && actionInfo.autoSelectedDice.length > 0) {
    return [...actionInfo.autoSelectedDice]
  }
  const selected = chooseDice(actionInfo.cost, availableDice)
  return availableDice.filter((_, i) => selected[i])
}

/**
 * Drive the real engine forward, applying initiative actions chosen by
 * `decide` for *both* players, until `maxActions` initiative actions have been
 * applied, the game ends, or the engine pauses at a state where the next
 * initiative decision belongs to `stopForWho` (when provided).
 *
 * For a single engine-exact step (V30 §6.4 acceptance #1), call with
 * `maxActions = 1`.
 */
export async function runEngineActions(
  state: GameState,
  decide: DecideActionFn,
  opts: {
    /** Apply at most this many initiative actions before returning. */
    maxActions?: number
    /** If set, stop *before* applying an action for this player (so the caller
     *  — typically the search root — can take over). */
    stopBeforeWho?: 0 | 1
  } = {},
): Promise<EngineStepResult> {
  const maxActions = opts.maxActions ?? 1
  let actionsApplied = 0
  let finalState = state
  let terminated = false
  let winner: 0 | 1 | null = null
  let shouldStop = false

  const game = new Game(state)

  const makeIo = (playerWho: 0 | 1) => ({
    notify: () => {},
    rpc: async (request: { request?: { $case?: string; value?: unknown } }): Promise<RpcResponse> => {
      const method = request.request?.$case
      if (!method) throw new Error("Invalid RPC request")
      switch (method) {
        case "action": {
          // Decide whether to stop before this player's action.
          if (
            opts.stopBeforeWho !== undefined &&
            playerWho === opts.stopBeforeWho
          ) {
            shouldStop = true
            game.terminate()
            // C3: After `terminate()`, the engine will reject the start()
            // promise and the response value is *not consumed*. Return a
            // harmless stub immediately, avoiding a full ActionPreviewer
            // pass to find `declareEnd`.
            return rpcResp("action", { chosenActionIndex: 0, usedDice: [] })
          }
          if (actionsApplied >= maxActions) {
            shouldStop = true
            game.terminate()
            // C3: Same as above — response is discarded post-terminate.
            return rpcResp("action", { chosenActionIndex: 0, usedDice: [] })
          }
          // C1: Use the cached full slate keyed by current engine state.
          // The cached entry pre-computes validIdx-style splits so we
          // avoid both the ActionPreviewer pass and the per-call O(n)
          // VALID scan.
          const cached = await getCachedLegalActionsWithMeta(game.state)
          const full = cached.full
          const validIdx: number[] = []
          for (let i = 0; i < full.length; i++) {
            if (full[i].validity === ActionValidity.VALID) validIdx.push(i)
          }
          if (validIdx.length === 0) {
            return rpcResp("action", { chosenActionIndex: 0, usedDice: [] })
          }
          const actions = validIdx.map((i) => full[i])
          let idx = decide(game.state, playerWho, actions)
          if (idx < 0 || idx >= actions.length) idx = 0
          const chosen = actions[idx]
          const engineIdx = validIdx[idx]
          const usedDice = autoSelectDice(game.state.players[playerWho].dice, chosen)
          actionsApplied++
          return rpcResp("action", {
            chosenActionIndex: engineIdx >= 0 ? engineIdx : 0,
            usedDice,
          })
        }
        case "chooseActive": {
          const candidates =
            (request.request?.value as { candidateIds?: number[] })?.candidateIds ?? []
          // Pick highest-HP alive candidate (deterministic stub).
          let best = candidates[0] ?? 0
          let bestHp = -1
          for (const id of candidates) {
            const ch = game.state.players[playerWho].characters.find((c) => c.id === id)
            const hp = ch?.variables.health ?? 0
            if (hp > bestHp) {
              bestHp = hp
              best = id
            }
          }
          return rpcResp("chooseActive", { activeCharacterId: best })
        }
        case "selectCard": {
          const candidates =
            (request.request?.value as { candidateDefinitionIds?: number[] })
              ?.candidateDefinitionIds ?? []
          return rpcResp("selectCard", { selectedDefinitionId: candidates[0] ?? 0 })
        }
        case "rerollDice":
          return rpcResp("rerollDice", { diceToReroll: [] })
        case "switchHands":
          return rpcResp("switchHands", { removedHandIds: [] })
        default:
          throw new Error(`Unexpected RPC method: ${method}`)
      }
    },
  })

  game.players[0].io = makeIo(0) as never
  game.players[1].io = makeIo(1) as never

  game.onPause = async (pauseState: GameState) => {
    finalState = pauseState
    if (shouldStop) {
      game.terminate()
    }
  }

  try {
    const w = await game.start()
    winner = (w ?? null) as 0 | 1 | null
    if (game.state.phase === "gameEnd") {
      terminated = true
    }
  } catch {
    // termination rejects the start() promise — expected for early stop.
  }

  finalState = game.state
  if (finalState.phase === "gameEnd") {
    terminated = true
    winner = finalState.winner
  }

  return { state: finalState, terminated, winner, actionsApplied }
}

/**
 * Convenience: apply exactly one initiative action (by index into the VALID
 * action slate) for the current-turn player and return the resulting state.
 * This is the engine-exact replacement for the old `applyActionToEngineState`.
 */
export async function engineExactStep(
  state: GameState,
  actionIndex: number,
): Promise<EngineStepResult> {
  let used = false
  return runEngineActions(
    state,
    () => {
      if (!used) {
        used = true
        return actionIndex
      }
      return -1
    },
    { maxActions: 1 },
  )
}
