// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / V30 §6.3 Step 3 — progressive-widening grouping unit tests.
 *
 * Pure-logic tests (no engine) for `classifyAction` and `progressiveWidth`.
 */

import { describe, expect, it } from "vitest"
import {
  classifyAction,
  progressiveWidth,
  type ActionGroupKey,
} from "./action-grouping.js"
import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"

function fakeAction(
  type: string,
  preview?: unknown[],
): ActionInfoWithModification {
  const base: Record<string, unknown> = { type, fast: false, validity: 0, cost: new Map(), preview }
  // Provide just enough structure for classifyAction.
  switch (type) {
    case "useSkill":
      base.skill = { definition: { id: 11011 } }
      base.targets = []
      break
    case "playCard":
      base.skill = { caller: { id: -1, definition: { id: 312001 } } }
      base.targets = []
      break
    case "switchActive":
      base.to = { id: -2, definition: { id: 1102 } }
      break
    case "elementalTuning":
      base.card = { id: -3, definition: { id: 312001 } }
      base.result = 3
      break
  }
  return base as unknown as ActionInfoWithModification
}

describe("classifyAction (preview-derived families)", () => {
  it("declareEnd → pass", () => {
    expect(classifyAction(fakeAction("declareEnd"))).toBe("pass")
  })
  it("elementalTuning → dice_tuning", () => {
    expect(classifyAction(fakeAction("elementalTuning"))).toBe("dice_tuning")
  })
  it("switchActive → switch_pivot", () => {
    expect(classifyAction(fakeAction("switchActive"))).toBe("switch_pivot")
  })
  it("skill with no preview → energy_build fallback", () => {
    expect(classifyAction(fakeAction("useSkill"))).toBe("energy_build")
  })
  it("card with no preview → other", () => {
    expect(classifyAction(fakeAction("playCard"))).toBe("other")
  })
})

describe("progressiveWidth", () => {
  it("keeps at least one representative of every present family", () => {
    const groups: ActionGroupKey[] = [
      "lethal",
      "damage",
      "damage",
      "support_setup",
      "pass",
    ]
    const prior = [0.1, 0.3, 0.2, 0.2, 0.2]
    const kept = progressiveWidth(groups, prior, 0.5, 4)
    const keptFamilies = new Set(kept.map((i) => groups[i]))
    // 4 distinct families present → all must survive.
    expect(keptFamilies.has("lethal")).toBe(true)
    expect(keptFamilies.has("damage")).toBe(true)
    expect(keptFamilies.has("support_setup")).toBe(true)
    expect(keptFamilies.has("pass")).toBe(true)
  })

  it("never drops below the number of present families", () => {
    const groups: ActionGroupKey[] = ["damage", "damage", "damage", "damage"]
    const prior = [0.25, 0.25, 0.25, 0.25]
    // budget = ceil(1^0.5) = 1, but 1 family present → at least 1 kept.
    const kept = progressiveWidth(groups, prior, 0.5, 1)
    expect(kept.length).toBeGreaterThanOrEqual(1)
  })

  it("widens with larger simulation budgets", () => {
    const groups: ActionGroupKey[] = new Array(20).fill("damage")
    const prior = new Array(20).fill(0.05)
    const small = progressiveWidth(groups, prior, 0.5, 16)
    const large = progressiveWidth(groups, prior, 0.5, 400)
    expect(large.length).toBeGreaterThan(small.length)
    expect(large.length).toBeLessThanOrEqual(20)
  })

  it("prefers higher-prior candidates when widening within a family", () => {
    const groups: ActionGroupKey[] = ["damage", "damage", "damage"]
    const prior = [0.1, 0.7, 0.2]
    const kept = progressiveWidth(groups, prior, 0.5, 4)
    // index 1 (highest prior) must be the representative kept first.
    expect(kept[0]).toBe(1)
  })
})
