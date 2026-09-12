// Copyright (C) 2025 Guyutongxue
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
 * Grouped Bootstrap CI Reporter
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md §4:
 *   "报告 1,000 次 grouped bootstrap（按 lineage 重采样）的 95% CI，
 *    比较模型时报告分项 delta 与 CI"
 *
 * The bootstrap resampling unit is the lineage group (not individual samples),
 * to prevent near-duplicate variants from inflating the effective sample size.
 */

import type { ScoreResult } from "./scorer"

// ─── Types ────────────────────────────────────────────────────────────────

export interface BootstrapConfig {
  /** Number of bootstrap iterations (default 1000) */
  iterations: number
  /** Confidence level (default 0.95) */
  confidenceLevel: number
  /** Random seed (default 42) */
  seed: number
}

export interface BootstrapCI {
  /** Point estimate (mean) */
  mean: number
  /** Lower bound of CI */
  lower: number
  /** Upper bound of CI */
  upper: number
  /** Standard deviation of bootstrap distribution */
  stdDev: number
  /** Confidence level used */
  confidenceLevel: number
}

export interface BootstrapReport {
  total: BootstrapCI
  byCategory: Record<string, BootstrapCI>
  config: BootstrapConfig
  numLineageGroups: number
  numSamples: number
}

export interface ComparisonReport {
  modelA: string
  modelB: string
  /** Delta = modelA.mean - modelB.mean */
  delta: number
  /** CI for the delta */
  deltaCI: BootstrapCI
  /** Per-category deltas */
  byCategoryDelta: Record<string, { delta: number; ci: BootstrapCI }>
  /** Whether the CI lower bound is > 0 (A significantly better) */
  aSignificantlyBetter: boolean
}

// ─── Random number generator (seeded) ──────────────────────────────────────

class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  next(): number {
    // Mulberry32 PRNG
    this.state |= 0
    this.state = (this.state + 0x6d2b79f5) | 0
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Pick a random integer in [0, n) */
  nextInt(n: number): number {
    return Math.floor(this.next() * n)
  }
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────

/**
 * Compute percentile-based confidence interval from bootstrap samples.
 */
function percentileCI(
  samples: number[],
  confidenceLevel: number,
): { lower: number; upper: number } {
  if (samples.length === 0) return { lower: 0, upper: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const alpha = 1 - confidenceLevel
  const lowerIdx = Math.floor((alpha / 2) * sorted.length)
  const upperIdx = Math.floor((1 - alpha / 2) * sorted.length)
  return {
    lower: sorted[lowerIdx]!,
    upper: sorted[Math.min(upperIdx, sorted.length - 1)]!,
  }
}

/**
 * Compute mean and standard deviation of an array.
 */
function stats(arr: number[]): { mean: number; stdDev: number } {
  if (arr.length === 0) return { mean: 0, stdDev: 0 }
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length
  return { mean, stdDev: Math.sqrt(variance) }
}

/**
 * Group scores by lineage.
 */
function groupByLineage(results: ScoreResult[]): Map<string, ScoreResult[]> {
  const groups = new Map<string, ScoreResult[]>()
  for (const r of results) {
    const lineage = r.variantInfo?.lineage ?? "no_lineage"
    const list = groups.get(lineage) ?? []
    list.push(r)
    groups.set(lineage, list)
  }
  return groups
}

/**
 * Compute a single bootstrap sample: resample lineage groups with replacement,
 * average within each group, then macro-average across groups.
 */
function bootstrapSample(
  groups: Map<string, ScoreResult[]>,
  rng: SeededRandom,
): { total: number; byCategory: Record<string, number> } {
  const groupKeys = [...groups.keys()]
  const numGroups = groupKeys.length
  if (numGroups === 0) return { total: 0, byCategory: {} }

  let totalSum = 0
  const categorySums: Record<string, number> = {}
  let categoryCount = 0

  for (let i = 0; i < numGroups; i++) {
    // Resample: pick a random group
    const key = groupKeys[rng.nextInt(numGroups)]!
    const group = groups.get(key)!
    // Average within the group
    const groupAvg = group.reduce((s, r) => s + r.total, 0) / group.length
    totalSum += groupAvg

    for (const sub of group[0]!.subscores) {
      if (!categorySums[sub.category]) {
        categorySums[sub.category] = 0
        categoryCount++
      }
      const subAvg = group.reduce((s, r) => {
        const match = r.subscores.find((x) => x.category === sub.category)
        return s + (match?.score ?? 0)
      }, 0) / group.length
      categorySums[sub.category]! += subAvg
    }
  }

  const total = totalSum / numGroups
  const byCategory: Record<string, number> = {}
  for (const [cat, sum] of Object.entries(categorySums)) {
    byCategory[cat] = sum / numGroups
  }

  return { total, byCategory }
}

/**
 * Run grouped bootstrap and compute confidence intervals.
 *
 * @param results  Score results for one model
 * @param config   Bootstrap configuration
 */
export function runBootstrap(
  results: ScoreResult[],
  config?: Partial<BootstrapConfig>,
): BootstrapReport {
  const fullConfig: BootstrapConfig = {
    iterations: 1000,
    confidenceLevel: 0.95,
    seed: 42,
    ...config,
  }

  const groups = groupByLineage(results)
  const rng = new SeededRandom(fullConfig.seed)

  // Collect bootstrap samples
  const totalSamples: number[] = []
  const categorySamples: Record<string, number[]> = {}

  for (let i = 0; i < fullConfig.iterations; i++) {
    const sample = bootstrapSample(groups, rng)
    totalSamples.push(sample.total)
    for (const [cat, val] of Object.entries(sample.byCategory)) {
      if (!categorySamples[cat]) categorySamples[cat] = []
      categorySamples[cat]!.push(val)
    }
  }

  // Compute point estimates and CIs
  const totalStats = stats(totalSamples)
  const totalCI = percentileCI(totalSamples, fullConfig.confidenceLevel)

  const byCategory: Record<string, BootstrapCI> = {}
  for (const [cat, samples] of Object.entries(categorySamples)) {
    const s = stats(samples)
    const ci = percentileCI(samples, fullConfig.confidenceLevel)
    byCategory[cat] = {
      mean: s.mean,
      lower: ci.lower,
      upper: ci.upper,
      stdDev: s.stdDev,
      confidenceLevel: fullConfig.confidenceLevel,
    }
  }

  return {
    total: {
      mean: totalStats.mean,
      lower: totalCI.lower,
      upper: totalCI.upper,
      stdDev: totalStats.stdDev,
      confidenceLevel: fullConfig.confidenceLevel,
    },
    byCategory,
    config: fullConfig,
    numLineageGroups: groups.size,
    numSamples: results.length,
  }
}

/**
 * Compare two models' bootstrap reports.
 *
 * Returns the delta (A - B) with its own bootstrap CI, computed as the
 * difference of paired bootstrap samples (same seed for both models).
 *
 * @param resultsA  Score results for model A
 * @param resultsB  Score results for model B
 * @param modelA    Name of model A
 * @param modelB    Name of model B
 * @param config    Bootstrap configuration
 */
export function compareModels(
  resultsA: ScoreResult[],
  resultsB: ScoreResult[],
  modelA: string,
  modelB: string,
  config?: Partial<BootstrapConfig>,
): ComparisonReport {
  const fullConfig: BootstrapConfig = {
    iterations: 1000,
    confidenceLevel: 0.95,
    seed: 42,
    ...config,
  }

  // Compute paired delta: for each bootstrap iteration, delta = sampleA - sampleB
  // Both models use the same RNG seed and group resampling indices.
  const groupsA = groupByLineage(resultsA)
  const groupsB = groupByLineage(resultsB)
  const rng = new SeededRandom(fullConfig.seed)

  const deltaTotalSamples: number[] = []
  const deltaCategorySamples: Record<string, number[]> = {}

  // Proper paired bootstrap: resample once, apply to both A and B
  const rng2 = new SeededRandom(fullConfig.seed)
  const groupKeysA = [...groupsA.keys()]
  const groupKeysB = [...groupsB.keys()]

  for (let i = 0; i < fullConfig.iterations; i++) {
    // Pick group indices
    const numGroupsA = groupKeysA.length
    const numGroupsB = groupKeysB.length
    // Use the maximum to ensure both can be resampled
    const numGroups = Math.min(numGroupsA, numGroupsB)

    let totalA = 0
    let totalB = 0
    const catA: Record<string, number> = {}
    const catB: Record<string, number> = {}

    for (let g = 0; g < numGroups; g++) {
      const idxA = rng2.nextInt(numGroupsA)
      const idxB = rng2.nextInt(numGroupsB)

      const groupA = groupsA.get(groupKeysA[idxA]!)!
      const groupB = groupsB.get(groupKeysB[idxB]!)!

      const avgA = groupA.reduce((s, r) => s + r.total, 0) / groupA.length
      const avgB = groupB.reduce((s, r) => s + r.total, 0) / groupB.length
      totalA += avgA
      totalB += avgB

      for (const sub of groupA[0]!.subscores) {
        if (!catA[sub.category]) catA[sub.category] = 0
        const subAvg = groupA.reduce((s, r) => {
          const m = r.subscores.find((x) => x.category === sub.category)
          return s + (m?.score ?? 0)
        }, 0) / groupA.length
        catA[sub.category]! += subAvg
      }
      for (const sub of groupB[0]!.subscores) {
        if (!catB[sub.category]) catB[sub.category] = 0
        const subAvg = groupB.reduce((s, r) => {
          const m = r.subscores.find((x) => x.category === sub.category)
          return s + (m?.score ?? 0)
        }, 0) / groupB.length
        catB[sub.category]! += subAvg
      }
    }

    totalA /= numGroups
    totalB /= numGroups
    for (const cat of Object.keys(catA)) {
      catA[cat]! /= numGroups
    }
    for (const cat of Object.keys(catB)) {
      catB[cat]! /= numGroups
    }

    deltaTotalSamples.push(totalA - totalB)
    for (const cat of Object.keys(catA)) {
      if (!deltaCategorySamples[cat]) deltaCategorySamples[cat] = []
      deltaCategorySamples[cat]!.push((catA[cat] ?? 0) - (catB[cat] ?? 0))
    }
  }

  const deltaStats = stats(deltaTotalSamples)
  const deltaCI = percentileCI(deltaTotalSamples, fullConfig.confidenceLevel)

  const byCategoryDelta: Record<string, { delta: number; ci: BootstrapCI }> = {}
  for (const [cat, samples] of Object.entries(deltaCategorySamples)) {
    const s = stats(samples)
    const ci = percentileCI(samples, fullConfig.confidenceLevel)
    byCategoryDelta[cat] = {
      delta: s.mean,
      ci: {
        mean: s.mean,
        lower: ci.lower,
        upper: ci.upper,
        stdDev: s.stdDev,
        confidenceLevel: fullConfig.confidenceLevel,
      },
    }
  }

  return {
    modelA,
    modelB,
    delta: deltaStats.mean,
    deltaCI: {
      mean: deltaStats.mean,
      lower: deltaCI.lower,
      upper: deltaCI.upper,
      stdDev: deltaStats.stdDev,
      confidenceLevel: fullConfig.confidenceLevel,
    },
    byCategoryDelta,
    aSignificantlyBetter: deltaCI.lower > 0,
  }
}

/**
 * Format a bootstrap CI for human-readable output.
 */
export function formatCI(ci: BootstrapCI, decimals = 2): string {
  return `${ci.mean.toFixed(decimals)} [${ci.lower.toFixed(decimals)}, ${ci.upper.toFixed(decimals)}]`
}

/**
 * Format a comparison report for human-readable output.
 */
export function formatComparison(report: ComparisonReport, decimals = 2): string {
  const lines: string[] = [
    `Comparison: ${report.modelA} vs ${report.modelB}`,
    `  Total delta: ${report.delta.toFixed(decimals)} [${report.deltaCI.lower.toFixed(decimals)}, ${report.deltaCI.upper.toFixed(decimals)}]`,
    `  A significantly better: ${report.aSignificantlyBetter ? "YES" : "NO"}`,
    "",
    "  By category:",
  ]
  for (const [cat, { delta, ci }] of Object.entries(report.byCategoryDelta)) {
    lines.push(
      `    ${cat.padEnd(30)} delta=${delta.toFixed(decimals)} [${ci.lower.toFixed(decimals)}, ${ci.upper.toFixed(decimals)}]`,
    )
  }
  return lines.join("\n")
}
