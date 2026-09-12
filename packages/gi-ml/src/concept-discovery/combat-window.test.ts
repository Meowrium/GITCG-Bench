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
import {
  extractConceptHypothesesFromCombatWindow,
  type CombatWindowConceptSourceLike,
} from "./combat-window.js"

test("extractConceptHypothesesFromCombatWindow exports plan, node, and claim concepts", () => {
  const source: CombatWindowConceptSourceLike = {
    tree_id: "tree_123",
    source_window: {
      window_id: "window_1",
      global_goal: "Burst through the opening window.",
      tags: ["useSkill", "playCard"],
    },
    analysis: {
      analysis_meta: {
        created_at: "2026-03-20T12:00:00.000Z",
      },
      source_context: {
        window_id: "window_1",
        session_id: "sess_valid",
        matchup_id: "ShuiNing-mirror",
        deck_fingerprint_self: "1411-1510-2102",
      },
      combat_window_plan: {
        window_id: "window_1",
        entry_conditions: ["pending_method=action", "round=2"],
        success_conditions: ["window_goal_reached"],
        fail_conditions: ["self.active_hp<=2"],
        entry_node_id: "node_setup",
        nodes: [
          {
            id: "node_setup",
            kind: "setup",
            intent: "Prepare burst threshold",
            expected_action_case: ["useSkill"],
            when: ["round=2"],
            must_do: ["gain energy"],
            avoid: ["declareEnd"],
            prefer_tags: ["reaction"],
          },
          {
            id: "node_convert",
            kind: "convert",
            intent: "Convert setup into lethal push",
            expected_action_case: ["playCard"],
            when: ["actions_taken>=2"],
            must_do: ["apply burst card"],
            avoid: [],
            prefer_tags: ["burst"],
          },
        ],
      },
      candidate_review: {
        preferred_line_tags: ["reaction", "burst"],
        rejected_patterns: ["end_turn"],
        key_branch_claims: [
          {
            claim: "Holding the burst card until the second action improves closure.",
            evidence_type: "heuristic",
            needs_branch_eval: true,
          },
        ],
      },
      outcome_assessment: {
        local_result: "good",
        why: ["Reached burst threshold", "Maintained tempo"],
        reusable: true,
        reuse_scope: "same_deck_broad",
      },
      quality: {
        llm_confidence: 0.74,
        generalization_confidence: 0.51,
        risk_flags: ["needs_branch_eval"],
      },
    },
  }

  const concepts = extractConceptHypothesesFromCombatWindow(source)

  expect(concepts).toHaveLength(6)
  expect(concepts[0]).toMatchObject({
    scope: "window",
    status: "draft",
    source: "combat_window",
  })
  expect(concepts[0]?.tags).toContain("same_deck_broad")
  expect(concepts[1]?.tags).toContain("setup")
  expect(concepts[1]?.estimator_slot).toMatchObject({
    all_of: [
      {
        action_case: "useSkill",
      },
      {
        candidate_tag: "reaction",
      },
    ],
  })
  expect(concepts[2]?.tags).toContain("convert")
  expect(concepts[3]).toMatchObject({
    scope: "window",
  })
  expect(concepts[3]?.tags).toContain("multi_step")
  expect(concepts[3]?.tags).toContain("sequence")
  expect(concepts[4]).toMatchObject({
    name: "transition-setup-to-convert",
    scope: "window",
  })
  expect(concepts[4]?.tags).toContain("combat_window_transition")
  expect(concepts[5]).toMatchObject({
    name: "claim-heuristic-0",
  })
  expect(concepts[5]?.tags).toContain("needs_branch_eval")
  expect(concepts[5]?.evidence_refs).toContain("tree:tree_123")
})
