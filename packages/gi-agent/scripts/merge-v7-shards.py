#!/usr/bin/env python3
"""Merge 4 shard captures into unified rl-dataset-v7, then train."""
import json, os, glob, subprocess, sys

BASE = "/mnt/d/AI/GTCG/genius-invokation/packages/gi-agent/output/local-training"
SHARDS = 4

def find_capture_files(shard_i):
    """Find all .rl.json capture files in shard directory."""
    capture_dir = os.path.join(BASE, f"rl-capture-v7-shard{shard_i}")
    if not os.path.isdir(capture_dir):
        print(f"WARNING: {capture_dir} not found")
        return []
    files = glob.glob(os.path.join(capture_dir, "**", "*.rl.json"), recursive=True)
    files.sort()
    return files

def main():
    # 1. Collect all capture files
    all_captures = []
    for i in range(SHARDS):
        files = find_capture_files(i)
        print(f"Shard {i}: {len(files)} capture files")
        all_captures.extend(files)
    print(f"Total: {len(all_captures)} capture files")

    # 2. Count total samples
    total_samples = 0
    by_matchup = {}
    for f in all_captures:
        try:
            with open(f) as fh:
                cap = json.load(fh)
            n = len(cap.get("samples", cap.get("decision_points", [])))
            total_samples += n
            mid = cap.get("matchup_id", "unknown")
            by_matchup[mid] = by_matchup.get(mid, 0) + n
        except Exception as e:
            print(f"  Error reading {f}: {e}")

    print(f"\nTotal samples across all shards: {total_samples}")
    print(f"Matchups: {len(by_matchup)}")
    for mid, n in sorted(by_matchup.items()):
        print(f"  {mid}: {n}")

    # 3. Write merged manifest
    manifest = {
        "schema_version": "rl_dataset_manifest.v1",
        "generated_at": __import__('datetime').datetime.now().isoformat(),
        "sample_count": total_samples,
        "source_capture_count": len(all_captures),
        "by_matchup": dict(sorted(by_matchup.items())),
        "source": "v7-macro-plan-merged",
        "shard_dirs": [f"rl-capture-v7-shard{i}" for i in range(SHARDS)]
    }
    manifest_path = os.path.join(BASE, "rl-dataset-v7-merged-manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"\nManifest: {manifest_path}")
    print(f"Samples: {total_samples}")

if __name__ == "__main__":
    main()
