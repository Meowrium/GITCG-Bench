#!/usr/bin/env python3
"""
GBRL value model trainer — direct inference (no LightGBM distillation).

1. Train GBRL GBTModel on value dataset
2. Save GBRL model binary + feature names for inference
3. Export GbdtValueArtifact-compatible JSON (artifact_type: "gbrl_value.v1")
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


def flatten_feature_slots(slots, prefix=""):
    """Flatten nested feature dict. Filters NaN/Inf to match TS-side filter."""
    result = {}
    if isinstance(slots, dict):
        for k, v in slots.items():
            full_key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
            if isinstance(v, dict):
                result.update(flatten_feature_slots(v, full_key))
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                if math.isfinite(v):
                    result[full_key] = float(v)
    return result


def is_categorical_feature(name):
    return "definition_id" in name


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
    "derived.self_temporal_setup_saturation",
    "derived.self_ready_to_cash_option_count",
    "derived.self_blocked_synergy_option_count",
    "derived.self_available_deferred_option_count",
    "derived.opp_temporal_setup_saturation",
    "derived.opp_ready_to_cash_option_count",
    "derived.dice_efficiency",
    "derived.summon_pressure",
    "derived.action_economy_ratio",
]


# ── Tree export helpers ──


def _binary_leaf_index(directions):
    """Compute binary leaf index from inequality_directions.
    Matches predictTree: leafIdx = (leafIdx << 1) | (feature > threshold ? 1 : 0)
    MSB = directions[0]."""
    idx = 0
    for d in directions:
        idx = (idx << 1) | d
    return idx


def _flush_tree(trees_export, depth, feature_idxs, feature_values, leaves):
    """Build a tree dict from accumulated leaf data, padding missing binary indices."""
    actual_depth = min(depth, len(feature_idxs), len(feature_values))
    levels = [
        {"feature_idx": int(feature_idxs[i]), "threshold": float(feature_values[i])}
        for i in range(actual_depth)
    ]
    # Pad remaining levels with zeros if needed
    for i in range(actual_depth, depth):
        levels.append({"feature_idx": 0, "threshold": 0.0})
    n_leaves = 1 << depth
    leaf_values = [0.0] * n_leaves
    for leaf_idx, leaf_val in leaves:
        if 0 <= leaf_idx < n_leaves:
            leaf_values[leaf_idx] = leaf_val
    actual = sum(1 for idx, _ in leaves if 0 <= idx < n_leaves)
    if actual != n_leaves:
        print(
            f"  WARNING: Tree depth={depth}: placed {actual}/{n_leaves} leaves "
            f"(missing {n_leaves - actual}, using 0.0)"
        )

    trees_export.append({"depth": depth, "levels": levels, "leaves": leaf_values})


def _parse_print_tree_output(tree_text):
    """Parse GBRL print_tree() output into GbrlTree list.
    Handles multi-line leaf entries (GBRL v1.1.7+ format):

        Oblivious DecisionTree idx: 0 ... max_depth: 5
        Leaf idx: 0 ... depth: 5 value: [0.1234]
          feature_idxs: [12, 34, 56, 78, 90]
          inequality_directions: [1, 0, 1, 1, 0]
          feature_values: [0.5, 1400, 3.2, 10, 2]
        ...
    """
    import re

    # ── Pre-process: collapse multi-line leaf entries ──
    raw_lines = tree_text.split("\n")
    collapsed_lines = []
    leaf_buf = []
    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("Leaf idx:"):
            if leaf_buf:
                collapsed_lines.append(" | ".join(leaf_buf))
            leaf_buf = [stripped]
        elif leaf_buf and (
            stripped.startswith("feature_idxs:")
            or stripped.startswith("inequality_directions:")
            or stripped.startswith("feature_values:")
        ):
            leaf_buf.append(stripped)
        else:
            if leaf_buf:
                collapsed_lines.append(" | ".join(leaf_buf))
                leaf_buf = []
            collapsed_lines.append(stripped)
    if leaf_buf:
        collapsed_lines.append(" | ".join(leaf_buf))

    # ── Parse collapsed lines ──
    trees_export = []
    current_depth = 0
    current_feature_idxs = None
    current_feature_values = None
    current_leaves = []  # list of (binary_leaf_idx, value) tuples
    tree_count = 0

    for line in collapsed_lines:
        line = line.strip()
        if not line:
            continue
        # Tree header
        if "DecisionTree" in line and "idx:" in line:
            if current_feature_idxs is not None:
                _flush_tree(
                    trees_export,
                    current_depth,
                    current_feature_idxs,
                    current_feature_values,
                    current_leaves,
                )
            current_feature_idxs = None
            current_feature_values = None
            current_leaves = []
            current_depth = 0
            tree_count += 1
            m = re.search(r"max_depth:\s*(\d+)", line)
            if m:
                current_depth = int(m.group(1))
        # Collapsed leaf line: "Leaf idx: ... | feature_idxs: [...] | inequality_directions: [...] | feature_values: [...]"
        elif line.startswith("Leaf idx:"):
            m_leaf = re.search(
                r"Leaf idx:\s*(\d+).*?depth:\s*(\d+)\s+value:\s*\[([\d.eE\-]+)\]", line
            )
            m_fidx = re.search(r"feature_idxs:\s*\[([^\]]+)\]", line)
            m_idir = re.search(r"inequality_directions:\s*\[([^\]]+)\]", line)
            m_fval = re.search(r"feature_values:\s*\[([^\]]+)\]", line)
            if m_leaf and m_fidx and m_fval:
                leaf_value = float(m_leaf.group(3))
                leaf_depth = int(m_leaf.group(2))
                if current_depth == 0:
                    current_depth = leaf_depth
                # Capture feature_idxs/feature_values from first leaf (oblivious: all same)
                if current_feature_idxs is None:
                    current_feature_idxs = [
                        int(x.strip()) for x in m_fidx.group(1).split(",")
                    ]
                    current_feature_values = [
                        float(x.strip()) for x in m_fval.group(1).split(",")
                    ]
                    if current_depth > 0 and len(current_feature_idxs) < current_depth:
                        print(
                            f"  WARNING: Tree idx={tree_count}: depth={current_depth} but "
                            f"feature_idxs has {len(current_feature_idxs)} elements — padding"
                        )
                        current_feature_idxs += [0] * (
                            current_depth - len(current_feature_idxs)
                        )
                        current_feature_values += [0.0] * (
                            current_depth - len(current_feature_values)
                        )
                # Compute binary leaf index from inequality_directions
                if m_idir:
                    idir = [int(x.strip()) for x in m_idir.group(1).split(",")]
                    leaf_idx = _binary_leaf_index(idir)
                else:
                    # Fallback: use numeric leaf idx from output
                    leaf_idx = int(m_leaf.group(1))
                current_leaves.append((leaf_idx, leaf_value))
            elif m_leaf:
                # Leaf without feature data — use numeric idx only
                leaf_value = float(m_leaf.group(3))
                leaf_idx = int(m_leaf.group(1))
                current_leaves.append((leaf_idx, leaf_value))

    # Save last tree
    if current_feature_idxs is not None:
        _flush_tree(
            trees_export,
            current_depth,
            current_feature_idxs,
            current_feature_values,
            current_leaves,
        )

    return trees_export


# ── Main ──


def main():
    parser = argparse.ArgumentParser(description="GBRL value model trainer (direct)")
    parser.add_argument("--input", required=True, help="Value dataset JSON")
    parser.add_argument("--output-artifact", required=True, help="Output artifact JSON")
    parser.add_argument("--output-eval", required=True, help="Output evaluation JSON")
    parser.add_argument("--estimators", type=int, default=120)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--lr", type=float, default=0.06)
    parser.add_argument("--top-features", type=int, default=80)
    parser.add_argument("--min-child", type=int, default=8)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--prefix", default="gbrl")
    args = parser.parse_args()

    # ── Resolve output paths ──
    artifact_path = Path(args.output_artifact).resolve()
    eval_path = Path(args.output_eval).resolve()
    model_path = artifact_path.with_suffix("")
    gbrl_save_name = str(model_path)
    features_path = model_path.parent / f"{model_path.name}.features.json"

    print(f"[GBRL-Direct] Loading dataset from {args.input}...")
    t0 = time.time()

    with open(args.input, "r", encoding="utf-8") as f:
        dataset = json.load(f)

    samples = dataset.get("samples", [])
    if not samples:
        print("ERROR: No samples in dataset", file=sys.stderr)
        sys.exit(1)

    print(f"  {len(samples)} samples loaded ({time.time() - t0:.1f}s)")

    # ── Flatten features ──
    print("[GBRL-Direct] Flattening features...")
    flat_samples = []
    targets = []
    for sample in samples:
        flat = flatten_feature_slots(sample.get("feature_slots", {}))
        flat_samples.append(flat)
        targets.append(sample.get("target_value", 0.5))

    # ── Feature selection ──
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

    force_included = [
        f for f in FORCE_INCLUDE_FEATURES if f in all_keys and key_stats[f][1] >= 1
    ]
    print(f"  Force-included {len(force_included)} features")

    var_ranked = sorted(
        [
            k
            for k, (v, c) in key_stats.items()
            if v > 1e-10 and c >= 5 and k not in force_included
        ],
        key=lambda k: (-key_stats[k][0], -key_stats[k][1]),
    )[: args.top_features - len(force_included)]

    feature_names = force_included + var_ranked
    print(f"  Selected {len(feature_names)} features (from {len(all_keys)} total)")

    # ── Build matrix ──
    cat_indices = []
    for i, name in enumerate(feature_names):
        if is_categorical_feature(name):
            cat_indices.append(i)

    X = np.zeros((len(flat_samples), len(feature_names)), dtype=np.float64)
    for i, flat in enumerate(flat_samples):
        for j, name in enumerate(feature_names):
            X[i, j] = flat.get(name, 0.0)

    y = np.array(targets, dtype=np.float64)

    # ── Train/val split ──
    n = len(y)
    val_mask = np.array([hash(str(i)) % 5 == 0 for i in range(n)])
    train_mask = ~val_mask
    X_train, y_train = X[train_mask], y[train_mask]
    X_val, y_val = X[val_mask], y[val_mask]
    print(f"  Train: {train_mask.sum()}, Val: {val_mask.sum()}")

    # ═══════════════════════════════════════════════════
    # Phase 1: Train GBRL
    # ═══════════════════════════════════════════════════
    print(
        f"\n[GBRL-Direct] Training GBRL (estimators={args.estimators}, depth={args.depth}, lr={args.lr})..."
    )
    t1 = time.time()

    try:
        from gbrl.models import GBTModel

        tree_struct_cfg = {
            "max_depth": args.depth,
            "grow_policy": "oblivious",  # Must be oblivious for predictTree (binary leaf indexing)
            "n_bins": 256,
            "min_data_in_leaf": args.min_child,
            "par_th": 1000,
        }

        optimizers = [{"algo": "SGD", "lr": args.lr, "start_idx": 0, "stop_idx": 1}]

        gbrl_model = GBTModel(
            tree_struct=tree_struct_cfg,
            input_dim=len(feature_names),
            output_dim=1,
            optimizers=optimizers,
            verbose=1,
        )

        gbrl_model.set_bias_from_targets(y_train)
        final_loss = gbrl_model.fit(
            X_train,
            y_train.reshape(-1, 1),
            iterations=args.estimators,
        )

        train_time = time.time() - t1
        print(
            f"  GBRL training complete ({train_time:.1f}s), final_loss={final_loss:.4f}"
        )

        # Evaluate GBRL
        gbrl_pred_train = gbrl_model(
            X_train, requires_grad=False, tensor=False
        ).flatten()
        gbrl_pred_val = gbrl_model(X_val, requires_grad=False, tensor=False).flatten()

        gbrl_train_mae = float(np.mean(np.abs(y_train - gbrl_pred_train)))
        gbrl_val_mae = float(np.mean(np.abs(y_val - gbrl_pred_val)))
        gbrl_val_rmse = float(np.sqrt(np.mean((y_val - gbrl_pred_val) ** 2)))

        print(f"  GBRL Train MAE: {gbrl_train_mae:.4f}  Val MAE: {gbrl_val_mae:.4f}")

        gbrl_pred_all = gbrl_model(X, requires_grad=False, tensor=False).flatten()
        gbrl_range_min = float(gbrl_pred_all.min())
        gbrl_range_max = float(gbrl_pred_all.max())
        gbrl_range_span = gbrl_range_max - gbrl_range_min
        gbrl_mean = float(gbrl_pred_all.mean())
        print(
            f"  GBRL pred range: [{gbrl_range_min:.4f}, {gbrl_range_max:.4f}] span={gbrl_range_span:.4f} mean={gbrl_mean:.4f}"
        )
        print(
            f"  y_true range: [{float(y.min()):.4f}, {float(y.max()):.4f}] span={float(y.max() - y.min()):.4f} mean={float(y.mean()):.4f}"
        )

        num_trees = gbrl_model.get_num_trees()
        if isinstance(num_trees, tuple):
            num_trees = num_trees[0]
        print(f"  Trees: {num_trees}")

    except ImportError:
        print("ERROR: gbrl package not installed.", file=sys.stderr)
        print("  Install: pip install gbrl", file=sys.stderr)
        sys.exit(1)

    # ═══════════════════════════════════════════════════
    # Phase 2: Save GBRL model + features
    # ═══════════════════════════════════════════════════
    print(f"\n[GBRL-Direct] Saving GBRL model to {gbrl_save_name}...")
    gbrl_model.save_learner(gbrl_save_name)
    actual_model_path = f"{gbrl_save_name}.gbrl_model"
    print(f"  Model saved: {actual_model_path}")

    features_data = {
        "feature_names": feature_names,
        "cat_indices": cat_indices,
        "bias": float(np.mean(gbrl_pred_all[train_mask])),
        "input_dim": len(feature_names),
    }
    features_path.parent.mkdir(parents=True, exist_ok=True)
    with open(features_path, "w", encoding="utf-8") as f:
        json.dump(features_data, f)
    print(f"  Features saved: {features_path}")

    # ═══════════════════════════════════════════════════
    # Phase 2.5: Export tree structure as JSON
    # ═══════════════════════════════════════════════════
    trees_path = model_path.parent / f"{model_path.name}.gbrl-trees.json"
    print(f"\n[GBRL-Direct] Exporting tree structure to {trees_path}...")

    import io, os as _os, tempfile as _tempfile

    all_output = []
    for tree_idx in range(num_trees):
        # redirect_stdout doesn't work (C-level fprintf). os.dup2 works but pipe buffer
        # may overflow for verbose tree dumps. Use a temp file instead.
        tmpfd, tmpname = _tempfile.mkstemp(suffix=".txt", prefix="gbrl_tree_")
        _os.close(tmpfd)
        old_fd = _os.dup(1)
        try:
            fd_out = _os.open(tmpname, _os.O_WRONLY | _os.O_TRUNC)
            _os.dup2(fd_out, 1)
            _os.close(fd_out)
            gbrl_model.print_tree(tree_idx)
            sys.stdout.flush()
        finally:
            _os.dup2(old_fd, 1)
            _os.close(old_fd)
        with open(tmpname, "r", encoding="utf-8", errors="replace") as tf:
            output = tf.read()
        _os.unlink(tmpname)
        all_output.append(f"Tree {tree_idx}:\n{output}")
    tree_text = "\n".join(all_output)

    # Save raw output for debug
    debug_path = model_path.parent / f"{model_path.name}.print_tree_raw.txt"
    with open(debug_path, "w", encoding="utf-8") as df:
        df.write(tree_text)

    trees_export = _parse_print_tree_output(tree_text)

    trees_data = {
        "bias": float(np.mean(gbrl_pred_all[train_mask])),
        "feature_names": feature_names,
        "trees": trees_export,
    }
    with open(trees_path, "w", encoding="utf-8") as f:
        json.dump(trees_data, f)
    print(
        f"[GBRL-Direct] Exported {len(trees_export)} trees to {trees_path} (raw: {debug_path})"
    )

    # ═══════════════════════════════════════════════════
    # Phase 3: Export GBRL artifact + eval JSON
    # ═══════════════════════════════════════════════════
    artifact = {
        "artifact_type": "gbrl_value.v1",
        "artifact_version": "gbrl_direct_value",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_path": actual_model_path,
        "features_path": str(features_path),
        "bias": float(np.mean(gbrl_pred_all[train_mask])),
        "learning_rate": args.lr,
        "feature_names": feature_names,
        "metadata": {
            "dataset_id": dataset.get("dataset_id", "unknown"),
            "sample_count": len(samples),
            "n_estimators": args.estimators,
            "max_depth": args.depth,
            "num_trees": num_trees,
            "training_mae": gbrl_val_mae,
            "training_rmse": gbrl_val_rmse,
            "gbrl_train_mae": gbrl_train_mae,
            "gbrl_val_mae": gbrl_val_mae,
            "gbrl_range_min": gbrl_range_min,
            "gbrl_range_max": gbrl_range_max,
            "gbrl_range_span": gbrl_range_span,
            "gbrl_mean": gbrl_mean,
            "engine": "gbrl_direct",
        },
    }

    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    with open(artifact_path, "w", encoding="utf-8") as f:
        json.dump(artifact, f, separators=(",", ":"))
    print(f"  Artifact: {artifact_path}")

    # ── Eval JSON ──
    evaluation = {
        "engine": "gbrl_direct",
        "gbrl_train_mae": gbrl_train_mae,
        "gbrl_val_mae": gbrl_val_mae,
        "gbrl_val_rmse": gbrl_val_rmse,
        "gbrl_range_min": gbrl_range_min,
        "gbrl_range_max": gbrl_range_max,
        "gbrl_range_span": gbrl_range_span,
        "gbrl_mean": gbrl_mean,
        "sample_count": len(samples),
        "train_count": int(train_mask.sum()),
        "val_count": int(val_mask.sum()),
        "n_estimators": args.estimators,
        "max_depth": args.depth,
        "learning_rate": args.lr,
        "feature_count": len(feature_names),
        "categorical_feature_count": len(cat_indices),
        "gbrl_training_time_sec": train_time,
    }
    with open(eval_path, "w", encoding="utf-8") as f:
        json.dump(evaluation, f, indent=2)
    print(f"  Eval: {eval_path}")

    print(
        f"\n[GBRL-Direct] Done. Val MAE={gbrl_val_mae:.4f}, Range=[{gbrl_range_min:.4f}, {gbrl_range_max:.4f}]"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback

        traceback.print_exc()
        sys.exit(1)
