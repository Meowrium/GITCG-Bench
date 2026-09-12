#!/usr/bin/env python3
"""
V30 KPI-B holdout evaluation: train logistic + lightgbm on base / base+ext,
report holdout-set accuracy and log-loss.

Inputs:
  examples/output/v30-kpib/holdout/{train,test}.ndjson
    Each line: {"f": [83 base], "e": [85 ext], "y": 0|1, "w": float}

Outputs:
  examples/output/v30-kpib/report-holdout.json
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss
import lightgbm as lgb


def load_ndjson(path: Path):
    f, e, y, w = [], [], [], []
    with open(path) as fp:
        for line in fp:
            obj = json.loads(line)
            f.append(obj["f"])
            e.append(obj["e"])
            y.append(obj["y"])
            w.append(obj.get("w", 1.0))
    return (
        np.asarray(f, dtype=np.float64),
        np.asarray(e, dtype=np.float64),
        np.asarray(y, dtype=np.float64),
        np.asarray(w, dtype=np.float64),
    )


def fit_logistic(X_train, y_train, w_train, X_test, y_test, C=10.0):
    clf = LogisticRegression(
        C=C,
        max_iter=300,
        solver="liblinear",
        random_state=0,
    )
    clf.fit(X_train, y_train, sample_weight=w_train)
    p_train = clf.predict_proba(X_train)[:, 1]
    p_test = clf.predict_proba(X_test)[:, 1]
    return {
        "train_acc": accuracy_score(y_train, (p_train >= 0.5).astype(int), sample_weight=w_train),
        "train_loss": log_loss(y_train, np.clip(p_train, 1e-7, 1 - 1e-7), sample_weight=w_train),
        "test_acc": accuracy_score(y_test, (p_test >= 0.5).astype(int)),
        "test_loss": log_loss(y_test, np.clip(p_test, 1e-7, 1 - 1e-7)),
        "n_features": X_train.shape[1],
    }


def fit_lgbm(X_train, y_train, w_train, X_test, y_test):
    train_set = lgb.Dataset(X_train, label=y_train, weight=w_train, free_raw_data=False)
    test_set = lgb.Dataset(X_test, label=y_test, reference=train_set, free_raw_data=False)
    params = {
        "objective": "binary",
        "metric": ["binary_logloss", "binary_error"],
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 50,
        "feature_fraction": 0.85,
        "bagging_fraction": 0.85,
        "bagging_freq": 5,
        "verbosity": -1,
        "seed": 0,
    }
    model = lgb.train(
        params,
        train_set,
        num_boost_round=400,
        valid_sets=[test_set],
        callbacks=[lgb.early_stopping(stopping_rounds=20, verbose=False)],
    )
    p_train = model.predict(X_train)
    p_test = model.predict(X_test)
    return {
        "train_acc": accuracy_score(y_train, (p_train >= 0.5).astype(int), sample_weight=w_train),
        "train_loss": log_loss(y_train, np.clip(p_train, 1e-7, 1 - 1e-7), sample_weight=w_train),
        "test_acc": accuracy_score(y_test, (p_test >= 0.5).astype(int)),
        "test_loss": log_loss(y_test, np.clip(p_test, 1e-7, 1 - 1e-7)),
        "best_iter": model.best_iteration,
        "n_features": X_train.shape[1],
    }


def fmt(d: dict) -> str:
    return (
        f"train_acc={d['train_acc']:.4f}  test_acc={d['test_acc']:.4f}  "
        f"train_loss={d['train_loss']:.4f}  test_loss={d['test_loss']:.4f}  "
        f"n={d['n_features']}"
    )


def main():
    out_dir = Path("examples/output/v30-kpib/holdout")
    f_train, e_train, y_train, w_train = load_ndjson(out_dir / "train.ndjson")
    f_test, e_test, y_test, w_test = load_ndjson(out_dir / "test.ndjson")
    print(f"train: {f_train.shape[0]} samples; test: {f_test.shape[0]} samples")
    print(f"base dim: {f_train.shape[1]}, ext dim: {e_train.shape[1]}")

    # Concat helpers
    X_train_base = f_train
    X_test_base = f_test
    X_train_full = np.concatenate([f_train, e_train], axis=1)
    X_test_full = np.concatenate([f_test, e_test], axis=1)

    print()
    print("=" * 72)
    print("LOGISTIC")
    print("=" * 72)
    t0 = time.time()
    lr_base = fit_logistic(X_train_base, y_train, w_train, X_test_base, y_test)
    print(f"  base : {fmt(lr_base)}  ({time.time()-t0:.1f}s)")
    t0 = time.time()
    lr_ext = fit_logistic(X_train_full, y_train, w_train, X_test_full, y_test)
    print(f"  ext  : {fmt(lr_ext)}  ({time.time()-t0:.1f}s)")
    print(
        f"  delta_acc:  {(lr_ext['test_acc']-lr_base['test_acc'])*100:+.3f} pp  "
        f"delta_loss: {(1 - lr_ext['test_loss']/lr_base['test_loss'])*100:+.3f} %"
    )

    print()
    print("=" * 72)
    print("LIGHTGBM")
    print("=" * 72)
    t0 = time.time()
    lg_base = fit_lgbm(X_train_base, y_train, w_train, X_test_base, y_test)
    print(f"  base : {fmt(lg_base)}  iters={lg_base['best_iter']}  ({time.time()-t0:.1f}s)")
    t0 = time.time()
    lg_ext = fit_lgbm(X_train_full, y_train, w_train, X_test_full, y_test)
    print(f"  ext  : {fmt(lg_ext)}  iters={lg_ext['best_iter']}  ({time.time()-t0:.1f}s)")
    print(
        f"  delta_acc:  {(lg_ext['test_acc']-lg_base['test_acc'])*100:+.3f} pp  "
        f"delta_loss: {(1 - lg_ext['test_loss']/lg_base['test_loss'])*100:+.3f} %"
    )

    print()
    print("=" * 72)
    print("KPI-B verdict")
    print("=" * 72)
    for name, base, ext in [
        ("logistic", lr_base, lr_ext),
        ("lightgbm", lg_base, lg_ext),
    ]:
        d_acc = (ext["test_acc"] - base["test_acc"]) * 100
        d_loss = (1 - ext["test_loss"] / base["test_loss"]) * 100
        verdict = "PASS" if (d_acc >= 2 and d_loss >= 5) else (
            "SIGNAL" if (d_acc >= 0.5 or d_loss >= 1) else "NO_SIGNAL"
        )
        print(
            f"  {name:8s}: holdout delta_acc={d_acc:+.3f}pp  delta_loss={d_loss:+.3f}%  → {verdict}"
        )

    report = {
        "logistic": {"base": lr_base, "ext": lr_ext},
        "lightgbm": {"base": lg_base, "ext": lg_ext},
    }
    Path("examples/output/v30-kpib/report-holdout.json").write_text(
        json.dumps(report, indent=2)
    )
    print()
    print("report → examples/output/v30-kpib/report-holdout.json")


if __name__ == "__main__":
    main()
