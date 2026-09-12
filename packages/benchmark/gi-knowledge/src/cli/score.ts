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
 * CLI: score — re-score a results file (e.g., after manually grading).
 *
 * Usage: gnx src/cli/score.ts [--results <path>]
 */

import { readFileSync, writeFileSync } from "node:fs"
import { formatReport } from "../score"

function parseArgs() {
  const args = process.argv.slice(2)
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      opts[key] = args[i + 1] ?? "true"
      if (opts[key] !== "true") i++
    }
  }
  return opts
}

function main() {
  const opts = parseArgs()
  const resultsPath =
    opts.results ?? opts.out ??
    (import.meta.dirname
      ? undefined
      : undefined)

  const actualPath = resultsPath ?? "./benchmark-results.json"
  const data = JSON.parse(readFileSync(actualPath, "utf-8"))
  const results = data.results ?? data

  console.log(formatReport(results))
}

main()
