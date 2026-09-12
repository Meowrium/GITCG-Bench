#!/usr/bin/env python3
"""V30 KPI-B deeper diagnosis: feature importance + ext-only vs base-only model."""

import json
import numpy as np
from pathlib import Path
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
import lightgbm as lgb


def load_ndjson(path: Path):
    f, e, y, w = [], [], [], []
    with open(path) as fp:
        for line in fp:
            obj = json.loads(line)
            f.append(obj["f"]); e.append(obj["e"]); y.append(obj["y"]); w.append(obj.get("w", 1.0))
    return np.asarray(f), np.asarray(e), np.asarray(y), np.asarray(w)


def fit_lgbm(X_train, y_train, w_train, X_test, y_test, name=""):
    train_set = lgb.Dataset(X_train, label=y_train, weight=w_train, free_raw_data=False)
    test_set = lgb.Dataset(X_test, label=y_test, reference=train_set, free_raw_data=False)
    params = {"objective": "binary", "metric": ["binary_logloss"],
              "learning_rate": 0.05, "num_leaves": 31, "min_data_in_leaf": 50,
              "feature_fraction": 0.85, "bagging_fraction": 0.85, "bagging_freq": 5,
              "verbosity": -1, "seed": 0}
    model = lgb.train(params, train_set, num_boost_round=400, valid_sets=[test_set],
                      callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=False)])
    p_test = model.predict(X_test)
    return model, accuracy_score(y_test, (p_test >= 0.5).astype(int)), \
           log_loss(y_test, np.clip(p_test, 1e-7, 1 - 1e-7))


def main():
    out_dir = Path("examples/output/v30-kpib/holdout")
    f_tr, e_tr, y_tr, w_tr = load_ndjson(out_dir / "train.ndjson")
    f_te, e_te, y_te, w_te = load_ndjson(out_dir / "test.ndjson")

    # Load feature names (we know base dim = 83 from FeatureExtractor and ext dim = 85)
    # For diagnostic only, we can load names from a previous run
    base_dim, ext_dim = f_tr.shape[1], e_tr.shape[1]
    names_path = Path("examples/output/v30-kpib/holdout/feature-names.json")
    if names_path.exists():
        names = json.loads(names_path.read_text())
        all_names = names["base"] + names["ext"]
    else:
        all_names = [f"base_{i}" for i in range(base_dim)] + [f"ext_{i}" for i in range(ext_dim)]

    X_tr = np.concatenate([f_tr, e_tr], axis=1)
    X_te = np.concatenate([f_te, e_te], axis=1)

    print("=" * 72)
    print("EXT-only LightGBM (does ext alone carry any signal?)")
    print("=" * 72)
    model_ext_only, acc_ext, loss_ext = fit_lgbm(e_tr, y_tr, w_tr, e_te, y_te, "ext-only")
    print(f"  ext-only:  test_acc={acc_ext:.4f}  test_loss={loss_ext:.4f}")
    # Compare to a constant predictor
    base_rate = y_tr.mean()
    const_pred = np.full_like(y_te, base_rate, dtype=np.float64)
    const_loss = log_loss(y_te, np.clip(const_pred, 1e-7, 1 - 1e-7))
    const_acc = accuracy_score(y_te, (const_pred >= 0.5).astype(int))
    print(f"  constant:  test_acc={const_acc:.4f}  test_loss={const_loss:.4f}  (predicting {base_rate:.4f})")
    print(f"  ext alone improves over constant: acc +{(acc_ext-const_acc)*100:+.2f}pp  loss {(1-loss_ext/const_loss)*100:+.2f}%")
    print()

    print("=" * 72)
    print("LightGBM full model — top 20 feature importance (gain)")
    print("=" * 72)
    full_model, _, _ = fit_lgbm(X_tr, y_tr, w_tr, X_te, y_te, "full")
    imp_gain = full_model.feature_importance(importance_type="gain")
    imp_split = full_model.feature_importance(importance_type="split")
    ranked = sorted(zip(all_names, imp_gain, imp_split), key=lambda r: -r[1])
    base_in_top20 = 0
    ext_in_top20 = 0
    print(f"  {'rank':<5} {'feature':<42} {'gain':>10} {'splits':>8}  {'group':>5}")
    for i, (n, g, s) in enumerate(ranked[:20]):
        is_ext = i >= 0 and any(n == nm for nm in all_names[base_dim:])
        if is_ext: ext_in_top20 += 1
        else: base_in_top20 += 1
        group = "ext" if is_ext else "base"
        print(f"  {i+1:<5} {n[:42]:<42} {g:>10.1f} {s:>8d}  {group:>5}")
    total_gain = imp_gain.sum()
    base_gain = imp_gain[:base_dim].sum()
    ext_gain = imp_gain[base_dim:].sum()
    print()
    print(f"  base/ext share of TOTAL gain:  base {base_gain/total_gain*100:.1f}% ({base_dim} feats), ext {ext_gain/total_gain*100:.1f}% ({ext_dim} feats)")
    print(f"  top-20 split:  base={base_in_top20}, ext={ext_in_top20}")

    # Bootstrap CI on the test-set delta
    print()
    print("=" * 72)
    print("Bootstrap CI on holdout test-set log-loss delta (lgbm full vs base-only)")
    print("=" * 72)
    base_model, _, _ = fit_lgbm(f_tr, y_tr, w_tr, f_te, y_te, "base")
    p_full = full_model.predict(X_te)
    p_base = base_model.predict(f_te)
    n = len(y_te)
    rng = np.random.default_rng(42)
    deltas_loss = []
    deltas_acc = []
    for _ in range(500):
        idx = rng.integers(0, n, size=n)
        l_full = log_loss(y_te[idx], np.clip(p_full[idx], 1e-7, 1 - 1e-7))
        l_base = log_loss(y_te[idx], np.clip(p_base[idx], 1e-7, 1 - 1e-7))
        a_full = accuracy_score(y_te[idx], (p_full[idx] >= 0.5).astype(int))
        a_base = accuracy_score(y_te[idx], (p_base[idx] >= 0.5).astype(int))
        deltas_loss.append((1 - l_full / l_base) * 100)
        deltas_acc.append((a_full - a_base) * 100)
    deltas_loss = np.array(deltas_loss)
    deltas_acc = np.array(deltas_acc)
    print(f"  delta_loss%:  median={np.median(deltas_loss):+.3f}  CI95=[{np.quantile(deltas_loss, 0.025):+.3f}, {np.quantile(deltas_loss, 0.975):+.3f}]")
    print(f"  delta_acc_pp: median={np.median(deltas_acc):+.3f}  CI95=[{np.quantile(deltas_acc, 0.025):+.3f}, {np.quantile(deltas_acc, 0.975):+.3f}]")
    p_loss_pos = (deltas_loss > 0).mean()
    p_acc_pos = (deltas_acc > 0).mean()
    print(f"  P(delta_loss>0): {p_loss_pos:.3f}    P(delta_acc>0): {p_acc_pos:.3f}")


if __name__ == "__main__":
    main()
