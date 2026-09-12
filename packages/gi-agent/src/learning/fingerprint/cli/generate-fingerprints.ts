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
 * V30 Stage 1.C — Fingerprint generation CLI.
 *
 * Usage:
 *   pnpm run fingerprint:generate
 *   pnpm run fingerprint:generate --output ./output/fp.json --version v6.5.0
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { CURRENT_VERSION, type Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { extractStaticFingerprints } from "../ast-visitor.js"
import { enrichWithSentinelPreviews } from "../sentinel-extractor.js"
import {
  FINGERPRINT_SCHEMA_VERSION,
  type EntityFingerprint,
  type FingerprintArtifact,
  type FingerprintKind,
} from "../types.js"

interface CliArgs {
  outputPath: string
  version: Version
  pretty: boolean
}

const DEFAULT_OUTPUT = "output/entity-fingerprints.generated.json"

function parseArgs(argv: string[]): CliArgs {
  let outputPath = DEFAULT_OUTPUT
  let version: Version = CURRENT_VERSION
  let pretty = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--output" || a === "-o") {
      outputPath = argv[++i] ?? DEFAULT_OUTPUT
    } else if (a === "--version" || a === "-v") {
      version = (argv[++i] ?? CURRENT_VERSION) as Version
    } else if (a === "--minify") {
      pretty = false
    } else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    }
  }
  return { outputPath, version, pretty }
}

function printHelp(): void {
  const log = console.log.bind(console)
  log(`Usage: pnpm run fingerprint:generate [options]

Options:
  --output, -o <path>    Output JSON path (default: ${DEFAULT_OUTPUT})
  --version, -v <ver>    Game version (default: CURRENT_VERSION)
  --minify               Disable pretty-printing
  --help, -h             Show this help
`)
}

function countByKind(entries: EntityFingerprint[]): Record<FingerprintKind, number> {
  const counts: Partial<Record<FingerprintKind, number>> = {}
  for (const e of entries) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1
  }
  return counts as Record<FingerprintKind, number>
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const log = console.log.bind(console)

  log(`[fingerprint] schema=v${FINGERPRINT_SCHEMA_VERSION} game_version=${args.version}`)
  const t0 = Date.now()

  const data = getData(args.version)
  log(`[fingerprint] resolved characters=${data.characters.size} entities=${data.entities.size}`)

  const staticFps = extractStaticFingerprints(data, { gameVersion: args.version })
  log(`[fingerprint] static extraction → ${staticFps.length} entries (${Date.now() - t0}ms)`)

  const fingerprints = enrichWithSentinelPreviews(staticFps)

  const artifact: FingerprintArtifact = {
    schema_version: FINGERPRINT_SCHEMA_VERSION,
    game_version: args.version,
    generated_at: new Date().toISOString(),
    counts: countByKind(fingerprints),
    entries: fingerprints,
  }

  const outAbs = resolve(args.outputPath)
  await mkdir(dirname(outAbs), { recursive: true })
  const json = args.pretty
    ? JSON.stringify(artifact, null, 2)
    : JSON.stringify(artifact)
  await writeFile(outAbs, json + "\n", "utf8")

  log(`[fingerprint] wrote ${outAbs}`)
  log(`[fingerprint] counts:`)
  for (const [kind, n] of Object.entries(artifact.counts).sort()) {
    log(`  ${kind.padEnd(20)} ${n}`)
  }
  log(`[fingerprint] total ${fingerprints.length} entries in ${Date.now() - t0}ms`)
}

main().catch((err) => {
  console.error("[fingerprint] FAILED:", err)
  process.exit(1)
})
