// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 — GameState → StateObservation bridge tests (`neural-leaf`).
 *
 * Validates that `observationFromState` produces a schema-v2 observation whose
 * candidate_actions align 1:1 with the legal action slate (so encoder Q lines
 * up with the actions ISMCTS scores). Does not require trained encoder weights
 * (those are schema-v2 and pending the F6 resample/retrain); the predictor
 * forward pass is covered by neural-predictor.test.ts.
 */

import { describe, expect, it } from "vitest"
import {
  Game,
  CURRENT_VERSION,
  type GameState,
  type DeckConfig,
} from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
import { legalActions } from "./engine-step.js"
import { observationFromState } from "./neural-leaf.js"
import { STATE_OBSERVATION_SCHEMA_VERSION } from "../learning/encoder/state-observation.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

async function reachActionState(seed: number): Promise<GameState | null> {
  const data = getData(CURRENT_VERSION)
  const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig
  const deck1 = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig
  const g = new Game(Game.createInitialState({ data, decks: [deck0, deck1], shuffleSeed: seed } as never))
  let cap: GameState | null = null
  const io = () =>
    ({
      notify: () => {},
      rpc: async (rq: { request?: { $case?: string; value?: unknown } }) => {
        const m = rq.request?.$case
        const r = (c: string, v: Record<string, unknown>) => ({ response: { $case: c as never, value: v as never } })
        if (m === "chooseActive") {
          const c = (rq.request?.value as { candidateIds?: number[] })?.candidateIds ?? []
          return r("chooseActive", { activeCharacterId: c[0] ?? 0 })
        }
        if (m === "rerollDice") return r("rerollDice", { diceToReroll: [] })
        if (m === "switchHands") return r("switchHands", { removedHandIds: [] })
        if (m === "selectCard") {
          const c = (rq.request?.value as { candidateDefinitionIds?: number[] })?.candidateDefinitionIds ?? []
          return r("selectCard", { selectedDefinitionId: c[0] ?? 0 })
        }
        return r("action", { chosenActionIndex: 0, usedDice: [] })
      },
    }) as never
  g.players[0].io = io()
  g.players[1].io = io()
  g.onPause = async (s: GameState) => {
    if (s.phase === "action" && !cap) {
      cap = s
      g.terminate()
    }
  }
  try {
    await g.start()
  } catch {
    // expected
  }
  return cap
}

describe("observationFromState (V31 F6 bridge)", () => {
  it("emits a schema-v3 observation aligned 1:1 with the action slate", async () => {
    const state = await reachActionState(909)
    expect(state).not.toBeNull()
    const who = state!.currentTurn
    const actions = await legalActions(state!)
    expect(actions.length).toBeGreaterThan(0)

    const exported = observationFromState(state!, who, actions)
    expect(exported).not.toBeNull()
    const obs = exported!.observation
    expect(obs.meta.schema_version).toBe(STATE_OBSERVATION_SCHEMA_VERSION)
    // One candidate per legal action, in order.
    expect(obs.candidate_actions.length).toBe(actions.length)
    expect(obs.meta.perspective).toBe(who)
    // Self side surfaces an active character (tier-0 resource, V31 F3).
    expect(obs.self.active_definition_id).toBeGreaterThan(0)
    // Opponent hand contents hidden (count only).
    expect(obs.opponent.hand.length).toBe(0)
    expect(obs.opponent.hand_size).toBeGreaterThanOrEqual(0)
    // V31 F6 / D7 — is_first_player carries the coin-flip signal.
    expect(typeof obs.self.is_first_player).toBe("boolean")
    expect(typeof obs.opponent.is_first_player).toBe("boolean")
    expect(obs.self.is_first_player).not.toBe(obs.opponent.is_first_player)
  }, 30000)

  it("returns null for a non-action state", async () => {
    // Use the initial (pre-action) state surrogate: a fresh createInitialState
    // is in initHands phase.
    const data = getData(CURRENT_VERSION)
    const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig
    const deck1 = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig
    const init = Game.createInitialState({ data, decks: [deck0, deck1], shuffleSeed: 1 } as never)
    const exported = observationFromState(init as GameState, 0, [])
    expect(exported).toBeNull()
  }, 30000)
})
