#!/usr/bin/env python3
"""
Export GBRL model trees to JSON for TypeScript inference.

Usage:
  python export_gbrl_trees.py --model v20.gbrl_model --features v20.features.json --output v20.trees.json

Output format:
  {
    "bias": 0.5,
    "feature_names": [...],
    "trees": [
      {
        "depth": 5,
        "levels": [
          {"feature_idx": 12, "threshold": 0.5},
          {"feature_idx": 34, "threshold": -0.2},
          ...
        ],
        "leaves": [0.123, -0.456, ...]  # 2^depth values
      },
      ...
    ]
  }
"""

import argparse
import json
import re
import sys
import io
from pathlib import Path

import numpy as np


def export_model_to_json(model_path, features_path, output_path):
    from gbrl.models import GBTModel

    # Load model
    mp = Path(model_path)
    if not mp.exists():
        mp = Path(f"{model_path}.gbrl_model")
    if not mp.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    with open(features_path, "r", encoding="utf-8") as f:
        features_data = json.load(f)

    model = GBTModel.load_learner(str(mp), device="cpu")
    num_trees = model.get_num_trees()
    if isinstance(num_trees, tuple):
        num_trees = num_trees[0]

    print(f"Exporting {num_trees} trees...", file=sys.stderr)

    # Capture print_tree output for all trees
    trees = []
    for tree_idx in range(num_trees):
        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        model.print_tree(tree_idx)
        output = sys.stdout.getvalue()
        sys.stdout = old_stdout

        tree = parse_tree_output(output)
        if tree:
            trees.append(tree)

    print(f"Exported {len(trees)} trees", file=sys.stderr)

    # Build export JSON
    export = {
        "bias": float(features_data.get("bias", 0.0)),
        "feature_names": features_data.get("feature_names", []),
        "trees": trees,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(export, f, separators=(",", ":"))

    file_size = Path(output_path).stat().st_size
    print(f"Saved: {output_path} ({file_size} bytes)", file=sys.stderr)


def parse_tree_output(output):
    """Parse print_tree output for oblivious trees."""
    lines = output.strip().split('\n')
    if len(lines) < 2:
        return None

    # Determine depth from first leaf line
    leaf_pattern = re.compile(
        r'Leaf idx: (\d+).*?depth: (\d+).*?value: \[([-\d.e+]+)\]'
        r'.*?feature_idxs: \[([^\]]+)\]'
        r'.*?feature_values: \[([^\]]+)\]'
    )

    leaves = []
    depth = 0
    feature_idxs = None
    feature_values = None

    for line in lines:
        m = leaf_pattern.search(line)
        if m:
            leaf_idx = int(m.group(1))
            d = int(m.group(2))
            value = float(m.group(3))
            fidxs = [int(x.strip()) for x in m.group(4).split(',')]
            fvals = [float(x.strip()) for x in m.group(5).split(',')]

            if feature_idxs is None:
                feature_idxs = fidxs
                feature_values = fvals
                depth = d

            leaves.append((leaf_idx, value))

    if not leaves or feature_idxs is None:
        return None

    # Sort leaves by index and extract values
    leaves.sort(key=lambda x: x[0])
    leaf_values = [v for _, v in leaves]

    # Build level info
    levels = []
    for i in range(depth):
        levels.append({
            "feature_idx": feature_idxs[i],
            "threshold": feature_values[i],
        })

    return {
        "depth": depth,
        "levels": levels,
        "leaves": leaf_values,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export GBRL trees to JSON")
    parser.add_argument("--model", required=True)
    parser.add_argument("--features", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    export_model_to_json(args.model, args.features, args.output)
