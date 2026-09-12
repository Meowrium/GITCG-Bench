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
import { mergeRankingDatasets } from "./merge.js"

test("mergeRankingDatasets merges query groups and preserves distinct groups", () => {
  const left: MlRankingDataset = {
    dataset_id: "left",
    created_at: "2026-03-23T00:00:00.000Z",
    metadata: null,
    query_groups: [
      {
        query_id: "q1",
        source: "branch_eval",
        state_ref: "state:q1",
        context_slots: {
          round: 3,
        },
        candidates: [
          {
            candidate_id: "q1:c1",
            query_id: "q1",
            action_case: "useSkill",
          },
        ],
        pairwise_preferences: [],
      },
    ],
  }

  const right: MlRankingDataset = {
    dataset_id: "right",
    created_at: "2026-03-23T00:00:00.000Z",
    metadata: null,
    query_groups: [
      {
        query_id: "q1",
        source: "branch_eval",
        state_ref: "state:q1",
        context_slots: {
          actor: 1,
        },
        candidates: [
          {
            candidate_id: "q1:c2",
            query_id: "q1",
            action_case: "playCard",
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
        source: "branch_eval",
        state_ref: "state:q2",
        candidates: [],
        pairwise_preferences: [],
      },
    ],
  }

  const merged = mergeRankingDatasets([left, right], {
    datasetId: "merged_test",
  })

  expect(merged.dataset_id).toBe("merged_test")
  expect(merged.query_groups).toHaveLength(2)
  expect(merged.query_groups[0]).toMatchObject({
    query_id: "q1",
    context_slots: {
      round: 3,
      actor: 1,
    },
  })
  expect(merged.query_groups[0]?.candidates).toHaveLength(2)
  expect(merged.query_groups[0]?.pairwise_preferences).toHaveLength(1)
})
