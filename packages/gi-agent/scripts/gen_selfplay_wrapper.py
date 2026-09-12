#!/usr/bin/env python3
"""
Self-play wrapper config generator for Iter 2.
Embeds the diverse benchmark config into the self-play wrapper.
Supports game plan integration via plansDir + planStrategy.
"""

import json, os, sys

benchmark_path = sys.argv[1]
wrapper_path = sys.argv[2]
iter_dir = sys.argv[3]
games_multiplier = int(sys.argv[4])

# Optional: --plans-dir <path>
plans_dir = None
for i, arg in enumerate(sys.argv):
    if arg == "--plans-dir" and i + 1 < len(sys.argv):
        plans_dir = sys.argv[i + 1]

wrapper = {
    "benchmarkPath": os.path.abspath(benchmark_path),
    "gamesMultiplier": games_multiplier,
    "planStrategy": "compiled",
    "plansDir": plans_dir,
    "rlCapture": {
        "directory": os.path.join(os.path.abspath(iter_dir), "self-play-rl"),
        "modelVersion": "local_iter2",
        "viewKind": "policy_public",
        "gameVersion": "v6.3.0",
        "cardPoolVersion": "v6.3.0",
        "rulesetVersion": "default",
        "contractVersion": "obs.v1"
    },
    "dataset": {
        "manifestPath": os.path.join(os.path.abspath(iter_dir), "rl-dataset.manifest.json"),
        "shardDir": os.path.join(os.path.abspath(iter_dir), "rl-dataset.shards"),
        "maxSamplesPerShard": 2000,
        "includeSides": [0, 1],
        "requireChosenCandidate": True
    },
    "outputPath": os.path.join(os.path.abspath(iter_dir), "self-play-result.json")
}

with open(wrapper_path, "w", encoding="utf-8") as f:
    json.dump(wrapper, f, indent=2, ensure_ascii=False)

print(f"  Wrapper config: {wrapper_path}")
print(f"  SideA: GiMlPolicy (bootstrap iter3 ranker) + game plan")
print(f"  SideB: 3 archetypes (aggressive/defensive/neutral)")
if plans_dir:
    print(f"  Plans dir: {plans_dir}")
