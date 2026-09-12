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
import type { GbdtValueArtifact, MlpValueArtifact } from "./nonlinear-artifacts.js"
import { predictGbdtValue, predictMlpValue } from "./nonlinear-artifacts.js"

export interface NonlinearValueSampleDiagnostic {
  sample_id: string
  target_value: number
  predicted_value: number
  absolute_error: number
  squared_error: number
}

export interface NonlinearValueDatasetEvaluation {
  dataset_id: string
  artifact_type: string
  artifact_version: string
  sample_count: number
  mae: number | null
  mse: number | null
  rmse: number | null
  mean_prediction: number | null
  mean_target: number | null
  diagnostics: NonlinearValueSampleDiagnostic[]
}

export function evaluateGbdtValueDataset(
  artifact: GbdtValueArtifact,
  dataset: MlValueDataset,
): NonlinearValueDatasetEvaluation {
  const diagnostics = dataset.samples.map((sample) => {
    const features = flattenNumericRecord(
      (sample.feature_slots ?? {}) as Record<string, JsonValue>,
    )
    const predicted = predictGbdtValue(artifact, features)
    const absoluteError = Math.abs(predicted - sample.target_value)
    return {
      sample_id: sample.sample_id,
      target_value: sample.target_value,
      predicted_value: predicted,
      absolute_error: absoluteError,
      squared_error: absoluteError * absoluteError,
    }
  })

  return buildEvaluation(artifact.artifact_type, artifact.artifact_version, dataset, diagnostics)
}

export function evaluateMlpValueDataset(
  artifact: MlpValueArtifact,
  dataset: MlValueDataset,
): NonlinearValueDatasetEvaluation {
  const diagnostics = dataset.samples.map((sample) => {
    const features = flattenNumericRecord(
      (sample.feature_slots ?? {}) as Record<string, JsonValue>,
    )
    const predicted = predictMlpValue(artifact, features)
    const absoluteError = Math.abs(predicted - sample.target_value)
    return {
      sample_id: sample.sample_id,
      target_value: sample.target_value,
      predicted_value: predicted,
      absolute_error: absoluteError,
      squared_error: absoluteError * absoluteError,
    }
  })

  return buildEvaluation(artifact.artifact_type, artifact.artifact_version, dataset, diagnostics)
}

function buildEvaluation(
  artifactType: string,
  artifactVersion: string,
  dataset: MlValueDataset,
  diagnostics: NonlinearValueSampleDiagnostic[],
): NonlinearValueDatasetEvaluation {
  const count = diagnostics.length
  const mae = count > 0
    ? diagnostics.reduce((s, d) => s + d.absolute_error, 0) / count
    : null
  const mse = count > 0
    ? diagnostics.reduce((s, d) => s + d.squared_error, 0) / count
    : null
  const meanPrediction = count > 0
    ? diagnostics.reduce((s, d) => s + d.predicted_value, 0) / count
    : null
  const meanTarget = count > 0
    ? diagnostics.reduce((s, d) => s + d.target_value, 0) / count
    : null

  return {
    dataset_id: dataset.dataset_id,
    artifact_type: artifactType,
    artifact_version: artifactVersion,
    sample_count: count,
    mae,
    mse,
    rmse: mse == null ? null : Math.sqrt(mse),
    mean_prediction: meanPrediction,
    mean_target: meanTarget,
    diagnostics,
  }
}

