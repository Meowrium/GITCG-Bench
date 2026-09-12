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

import type { JsonValue, MlValueDataset } from "../contracts/index.js"
import type { LinearValueArtifact } from "./artifact.js"

export interface BuildLinearValueArtifactOptions {
  artifactVersion?: string
  topFeatureCount?: number
}

interface WeightedStats {
  count: number
  sumWeight: number
  sumValue: number
  sumTarget: number
  sumValueSq: number
  sumValueTarget: number
}

export function buildLinearValueArtifactFromDataset(
  dataset: MlValueDataset,
  options: BuildLinearValueArtifactOptions = {},
): LinearValueArtifact {
  const stats = new Map<string, WeightedStats>()
  let totalWeight = 0
  let weightedTargetSum = 0
  const featureMeans = new Map<string, number>()

  for (const sample of dataset.samples) {
    const weight = sample.weight ?? 1
    totalWeight += weight
    weightedTargetSum += sample.target_value * weight
    const flattened = flattenNumericRecord(sample.feature_slots ?? {})
    for (const [path, value] of Object.entries(flattened)) {
      updateStats(stats, path, value, sample.target_value, weight)
    }
  }

  const meanTarget = totalWeight > 0 ? weightedTargetSum / totalWeight : 0
  const rankedWeights = [...stats.entries()]
    .map(([path, stat]) => {
      const meanValue = stat.sumValue / stat.sumWeight
      const meanTargetForFeature = stat.sumTarget / stat.sumWeight
      const variance = stat.sumValueSq / stat.sumWeight - meanValue * meanValue
      if (variance <= 0) {
        return null
      }
      const covariance =
        stat.sumValueTarget / stat.sumWeight - meanValue * meanTargetForFeature
      const weight = covariance / variance
      if (!Number.isFinite(weight) || weight === 0) {
        return null
      }
      featureMeans.set(path, meanValue)
      return { path, weight, support: stat.sumWeight }
    })
    .filter((entry): entry is { path: string; weight: number; support: number } => entry != null)
    .sort((left, right) => {
      const absDiff = Math.abs(right.weight) - Math.abs(left.weight)
      if (absDiff !== 0) {
        return absDiff
      }
      return right.support - left.support
    })
    .slice(0, options.topFeatureCount ?? 32)

  const featureWeights = Object.fromEntries(
    rankedWeights.map((entry) => [entry.path, entry.weight]),
  )
  const bias = rankedWeights.reduce(
    (acc, entry) => acc - entry.weight * (featureMeans.get(entry.path) ?? 0),
    meanTarget,
  )

  return {
    artifact_type: "linear_value_baseline.v1",
    artifact_version: options.artifactVersion ?? `dataset_${dataset.dataset_id}`,
    created_at: new Date().toISOString(),
    bias,
    feature_weights: featureWeights,
    metadata: {
      dataset_id: dataset.dataset_id,
      sample_count: dataset.samples.length,
    },
  }
}

function updateStats(
  stats: Map<string, WeightedStats>,
  path: string,
  value: number,
  target: number,
  weight: number,
) {
  const entry = stats.get(path) ?? {
    count: 0,
    sumWeight: 0,
    sumValue: 0,
    sumTarget: 0,
    sumValueSq: 0,
    sumValueTarget: 0,
  }
  entry.count += 1
  entry.sumWeight += weight
  entry.sumValue += value * weight
  entry.sumTarget += target * weight
  entry.sumValueSq += value * value * weight
  entry.sumValueTarget += value * target * weight
  stats.set(path, entry)
}

