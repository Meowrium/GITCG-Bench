# Copyright (C) 2026 Piovium Labs
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
"""
V31 F6 / D4 — cross-generation gameplay analysis.

Loads self-play sample DBs (each row carries `StateObservation` + `policy_target`
+ `label`) and / or per-game gen-vs-gen capture JSONs, scores every position
through each encoder generation, and surfaces:

  1. global stats per generation (V-head agreement with outcome, π entropy,
     action-case distribution, top-K confidence)
  2. cross-gen disagreements: positions where gen N+1's argmax differs from
     gen N's argmax (with the biggest Q-delta), grouped by round / phase /
     action_case so we can see *what kinds* of decisions changed
  3. concrete worked examples (a handful of the largest disagreements) printed
     with the position summary so they can be inspected by hand

Usage:
    python -m gitcg_ml.analyze_flywheel \
        --weights gen0=encoder-weights-tdfull.json gen1=encoder-weights-gen1.json gen2=encoder-weights-gen2.json \
        --self-play gen0-selfplay.sqlite gen1-selfplay.sqlite \
        --max-rows 3000 \
        --out flywheel-analysis.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch.utils.data import DataLoader

from gitcg_ml.train_v30_encoder import (
    HParams,
    StateObservationDataset,
    V30Encoder,
    Vocabularies,
    collate,
)


def load_predictor(path: str) -> tuple[V30Encoder, Vocabularies, HParams, torch.device]:
    with open(path, "rt", encoding="utf-8") as fh:
        bundle = json.load(fh)
    vocabs = Vocabularies.from_json(bundle["vocabularies"])
    hp = HParams(
        embed_dim=bundle["h_params"]["embed_dim"],
        hidden_dim=bundle["h_params"]["hidden_dim"],
        state_repr_dim=bundle["h_params"]["state_repr_dim"],
        action_repr_dim=bundle["h_params"]["action_repr_dim"],
        dropout=bundle["h_params"]["dropout"],
    )
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = V30Encoder(vocabs, hp).to(device)
    state_dict = {
        k: torch.tensor(v["values"]).reshape(v["shape"]) for k, v in bundle["state_dict"].items()
    }
    model.load_state_dict(state_dict)
    model.eval()
    return model, vocabs, hp, device


def load_records_from_sqlite(db_path: str, max_rows: int | None = None) -> list[dict[str, Any]]:
    """Load StateObservationRecord-style rows from a self-play DB."""
    conn = sqlite3.connect(db_path)
    cur = conn.execute(
        "SELECT game_id, round, turn, player, state_observation, label, weight "
        "FROM samples WHERE state_observation IS NOT NULL ORDER BY id"
    )
    rows: list[dict[str, Any]] = []
    for r in cur:
        game_id, rnd, turn, player, so_json, label, weight = r
        obs = json.loads(so_json)
        rows.append({
            "observation": obs,
            "label": float(label),
            "weight": float(weight),
            "game_id": game_id,
            "round": int(rnd),
            "turn": int(turn),
            "player": int(player),
        })
        if max_rows and len(rows) >= max_rows:
            break
    conn.close()
    return rows


def load_capture_json(path: str) -> list[dict[str, Any]]:
    """Load per-decision samples from a gen-vs-gen capture JSON."""
    with open(path, "rt", encoding="utf-8") as fh:
        payload = json.load(fh)
    rows: list[dict[str, Any]] = []
    winner = payload.get("winner")
    new_side = payload.get("new_side")
    for d in payload.get("decisions", []):
        rows.append({
            "observation": d["observation"],
            # label = did *this side* win? gen-vs-gen uses winner ∈ {0,1,None}.
            "label": 1.0 if winner == d["side"] else (0.0 if winner is not None else 0.5),
            "weight": 1.0,
            "game_id": d["game_id"],
            "round": d["round"],
            "turn": d["turn"],
            "player": d["side"],
            "agent_label": d["agent_label"],
            "captured_visits": d.get("visit_distribution"),
            "captured_q": d.get("mean_q"),
            "captured_chosen": d.get("chosen_index"),
            "matchup_new_side": new_side,
            "matchup_winner": winner,
        })
    return rows


def predict_batch(model: V30Encoder, vocabs: Vocabularies, records: list[dict[str, Any]],
                  device: torch.device, batch_size: int = 64) -> dict[str, np.ndarray]:
    """Run `records` through `model`; return ndarrays for v, q, masked argmax."""
    ds = StateObservationDataset(records, vocabs)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False, collate_fn=collate)
    out_v = []
    out_argmax = []
    out_top_p = []
    out_entropy = []
    out_q_chosen = []
    out_q_argmax = []
    out_n_cands = []
    with torch.no_grad():
        for batch in loader:
            batch_dev = {k: v.to(device) for k, v in batch.items()}
            q, v, _ = model(batch_dev)
            mask = batch_dev["action_mask"]
            # Mask invalid candidates with -inf for argmax / softmax.
            q_masked = torch.where(mask > 0, q, torch.full_like(q, -1e9))
            argmax = q_masked.argmax(dim=1)
            # softmax over valid candidates only
            log_p = torch.log_softmax(q_masked, dim=1)
            p = torch.exp(log_p)
            top_p = p.gather(1, argmax.unsqueeze(1)).squeeze(1)
            entropy = -(p * log_p).sum(dim=1)
            sel = batch_dev["selected_action"]
            q_chosen = q.gather(1, sel.unsqueeze(1)).squeeze(1)
            q_argmax = q_masked.gather(1, argmax.unsqueeze(1)).squeeze(1)
            n_cands = mask.sum(dim=1)
            out_v.append(v.cpu().numpy())
            out_argmax.append(argmax.cpu().numpy())
            out_top_p.append(top_p.cpu().numpy())
            out_entropy.append(entropy.cpu().numpy())
            out_q_chosen.append(q_chosen.cpu().numpy())
            out_q_argmax.append(q_argmax.cpu().numpy())
            out_n_cands.append(n_cands.cpu().numpy())
    return {
        "v": np.concatenate(out_v),
        "v_prob": 1.0 / (1.0 + np.exp(-np.concatenate(out_v))),
        "argmax": np.concatenate(out_argmax),
        "top_p": np.concatenate(out_top_p),
        "entropy": np.concatenate(out_entropy),
        "q_chosen": np.concatenate(out_q_chosen),
        "q_argmax": np.concatenate(out_q_argmax),
        "n_cands": np.concatenate(out_n_cands),
    }


def summarise_generation(name: str, preds: dict[str, np.ndarray],
                         records: list[dict[str, Any]]) -> dict[str, Any]:
    label = np.array([r["label"] for r in records])
    v_prob = preds["v_prob"]
    n = len(label)
    # Brier (lower better) + sign-agreement
    brier = float(np.mean((v_prob - label) ** 2))
    sign_acc = float(np.mean((v_prob >= 0.5).astype(np.float32) == label))
    # Argmax-of-Q agrees with the actually-chosen (target) action?
    chosen = np.array([r["observation"].get("selected_action_index") or 0 for r in records])
    argmax = preds["argmax"]
    pi_agreement = float(np.mean(argmax == chosen))
    # Action-case distribution of the model's argmax
    case_of_argmax: Counter[str] = Counter()
    for i in range(n):
        cas = records[i]["observation"]["candidate_actions"]
        idx = int(argmax[i])
        if 0 <= idx < len(cas):
            case_of_argmax[cas[idx].get("action_case", "unknown")] += 1
    # Per-round V calibration
    per_round: dict[int, dict[str, float]] = {}
    for i in range(n):
        r = records[i]["round"]
        per_round.setdefault(r, {"n": 0.0, "v_sum": 0.0, "label_sum": 0.0})
        per_round[r]["n"] += 1
        per_round[r]["v_sum"] += v_prob[i]
        per_round[r]["label_sum"] += label[i]
    for r, st in per_round.items():
        st["v_mean"] = st["v_sum"] / max(1, st["n"])
        st["label_mean"] = st["label_sum"] / max(1, st["n"])
    return {
        "generation": name,
        "n_positions": n,
        "v_brier": brier,
        "v_sign_acc": sign_acc,
        "argmax_eq_chosen": pi_agreement,
        "v_prob_mean": float(v_prob.mean()),
        "v_prob_std": float(v_prob.std()),
        "entropy_mean": float(preds["entropy"].mean()),
        "top_p_mean": float(preds["top_p"].mean()),
        "n_cands_mean": float(preds["n_cands"].mean()),
        "argmax_case_distribution": dict(case_of_argmax),
        "per_round": {str(k): {kk: float(vv) for kk, vv in v.items() if kk != "v_sum" and kk != "label_sum"} for k, v in per_round.items()},
    }


def cross_generation_diff(gen_a_name: str, preds_a: dict[str, np.ndarray],
                          gen_b_name: str, preds_b: dict[str, np.ndarray],
                          records: list[dict[str, Any]],
                          top_k_examples: int = 12) -> dict[str, Any]:
    """Find positions where gen A's argmax differs from gen B's argmax."""
    argmax_a = preds_a["argmax"]
    argmax_b = preds_b["argmax"]
    diff_mask = argmax_a != argmax_b
    n_total = len(records)
    n_diff = int(diff_mask.sum())
    by_case: Counter[tuple[str, str]] = Counter()
    by_round: Counter[int] = Counter()
    deltas: list[tuple[int, float, int, int]] = []  # (idx, |q_b@argmax_b - q_b@argmax_a|, a_choice, b_choice)
    for i in np.where(diff_mask)[0]:
        i = int(i)
        cas = records[i]["observation"]["candidate_actions"]
        ai, bi = int(argmax_a[i]), int(argmax_b[i])
        case_a = cas[ai].get("action_case", "unknown") if 0 <= ai < len(cas) else "?"
        case_b = cas[bi].get("action_case", "unknown") if 0 <= bi < len(cas) else "?"
        by_case[(case_a, case_b)] += 1
        by_round[int(records[i]["round"])] += 1
        # Magnitude: how much does B prefer its own choice vs A's choice?
        n_c = len(cas)
        if ai < n_c and bi < n_c:
            # We need both q values from B. Recompute via approximating with q_chosen vs q_argmax —
            # for non-chosen indices we need full q tensor, which we don't keep. Use top_p_b as a proxy
            # for confidence in B's pick.
            mag = float(preds_b["top_p"][i] - preds_a["top_p"][i])
        else:
            mag = 0.0
        deltas.append((i, mag, ai, bi))
    deltas.sort(key=lambda x: -abs(x[1]))
    # Worked examples
    examples = []
    for i, mag, ai, bi in deltas[:top_k_examples]:
        rec = records[i]
        cas = rec["observation"]["candidate_actions"]
        examples.append({
            "ply_idx": i,
            "game_id": rec["game_id"],
            "round": rec["round"],
            "turn": rec["turn"],
            "side": rec["player"],
            "n_candidates": len(cas),
            "{a}_choice".format(a=gen_a_name): {
                "case": cas[ai].get("action_case") if 0 <= ai < len(cas) else None,
                "primary_def_id": cas[ai].get("primary_definition_id") if 0 <= ai < len(cas) else None,
                "top_p": float(preds_a["top_p"][i]),
                "v_prob": float(preds_a["v_prob"][i]),
            },
            "{b}_choice".format(b=gen_b_name): {
                "case": cas[bi].get("action_case") if 0 <= bi < len(cas) else None,
                "primary_def_id": cas[bi].get("primary_definition_id") if 0 <= bi < len(cas) else None,
                "top_p": float(preds_b["top_p"][i]),
                "v_prob": float(preds_b["v_prob"][i]),
            },
            "confidence_delta_b_minus_a": mag,
            "label": float(rec["label"]),
            "active_def_id_self": rec["observation"]["self"].get("active_definition_id"),
            "active_def_id_opp": rec["observation"]["opponent"].get("active_definition_id"),
        })
    return {
        "comparison": f"{gen_a_name}_vs_{gen_b_name}",
        "n_total": n_total,
        "n_disagreements": n_diff,
        "disagreement_rate": n_diff / max(1, n_total),
        "by_case_transition": {f"{ka}→{kb}": v for (ka, kb), v in sorted(by_case.items(), key=lambda x: -x[1])[:20]},
        "by_round": {str(k): v for k, v in sorted(by_round.items())},
        "top_examples": examples,
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--weights", nargs="+", required=True,
                   help='List of name=path pairs, e.g. gen0=path1.json gen1=path2.json')
    p.add_argument("--self-play", nargs="*", default=[],
                   help="SQLite self-play sample DB paths (each row = one decision with π_MCTS)")
    p.add_argument("--captures", nargs="*", default=[],
                   help="gen-vs-gen capture JSON paths (one per game)")
    p.add_argument("--max-rows", type=int, default=0,
                   help="Cap rows loaded per source (0 = no cap)")
    p.add_argument("--out", required=True)
    args = p.parse_args(argv)

    gens: list[tuple[str, str]] = []
    for spec in args.weights:
        if "=" not in spec:
            print(f"invalid --weights entry: {spec}", file=sys.stderr); sys.exit(2)
        name, path = spec.split("=", 1)
        gens.append((name, path))

    # Load all records into one combined list (we'll keep a source tag).
    all_records: list[dict[str, Any]] = []
    for db in args.self_play:
        rs = load_records_from_sqlite(db, args.max_rows or None)
        for r in rs:
            r["source"] = os.path.basename(db)
        all_records.extend(rs)
        print(f"[analyze] loaded {len(rs)} rows from {db}", file=sys.stderr)
    for cap in args.captures:
        rs = load_capture_json(cap)
        for r in rs:
            r["source"] = os.path.basename(cap)
        all_records.extend(rs)
        print(f"[analyze] loaded {len(rs)} rows from {cap}", file=sys.stderr)
    if args.max_rows and len(all_records) > args.max_rows:
        all_records = all_records[: args.max_rows]
    print(f"[analyze] total records: {len(all_records)}", file=sys.stderr)
    if not all_records:
        print("no records loaded", file=sys.stderr); sys.exit(1)

    # Run each generation over the same record set.
    preds_per_gen: dict[str, dict[str, np.ndarray]] = {}
    summaries: list[dict[str, Any]] = []
    for name, path in gens:
        print(f"[analyze] scoring {len(all_records)} positions with {name} ({path})", file=sys.stderr)
        model, vocabs, hp, device = load_predictor(path)
        # NB: vocab is per-bundle, so we re-instantiate the dataset per gen
        # (different bundles have different `id_to_index` maps).
        preds = predict_batch(model, vocabs, all_records, device)
        preds_per_gen[name] = preds
        summaries.append(summarise_generation(name, preds, all_records))

    # Cross-generation diffs (consecutive pairs).
    diffs = []
    names = [g[0] for g in gens]
    for i in range(len(names) - 1):
        a, b = names[i], names[i + 1]
        diffs.append(
            cross_generation_diff(a, preds_per_gen[a], b, preds_per_gen[b], all_records)
        )
    # Also gen0 vs last for end-to-end view.
    if len(names) >= 3:
        diffs.append(
            cross_generation_diff(names[0], preds_per_gen[names[0]],
                                  names[-1], preds_per_gen[names[-1]], all_records)
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "n_records": len(all_records),
        "generations": [{"name": n, "path": p} for n, p in gens],
        "summaries": summaries,
        "cross_gen_diffs": diffs,
    }
    with open(out_path, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
    print(f"[analyze] wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
