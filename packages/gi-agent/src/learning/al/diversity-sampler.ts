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

/**
 * Diversity Sampling — feature-space coverage analysis for self-play matchups.
 *
 * Buckets collected feature vectors into a coarse grid on key dimensions
 * to identify underrepresented regions of the feature space. Matchups that
 * cover these regions receive a diversity bonus in top-up planning.
 */

import type { SampleRecord } from "../../db/data-lake.js"

/** Key feature dimensions used for coverage bucketing. */
const DIVERSITY_FEATURE_KEYS = [
  "damageEstimate",
  "reactionValue",
  "totalCost",
  "selfActiveHpRatio",
  "opponentActiveHpRatio",
  "round",
] as const

interface FeatureIndex {
  damageEstimate: number
  reactionValue: number
  totalCost: number
  selfActiveHpRatio: number
  opponentActiveHpRatio: number
  round: number
}

/**
 * Discretize a numeric value into a bucket index (0 to bucketsPerDim-1).
 */
function bucketize(value: number, min: number, max: number, bucketsPerDim: number): number {
  if (max <= min) return 0
  const clamped = Math.max(min, Math.min(max, value))
  const bucket = Math.floor(((clamped - min) / (max - min)) * bucketsPerDim)
  return Math.min(bucketsPerDim - 1, Math.max(0, bucket))
}

/**
 * Build a string key for a feature bucket (hash of discretized feature values).
 */
function bucketKey(features: FeatureIndex, ranges: Record<string, { min: number; max: number }>, bucketsPerDim: number): string {
  const parts = DIVERSITY_FEATURE_KEYS.map((key) => {
    const range = ranges[key]
    const bucket = bucketize(features[key], range.min, range.max, bucketsPerDim)
    return `${key}:${bucket}`
  })
  return parts.join("|")
}

/**
 * Extract diversity-relevant features from a SampleRecord.
 */
function extractDiversityFeatures(record: SampleRecord): FeatureIndex | null {
  const arr = record.features
  // Feature indices match the order from FeatureExtractor.featureNames()
  // We need the indices of our DIVERSITY_FEATURE_KEYS in that order
  // The indices are: damageEstimate=11, reactionValue=14, totalCost=27,
  //   selfActiveHpRatio=28, opponentActiveHpRatio=33, round=40
  if (arr.length < 41) return null
  return {
    damageEstimate: arr[11] ?? 0,
    reactionValue: arr[14] ?? 0,
    totalCost: arr[27] ?? 0,
    selfActiveHpRatio: arr[28] ?? 0,
    opponentActiveHpRatio: arr[33] ?? 0,
    round: arr[40] ?? 0,
  }
}

export interface DiversityCoverageResult {
  /** Total number of samples analyzed. */
  totalSamples: number
  /** Number of unique feature buckets covered. */
  coveredBuckets: number
  /** Map from bucket key to sample count. */
  bucketCounts: Map<string, number>
}

/**
 * Build a coverage grid from collected samples.
 *
 * Discretizes the feature space along key dimensions and counts
 * how many samples fall into each bucket.
 */
export function buildCoverageGrid(
  samples: readonly SampleRecord[],
  bucketsPerDim: number = 5,
): DiversityCoverageResult {
  // 1. Extract features and compute ranges
  const features: FeatureIndex[] = []
  const ranges: Record<string, { min: number; max: number }> = {}
  for (const key of DIVERSITY_FEATURE_KEYS) {
    ranges[key] = { min: Infinity, max: -Infinity }
  }

  for (const sample of samples) {
    const f = extractDiversityFeatures(sample)
    if (!f) continue
    features.push(f)
    for (const key of DIVERSITY_FEATURE_KEYS) {
      if (f[key] < ranges[key].min) ranges[key].min = f[key]
      if (f[key] > ranges[key].max) ranges[key].max = f[key]
    }
  }

  // 2. Bucketize
  const bucketCounts = new Map<string, number>()
  for (const f of features) {
    const key = bucketKey(f, ranges, bucketsPerDim)
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1)
  }

  return {
    totalSamples: features.length,
    coveredBuckets: bucketCounts.size,
    bucketCounts,
  }
}

/**
 * Compute a coverage score for a set of samples.
 *
 * Higher score = samples cover more underrepresented feature regions.
 * Computed as: mean(1 / bucket_density) across all samples.
 * A bucket with few samples (sparse) has low density → high inverse.
 */
export function computeCoverageScore(
  samples: readonly SampleRecord[],
  coverage: DiversityCoverageResult,
): number {
  if (samples.length === 0 || coverage.totalSamples === 0) return 0

  let totalScore = 0
  let count = 0
  const totalSamples = coverage.totalSamples

  for (const sample of samples) {
    const f = extractDiversityFeatures(sample)
    if (!f) continue

    // Recompute ranges from coverage
    const ranges: Record<string, { min: number; max: number }> = {}
    for (const key of DIVERSITY_FEATURE_KEYS) {
      ranges[key] = { min: Infinity, max: -Infinity }
    }
    // Find all non-null features and compute min/max
    const allFeatures: FeatureIndex[] = []
    for (const s of samples) {
      const sf = extractDiversityFeatures(s)
      if (sf) allFeatures.push(sf)
    }
    for (const sf of allFeatures) {
      for (const key of DIVERSITY_FEATURE_KEYS) {
        if (sf[key] < ranges[key].min) ranges[key].min = sf[key]
        if (sf[key] > ranges[key].max) ranges[key].max = sf[key]
      }
    }

    const key = bucketKey(f, ranges, 5)
    const bucketCount = coverage.bucketCounts.get(key) ?? 0
    if (bucketCount > 0) {
      // Inverse density: sparse regions get higher score
      const density = bucketCount / totalSamples
      totalScore += 1 / Math.max(density, 1 / totalSamples)
    }
    count++
  }

  return count > 0 ? totalScore / count : 0
}

/**
 * Build per-matchup diversity weights for top-up planning.
 *
 * Matchups whose samples cover underrepresented feature regions
 * get higher diversity weights (0-1 scale, normalized).
 *
 * @param matchupSamples - Map from matchup ID to its collected samples
 * @param allSamples - All samples for global coverage computation
 * @returns Map from matchup ID to diversity weight (0-1, higher = more underrepresented)
 */
export function buildDiversityTopupWeights(
  matchupSamples: Map<string, readonly SampleRecord[]>,
  allSamples: readonly SampleRecord[],
): Map<string, number> {
  const coverage = buildCoverageGrid(allSamples)
  if (coverage.totalSamples === 0) return new Map()

  const matchupScores = new Map<string, number>()
  let maxScore = 0
  for (const [matchupId, samples] of matchupSamples) {
    const score = computeCoverageScore(samples, coverage)
    matchupScores.set(matchupId, score)
    if (score > maxScore) maxScore = score
  }

  const weights = new Map<string, number>()
  for (const [matchupId, score] of matchupScores) {
    weights.set(matchupId, maxScore > 0 ? score / maxScore : 0)
  }

  return weights
}
