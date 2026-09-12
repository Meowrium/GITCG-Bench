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
 * LightGBM value artifact trainer (TS CLI wrapper).
 *
 * Reads an RL dataset, builds a value dataset, passes it to
 * the Python LightGBM trainer, and writes both artifact and evaluation JSON.
 *
 * Usage:
 *   pnpm exec gnx src/cli/run-build-lgbm-value.ts \
 *     --input <rl-dataset.json> \
 *     --output-dir <dir> \
 *     --prefix <name> \
 *     [--estimators 120] [--depth 5] [--lr 0.06] \
 *     [--top-features 80] [--min-leaf 8] [--subsample 0.8] \
 *     [--python <python-path>]
 */

import { parseArgs } from "node:util"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import { finished } from "node:stream/promises"
import { spawn } from "node:child_process"
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PYTHON_SCRIPT = resolve(__dirname, "../../python/gitcg_ml/train_lgbm_value.py")

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/lgbm-value" },
      prefix: { type: "string", default: "lgbm" },
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
      "Usage: pnpm exec gnx run-build-lgbm-value.ts --input <rl-dataset.json> [options]",
    )
    process.exit(1)
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string

  // Detect Python path
  let pythonPath = values.python as string
  if (!pythonPath) {
    // Try the project's lgbm venv first
    const venvPython = resolve(
      __dirname,
      "../../python/.lgbm-venv/Scripts/python.exe",
    )
    try {
      const { statSync } = await import("node:fs")
      statSync(venvPython)
      pythonPath = venvPython
    } catch {
      // Fallback: try linux venv path, then system python
      const venvPythonLinux = resolve(
        __dirname,
        "../../python/.lgbm-venv/bin/python",
      )
      try {
        const { statSync } = await import("node:fs")
        statSync(venvPythonLinux)
        pythonPath = venvPythonLinux
      } catch {
        pythonPath = "python"
      }
    }
  }

  console.log(`[LightGBM CLI] Python: ${pythonPath}`)
  console.log(`[LightGBM CLI] Loading RL dataset from ${inputPath}...`)
  let rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log(`[LightGBM CLI] Building value dataset...`)
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset)
  console.log(
    `[LightGBM CLI] Value dataset: ${valueDataset.samples.length} samples`,
  )

  // Free RL dataset before writing (save ~2.5 GB)
  rlDataset = null as any
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }

  // Write value dataset to temp file using streaming to avoid OOM
  const tmpDir = await mkdtemp(join(tmpdir(), "lgbm-"))
  const tmpDatasetPath = join(tmpDir, "value-dataset.json")
  console.log(`[LightGBM CLI] Writing temp dataset (streaming)...`)
  {
    const stream = createWriteStream(tmpDatasetPath, { encoding: "utf8" })
    // Write header
    const { samples, ...rest } = valueDataset
    const header = JSON.stringify(rest)
    // Insert samples array
    stream.write(header.slice(0, -1) + ',"samples":[')
    for (let i = 0; i < samples.length; i++) {
      if (i > 0) stream.write(",")
      stream.write(JSON.stringify(samples[i]))
    }
    stream.write("]}")
    stream.end()
    await finished(stream)
  }
  console.log(`[LightGBM CLI] Temp dataset: ${tmpDatasetPath}`)

  const artifactPath = join(outputDir, `${prefix}.gbdt-value-artifact.json`)
  const evalPath = join(outputDir, `${prefix}.gbdt-value-eval.json`)

  // Spawn Python trainer
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

  console.log(`[LightGBM CLI] Running: ${pythonPath} ${args.join(" ")}`)

  const proc = spawn(pythonPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(__dirname, "../.."),
  })

  // Stream to buffer, only print summary lines (avoid flooding ECI log)
  const decoder2 = new TextDecoder()
  const summarize2 = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.includes("tree_idx") && !line.includes("Leaf idx") && !line.includes("edge_weights"))
        console.log(line)
    }
  }
  const onStream = (stream: NodeJS.ReadableStream, handler: (text: string) => void) => {
    stream.on("data", (chunk: Buffer) => handler(decoder2.decode(chunk)))
  }
  await new Promise<void>((resolveStreams) => {
    let pending = 2
    const done = () => { if (--pending === 0) resolveStreams() }
    onStream(proc.stdout!, summarize2)
    onStream(proc.stderr!, summarize2)
    proc.stdout!.on("end", done)
    proc.stderr!.on("end", done)
  })

  const exitCode: number = await new Promise((resolveExit) => proc.on("exit", resolveExit))
  // Clean up temp file
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})

  if (exitCode !== 0) {
    console.error(`[LightGBM CLI] Python trainer exited with code ${exitCode}`)
    process.exit(exitCode)
  }

  // Read back evaluation for summary
  try {
    const evalJson = JSON.parse(await readFile(evalPath, "utf-8"))
    console.log(`\n[LightGBM CLI] Training Complete`)
    console.log(`  Artifact: ${artifactPath}`)
    console.log(`  Evaluation: ${evalPath}`)
    console.log(`  Samples: ${evalJson.sample_count}`)
    console.log(`  MAE: ${evalJson.mae?.toFixed(4) ?? "null"}`)
    console.log(`  RMSE: ${evalJson.rmse?.toFixed(4) ?? "null"}`)
  } catch {
    console.log(`[LightGBM CLI] Done (could not read eval summary).`)
  }
}

main().catch((error) => {
  console.error("run-build-lgbm-value fatal error:", error)
  process.exit(1)
})
