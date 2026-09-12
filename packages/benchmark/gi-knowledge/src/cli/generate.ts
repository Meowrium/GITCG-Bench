// Copyright (C) 2026 Piovium Labs
// 
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
// 
// 
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
// 
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * CLI: generate — parse card data and output a question bank JSON file.
 *
 * Usage: gnx src/cli/generate.ts [--out <path>] [--max <number>] [--seed <number>]
 */

import { writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import {
  extractAllCardDefs,
  getCharacters,
  getPlayableCards,
  generateBenchmark,
} from "../index"

const OUT_DIR = path.resolve(import.meta.dirname, "../../data")

function timestamp(): string {
  const d = new Date()
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      opts[key] = args[i + 1] ?? "true"
      if (opts[key] !== "true" && args[i + 1] !== undefined) i++
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs()
  const tag = opts.tag ?? timestamp()
  const outPath = opts.out ?? path.join(OUT_DIR, `benchmark-${tag}.json`)
  const maxQuestions = opts.max ? Number(opts.max) : undefined
  const seed = opts.seed ? Number(opts.seed) : 42

  console.log("📖  Extracting card data from @gi-tcg/data...")
  const all = await extractAllCardDefs()
  console.log(`   Found ${all.length} definitions total`)

  const cards = getPlayableCards(all)
  const chars = getCharacters(all)
  console.log(`   Cards: ${cards.length}, Characters: ${chars.length}`)

  console.log("🧠  Generating benchmark questions...")
  const bench = generateBenchmark(cards, chars, all, { maxQuestions, seed })

  // Write
  const dir = path.dirname(outPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(outPath, JSON.stringify(bench, null, 2), "utf-8")

  console.log(`\n✅  Generated ${bench.meta.totalQuestions} questions → ${outPath}`)
  console.log("\n📊  Categories:")
  for (const [cat, count] of Object.entries(bench.meta.categories)) {
    console.log(`   ${cat.padEnd(30)} ${count}`)
  }
}

main().catch((err) => {
  console.error("❌", err)
  process.exit(1)
})
