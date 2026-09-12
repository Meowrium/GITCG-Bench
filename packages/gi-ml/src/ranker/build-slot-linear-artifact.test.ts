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
import { buildSlotLinearArtifactFromDataset } from "./build-slot-linear-artifact.js"

test("buildSlotLinearArtifactFromDataset derives action case and tag bias from pairwise outcomes", () => {
  const dataset: MlRankingDataset = {
    dataset_id: "dataset_1",
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
            runtime_slots: {
              candidate_tags: ["burst"],
              candidate_numeric_slots: {
                healingEstimate: 2,
                totalCost: 2,
              },
            },
          },
          {
            candidate_id: "q1:c2",
            query_id: "q1",
            action_case: "playCard",
            runtime_slots: {
              candidate_tags: ["draw"],
              candidate_numeric_slots: {
                healingEstimate: 0,
                totalCost: 4,
              },
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "q1",
            candidate_a_id: "q1:c1",
            candidate_b_id: "q1:c2",
            preference_label: 1,
            confidence: 0.8,
          },
        ],
      },
      {
        query_id: "q2",
        candidates: [
          {
            candidate_id: "q2:c1",
            query_id: "q2",
            action_case: "useSkill",
            runtime_slots: {
              candidate_tags: ["burst"],
              candidate_numeric_slots: {
                healingEstimate: 1,
                totalCost: 1,
              },
            },
          },
          {
            candidate_id: "q2:c2",
            query_id: "q2",
            action_case: "declareEnd",
            runtime_slots: {
              candidate_tags: ["end_turn"],
              candidate_numeric_slots: {
                healingEstimate: 0,
                totalCost: 0,
              },
            },
          },
        ],
        pairwise_preferences: [
          {
            query_id: "q2",
            candidate_a_id: "q2:c1",
            candidate_b_id: "q2:c2",
            preference_label: 1,
            confidence: 1,
          },
        ],
      },
    ],
  }

  const artifact = buildSlotLinearArtifactFromDataset(dataset, {
    artifactVersion: "artifact_v1",
  })

  expect(artifact.artifact_type).toBe("slot_linear_ranker.v1")
  expect(artifact.artifact_version).toBe("artifact_v1")
  expect((artifact.config.action_case_bias?.useSkill ?? 0)).toBeGreaterThan(0)
  expect((artifact.config.action_case_bias?.declareEnd ?? 0)).toBeLessThan(0)
  expect((artifact.config.candidate_tag_bias?.burst ?? 0)).toBeGreaterThan(0)
  expect((artifact.config.candidate_tag_bias?.end_turn ?? 0)).toBeLessThan(0)
  expect(
    (artifact.config.candidate_numeric_slot_weights?.["candidate_numeric_slots.healingEstimate"] ?? 0),
  ).toBeGreaterThan(0)
  expect(
    (artifact.config.candidate_numeric_slot_weights?.["candidate_numeric_slots.totalCost"] ?? 0),
  ).toBeLessThan(0)
})

test("buildSlotLinearArtifactFromDataset falls back to continuation scores when pairwise preferences are absent", () => {
  const dataset: MlRankingDataset = {
    dataset_id: "dataset_2",
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
            runtime_slots: {
              candidate_tags: ["burst"],
              candidate_numeric_slots: {
                healingEstimate: 2,
              },
              continuation: {
                score: 0.5,
              },
            },
          },
          {
            candidate_id: "q1:c2",
            query_id: "q1",
            action_case: "declareEnd",
            runtime_slots: {
              candidate_tags: ["end_turn"],
              candidate_numeric_slots: {
                healingEstimate: 0,
              },
              continuation: {
                score: 0,
              },
            },
          },
        ],
        pairwise_preferences: [],
      },
    ],
  }

  const artifact = buildSlotLinearArtifactFromDataset(dataset)

  expect((artifact.config.action_case_bias?.useSkill ?? 0)).toBeGreaterThan(0)
  expect((artifact.config.action_case_bias?.declareEnd ?? 0)).toBeLessThan(0)
  expect((artifact.config.candidate_tag_bias?.burst ?? 0)).toBeGreaterThan(0)
  expect((artifact.config.candidate_tag_bias?.end_turn ?? 0)).toBeLessThan(0)
  expect(
    (artifact.config.candidate_numeric_slot_weights?.["candidate_numeric_slots.healingEstimate"] ?? 0),
  ).toBeGreaterThan(0)
})
