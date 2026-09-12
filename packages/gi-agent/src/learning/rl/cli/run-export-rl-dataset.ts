// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { writeJsonFile } from "../../combat-windows/artifact-utils.js"
import {
  exportRlDatasetSamplesFromCapture,
  exportRlDatasetV1,
} from "../export-dataset.js"
import type {
  RlDatasetManifestShardEntryV1,
  RlDatasetManifestV1,
  RlDatasetShardV1,
  SelfPlayRlGameCaptureV1,
} from "@gi-tcg/ml/contracts"

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "./output/self-play-rl" },
      output: { type: "string", default: "./output/rl-dataset.json" },
      "output-manifest": { type: "string", default: "" },
      "shard-dir": { type: "string", default: "" },
      "max-samples-per-shard": { type: "string", default: "2000" },
      side: { type: "string", multiple: true },
      "require-chosen": { type: "boolean", default: false },
      "exclude-draw-matchup": { type: "string", multiple: true },
    },
    strict: false,
  })

  const inputDir = resolve(values.input as string)
  const outputPath = resolve(values.output as string)
  const outputManifestPath = normalizeOptionalPath(values["output-manifest"] as string, outputPath, ".manifest.json")
  const shardDir = normalizeOptionalDir(values["shard-dir"] as string, outputPath)
  const maxSamplesPerShard = Math.max(1, Number(values["max-samples-per-shard"] as string) || 2000)
  const capturePaths = await collectCapturePaths(inputDir)
  const includeSides = normalizeSides(values.side as string[] | undefined)
  const requireChosenCandidate = values["require-chosen"] as boolean
  const excludeDrawMatchups = normalizeMatchupIds(
    values["exclude-draw-matchup"] as string[] | undefined,
  )

  if (outputManifestPath || shardDir) {
    const manifest = await exportShardedRlDataset({
      capturePaths,
      outputManifestPath: outputManifestPath ?? replaceJsonSuffix(outputPath, ".manifest.json"),
      shardDir: shardDir ?? replaceJsonSuffix(outputPath, ".shards"),
      includeSides,
      requireChosenCandidate,
      excludeDrawMatchups,
      maxSamplesPerShard,
    })
    console.log(`RL captures: ${manifest.source_capture_count}`)
    console.log(`RL samples: ${manifest.sample_count}`)
    console.log(`Shard count: ${manifest.shard_count}`)
    console.log(`Manifest: ${outputManifestPath ?? replaceJsonSuffix(outputPath, ".manifest.json")}`)
    console.log(`Shard dir: ${shardDir ?? replaceJsonSuffix(outputPath, ".shards")}`)
    return
  }

  const captures = await Promise.all(capturePaths.map(readCaptureFile))
  const dataset = exportRlDatasetV1(captures, {
    includeSides,
    requireChosenCandidate,
    excludeDrawMatchups,
  })
  await writeJsonFile(outputPath, dataset)
  console.log(`RL captures: ${captures.length}`)
  console.log(`RL samples: ${dataset.sample_count}`)
  console.log(`Output: ${outputPath}`)
}

async function collectCapturePaths(rootDir: string): Promise<string[]> {
  const queue = [rootDir]
  const results: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const resolved = resolve(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(resolved)
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".rl.json")) {
        results.push(resolved)
      }
    }
  }
  return results.sort((a, b) => a.localeCompare(b))
}

async function readCaptureFile(path: string): Promise<SelfPlayRlGameCaptureV1> {
  return JSON.parse(await readFile(path, "utf8")) as SelfPlayRlGameCaptureV1
}

function normalizeSides(rawSides: string[] | undefined): ReadonlyArray<0 | 1> | undefined {
  if (!rawSides || rawSides.length === 0) {
    return undefined
  }
  return rawSides.flatMap((value) => {
    if (value === "0") return [0]
    if (value === "1") return [1]
    return []
  })
}

function normalizeMatchupIds(rawMatchups: string[] | undefined): ReadonlyArray<string> | undefined {
  if (!rawMatchups || rawMatchups.length === 0) {
    return undefined
  }
  return [...new Set(rawMatchups.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  )
}

async function exportShardedRlDataset(args: {
  capturePaths: readonly string[]
  outputManifestPath: string
  shardDir: string
  includeSides?: ReadonlyArray<0 | 1>
  requireChosenCandidate: boolean
  excludeDrawMatchups?: ReadonlyArray<string>
  maxSamplesPerShard: number
}): Promise<RlDatasetManifestV1> {
  await mkdir(args.shardDir, { recursive: true })

  const globalByMatchup = new Map<string, number>()
  const shardEntries: RlDatasetManifestShardEntryV1[] = []
  let currentSamples = [] as RlDatasetShardV1["samples"]
  let currentCaptureCount = 0
  let currentByMatchup = new Map<string, number>()
  let totalSamples = 0
  let shardCount = 0

  const flushShard = async () => {
    if (currentSamples.length === 0) {
      return
    }
    shardCount += 1
    const shardId = `shard-${String(shardCount).padStart(5, "0")}`
    const shard: RlDatasetShardV1 = {
      schema_version: "rl_dataset_shard.v1",
      generated_at: new Date().toISOString(),
      shard_id: shardId,
      source_capture_count: currentCaptureCount,
      sample_count: currentSamples.length,
      by_matchup: toSortedRecord(currentByMatchup),
      samples: currentSamples,
    }
    const shardFilename = `${shardId}.json`
    await writeCompactJson(join(args.shardDir, shardFilename), shard)
    shardEntries.push({
      shard_id: shardId,
      relative_path: shardFilename,
      source_capture_count: shard.source_capture_count,
      sample_count: shard.sample_count,
      by_matchup: shard.by_matchup,
    })
    currentSamples = []
    currentCaptureCount = 0
    currentByMatchup = new Map<string, number>()
  }

  for (const capturePath of args.capturePaths) {
    const capture = await readCaptureFile(capturePath)
    const samples = exportRlDatasetSamplesFromCapture(capture, {
      includeSides: args.includeSides,
      requireChosenCandidate: args.requireChosenCandidate,
      excludeDrawMatchups: args.excludeDrawMatchups,
    })
    currentSamples.push(...samples)
    currentCaptureCount += 1
    totalSamples += samples.length
    addMatchupCount(globalByMatchup, capture.matchup_id, samples.length)
    addMatchupCount(currentByMatchup, capture.matchup_id, samples.length)
    if (currentSamples.length >= args.maxSamplesPerShard) {
      await flushShard()
    }
  }
  await flushShard()

  const manifest: RlDatasetManifestV1 = {
    schema_version: "rl_dataset_manifest.v1",
    generated_at: new Date().toISOString(),
    source_capture_count: args.capturePaths.length,
    sample_count: totalSamples,
    by_matchup: toSortedRecord(globalByMatchup),
    samples_schema_version: "rl_dataset.v1",
    shard_schema_version: "rl_dataset_shard.v1",
    shard_count: shardEntries.length,
    shards: shardEntries,
  }
  await writeCompactJson(args.outputManifestPath, manifest)
  return manifest
}

function normalizeOptionalPath(raw: string, outputPath: string, suffix: string): string | null {
  if (raw && raw.length > 0) {
    return resolve(raw)
  }
  return null
}

function normalizeOptionalDir(raw: string, outputPath: string): string | null {
  if (raw && raw.length > 0) {
    return resolve(raw)
  }
  return null
}

function replaceJsonSuffix(path: string, replacement: string): string {
  return path.endsWith(".json") ? `${path.slice(0, -5)}${replacement}` : `${path}${replacement}`
}

function addMatchupCount(map: Map<string, number>, matchupId: string, count: number): void {
  map.set(matchupId, (map.get(matchupId) ?? 0) + count)
}

function toSortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

async function writeCompactJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8")
}

main().catch((error) => {
  console.error("run-export-rl-dataset fatal error:", error)
  process.exit(1)
})
