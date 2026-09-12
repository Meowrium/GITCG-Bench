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
import type { MlValueDataset } from "../contracts/index.js"
import { buildLinearValueArtifactFromDataset } from "./build-linear-value-artifact.js"
import { evaluateValueDataset, predictValueSample } from "./evaluate.js"

function createValueDatasetFixture(): MlValueDataset {
  return {
    dataset_id: "value_fixture",
    samples: [
      {
        sample_id: "s1",
        source: "self_play",
        state_ref: "state-1",
        target_value: 1,
        weight: 1,
        feature_slots: {
          self: { hand_count: 5, dice_count: 8 },
          opponent: { hand_count: 2, dice_count: 2 },
          derived: { self_resource_score: 7, opp_resource_score: 2 },
        },
      },
      {
        sample_id: "s2",
        source: "self_play",
        state_ref: "state-2",
        target_value: 0,
        weight: 1,
        feature_slots: {
          self: { hand_count: 1, dice_count: 1 },
          opponent: { hand_count: 4, dice_count: 7 },
          derived: { self_resource_score: 1, opp_resource_score: 6 },
        },
      },
      {
        sample_id: "s3",
        source: "self_play",
        state_ref: "state-3",
        target_value: 0.8,
        weight: 1,
        feature_slots: {
          self: { hand_count: 4, dice_count: 6 },
          opponent: { hand_count: 3, dice_count: 4 },
          derived: { self_resource_score: 5, opp_resource_score: 3 },
        },
      },
    ],
  }
}

test("buildLinearValueArtifactFromDataset derives feature weights", () => {
  const dataset = createValueDatasetFixture()
  const artifact = buildLinearValueArtifactFromDataset(dataset, {
    artifactVersion: "value_fixture_v1",
    topFeatureCount: 4,
  })

  expect(artifact.artifact_type).toBe("linear_value_baseline.v1")
  expect(artifact.artifact_version).toBe("value_fixture_v1")
  expect(Object.keys(artifact.feature_weights).length).toBeGreaterThan(0)

  const predictionA = predictValueSample(artifact, dataset.samples[0]!)
  const predictionB = predictValueSample(artifact, dataset.samples[1]!)
  expect(predictionA).toBeGreaterThan(predictionB)
})

test("evaluateValueDataset reports bounded predictions and aggregate error", () => {
  const dataset = createValueDatasetFixture()
  const artifact = buildLinearValueArtifactFromDataset(dataset, {
    artifactVersion: "value_fixture_eval_v1",
    topFeatureCount: 4,
  })

  const evaluation = evaluateValueDataset(artifact, dataset)
  expect(evaluation.dataset_id).toBe("value_fixture")
  expect(evaluation.artifact_version).toBe("value_fixture_eval_v1")
  expect(evaluation.sample_count).toBe(3)
  expect(evaluation.mae).not.toBeNull()
  expect(evaluation.rmse).not.toBeNull()
  expect(evaluation.diagnostics).toHaveLength(3)
  for (const diagnostic of evaluation.diagnostics) {
    expect(diagnostic.predicted_value).toBeGreaterThanOrEqual(0)
    expect(diagnostic.predicted_value).toBeLessThanOrEqual(1)
  }
})
