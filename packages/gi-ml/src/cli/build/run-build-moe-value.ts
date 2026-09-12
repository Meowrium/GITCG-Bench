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
 * MoE GBDT value artifact trainer (TS CLI wrapper).
 *
 * Reads an RL dataset, builds a value dataset, passes it to
 * the Python MoE trainer, and writes both artifact and evaluation JSON.
 *
 * Usage:
 *   pnpm exec gnx src/cli/run-build-moe-value.ts \
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
const PYTHON_SCRIPT = resolve(__dirname, "../../python/gitcg_ml/train_moe_value.py")

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/moe-value" },
      prefix: { type: "string", default: "moe" },
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
      "Usage: pnpm exec gnx run-build-moe-value.ts --input <rl-dataset.json> [options]",
    )
    process.exit(1)
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string

  // Detect Python path
  let pythonPath = values.python as string
  if (!pythonPath) {
    const venvPython = resolve(
      __dirname,
      "../../python/.lgbm-venv/Scripts/python.exe",
    )
    try {
      const { statSync } = await import("node:fs")
      statSync(venvPython)
      pythonPath = venvPython
    } catch {
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

  console.log(`[MoE CLI] Python: ${pythonPath}`)
  console.log(`[MoE CLI] Loading RL dataset from ${inputPath}...`)
  let rlDataset = await loadRlDatasetInput(resolve(inputPath))

  console.log(`[MoE CLI] Building value dataset...`)
  const valueDataset = buildValueDatasetFromRlDataset(rlDataset)
  console.log(
    `[MoE CLI] Value dataset: ${valueDataset.samples.length} samples`,
  )

  // Free RL dataset memory
  rlDataset = null as any
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }

  // Write value dataset to temp file
  const tmpDir = await mkdtemp(join(tmpdir(), "moe-"))
  const tmpDatasetPath = join(tmpDir, "value-dataset.json")
  console.log(`[MoE CLI] Writing temp dataset (streaming)...`)
  {
    const stream = createWriteStream(tmpDatasetPath, { encoding: "utf8" })
    const { samples, ...rest } = valueDataset
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
  console.log(`[MoE CLI] Temp dataset: ${tmpDatasetPath}`)

  const artifactPath = join(outputDir, `${prefix}.moe-value-artifact.json`)
  const evalPath = join(outputDir, `${prefix}.moe-value-eval.json`)

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

  console.log(`[MoE CLI] Running: ${pythonPath} ${args.join(" ")}`)

  const proc = spawn(pythonPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: resolve(__dirname, "../.."),
  })

  // Stream to buffer, only print summary lines (avoid flooding ECI log)
  const decoder3 = new TextDecoder()
  const summarize3 = (text: string) => {
    for (const line of text.split("\n")) {
      if (!line.includes("tree_idx") && !line.includes("Leaf idx") && !line.includes("edge_weights"))
        console.log(line)
    }
  }
  const onStream3 = (stream: NodeJS.ReadableStream, handler: (text: string) => void) => {
    stream.on("data", (chunk: Buffer) => handler(decoder3.decode(chunk)))
  }
  await new Promise<void>((resolveStreams) => {
    let pending = 2
    const done = () => { if (--pending === 0) resolveStreams() }
    onStream3(proc.stdout!, summarize3)
    onStream3(proc.stderr!, summarize3)
    proc.stdout!.on("end", done)
    proc.stderr!.on("end", done)
  })

  const exitCode: number = await new Promise((resolveExit) => proc.on("exit", resolveExit))
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {})

  if (exitCode !== 0) {
    console.error(`[MoE CLI] Python trainer exited with code ${exitCode}`)
    process.exit(exitCode)
  }

  try {
    const evalJson = JSON.parse(await readFile(evalPath, "utf-8"))
    console.log(`\n[MoE CLI] Training Complete`)
    console.log(`  Artifact: ${artifactPath}`)
    console.log(`  Evaluation: ${evalPath}`)
    console.log(`  Samples: ${evalJson.sample_count}`)
    console.log(`  Baseline MAE: ${evalJson.baseline_mae?.toFixed(4) ?? "null"}`)
    console.log(`  Expert MAEs:`)
    for (const exp of evalJson.experts ?? []) {
      const maeStr = exp.mae != null ? exp.mae.toFixed(4) : "N/A (fallback)"
      console.log(`    ${exp.name}: ${exp.count} samples, MAE=${maeStr}`)
    }
  } catch {
    console.log(`[MoE CLI] Done (could not read eval summary).`)
  }
}

main().catch((error) => {
  console.error("run-build-moe-value fatal error:", error)
  process.exit(1)
})
