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
import { extractConceptHypothesesFromBranchEvalDataset } from "./branch-eval.js"

test("extractConceptHypothesesFromBranchEvalDataset discovers preferred action and tag patterns", () => {
  const dataset: MlRankingDataset = {
    dataset_id: "dataset_branch_eval_concepts",
    created_at: "2026-03-22T00:00:00.000Z",
    metadata: null,
    query_groups: [
      {
        query_id: "q1",
        source: "branch_eval",
        state_ref: "state:q1",
        candidates: [
          {
            candidate_id: "q1:c1",
            query_id: "q1",
            action_case: "useSkill",
            branch_eval_ref: "branch:q1:c1",
            runtime_slots: {
              candidate_tags: ["burst"],
              action_definition_kind: "skill",
              skill_definition_id: 2102,
              actor_character_definition_id: 1411,
              continuation: { score: 0.8 },
            },
          },
          {
            candidate_id: "q1:c2",
            query_id: "q1",
            action_case: "declareEnd",
            branch_eval_ref: "branch:q1:c2",
            runtime_slots: {
              candidate_tags: ["end_turn"],
              action_definition_kind: "none",
              actor_character_definition_id: 1411,
              continuation: { score: 0.1 },
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "q1",
            candidate_a_id: "q1:c1",
            candidate_b_id: "q1:c2",
            preference_label: 1,
            confidence: 0.7,
            evidence_ref: "pref:q1",
          },
        ],
      },
      {
        query_id: "q2",
        source: "branch_eval",
        state_ref: "state:q2",
        candidates: [
          {
            candidate_id: "q2:c1",
            query_id: "q2",
            action_case: "useSkill",
            branch_eval_ref: "branch:q2:c1",
            runtime_slots: {
              candidate_tags: ["burst"],
              action_definition_kind: "skill",
              skill_definition_id: 2102,
              actor_character_definition_id: 1411,
              continuation: { score: 0.75 },
            },
          },
          {
            candidate_id: "q2:c2",
            query_id: "q2",
            action_case: "switchActive",
            branch_eval_ref: "branch:q2:c2",
            runtime_slots: {
              candidate_tags: ["pivot"],
              action_definition_kind: "character",
              character_definition_id: 1205,
              actor_character_definition_id: 1411,
              continuation: { score: 0.2 },
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "q2",
            candidate_a_id: "q2:c1",
            candidate_b_id: "q2:c2",
            preference_label: 1,
            confidence: 0.55,
            evidence_ref: "pref:q2",
          },
        ],
      },
    ],
  }

  const concepts = extractConceptHypothesesFromBranchEvalDataset(dataset, {
    minSupport: 2,
    minMeanConfidence: 0.2,
  })

  expect(concepts.map((concept) => concept.concept_id)).toContain(
    "concept:branch-eval:action-case:useskill",
  )
  expect(concepts.map((concept) => concept.concept_id)).toContain(
    "concept:branch-eval:candidate-tag:burst",
  )
  expect(concepts.map((concept) => concept.concept_id)).toContain(
    "concept:branch-eval:action-tag:useskill-burst",
  )
  expect(concepts.map((concept) => concept.concept_id)).toContain(
    "concept:branch-eval:skill-definition:2102",
  )
  expect(concepts.map((concept) => concept.concept_id)).toContain(
    "concept:branch-eval:action-entity:useskill-skill-2102",
  )

  const combined = concepts.find((concept) =>
    concept.concept_id === "concept:branch-eval:action-tag:useskill-burst",
  )
  expect(combined).toMatchObject({
    scope: "state_action",
    source: "branch_eval",
    estimator_slot: {
      all_of: [
        {
          action_case: "useSkill",
        },
        {
          candidate_tag: "burst",
        },
      ],
    },
  })
  expect(combined?.validation_slot).toMatchObject({
    support_count: 2,
  })

  const actionEntity = concepts.find((concept) =>
    concept.concept_id === "concept:branch-eval:action-entity:useskill-skill-2102",
  )
  expect(actionEntity?.estimator_slot).toMatchObject({
    all_of: [
      { action_case: "useSkill" },
      { action_definition_kind: "skill" },
      { skill_definition_id: 2102 },
    ],
  })
})
