// Minimal script: build ranker + value artifacts without loading entire dataset into memory.
// Streaming shard-by-shard to avoid OOM in WSL.
import { parseArgs } from "node:util"
import { resolve, dirname } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import type { RlDatasetShardV1, RlDecisionPointSampleV1, ObservationV1 } from "../../contracts/rl-types.js"
import { readJsonFile } from "../../io/index.js"
import { loadRlDatasetManifest } from "../../datasets/rl-input.js"
import { buildObservationValueFeatureSlots } from "../../datasets/rl-value.js"
import {
  StreamingRankerStats,
  finalizeToArtifact,
  type StreamingRankerOptions,
} from "../../ranker/build-slot-linear-artifact-streaming.js"
import type { MlValueSample } from "../../contracts/index.js"
import type { LinearValueArtifact } from "../../value/artifact.js"

declare const process: any

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", default: "" },
      "output-dir": { type: "string", default: "./output" },
      prefix: { type: "string", default: "v14" },
      version: { type: "string", default: "" },
      "top-tags": { type: "string", default: "32" },
      "top-candidate-slots": { type: "string", default: "64" },
      "top-features": { type: "string", default: "64" },
    },
  })

  const inputPath = resolve(values.input as string)
  const outputDir = resolve(values["output-dir"] as string)
  const prefix = values.prefix as string
  const version = (values.version as string) || prefix
  mkdirSync(outputDir, { recursive: true })

  const manifest = await loadRlDatasetManifest(inputPath)
  const baseDir = manifest.baseDir
  const shardPaths = manifest.shardPaths.length > 0
    ? manifest.shardPaths
    : [inputPath] // single shard or monolithic dataset

  console.log(`Manifest: ${manifest.sampleCount} samples, ${shardPaths.length} shard(s)`)

  // ── Phase 1: Streaming ranker ──
  console.log("[Phase 1/2] Streaming ranker build...")
  const rankerStats = new StreamingRankerStats()
  let rankerSamples = 0

  for (let i = 0; i < shardPaths.length; i++) {
    const shardPath = resolve(baseDir, shardPaths[i]!)
    const shard = await readJsonFile<RlDatasetShardV1>(shardPath)
    const q = rankerStats.processShard(shard)
    rankerSamples += shard.samples.length
    console.log(`  shard ${i + 1}/${shardPaths.length}: +${q} queries, total queries=${rankerStats.totalQueries}`)
    // Drop the shard immediately
    ;(shard as any).samples = []
    const gcFn = (globalThis as any).gc
    if (typeof gcFn === "function") gcFn()
  }

  const rankerArtifact = finalizeToArtifact(rankerStats, {
    artifactVersion: `${version}_ranker`,
    topTagCount: Number(values["top-tags"]),
    topCandidateNumericSlotCount: Number(values["top-candidate-slots"]),
  })

  const rankerArtifactPath = resolve(outputDir, `${prefix}.ranker-artifact.json`)
  writeFileSync(rankerArtifactPath, JSON.stringify(rankerArtifact) + "\n")
  console.log(`  Ranker artifact: ${rankerArtifactPath}`)
  console.log(`  queries=${rankerStats.totalQueries}, samples=${rankerSamples}`)

  // ── Phase 2: Streaming value model (single pass) ──
  console.log("[Phase 2/2] Streaming value build...")
  const valueStats = new StreamingValueStats()
  for (let i = 0; i < shardPaths.length; i++) {
    const shardPath = resolve(baseDir, shardPaths[i]!)
    const shard = await readJsonFile<RlDatasetShardV1>(shardPath)
    valueStats.processShard(shard)
    ;(shard as any).samples = []
    const gcFn = (globalThis as any).gc
    if (typeof gcFn === "function") gcFn()
    if ((i + 1) % 5 === 0 || i === shardPaths.length - 1) {
      console.log(`  value ${i + 1}/${shardPaths.length}, samples=${valueStats.sampleCount}`)
    }
  }

  const valueArtifact = finalizeValueArtifact(valueStats, {
    artifactVersion: `${version}_value`,
    topFeatureCount: Number(values["top-features"]),
  })

  const valueArtifactPath = resolve(outputDir, `${prefix}.value-artifact.json`)
  writeFileSync(valueArtifactPath, JSON.stringify(valueArtifact) + "\n")
  console.log(`  Value artifact: ${valueArtifactPath}`)
  console.log(`  samples=${valueStats.sampleCount}, features=${Object.keys(valueArtifact.feature_weights).length}`)

  console.log("\nDone! All artifacts written.")
}

// ─────────────────────────────────────────────────────────────────────────────
// Value model streaming helpers (single-pass, same math as build-linear-value-artifact.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface ValuePathStat {
  count: number
  sumWeight: number
  sumValue: number
  sumTarget: number
  sumValueSq: number
  sumValueTarget: number
}

class StreamingValueStats {
  stats = new Map<string, ValuePathStat>()
  totalWeight = 0
  weightedTargetSum = 0
  sampleCount = 0

  processShard(shard: RlDatasetShardV1): void {
    for (const sample of shard.samples) {
      const vs = buildValueSample(sample)
      if (!vs) continue
      const weight = vs.weight ?? 1
      this.totalWeight += weight
      this.weightedTargetSum += vs.target_value * weight
      this.sampleCount++
      const flat = flattenNumericRecord(vs.feature_slots ?? {})
      for (const [path, value] of Object.entries(flat)) {
        const s = this.stats.get(path) ?? {
          count: 0,
          sumWeight: 0,
          sumValue: 0,
          sumTarget: 0,
          sumValueSq: 0,
          sumValueTarget: 0,
        }
        s.count++
        s.sumWeight += weight
        s.sumValue += value * weight
        s.sumTarget += vs.target_value * weight
        s.sumValueSq += value * value * weight
        s.sumValueTarget += value * vs.target_value * weight
        this.stats.set(path, s)
      }
    }
  }
}

function finalizeValueArtifact(
  stats: StreamingValueStats,
  options: { artifactVersion?: string; topFeatureCount?: number },
): LinearValueArtifact {
  const meanTarget = stats.totalWeight > 0 ? stats.weightedTargetSum / stats.totalWeight : 0

  const ranked = []
  for (const [path, stat] of stats.stats) {
    const meanValue = stat.sumValue / stat.sumWeight
    const meanTargetForFeature = stat.sumTarget / stat.sumWeight
    const variance = stat.sumValueSq / stat.sumWeight - meanValue * meanValue
    if (variance <= 0) continue
    const covariance = stat.sumValueTarget / stat.sumWeight - meanValue * meanTargetForFeature
    const weight = covariance / variance
    if (!Number.isFinite(weight) || weight === 0) continue
    ranked.push({ path, weight, support: stat.sumWeight })
  }

  ranked.sort((a, b) => {
    const absDiff = Math.abs(b.weight) - Math.abs(a.weight)
    if (absDiff !== 0) return absDiff
    return b.support - a.support
  })

  const topK = options.topFeatureCount ?? 32
  const selected = ranked.slice(0, topK)

  const featureWeights: Record<string, number> = {}
  let bias = meanTarget
  for (const entry of selected) {
    featureWeights[entry.path] = entry.weight
    const s = stats.stats.get(entry.path)
    const meanValue = s ? s.sumValue / s.sumWeight : 0
    bias -= entry.weight * meanValue
  }

  return {
    artifact_type: "linear_value_baseline.v1",
    artifact_version: options.artifactVersion ?? "streaming_value",
    created_at: new Date().toISOString(),
    bias,
    feature_weights: featureWeights,
    metadata: {
      dataset_id: `streaming__${stats.sampleCount}`,
      sample_count: stats.sampleCount,
    },
  }
}

// ── Lightweight value sample builder (inlined to avoid full dataset materialisation) ──

function buildValueSample(sample: RlDecisionPointSampleV1): MlValueSample | null {
  if (sample.outcome_label == null) {
    return null
  }
  const targetValue = sample.outcome_label
  const weight = sample.reward_breakdown == null
    ? 1
    : clamp(0.5 + Math.abs(sample.reward_breakdown.terminal) + Math.abs(sample.reward_breakdown.clipped_shaping_total), 0.25, 2)

  return {
    sample_id: sample.decision_point.decision_point_id,
    source: "self_play",
    state_ref: sample.observation.point.decision_point_id,
    target_value: targetValue,
    weight,
    context_slots: {},
    feature_slots: buildObservationValueFeatureSlots(sample.observation),
  }
}

import { flattenNumericRecord } from "../../utils/flatten.js"

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

main().catch((error) => {
  console.error("Fatal:", error)
  process.exit(1)
})
