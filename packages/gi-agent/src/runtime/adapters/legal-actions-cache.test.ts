// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Tests for the legal-actions cache (C1).
 *
 * Verifies:
 *  1. Repeated calls on the same `GameState` reference return the same slate
 *     (cache hit).
 *  2. The cached slate equals what `Game.availableActions()` would return
 *     when filtered to VALID — i.e. the cache does not alter semantics.
 *  3. `declareEndIndexFull` points at the actual declareEnd action in the
 *     full slate.
 *  4. Distinct `GameState` references produce independent cache entries
 *     (no cross-state pollution).
 */

import { describe, expect, it } from "vitest"
import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index"
import { ActionValidity } from "@gi-tcg/typings"
import {
  getCachedLegalActions,
  getCachedLegalActionsWithMeta,
} from "./legal-actions-cache.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

async function reachFirstActionState(seed: number): Promise<GameState | null> {
  const data = getData(CURRENT_VERSION)
  const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig
  const deck1 = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig
  const initial = Game.createInitialState({
    data,
    decks: [deck0, deck1],
    shuffleSeed: seed,
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

describe("legal-actions cache (C1)", () => {
  it("returns the same array reference on repeated lookups of the same state", async () => {
    const state = await reachFirstActionState(12345)
    expect(state).not.toBeNull()
    const a = await getCachedLegalActions(state!)
    const b = await getCachedLegalActions(state!)
    // Same reference (cache hit) — not just equal contents.
    expect(b).toBe(a)
  }, 30000)

  it("returns only VALID actions, matching a fresh Game.availableActions() filter on the same state", async () => {
    const state = await reachFirstActionState(12345)
    expect(state).not.toBeNull()

    // Run a fresh engine query against the *same* GameState ref before
    // the cache populates. Since the cache stores Promises keyed by the
    // GameState reference, we need to query the engine directly here on
    // an *unseen* state ref to compare against the cached result.
    const game = new Game(state!)
    let baseline: ReturnType<Game["availableActions"]>
    try {
      baseline = game.availableActions()
    } finally {
      game.terminate()
    }
    const baselineFull = await baseline
    const baselineValid = baselineFull.filter(
      (a) => a.validity === ActionValidity.VALID,
    )

    // Now populate the cache and compare.
    const cached = await getCachedLegalActions(state!)
    expect(cached.length).toBe(baselineValid.length)
    for (let i = 0; i < cached.length; i++) {
      expect(cached[i].type).toBe(baselineValid[i].type)
    }
  }, 30000)

  it("exposes a working declareEndIndexFull pointer into the full slate", async () => {
    const state = await reachFirstActionState(12345)
    expect(state).not.toBeNull()
    const meta = await getCachedLegalActionsWithMeta(state!)
    expect(meta.full.length).toBeGreaterThan(0)
    if (meta.declareEndIndexFull >= 0) {
      expect(meta.full[meta.declareEndIndexFull].type).toBe("declareEnd")
    }
  }, 30000)

  it("independent states produce independent cache entries", async () => {
    const stateA = await reachFirstActionState(11111)
    const stateB = await reachFirstActionState(22222)
    expect(stateA).not.toBeNull()
    expect(stateB).not.toBeNull()
    const a = await getCachedLegalActions(stateA!)
    const b = await getCachedLegalActions(stateB!)
    // Different state objects → different cache entries (different array refs).
    expect(b).not.toBe(a)
  }, 30000)
})
