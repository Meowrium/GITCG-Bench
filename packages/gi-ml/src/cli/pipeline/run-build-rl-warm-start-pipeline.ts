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
import { loadRlDatasetInput } from "../../datasets/rl-input.js"
import { buildRankingDatasetFromRlDataset } from "../../datasets/rl.js"
import { writeJsonFile } from "../../io/index.js"
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js"
import { evaluateRankingDataset } from "../../ranker/evaluate.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "dataset-output": { type: "string", default: "./output/rl-ranking-dataset.json" },
      "artifact-output": { type: "string", default: "./output/rl-slot-linear-ranker.json" },
      "evaluation-output": { type: "string", default: "./output/rl-slot-linear-ranker-eval.json" },
      "dataset-id": { type: "string", default: "" },
      version: { type: "string", default: "" },
      "include-unchosen": { type: "boolean", default: false },
      "top-tags": { type: "string", default: "32" },
      "top-candidate-slots": { type: "string", default: "24" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const rlDataset = await loadRlDatasetInput(resolve(inputPath))
  const rankingDataset = buildRankingDatasetFromRlDataset(rlDataset, {
    datasetId: (values["dataset-id"] as string) || undefined,
    includeUnchosenQueries: Boolean(values["include-unchosen"]),
  })
  const rankingPath = await writeJsonFile(values["dataset-output"] as string, rankingDataset)

  const artifact = buildSlotLinearArtifactFromDataset(rankingDataset, {
    artifactVersion: (values.version as string) || undefined,
    topTagCount: Number(values["top-tags"]),
    topCandidateNumericSlotCount: Number(values["top-candidate-slots"]),
  })
  const evaluation = await evaluateRankingDataset(
    new SlotLinearRanker(artifact),
    rankingDataset,
  )
  const artifactPath = await writeJsonFile(values["artifact-output"] as string, artifact)
  const evaluationPath = await writeJsonFile(values["evaluation-output"] as string, evaluation)

  console.log(`RL ranking dataset written: ${rankingPath}`)
  console.log(`query_groups=${rankingDataset.query_groups.length}`)
  console.log(`Warm-start ranker artifact written: ${artifactPath}`)
  console.log(`artifact_version=${artifact.artifact_version}`)
  console.log(`Warm-start ranker evaluation written: ${evaluationPath}`)
  console.log(`pairwise_support_rate=${evaluation.pairwise_support_rate ?? "null"}`)
  console.log(`top1_not_contradicted_rate=${evaluation.top1_not_contradicted_rate ?? "null"}`)
}

main().catch((error) => {
  console.error("run-build-rl-warm-start-pipeline fatal error:", error)
  process.exit(1)
})
