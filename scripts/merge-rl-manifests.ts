// Merge two RL dataset manifests by copying secondary shards into primary shard dir
// and updating the primary manifest's metadata.
//
// Usage: bun run merge-rl-manifests.ts <primary-manifest.json> <secondary-manifest.json>
//
// The secondary shard files are copied (or moved) into the primary shard directory,
// and the primary manifest is updated with combined sample counts and shard entries.

import { copyFile, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { existsSync } from "node:fs"

interface RlDatasetManifestShardEntryV1 {
  shard_id: string
  relative_path: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
}

interface RlDatasetManifestV1 {
  schema_version: "rl_dataset_manifest.v1"
  generated_at: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
  samples_schema_version: string
  shard_schema_version: string
  shard_count: number
  shards: RlDatasetManifestShardEntryV1[]
}

async function main() {
  const primaryManifestPath = resolve(process.argv[2]!)
  const secondaryManifestPath = resolve(process.argv[3]!)

  if (!existsSync(primaryManifestPath)) {
    console.error(`Primary manifest not found: ${primaryManifestPath}`)
    process.exit(1)
  }
  if (!existsSync(secondaryManifestPath)) {
    console.error(`Secondary manifest not found: ${secondaryManifestPath}`)
    process.exit(1)
  }

  const primaryDir = dirname(primaryManifestPath)
  const secondaryDir = dirname(secondaryManifestPath)

  const primary: RlDatasetManifestV1 = JSON.parse(await readFile(primaryManifestPath, "utf8"))
  const secondary: RlDatasetManifestV1 = JSON.parse(await readFile(secondaryManifestPath, "utf8"))

  if (primary.schema_version !== "rl_dataset_manifest.v1") {
    console.error(`Primary is not a manifest: ${primary.schema_version}`)
    process.exit(1)
  }
  if (secondary.schema_version !== "rl_dataset_manifest.v1") {
    console.error(`Secondary is not a manifest: ${secondary.schema_version}`)
    process.exit(1)
  }

  // Determine primary shard directory
  // Shards are relative to the manifest file's directory
  const primaryShardDir = join(primaryDir, "rl-dataset.shards")
  const secondaryShardDir = join(secondaryDir, "rl-dataset-baseline.shards")

  // Renumber secondary shards to avoid ID conflicts with primary
  const primaryShardCount = primary.shards.length
  const mergedShardEntries: RlDatasetManifestShardEntryV1[] = [...primary.shards]

  // Merge by_matchup counts
  const mergedByMatchup = { ...primary.by_matchup }
  for (const [key, count] of Object.entries(secondary.by_matchup)) {
    mergedByMatchup[key] = (mergedByMatchup[key] ?? 0) + count
  }

  // Copy secondary shard files into primary shard dir with renumbered names
  let copiedShards = 0
  for (let i = 0; i < secondary.shards.length; i++) {
    const origShard = secondary.shards[i]!
    const newShardIndex = primaryShardCount + i + 1
    const newShardId = `shard-${String(newShardIndex).padStart(5, "0")}`
    const newShardFilename = `${newShardId}.json`

    const srcPath = join(secondaryShardDir, origShard.relative_path)
    const dstPath = join(primaryShardDir, newShardFilename)

    if (!existsSync(srcPath)) {
      console.warn(`  Warning: Secondary shard not found: ${srcPath}, skipping`)
      continue
    }

    await copyFile(srcPath, dstPath)
    copiedShards++

    mergedShardEntries.push({
      shard_id: newShardId,
      relative_path: newShardFilename,
      source_capture_count: origShard.source_capture_count,
      sample_count: origShard.sample_count,
      by_matchup: origShard.by_matchup,
    })
  }

  // Update primary manifest
  const mergedManifest: RlDatasetManifestV1 = {
    ...primary,
    source_capture_count: primary.source_capture_count + secondary.source_capture_count,
    sample_count: primary.sample_count + secondary.sample_count,
    by_matchup: mergedByMatchup,
    shard_count: mergedShardEntries.length,
    shards: mergedShardEntries,
    generated_at: new Date().toISOString(),
  }

  await writeFile(primaryManifestPath, JSON.stringify(mergedManifest) + "\n", "utf8")

  console.log(`Merged ${copiedShards} secondary shards into primary`)
  console.log(`Total samples: ${mergedManifest.sample_count} (primary: ${primary.sample_count}, secondary: ${secondary.sample_count})`)
  console.log(`Total shards: ${mergedManifest.shard_count}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
