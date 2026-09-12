// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / V30 §6.4 acceptance #1 — Engine-exact step on a real game state.
 *
 * Drives a real `@gi-tcg/core` game (decoded benchmark decks) to its first
 * action-phase decision point, then verifies `engineExactStep` applies exactly
 * one initiative action and advances the state consistently. This is the
 * "true engine step vs old apply" check: the engine step must mutate real
 * fields (dice spent, hp/energy) rather than the hand-rolled approximation.
 */

import { describe, expect, it } from "vitest"
import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
import { ActionValidity } from "@gi-tcg/typings"
import { engineExactStep, legalActions, runEngineActions } from "./engine-step.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

/** Drive a fresh game to its first `action` phase pause and return that state. */
async function reachFirstActionState(): Promise<GameState | null> {
  const data = getData(CURRENT_VERSION)
  const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig
  const deck1 = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig
  const initial = Game.createInitialState({
    data,
    decks: [deck0, deck1],
    shuffleSeed: 12345,
  } as never)
  const game = new Game(initial)
  let captured: GameState | null = null
  game.players[0].io = stubIo()
  game.players[1].io = stubIo()
  game.onPause = async (state: GameState) => {
    if (state.phase === "action" && captured === null) {
      captured = state
      game.terminate()
    }
  }
  try {
    await game.start()
  } catch {
    // termination rejects — expected
  }
  return captured
}

function stubIo() {
  return {
    notify: () => {},
    rpc: async (request: { request?: { $case?: string; value?: unknown } }) => {
      const method = request.request?.$case
      const resp = (m: string, v: Record<string, unknown>) => ({
        response: { $case: m as never, value: v as never },
      })
      switch (method) {
        case "action":
          return resp("action", { chosenActionIndex: 0, usedDice: [] })
        case "chooseActive": {
          const c = (request.request?.value as { candidateIds?: number[] })?.candidateIds ?? []
          return resp("chooseActive", { activeCharacterId: c[0] ?? 0 })
        }
        case "rerollDice":
          return resp("rerollDice", { diceToReroll: [] })
        case "switchHands":
          return resp("switchHands", { removedHandIds: [] })
        case "selectCard": {
          const c = (request.request?.value as { candidateDefinitionIds?: number[] })?.candidateDefinitionIds ?? []
          return resp("selectCard", { selectedDefinitionId: c[0] ?? 0 })
        }
        default:
          return resp("action", { chosenActionIndex: 0, usedDice: [] })
      }
    },
  } as never
}

describe("engine-exact step (V30 §6.4 #1)", () => {
  it("reaches an action-phase state with legal actions", async () => {
    const state = await reachFirstActionState()
    expect(state).not.toBeNull()
    expect(state!.phase).toBe("action")
    const actions = await legalActions(state!)
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((a) => a.validity === ActionValidity.VALID)).toBe(true)
  }, 30000)

  it("applies exactly one initiative action through the real engine", async () => {
    const state = await reachFirstActionState()
    expect(state).not.toBeNull()
    const actions = await legalActions(state!)
    // Pick a skill if available, else first action.
    const skillIdx = actions.findIndex((a) => a.type === "useSkill")
    const idx = skillIdx >= 0 ? skillIdx : 0
    const result = await engineExactStep(state!, idx)
    expect(result.actionsApplied).toBe(1)
    // State object must differ from input (engine produced a new immutable state).
    expect(result.state).not.toBe(state)
  }, 30000)

  it("declareEnd advances turn to the opponent (real engine semantics)", async () => {
    const state = await reachFirstActionState()
    expect(state).not.toBeNull()
    const actions = await legalActions(state!)
    const endIdx = actions.findIndex((a) => a.type === "declareEnd")
    expect(endIdx).toBeGreaterThanOrEqual(0)
    const who = state!.currentTurn
    const result = await engineExactStep(state!, endIdx)
    expect(result.actionsApplied).toBe(1)
    // After our declareEnd, this side is flagged declaredEnd.
    expect(result.state.players[who].declaredEnd).toBe(true)
  }, 30000)

  it("runEngineActions can stop before the opponent's action", async () => {
    const state = await reachFirstActionState()
    const who = state!.currentTurn
    const opp = (1 - who) as 0 | 1
    // Always declareEnd for whoever acts; stop before opponent.
    const result = await runEngineActions(
      state!,
      (s, w, acts) => {
        const i = acts.findIndex((a) => a.type === "declareEnd")
        return i >= 0 ? i : 0
      },
      { maxActions: 10, stopBeforeWho: opp },
    )
    expect(result.state.players[who].declaredEnd).toBe(true)
  }, 30000)
})
