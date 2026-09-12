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

import { spawn } from "node:child_process"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import { readJsonFile, resolveCliPath, writeJsonFile } from "../../io/index.js"
import { readSlotLinearRankerArtifact } from "../../ranker/index.js"
import type { RankingDatasetEvaluation as MlRankingEvaluation } from "../../ranker/evaluate.js"
import { readLinearValueArtifact } from "../../value/index.js"
import type { ValueDatasetEvaluation as MlValueDatasetEvaluation } from "../../value/evaluate.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/rl-formal-train" },
      prefix: { type: "string", default: "rl_formal" },
      python: { type: "string", default: "python" },
      "python-cwd": { type: "string", default: "./python" },
      "dataset-id": { type: "string", default: "" },
      version: { type: "string", default: "" },
      "holdout-fraction": { type: "string", default: "0.1" },
      "holdout-seed": { type: "string", default: "rl_formal_holdout_v1" },
      "ranker-epochs": { type: "string", default: "40" },
      "ranker-lr": { type: "string", default: "0.08" },
      "ranker-l2": { type: "string", default: "0.0005" },
      "ranker-top-tags": { type: "string", default: "64" },
      "ranker-top-candidate-slots": { type: "string", default: "64" },
      "ranker-top-query-slots": { type: "string", default: "32" },
      "value-epochs": { type: "string", default: "60" },
      "value-lr": { type: "string", default: "0.05" },
      "value-l2": { type: "string", default: "0.0005" },
      "value-top-features": { type: "string", default: "96" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const outputDir = resolveCliPath(values["output-dir"] as string)
  const prefix = (values.prefix as string) || "rl_formal"
  const datasetId = (values["dataset-id"] as string) || undefined
  const version = (values.version as string) || prefix
  const pythonExe = await resolvePythonCommand(values.python as string)
  const pythonCwd = resolveCliPath(values["python-cwd"] as string)
  const holdoutFraction = Number(values["holdout-fraction"])
  const holdoutSeed = (values["holdout-seed"] as string) || "rl_formal_holdout_v1"
  const bunExe = process.execPath
  const cliCwd = process.cwd()

  const rankingDatasetPath = join(outputDir, `${prefix}.ranking-dataset.json`)
  const valueDatasetPath = join(outputDir, `${prefix}.value-dataset.json`)
  const rankingTrainDatasetPath = join(outputDir, `${prefix}.ranking-train-dataset.json`)
  const rankingHoldoutDatasetPath = join(outputDir, `${prefix}.ranking-holdout-dataset.json`)
  const valueTrainDatasetPath = join(outputDir, `${prefix}.value-train-dataset.json`)
  const valueHoldoutDatasetPath = join(outputDir, `${prefix}.value-holdout-dataset.json`)

  const rankerArtifactPath = join(outputDir, `${prefix}.ranker-artifact.python.json`)
  const valueArtifactPath = join(outputDir, `${prefix}.value-artifact.python.json`)
  const rankingEvalPath = join(outputDir, `${prefix}.ranker-eval.python.json`)
  const valueEvalPath = join(outputDir, `${prefix}.value-eval.python.json`)

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-ranking-dataset.ts",
    withOptionalStringArgs(
      [
        "--input",
        resolveCliPath(inputPath),
        "--output",
        rankingDatasetPath,
        "--batch-size",
        "5",
      ],
      "--dataset-id",
      datasetId ? `${datasetId}_ranking` : undefined,
    ),
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-value-dataset.ts",
    withOptionalStringArgs(
      [
        "--input",
        resolveCliPath(inputPath),
        "--output",
        valueDatasetPath,
        "--batch-size",
        "5",
      ],
      "--dataset-id",
      datasetId ? `${datasetId}_value` : undefined,
    ),
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-ranking-dataset.ts",
    withHoldoutArgs(
      withOptionalStringArgs(
        [
          "--input",
          resolveCliPath(inputPath),
          "--output",
          rankingTrainDatasetPath,
          "--batch-size",
          "5",
          "--subset",
          "train",
        ],
        "--dataset-id",
        datasetId ? `${datasetId}_ranking_train` : undefined,
      ),
      holdoutFraction,
      holdoutSeed,
    ),
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-ranking-dataset.ts",
    withHoldoutArgs(
      withOptionalStringArgs(
        [
          "--input",
          resolveCliPath(inputPath),
          "--output",
          rankingHoldoutDatasetPath,
          "--batch-size",
          "5",
          "--subset",
          "holdout",
        ],
        "--dataset-id",
        datasetId ? `${datasetId}_ranking_holdout` : undefined,
      ),
      holdoutFraction,
      holdoutSeed,
    ),
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-value-dataset.ts",
    withHoldoutArgs(
      withOptionalStringArgs(
        [
          "--input",
          resolveCliPath(inputPath),
          "--output",
          valueTrainDatasetPath,
          "--batch-size",
          "5",
          "--subset",
          "train",
        ],
        "--dataset-id",
        datasetId ? `${datasetId}_value_train` : undefined,
      ),
      holdoutFraction,
      holdoutSeed,
    ),
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-export-rl-value-dataset.ts",
    withHoldoutArgs(
      withOptionalStringArgs(
        [
          "--input",
          resolveCliPath(inputPath),
          "--output",
          valueHoldoutDatasetPath,
          "--batch-size",
          "5",
          "--subset",
          "holdout",
        ],
        "--dataset-id",
        datasetId ? `${datasetId}_value_holdout` : undefined,
      ),
      holdoutFraction,
      holdoutSeed,
    ),
  )

  await runCommand(
    pythonExe,
    [
      "-m",
      "gitcg_ml.cli.train_slot_linear_ranker",
      "--input",
      rankingTrainDatasetPath,
      "--output",
      rankerArtifactPath,
      "--version",
      `${version}_ranker_py`,
      "--epochs",
      values["ranker-epochs"] as string,
      "--learning-rate",
      values["ranker-lr"] as string,
      "--l2",
      values["ranker-l2"] as string,
      "--top-tags",
      values["ranker-top-tags"] as string,
      "--top-candidate-slots",
      values["ranker-top-candidate-slots"] as string,
      "--top-query-slots",
      values["ranker-top-query-slots"] as string,
    ],
    pythonCwd,
  )

  await runCommand(
    pythonExe,
    [
      "-m",
      "gitcg_ml.cli.train_linear_value_model",
      "--input",
      valueTrainDatasetPath,
      "--output",
      valueArtifactPath,
      "--version",
      `${version}_value_py`,
      "--epochs",
      values["value-epochs"] as string,
      "--learning-rate",
      values["value-lr"] as string,
      "--l2",
      values["value-l2"] as string,
      "--top-features",
      values["value-top-features"] as string,
    ],
    pythonCwd,
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-evaluate-slot-linear-ranker.ts",
    [
      "--dataset",
      rankingHoldoutDatasetPath,
      "--artifact",
      rankerArtifactPath,
      "--output",
      rankingEvalPath,
    ],
  )

  await runBunCli(
    bunExe,
    cliCwd,
    "run-evaluate-rl-value-artifact.ts",
    [
      "--dataset",
      valueHoldoutDatasetPath,
      "--artifact",
      valueArtifactPath,
      "--output",
      valueEvalPath,
    ],
  )

  const [rankerArtifact, valueArtifact, rankingEvaluation, valueEvaluation] = await Promise.all([
    readSlotLinearRankerArtifact(rankerArtifactPath),
    readLinearValueArtifact(valueArtifactPath),
    readJsonFile<MlRankingEvaluation>(rankingEvalPath),
    readJsonFile<MlValueDatasetEvaluation>(valueEvalPath),
  ])

  const bundle = buildBundle({
    inputPath: resolveCliPath(inputPath),
    pythonExe,
    pythonCwd,
    rankingDatasetPath,
    rankerArtifactPath,
    rankingEvalPath,
    rankingEvaluation,
    rankingTrainDatasetPath,
    rankingHoldoutDatasetPath,
    valueDatasetPath,
    valueArtifactPath,
    valueEvalPath,
    valueEvaluation,
    valueTrainDatasetPath,
    valueHoldoutDatasetPath,
    holdoutFraction,
    holdoutSeed,
    rankerArtifactVersion: rankerArtifact.artifact_version,
    valueArtifactVersion: valueArtifact.artifact_version,
  })
  const bundlePath = await writeJsonFile(join(outputDir, `${prefix}.bundle.json`), bundle)

  console.log(`RL formal training bundle written: ${bundlePath}`)
  console.log(`ranking_query_count=${rankingEvaluation.query_count}`)
  console.log(`pairwise_support_rate=${rankingEvaluation.pairwise_support_rate ?? "null"}`)
  console.log(`top1_not_contradicted_rate=${rankingEvaluation.top1_not_contradicted_rate ?? "null"}`)
  console.log(`value_sample_count=${valueEvaluation.sample_count}`)
  console.log(`value_mae=${valueEvaluation.mae ?? "null"}`)
  console.log(`value_rmse=${valueEvaluation.rmse ?? "null"}`)
}

export interface BuildBundleArgs {
  inputPath: string
  pythonExe: string
  pythonCwd: string
  rankingDatasetPath: string
  rankingTrainDatasetPath: string
  rankingHoldoutDatasetPath: string
  rankerArtifactPath: string
  rankingEvalPath: string
  rankingEvaluation: MlRankingEvaluation
  valueDatasetPath: string
  valueTrainDatasetPath: string
  valueHoldoutDatasetPath: string
  valueArtifactPath: string
  valueEvalPath: string
  valueEvaluation: MlValueDatasetEvaluation
  holdoutFraction: number
  holdoutSeed: string
  rankerArtifactVersion: string
  valueArtifactVersion: string
}

export function buildBundle(args: BuildBundleArgs) {
  return {
    bundle_version: "rl_formal_training_bundle.v1",
    created_at: new Date().toISOString(),
    source_dataset: args.inputPath,
    trainer: {
      kind: "python",
      python: args.pythonExe,
      python_cwd: args.pythonCwd,
    },
    outputs: {
      ranking_dataset: args.rankingDatasetPath,
      ranking_training_dataset: args.rankingTrainDatasetPath,
      ranking_holdout_dataset: args.rankingHoldoutDatasetPath,
      ranking_artifact: args.rankerArtifactPath,
      ranking_evaluation: args.rankingEvalPath,
      value_dataset: args.valueDatasetPath,
      value_training_dataset: args.valueTrainDatasetPath,
      value_holdout_dataset: args.valueHoldoutDatasetPath,
      value_artifact: args.valueArtifactPath,
      value_evaluation: args.valueEvalPath,
    },
    evaluation_split: {
      kind: "holdout",
      holdout_fraction: args.holdoutFraction,
      holdout_seed: args.holdoutSeed,
    },
    metrics: {
      ranking: {
        query_count: args.rankingEvaluation.query_count,
        pairwise_support_rate: args.rankingEvaluation.pairwise_support_rate,
        top1_not_contradicted_rate: args.rankingEvaluation.top1_not_contradicted_rate,
      },
      value: {
        sample_count: args.valueEvaluation.sample_count,
        mae: args.valueEvaluation.mae,
        rmse: args.valueEvaluation.rmse,
      },
    },
    versions: {
      ranker_artifact_version: args.rankerArtifactVersion,
      value_artifact_version: args.valueArtifactVersion,
    },
  }
}

async function runBunCli(
  bunExe: string,
  cwd: string,
  relativeCliPath: string,
  args: string[],
): Promise<void> {
  const cliPath = fileURLToPath(new URL(relativeCliPath, import.meta.url))
  await runCommand(bunExe, [cliPath, ...args], cwd)
}

function withOptionalStringArgs(
  args: string[],
  flag: string,
  value: string | undefined,
): string[] {
  if (!value) {
    return args
  }
  return [...args, flag, value]
}

function withHoldoutArgs(
  args: string[],
  holdoutFraction: number,
  holdoutSeed: string,
): string[] {
  return [
    ...args,
    "--holdout-fraction",
    String(holdoutFraction),
    "--holdout-seed",
    holdoutSeed,
  ]
}

export function choosePythonCommand(
  requestedCommand: string,
  platform: NodeJS.Platform,
  pythonAvailable: boolean,
): string {
  if (
    platform === "win32" &&
    /^python3(?:\.exe)?$/i.test(requestedCommand) &&
    pythonAvailable
  ) {
    return "python"
  }
  return requestedCommand
}

async function resolvePythonCommand(requestedCommand: string): Promise<string> {
  if (process.platform !== "win32") {
    return requestedCommand
  }

  const pythonAvailable = await commandExists("python")
  const resolved = choosePythonCommand(
    requestedCommand,
    process.platform,
    pythonAvailable,
  )
  if (resolved !== requestedCommand) {
    console.warn(
      `Python command "${requestedCommand}" is mapped to "${resolved}" on Windows for CLI compatibility.`,
    )
  }
  return resolved
}

async function commandExists(command: string): Promise<boolean> {
  const exitCode = await new Promise<number>((resolvePromise) => {
    const child = spawn("where.exe", [command], {
      stdio: "ignore",
      shell: false,
    })
    child.on("error", () => resolvePromise(1))
    child.on("exit", (code) => resolvePromise(code ?? 1))
  })
  return exitCode === 0
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`))
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("run-train-rl-formal-pipeline fatal error:", error)
    process.exit(1)
  })
}
