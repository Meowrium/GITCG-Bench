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

import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { finished } from "node:stream/promises"
import { parseArgs } from "node:util"
import type { MlRankingQueryGroup } from "../../contracts/index.js"
import { buildRankingDatasetFromRlDataset } from "../../datasets/rl.js"
import {
  loadRlDatasetManifest,
  loadRlShardFromManifest,
  type LoadedRlDatasetManifest,
} from "../../datasets/rl-input.js"
import { resolveCliPath } from "../../io/cli-path.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/rl-ranking-dataset.json" },
      "dataset-id": { type: "string", default: "" },
      "include-unchosen": { type: "boolean", default: false },
      "batch-size": { type: "string", default: "0" },
    },
    strict: false,
  })

  const inputPath = values.input as string
  if (!inputPath) {
    throw new Error("input is required")
  }

  const resolvedInput = resolveCliPath(inputPath)
  const manifest = await loadRlDatasetManifest(resolvedInput)
  const batchSize = Math.max(1, Number(values["batch-size"]) || manifest.shardPaths.length)

  console.log(
    `  Streaming export: ${manifest.shardPaths.length} shards, batch=${batchSize}`
  )

  const outputPath = resolveCliPath(values.output as string)
  await mkdir(dirname(outputPath), { recursive: true })
  const stream = createWriteStream(outputPath, { encoding: "utf8" })

  const datasetId =
    (values["dataset-id"] as string) || `rl_self_play__${manifest.sampleCount}`

  // Write header
  await writeChunk(stream, `{\n  ${JSON.stringify("dataset_id")}: ${JSON.stringify(datasetId)}`)
  await writeChunk(stream, `,\n  ${JSON.stringify("created_at")}: ${JSON.stringify(new Date().toISOString())}`)
  await writeChunk(stream, `,\n  ${JSON.stringify("metadata")}: ${JSON.stringify({
    source: "self_play",
    dataset_schema_version: manifest.schemaVersion,
    sample_count: manifest.sampleCount,
    source_capture_count: manifest.sourceCaptureCount,
    matchup_counts: manifest.byMatchup,
  })}`)
  await writeChunk(stream, `,\n  ${JSON.stringify("query_groups")}: [`)

  let totalQueryGroups = 0
  let isFirstItem = true

  // Process shards in batches
  for (let batchStart = 0; batchStart < manifest.shardPaths.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, manifest.shardPaths.length)
    const batchSamples: Awaited<ReturnType<typeof loadRlShardFromManifest>>["samples"][] = []

    // Load batch into memory
    for (let i = batchStart; i < batchEnd; i++) {
      const shard = await loadRlShardFromManifest(
        manifest.baseDir,
        manifest.shardPaths[i]!
      )
      batchSamples.push(shard.samples)
    }

    const allSamples = batchSamples.flat()
    console.log(
      `  Batch ${batchStart / batchSize + 1}: loaded ${batchEnd - batchStart} shards (${allSamples.length} samples)`
    )

    // Build ranking dataset from this batch
    const rankingDataset = buildRankingDatasetFromRlDataset(
      {
        schema_version: "rl_dataset.v1",
        generated_at: new Date().toISOString(),
        source_capture_count: 0,
        sample_count: allSamples.length,
        by_matchup: {},
        samples: allSamples,
      },
      {
        datasetId,
        includeUnchosenQueries: Boolean(values["include-unchosen"]),
      }
    )

    // Write query groups to stream
    for (const group of rankingDataset.query_groups) {
      if (!isFirstItem) {
        await writeChunk(stream, ",")
      }
      isFirstItem = false
      await writeChunk(stream, "\n    " + JSON.stringify(group))
      totalQueryGroups++
    }

    // Free batch memory
    batchSamples.length = 0
  }

  // Close JSON
  await writeChunk(stream, "\n  ]\n}\n")
  stream.end()
  await finished(stream)

  console.log(`RL ranking dataset written: ${outputPath}`)
  console.log(`query_groups=${totalQueryGroups}`)
}

async function writeChunk(
  stream: NodeJS.WritableStream,
  chunk: string
): Promise<void> {
  if (stream.write(chunk)) {
    return
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onDrain = () => {
      cleanup()
      resolvePromise()
    }
    const onError = (error: Error) => {
      cleanup()
      rejectPromise(error)
    }
    const cleanup = () => {
      stream.off("drain", onDrain)
      stream.off("error", onError)
    }
    stream.on("drain", onDrain)
    stream.on("error", onError)
  })
}

main().catch((error) => {
  console.error("run-export-rl-ranking-dataset fatal error:", error)
  process.exit(1)
})
