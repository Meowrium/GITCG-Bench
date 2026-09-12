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
 * Iterative self-play → train → benchmark loop.
 *
 * Each iteration:
 *   1. Self-play with current best model (or baseline for iter 0)
 *   2. Export RL dataset
 *   3. Train ranker (slot-linear) + value (GBDT) models
 *   4. Benchmark new model vs baseline and vs previous best
 *   5. Promote if improved
 *
 * Hardware-aware: sequential game execution, chunked dataset loading,
 * configurable games per iteration.
 */

import { mkdirSync } from "node:fs"
import { mkdir, readFile, writeFile, copyFile, access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

// ======================== Types ========================

export interface IterationConfig {
  /** Root output directory for all iterations */
  outputDir: string

  /** Path to benchmark.json with deck matchups */
  benchmarkPath: string

  /** Number of iterations to run */
  maxIterations: number

  /** Games per matchup per iteration (self-play data generation) */
  gamesPerMatchup: number

  /** Games per matchup for evaluation benchmark */
  evalGamesPerMatchup: number

  /** GBDT hyperparameters */
  gbdt: {
    nEstimators: number
    maxDepth: number
    learningRate: number
    topFeatureCount: number
  }

  /** Ranker hyperparameters */
  ranker: {
    topTags: number
    topCandidateSlots: number
  }

  /** Promotion criteria */
  promotion: {
    /** Minimum value MAE improvement over baseline to promote */
    minMaeImprovement: number
    /** Minimum ranker pairwise support rate */
    minPairwiseSupport: number
  }

  /** Memory management */
  memory: {
    /** Force GC between stages */
    gcBetweenStages: boolean
    /** Maximum samples loaded at once for dataset conversion */
    maxSamplesInMemory: number
  }
}

export interface IterationResult {
  iteration: number
  selfPlayGames: number
  rlSampleCount: number
  rankerMetrics: {
    pairwiseSupport: number | null
    top1NotContradicted: number | null
  }
  valueMetrics: {
    mae: number | null
    rmse: number | null
    training_mae: number | null
    training_rmse: number | null
  }
  evalMetrics?: {
    vsBaseline?: { wins: number; losses: number; draws: number; winRate: number }
    vsPrevious?: { wins: number; losses: number; draws: number; winRate: number }
  }
  promoted: boolean
  artifactPaths: {
    ranker: string
    value: string
  }
}

export interface PipelineState {
  config: IterationConfig
  currentBestIteration: number | null
  currentBestRankerPath: string | null
  currentBestValuePath: string | null
  currentBestQValuePath: string | null
  iterations: IterationResult[]
  startedAt: string
  lastUpdatedAt: string
}

// ======================== Default Config ========================

const DEFAULT_CONFIG: IterationConfig = {
  outputDir: "./output/iterative-training",
  benchmarkPath: "./benchmark.training-v1.json",
  maxIterations: 5,
  gamesPerMatchup: 12,
  evalGamesPerMatchup: 8,
  gbdt: {
    nEstimators: 100,
    maxDepth: 5,
    learningRate: 0.06,
    topFeatureCount: 48,
  },
  ranker: {
    topTags: 32,
    topCandidateSlots: 24,
  },
  promotion: {
    minMaeImprovement: 0.01,
    minPairwiseSupport: 0.55,
  },
  memory: {
    gcBetweenStages: true,
    maxSamplesInMemory: 20000,
  },
}

// ======================== Helpers ========================

function iterDir(outputDir: string, iteration: number): string {
  return join(outputDir, `iter-${String(iteration).padStart(3, "0")}`)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

async function writeJsonFile(path: string, data: unknown): Promise<string> {
  const resolved = resolve(path)
  mkdirSync(dirname(resolved), { recursive: true })
  await writeFile(resolved, JSON.stringify(data), "utf8")
  return resolved
}

function tryGc(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }
}

// ======================== Stage Functions ========================

/**
 * Generate benchmark config for self-play data collection with a given policy.
 */
function generateSelfPlayConfig(
  iteration: number,
  config: IterationConfig,
  currentBestRankerPath: string | null,
  currentBestValuePath: string | null,
  outputDir: string,
): object {
  const rlDir = join(outputDir, "self-play-rl")
  const modelVersion = `iter-${iteration}`

  const sideConfig = currentBestRankerPath
    ? {
        name: `trained-iter${iteration}`,
        kind: "gi-ml-runtime" as const,
        rankerArtifactPath: currentBestRankerPath,
        valueArtifactPath: currentBestValuePath ?? undefined,
        options: { endTurnPenalty: 5 },
      }
    : {
        name: "baseline",
        kind: "baseline" as const,
        options: { endTurnPenalty: 5 },
      }

  return {
    benchmarkPath: config.benchmarkPath,
    gamesMultiplier: config.gamesPerMatchup / 10,  // benchmark.json has games:10 base
    sideA: sideConfig,
    sideB: sideConfig,
    rlCapture: {
      directory: rlDir,
      modelVersion,
      viewKind: "policy_public",
      gameVersion: "v6.3.0",
      cardPoolVersion: "v6.3.0",
      rulesetVersion: "default",
      contractVersion: "obs.v1",
    },
    dataset: {
      outputPath: join(outputDir, "rl-dataset.json"),
      includeSides: [0, 1],
      requireChosenCandidate: true,
    },
    outputPath: join(outputDir, "self-play-result.json"),
  }
}

/**
 * Generate benchmark config for evaluation (trained vs baseline).
 */
function generateEvalBenchmarkConfig(
  config: IterationConfig,
  rankerPath: string,
  valuePath: string | null,
): object {
  return {
    benchmarkPath: config.benchmarkPath,
    gamesMultiplier: config.evalGamesPerMatchup / 10,
    sideA: {
      name: "trained",
      kind: "gi-ml-runtime",
      rankerArtifactPath: rankerPath,
      valueArtifactPath: valuePath ?? undefined,
      options: { endTurnPenalty: 5 },
    },
    sideB: {
      name: "baseline",
      kind: "baseline",
      options: { endTurnPenalty: 5 },
    },
    outputPath: null,
  }
}

// ======================== Main Pipeline ========================

export async function runIterativePipeline(
  userConfig: Partial<IterationConfig> = {},
): Promise<PipelineState> {
  const config: IterationConfig = { ...DEFAULT_CONFIG, ...userConfig }
  const stateFilePath = join(config.outputDir, "pipeline-state.json")

  // Resume from previous state if exists
  let state: PipelineState
  if (await fileExists(stateFilePath)) {
    state = await readJsonFile<PipelineState>(stateFilePath)
    state.config = config
    console.log(`Resuming pipeline from iteration ${state.iterations.length}`)
  } else {
    state = {
      config,
      currentBestIteration: null,
      currentBestRankerPath: null,
      currentBestValuePath: null,
      iterations: [],
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    }
  }

  const startIter = state.iterations.length
  for (let iter = startIter; iter < config.maxIterations; iter++) {
    console.log(`\n${"=".repeat(70)}`)
    console.log(`ITERATION ${iter} / ${config.maxIterations - 1}`)
    console.log(`${"=".repeat(70)}`)

    const output = iterDir(config.outputDir, iter)
    await mkdir(output, { recursive: true })

    // Stage 1: Self-play data generation
    console.log(`\n[Stage 1/${iter}] Self-play data generation...`)
    const selfPlayConfigPath = join(output, "self-play-config.json")
    const selfPlayConfig = generateSelfPlayConfig(
      iter,
      config,
      state.currentBestRankerPath,
      state.currentBestValuePath,
      output,
    )
    await writeJsonFile(selfPlayConfigPath, selfPlayConfig)
    console.log(`  Config written: ${selfPlayConfigPath}`)
    console.log(`  Run: cd packages/gi-agent && pnpm run rl:smoke ${selfPlayConfigPath}`)

    // Check if self-play already ran
    const rlDatasetPath = join(output, "rl-dataset.json")
    if (!(await fileExists(rlDatasetPath))) {
      console.log(`  [MANUAL] Self-play data not found. Please run the command above and re-run this pipeline.`)
      state.lastUpdatedAt = new Date().toISOString()
      await writeJsonFile(stateFilePath, state)
      return state
    }

    // Stage 2: Train models
    console.log(`\n[Stage 2/${iter}] Training models...`)
    if (config.memory.gcBetweenStages) tryGc()

    const bundleOutputDir = join(output, "artifacts")
    const bundlePrefix = `iter${iter}`
    console.log(`  Run: cd packages/gi-ml && pnpm exec gnx src/cli/run-build-rl-warm-start-bundle.ts \\`)
    console.log(`    --input ${rlDatasetPath} --output-dir ${bundleOutputDir} --prefix ${bundlePrefix}`)

    // Check if training already ran
    const rankerPath = join(bundleOutputDir, `${bundlePrefix}.ranker-artifact.json`)
    const valuePath = join(bundleOutputDir, `${bundlePrefix}.value-artifact.json`)
    if (!(await fileExists(rankerPath))) {
      console.log(`  [MANUAL] Artifacts not found. Please run the training command above and re-run this pipeline.`)
      state.lastUpdatedAt = new Date().toISOString()
      await writeJsonFile(stateFilePath, state)
      return state
    }

    // Stage 3: Also train GBDT value model
    console.log(`\n[Stage 3/${iter}] Training GBDT value model...`)
    const gbdtValuePath = join(bundleOutputDir, `${bundlePrefix}.gbdt-value-artifact.json`)
    console.log(`  Run: cd packages/gi-ml && pnpm exec gnx src/cli/run-nonlinear-comparison.ts \\`)
    console.log(`    --input ${rlDatasetPath} --output-dir ${bundleOutputDir} --prefix ${bundlePrefix} \\`)
    console.log(`    --gbdt-estimators ${config.gbdt.nEstimators} --gbdt-depth ${config.gbdt.maxDepth} \\`)
    console.log(`    --gbdt-lr ${config.gbdt.learningRate}`)

    // Read metrics from bundle if available
    const bundlePath = join(bundleOutputDir, `${bundlePrefix}.bundle.json`)
    let rankerMetrics = { pairwiseSupport: null as number | null, top1NotContradicted: null as number | null }
    let valueMetrics = { mae: null as number | null, rmse: null as number | null, training_mae: null as number | null, training_rmse: null as number | null }

    if (await fileExists(bundlePath)) {
      const bundle = await readJsonFile<{
        metrics: {
          ranking: { pairwise_support_rate: number | null; top1_not_contradicted_rate: number | null }
          value: { mae: number | null; rmse: number | null }
        }
      }>(bundlePath)
      rankerMetrics = {
        pairwiseSupport: bundle.metrics.ranking.pairwise_support_rate,
        top1NotContradicted: bundle.metrics.ranking.top1_not_contradicted_rate,
      }
      valueMetrics = {
        mae: bundle.metrics.value.mae,
        rmse: bundle.metrics.value.rmse,
        training_mae: null,
        training_rmse: null,
      }
    }

    // Use GBDT value artifact if available (superior performance)
    const finalValuePath = (await fileExists(gbdtValuePath)) ? gbdtValuePath : valuePath

    // Read GBDT metrics if available
    const gbdtEvalPath = join(bundleOutputDir, `${bundlePrefix}.gbdt-value-eval.json`)
    if (await fileExists(gbdtEvalPath)) {
      const gbdtEval = await readJsonFile<{
        mae: number | null
        rmse: number | null
      }>(gbdtEvalPath)
      valueMetrics = {
        mae: gbdtEval.mae,
        rmse: gbdtEval.rmse,
        training_mae: gbdtEval.mae,
        training_rmse: gbdtEval.rmse,
      }
      console.log(`  GBDT Value MAE=${gbdtEval.mae?.toFixed(4)} RMSE=${gbdtEval.rmse?.toFixed(4)}`)
    }

    // Stage 4: Decide promotion
    console.log(`\n[Stage 4/${iter}] Promotion decision...`)
    const promoted = shouldPromote(rankerMetrics, valueMetrics, config.promotion, state)
    const iterResult: IterationResult = {
      iteration: iter,
      selfPlayGames: -1,  // Will be updated from self-play result
      rlSampleCount: -1,
      rankerMetrics,
      valueMetrics,
      promoted,
      artifactPaths: {
        ranker: rankerPath,
        value: finalValuePath,
      },
    }

    // Read self-play result for game count
    const selfPlayResultPath = join(output, "self-play-result.json")
    if (await fileExists(selfPlayResultPath)) {
      const spResult = await readJsonFile<{
        self_play?: { totalGames?: number }
        dataset?: { sample_count?: number }
      }>(selfPlayResultPath)
      iterResult.selfPlayGames = spResult.self_play?.totalGames ?? -1
      iterResult.rlSampleCount = spResult.dataset?.sample_count ?? -1
    }

    if (promoted) {
      console.log(`  ✅ PROMOTED: iter ${iter} becomes the new best model`)
      state.currentBestIteration = iter
      state.currentBestRankerPath = rankerPath
      state.currentBestValuePath = finalValuePath
    } else {
      console.log(`  ❌ NOT PROMOTED: keeping iter ${state.currentBestIteration ?? "baseline"}`)
    }

    state.iterations.push(iterResult)
    state.lastUpdatedAt = new Date().toISOString()
    await writeJsonFile(stateFilePath, state)

    // Print iteration summary
    printIterationSummary(iter, iterResult, state)

    if (config.memory.gcBetweenStages) tryGc()
  }

  // Print final summary
  printFinalSummary(state)
  return state
}

/**
 * Promotion logic — supports two strategies:
 * - "mae" (legacy): Compare MAE improvement against previous best
 * - "winrate": Compare win-rate of new model vs previous best
 *
 * Note: The actual pipeline (run-multi-iteration-training.ps1) now uses
 * win-rate evaluation by default. This TS implementation is kept for
 * reference and single-iteration use cases.
 */
function shouldPromote(
  rankerMetrics: { pairwiseSupport: number | null },
  valueMetrics: { mae: number | null },
  criteria: IterationConfig["promotion"],
  state: PipelineState,
  _winRateVsPrevious?: number | null,
): boolean {
  // First iteration: always promote if metrics are reasonable
  if (state.currentBestIteration == null) {
    return (rankerMetrics.pairwiseSupport ?? 0) >= criteria.minPairwiseSupport
  }

  // If win-rate data is available, use it for promotion
  if (_winRateVsPrevious != null) {
    return _winRateVsPrevious >= 0.55 && (rankerMetrics.pairwiseSupport ?? 0) >= criteria.minPairwiseSupport
  }

  // Fallback: MAE-based comparison
  const prevIter = state.iterations[state.currentBestIteration]
  if (!prevIter) return true

  const prevMae = prevIter.valueMetrics.mae ?? 1
  const curMae = valueMetrics.mae ?? 1
  const maeImproved = (prevMae - curMae) >= criteria.minMaeImprovement
  const rankerOk = (rankerMetrics.pairwiseSupport ?? 0) >= criteria.minPairwiseSupport

  return maeImproved && rankerOk
}

function printIterationSummary(
  iter: number,
  result: IterationResult,
  state: PipelineState,
): void {
  console.log(`\n--- Iteration ${iter} Summary ---`)
  console.log(`  Games: ${result.selfPlayGames}  Samples: ${result.rlSampleCount}`)
  console.log(`  Ranker: pairwise=${result.rankerMetrics.pairwiseSupport?.toFixed(4)} top1=${result.rankerMetrics.top1NotContradicted?.toFixed(4)}`)
  console.log(`  Value:  MAE=${result.valueMetrics.mae?.toFixed(4)} RMSE=${result.valueMetrics.rmse?.toFixed(4)}`)
  console.log(`  Promoted: ${result.promoted}`)
  console.log(`  Best iteration: ${state.currentBestIteration ?? "baseline"}`)
}

function printFinalSummary(state: PipelineState): void {
  console.log(`\n${"=".repeat(70)}`)
  console.log("PIPELINE COMPLETE")
  console.log(`${"=".repeat(70)}`)
  console.log(`Total iterations: ${state.iterations.length}`)
  console.log(`Best iteration: ${state.currentBestIteration ?? "none (baseline)"}`)
  if (state.currentBestRankerPath) {
    console.log(`Best ranker: ${state.currentBestRankerPath}`)
  }
  if (state.currentBestValuePath) {
    console.log(`Best value:  ${state.currentBestValuePath}`)
  }

  console.log(`\nIteration History:`)
  for (const iter of state.iterations) {
    const flag = iter.promoted ? "✅" : "  "
    console.log(`  ${flag} iter=${iter.iteration} MAE=${iter.valueMetrics.mae?.toFixed(4)} pairwise=${iter.rankerMetrics.pairwiseSupport?.toFixed(4)}`)
  }
}

// ======================== CLI ========================

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/iterative-training" },
      "benchmark-path": { type: "string", default: "" },
      "max-iterations": { type: "string", default: "5" },
      "games-per-matchup": { type: "string", default: "12" },
      "eval-games": { type: "string", default: "8" },
      "gbdt-estimators": { type: "string", default: "100" },
      "gbdt-depth": { type: "string", default: "5" },
      "gbdt-lr": { type: "string", default: "0.06" },
    },
    strict: false,
  })

  let config: Partial<IterationConfig> = {}
  if (values.config) {
    config = JSON.parse(await readFile(resolve(values.config as string), "utf8"))
  }

  // CLI overrides
  if (values["output-dir"]) config.outputDir = values["output-dir"] as string
  if (values["benchmark-path"]) config.benchmarkPath = values["benchmark-path"] as string
  if (values["max-iterations"]) config.maxIterations = Number(values["max-iterations"])
  if (values["games-per-matchup"]) config.gamesPerMatchup = Number(values["games-per-matchup"])
  if (values["eval-games"]) config.evalGamesPerMatchup = Number(values["eval-games"])

  if (values["gbdt-estimators"] || values["gbdt-depth"] || values["gbdt-lr"]) {
    config.gbdt = {
      nEstimators: Number(values["gbdt-estimators"] ?? 100),
      maxDepth: Number(values["gbdt-depth"] ?? 5),
      learningRate: Number(values["gbdt-lr"] ?? 0.06),
      topFeatureCount: 48,
    }
  }

  await runIterativePipeline(config)
}

main().catch((error) => {
  console.error("Iterative pipeline fatal error:", error)
  process.exit(1)
})
