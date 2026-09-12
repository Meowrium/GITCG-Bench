"""
V30 Stage 3 — Temperature scaling for encoder logits.

Loads a trained encoder weights bundle, finds the optimal temperature T
on the held-out test set so that softmax(logit/T) minimises NLL, and
writes a re-calibrated weights bundle. This is the cheapest fix when an
encoder has good ranking (Δacc OK) but bad calibration (Δloss not OK)
— Guo et al. 2017.

For binary BCE on a single chosen-action logit, "softmax/T" reduces to
sigmoid(logit/T). We grid-search T ∈ [0.5, 5.0] with golden-section
refinement.

Usage:
    python -m gitcg_ml.calibrate_v30_encoder \
        --weights encoder-weights.json \
        --val test.ndjson \
        --out  encoder-weights.calibrated.json \
        --report encoder-report-calibrated.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader

from gitcg_ml.train_v30_encoder import (
    HParams,
    StateObservationDataset,
    V30Encoder,
    Vocabularies,
    collate,
    read_ndjson,
)


def collect_logits(
    model: V30Encoder,
    loader: DataLoader[dict[str, torch.Tensor]],
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    selected_logits = []
    labels = []
    weights = []
    model.eval()
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            q, _, _ = model(batch)
            sel = batch["selected_action"]
            sel_q = q.gather(1, sel.unsqueeze(1)).squeeze(1)
            selected_logits.append(sel_q.cpu())
            labels.append(batch["label"].cpu())
            weights.append(batch["weight"].cpu())
    return (
        torch.cat(selected_logits, dim=0),
        torch.cat(labels, dim=0),
        torch.cat(weights, dim=0),
    )


def bce_at_temperature(
    logits: torch.Tensor,
    labels: torch.Tensor,
    weights: torch.Tensor,
    T: float,
) -> tuple[float, float]:
    scaled = logits / T
    bce = F.binary_cross_entropy_with_logits(scaled, labels, reduction="none")
    weighted = (bce * weights).sum() / weights.sum().clamp_min(1.0)
    pred = (scaled >= 0).float()
    acc = ((pred == labels).float() * weights).sum() / weights.sum().clamp_min(1.0)
    return float(weighted.item()), float(acc.item())


def golden_section(
    logits: torch.Tensor,
    labels: torch.Tensor,
    weights: torch.Tensor,
    lo: float = 0.5,
    hi: float = 8.0,
    iters: int = 30,
) -> float:
    phi = (math.sqrt(5) - 1) / 2  # 0.618
    a, b = lo, hi
    c = b - phi * (b - a)
    d = a + phi * (b - a)
    fc, _ = bce_at_temperature(logits, labels, weights, c)
    fd, _ = bce_at_temperature(logits, labels, weights, d)
    for _ in range(iters):
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - phi * (b - a)
            fc, _ = bce_at_temperature(logits, labels, weights, c)
        else:
            a, c, fc = c, d, fd
            d = a + phi * (b - a)
            fd, _ = bce_at_temperature(logits, labels, weights, d)
    return (a + b) / 2


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--val", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--report", default=None)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--cpu", action="store_true")
    args = parser.parse_args(argv)

    device = torch.device("cuda" if torch.cuda.is_available() and not args.cpu else "cpu")
    print(f"[calibrate] device={device}", file=sys.stderr)

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
    print(f"[calibrate] val records={len(records)}", file=sys.stderr)
    ds = StateObservationDataset(records, vocabs)
    loader = DataLoader(ds, batch_size=args.batch_size, shuffle=False, collate_fn=collate)

    logits, labels, weights = collect_logits(model, loader, device)

    bce_T1, acc_T1 = bce_at_temperature(logits, labels, weights, 1.0)
    T_star = golden_section(logits, labels, weights)
    bce_Ts, acc_Ts = bce_at_temperature(logits, labels, weights, T_star)

    print(f"[calibrate] T=1.0  bce={bce_T1:.4f}  acc={acc_T1:.4f}")
    print(f"[calibrate] T*={T_star:.4f}  bce={bce_Ts:.4f}  acc={acc_Ts:.4f}")
    print(f"[calibrate] BCE reduction: {(1 - bce_Ts / bce_T1) * 100:.2f}%")

    # Bake the temperature into the model: scale value_head and advantage_head
    # final-layer weights+bias by 1/T. After this transformation, predict()
    # at T=1.0 produces identical logits to the un-baked model at T=T*.
    with torch.no_grad():
        model.value_head[3].weight.div_(T_star)
        model.value_head[3].bias.div_(T_star)
        model.advantage_head[3].weight.div_(T_star)
        model.advantage_head[3].bias.div_(T_star)

    # Sanity check: re-run val
    logits2, _, _ = collect_logits(model, loader, device)
    bce_check, acc_check = bce_at_temperature(logits2, labels, weights, 1.0)
    print(f"[calibrate] post-bake T=1.0  bce={bce_check:.4f}  acc={acc_check:.4f}")

    # Export calibrated weights
    new_state_dict = {
        k: {
            "shape": list(v.shape),
            "dtype": str(v.dtype).replace("torch.", ""),
            "values": v.detach().cpu().reshape(-1).tolist(),
        }
        for k, v in model.state_dict().items()
    }
    bundle["state_dict"] = new_state_dict
    bundle.setdefault("calibration", {})["temperature_scale"] = T_star
    bundle["calibration"]["bce_before"] = bce_T1
    bundle["calibration"]["bce_after"] = bce_Ts
    bundle["calibration"]["acc_before"] = acc_T1
    bundle["calibration"]["acc_after"] = acc_Ts

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wt", encoding="utf-8") as fh:
        json.dump(bundle, fh)

    if args.report:
        report = {
            "weights_in": args.weights,
            "weights_out": args.out,
            "val_size": len(records),
            "temperature_scale": T_star,
            "before": {"bce": bce_T1, "acc": acc_T1},
            "after":  {"bce": bce_Ts, "acc": acc_Ts},
            "bce_reduction_pct": (1 - bce_Ts / bce_T1) * 100,
        }
        with open(args.report, "wt", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    print(json.dumps({"T": T_star, "bce_before": bce_T1, "bce_after": bce_Ts}))


if __name__ == "__main__":
    main()
