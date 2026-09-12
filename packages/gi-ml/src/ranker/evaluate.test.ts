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
import type { SlotLinearRankerArtifact } from "./artifact.js"
import { evaluateRankingDataset } from "./evaluate.js"
import { SlotLinearRanker } from "./slot-linear-ranker.js"

test("evaluateRankingDataset reports pairwise support and top1 consistency", async () => {
  const artifact: SlotLinearRankerArtifact = {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: "artifact_eval_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    compatibility: null,
    config: {
      action_case_bias: {
        useSkill: 1,
        declareEnd: -1,
      },
    },
  }
  const dataset: MlRankingDataset = {
    dataset_id: "dataset_eval",
    created_at: "2026-03-22T00:00:00.000Z",
    metadata: null,
    query_groups: [
      {
        query_id: "q1",
        candidates: [
          {
            candidate_id: "q1:c1",
            query_id: "q1",
            action_case: "useSkill",
          },
          {
            candidate_id: "q1:c2",
            query_id: "q1",
            action_case: "declareEnd",
          },
        ],
        pairwise_preferences: [
          {
            query_id: "q1",
            candidate_a_id: "q1:c1",
            candidate_b_id: "q1:c2",
            preference_label: 1,
          },
        ],
      },
      {
        query_id: "q2",
        candidates: [
          {
            candidate_id: "q2:c1",
            query_id: "q2",
            action_case: "declareEnd",
          },
          {
            candidate_id: "q2:c2",
            query_id: "q2",
            action_case: "declareEnd",
          },
        ],
        pairwise_preferences: [],
      },
    ],
  }

  const evaluation = await evaluateRankingDataset(
    new SlotLinearRanker(artifact),
    dataset,
  )

  expect(evaluation).toMatchObject({
    dataset_id: "dataset_eval",
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: "artifact_eval_v1",
    query_count: 2,
    query_with_preferences_count: 1,
    pairwise_preference_count: 1,
    pairwise_supported_score: 1,
    pairwise_support_rate: 1,
    top1_not_contradicted_count: 1,
    top1_not_contradicted_rate: 1,
  })
  expect(evaluation.query_diagnostics[0]).toMatchObject({
    query_id: "q1",
    top_candidate_id: "q1:c1",
    pairwise_support_rate: 1,
    top1_not_contradicted: true,
  })
  expect(evaluation.query_diagnostics[1]).toMatchObject({
    query_id: "q2",
    pairwise_preference_count: 0,
    pairwise_support_rate: null,
    top1_not_contradicted: null,
  })
})
