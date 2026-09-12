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
import { TreeLake } from "../tree-lake.js"
import {
  ReplayWindowAligner,
  buildCanonicalFingerprintFromReplayPoint,
} from "../replay-alignment.js"

async function main() {
  const { values } = parseArgs({
    options: {
      "tree-lake": { type: "string", default: "./output/combat-windows/tree-lake.sqlite" },
      "benchmark-path": { type: "string", default: "" },
      "matchup-id": { type: "string", default: "" },
      "replay-dir": { type: "string", default: "" },
      threshold: { type: "string", default: "0.6" },
      status: { type: "string", default: "validated" },
      limit: { type: "string", default: "100" },
      "tree-id": { type: "string", default: "" },
    },
    strict: false,
  })

  const benchmarkPath = values["benchmark-path"] as string
  const matchupId = values["matchup-id"] as string
  const replayDir = values["replay-dir"] as string
  if (!benchmarkPath || !matchupId || !replayDir) {
    throw new Error("benchmark-path, matchup-id, and replay-dir are required")
  }

  const lake = new TreeLake(resolve(values["tree-lake"] as string))
  const aligner = new ReplayWindowAligner()
  const replayPoints = await aligner.collectReplayPoints({
    benchmarkPath,
    matchupId,
    replayDir,
  })

  try {
    const treeId = (values["tree-id"] as string) || ""
    const trees = treeId
      ? [lake.getTree(treeId)].filter((item): item is NonNullable<typeof item> => item != null)
      : lake.listTrees({
          status: values.status as "draft" | "validated" | "promoted" | "rejected",
          limit: Number(values.limit),
        })

    let matched = 0
    let unmatched = 0
    for (const tree of trees) {
      const summary = aligner.alignTreeToReplayPoints(tree, replayPoints, {
        threshold: Number(values.threshold),
      })
      summary.benchmark_path = resolve(benchmarkPath)
      lake.updateReplayAlignment({
        treeId: tree.tree_id,
        replayAlignment: summary,
      })
      if (summary.matched && summary.replay_file && summary.replay_entry_index != null) {
        const point = replayPoints.find((candidate) =>
          candidate.replay_file === summary.replay_file &&
          candidate.replay_entry_index === summary.replay_entry_index,
        )
        if (point) {
          lake.updateCanonicalFingerprint({
            treeId: tree.tree_id,
            canonicalFingerprint: buildCanonicalFingerprintFromReplayPoint(tree, point),
          })
        }
      }
      if (summary.matched) {
        matched += 1
      } else {
        unmatched += 1
      }
      console.log(`${tree.tree_id}: replay ${summary.matched ? "matched" : "unmatched"} similarity=${summary.similarity.toFixed(3)}`)
    }

    console.log(`Replay alignment complete. matched=${matched} unmatched=${unmatched}`)
  } finally {
    lake.close()
  }
}

main().catch((error) => {
  console.error("run-align-replay fatal error:", error)
  process.exit(1)
})
