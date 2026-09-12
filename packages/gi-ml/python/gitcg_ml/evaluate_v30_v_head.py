"""
V30 Stage 3 — V(s) head explained variance.

V30 §5.6 acceptance: "V(s) head 在保留的对局上 explained variance ≥ 0.4"

Loads the encoder weights, runs V head over the held-out test split, and
computes:
    explained_variance = 1 - Var[label - V(s)] / Var[label]

Also reports per-round explained variance to surface where the V head is
informative (typically R2-R4) vs where it's noisy (R1 dominated by random
draw / coin flip).

Usage:
    python -m gitcg_ml.evaluate_v30_v_head \
        --weights encoder-weights.json \
        --val test.ndjson \
        --out v_head_report.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from gitcg_ml.train_v30_encoder import (
    HParams,
    StateObservationDataset,
    V30Encoder,
    Vocabularies,
    collate,
    read_ndjson,
)


def collect_v_predictions(
    model: V30Encoder,
    loader: DataLoader[dict[str, torch.Tensor]],
    device: torch.device,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    vs = []
    labels = []
    weights = []
    rounds = []
    model.eval()
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            _, v, _ = model(batch)
            vs.append(v.cpu().numpy())
            labels.append(batch["label"].cpu().numpy())
            weights.append(batch["weight"].cpu().numpy())
            # global_meta[..., 0] is round / 12 — recover rounds for stratification
            r = (batch["global_meta"][..., 0].cpu().numpy() * 12).round().astype(int)
            rounds.append(r)
    return (
        np.concatenate(vs),
        np.concatenate(labels),
        np.concatenate(weights),
        np.concatenate(rounds),
    )


def weighted_var(x: np.ndarray, w: np.ndarray) -> float:
    if w.sum() <= 0:
        return float("nan")
    mean = float((x * w).sum() / w.sum())
    return float(((x - mean) ** 2 * w).sum() / w.sum())


def explained_variance(
    label: np.ndarray, pred: np.ndarray, weight: np.ndarray
) -> float:
    var_label = weighted_var(label, weight)
    if var_label <= 0:
        return float("nan")
    var_resid = weighted_var(label - pred, weight)
    return 1 - var_resid / var_label


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--val", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args(argv)

    device = torch.device("cuda" if torch.cuda.is_available() and not args.cpu else "cpu")

    with open(args.weights, "rt", encoding="utf-8") as fh:
        bundle = json.load(fh)
    vocabs = Vocabularies.from_json(bundle["vocabularies"])
    hp = HParams(
        embed_dim=bundle["h_params"]["embed_dim"],
        hidden_dim=bundle["h_params"]["hidden_dim"],
        state_repr_dim=bundle["h_params"]["state_repr_dim"],
        action_repr_dim=bundle["h_params"]["action_repr_dim"],
        dropout=bundle["h_params"]["dropout"],
    )
    model = V30Encoder(vocabs, hp).to(device)
    state_dict = {k: torch.tensor(v["values"]).reshape(v["shape"]) for k, v in bundle["state_dict"].items()}
    model.load_state_dict(state_dict)

    records = read_ndjson(args.val)
    print(f"[v_head] loaded {len(records)} val records", file=sys.stderr)
    ds = StateObservationDataset(records, vocabs)
    loader = DataLoader(ds, batch_size=args.batch_size, shuffle=False, collate_fn=collate)

    v_pred, label, weight, rounds = collect_v_predictions(model, loader, device)

    # V head outputs raw logits-ish; for explained variance we want it in
    # probability space so the residual is comparable to label ∈ {0, 1}.
    # Apply sigmoid here (consistent with how V is used downstream as a
    # win-probability proxy).
    v_prob = 1.0 / (1.0 + np.exp(-v_pred))

    ev_overall = explained_variance(label, v_prob, weight)

    # Per-round breakdown
    per_round = {}
    for r in sorted(set(rounds.tolist())):
        if r <= 0:
            continue
        mask = rounds == r
        if mask.sum() < 50:
            continue
        per_round[int(r)] = {
            "n": int(mask.sum()),
            "ev": explained_variance(label[mask], v_prob[mask], weight[mask]),
            "v_mean": float((v_prob[mask] * weight[mask]).sum() / weight[mask].sum()),
            "label_mean": float((label[mask] * weight[mask]).sum() / weight[mask].sum()),
        }

    # Bias / scale diagnostics
    pred_mean = float((v_prob * weight).sum() / weight.sum())
    label_mean = float((label * weight).sum() / weight.sum())

    threshold = 0.4
    passed = ev_overall >= threshold

    report = {
        "weights_in": args.weights,
        "n_val": len(records),
        "explained_variance_overall": ev_overall,
        "threshold": threshold,
        "passed": passed,
        "label_mean": label_mean,
        "v_pred_mean": pred_mean,
        "v_pred_var": weighted_var(v_prob, weight),
        "label_var": weighted_var(label, weight),
        "per_round": per_round,
    }
    print(json.dumps(report, indent=2))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "wt", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)

    print(f"\nV30 §5.6 V(s) explained variance: {ev_overall:.4f} (threshold ≥ {threshold}) {'✓ PASSED' if passed else '✗ FAILED'}", file=sys.stderr)


if __name__ == "__main__":
    main()
