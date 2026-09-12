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
// License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { expect, test } from "vitest"
import type { CombatWindowConceptSourceLike } from "./combat-window.js"
import { extractComboConceptHypothesesFromCombatWindow } from "./combo-window.js"

test("extractComboConceptHypothesesFromCombatWindow exports two-step combo patterns", () => {
  const source: CombatWindowConceptSourceLike = {
    tree_id: "tree_combo",
    source_window: {
      window_id: "window_combo",
      global_goal: "Prepare and cash out burst.",
      tags: ["setup", "burst"],
    },
    analysis: {
      analysis_meta: {
        created_at: "2026-03-23T10:00:00.000Z",
      },
      source_context: {
        window_id: "window_combo",
        session_id: "sess_combo",
        matchup_id: "PyroKe-mirror",
        deck_fingerprint_self: "pyroke",
      },
      combat_window_plan: {
        window_id: "window_combo",
        entry_conditions: ["round=3"],
        success_conditions: ["burst_ready"],
        fail_conditions: ["dies"],
        entry_node_id: "node_setup",
        nodes: [
          {
            id: "node_setup",
            kind: "setup",
            intent: "Fix dice and enable burst",
            expected_action_case: ["elementalTuning"],
            when: [],
            must_do: [],
            avoid: [],
            prefer_tags: ["dice_fix"],
          },
          {
            id: "node_burst",
            kind: "burst",
            intent: "Spend the setup on direct pressure",
            expected_action_case: ["useSkill"],
            when: [],
            must_do: [],
            avoid: [],
            prefer_tags: ["energy"],
          },
        ],
      },
      candidate_review: {
        preferred_line_tags: ["dice_fix", "energy"],
        rejected_patterns: [],
        key_branch_claims: [],
      },
      outcome_assessment: {
        local_result: "good",
        why: ["burst closes the race"],
        reusable: true,
        reuse_scope: "same_deck_broad",
      },
      quality: {
        llm_confidence: 0.8,
        generalization_confidence: 0.6,
        risk_flags: [],
      },
    },
  }

  const concepts = extractComboConceptHypothesesFromCombatWindow(source)

  expect(concepts).toHaveLength(1)
  expect(concepts[0]).toMatchObject({
    name: "combo-setup-to-burst",
    scope: "window",
    source: "combat_window",
  })
  expect(concepts[0]?.tags).toContain("combat_window_combo")
  expect(concepts[0]?.tags).toContain("multi_step")
  expect(concepts[0]?.estimator_slot).toEqual({
    kind: "combo_pattern.v1",
    in_order: [
      {
        all_of: [
          { action_case: "elementalTuning" },
          { candidate_tag: "dice_fix" },
        ],
      },
      {
        all_of: [
          { action_case: "useSkill" },
          { candidate_tag: "energy" },
        ],
      },
    ],
    max_step_gap: 1,
  })
})
