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

import { parseArgs } from "node:util"
import { resolve } from "node:path"
import type { MlRankingDataset } from "../../contracts/index.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/slot-linear-ranker.json" },
      version: { type: "string", default: "" },
      "top-tags": { type: "string", default: "32" },
      "top-candidate-slots": { type: "string", default: "24" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const dataset = await readJsonFile<MlRankingDataset>(resolve(inputPath))
  const artifact = buildSlotLinearArtifactFromDataset(dataset, {
    artifactVersion: (values.version as string) || undefined,
    topTagCount: Number(values["top-tags"]),
    topCandidateNumericSlotCount: Number(values["top-candidate-slots"]),
  })

  const outputPath = await writeJsonFile(values.output as string, artifact)
  console.log(`Slot-linear ranker artifact written: ${outputPath}`)
  console.log(`artifact_version=${artifact.artifact_version}`)
}

main().catch((error) => {
  console.error("run-build-slot-linear-ranker fatal error:", error)
  process.exit(1)
})
