// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { mkdirSync } from "node:fs"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "../../../../../assets-manager/src/index"
import {
  createPolicyFromConfig,
  loadBenchmarkCliConfig,
  readJsonFile,
  type BenchmarkPolicyConfig,
} from "../../../evaluation/benchmark/cli-config.js"
import { DeckPriorProvider } from "../../features/deck-prior-provider.js"
import { LlmDeckPriorProvider } from "../../features/llm-deck-prior-provider.js"
import { SelfPlayCollector, type SelfPlayMatchup } from "../../self-play/self-play-collector.js"
import {
  exportRlDatasetSamplesFromCapture,
  exportRlDatasetV1,
} from "../export-dataset.js"
import { resolveDatasetCapturePaths } from "../capture-paths.js"
import type { PlanPhase } from "../../../runtime/plan/types.js"
import { loadPlanWithMatchupAwareness } from "../../../runtime/plan/plan-loader.js"
import type {
  ObservationViewKindV1,
  RewardConfigV1,
  RlDatasetManifestShardEntryV1,
  RlDatasetManifestV1,
  RlDatasetShardV1,
  SelfPlayRlGameCaptureV1,
} from "@gi-tcg/ml/contracts"

interface CliArgs {
  configPath: string
  outputPath?: string
}

interface SelfPlayRlSmokeCliConfig {
  benchmarkPath: string
  dbPath?: string
  source?: "self_play" | "human_critic"
  gamesMultiplier?: number
  replayLogCapture?: {
    directory: string
    maxGamesPerMatchup: number
    version?: Version
  }
  rlCapture: {
    directory: string
    modelVersion: string
    viewKind?: ObservationViewKindV1
    rewardConfig?: RewardConfigV1
    gameVersion?: string
    cardPoolVersion?: string
    rulesetVersion?: string
    contractVersion?: string
  }
  dataset: {
    outputPath?: string
    manifestPath?: string
    shardDir?: string
    maxSamplesPerShard?: number
    includeSides?: Array<0 | 1>
    requireChosenCandidate?: boolean
    excludeDrawMatchups?: string[]
  }
  sideA?: BenchmarkPolicyConfig
  sideB?: BenchmarkPolicyConfig
  outputPath?: string
  /** SPL: "none" or "compiled" */
  planStrategy?: string
  /** SPL: directory containing {deckFingerprint}.plan.json files */
  plansDir?: string | null
  /** SPL: exploration epsilon for phase-aware sampling */
  planExplorationEpsilon?: number
  /** LLM deck analysis cache directory (enables LLM-enhanced prior features) */
  llmCacheDir?: string
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = resolve(process.cwd(), args.configPath)
  const configDir = dirname(configPath)
  const config = (await readJsonFile(configPath)) as SelfPlayRlSmokeCliConfig
  const loadedBenchmark = await loadBenchmarkCliConfig(
    resolve(configDir, config.benchmarkPath),
  )
  const data = getData(loadedBenchmark.version)
  const collector = new SelfPlayCollector()
  const priorProvider: DeckPriorProvider = config.llmCacheDir
    ? new LlmDeckPriorProvider({ llmCacheDir: resolve(configDir, config.llmCacheDir) })
    : new DeckPriorProvider()

  const matchups: SelfPlayMatchup[] = []
  for (const matchup of loadedBenchmark.config.matchups) {
    if ("priorMatrix" in matchup || "priorMatrixBatch" in matchup) {
      throw new Error("RL smoke does not support benchmark priorMatrix or priorMatrixBatch matchups")
    }
    const sideAConfig = config.sideA ?? matchup.sideA
    const sideBConfig = config.sideB ?? matchup.sideB
    const games = Math.max(
      1,
      Math.round(matchup.games * (config.gamesMultiplier ?? 1)),
    )

    matchups.push({
      id: matchup.id,
      decks: [
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck0),
        DEFAULT_ASSETS_MANAGER.decode(matchup.deck1),
      ],
      games,
      sideA: {
        name: sideAConfig.name,
        createPolicy: () => {
          throw new Error("Policy factory not initialized")
        },
      },
      sideB: {
        name: sideBConfig.name,
        createPolicy: () => {
          throw new Error("Policy factory not initialized")
        },
      },
    })

    const current = matchups[matchups.length - 1]
    const policyA = await createPolicyFromConfig(sideAConfig, loadedBenchmark.configDir, {
      selfDeckCode: matchup.deck0,
      opponentDeckCode: matchup.deck1,
      priorProvider,
    })
    const policyB = await createPolicyFromConfig(sideBConfig, loadedBenchmark.configDir, {
      selfDeckCode: matchup.deck1,
      opponentDeckCode: matchup.deck0,
      priorProvider,
    })
    current.sideA.createPolicy = () => policyA
    current.sideB.createPolicy = () => policyB

    // SPL: load plan phases with matchup-aware augmentation
    if (config.planStrategy === "compiled" && config.plansDir) {
      const plansDir = resolve(configDir, config.plansDir)
      const planA = loadPlanWithMatchupAwareness(plansDir, matchup.deck0, matchup.deck1)
      const planB = loadPlanWithMatchupAwareness(plansDir, matchup.deck1, matchup.deck0)
      if (planA) current.sideA.planPhases = planA
      if (planB) current.sideB.planPhases = planB
    }
  }

  const currentRunCapturePaths: string[] = []
  const result = await collector.collect({
    dbPath: config.dbPath ? resolve(configDir, config.dbPath) : undefined,
    data,
    matchups,
    source: config.source,
    replayLogCapture: config.replayLogCapture
      ? {
          directory: resolve(configDir, config.replayLogCapture.directory),
          maxGamesPerMatchup: config.replayLogCapture.maxGamesPerMatchup,
          version: config.replayLogCapture.version ?? loadedBenchmark.version,
        }
      : undefined,
    rlCapture: {
      directory: resolve(configDir, config.rlCapture.directory),
      modelVersion: config.rlCapture.modelVersion,
      viewKind: config.rlCapture.viewKind,
      rewardConfig: config.rlCapture.rewardConfig,
      gameVersion: config.rlCapture.gameVersion,
      cardPoolVersion: config.rlCapture.cardPoolVersion,
      rulesetVersion: config.rlCapture.rulesetVersion,
      contractVersion: config.rlCapture.contractVersion,
    },
    onGameComplete: ({ rlCapturePath }) => {
      if (rlCapturePath) {
        currentRunCapturePaths.push(rlCapturePath)
      }
    },
  })

  const captureDir = resolve(configDir, config.rlCapture.directory)
  const capturePaths = resolveDatasetCapturePaths({
    currentRunCapturePaths,
    fallbackCapturePaths: await collectCapturePaths(captureDir),
  })
  const requireChosenCandidate = config.dataset.requireChosenCandidate ?? false
  const excludeDrawMatchups = config.dataset.excludeDrawMatchups
  const datasetOutputPath = config.dataset.outputPath
    ? resolve(configDir, config.dataset.outputPath)
    : null
  const manifestPath = config.dataset.manifestPath
    ? resolve(configDir, config.dataset.manifestPath)
    : null
  const shardDir = config.dataset.shardDir
    ? resolve(configDir, config.dataset.shardDir)
    : null

  let sampleCount = 0
  let datasetOutputLocation = datasetOutputPath ?? ""
  let datasetSummary:
    | {
        schema_version: "rl_dataset.v1"
        generated_at: string
        sample_count: number
        source_capture_count: number
        by_matchup: Record<string, number>
      }
    | {
        schema_version: "rl_dataset_manifest.v1"
        generated_at: string
        sample_count: number
        source_capture_count: number
        by_matchup: Record<string, number>
        shard_count: number
      }

  if (manifestPath || shardDir) {
    const manifest = await exportShardedRlDataset({
      capturePaths,
      outputManifestPath:
        manifestPath ??
        replaceJsonSuffix(datasetOutputPath ?? resolve(configDir, "./output/rl-dataset.json"), ".manifest.json"),
      shardDir:
        shardDir ??
        replaceJsonSuffix(datasetOutputPath ?? resolve(configDir, "./output/rl-dataset.json"), ".shards"),
      includeSides: config.dataset.includeSides,
      requireChosenCandidate,
      excludeDrawMatchups,
      maxSamplesPerShard: Math.max(1, config.dataset.maxSamplesPerShard ?? 2000),
    })
    sampleCount = manifest.sample_count
    datasetOutputLocation =
      manifestPath ??
      replaceJsonSuffix(datasetOutputPath ?? resolve(configDir, "./output/rl-dataset.json"), ".manifest.json")
    datasetSummary = {
      schema_version: manifest.schema_version,
      generated_at: manifest.generated_at,
      sample_count: manifest.sample_count,
      source_capture_count: manifest.source_capture_count,
      by_matchup: manifest.by_matchup,
      shard_count: manifest.shard_count,
    }
  } else {
    const captures = await Promise.all(capturePaths.map(readCaptureFile))
    const dataset = exportRlDatasetV1(captures, {
      includeSides: config.dataset.includeSides,
      requireChosenCandidate,
      excludeDrawMatchups,
    })
    const resolvedDatasetOutputPath =
      datasetOutputPath ?? resolve(configDir, "./output/rl-dataset.json")
    mkdirSync(dirname(resolvedDatasetOutputPath), { recursive: true })
    await writeRlDatasetStreaming(resolvedDatasetOutputPath, dataset)
    sampleCount = dataset.sample_count
    datasetOutputLocation = resolvedDatasetOutputPath
    datasetSummary = {
      schema_version: dataset.schema_version,
      generated_at: dataset.generated_at,
      sample_count: dataset.sample_count,
      source_capture_count: dataset.source_capture_count,
      by_matchup: dataset.by_matchup,
    }
  }

  const outputPath = args.outputPath ?? config.outputPath
  console.log(formatSummary(result, sampleCount, datasetOutputLocation))
  if (outputPath) {
    const resolved = resolve(configDir, outputPath)
    mkdirSync(dirname(resolved), { recursive: true })
    await writeCompactJson(resolved, {
      self_play: result,
      dataset: datasetSummary,
      dataset_output: datasetOutputLocation,
    })
  }
}

async function collectCapturePaths(rootDir: string): Promise<string[]> {
  const queue = [rootDir]
  const results: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const resolved = resolve(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(resolved)
      } else if (entry.isFile() && entry.name.endsWith(".rl.json")) {
        results.push(resolved)
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b))
}

async function readCaptureFile(path: string): Promise<SelfPlayRlGameCaptureV1> {
  return JSON.parse(await readFile(path, "utf8")) as SelfPlayRlGameCaptureV1
}

async function exportShardedRlDataset(args: {
  capturePaths: readonly string[]
  outputManifestPath: string
  shardDir: string
  includeSides?: ReadonlyArray<0 | 1>
  requireChosenCandidate: boolean
  excludeDrawMatchups?: ReadonlyArray<string>
  maxSamplesPerShard: number
}): Promise<RlDatasetManifestV1> {
  await mkdir(args.shardDir, { recursive: true })

  const globalByMatchup = new Map<string, number>()
  const shardEntries: RlDatasetManifestShardEntryV1[] = []
  let currentSamples = [] as RlDatasetShardV1["samples"]
  let currentCaptureCount = 0
  let currentByMatchup = new Map<string, number>()
  let totalSamples = 0
  let shardCount = 0

  const flushShard = async () => {
    if (currentSamples.length === 0) {
      return
    }
    shardCount += 1
    const shardId = `shard-${String(shardCount).padStart(5, "0")}`
    const shard: RlDatasetShardV1 = {
      schema_version: "rl_dataset_shard.v1",
      generated_at: new Date().toISOString(),
      shard_id: shardId,
      source_capture_count: currentCaptureCount,
      sample_count: currentSamples.length,
      by_matchup: toSortedRecord(currentByMatchup),
      samples: currentSamples,
    }
    const shardFilename = `${shardId}.json`
    await writeCompactJson(join(args.shardDir, shardFilename), shard)
    shardEntries.push({
      shard_id: shardId,
      relative_path: shardFilename,
      source_capture_count: shard.source_capture_count,
      sample_count: shard.sample_count,
      by_matchup: shard.by_matchup,
    })
    currentSamples = []
    currentCaptureCount = 0
    currentByMatchup = new Map<string, number>()
  }

  for (const capturePath of args.capturePaths) {
    const capture = await readCaptureFile(capturePath)
    const samples = exportRlDatasetSamplesFromCapture(capture, {
      includeSides: args.includeSides,
      requireChosenCandidate: args.requireChosenCandidate,
      excludeDrawMatchups: args.excludeDrawMatchups,
    })
    currentSamples.push(...samples)
    currentCaptureCount += 1
    totalSamples += samples.length
    addMatchupCount(globalByMatchup, capture.matchup_id, samples.length)
    addMatchupCount(currentByMatchup, capture.matchup_id, samples.length)
    if (currentSamples.length >= args.maxSamplesPerShard) {
      await flushShard()
    }
  }
  await flushShard()

  const manifest: RlDatasetManifestV1 = {
    schema_version: "rl_dataset_manifest.v1",
    generated_at: new Date().toISOString(),
    source_capture_count: args.capturePaths.length,
    sample_count: totalSamples,
    by_matchup: toSortedRecord(globalByMatchup),
    samples_schema_version: "rl_dataset.v1",
    shard_schema_version: "rl_dataset_shard.v1",
    shard_count: shardEntries.length,
    shards: shardEntries,
  }
  await writeCompactJson(args.outputManifestPath, manifest)
  return manifest
}

function parseArgs(argv: string[]): CliArgs {
  const configPath = argv[0]
  if (!configPath) {
    throw new Error(
      "Usage: pnpm exec gnx src/learning/rl/cli/run-self-play-rl-smoke.ts <config.json> [--output result.json]",
    )
  }

  const args: CliArgs = { configPath }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--output" && argv[i + 1]) {
      args.outputPath = argv[i + 1]
      i++
    }
  }
  return args
}

function formatSummary(
  result: Awaited<ReturnType<SelfPlayCollector["collect"]>>,
  sampleCount: number,
  datasetOutputPath: string,
) {
  return [
    `Self-play games: ${result.totalGames}`,
    `Inserted samples: ${result.insertedSamples}`,
    `Skipped samples: ${result.skippedSamples}`,
    `RL dataset samples: ${sampleCount}`,
    `RL dataset output: ${datasetOutputPath}`,
    ...result.matchups.map(
      (matchup) =>
        `${matchup.matchupId}: games=${matchup.games} inserted=${matchup.insertedSamples} skipped=${matchup.skippedSamples}`,
    ),
  ].join("\n")
}

async function writeCompactJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8")
}

/**
 * Stream-write an RlDatasetV1 object to disk without materializing the entire
 * JSON string in memory.  This avoids RangeError: Out of memory when the
 * dataset contains tens of thousands of samples.
 */
async function writeRlDatasetStreaming(
  path: string,
  dataset: {
    schema_version: string
    generated_at: string
    source_capture_count: number
    sample_count: number
    by_matchup: Record<string, number>
    samples: readonly unknown[]
  },
): Promise<void> {
  const stream = createWriteStream(path, "utf8")
  const header = {
    schema_version: dataset.schema_version,
    generated_at: dataset.generated_at,
    source_capture_count: dataset.source_capture_count,
    sample_count: dataset.sample_count,
    by_matchup: dataset.by_matchup,
  }
  // Write header + start of samples array
  stream.write(JSON.stringify(header).slice(0, -1) + ',"samples":[')

  for (let i = 0; i < dataset.samples.length; i++) {
    if (i > 0) stream.write(",")
    stream.write(JSON.stringify(dataset.samples[i]))
  }

  stream.write("]}\n")

  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on("error", reject)
  })
}

function addMatchupCount(map: Map<string, number>, matchupId: string, count: number): void {
  map.set(matchupId, (map.get(matchupId) ?? 0) + count)
}

function toSortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function replaceJsonSuffix(path: string, replacement: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}${replacement}` : `${path}${replacement}`
}


await main()
