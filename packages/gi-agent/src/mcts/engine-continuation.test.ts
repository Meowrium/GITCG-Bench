// Copyright (C) 2024-2025 Guyutongxue
//
// Engine Continuation Tests — verify engine-backed action snapshot
// produces results consistent with the lightweight simulator for
// basic actions (skills, switches, declareEnd).

import { expect, test } from "vitest"
import {
  cloneMutableState,
  engineBackedActionSnapshot,
  type EngineActionInfo,
} from "./engine-continuation.js"
import type { GameState } from "@gi-tcg/core"
import { DiceType } from "@gi-tcg/typings"

// ── Synthetic GameState for testing ──

function makeTestState(): GameState {
  return {
    $$: "game" as const,
    data: {} as any,
    config: { errorLevel: "strict" as const, maxDiceCount: 16, maxHandsCount: 10, maxPileCount: 200, maxRoundsCount: 15, maxSupportsCount: 4, maxSummonsCount: 4 },
    phase: "action" as const,
    roundNumber: 1,
    winner: null,
    players: [
      {
        $$: "player" as const,
        activeCharacterId: -1001,  // NOT activeCharacterIndex
        characters: [
          {
            $$: "character" as const,
            id: -1001,
            definition: { id: 1705, type: "character" } as any,
            variables: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 3, alive: 1, aura: 0 },
            entities: [],
            status: [],
          },
          {
            $$: "character" as const,
            id: -1002,
            definition: { id: 1510, type: "character" } as any,
            variables: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 2, alive: 1, aura: 0 },
            entities: [],
            status: [],
          },
        ],
        dice: [DiceType.Pyro, DiceType.Pyro, DiceType.Pyro, DiceType.Omni, DiceType.Omni, DiceType.Omni, DiceType.Omni, DiceType.Omni] as any,
        hands: [],  // NEEDED by takeActionPhaseSnapshot
        pile: [],
        summons: [],
        supports: [],
        combatStatuses: [],
        pileCount: 20,
        handCount: 5,
        declaredEnd: false,
      },
      {
        $$: "player" as const,
        activeCharacterId: -2001,
        characters: [
          {
            $$: "character" as const,
            id: -2001,
            definition: { id: 1407, type: "character" } as any,
            variables: { health: 10, maxHealth: 10, energy: 0, maxEnergy: 2, alive: 1, aura: 0 },
            entities: [],
            status: [],
          },
        ],
        dice: [DiceType.Hydro, DiceType.Hydro, DiceType.Hydro, DiceType.Omni, DiceType.Omni, DiceType.Omni, DiceType.Omni, DiceType.Omni] as any,
        hands: [],
        pile: [],
        summons: [],
        supports: [],
        combatStatuses: [],
        pileCount: 20,
        handCount: 5,
        declaredEnd: false,
      },
    ],
  } as any as GameState
}

// ─────────────────────────────────────────────
// Test: cloneMutableState produces independent copy
// ─────────────────────────────────────────────

test("cloneMutableState: deep copies character HP", () => {
  const state = makeTestState()
  const cloned = cloneMutableState(state)

  expect(cloned.players[0].characters[0].variables.health).toBe(10)

  ;(cloned.players[0].characters[0].variables as any).health = 5
  expect(state.players[0].characters[0].variables.health).toBe(10)
  expect(cloned.players[0].characters[0].variables.health).toBe(5)
})

test("cloneMutableState: deep copies entity variables", () => {
  const state = makeTestState()
  // Add a support with variables
  ;(state.players[0] as any).supports = [{
    $$: "entity" as const,
    id: -3001,
    definition: { id: 330001 } as any,
    variables: { usage: 2, maxUsage: 3 },
  }] as any

  const cloned = cloneMutableState(state)
  ;(cloned.players[0].supports[0].variables as any).usage = 1

  expect(state.players[0].supports[0].variables.usage).toBe(2)
  expect(cloned.players[0].supports[0].variables.usage).toBe(1)
})

test("cloneMutableState: shares data reference (not deep-copies data)", () => {
  const state = makeTestState()
  const cloned = cloneMutableState(state)

  // Data should be the same reference (immutable)
  expect(cloned.data).toBe(state.data)
})

// ─────────────────────────────────────────────
// Test: engineBackedActionSnapshot
// ─────────────────────────────────────────────

test("engineBackedActionSnapshot: skill applies damage to opponent", () => {
  const state = makeTestState()

  const action: EngineActionInfo = {
    type: "useSkill",
    cost: new Map([[DiceType.Pyro, 3]]),
    estimatedDamage: 3,
    applyElement: DiceType.Pyro,
    actorDefId: 1705,
    skillType: "elemental",
    energyCost: undefined,
  }

  const result = engineBackedActionSnapshot(state, 0, action)

  // Opponent should have taken 3 damage
  expect(result.oppSnapshot.chars[0].hp).toBe(7)
  // Actor should have gained 1 energy
  expect(result.selfSnapshot.chars[0].energy).toBe(1)
})

test("engineBackedActionSnapshot: switch changes active index", () => {
  const state = makeTestState()

  const action: EngineActionInfo = {
    type: "switchActive",
    cost: new Map([[DiceType.Omni, 1]]),
    switchTargetIdx: 1,
    actorDefId: 1705,
  }

  const result = engineBackedActionSnapshot(state, 0, action)

  expect(result.selfSnapshot.activeIdx).toBe(1)
})

test("engineBackedActionSnapshot: declareEnd sets flag", () => {
  const state = makeTestState()

  const action: EngineActionInfo = {
    type: "declareEnd",
    cost: new Map(),
    actorDefId: 1705,
  }

  const result = engineBackedActionSnapshot(state, 0, action)

  expect(result.selfSnapshot.declaredEnd).toBe(true)
})
