// Copyright (C) 2024-2025 Guyutongxue
//
// Streaming ranker builder CLI — process RL shards incrementally.

import { parseArgs } from "node:util"
import { dirname, join, resolve } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { loadRlDatasetInput as loadManifest } from "../../datasets/rl-input.js"
import { readJsonFile, writeJsonFile } from "../../io/index.js"
import {
  StreamingRankerStats,
  finalizeToArtifact,
} from "../../ranker/build-slot-linear-artifact-streaming.js"
import { buildLinearValueArtifactFromDataset } from "../../value/build-linear-value-artifact.js"
import { evaluateValueDataset } from "../../value/evaluate.js"
import { buildValueDatasetFromRlDataset } from "../../datasets/rl-value.js"
import type { RlDatasetShardV1 } from "../../contracts/rl-types.js"

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output/streaming-ranker" },
      prefix: { type: "string", default: "streaming" },
      "top-tags": { type: "string", default: "32" },
      "top-candidate-slots": { type: "string", default: "24" },
      "max-shards": { type: "string", default: "0" },
      "artifact-version": { type: "string", default: "" },
    },
    strict: false,
  })

  const manifestPath = values.manifest as string
  if (!manifestPath) {
    console.error("Usage: pnpm exec gnx run-build-ranker-streaming.ts --manifest <manifest.json> [options]")
    process.exit(1)
  }

  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string
  const topTags = Number(values["top-tags"])
  const topSlots = Number(values["top-candidate-slots"])
  const maxShards = Number(values["max-shards"])
  const artifactVersion = (values["artifact-version"] as string) || `streaming_${prefix}`

  await mkdir(outputDir, { recursive: true })

  // Load manifest
  console.log(`[StreamRanker] Loading manifest: ${manifestPath}`)
  const manifestDir = dirname(resolve(manifestPath))
  const manifest = await readJsonFile<{
    shards: Array<{ relative_path: string; sample_count: number }>
    sample_count: number
  }>(resolve(manifestPath))

  const shardList = maxShards > 0 ? manifest.shards.slice(0, maxShards) : manifest.shards
  console.log(`[StreamRanker] Processing ${shardList.length}/${manifest.shards.length} shards (${manifest.sample_count} total samples)...`)

  // ── Phase 1: Streaming ranker stats ──
  const stats = new StreamingRankerStats()
  let totalSamples = 0

  for (let i = 0; i < shardList.length; i++) {
    const relPath = shardList[i]!.relative_path

    // Try multiple locations for shard
    let shardPath = resolve(manifestDir, relPath)
    try { await readFile(shardPath) } catch {
      shardPath = resolve(manifestDir, "rl-dataset.shards", relPath)
      try { await readFile(shardPath) } catch {
        shardPath = resolve(manifestDir, "self-play-rl", relPath)
      }
    }

    const shard = await readJsonFile<RlDatasetShardV1>(shardPath)
    const queries = stats.processShard(shard)
    totalSamples += shard.sample_count ?? shard.samples.length

    if ((i + 1) % 5 === 0 || i === shardList.length - 1) {
      console.log(`  Shard ${i + 1}/${shardList.length}: ${queries} queries from ${shard.sample_count} samples (total: ${stats.totalQueries} queries, ${totalSamples} samples)`)
    }
  }

  console.log(`[StreamRanker] Accumulated stats: ${stats.totalQueries} queries, ${stats.actionCaseStats.size} action cases, ${stats.tagStats.size} tags, ${stats.numericSlotStats.size} numeric slots`)

  // ── Phase 2: Finalize ranker artifact ──
  const artifact = finalizeToArtifact(stats, {
    artifactVersion,
    topTagCount: topTags,
    topCandidateNumericSlotCount: topSlots,
  })

  console.log(`[StreamRanker] Ranker artifact: ${Object.keys(artifact.config.action_case_bias).length} action biases, ${Object.keys(artifact.config.candidate_tag_bias).length} tag biases, ${Object.keys(artifact.config.candidate_numeric_slot_weights).length} numeric weights`)

  // Write ranker artifact
  const rankerPath = join(outputDir, `${prefix}.ranker-artifact.json`)
  await writeJsonFile(rankerPath, artifact)
  console.log(`[StreamRanker] Ranker artifact: ${rankerPath}`)

  // ── Phase 3: Value dataset + linear value (if enough memory) ──
  console.log(`[StreamRanker] Phase 3: Building value dataset (from first ${Math.min(shardList.length, 10)} shards for linear value)...`)
  // For linear value we only need ~10K samples
  const valueShards = shardList.slice(0, Math.min(10, shardList.length))
  const valueSamples: unknown[] = []
  for (let i = 0; i < valueShards.length; i++) {
    const relPath = valueShards[i]!.relative_path
    let shardPath = resolve(manifestDir, relPath)
    try { await readFile(shardPath) } catch {
      shardPath = resolve(manifestDir, "rl-dataset.shards", relPath)
      try { await readFile(shardPath) } catch {
        shardPath = resolve(manifestDir, "self-play-rl", relPath)
      }
    }
    const shard = await readJsonFile<RlDatasetShardV1>(shardPath)
    valueSamples.push(...shard.samples)
  }

  // Build a minimal RlDatasetV1 for value training
  const miniRlDataset = {
    schema_version: "rl_dataset.v1" as const,
    generated_at: new Date().toISOString(),
    source_capture_count: valueShards.length,
    sample_count: valueSamples.length,
    by_matchup: {},
    samples: valueSamples as Parameters<typeof buildValueDatasetFromRlDataset>[0]["samples"],
  }

  const valueDataset = buildValueDatasetFromRlDataset(miniRlDataset, {
    datasetId: `${prefix}_value`,
  })

  console.log(`[StreamRanker] Value dataset: ${valueDataset.samples.length} samples`)

  const linearValueArtifact = buildLinearValueArtifactFromDataset(valueDataset, {
    artifactVersion: `${artifactVersion}_linear_value`,
  })

  const valueArtifactPath = join(outputDir, `${prefix}.value-artifact.json`)
  await writeJsonFile(valueArtifactPath, linearValueArtifact)
  console.log(`[StreamRanker] Linear value artifact: ${valueArtifactPath}`)

  // Evaluate
  const evalResult = evaluateValueDataset(linearValueArtifact, valueDataset)
  const evalPath = join(outputDir, `${prefix}.value-eval.json`)
  await writeJsonFile(evalPath, {
    ...evalResult,
    sample_count: valueSamples.length,
  })
  console.log(`[StreamRanker] Value eval: ${evalPath}`)
  console.log(`  MAE: ${evalResult.mae?.toFixed(4) ?? "?"}  RMSE: ${evalResult.rmse?.toFixed(4) ?? "?"}`)

  // Write bundle summary
  const bundle = {
    schema_version: "warm_start_bundle.v1",
    created_at: new Date().toISOString(),
    ranker: artifact,
    linear_value: linearValueArtifact,
    metrics: {
      ranking: { query_count: stats.totalQueries },
      value: evalResult,
    },
  }
  const bundlePath = join(outputDir, `${prefix}.bundle.json`)
  await writeJsonFile(bundlePath, bundle)
  console.log(`[StreamRanker] Bundle: ${bundlePath}`)
  console.log(`[StreamRanker] Done.`)
}

main().catch((error) => {
  console.error("[StreamRanker] Fatal:", error)
  process.exit(1)
})
