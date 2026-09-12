// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { createWriteStream } from "node:fs"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { finished } from "node:stream/promises"
import { parseArgs } from "node:util"
import type { MlValueSample } from "../../contracts/index.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"
import {
  loadRlDatasetManifest,
  loadRlShardFromManifest,
} from "../../datasets/rl-input.js"
import { resolveCliPath } from "../../io/cli-path.js"
import type { DatasetSubsetKind } from "../../datasets/holdout.js"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      output: { type: "string", default: "./output/rl-value-dataset.json" },
      "dataset-id": { type: "string", default: "" },
      "include-unknown-outcome": { type: "boolean", default: false },
      subset: { type: "string", default: "all" },
      "holdout-fraction": { type: "string", default: "0" },
      "holdout-seed": { type: "string", default: "" },
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
    `  Streaming value export: ${manifest.shardPaths.length} shards, batch=${batchSize}`
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
  await writeChunk(stream, `,\n  ${JSON.stringify("samples")}: [`)

  let totalSamples = 0
  let isFirstItem = true

  for (let batchStart = 0; batchStart < manifest.shardPaths.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, manifest.shardPaths.length)
    const batchSamples: Awaited<ReturnType<typeof loadRlShardFromManifest>>["samples"][] = []

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

    const valueDataset = buildValueDatasetFromRlDataset(
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
        includeUnknownOutcome: Boolean(values["include-unknown-outcome"]),
        subset: parseSubset(values.subset as string),
        holdoutFraction: Number(values["holdout-fraction"]),
        holdoutSeed: (values["holdout-seed"] as string) || undefined,
      }
    )

    for (const sample of valueDataset.samples) {
      if (!isFirstItem) {
        await writeChunk(stream, ",")
      }
      isFirstItem = false
      await writeChunk(stream, "\n    " + JSON.stringify(sample))
      totalSamples++
    }

    batchSamples.length = 0
  }

  await writeChunk(stream, "\n  ]\n}\n")
  stream.end()
  await finished(stream)

  console.log(`RL value dataset written: ${outputPath}`)
  console.log(`samples=${totalSamples}`)
}

function parseSubset(value: string): DatasetSubsetKind {
  if (value === "all" || value === "train" || value === "holdout") {
    return value
  }
  throw new Error(`invalid subset: ${value}`)
}

async function writeChunk(
  stream: NodeJS.WritableStream,
  chunk: string
): Promise<void> {
  if (stream.write(chunk)) {
    return
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onDrain = () => { cleanup(); resolvePromise() }
    const onError = (error: Error) => { cleanup(); rejectPromise(error) }
    const cleanup = () => { stream.off("drain", onDrain); stream.off("error", onError) }
    stream.on("drain", onDrain)
    stream.on("error", onError)
  })
}

main().catch((error) => {
  console.error("run-export-rl-value-dataset fatal error:", error)
  process.exit(1)
})
