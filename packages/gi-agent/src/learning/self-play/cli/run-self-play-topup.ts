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
import { dirname, relative, resolve } from "node:path"
import {
  loadBenchmarkCliConfig,
  readJsonFile,
} from "../../../evaluation/benchmark/cli-config.js"
import type { SelfPlayCollectionResult } from "../self-play-collector.js"
import { buildSelfPlayTopupPlan, type SelfPlayTopupStrategy } from "../self-play-topup.js"

interface CliArgs {
  configPath: string
}

interface SelfPlayTopupCliConfig {
  benchmarkPath: string
  resultPath: string
  templateSelfPlayConfigPath?: string
  strategy?: SelfPlayTopupStrategy
  output: {
    reportPath: string
    benchmarkPath: string
    selfPlayConfigPath?: string
  }
}

interface SelfPlayCliTemplateConfig {
  benchmarkPath: string
  dbPath: string
  source?: "self_play" | "human_critic"
  gamesMultiplier?: number
  replayLogCapture?: {
    directory: string
    maxGamesPerMatchup: number
    version?: string
  }
  sideA?: unknown
  sideB?: unknown
  outputPath?: string
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = resolve(process.cwd(), args.configPath)
  const configDir = dirname(configPath)
  const config = (await readJsonFile(configPath)) as SelfPlayTopupCliConfig
  const benchmark = await loadBenchmarkCliConfig(resolve(configDir, config.benchmarkPath))
  const result = (await readJsonFile(
    resolve(configDir, config.resultPath),
  )) as SelfPlayCollectionResult
  const plan = buildSelfPlayTopupPlan({
    benchmarkConfig: benchmark.config,
    result,
    strategy: config.strategy,
  })

  await writeJson(resolve(configDir, config.output.reportPath), plan)
  await writeJson(resolve(configDir, config.output.benchmarkPath), plan.benchmarkConfig)

  if (config.output.selfPlayConfigPath) {
    const templatePath =
      config.templateSelfPlayConfigPath ?? config.output.selfPlayConfigPath
    const template = (await readJsonFile(
      resolve(configDir, templatePath),
    )) as SelfPlayCliTemplateConfig
    const benchmarkOutputPath = resolve(configDir, config.output.benchmarkPath)
    const selfPlayConfigPath = resolve(configDir, config.output.selfPlayConfigPath)
    const generatedConfig: SelfPlayCliTemplateConfig = {
      ...template,
      benchmarkPath: toPosixRelativePath(
        dirname(selfPlayConfigPath),
        benchmarkOutputPath,
      ),
      outputPath: "./output/self-play-topup-result.json",
    }
    await writeJson(selfPlayConfigPath, generatedConfig)
  }

  console.log(formatPlanSummary(plan))
}

function parseArgs(argv: string[]): CliArgs {
  const configPath = argv[0]
  if (!configPath) {
    throw new Error(
      "Usage: pnpm exec gnx src/learning/self-play/cli/run-self-play-topup.ts <config.json>",
    )
  }
  return { configPath }
}

async function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function toPosixRelativePath(fromDir: string, targetPath: string) {
  return relative(fromDir, targetPath).replace(/\\/g, "/")
}

function formatPlanSummary(plan: ReturnType<typeof buildSelfPlayTopupPlan>) {
  return [
    `Top-up matchups: ${plan.matchups.length}`,
    `Estimated extra games: ${plan.totalExtraGames}`,
    `Target inserted/game: ${plan.strategy.resolvedTargetInsertedPerGame.toFixed(2)}`,
    ...plan.matchups.map(
      (matchup) =>
        `${matchup.matchupId}: current=${matchup.currentInsertedSamples}/${matchup.currentGames} skipped=${matchup.currentSkippedSamples} extra=${matchup.estimatedExtraGames}`,
    ),
  ].join("\n")
}

await main()
