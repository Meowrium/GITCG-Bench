#!/usr/bin/env python3
"""
GBRL inference server for MCTS value prediction.

Two modes:
  --server   Persistent JSON-lines server (stdin/stdout, for MCTS)
  (default)  Single-shot: --input-features <json> → stdout

Protocol (server mode):
  Each stdin line is a JSON object with:
    { "features": {...}, "start_idx": 0, "stop_idx": null }
  Each stdout line is:
    { "value": 0.5234, "error": null }
  Send {"shutdown": true} to exit.

  Feature dict keys must match the flattened feature names from training.

Usage:
  python predict_gbrl.py --model artifacts/v20.gbrl_model --features artifacts/v20.features.json --server
  python predict_gbrl.py --model ... --features ... --input-features sample.json
"""

import argparse
import json
import sys
import os
from pathlib import Path

import numpy as np


def load_model_and_features(model_path_str, features_path_str):
    """Load GBRL model and feature metadata."""
    from gbrl.models import GBTModel

    model_path = Path(model_path_str)
    if not model_path.exists():
        # Try appending .gbrl_model extension
        model_path = Path(f"{model_path_str}.gbrl_model")
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path_str} (tried with .gbrl_model suffix)")

    with open(features_path_str, "r", encoding="utf-8") as f:
        features_data = json.load(f)

    print(f"[GBRL Predict] Loading model: {model_path}", file=sys.stderr)
    model = GBTModel.load_learner(str(model_path), device="cpu")
    num_trees = model.get_num_trees()
    if isinstance(num_trees, tuple):
        num_trees = num_trees[0]
    print(f"[GBRL Predict] Model loaded: {num_trees} trees, {len(features_data['feature_names'])} features", file=sys.stderr)

    return model, features_data


def build_feature_vector(flat_features, feature_names):
    """Build numpy array from flat feature dict, aligning to training feature order."""
    X = np.zeros((1, len(feature_names)), dtype=np.float64)
    for j, name in enumerate(feature_names):
        X[0, j] = flat_features.get(name, 0.0)
    return X


def predict_single(model, features_data, flat_features, start_idx=0, stop_idx=None):
    """Single prediction."""
    X = build_feature_vector(flat_features, features_data["feature_names"])
    pred = model(X, requires_grad=False, tensor=False,
                 start_idx=start_idx, stop_idx=stop_idx)
    return float(pred.flatten()[0])


def predict_batch(model, features_data, flat_features, batch_size=50):
    """Predict with batched trees to limit peak memory."""
    num_trees = model.get_num_trees()
    if isinstance(num_trees, tuple):
        num_trees = num_trees[0]

    X = build_feature_vector(flat_features, features_data["feature_names"])
    total = 0.0
    # Add bias
    total += features_data.get("bias", 0.0)

    for start in range(0, num_trees, batch_size):
        stop = min(start + batch_size, num_trees)
        pred = model(X, requires_grad=False, tensor=False,
                     start_idx=start, stop_idx=stop)
        total += float(pred.flatten()[0])

    return total


def run_server(model, features_data):
    """Persistent JSON-lines server on stdin/stdout.
    Uses raw stdin buffer to avoid full-buffering on pipes."""
    import io
    print("[GBRL Predict] Server ready, waiting for input...", file=sys.stderr)
    sys.stderr.flush()

    # Use raw buffer for unbuffered reads (pipes are fully-buffered by default)
    reader = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline="\n")

    while True:
        line = reader.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"value": None, "error": f"Invalid JSON: {e}"}), flush=True)
            continue

        if request.get("shutdown"):
            print(json.dumps({"value": None, "error": None, "shutdown": True}), flush=True)
            break

        features = request.get("features")
        if not features:
            print(json.dumps({"value": None, "error": "Missing 'features' field"}), flush=True)
            continue

        start_idx = request.get("start_idx", 0)
        stop_idx = request.get("stop_idx", None)
        batch_size = request.get("batch_size", None)

        try:
            if batch_size is not None:
                value = predict_batch(model, features_data, features, batch_size)
            else:
                value = predict_single(model, features_data, features, start_idx, stop_idx)
            print(json.dumps({"value": value, "error": None}), flush=True)
        except Exception as e:
            print(json.dumps({"value": None, "error": str(e)}), flush=True)

    print("[GBRL Predict] Server stopped", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description="GBRL value inference")
    parser.add_argument("--model", required=True, help="Path to .gbrl_model file")
    parser.add_argument("--features", required=True, help="Path to .features.json file")
    parser.add_argument("--input-features", help="JSON file with flattened feature dict")
    parser.add_argument("--server", action="store_true", help="Run as persistent JSON-lines server")
    parser.add_argument("--batch-size", type=int, default=None, help="Tree batch size for prediction")
    args = parser.parse_args()

    try:
        model, features_data = load_model_and_features(args.model, args.features)
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)

    if args.server:
        run_server(model, features_data)
    else:
        if args.input_features:
            with open(args.input_features, "r", encoding="utf-8") as f:
                features = json.load(f)
        else:
            # Read from stdin
            features = json.loads(sys.stdin.read())

        if isinstance(features, list):
            # Batch mode: list of feature dicts
            results = []
            for feat in features:
                if args.batch_size:
                    value = predict_batch(model, features_data, feat, args.batch_size)
                else:
                    value = predict_single(model, features_data, feat)
                results.append(value)
            print(json.dumps({"values": results, "error": None}))
        else:
            if args.batch_size:
                value = predict_batch(model, features_data, features, args.batch_size)
            else:
                value = predict_single(model, features_data, features)
            print(json.dumps({"value": value, "error": None}))


if __name__ == "__main__":
    main()
