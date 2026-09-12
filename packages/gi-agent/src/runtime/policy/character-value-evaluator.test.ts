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

import { describe, it, expect } from "vitest"
import {
  reactionBonusForPair,
  computeCollapseDistance,
} from "./character-value-evaluator.js"

describe("V31 F1 — additive reaction bonus (engine-aligned)", () => {
  it("amplifying reactions → flat +2", () => {
    // vaporize
    expect(reactionBonusForPair("hydro", new Set(["pyro"]))).toBe(2)
    expect(reactionBonusForPair("pyro", new Set(["hydro"]))).toBe(2)
    // melt
    expect(reactionBonusForPair("cryo", new Set(["pyro"]))).toBe(2)
    expect(reactionBonusForPair("pyro", new Set(["cryo"]))).toBe(2)
    // overloaded
    expect(reactionBonusForPair("pyro", new Set(["electro"]))).toBe(2)
    expect(reactionBonusForPair("electro", new Set(["pyro"]))).toBe(2)
  })

  it("transformative reactions → flat +1", () => {
    expect(reactionBonusForPair("cryo", new Set(["electro"]))).toBe(1) // superconduct
    expect(reactionBonusForPair("hydro", new Set(["electro"]))).toBe(1) // electro-charged
    expect(reactionBonusForPair("hydro", new Set(["cryo"]))).toBe(1) // frozen
    expect(reactionBonusForPair("dendro", new Set(["pyro"]))).toBe(1) // burning
    expect(reactionBonusForPair("electro", new Set(["dendro"]))).toBe(1) // quicken
    expect(reactionBonusForPair("hydro", new Set(["geo"]))).toBe(1) // crystallize
  })

  it("no aura → 0 (opponent only applies an element)", () => {
    expect(reactionBonusForPair(null, new Set(["pyro", "hydro"]))).toBe(0)
  })

  it("no reaction pairing → 0", () => {
    expect(reactionBonusForPair("hydro", new Set(["hydro"]))).toBe(0)
    expect(reactionBonusForPair("pyro", new Set(["pyro"]))).toBe(0)
  })

  it("is purely additive, never multiplicative (6-dmg vaporize ⇒ threat 8, not 12)", () => {
    // collapseDistance threads opponentReactionBonus as ADDITIVE.
    // Old multiplicative model would have computed threat = 6 * 2 = 12.
    const hp = 10
    const distAdditive8 = computeCollapseDistance(hp, hp, 0, 3, "core", 6, 2) // threat = 6 + 2 = 8
    const distNoBonus6 = computeCollapseDistance(hp, hp, 0, 3, "core", 6, 0) // threat = 6
    const distOldMul12 = computeCollapseDistance(hp, hp, 0, 3, "core", 12, 0) // threat = 12

    // More threat → smaller collapse distance (closer to collapse).
    expect(distAdditive8).toBeLessThan(distNoBonus6)
    // The additive model is strictly less threatening than the old ×2 model.
    expect(distAdditive8).toBeGreaterThan(distOldMul12)
  })

  it("negative bonus is clamped (never increases collapse distance)", () => {
    const hp = 10
    const a = computeCollapseDistance(hp, hp, 0, 3, "core", 6, -5)
    const b = computeCollapseDistance(hp, hp, 0, 3, "core", 6, 0)
    expect(a).toBe(b)
  })
})
