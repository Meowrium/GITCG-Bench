// Copyright (C) 2024-2025 Guyutongxue
//
// Smoke test for MCTS engine with mock snapshots.

import { describe, test, expect } from "vitest"
import {
  MctsEngine,
  heuristicValueFn,
  createActionGenerator,
  createPolicyPrior,
} from "./index.js"
import type { ActionPhaseSnapshot, EngineActionInfo } from "./state-snapshot.js"
import { DICE_ZERO, diceVectorFromArray } from "./dice-vector.js"
import { simulateAction, isOpponentAlive } from "./state-snapshot.js"

// ── Build mock snapshots ──

function mockSnap(chars: Array<{ hp: number; energy: number; aura: number }>, dice: number[]): ActionPhaseSnapshot {
  return {
    who: 0,
    chars: chars.map((c, i) => ({
      id: -500000 - i,
      definitionId: 1100 + i,
      hp: c.hp,
      maxHp: 10,
      energy: c.energy,
      maxEnergy: 2,
      alive: c.hp > 0,
      aura: c.aura,
      equipDefIds: [],
    })),
    activeIdx: 0,
    dice: diceVectorFromArray(dice as any),
    handDefIds: [],
    supports: [],
    summons: [],
    combatStatuses: [],
    declaredEnd: false,
    roundNumber: 1,
  }
}

// ── Simple action generator ──

function simpleActions(snap: ActionPhaseSnapshot, _oppSnap: ActionPhaseSnapshot): EngineActionInfo[] {
  const actions: EngineActionInfo[] = []
  const active = snap.chars[snap.activeIdx]
  if (!active || !active.alive) return actions

  // Skill
  actions.push({
    type: "useSkill",
    cost: new Map([[3, 3]]), // 3 pyro dice
    estimatedDamage: 2,
    applyElement: 3,
  })

  // Switch to slot 1
  if (snap.chars[1]?.alive) {
    actions.push({
      type: "switchActive",
      cost: new Map([[0, 1]]),
      switchTargetIdx: 1,
      fast: false,
    })
  }

  // Declare end
  actions.push({
    type: "declareEnd",
    cost: new Map(),
  })

  return actions
}

// ── Tests ──

describe("MCTS Engine", () => {
  test("basic search returns an action", () => {
    const selfSnap = mockSnap(
      [{ hp: 10, energy: 0, aura: 3 }],
      [3, 3, 3, 3, 3, 3, 3, 3], // 3 pyro + 5 others
    )
    const oppSnap = mockSnap(
      [{ hp: 10, energy: 0, aura: 0 }],
      [1, 1, 1, 1, 1, 1, 1, 1],
    )

    const generate = createActionGenerator(simpleActions)
    const policyPrior = createPolicyPrior(() => 1) // uniform prior
    const engine = new MctsEngine(
      policyPrior,
      heuristicValueFn,
      generate,
      { iterations: 50, maxDepth: 3 },
    )

    const result = engine.searchFromSnapshots(selfSnap, oppSnap)

    expect(result.action).not.toBeNull()
    expect(["skill", "switch", "end"]).toContain(result.action?.type)
  })

  test("dice-aware: skips unaffordable actions", () => {
    // Only 1 die — can't afford 3-cost skill
    const selfSnap = mockSnap(
      [{ hp: 10, energy: 0, aura: 3 }],
      [3], // only 1 pyro die
    )
    const oppSnap = mockSnap(
      [{ hp: 5, energy: 0, aura: 0 }],
      [1],
    )

    const generate = createActionGenerator((snap, oppSnap) => {
      // Skill costs 3 — unaffordable with 1 die
      // Should be filtered out
      return [
        { type: "useSkill", cost: new Map([[3, 3]]), estimatedDamage: 2, applyElement: 3 },
        { type: "declareEnd", cost: new Map() },
      ] as EngineActionInfo[]
    })

    const policyPrior = createPolicyPrior(() => 1)
    const engine = new MctsEngine(
      policyPrior,
      heuristicValueFn,
      generate,
      { iterations: 20, maxDepth: 2 },
    )

    const result = engine.searchFromSnapshots(selfSnap, oppSnap)
    expect(result.action?.type).toBe("end") // only end is affordable
  })

  test("prefers winning move over neutral", () => {
    // Opponent at 2 HP, our skill deals 3 damage = win
    const selfSnap = mockSnap(
      [{ hp: 10, energy: 0, aura: 3 }],
      [3, 3, 3, 8, 8, 8, 8, 8], // plenty of dice
    )
    const oppSnap = mockSnap(
      [{ hp: 2, energy: 0, aura: 0 }], // 2 HP — 1 hit to kill
      [1],
    )

    const generate = createActionGenerator((snap, oppSnap) => {
      return [
        { type: "useSkill", cost: new Map([[3, 3]]), estimatedDamage: 3, applyElement: 3 },
        { type: "switchActive", cost: new Map([[0, 1]]), switchTargetIdx: 0, fast: false },
        { type: "declareEnd", cost: new Map() },
      ] as EngineActionInfo[]
    })

    const policyPrior = createPolicyPrior(() => 1)
    const engine = new MctsEngine(
      policyPrior,
      heuristicValueFn,
      generate,
      { iterations: 100, maxDepth: 3, temperature: 0 },
    )

    const result = engine.searchFromSnapshots(selfSnap, oppSnap)
    expect(result.action?.type).toBe("skill") // should find the winning skill
  })
})
