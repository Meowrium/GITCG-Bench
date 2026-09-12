#!/usr/bin/env python3
"""
MoE (Mixture of Experts) GBDT value model trainer.

Reads a flattened value dataset JSON, assigns each sample to an expert
based on state features, trains a separate LightGBM regressor per expert,
and exports a MoEValueArtifact-compatible JSON.

Usage:
  python train_moe_value.py \
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
from collections import Counter
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
    return "definition_id" in name


# ── Features to force-include (same as train_lgbm_value.py) ──

FORCE_INCLUDE_FEATURES = [
    "pending_method.is_action",
    "pending_method.is_choose_active",
    "pending_method.is_reroll_dice",
    "pending_method.is_switch_hands",
    "pending_method.is_select_card",
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
]


# ── Expert definitions ──

EXPERT_NAMES = ["setup", "survival", "finisher", "midgame", "neutral"]

def assign_expert(flat):
    """Assign a sample to an expert based on state features.

    Expert definitions derived from GBDT root-split analysis:
      opp_total_health >= 25 (15 trees' root)  -> setup
      self_total_health <= 2.5 (5 trees' root) -> survival
      opp_total_health <= 4.5 (3 trees' root)  -> finisher
      round 3-5 + not special                   -> midgame
      else                                       -> neutral

    Returns index into EXPERT_NAMES.
    All conditions are computed from flattened feature names.
    """
    self_hp = flat.get("self.active_health", 10)
    self_total = flat.get("self.total_health", 30)
    self_alive = flat.get("self.alive_count", 3)
    opp_total = flat.get("opponent.total_health", 30)
    opp_hp = flat.get("opponent.active_health", 10)
    round_num = flat.get("round", 1)

    # Setup: full-health teams (no damage taken yet) or T0-T1
    if opp_total >= 25 or round_num <= 1:
        return 0  # setup

    # Survival: near-death state (GBDT threshold self.total_health <= 2.5)
    if self_total <= 2.5 or self_hp <= 4 or self_alive < 3:
        return 1  # survival

    # Finisher: opponent on the brink of KO
    if opp_total <= 4.5 or opp_hp <= 3:
        return 2  # finisher

    # Midgame: rounds 3-5, not in any acute state
    if 3 <= round_num <= 5:
        return 3  # midgame

    # Neutral: everything else (late game, round 6+, generic)
    return 4  # neutral


# ── LightGBM tree → GbdtValueArtifact JSON conversion ──

def lgbm_tree_to_artifact_tree(tree_info):
    """Convert a single LightGBM tree dict to GbdtTreeNode[] format."""
    nodes = []

    def visit(node_dict):
        if "leaf_value" in node_dict:
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

        my_idx = len(nodes)
        nodes.append(None)

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

        if decision_type == "==" and isinstance(threshold, str) and "||" in threshold:
            cat_values = [int(v) for v in threshold.split("||") if v]
            entry["threshold"] = None
            entry["categorical_set"] = cat_values
        elif decision_type == "==" and threshold is not None:
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
    """Convert a trained LightGBM Booster to GbdtValueArtifact-style dict."""
    model_dump = booster.dump_model()
    trees = []
    for tree_info in model_dump["tree_info"]:
        trees.append(lgbm_tree_to_artifact_tree(tree_info))

    init_score = model_dump.get("average_output", 0.0)

    feature_name_map = {str(i): name for i, name in enumerate(feature_names)}
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
        "learning_rate": 1.0,
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


# ── Train a single GBDT model on data ──

def train_gbdt(
    X, y, w, feature_names, cat_indices,
    estimators, depth, lr, min_child, subsample,
):
    """Train a single LightGBM regressor, return (booster, val_mae, val_rmse, top_features)."""
    # 80/20 split by hash
    n = len(y)
    val_mask = np.array([hash(str(i)) % 5 == 0 for i in range(n)])
    train_mask = ~val_mask

    X_train, y_train, w_train = X[train_mask], y[train_mask], w[train_mask]
    X_val, y_val, w_val = X[val_mask], y[val_mask], w[val_mask]

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

    params = {
        "objective": "regression",
        "metric": ["mae", "rmse"],
        "num_leaves": 2 ** depth - 1,
        "max_depth": depth,
        "learning_rate": lr,
        "n_estimators": estimators,
        "min_child_samples": min_child,
        "subsample": subsample,
        "subsample_freq": 1,
        "colsample_bytree": 0.8,
        "reg_alpha": 0.01,
        "reg_lambda": 0.1,
        "verbose": -1,
        "seed": 42,
    }

    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=estimators,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[lgb.log_evaluation(period=100)],
    )

    y_pred = booster.predict(X_val)
    val_mae = float(np.average(np.abs(y_val - y_pred), weights=w_val))
    val_rmse = float(np.sqrt(np.average((y_val - y_pred) ** 2, weights=w_val)))

    importance = booster.feature_importance(importance_type="gain")
    top_feats = sorted(
        zip(feature_names, importance),
        key=lambda x: -x[1],
    )[:10]

    return booster, val_mae, val_rmse, top_feats


# ── Feature selection ──

def select_features(flat_samples, all_keys, key_stats):
    """Select top features by variance + force-include list."""
    force_included = [
        f for f in FORCE_INCLUDE_FEATURES
        if f in all_keys and key_stats[f][1] >= 1
    ]

    var_ranked = sorted(
        [k for k, (v, c) in key_stats.items()
         if v > 1e-10 and c >= 5 and k not in force_included],
        key=lambda k: (-key_stats[k][0], -key_stats[k][1]),
    )

    return force_included, var_ranked


def build_matrix(flat_samples, feature_names):
    """Build numpy matrix from flattened samples."""
    X = np.zeros((len(flat_samples), len(feature_names)), dtype=np.float64)
    for i, flat in enumerate(flat_samples):
        for j, name in enumerate(feature_names):
            X[i, j] = flat.get(name, 0.0)
    return X


# ── Main ──

def main():
    parser = argparse.ArgumentParser(description="Train MoE GBDT value model")
    parser.add_argument("--input", required=True, help="Path to value dataset JSON")
    parser.add_argument("--output-artifact", required=True, help="Output MoE artifact JSON")
    parser.add_argument("--output-eval", required=True, help="Output evaluation JSON")
    parser.add_argument("--estimators", type=int, default=120)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--lr", type=float, default=0.06)
    parser.add_argument("--top-features", type=int, default=80)
    parser.add_argument("--min-child", type=int, default=8)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--prefix", default="lgbm")
    args = parser.parse_args()

    print(f"[MoE] Loading dataset from {args.input}...")
    t0 = time.time()

    with open(args.input, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    samples = dataset.get("samples", [])
    if not samples:
        print("ERROR: No samples in dataset", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(samples)} samples loaded ({time.time()-t0:.1f}s)")

    # ── Flatten features ──
    print("[MoE] Flattening features...")
    flat_samples = []
    targets = []
    weights = []
    for sample in samples:
        flat = flatten_feature_slots(sample.get("feature_slots", {}))
        flat_samples.append(flat)
        targets.append(sample.get("target_value", 0.5))
        weights.append(sample.get("weight", 1.0))

    # ── Compute feature variance stats (same as baseline) ──
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

    force_included, var_ranked = select_features(flat_samples, all_keys, key_stats)

    feature_names_all = force_included + var_ranked[:args.top_features - len(force_included)]
    print(f"  Selected {len(feature_names_all)} features (from {len(all_keys)} total)")

    cat_indices = []
    for i, name in enumerate(feature_names_all):
        if is_categorical_feature(name):
            cat_indices.append(i)

    X_all = build_matrix(flat_samples, feature_names_all)
    y_all = np.array(targets, dtype=np.float64)
    w_all = np.array(weights, dtype=np.float64)

    for ci in cat_indices:
        X_all[:, ci] = X_all[:, ci].astype(np.int64)

    # ── Assign experts ──
    print("[MoE] Assigning experts...")
    expert_ids = [assign_expert(flat) for flat in flat_samples]
    expert_counts = Counter(expert_ids)
    print(f"  Expert distribution: {dict(expert_counts)}")
    for name, count in sorted(expert_counts.items()):
        print(f"    {EXPERT_NAMES[name]}: {count} ({count/len(samples)*100:.1f}%)")

    # ── Train baseline (full data) ──
    print(f"\n[MoE] Training BASELINE model (all {len(samples)} samples)...")
    t1 = time.time()
    booster_all, baseline_mae, baseline_rmse, _ = train_gbdt(
        X_all, y_all, w_all, feature_names_all, cat_indices,
        args.estimators, args.depth, args.lr, args.min_child, args.subsample,
    )
    baseline_time = time.time() - t1
    print(f"  Baseline: MAE={baseline_mae:.4f}, RMSE={baseline_rmse:.4f} ({baseline_time:.1f}s)")

    # ── Train each expert ──
    experts = []
    expert_maes = []
    all_expert_top_features = []

    for expert_idx, expert_name in enumerate(EXPERT_NAMES):
        mask = np.array([eid == expert_idx for eid in expert_ids])
        count = int(mask.sum())
        if count < 100:
            print(f"\n[MoE] Expert '{expert_name}': only {count} samples, skipping training (will use baseline)")
            experts.append({
                "name": expert_name,
                "model": None,  # Will fall back to baseline
                "sample_count": count,
            })
            expert_maes.append(None)
            all_expert_top_features.append([])
            continue

        X_expert = X_all[mask]
        y_expert = y_all[mask]
        w_expert = w_all[mask]

        # Re-select features for this expert (may prefer different features)
        exp_flat = [flat_samples[i] for i in range(len(samples)) if mask[i]]
        exp_keys = set()
        for flat in exp_flat:
            exp_keys.update(flat.keys())

        exp_key_stats = {}
        for key in exp_keys:
            vals = [flat.get(key, 0.0) for flat in exp_flat]
            arr = np.array(vals)
            var = np.var(arr)
            cnt = np.count_nonzero(arr)
            exp_key_stats[key] = (var, cnt)

        exp_force = [f for f in FORCE_INCLUDE_FEATURES if f in exp_keys and exp_key_stats[f][1] >= 1]
        exp_var_ranked = sorted(
            [k for k, (v, c) in exp_key_stats.items()
             if v > 1e-10 and c >= 5 and k not in exp_force],
            key=lambda k: (-exp_key_stats[k][0], -exp_key_stats[k][1]),
        )
        exp_features = exp_force + exp_var_ranked[:min(args.top_features, len(exp_var_ranked))]
        
        # Rebuild matrix with expert-specific features
        X_exp = build_matrix(exp_flat, exp_features)
        for ci_i, ci in enumerate(cat_indices):
            if ci_i < X_exp.shape[1]:
                X_exp[:, ci_i] = X_exp[:, ci_i].astype(np.int64)

        exp_cat = [i for i, name in enumerate(exp_features) if is_categorical_feature(name)]

        print(f"\n[MoE] Training EXPERT '{expert_name}' ({count} samples, {len(exp_features)} features)...")
        t2 = time.time()
        booster_exp, mae, rmse, top_feats = train_gbdt(
            X_exp, y_expert, w_expert, exp_features, exp_cat,
            args.estimators, args.depth, args.lr, args.min_child, args.subsample,
        )
        exp_time = time.time() - t2

        artifact = convert_lgbm_model_to_artifact(
            booster=booster_exp,
            feature_names=exp_features,
            dataset_id=dataset.get("dataset_id", "unknown"),
            sample_count=count,
            n_estimators=args.estimators,
            max_depth=args.depth,
            training_mae=mae,
            training_rmse=rmse,
            artifact_version=f"{args.prefix}_moe_{expert_name}",
        )
        experts.append({
            "name": expert_name,
            "model": artifact,
            "sample_count": count,
        })
        expert_maes.append(mae)
        all_expert_top_features.append(top_feats)
        print(f"  Expert MAE={mae:.4f}, RMSE={rmse:.4f} ({exp_time:.1f}s)")
        for name, gain in top_feats:
            cm = " [CAT]" if is_categorical_feature(name) else ""
            print(f"    {name}: {gain:.1f}{cm}")

    # Fill None experts with baseline fallback
    for i, exp in enumerate(experts):
        if exp["model"] is None:
            print(f"  Expert '{exp['name']}' uses baseline model (fallback)")

    # ── Build MoE Artifact ──
    baseline_artifact = convert_lgbm_model_to_artifact(
        booster=booster_all,
        feature_names=feature_names_all,
        dataset_id=dataset.get("dataset_id", "unknown"),
        sample_count=len(samples),
        n_estimators=args.estimators,
        max_depth=args.depth,
        training_mae=baseline_mae,
        training_rmse=baseline_rmse,
        artifact_version=f"{args.prefix}_moe_baseline",
    )

    moe_artifact = {
        "artifact_type": "moe_value.v1",
        "artifact_version": f"{args.prefix}_moe_value",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "experts": experts,
        "baseline_model": baseline_artifact,
        "expert_names": EXPERT_NAMES,
        "metadata": {
            "dataset_id": dataset.get("dataset_id", "unknown"),
            "sample_count": len(samples),
            "expert_counts": [expert_counts.get(i, 0) for i in range(len(EXPERT_NAMES))],
            "baseline_mae": baseline_mae,
            "baseline_rmse": baseline_rmse,
            "expert_maes": expert_maes,
            "n_estimators": args.estimators,
            "max_depth": args.depth,
            "engine": "lightgbm",
            "engine_version": lgb.__version__,
        },
    }

    Path(args.output_artifact).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output_artifact, "w", encoding="utf-8") as f:
        json.dump(moe_artifact, f, separators=(",", ":"))
    print(f"\n[MoE] Artifact: {args.output_artifact}")

    # ── Evaluation JSON ──
    evaluation = {
        "type": "moe_value",
        "baseline_mae": baseline_mae,
        "baseline_rmse": baseline_rmse,
        "expert_maes": [m if m is not None else -1 for m in expert_maes],
        "expert_counts": [expert_counts.get(i, 0) for i in range(len(EXPERT_NAMES))],
        "sample_count": len(samples),
        "n_estimators": args.estimators,
        "max_depth": args.depth,
        "feature_count": len(feature_names_all),
        "training_time_sec": time.time() - t0,
        "experts": [
            {
                "name": EXPERT_NAMES[i],
                "count": expert_counts.get(i, 0),
                "mae": expert_maes[i],
                "top_features": [
                    {"name": n, "gain": float(g)}
                    for n, g in all_expert_top_features[i][:10]
                ] if all_expert_top_features[i] else [],
            }
            for i in range(len(EXPERT_NAMES))
        ],
    }

    with open(args.output_eval, "w", encoding="utf-8") as f:
        json.dump(evaluation, f, indent=2)
    print(f"[MoE] Eval: {args.output_eval}")

    print(f"\n[MoE] Done. Baseline MAE={baseline_mae:.4f}")
    for i, mae in enumerate(expert_maes):
        if mae is not None:
            delta = baseline_mae - mae
            print(f"  Expert '{EXPERT_NAMES[i]}': MAE={mae:.4f} (Δ={delta:+.4f})")


if __name__ == "__main__":
    main()
