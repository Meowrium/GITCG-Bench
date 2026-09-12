import { flattenNumericRecord } from "../utils/flatten.js"
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

import type { JsonValue, MlValueDataset, MlValueSample } from "../contracts/index.js"
import type { LinearValueArtifact } from "./artifact.js"

export interface ValueSampleDiagnostic {
  sample_id: string
  target_value: number
  predicted_value: number
  absolute_error: number
  squared_error: number
}

export interface ValueDatasetEvaluation {
  dataset_id: string
  artifact_type: string
  artifact_version: string
  sample_count: number
  mae: number | null
  mse: number | null
  rmse: number | null
  mean_prediction: number | null
  mean_target: number | null
  diagnostics: ValueSampleDiagnostic[]
}

export function evaluateValueDataset(
  artifact: LinearValueArtifact,
  dataset: MlValueDataset,
): ValueDatasetEvaluation {
  const diagnostics = dataset.samples.map((sample) => evaluateSample(artifact, sample))
  const count = diagnostics.length
  const mae = average(diagnostics.map((item) => item.absolute_error))
  const mse = average(diagnostics.map((item) => item.squared_error))
  const meanPrediction = average(diagnostics.map((item) => item.predicted_value))
  const meanTarget = average(diagnostics.map((item) => item.target_value))

  return {
    dataset_id: dataset.dataset_id,
    artifact_type: artifact.artifact_type,
    artifact_version: artifact.artifact_version,
    sample_count: count,
    mae,
    mse,
    rmse: mse == null ? null : Math.sqrt(mse),
    mean_prediction: meanPrediction,
    mean_target: meanTarget,
    diagnostics,
  }
}

export function predictValueSample(
  artifact: LinearValueArtifact,
  sample: MlValueSample,
): number {
  const flattened = flattenNumericRecord((sample.feature_slots ?? {}) as Record<string, JsonValue>)
  let score = artifact.bias
  for (const [path, weight] of Object.entries(artifact.feature_weights)) {
    score += (flattened[path] ?? 0) * weight
  }
  return clamp(score, 0, 1)
}

function evaluateSample(
  artifact: LinearValueArtifact,
  sample: MlValueSample,
): ValueSampleDiagnostic {
  const predicted = predictValueSample(artifact, sample)
  const absoluteError = Math.abs(predicted - sample.target_value)
  const squaredError = absoluteError * absoluteError
  return {
    sample_id: sample.sample_id,
    target_value: sample.target_value,
    predicted_value: predicted,
    absolute_error: absoluteError,
    squared_error: squaredError,
  }
}


function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
