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

import { mkdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
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
import {
  SelfPlayCollector,
  type SelfPlayMatchup,
} from "../self-play-collector.js"
import type {
  ObservationViewKindV1,
  RewardConfigV1,
} from "../../rl/types.js"
import type { PlanPhase } from "../../../runtime/plan/types.js"
import { loadPlanWithMatchupAwareness } from "../../../runtime/plan/plan-loader.js"
import { FingerprintLake } from "../../fingerprint/fingerprint-lake.js"

interface CliArgs {
  configPath: string
  outputPath?: string
  enableFeatureExtension?: boolean
  fingerprintArtifactPath?: string
  /** V30 Stage 3 — capture StateObservation per sample. */
  enableStateObservation?: boolean
}

interface SelfPlayCliConfig {
  benchmarkPath: string
  dbPath?: string
  source?: "self_play" | "human_critic"
  gamesMultiplier?: number
  replayLogCapture?: {
    directory: string
    maxGamesPerMatchup: number
    version?: Version
  }
  rlCapture?: {
    directory: string
    modelVersion: string
    viewKind?: ObservationViewKindV1
    rewardConfig?: RewardConfigV1
    gameVersion?: string
    cardPoolVersion?: string
    rulesetVersion?: string
    contractVersion?: string
  }
  /** V30 Stage 2.E — capture FeatureExtension array per sample. */
  featureExtension?: {
    enabled: boolean
    /** Path to fingerprint artifact JSON. Defaults to output/entity-fingerprints.generated.json. */
    fingerprintArtifactPath?: string
  }
  /** V30 Stage 3 — capture StateObservation per sample for the encoder. */
  stateObservation?: {
    enabled: boolean
  }
  sideA?: BenchmarkPolicyConfig
  sideB?: BenchmarkPolicyConfig
  outputPath?: string
  planStrategy?: string
  plansDir?: string | null
  planExplorationEpsilon?: number
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = resolve(process.cwd(), args.configPath)
  const configDir = dirname(configPath)
  const config = (await readJsonFile(configPath)) as SelfPlayCliConfig
  // V30 Stage 2.E — surface DataLake backend at startup
  try {
    const { dataLakeBackend, dataLakeBackendError } = await import("../../../db/data-lake.js")
    const backend = dataLakeBackend()
    if (backend === "none") {
      console.warn(`[self-play] DataLake backend: NONE → JSON fallback (slow). Reason: ${dataLakeBackendError() ?? "(unknown)"}`)
    } else {
      console.log(`[self-play] DataLake backend: ${backend}`)
    }
  } catch {
    /* non-fatal */
  }
  const loadedBenchmark = await loadBenchmarkCliConfig(
    resolve(configDir, config.benchmarkPath),
  )
  const data = getData(loadedBenchmark.version)
  const collector = new SelfPlayCollector()
  const llmCacheDir = process.env.LLM_CACHE_DIR
  const priorProvider = llmCacheDir
    ? new LlmDeckPriorProvider({ llmCacheDir })
    : new DeckPriorProvider()

  const matchups: SelfPlayMatchup[] = []
  for (const matchup of loadedBenchmark.config.matchups) {
    if ("priorMatrix" in matchup || "priorMatrixBatch" in matchup) {
      throw new Error("Self-play does not support benchmark priorMatrix or priorMatrixBatch matchups");
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
    }, 0)
    const policyB = await createPolicyFromConfig(sideBConfig, loadedBenchmark.configDir, {
      selfDeckCode: matchup.deck1,
      opponentDeckCode: matchup.deck0,
      priorProvider,
    }, 1)
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

  // V30 Stage 2.E — resolve FeatureExtension config (CLI flag overrides config)
  const extConfigEnabled = config.featureExtension?.enabled ?? false
  const extEnabled = args.enableFeatureExtension ?? extConfigEnabled
  let fingerprintLake: FingerprintLake | null = null
  if (extEnabled) {
    const artifactPath = resolve(
      configDir,
      args.fingerprintArtifactPath
        ?? config.featureExtension?.fingerprintArtifactPath
        ?? "../../output/entity-fingerprints.generated.json",
    )
    try {
      fingerprintLake = await FingerprintLake.fromFile(artifactPath)
      console.log(`[self-play] FeatureExtension enabled, lake size=${fingerprintLake.size()} from ${artifactPath}`)
    } catch (err) {
      console.warn(
        `[self-play] FeatureExtension enabled but failed to load fingerprint artifact at ${artifactPath}: ${err instanceof Error ? err.message : String(err)}. Fingerprint dims will be zero.`,
      )
      fingerprintLake = null
    }
  }

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
    rlCapture: config.rlCapture
      ? {
          directory: resolve(configDir, config.rlCapture.directory),
          modelVersion: config.rlCapture.modelVersion,
          viewKind: config.rlCapture.viewKind,
          rewardConfig: config.rlCapture.rewardConfig,
          gameVersion: config.rlCapture.gameVersion,
          cardPoolVersion: config.rlCapture.cardPoolVersion,
          rulesetVersion: config.rlCapture.rulesetVersion,
          contractVersion: config.rlCapture.contractVersion,
        }
      : undefined,
    featureExtension: extEnabled
      ? { enabled: true, fingerprintLake }
      : undefined,
    stateObservation: (args.enableStateObservation ?? config.stateObservation?.enabled)
      ? { enabled: true }
      : undefined,
  })

  const outputPath = args.outputPath ?? config.outputPath
  console.log(formatSummary(result))
  if (outputPath) {
    const resolved = resolve(configDir, outputPath)
    mkdirSync(dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  }
}

function parseArgs(argv: string[]): CliArgs {
  const configPath = argv[0]
  if (!configPath) {
    throw new Error(
      "Usage: pnpm exec gnx src/learning/self-play/cli/run-self-play.ts <config.json> [--output result.json] [--enable-feature-extension] [--fingerprint-artifact path]",
    )
  }

  const args: CliArgs = { configPath }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--output" && argv[i + 1]) {
      args.outputPath = argv[i + 1]
      i++
    } else if (argv[i] === "--enable-feature-extension") {
      args.enableFeatureExtension = true
    } else if (argv[i] === "--fingerprint-artifact" && argv[i + 1]) {
      args.fingerprintArtifactPath = argv[i + 1]
      i++
    } else if (argv[i] === "--enable-state-observation") {
      args.enableStateObservation = true
    }
  }
  return args
}

function formatSummary(result: Awaited<ReturnType<SelfPlayCollector["collect"]>>) {
  return [
    `Self-play games: ${result.totalGames}`,
    `Inserted samples: ${result.insertedSamples}`,
    `Skipped samples: ${result.skippedSamples}`,
    ...result.matchups.map(
      (matchup) =>
        `${matchup.matchupId}: games=${matchup.games} inserted=${matchup.insertedSamples} skipped=${matchup.skippedSamples}`,
    ),
  ].join("\n")
}


await main()
