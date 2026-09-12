// Copyright (C) 2024-2025 Guyutongxue
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

import { expect, test } from "vitest"
import { SlotThresholdConceptValidator } from "./validator.js"

test("SlotThresholdConceptValidator promotes concepts that satisfy thresholds", async () => {
  const validator = new SlotThresholdConceptValidator({
    thresholds: {
      min_evidence_refs: 2,
    },
  })

  const result = await validator.validate({
    hypothesis: {
      concept_id: "concept:burst-window",
      name: "burst-window",
      scope: "state",
      description: "high tempo burst timing",
      evidence_refs: ["tree:1", "tree:2"],
      status: "draft",
      validation_slot: {
        required_numeric_slots: {
          "metrics.predictability": 0.7,
        },
        required_truthy_slots: ["flags.transferable"],
      },
    },
    evidence_refs: ["tree:1", "tree:2", "branch:3"],
    validation_slots: {
      metrics: {
        predictability: 0.81,
      },
      flags: {
        transferable: true,
      },
    },
  })

  expect(result.promoted).toBe(true)
  expect(result.reasons).toEqual([])
  expect(result.run.result).toBe("validated")
})

test("SlotThresholdConceptValidator holds concepts with missing support", async () => {
  const validator = new SlotThresholdConceptValidator()

  const result = await validator.validate({
    hypothesis: {
      concept_id: "concept:energy-window",
      name: "energy-window",
      scope: "window",
      description: "needs more evidence",
      evidence_refs: ["tree:1"],
      status: "draft",
      validation_slot: {
        min_evidence_refs: 2,
        maximum_numeric_slots: {
          "metrics.failure_rate": 0.2,
        },
      },
    },
    evidence_refs: ["tree:1"],
    validation_slots: {
      metrics: {
        failure_rate: 0.35,
      },
    },
  })

  expect(result.promoted).toBe(false)
  expect(result.run.result).toBe("hold")
  expect(result.reasons).toContain("evidence refs 1 below required minimum 2")
  expect(result.reasons).toContain("numeric slot metrics.failure_rate=0.35 above maximum 0.2")
})

test("SlotThresholdConceptValidator rejects deprecated concepts", async () => {
  const validator = new SlotThresholdConceptValidator()

  const result = await validator.validate({
    hypothesis: {
      concept_id: "concept:deprecated",
      name: "deprecated",
      scope: "state_action",
      description: "old concept",
      evidence_refs: ["tree:9"],
      status: "deprecated",
    },
    evidence_refs: ["tree:9"],
    validation_slots: {
      metrics: {
        predictability: 0.99,
      },
    },
  })

  expect(result.promoted).toBe(false)
  expect(result.run.result).toBe("rejected")
  expect(result.reasons).toContain("status deprecated is not eligible for validation")
})
