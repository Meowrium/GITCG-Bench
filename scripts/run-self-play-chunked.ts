// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Chunked self-play runner — splits matchups into chunks to reduce peak memory.
 *
 * Instead of running all matchups in a single process (which loads all captures
 * into memory before exporting shards), this script:
 * 1. Reads the self-play config
 * 2. Splits matchups into chunks of N
 * 3. For each chunk, runs self-play and exports shards incrementally
 * 4. Merges all chunk manifests at the end
 *
 * Usage:
 *   bun run scripts/run-self-play-chunked.ts <config.json> --chunk-size <N>
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { execSync } from "node:child_process"

interface SelfPlayConfig {
  benchmarkPath: string
  gamesMultiplier?: number
  rlCapture: {
    directory: string
    modelVersion: string
    viewKind?: string
    rewardConfig?: unknown
    gameVersion?: string
    cardPoolVersion?: string
    rulesetVersion?: string
    contractVersion?: string
  }
  replayLogCapture?: {
    directory: string
    maxGamesPerMatchup: number
  }
  dataset: {
    outputPath?: string
    manifestPath?: string
    shardDir?: string
    maxSamplesPerShard?: number
    includeSides?: Array<0 | 1>
    requireChosenCandidate?: boolean
    excludeDrawMatchups?: string[]
  }
  sideA?: unknown
  sideB?: unknown
  outputPath?: string
}

interface BenchmarkConfig {
  matchups: Array<{
    id: string
    games: number
    deck0: string
    deck1: string
    sideA?: unknown
    sideB?: unknown
  }>
}

interface ManifestShard {
  shard_id: string
  relative_path: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
}

interface Manifest {
  schema_version: string
  generated_at: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
  samples_schema_version: string
  shard_schema_version: string
  shard_count: number
  shards: ManifestShard[]
}

async function main() {
  const args = process.argv.slice(2)
  const configPath = resolve(args[0])
  let chunkSize = 0
  let cwd = process.cwd()

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--chunk-size" && args[i + 1]) {
      chunkSize = Number(args[i + 1])
      i++
    } else if (args[i] === "--cwd" && args[i + 1]) {
      cwd = args[i + 1]
      i++
    }
  }

  if (!chunkSize || chunkSize <= 0) {
    console.error("Usage: bun run run-self-play-chunked.ts <config.json> --chunk-size <N>")
    process.exit(1)
  }

  const configDir = dirname(configPath)
  const config: SelfPlayConfig = JSON.parse(await readFile(configPath, "utf8"))

  // Read benchmark to get matchup count
  const benchmarkPath = resolve(configDir, config.benchmarkPath)
  const benchmark: BenchmarkConfig = JSON.parse(await readFile(benchmarkPath, "utf8"))
  const matchups = benchmark.matchups
  const totalMatchups = matchups.length

  console.log(`[Chunked] Total matchups: ${totalMatchups}, chunk size: ${chunkSize}`)
  console.log(`[Chunked] Will run ${Math.ceil(totalMatchups / chunkSize)} chunks`)

  // Prepare output directories
  const manifestPath = config.dataset.manifestPath
    ? resolve(configDir, config.dataset.manifestPath)
    : null
  const shardDir = config.dataset.shardDir
    ? resolve(configDir, config.dataset.shardDir)
    : null

  if (!manifestPath || !shardDir) {
    console.error("[Chunked] Error: manifestPath and shardDir must be specified in config")
    process.exit(1)
  }

  mkdirSync(shardDir, { recursive: true })

  // We need to create a split benchmark that only contains a subset of matchups.
  // Instead of modifying the self-play runner, we'll create per-chunk configs
  // that point to per-chunk benchmarks, then merge the resulting manifests.

  const allShards: ManifestShard[] = []
  let totalSamples = 0
  let totalCaptures = 0
  const globalByMatchup: Record<string, number> = {}
  let globalShardIndex = 0

  // Read existing shards to continue from where we left off
  const existingFiles = readdirSync(shardDir).filter(f => f.endsWith(".json"))
  if (existingFiles.length > 0) {
    globalShardIndex = existingFiles.length
    console.log(`[Chunked] Found ${existingFiles.length} existing shards, will continue from shard ${globalShardIndex + 1}`)
  }

  for (let chunkStart = 0; chunkStart < totalMatchups; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, totalMatchups)
    const chunkMatchups = matchups.slice(chunkStart, chunkEnd)
    const chunkIndex = Math.floor(chunkStart / chunkSize)

    console.log(`\n[Chunked] === Chunk ${chunkIndex + 1}/${Math.ceil(totalMatchups / chunkSize)}: matchups ${chunkStart + 1}-${chunkEnd} ===`)

    // Create a temporary benchmark with only this chunk's matchups
    const chunkBenchmark = { ...benchmark, matchups: chunkMatchups }
    const chunkBenchmarkPath = join(configDir, `chunk-${chunkIndex}-benchmark.json`)
    writeFileSync(chunkBenchmarkPath, JSON.stringify(chunkBenchmark), "utf8")

    // Create chunk self-play config pointing to the chunk benchmark
    const chunkConfig: SelfPlayConfig = {
      ...config,
      benchmarkPath: chunkBenchmarkPath,
      rlCapture: {
        ...config.rlCapture,
        directory: join(configDir, `chunk-${chunkIndex}-rl`),
      },
      replayLogCapture: config.replayLogCapture
        ? {
            ...config.replayLogCapture,
            directory: join(configDir, `chunk-${chunkIndex}-replay`),
          }
        : undefined,
      dataset: {
        ...config.dataset,
        manifestPath: join(configDir, `chunk-${chunkIndex}-manifest.json`),
        shardDir: join(configDir, `chunk-${chunkIndex}-shards`),
      },
      outputPath: join(configDir, `chunk-${chunkIndex}-result.json`),
    }
    const chunkConfigPath = join(configDir, `chunk-${chunkIndex}-config.json`)
    writeFileSync(chunkConfigPath, JSON.stringify(chunkConfig), "utf8")

    // Run self-play for this chunk
    const runnerScript = "src/learning/rl/cli/run-self-play-rl-smoke.ts"
    console.log(`[Chunked] Running: bun run --smol ${runnerScript} ${chunkConfigPath}`)

    try {
      execSync(`bun run --smol ${runnerScript} ${chunkConfigPath}`, {
        cwd,
        stdio: "inherit",
        timeout: 30 * 60 * 1000, // 30 min timeout per chunk
      })
    } catch (e) {
      console.error(`[Chunked] Chunk ${chunkIndex + 1} failed: ${e}`)
      // Continue with next chunk rather than aborting
    }

    // Read chunk manifest and merge shards
    const chunkManifestPath = chunkConfig.dataset.manifestPath!
    try {
      const chunkManifest: Manifest = JSON.parse(await readFile(chunkManifestPath, "utf8"))
      totalSamples += chunkManifest.sample_count
      totalCaptures += chunkManifest.source_capture_count

      for (const [matchupId, count] of Object.entries(chunkManifest.by_matchup)) {
        globalByMatchup[matchupId] = (globalByMatchup[matchupId] ?? 0) + count
      }

      // Copy shards to global shard dir with renumbered IDs
      const chunkShardDir = chunkConfig.dataset.shardDir!
      for (const shard of chunkManifest.shards) {
        globalShardIndex++
        const newShardId = `shard-${String(globalShardIndex).padStart(5, "0")}`
        const srcPath = join(chunkShardDir, shard.relative_path)
        const dstPath = join(shardDir, `${newShardId}.json`)
        await copyFile(srcPath, dstPath)
        allShards.push({
          shard_id: newShardId,
          relative_path: `${newShardId}.json`,
          source_capture_count: shard.source_capture_count,
          sample_count: shard.sample_count,
          by_matchup: shard.by_matchup,
        })
      }

      console.log(`[Chunked] Chunk ${chunkIndex + 1} complete: ${chunkManifest.sample_count} samples, ${chunkManifest.shards.length} shards`)
    } catch (e) {
      console.error(`[Chunked] Could not read chunk manifest: ${e}`)
    }

    // Clean up chunk temp files
    try {
      rmSync(join(configDir, `chunk-${chunkIndex}-benchmark.json`), { force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-config.json`), { force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-manifest.json`), { force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-result.json`), { force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-rl`), { recursive: true, force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-replay`), { recursive: true, force: true })
      rmSync(join(configDir, `chunk-${chunkIndex}-shards`), { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }

    // Force GC between chunks
    if (typeof globalThis.gc === "function") {
      globalThis.gc()
    }
  }

  // Write final merged manifest
  const finalManifest: Manifest = {
    schema_version: "rl_dataset_manifest.v1",
    generated_at: new Date().toISOString(),
    source_capture_count: totalCaptures,
    sample_count: totalSamples,
    by_matchup: globalByMatchup,
    samples_schema_version: "rl_dataset.v1",
    shard_schema_version: "rl_dataset_shard.v1",
    shard_count: allShards.length,
    shards: allShards,
  }

  writeFileSync(manifestPath, JSON.stringify(finalManifest), "utf8")
  console.log(`\n[Chunked] === All chunks complete ===`)
  console.log(`[Chunked] Total: ${totalSamples} samples, ${allShards.length} shards, ${totalCaptures} captures`)
  console.log(`[Chunked] Manifest: ${manifestPath}`)
}

main().catch((error) => {
  console.error("Chunked self-play fatal error:", error)
  process.exit(1)
})
