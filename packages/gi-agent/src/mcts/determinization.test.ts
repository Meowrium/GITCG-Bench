// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / V30 §6.3 Step 2 — determinization tests.
 *
 * Verifies `randomizeUnknowns`:
 *   - preserves the opponent's *multiset* of remaining cards (legal pool),
 *   - preserves opponent hand size,
 *   - preserves the perspective player's known hand contents,
 *   - is engine-legal (can drive a real game step),
 *   - produces distinct worlds across K determinizations.
 */

import { describe, expect, it } from "vitest"
import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import {
  makeLcg,
  randomizeUnknowns,
  sampleDeterminizations,
} from "./determinization.js"
import { legalActions } from "./engine-step.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

async function reachActionState(seed: number): Promise<GameState | null> {
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
  const io = () =>
    ({
      notify: () => {},
      rpc: async (request: { request?: { $case?: string; value?: unknown } }) => {
        const m = request.request?.$case
        const r = (c: string, v: Record<string, unknown>) => ({ response: { $case: c as never, value: v as never } })
        if (m === "chooseActive") {
          const c = (request.request?.value as { candidateIds?: number[] })?.candidateIds ?? []
          return r("chooseActive", { activeCharacterId: c[0] ?? 0 })
        }
        if (m === "rerollDice") return r("rerollDice", { diceToReroll: [] })
        if (m === "switchHands") return r("switchHands", { removedHandIds: [] })
        if (m === "selectCard") {
          const c = (request.request?.value as { candidateDefinitionIds?: number[] })?.candidateDefinitionIds ?? []
          return r("selectCard", { selectedDefinitionId: c[0] ?? 0 })
        }
        return r("action", { chosenActionIndex: 0, usedDice: [] })
      },
    }) as never
  game.players[0].io = io()
  game.players[1].io = io()
  game.onPause = async (state: GameState) => {
    if (state.phase === "action" && captured === null) {
      captured = state
      game.terminate()
    }
  }
  try {
    await game.start()
  } catch {
    // expected
  }
  return captured
}

function multiset(cards: readonly { definition: { id: number } }[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const c of cards) m.set(c.definition.id, (m.get(c.definition.id) ?? 0) + 1)
  return m
}

function eqMultiset(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

describe("randomizeUnknowns (V30 §6.3 Step 2)", () => {
  it("preserves opponent remaining-card pool and hand size", async () => {
    const state = await reachActionState(777)
    expect(state).not.toBeNull()
    const who = state!.currentTurn
    const opp = (1 - who) as 0 | 1
    const before = multiset([...state!.players[opp].hands, ...state!.players[opp].pile])
    const handSizeBefore = state!.players[opp].hands.length

    const det = randomizeUnknowns(state!, who, { rng: makeLcg(42) })
    const after = multiset([...det.players[opp].hands, ...det.players[opp].pile])

    expect(eqMultiset(before, after)).toBe(true)
    expect(det.players[opp].hands.length).toBe(handSizeBefore)
  }, 30000)

  it("preserves the perspective player's known hand contents", async () => {
    const state = await reachActionState(778)
    const who = state!.currentTurn
    const before = multiset(state!.players[who].hands)
    const det = randomizeUnknowns(state!, who, { rng: makeLcg(7) })
    const after = multiset(det.players[who].hands)
    expect(eqMultiset(before, after)).toBe(true)
  }, 30000)

  it("does not mutate the original state", async () => {
    const state = await reachActionState(779)
    const who = state!.currentTurn
    const opp = (1 - who) as 0 | 1
    const origHandIds = state!.players[opp].hands.map((c) => c.id)
    randomizeUnknowns(state!, who, { rng: makeLcg(1) })
    expect(state!.players[opp].hands.map((c) => c.id)).toEqual(origHandIds)
  }, 30000)

  it("produces an engine-legal determinized state", async () => {
    const state = await reachActionState(780)
    const who = state!.currentTurn
    const det = randomizeUnknowns(state!, who, { rng: makeLcg(99) })
    const actions = await legalActions(det)
    // Legal action set depends on the active player's known resources, which
    // are unchanged by determinization → same count as the original.
    const origActions = await legalActions(state!)
    expect(actions.length).toBe(origActions.length)
  }, 30000)

  it("sampleDeterminizations yields distinct worlds", async () => {
    const state = await reachActionState(781)
    const who = state!.currentTurn
    const opp = (1 - who) as 0 | 1
    if (state!.players[opp].pile.length + state!.players[opp].hands.length < 4) return
    const worlds = sampleDeterminizations(state!, who, 8, { rng: makeLcg(123) })
    const sigs = new Set(
      worlds.map((w) => w.players[opp].hands.map((c) => c.definition.id).join(",")),
    )
    // At least 2 distinct opponent hands across 8 samples.
    expect(sigs.size).toBeGreaterThan(1)
  }, 30000)

  // 设计文档 §10.1 的钉死测试：oracle 信息对等——搜索视角不得保留对手真实手牌。
  // 若 randomizeUnknowns 退化为"只洗牌序不动手牌"，oracle 就变成上帝视角，
  // blunder 判定会系统性偏苛。这里断言：在池足够大的局面下，多个 determinization
  // 中绝大多数的对手手牌（按实体 id 集合）与原始不同。
  it("hides the opponent's true hand from the search perspective (info parity)", async () => {
    const state = await reachActionState(782)
    expect(state).not.toBeNull()
    const who = state!.currentTurn
    const opp = (1 - who) as 0 | 1
    const pool = state!.players[opp].pile.length + state!.players[opp].hands.length
    const handSize = state!.players[opp].hands.length
    if (pool < 6 || handSize < 2) return // 池太小时重洗可能碰巧复原，跳过
    const origIds = new Set(state!.players[opp].hands.map((c) => c.id))
    const worlds = sampleDeterminizations(state!, who, 16, { rng: makeLcg(2026) })
    const identical = worlds.filter(
      (w) => w.players[opp].hands.length === handSize
        && w.players[opp].hands.every((c) => origIds.has(c.id)),
    )
    // 16 个平行世界里，恰好复原对手真实手牌的比例应接近组合概率（远小于一半）
    expect(identical.length).toBeLessThanOrEqual(worlds.length / 2)
  }, 30000)
})
