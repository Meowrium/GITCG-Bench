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
import type { MlRankingDataset } from "../contracts/index.js"
import { extractComboConceptHypothesesFromBranchEvalDataset } from "./branch-eval-combo.js"

test("extractComboConceptHypothesesFromBranchEvalDataset discovers adjacent two-step combos", () => {
  const dataset: MlRankingDataset = {
    dataset_id: "dataset_branch_eval_combo",
    created_at: "2026-03-23T00:00:00.000Z",
    metadata: null,
    query_groups: [
      {
        query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
        source: "branch_eval",
        state_ref: "state:q0",
        context_slots: {
          policy_selected_action_index: 1,
          policy_selected_action_type: "elementalTuning",
        },
        candidates: [
          {
            candidate_id: "q0:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
            action_case: "elementalTuning",
            branch_eval_ref: "branch:q0:c1",
            runtime_slots: {
              branch_action_index: 1,
              action_definition_kind: "card",
              card_definition_id: 215001,
              actor_character_definition_id: 1411,
              candidate_tags: ["dice_fix"],
            },
          },
          {
            candidate_id: "q0:c2",
            query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
            action_case: "declareEnd",
            branch_eval_ref: "branch:q0:c2",
            runtime_slots: {
              branch_action_index: 2,
              action_definition_kind: "none",
              actor_character_definition_id: 1411,
              candidate_tags: ["end_turn"],
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_10:point_0",
            candidate_a_id: "q0:c1",
            candidate_b_id: "q0:c2",
            preference_label: 1,
            confidence: 0.8,
            evidence_ref: "pref:q0",
          },
        ],
      },
      {
        query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_11:point_1",
        source: "branch_eval",
        state_ref: "state:q1",
        context_slots: {
          policy_selected_action_index: 3,
          policy_selected_action_type: "useSkill",
        },
        candidates: [
          {
            candidate_id: "q1:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_11:point_1",
            action_case: "useSkill",
            branch_eval_ref: "branch:q1:c1",
            runtime_slots: {
              branch_action_index: 3,
              action_definition_kind: "skill",
              skill_definition_id: 2102,
              actor_character_definition_id: 1411,
              candidate_tags: ["energy"],
            },
          },
        ],
        pairwise_preferences: [],
      },
      {
        query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_12:point_4",
        source: "branch_eval",
        state_ref: "state:q1b",
        context_slots: {
          policy_selected_action_index: 5,
          policy_selected_action_type: "useSkill",
        },
        candidates: [
          {
            candidate_id: "q1b:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0001-p0.json:entry_12:point_4",
            action_case: "useSkill",
            branch_eval_ref: "branch:q1b:c1",
            runtime_slots: {
              branch_action_index: 5,
              action_definition_kind: "skill",
              skill_definition_id: 2103,
              actor_character_definition_id: 1411,
              candidate_tags: ["burst"],
            },
          },
        ],
        pairwise_preferences: [],
      },
      {
        query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_12:point_0",
        source: "branch_eval",
        state_ref: "state:q2",
        context_slots: {
          policy_selected_action_index: 1,
          policy_selected_action_type: "elementalTuning",
        },
        candidates: [
          {
            candidate_id: "q2:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_12:point_0",
            action_case: "elementalTuning",
            branch_eval_ref: "branch:q2:c1",
            runtime_slots: {
              branch_action_index: 1,
              action_definition_kind: "card",
              card_definition_id: 215001,
              actor_character_definition_id: 1411,
              candidate_tags: ["dice_fix"],
            },
          },
          {
            candidate_id: "q2:c2",
            query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_12:point_0",
            action_case: "switchActive",
            branch_eval_ref: "branch:q2:c2",
            runtime_slots: {
              branch_action_index: 2,
              action_definition_kind: "character",
              character_definition_id: 1205,
              actor_character_definition_id: 1411,
              candidate_tags: ["pivot"],
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_12:point_0",
            candidate_a_id: "q2:c1",
            candidate_b_id: "q2:c2",
            preference_label: 1,
            confidence: 0.6,
            evidence_ref: "pref:q2",
          },
        ],
      },
      {
        query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_13:point_1",
        source: "branch_eval",
        state_ref: "state:q3",
        context_slots: {
          policy_selected_action_index: 4,
          policy_selected_action_type: "useSkill",
        },
        candidates: [
          {
            candidate_id: "q3:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_13:point_1",
            action_case: "useSkill",
            branch_eval_ref: "branch:q3:c1",
            runtime_slots: {
              branch_action_index: 4,
              action_definition_kind: "skill",
              skill_definition_id: 2102,
              actor_character_definition_id: 1411,
              candidate_tags: ["energy"],
            },
          },
        ],
        pairwise_preferences: [],
      },
      {
        query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_14:point_3",
        source: "branch_eval",
        state_ref: "state:q3b",
        context_slots: {
          policy_selected_action_index: 6,
          policy_selected_action_type: "useSkill",
        },
        candidates: [
          {
            candidate_id: "q3b:c1",
            query_id: "branch_eval:PyroKe-mirror:game-0002-p0.json:entry_14:point_3",
            action_case: "useSkill",
            branch_eval_ref: "branch:q3b:c1",
            runtime_slots: {
              branch_action_index: 6,
              action_definition_kind: "skill",
              skill_definition_id: 2103,
              actor_character_definition_id: 1411,
              candidate_tags: ["burst"],
            },
          },
        ],
        pairwise_preferences: [],
      },
    ],
  }

  const concepts = extractComboConceptHypothesesFromBranchEvalDataset(dataset, {
    minSupport: 2,
    minMeanConfidence: 0.2,
    maxPointGap: 4,
    minComboSteps: 3,
    maxComboSteps: 3,
  })

  expect(concepts).toHaveLength(1)
  expect(concepts[0]).toMatchObject({
    scope: "state_action",
    source: "branch_eval",
    estimator_slot: {
      kind: "combo_pattern.v1",
      in_order: [
        {
          all_of: [
            { action_case: "elementalTuning" },
            { action_definition_kind: "card" },
            { card_definition_id: 215001 },
            { actor_character_definition_id: 1411 },
            { candidate_tag: "dice_fix" },
          ],
        },
        {
          all_of: [
            { action_case: "useSkill" },
            { action_definition_kind: "skill" },
            { skill_definition_id: 2102 },
            { actor_character_definition_id: 1411 },
            { candidate_tag: "energy" },
          ],
        },
        {
          all_of: [
            { action_case: "useSkill" },
            { action_definition_kind: "skill" },
            { skill_definition_id: 2103 },
            { actor_character_definition_id: 1411 },
            { candidate_tag: "burst" },
          ],
        },
      ],
      max_step_gap: 4,
    },
  })
  expect(concepts[0]?.validation_slot).toMatchObject({
    support_count: 2,
    sequence_length: 3,
    max_point_gap: 4,
    discovery_method: "branch_eval_window_combo.v2",
  })
})
