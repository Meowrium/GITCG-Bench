// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { dirname, resolve } from "node:path"
import type {
  RlDatasetManifestV1,
  RlDatasetShardV1,
  RlDatasetV1,
  RlDecisionPointSampleV1,
} from "../contracts/rl-types.js"
import { readJsonFile } from "../io/index.js"

type SupportedRlInput = RlDatasetV1 | RlDatasetManifestV1 | RlDatasetShardV1

export interface LoadedRlDatasetManifest {
  baseDir: string
  schemaVersion: string
  sampleCount: number
  sourceCaptureCount: number
  byMatchup: Record<string, number>
  shardPaths: string[]
}

export async function loadRlDatasetManifest(
  inputPath: string,
): Promise<LoadedRlDatasetManifest> {
  const resolvedPath = resolve(inputPath)
  const input = await readJsonFile<SupportedRlInput>(resolvedPath)
  const baseDir = dirname(resolvedPath)

  if (input.schema_version === "rl_dataset.v1") {
    return {
      baseDir,
      schemaVersion: input.schema_version,
      sampleCount: input.sample_count,
      sourceCaptureCount: input.source_capture_count,
      byMatchup: input.by_matchup,
      shardPaths: [],
    }
  }

  if (input.schema_version === "rl_dataset_shard.v1") {
    return {
      baseDir,
      schemaVersion: input.schema_version,
      sampleCount: input.sample_count,
      sourceCaptureCount: input.source_capture_count,
      byMatchup: input.by_matchup,
      shardPaths: [],
    }
  }

  // rl_dataset_manifest.v1
  return {
    baseDir,
    schemaVersion: input.schema_version,
    sampleCount: input.sample_count,
    sourceCaptureCount: input.source_capture_count,
    byMatchup: input.by_matchup,
    shardPaths: input.shards.map((s) => s.relative_path),
  }
}

export async function loadRlShardFromManifest(
  manifestDir: string,
  relativePath: string,
): Promise<{ samples: RlDecisionPointSampleV1[] }> {
  const directPath = resolve(manifestDir, relativePath)
  try {
    const shard = await readJsonFile<RlDatasetShardV1>(directPath)
    return { samples: shard.samples }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
  }

  const shardDirFallbackPath = resolve(manifestDir, "rl-dataset.shards", relativePath)
  const shard = await readJsonFile<RlDatasetShardV1>(shardDirFallbackPath)
  return { samples: shard.samples }
}

export async function loadRlDatasetInput(inputPath: string): Promise<RlDatasetV1> {
  const resolvedPath = resolve(inputPath)
  const input = await readJsonFile<SupportedRlInput>(resolvedPath)

  if (input.schema_version === "rl_dataset.v1") {
    return input
  }

  if (input.schema_version === "rl_dataset_shard.v1") {
    return {
      schema_version: "rl_dataset.v1",
      generated_at: input.generated_at,
      source_capture_count: input.source_capture_count,
      sample_count: input.sample_count,
      by_matchup: input.by_matchup,
      samples: input.samples,
    }
  }

  const baseDir = dirname(resolvedPath)
  const shardPaths = input.shards.map((s) => s.relative_path)
  console.log(`  Loading ${shardPaths.length} shards from manifest...`)
  const samples: RlDecisionPointSampleV1[] = []
  for (let i = 0; i < shardPaths.length; i++) {
    const shard = await loadRlShardFromManifest(baseDir, shardPaths[i]!)
    samples.push(...shard.samples)
    if ((i + 1) % 5 === 0 || i === shardPaths.length - 1) {
      console.log(`  Loaded shard ${i + 1}/${shardPaths.length} (${samples.length} samples so far)`)
    }
  }
  const sampleCount = samples.length
  if (sampleCount !== input.sample_count) {
    throw new Error(
      `RL dataset manifest sample_count mismatch: manifest=${input.sample_count} actual=${sampleCount}`,
    )
  }

  return {
    schema_version: "rl_dataset.v1",
    generated_at: input.generated_at,
    source_capture_count: input.source_capture_count,
    sample_count: sampleCount,
    by_matchup: input.by_matchup,
    samples,
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}
