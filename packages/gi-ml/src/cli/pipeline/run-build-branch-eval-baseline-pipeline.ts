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
import type { BranchEvalReportLike } from "../../datasets/branch-eval.js"
import { buildRankingDatasetFromBranchEvalReport } from "../../datasets/branch-eval.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"
import { evaluateRankingDataset } from "../../ranker/evaluate.js"
import { buildSlotLinearArtifactFromDataset } from "../../ranker/build-slot-linear-artifact.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "dataset-output": { type: "string", default: "./output/branch-eval-dataset.json" },
      "artifact-output": { type: "string", default: "./output/slot-linear-ranker.json" },
      "evaluation-output": { type: "string", default: "./output/slot-linear-ranker-eval.json" },
      "dataset-id": { type: "string", default: "" },
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

  const report = await readJsonFile<BranchEvalReportLike>(resolve(inputPath))
  const dataset = buildRankingDatasetFromBranchEvalReport(report, {
    datasetId: (values["dataset-id"] as string) || undefined,
  })
  const artifact = buildSlotLinearArtifactFromDataset(dataset, {
    artifactVersion: (values.version as string) || undefined,
    topTagCount: Number(values["top-tags"]),
    topCandidateNumericSlotCount: Number(values["top-candidate-slots"]),
  })
  const evaluation = await evaluateRankingDataset(
    new SlotLinearRanker(artifact),
    dataset,
  )

  const datasetOutputPath = await writeJsonFile(values["dataset-output"] as string, dataset)
  const artifactOutputPath = await writeJsonFile(values["artifact-output"] as string, artifact)
  const evaluationOutputPath = await writeJsonFile(values["evaluation-output"] as string, evaluation)

  console.log(`Branch-eval baseline dataset written: ${datasetOutputPath}`)
  console.log(`Branch-eval baseline artifact written: ${artifactOutputPath}`)
  console.log(`Branch-eval baseline evaluation written: ${evaluationOutputPath}`)
  console.log(`pairwise_support_rate=${evaluation.pairwise_support_rate ?? "null"}`)
  console.log(`top1_not_contradicted_rate=${evaluation.top1_not_contradicted_rate ?? "null"}`)
}

main().catch((error) => {
  console.error("run-build-branch-eval-baseline-pipeline fatal error:", error)
  process.exit(1)
})
