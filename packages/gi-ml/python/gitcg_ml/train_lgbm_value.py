#!/usr/bin/env python3
# Copyright (C) 2024-2025 Guyutongxue
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.

"""
LightGBM value model trainer.

Reads a flattened value dataset JSON (produced by the TS pipeline),
trains a LightGBM regressor with native categorical feature support,
and exports a GbdtValueArtifact-compatible JSON.

Usage:
  python train_lgbm_value.py \
    --input <value-dataset.json> \
    --output-artifact <artifact.json> \
    --output-eval <eval.json> \
    [--estimators 120] [--depth 5] [--lr 0.06] \
    [--top-features 80] [--min-child 8] [--subsample 0.8]
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np


# ── Feature flattening (mirrors TS flattenNumericRecord) ──

def flatten_feature_slots(slots, prefix=""):
    """Recursively flatten nested feature_slots into dot-separated keys."""
    result = {}
    if isinstance(slots, dict):
        for k, v in slots.items():
            full_key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
            if isinstance(v, dict):
                result.update(flatten_feature_slots(v, full_key))
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                result[full_key] = float(v)
    return result


def is_categorical_feature(name):
    """Determine if a feature should be treated as categorical."""
    return "definition_id" in name


# Features that should always be included regardless of variance ranking.
# These are low-variance binary signals (e.g., decision type one-hot) that
# provide essential context for tree splits even though they rank low by
# variance in a global feature selection pass.
FORCE_INCLUDE_FEATURES = [
    "pending_method.is_action",
    "pending_method.is_choose_active",
    "pending_method.is_reroll_dice",
    "pending_method.is_switch_hands",
    "pending_method.is_select_card",
    # 方案 A+：行动级状态特征注入
    "self_active.skill_damage_normal",
    "self_active.skill_damage_skill",
    "self_active.skill_damage_burst",
    "self_active.energy_full",
    "self.can_afford_normal",
    "self.can_afford_skill",
    "self.can_afford_burst",
    "opponent_active.is_frozen",
    "opponent_active.is_stunned",
    "opponent_active.shield",
    "opponent_bench.min_hp",
    "opponent_bench.min_hp_index",
    # P2-2: Temporal portfolio features (low-variance but high-signal)
    # — prevent variance-based top-k from dropping them
    "derived.self_temporal_setup_saturation",
    "derived.self_ready_to_cash_option_count",
    "derived.self_blocked_synergy_option_count",
    "derived.self_available_deferred_option_count",
    "derived.opp_temporal_setup_saturation",
    "derived.opp_ready_to_cash_option_count",
    "derived.opp_blocked_synergy_option_count",
    "derived.opp_available_deferred_option_count",
    # P2: Extended derived features — also high-signal, potentially low-variance
    "derived.dice_efficiency",
    "derived.summon_pressure",
    "derived.action_economy_ratio",
]


# ── LightGBM tree → GbdtValueArtifact JSON conversion ──

def lgbm_tree_to_artifact_tree(tree_info):
    """Convert a single LightGBM tree dict to GbdtTreeNode[] format."""
    nodes = []

    def visit(node_dict):
        if "leaf_value" in node_dict:
            # Leaf node
            entry = {
                "feature": None,
                "threshold": None,
                "left": None,
                "right": None,
                "value": node_dict["leaf_value"],
            }
            nodes.append(entry)
            return len(nodes) - 1

        left_child = node_dict.get("left_child", {})
        right_child = node_dict.get("right_child", {})

        # Reserve slot
        my_idx = len(nodes)
        nodes.append(None)  # placeholder

        left_idx = visit(left_child)
        right_idx = visit(right_child)

        split_feature = node_dict.get("split_feature", None)
        threshold = node_dict.get("threshold", None)
        decision_type = node_dict.get("decision_type", "<=")

        entry = {
            "feature": str(split_feature) if split_feature is not None else None,
            "left": left_idx,
            "right": right_idx,
            "value": None,
        }

        # Handle categorical splits: threshold is "val1||val2||..."
        if decision_type == "==" and isinstance(threshold, str) and "||" in threshold:
            cat_values = [int(v) for v in threshold.split("||") if v]
            entry["threshold"] = None
            entry["categorical_set"] = cat_values
        elif decision_type == "==" and threshold is not None:
            # Single categorical value
            entry["threshold"] = None
            entry["categorical_set"] = [int(float(str(threshold)))]
        else:
            entry["threshold"] = float(threshold) if threshold is not None else None

        nodes[my_idx] = entry
        return my_idx

    visit(tree_info["tree_structure"])
    return {"nodes": nodes}


def convert_lgbm_model_to_artifact(
    booster, feature_names, dataset_id, sample_count,
    n_estimators, max_depth, training_mae, training_rmse,
    artifact_version="lgbm_gbdt_value",
):
    """Convert a trained LightGBM Booster to GbdtValueArtifact JSON."""
    model_dump = booster.dump_model()
    trees = []
    for tree_info in model_dump["tree_info"]:
        trees.append(lgbm_tree_to_artifact_tree(tree_info))

    # LightGBM applies shrinkage per tree; learning_rate=1 means
    # the leaf values already incorporate the learning rate.
    # Our artifact format expects: value = bias + lr * sum(tree_predict)
    # With LightGBM: value = init_score + sum(lr * tree_predict_raw)
    # The dump already has lr-adjusted leaf values, so we set lr=1.
    init_score = model_dump.get("average_output", 0.0)

    # Map feature indices back to names (split_feature is 0-based index)
    feature_name_map = {str(i): name for i, name in enumerate(feature_names)}

    # Rename features in tree nodes
    for tree in trees:
        for node in tree["nodes"]:
            if node["feature"] is not None:
                feat_key = node["feature"]
                if feat_key in feature_name_map:
                    node["feature"] = feature_name_map[feat_key]

    return {
        "artifact_type": "gbdt_value.v1",
        "artifact_version": artifact_version,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "bias": float(init_score),
        "learning_rate": 1.0,  # leaf values already scaled
        "trees": trees,
        "feature_names": feature_names,
        "metadata": {
            "dataset_id": dataset_id,
            "sample_count": sample_count,
            "n_estimators": n_estimators,
            "max_depth": max_depth,
            "training_mae": training_mae,
            "training_rmse": training_rmse,
            "engine": "lightgbm",
            "engine_version": lgb.__version__,
        },
    }


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="Train LightGBM value model")
    parser.add_argument("--input", required=True, help="Path to value dataset JSON")
    parser.add_argument("--output-artifact", required=True, help="Output artifact JSON")
    parser.add_argument("--output-eval", required=True, help="Output evaluation JSON")
    parser.add_argument("--estimators", type=int, default=120)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--lr", type=float, default=0.06)
    parser.add_argument("--top-features", type=int, default=80)
    parser.add_argument("--min-child", type=int, default=8)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--prefix", default="lgbm")
    args = parser.parse_args()

    print(f"[LightGBM] Loading dataset from {args.input}...")
    t0 = time.time()

    with open(args.input, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    samples = dataset.get("samples", [])
    if not samples:
        print("ERROR: No samples in dataset", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(samples)} samples loaded ({time.time()-t0:.1f}s)")

    # ── Flatten features ──
    print("[LightGBM] Flattening features...")
    flat_samples = []
    targets = []
    weights = []
    for sample in samples:
        flat = flatten_feature_slots(sample.get("feature_slots", {}))
        flat_samples.append(flat)
        targets.append(sample.get("target_value", 0.5))
        weights.append(sample.get("weight", 1.0))

    # ── Compute feature variance stats ──
    all_keys = set()
    for flat in flat_samples:
        all_keys.update(flat.keys())

    key_stats = {}
    for key in all_keys:
        vals = [flat.get(key, 0.0) for flat in flat_samples]
        arr = np.array(vals)
        var = np.var(arr)
        count = np.count_nonzero(arr)
        key_stats[key] = (var, count)

    # ── Force-include low-variance features (decision type one-hot, etc.) ──
    force_included = [
        f for f in FORCE_INCLUDE_FEATURES
        if f in all_keys and key_stats[f][1] >= 1  # at least 1 non-zero
    ]
    print(f"  Force-included {len(force_included)} features: {force_included}")

    # ── Select top features by variance, excluding already force-included ──
    var_ranked = sorted(
        [k for k, (v, c) in key_stats.items()
         if v > 1e-10 and c >= 5 and k not in force_included],
        key=lambda k: (-key_stats[k][0], -key_stats[k][1]),
    )[:args.top_features - len(force_included)]

    feature_names = force_included + var_ranked

    print(f"  Selected {len(feature_names)} features (from {len(all_keys)} total)")

    # ── Build matrix ──
    cat_indices = []
    for i, name in enumerate(feature_names):
        if is_categorical_feature(name):
            cat_indices.append(i)

    print(f"  Categorical features: {len(cat_indices)} ({[feature_names[i] for i in cat_indices]})")

    X = np.zeros((len(flat_samples), len(feature_names)), dtype=np.float64)
    for i, flat in enumerate(flat_samples):
        for j, name in enumerate(feature_names):
            X[i, j] = flat.get(name, 0.0)

    y = np.array(targets, dtype=np.float64)
    w = np.array(weights, dtype=np.float64)

    # For categorical features, cast to int (LightGBM requires int for categorical)
    for ci in cat_indices:
        X[:, ci] = X[:, ci].astype(np.int64)

    # ── Train/val split (80/20 by hash) ──
    n = len(y)
    val_mask = np.array([hash(str(i)) % 5 == 0 for i in range(n)])
    train_mask = ~val_mask

    X_train, y_train, w_train = X[train_mask], y[train_mask], w[train_mask]
    X_val, y_val, w_val = X[val_mask], y[val_mask], w[val_mask]

    print(f"  Train: {train_mask.sum()}, Val: {val_mask.sum()}")

    # ── Create LightGBM datasets ──
    dtrain = lgb.Dataset(
        X_train, label=y_train, weight=w_train,
        feature_name=feature_names,
        categorical_feature=[feature_names[i] for i in cat_indices],
        free_raw_data=False,
    )
    dval = lgb.Dataset(
        X_val, label=y_val, weight=w_val,
        reference=dtrain,
        feature_name=feature_names,
        categorical_feature=[feature_names[i] for i in cat_indices],
        free_raw_data=False,
    )

    # ── Train ──
    params = {
        "objective": "regression",
        "metric": ["mae", "rmse"],
        "num_leaves": 2 ** args.depth - 1,
        "max_depth": args.depth,
        "learning_rate": args.lr,
        "min_data_in_leaf": args.min_child,
        "subsample": args.subsample,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_alpha": 0.01,
        "reg_lambda": 0.1,
        "verbose": -1,
        "seed": 42,
    }

    print(f"[LightGBM] Training (estimators={args.estimators}, depth={args.depth}, lr={args.lr})...")
    t1 = time.time()

    callbacks = [lgb.log_evaluation(period=20)]
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=args.estimators,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=callbacks,
    )

    train_time = time.time() - t1
    print(f"  Training complete ({train_time:.1f}s)")

    # ── Evaluate ──
    y_pred_train = booster.predict(X_train)
    y_pred_val = booster.predict(X_val)

    train_mae = float(np.average(np.abs(y_train - y_pred_train), weights=w_train))
    train_rmse = float(np.sqrt(np.average((y_train - y_pred_train)**2, weights=w_train)))
    val_mae = float(np.average(np.abs(y_val - y_pred_val), weights=w_val))
    val_rmse = float(np.sqrt(np.average((y_val - y_pred_val)**2, weights=w_val)))

    print(f"\n  Train MAE: {train_mae:.4f}  RMSE: {train_rmse:.4f}")
    print(f"  Val   MAE: {val_mae:.4f}  RMSE: {val_rmse:.4f}")

    # --- Unweighted metrics (for luck-weighted comparison) ---
    train_mae_unw = float(np.mean(np.abs(y_train - y_pred_train)))
    train_rmse_unw = float(np.sqrt(np.mean((y_train - y_pred_train) ** 2)))
    val_mae_unw = float(np.mean(np.abs(y_val - y_pred_val)))
    val_rmse_unw = float(np.sqrt(np.mean((y_val - y_pred_val) ** 2)))

    # --- Weight statistics ---
    w_all = np.array(weights)
    w_min = float(np.min(w_all))
    w_max = float(np.max(w_all))
    w_mean = float(np.mean(w_all))
    w_std = float(np.std(w_all))
    w_p10 = float(np.percentile(w_all, 10))
    w_p50 = float(np.percentile(w_all, 50))
    w_p90 = float(np.percentile(w_all, 90))
    w_frac_below_05 = float(np.mean(np.asarray(w_all) < 0.5))
    w_frac_above_15 = float(np.mean(np.asarray(w_all) > 1.5))
    loss_ratio = val_mae / max(val_mae_unw, 1e-8)

    print(f"\n  Weight stats: mean={w_mean:.3f} std={w_std:.3f} "
          f"min={w_min:.3f} max={w_max:.3f}")
    print(f"  Weight dist: p10={w_p10:.3f} p50={w_p50:.3f} p90={w_p90:.3f}")
    print(f"  Weight < 0.5: {w_frac_below_05:.1%}  > 1.5: {w_frac_above_15:.1%}")
    print(f"\n  Unweighted Val MAE: {val_mae_unw:.4f}  RMSE: {val_rmse_unw:.4f}")
    print(f"  Weighted/Unweighted loss ratio: {loss_ratio:.3f}")

    # Feature importance
    importance = booster.feature_importance(importance_type="gain")
    top_feats = sorted(
        zip(feature_names, importance),
        key=lambda x: -x[1],
    )[:20]
    print("\n  Top 20 features (gain):")
    for name, gain in top_feats:
        cat_mark = " [CAT]" if is_categorical_feature(name) else ""
        print(f"    {name}: {gain:.1f}{cat_mark}")

    # ── Convert to GbdtValueArtifact ──
    print("\n[LightGBM] Converting to GbdtValueArtifact format...")
    artifact = convert_lgbm_model_to_artifact(
        booster=booster,
        feature_names=feature_names,
        dataset_id=dataset.get("dataset_id", "unknown"),
        sample_count=len(samples),
        n_estimators=args.estimators,
        max_depth=args.depth,
        training_mae=val_mae,
        training_rmse=val_rmse,
        artifact_version=f"{args.prefix}_lgbm_value",
    )

    Path(args.output_artifact).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output_artifact, "w", encoding="utf-8") as f:
        json.dump(artifact, f, separators=(",", ":"))
    print(f"  Artifact: {args.output_artifact}")

    # ── Evaluation JSON ──
    evaluation = {
        "engine": "lightgbm",
        "engine_version": lgb.__version__,
        "mae": val_mae,
        "rmse": val_rmse,
        "train_mae": train_mae,
        "train_rmse": train_rmse,
        "sample_count": len(samples),
        "train_count": int(train_mask.sum()),
        "val_count": int(val_mask.sum()),
        "val_mae_unweighted": val_mae_unw,
        "val_rmse_unweighted": val_rmse_unw,
        "weighted_unweighted_loss_ratio": loss_ratio,
        "weight_stats": {
            "min": w_min,
            "max": w_max,
            "mean": w_mean,
            "std": w_std,
            "p10": w_p10,
            "p50": w_p50,
            "p90": w_p90,
            "fraction_below_0_5": w_frac_below_05,
            "fraction_above_1_5": w_frac_above_15,
        },
        "n_estimators": args.estimators,
        "max_depth": args.depth,
        "learning_rate": args.lr,
        "feature_count": len(feature_names),
        "categorical_feature_count": len(cat_indices),
        "training_time_sec": train_time,
        "top_features": [{"name": n, "gain": float(g)} for n, g in top_feats],
    }

    with open(args.output_eval, "w", encoding="utf-8") as f:
        json.dump(evaluation, f, indent=2)
    print(f"  Eval: {args.output_eval}")

    print(f"\n[LightGBM] Done. Val MAE={val_mae:.4f}, RMSE={val_rmse:.4f}")


if __name__ == "__main__":
    main()
