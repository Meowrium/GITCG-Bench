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
import type { MlConceptHypothesis } from "../contracts/index.js"
import { mergeConceptHypotheses } from "./merge.js"

test("mergeConceptHypotheses merges duplicate concepts conservatively", () => {
  const concepts: MlConceptHypothesis[] = [
    {
      concept_id: "concept:x",
      name: "branch-eval-x",
      scope: "state_action",
      description: "branch-eval version",
      evidence_refs: ["branch:1"],
      tags: ["branch_eval"],
      estimator_slot: {
        action_case: "useSkill",
      },
      validation_slot: {
        support_count: 3,
      },
      status: "draft",
      source: "branch_eval",
      created_at: "2026-03-22T00:00:00.000Z",
      updated_at: "2026-03-22T00:00:00.000Z",
    },
    {
      concept_id: "concept:x",
      name: "combat-window-x",
      scope: "state_action",
      description: "combat-window version",
      evidence_refs: ["combat:1"],
      tags: ["combat_window"],
      estimator_slot: {
        all_of: [
          { action_case: "useSkill" },
          { candidate_tag: "burst" },
        ],
      },
      validation_slot: {
        reusable: true,
      },
      status: "validated",
      source: "combat_window",
      created_at: "2026-03-21T00:00:00.000Z",
      updated_at: "2026-03-23T00:00:00.000Z",
    },
  ]

  const [merged] = mergeConceptHypotheses(concepts)
  expect(merged).toMatchObject({
    concept_id: "concept:x",
    name: "combat-window-x",
    status: "validated",
    source: "combat_window",
    estimator_slot: {
      all_of: [
        { action_case: "useSkill" },
        { candidate_tag: "burst" },
      ],
    },
  })
  expect(merged?.evidence_refs).toEqual(["branch:1", "combat:1"])
  expect(merged?.tags).toEqual(["branch_eval", "combat_window"])
  expect(merged?.validation_slot).toMatchObject({
    support_count: 3,
    reusable: true,
  })
})
