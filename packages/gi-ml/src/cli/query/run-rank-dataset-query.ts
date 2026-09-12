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
import type {
  MlDecisionPoint,
  MlRankingDataset,
} from "../../contracts/index.js"
import type { RuntimeConceptState } from "../../runtime/index.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"
import { readSlotLinearRankerArtifact } from "../../ranker/json.js"
import { SlotLinearRanker } from "../../ranker/slot-linear-ranker.js"

async function main() {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "" },
      artifact: { type: "string", default: "" },
      output: { type: "string", default: "" },
      "query-id": { type: "string", default: "" },
      index: { type: "string", default: "0" },
      concepts: { type: "string", default: "" },
    },
    strict: false,
  })

  const datasetPath = values.dataset as string
  const artifactPath = values.artifact as string
  if (!datasetPath || !artifactPath) {
    throw new Error("dataset and artifact are required")
  }

  const dataset = await readJsonFile<MlRankingDataset>(resolve(datasetPath))
  const queryGroup = selectQueryGroup(dataset, {
    queryId: values["query-id"] as string,
    index: Number(values.index),
  })
  if (!queryGroup) {
    throw new Error("query group not found")
  }

  const artifact = await readSlotLinearRankerArtifact(resolve(artifactPath))
  const ranker = new SlotLinearRanker(artifact)
  const conceptState = values.concepts
    ? await readJsonFile<RuntimeConceptState>(resolve(values.concepts as string))
    : null

  const query: MlDecisionPoint = {
    query_id: queryGroup.query_id,
    source: queryGroup.source ?? "unknown",
    state_ref: queryGroup.state_ref ?? null,
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: queryGroup.candidates.map((candidate) => candidate.candidate_id),
    evidence_refs: [],
    context_slots: queryGroup.context_slots ?? null,
  }

  const result = await ranker.rank({
    query,
    candidates: queryGroup.candidates,
    concept_state: conceptState,
  })

  if (values.output) {
    await writeJsonFile(values.output as string, result)
    console.log(`Rank result written: ${resolve(values.output as string)}`)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}

function selectQueryGroup(
  dataset: MlRankingDataset,
  args: {
    queryId: string
    index: number
  },
) {
  if (args.queryId) {
    return dataset.query_groups.find((group) => group.query_id === args.queryId) ?? null
  }
  return dataset.query_groups[args.index] ?? null
}

main().catch((error) => {
  console.error("run-rank-dataset-query fatal error:", error)
  process.exit(1)
})
