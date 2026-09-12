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

import { describe, expect, it } from "vitest"
import {
  KNOWLEDGE_SOURCE_REGISTRY,
  confidenceGatedAlpha,
  isSafetyConstraint,
  knowledgeSourceFor,
} from "./knowledge-source.js"

describe("V31 F7 — knowledge-source taxonomy (P4)", () => {
  it("tags learned scorers as S3", () => {
    expect(knowledgeSourceFor("neural_encoder").source).toBe("S3_learned")
    expect(knowledgeSourceFor("gbdt_value").source).toBe("S3_learned")
    expect(knowledgeSourceFor("evaluator_logistic").source).toBe("S3_learned")
  })

  it("tags deck templates as S1 and meta rules as S2", () => {
    expect(knowledgeSourceFor("gameplan").source).toBe("S1_deck_template")
    expect(knowledgeSourceFor("macro_plan").source).toBe("S1_deck_template")
    expect(knowledgeSourceFor("tempo_value").source).toBe("S2_meta_rule")
    expect(knowledgeSourceFor("strategic_value").source).toBe("S2_meta_rule")
  })

  it("separates safety constraints from soft heuristics", () => {
    // safety: never overridable by S3
    expect(isSafetyConstraint("lethal_chain")).toBe(true)
    expect(isSafetyConstraint("declare_end_constraints")).toBe(true)
    expect(isSafetyConstraint("immunity_guard")).toBe(true)
    // heuristic: a confident S3 may override
    expect(isSafetyConstraint("tempo_value")).toBe(false)
    expect(isSafetyConstraint("gameplan")).toBe(false)
    expect(isSafetyConstraint("neural_encoder")).toBe(false)
  })

  it("defaults unknown ids to S2 heuristic (never safety)", () => {
    const tag = knowledgeSourceFor("some_unregistered_scorer")
    expect(tag.source).toBe("S2_meta_rule")
    expect(tag.constraintClass).toBe("heuristic")
    expect(isSafetyConstraint("some_unregistered_scorer")).toBe(false)
  })

  it("every learned id is heuristic, never safety (S3 must remain defeasible by safety net)", () => {
    for (const [id, tag] of Object.entries(KNOWLEDGE_SOURCE_REGISTRY)) {
      if (tag.source === "S3_learned") {
        expect(tag.constraintClass, `${id} should be heuristic`).toBe("heuristic")
      }
    }
  })

  describe("confidenceGatedAlpha (P4 bootstrap→decision transition)", () => {
    it("returns minAlpha for zero / missing data (defer to S1/S2)", () => {
      expect(confidenceGatedAlpha(0)).toBeCloseTo(0.1, 6)
      expect(confidenceGatedAlpha(null)).toBeCloseTo(0.1, 6)
      expect(confidenceGatedAlpha(undefined)).toBeCloseTo(0.1, 6)
    })

    it("reaches maxAlpha at the confident sample count (S3 leads)", () => {
      expect(confidenceGatedAlpha(40000)).toBeCloseTo(0.6, 6)
      expect(confidenceGatedAlpha(100000)).toBeCloseTo(0.6, 6) // clamped
    })

    it("ramps monotonically with sample count", () => {
      const a = confidenceGatedAlpha(5000)
      const b = confidenceGatedAlpha(20000)
      const c = confidenceGatedAlpha(35000)
      expect(a).toBeLessThan(b)
      expect(b).toBeLessThan(c)
      expect(a).toBeGreaterThan(0.1)
      expect(c).toBeLessThan(0.6)
    })

    it("honours custom gate config", () => {
      const cfg = { minAlpha: 0.2, maxAlpha: 0.8, confidentSampleCount: 1000 }
      expect(confidenceGatedAlpha(0, cfg)).toBeCloseTo(0.2, 6)
      expect(confidenceGatedAlpha(1000, cfg)).toBeCloseTo(0.8, 6)
      expect(confidenceGatedAlpha(500, cfg)).toBeCloseTo(0.5, 6)
    })
  })
})
