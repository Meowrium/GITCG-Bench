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

import { readFileSync, writeFileSync } from "node:fs"

const manifestPath = process.argv[2]
const summaryPath = process.argv[3]
const filterPattern = process.argv[4] ?? ".*"
if (!manifestPath || !summaryPath) {
  throw new Error("manifestPath and summaryPath are required")
}

const matcher = new RegExp(filterPattern)
const lines = readFileSync(manifestPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .slice(1)

const rows = lines
  .map((line) => line.split("\t"))
  .filter((parts) => matcher.test(parts[0] ?? ""))
  .map(([matchupId, _branchConfigPath, branchOutputPath, datasetOutputPath, artifactOutputPath, evaluationOutputPath]) => {
    let evaluation: unknown = null
    try {
      evaluation = JSON.parse(readFileSync(evaluationOutputPath!, "utf8"))
    } catch {
      evaluation = null
    }
    return {
      matchup_id: matchupId,
      branch_eval_report: branchOutputPath,
      dataset: datasetOutputPath,
      artifact: artifactOutputPath,
      evaluation_output: evaluationOutputPath,
      evaluation,
    }
  })

writeFileSync(summaryPath, `${JSON.stringify({ rows }, null, 2)}\n`, "utf8")
