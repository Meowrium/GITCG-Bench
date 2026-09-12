// Copyright (C) 2026 Piovium Labs
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
 * V30 Stage 3 — CLI entrypoint for exporting encoder NDJSON datasets.
 *
 * Usage:
 *   pnpm encoder:export-dataset <db-path> <out-dir> [--test-fraction 0.2] [--max-samples N] [--seed S]
 */

import { exportEncoderDataset } from "../export-dataset.js"

function parseArgs(argv: readonly string[]): {
  dbPath: string
  outDir: string
  testFraction: number
  maxSamples: number
  seed: number
  reweight: "none" | "gi-v30"
  upgradeV2ToV3: boolean
  upgradeV3ToV4: boolean
} {
  const positional: string[] = []
  let testFraction = 0.2
  let maxSamples = 0
  let seed = 17
  let reweight: "none" | "gi-v30" = "none"
  let upgradeV2ToV3 = false
  let upgradeV3ToV4 = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--test-fraction") {
      testFraction = Number(argv[++i] ?? "0.2")
    } else if (a === "--max-samples") {
      maxSamples = Number(argv[++i] ?? "0")
    } else if (a === "--seed") {
      seed = Number(argv[++i] ?? "17")
    } else if (a === "--reweight") {
      const v = argv[++i] ?? "none"
      if (v !== "none" && v !== "gi-v30") {
        throw new Error(`--reweight must be 'none' or 'gi-v30', got '${v}'`)
      }
      reweight = v
    } else if (a === "--upgrade-v2-to-v3") {
      upgradeV2ToV3 = true
    } else if (a === "--upgrade-v3-to-v4") {
      // V31 F9: upgrade schema-v3 captures to v4 by zero-filling skill_fingerprint.
      upgradeV3ToV4 = true
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`)
    } else {
      positional.push(a)
    }
  }
  if (positional.length < 2) {
    throw new Error(
      "Usage: run-export-encoder-dataset.ts <db-path> <out-dir> [--test-fraction F] [--max-samples N] [--seed S] [--reweight none|gi-v30] [--upgrade-v2-to-v3] [--upgrade-v3-to-v4]",
    )
  }
  return {
    dbPath: positional[0],
    outDir: positional[1],
    testFraction,
    maxSamples,
    seed,
    reweight,
    upgradeV2ToV3,
    upgradeV3ToV4,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = exportEncoderDataset({
    dbPath: args.dbPath,
    outDir: args.outDir,
    testFraction: args.testFraction,
    maxSamples: args.maxSamples,
    splitSeed: args.seed,
    reweight: args.reweight,
    upgradeV2ToV3: args.upgradeV2ToV3,
    upgradeV3ToV4: args.upgradeV3ToV4,
    verbose: true,
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
