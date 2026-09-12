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
 * LightGBM Q-value trainer (TS CLI wrapper).
 *
 * Reads an RL dataset, builds a Q-value dataset with combined (state + action)
 * features, trains LightGBM the same way as the V model, and writes the artifact.
 *
 * The trained model estimates Q(s,a) = win probability given (state, action).
 * At inference, each candidate's meta_effect_slots (same computation path as
 * training) are merged with state features and passed to predictGbdtValue().
 *
 * Usage:
 *   pnpm exec gnx src/cli/run-build-lgbm-q-value.ts \
 *     --input <rl-dataset.json> \
 *     --output-dir <dir> \
 *     --prefix <name> \
 *     [--estimators 120] [--depth 5] [--lr 0.06] \
 *     [--top-features 80] [--python <python-path>]
 */

import { parseArgs } from "node:util"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { finished } from "node:stream/promises"
import { spawn } from "node:child_process"
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildQValueDatasetFromRlDataset } from "../../datasets/rl-q-value.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
// Reuse the same Python trainer as V model — it's generic LightGBM regression
const PYTHON_SCRIPT = resolve(__dirname, "../../python/gitcg_ml/train_lgbm_value.py")

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/lgbm-q-value" },
      prefix: { type: "string", default: "lgbm_q" },
      estimators: { type: "string", default: "120" },
      depth: { type: "string", default: "5" },
      lr: { type: "string", default: "0.06" },
      "top-features": { type: "string", default: "80" },
      "min-leaf": { type: "string", default: "8" },
      subsample: { type: "string", default: "0.8" },
      python: { type: "string", default: "" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    console.error(
      "Usage: pnpm exec gnx run-build-lgbm-q-value.ts --input <rl-dataset.json> [options]",
    )
    process.exit(1)
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string

  // Detect Python path
  let pythonPath = values.python as string
  if (!pythonPath) {
    const venvPython = resolve(__dirname, "../../python/.lgbm-venv/Scripts/python.exe")
    try {
      const { statSync } = await import("node:fs")
      statSync(venvPython)
      pythonPath = venvPython
    } catch {
      const venvPythonLinux = resolve(__dirname, "../../python/.lgbm-venv/bin/python")
      try {
        const { statSync } = await import("node:fs")
        statSync(venvPythonLinux)
        pythonPath = venvPythonLinux
      } catch {
        pythonPath = "python"
      }
    }
  }

  console.log(`[LightGBM Q-value CLI] Python: ${pythonPath}`)
  console.log(`[LightGBM Q-value CLI] Loading RL dataset from ${inputPath}...`)
  let rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log(`[LightGBM Q-value CLI] Building Q-value dataset...`)
  const qDataset = buildQValueDatasetFromRlDataset(rlDataset)
  console.log(
    `[LightGBM Q-value CLI] Q-value dataset: ${qDataset.samples.length} samples`,
  )

  if (qDataset.samples.length === 0) {
    console.warn("[LightGBM Q-value CLI] No samples — check dataset (requires chosen_candidate_id and outcome_label).")
    process.exit(0)
  }

  // Free RL dataset before writing (save ~2.5 GB)
  rlDataset = null as any
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }

  // Write Q-value dataset to temp file using streaming to avoid OOM
  const tmpDir = await mkdtemp(join(tmpdir(), "lgbm-q-"))
  const tmpDatasetPath = join(tmpDir, "q-value-dataset.json")
  console.log(`[LightGBM Q-value CLI] Writing temp dataset (streaming)...`)
  {
    const stream = createWriteStream(tmpDatasetPath, { encoding: "utf8" })
    const { samples, ...rest } = qDataset
    const header = JSON.stringify(rest)
    stream.write(header.slice(0, -1) + ',"samples":[')
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) stream.write(",")
      stream.write(JSON.stringify(samples[i]))
    }
    stream.write("]}")
    stream.end()
    await finished(stream)
  }
  console.log(`[LightGBM Q-value CLI] Temp dataset: ${tmpDatasetPath}`)

  const artifactPath = join(outputDir, `${prefix}.gbdt-q-value-artifact.json`)
  const evalPath = join(outputDir, `${prefix}.gbdt-q-value-eval.json`)

  // Spawn Python trainer (identical to V model — generic LightGBM regression)
  const args = [
    PYTHON_SCRIPT,
    "--input",
    tmpDatasetPath,
    "--output-artifact",
    artifactPath,
    "--output-eval",
    evalPath,
    "--estimators",
    values.estimators as string,
    "--depth",
    values.depth as string,
    "--lr",
    values.lr as string,
    "--top-features",
    values["top-features"] as string,
    "--min-child",
    values["min-leaf"] as string,
    "--subsample",
    values.subsample as string,
    "--prefix",
    prefix,
  ]

  console.log(`[LightGBM Q-value CLI] Running Python trainer...`)

  const proc = spawn(pythonPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(__dirname, "../.."),
  })

  // Stream to buffer, only print summary lines (avoid flooding ECI log)
  const decoder_q = new TextDecoder()
  const summarizeQ = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.includes("tree_idx") && !line.includes("Leaf idx") && !line.includes("edge_weights")) {
        console.log(line)
      }
    }
  }
  const onStreamQ = (stream: NodeJS.ReadableStream, handler: (text: string) => void) => {
    stream.on("data", (chunk: Buffer) => handler(decoder_q.decode(chunk)))
  }
  await new Promise<void>((resolveStreams) => {
    let pending = 2
    const done = () => { if (--pending === 0) resolveStreams() }
    onStreamQ(proc.stdout!, summarizeQ)
    onStreamQ(proc.stderr!, summarizeQ)
    proc.stdout!.on("end", done)
    proc.stderr!.on("end", done)
  })

  const exitCode: number = await new Promise((resolveExit) => proc.on("exit", resolveExit))
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})

  if (exitCode !== 0) {
    console.error(`[LightGBM Q-value CLI] Python trainer exited with code ${exitCode}`)
    process.exit(exitCode)
  }

  // Post-process: patch artifact_type from "gbdt_value.v1" → "gbdt_q_value.v1"
  // (Python trainer always writes "gbdt_value.v1" regardless of model purpose)
  try {
    const artifactJson = JSON.parse(await readFile(artifactPath, "utf-8"))
    artifactJson.artifact_type = "gbdt_q_value.v1"
    await writeFile(artifactPath, JSON.stringify(artifactJson, null, 2))
    console.log(`[LightGBM Q-value CLI] Patched artifact_type → "gbdt_q_value.v1"`)
  } catch (e) {
    console.error(`[LightGBM Q-value CLI] Failed to patch artifact_type:`, e)
  }

  try {
    const evalJson = JSON.parse(await readFile(evalPath, "utf-8"))
    console.log(`\n[LightGBM Q-value CLI] Training Complete`)
    console.log(`  Artifact: ${artifactPath}`)
    console.log(`  Eval:     ${evalPath}`)
    console.log(`  Samples:  ${evalJson.sample_count}`)
    console.log(`  MAE:      ${evalJson.mae?.toFixed(4) ?? "null"}`)
    console.log(`  RMSE:     ${evalJson.rmse?.toFixed(4) ?? "null"}`)
  } catch {
    console.log(`[LightGBM Q-value CLI] Done (could not read eval summary).`)
  }
}

main().catch((error) => {
  console.error("run-build-lgbm-q-value fatal error:", error)
  process.exit(1)
})
