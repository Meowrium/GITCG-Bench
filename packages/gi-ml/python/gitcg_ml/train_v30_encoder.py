# Copyright (C) 2026 Piovium Labs
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
"""
V30 Stage 3 — DeepSets + ID-embedding encoder for Genius Invokation.

Inputs: NDJSON files of `StateObservationRecord` (see
`packages/gi-agent/src/learning/encoder/state-observation.ts`).

Architecture
============
* Independent embedding tables per entity kind (character, summon, support,
  combat_status, character_status, hand_card) + an action-target table that
  shares the union of skill / card definition ids.
* Variable-length entity sets are aggregated with `mean ⊕ max ⊕ sum` pools
  (DeepSets-style permutation invariance).
* State representation is an MLP over the concatenated pooled vectors plus a
  meta block (round, phase, dice histogram, hand sizes, declared-end flags).
* Per-candidate action representation joins the action-target embedding with
  the action_case one-hot, the cost histogram, the preview vector, and a
  small fingerprint-flag block embedded directly from observation fields.
* Dueling head:
      Q(s, a) = V(s) + A(s, a) − mean_a A(s, a)
* Loss: weighted BCE over the chosen action's Q viewed as logits, plus an
  optional V-head MSE term on the trajectory return; defaults reproduce the
  V30 §5.4 single-step credit assignment.

This file is self-contained: `python -m gitcg_ml.train_v30_encoder ...`.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset

# ---------------------------------------------------------------------------
# Hyper-params and constants
# ---------------------------------------------------------------------------

# Must match `STATE_OBSERVATION_SCHEMA_VERSION` in TS.
SCHEMA_VERSION = 4

# V31 F9 — Character Skill Fingerprint dimension (must match generator output).
CSF_DIM = 256

# Max entity-set sizes. Pads beyond → masked. Truncates above.
MAX_CHARS = 4
MAX_SUMMONS = 6
MAX_SUPPORTS = 6
MAX_COMBAT_STATUSES = 6
MAX_HAND = 12

# Action slate cap (engine usually emits ≤ 60).
MAX_CANDIDATES = 64

# Action case enumeration (must be stable; see runtime predictor).
ACTION_CASES = (
    "useSkill",
    "playCard",
    "switchActive",
    "elementalTuning",
    "declareEnd",
    "unknown",
)
ACTION_CASE_TO_INDEX = {c: i for i, c in enumerate(ACTION_CASES)}
NUM_ACTION_CASES = len(ACTION_CASES)

# DiceType bucket count (mirrors PbDiceType range 0..8).
DICE_BUCKETS = 9

# DiceRequirementType bucket count (mirrors PbDiceRequirementType 0..10).
COST_BUCKETS = 11

# Preview vector scalar dim (must match ts/preview-vector.ts PREVIEW_VECTOR_SCALAR_DIM).
PREVIEW_VECTOR_DIM = 29 + 9 + 8  # primitives (incl. V31 F5 immune ×2) + damage_by_type + reaction_family

# AuraType vocabulary. Numeric values come from typings/AuraType. We treat the
# combined CRYO_DENDRO (113) as its own slot. Anything unknown → 0.
AURA_VOCAB = (0, 1, 2, 3, 4, 7, 113)
AURA_TO_INDEX = {v: i for i, v in enumerate(AURA_VOCAB)}


@dataclass
class HParams:
    embed_dim: int = 32
    hidden_dim: int = 128
    state_repr_dim: int = 128
    action_repr_dim: int = 96
    dropout: float = 0.05
    learning_rate: float = 1e-3
    weight_decay: float = 1e-4
    batch_size: int = 64
    epochs: int = 10
    grad_clip: float = 5.0
    v_head_weight: float = 0.5  # MSE weight on V(s) target
    policy_weight: float = 0.0  # V31 F6/D3: distillation weight on pi_MCTS
    mirror_weight: float = 0.0  # V31 F6/D7: weight on mirror anti-symmetric regularizer
    seed: int = 17


# ---------------------------------------------------------------------------
# Vocabulary management
# ---------------------------------------------------------------------------


class IdVocabulary:
    """Maps definition_id → index. Builds incrementally so unseen ids are
    automatically registered when fitting; the resulting vocab is dumped to
    JSON for runtime use."""

    PAD_TOKEN = 0
    UNK_TOKEN = 1

    def __init__(self) -> None:
        self.id_to_index: dict[int, int] = {}
        self.next_index = 2  # 0=PAD, 1=UNK

    def fit(self, ids: Iterable[int]) -> None:
        for raw in ids:
            i = int(raw)
            if i <= 0:
                continue
            if i not in self.id_to_index:
                self.id_to_index[i] = self.next_index
                self.next_index += 1

    def encode(self, raw: Any) -> int:
        if raw is None:
            return self.PAD_TOKEN
        try:
            i = int(raw)
        except (TypeError, ValueError):
            return self.UNK_TOKEN
        if i <= 0:
            return self.PAD_TOKEN
        return self.id_to_index.get(i, self.UNK_TOKEN)

    def __len__(self) -> int:
        return self.next_index

    def to_json(self) -> dict[str, Any]:
        return {
            "pad_token": self.PAD_TOKEN,
            "unk_token": self.UNK_TOKEN,
            "size": self.next_index,
            "id_to_index": {str(k): v for k, v in self.id_to_index.items()},
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "IdVocabulary":
        v = cls()
        v.next_index = int(data["size"])
        v.id_to_index = {int(k): int(val) for k, val in data["id_to_index"].items()}
        return v


@dataclass
class Vocabularies:
    character: IdVocabulary
    summon: IdVocabulary
    support: IdVocabulary
    combat_status: IdVocabulary
    character_status: IdVocabulary
    hand_card: IdVocabulary
    action_target: IdVocabulary

    @classmethod
    def empty(cls) -> "Vocabularies":
        return cls(
            character=IdVocabulary(),
            summon=IdVocabulary(),
            support=IdVocabulary(),
            combat_status=IdVocabulary(),
            character_status=IdVocabulary(),
            hand_card=IdVocabulary(),
            action_target=IdVocabulary(),
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "character": self.character.to_json(),
            "summon": self.summon.to_json(),
            "support": self.support.to_json(),
            "combat_status": self.combat_status.to_json(),
            "character_status": self.character_status.to_json(),
            "hand_card": self.hand_card.to_json(),
            "action_target": self.action_target.to_json(),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Vocabularies":
        return cls(
            character=IdVocabulary.from_json(data["character"]),
            summon=IdVocabulary.from_json(data["summon"]),
            support=IdVocabulary.from_json(data["support"]),
            combat_status=IdVocabulary.from_json(data["combat_status"]),
            character_status=IdVocabulary.from_json(data["character_status"]),
            hand_card=IdVocabulary.from_json(data["hand_card"]),
            action_target=IdVocabulary.from_json(data["action_target"]),
        )


def fit_vocabularies(records: Iterable[dict[str, Any]]) -> Vocabularies:
    vocabs = Vocabularies.empty()
    for rec in records:
        obs = rec["observation"]
        for side_key in ("self", "opponent"):
            side = obs[side_key]
            vocabs.character.fit(c["definition_id"] for c in side.get("characters", []))
            vocabs.summon.fit(e["definition_id"] for e in side.get("summons", []))
            vocabs.support.fit(e["definition_id"] for e in side.get("supports", []))
            vocabs.combat_status.fit(
                e["definition_id"] for e in side.get("combat_statuses", [])
            )
            for c in side.get("characters", []):
                vocabs.character_status.fit(c.get("attached_definition_ids", []))
            vocabs.hand_card.fit(c["definition_id"] for c in side.get("hand", []))
        vocabs.action_target.fit(
            a.get("primary_definition_id", 0)
            for a in obs.get("candidate_actions", [])
        )
    return vocabs


# ---------------------------------------------------------------------------
# NDJSON Dataset
# ---------------------------------------------------------------------------


def read_ndjson(path: str | os.PathLike[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def td_lambda_targets(
    records: list[dict[str, Any]],
    gamma: float = 0.95,
    lam: float = 0.9,
) -> None:
    """V31 F6 / V30 §21.9 — populate each record's `v_target` with a TD(λ) return.

    The terminal-label V target collapses the V head to a near-constant mean
    (explained-variance < 0.4) because every state in an 80-step trajectory is
    supervised with the same noisy ±1 outcome. TD(λ) replaces that with a
    bootstrapped, low-variance target:

        G_t^λ = (1-λ) Σ_n λ^{n-1} G_t^{(n)} ,  G_t^{(n)} = γ^n · z_terminal

    For self-play trajectories the only reward is terminal (z ∈ {0,1}), so the
    n-step return reduces to a γ-discounted terminal label and the λ-return is a
    geometric blend toward it. We reconstruct each trajectory by grouping on
    `(game_id, perspective)` and ordering by `sample_index`, then assign

        v_target_t = G_t^λ  ∈ [0, 1]

    which discounts the terminal outcome by distance-to-end — exactly the smooth
    target V30 §21.9 calls for. Records are mutated in place (idempotent).

    This is the *offline* (model-free) variant. The online bootstrap that uses
    V(s_next) from the live encoder (AlphaZero-style, V30 §7) plugs into the same
    `v_target` field once `next_state_observation` is collected.
    """
    # Group indices by trajectory.
    groups: dict[tuple[str, int], list[int]] = {}
    for i, rec in enumerate(records):
        meta = rec.get("observation", {}).get("meta", {})
        gid = str(meta.get("game_id", ""))
        persp = int(meta.get("perspective", 0) or 0)
        groups.setdefault((gid, persp), []).append(i)

    for key, idxs in groups.items():
        # Order by sample_index (monotonic per perspective).
        idxs.sort(
            key=lambda i: int(
                records[i].get("observation", {}).get("meta", {}).get("sample_index", 0) or 0
            )
        )
        n = len(idxs)
        # Terminal outcome z (same for the whole trajectory).
        z = float(records[idxs[-1]].get("label", 0.0))
        # Backward λ-return accumulation. With only a terminal reward:
        #   G_T = z
        #   G_t^λ = (1-λ)·γ·V_boot_{t+1} + λ·γ·G_{t+1}^λ , V_boot ≈ z (no learned V offline)
        # which simplifies to a geometric discount toward z.
        g_next = z
        for pos in range(n - 1, -1, -1):
            i = idxs[pos]
            if pos == n - 1:
                g = z
            else:
                # bootstrap toward z (offline proxy for V(s_{t+1})) blended with
                # the λ-return of the next step.
                g = (1.0 - lam) * (gamma * z) + lam * (gamma * g_next)
            records[i]["v_target"] = max(0.0, min(1.0, g))
            g_next = g


def build_successor_index(records: list[dict[str, Any]]) -> list[int]:
    """V31 F6 online-TD — map each record index to its successor's index.

    Two consecutive samples from the same `(game_id, perspective)` (ordered by
    `sample_index`) are exactly `(s_t, s_{t+1})`. Returns a list `succ` where
    `succ[i]` is the index of `s_{t+1}` for record `i`, or `-1` if `i` is the
    last decision of its trajectory (terminal → bootstrap with the outcome `z`).
    """
    groups: dict[tuple[str, int], list[int]] = {}
    for i, rec in enumerate(records):
        meta = rec.get("observation", {}).get("meta", {})
        gid = str(meta.get("game_id", ""))
        persp = int(meta.get("perspective", 0) or 0)
        groups.setdefault((gid, persp), []).append(i)

    succ = [-1] * len(records)
    for idxs in groups.values():
        idxs.sort(
            key=lambda i: int(
                records[i].get("observation", {}).get("meta", {}).get("sample_index", 0) or 0
            )
        )
        for pos in range(len(idxs) - 1):
            succ[idxs[pos]] = idxs[pos + 1]
    return succ


def is_pure_mirror_record(rec: dict[str, Any]) -> bool:
    """V31 F6 / D7 — does this sample sit in a pure mirror matchup?

    True iff the two sides have *identical character sets* (same multiset of
    character `definition_id`). In a true mirror the only asymmetric signal is
    `is_first_player`; if the encoder collapses to a symmetric Q distribution
    here (the gen3/gen4 failure mode) it loses 0/2 in mirror brackets
    (see §F6.D5 / §F6.D6 #3).
    """
    obs = rec.get("observation") or {}
    self_chars = sorted(
        int(c.get("definition_id", 0) or 0)
        for c in (obs.get("self") or {}).get("characters", [])
        if int(c.get("definition_id", 0) or 0) > 0
    )
    opp_chars = sorted(
        int(c.get("definition_id", 0) or 0)
        for c in (obs.get("opponent") or {}).get("characters", [])
        if int(c.get("definition_id", 0) or 0) > 0
    )
    if not self_chars or not opp_chars:
        return False
    return self_chars == opp_chars


# Sides have isomorphic tensor schemas — listed here so `swap_sides_in_batch`
# stays the single source of truth.
_PER_SIDE_KEYS = (
    "char_ids", "char_mask", "char_num",
    "attached_ids", "attached_mask",
    "char_csf",
    "summon_ids", "summon_mask", "summon_num",
    "support_ids", "support_mask", "support_num",
    "cs_ids", "cs_mask",
    "hand_ids", "hand_mask",
    "side_meta", "dice",
)


def swap_sides_in_batch(batch: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    """V31 F6 / D7 — produce a copy of `batch` with `self_*` and `opp_*`
    swapped, and `global_meta.perspective` flipped (0↔1).

    Used by the mirror anti-symmetric regularizer: in a pure mirror position
    the two perspectives must produce win-probs that sum to 1 (one wins ↔ the
    other loses). Forwarding `swap(batch)` and constraining
    `sigmoid(V(s)) + sigmoid(V(swap(s))) ≈ 1` enforces that on the V head.

    Action tensors stay attached to the same perspective (they belong to the
    side currently to-move — we don't need them for the V-only constraint).
    `selected_action` / `label` / `v_target` / `weight` are not touched.
    """
    swapped: dict[str, torch.Tensor] = dict(batch)
    for k in _PER_SIDE_KEYS:
        sk, ok = f"self_{k}", f"opp_{k}"
        if sk in batch and ok in batch:
            swapped[sk] = batch[ok]
            swapped[ok] = batch[sk]
    # global_meta[:, 2] is perspective ∈ {0,1}; flip it.
    gm = batch.get("global_meta")
    if gm is not None and gm.shape[-1] >= 3:
        gm2 = gm.clone()
        gm2[..., 2] = 1.0 - gm2[..., 2]
        swapped["global_meta"] = gm2
    return swapped


def make_is_mirror_tensor(
    records: list[dict[str, Any]],
    indices: list[int] | None = None,
) -> torch.Tensor:
    """Mask of pure-mirror records aligned with `indices` (or all records)."""
    src = records if indices is None else [records[i] for i in indices]
    return torch.tensor(
        [1.0 if is_pure_mirror_record(r) else 0.0 for r in src],
        dtype=torch.float,
    )


def _v_predictions(
    model: "V30Encoder",
    loader: DataLoader[dict[str, torch.Tensor]],
    device: torch.device,
    n: int,
) -> "torch.Tensor":
    """No-grad forward over `loader`; returns V(s) win-prob per row_index (len n)."""
    model.eval()
    out = torch.full((n,), float("nan"))
    with torch.no_grad():
        for batch in loader:
            rows = batch["row_index"]
            b = {k: v.to(device) for k, v in batch.items() if k != "row_index"}
            _, v, _ = model(b)
            v_prob = torch.sigmoid(v).detach().cpu()
            out[rows] = v_prob
    return out


def refresh_td_targets(
    records: list[dict[str, Any]],
    succ: list[int],
    v_pred: "torch.Tensor",
    gamma: float,
) -> None:
    """V31 F6 — half-gradient TD(0) target refresh (AlphaZero-style frozen target).

    For each record: `v_target = z` (terminal label) if it is the last decision
    of its trajectory, else `γ · V_θ(s_next)` using the *current* model's V (a
    detached, frozen bootstrap). Writes back into each record's `v_target`.

    Unlike the offline λ-return (which collapses to a discounted terminal label
    and leaves the V head near-constant, V30 §21.9), the bootstrap target carries
    real per-state structure because `V_θ(s_next)` differs across states, giving
    the V head a non-degenerate regression signal.
    """
    for i, rec in enumerate(records):
        j = succ[i]
        if j < 0:
            # Terminal decision → outcome label is the exact return.
            rec["v_target"] = float(rec.get("label", 0.0))
        else:
            vn = float(v_pred[j].item())
            if vn != vn:  # NaN guard (row missed a pass)
                vn = float(rec.get("label", 0.0))
            rec["v_target"] = max(0.0, min(1.0, gamma * vn))


@dataclass
class OnlineTdState:
    """Bundle for the per-epoch online-TD target refresh (V31 F6)."""

    records: list[dict[str, Any]]
    successor: list[int]
    refresh_loader: "DataLoader[dict[str, torch.Tensor]]"
    gamma: float
    warmup_epochs: int = 1

    def refresh_dataset_targets(self) -> None:
        # The dataset reads `rec["v_target"]` fresh in __getitem__, and records
        # are shared by reference, so mutating them in `refresh_td_targets` is
        # already visible to the next epoch. This hook exists for clarity and as
        # an extension point if targets are ever cached/tensorised eagerly.
        return None


def validate_schema_version(records: list[dict[str, Any]], source: str) -> None:
    """V31 F3 / D7: reject captures whose schema_version != SCHEMA_VERSION.

    Mixing schema v1 (no active_element / tuning_target / immune fields) or v2
    (no is_first_player) with v3 silently mis-aligns the encoder input, so we
    fail loudly rather than train on a corrupt feature layout.
    """
    seen: set[int] = set()
    for rec in records:
        meta = rec.get("observation", {}).get("meta", {})
        ver = meta.get("schema_version")
        if isinstance(ver, int):
            seen.add(ver)
    bad = {v for v in seen if v != SCHEMA_VERSION}
    if bad:
        raise SystemExit(
            f"[v30-encoder] {source}: incompatible state_observation schema_version(s) "
            f"{sorted(bad)} (expected {SCHEMA_VERSION}). Re-collect self-play samples "
            f"with the current StateExporter (V31 F9 schema v4 — adds "
            f"Character Skill Fingerprint)."
        )


class StateObservationDataset(Dataset[dict[str, torch.Tensor]]):
    def __init__(
        self,
        records: list[dict[str, Any]],
        vocabs: Vocabularies,
        pre_encode: bool = False,
    ) -> None:
        self.records = records
        self.vocabs = vocabs
        self._pre_encoded: list[dict[str, torch.Tensor]] | None = None
        if pre_encode:
            self._pre_encoded = [self._encode_one(i) for i in range(len(records))]

    def _encode_one(self, idx: int) -> dict[str, torch.Tensor]:
        rec = self.records[idx]
        obs = rec["observation"]
        meta = obs["meta"]
        self_side = self._encode_side(obs["self"])
        opp_side = self._encode_side(obs["opponent"])

        candidates = obs.get("candidate_actions", [])[:MAX_CANDIDATES]
        n_cands = max(1, len(candidates))
        action_target_ids = torch.zeros(MAX_CANDIDATES, dtype=torch.long)
        action_case_ids = torch.zeros(MAX_CANDIDATES, dtype=torch.long)
        action_cost = torch.zeros(MAX_CANDIDATES, COST_BUCKETS, dtype=torch.float)
        action_preview = torch.zeros(MAX_CANDIDATES, PREVIEW_VECTOR_DIM, dtype=torch.float)
        action_flags = torch.zeros(MAX_CANDIDATES, 6, dtype=torch.float)
        action_mask = torch.zeros(MAX_CANDIDATES, dtype=torch.float)
        for i, a in enumerate(candidates):
            action_target_ids[i] = self.vocabs.action_target.encode(
                a.get("primary_definition_id", 0)
            )
            action_case_ids[i] = ACTION_CASE_TO_INDEX.get(
                a.get("action_case", "unknown"), ACTION_CASE_TO_INDEX["unknown"]
            )
            cost_arr = a.get("cost_by_type") or []
            for j in range(min(COST_BUCKETS, len(cost_arr))):
                action_cost[i, j] = float(cost_arr[j])
            pv = a.get("preview_vector") or []
            for j in range(min(PREVIEW_VECTOR_DIM, len(pv))):
                action_preview[i, j] = float(pv[j])
            action_flags[i, 0] = float(a.get("cost_total_dice", 0)) / 6.0
            action_flags[i, 1] = float(a.get("cost_energy", 0)) / 4.0
            action_flags[i, 2] = 1.0 if a.get("is_fast") else 0.0
            tt = a.get("tuning_target")
            action_flags[i, 3] = float(tt) / 7.0 if isinstance(tt, (int, float)) and tt and tt > 0 else 0.0
            action_flags[i, 4] = 1.0 if a.get("consumes_legend") else 0.0
            action_flags[i, 5] = 1.0 if a.get("changes_active") else 0.0
            action_mask[i] = 1.0

        selected = obs.get("selected_action_index")
        if selected is None or selected < 0 or selected >= n_cands:
            selected = 0

        policy_target = torch.zeros(MAX_CANDIDATES, dtype=torch.float)
        has_policy_target = 0.0
        pt = rec.get("policy_target")
        if pt is None:
            pt = obs.get("policy_target")
        if isinstance(pt, list) and len(pt) > 0:
            s = 0.0
            for j in range(min(MAX_CANDIDATES, len(pt))):
                val = float(pt[j])
                if val < 0:
                    val = 0.0
                policy_target[j] = val
                s += val
            if s > 0:
                policy_target = policy_target / s
                has_policy_target = 1.0

        sample = {
            **{f"self_{k}": v for k, v in self_side.items()},
            **{f"opp_{k}": v for k, v in opp_side.items()},
            "action_target_ids": action_target_ids,
            "action_case_ids": action_case_ids,
            "action_cost": action_cost,
            "action_preview": action_preview,
            "action_flags": action_flags,
            "action_mask": action_mask,
            "selected_action": torch.tensor(int(selected), dtype=torch.long),
            "policy_target": policy_target,
            "has_policy_target": torch.tensor(has_policy_target, dtype=torch.float),
            "global_meta": torch.tensor(
                [
                    float(meta.get("round", 0)) / 12.0,
                    1.0 if meta.get("opponent_declared_end") else 0.0,
                    float(meta.get("perspective", 0)),
                ],
                dtype=torch.float,
            ),
            "label": torch.tensor(float(rec.get("label", 0.0)), dtype=torch.float),
            "weight": torch.tensor(float(rec.get("weight", 1.0)), dtype=torch.float),
            "v_target": torch.tensor(
                float(rec["v_target"]) if rec.get("v_target") is not None else float(rec.get("label", 0.0)),
                dtype=torch.float,
            ),
            "row_index": torch.tensor(int(idx), dtype=torch.long),
            "is_mirror": torch.tensor(
                1.0 if is_pure_mirror_record(rec) else 0.0, dtype=torch.float
            ),
        }
        return sample

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        if self._pre_encoded is not None:
            return self._pre_encoded[idx]
        return self._encode_one(idx)

    def _encode_side(self, side: dict[str, Any]) -> dict[str, torch.Tensor]:
        # Characters --------------------------------------------------------
        chars = side.get("characters", [])[:MAX_CHARS]
        char_ids = torch.zeros(MAX_CHARS, dtype=torch.long)
        char_mask = torch.zeros(MAX_CHARS, dtype=torch.float)
        # numeric features per character: hp_norm, energy_norm, alive, active, aura_idx
        char_num = torch.zeros(MAX_CHARS, 5, dtype=torch.float)
        # attached statuses: pad first 4 per character
        attached_ids = torch.zeros(MAX_CHARS, 4, dtype=torch.long)
        attached_mask = torch.zeros(MAX_CHARS, 4, dtype=torch.float)
        # V31 F9: Character Skill Fingerprint (256 dims), zeros for missing/legacy
        char_csf = torch.zeros(MAX_CHARS, CSF_DIM, dtype=torch.float)
        for i, c in enumerate(chars):
            char_ids[i] = self.vocabs.character.encode(c.get("definition_id"))
            char_mask[i] = 1.0
            max_h = max(int(c.get("max_health", 1) or 1), 1)
            max_e = max(int(c.get("max_energy", 1) or 1), 1)
            char_num[i, 0] = float(c.get("health", 0)) / max_h
            char_num[i, 1] = float(c.get("energy", 0)) / max_e
            char_num[i, 2] = 0.0 if c.get("defeated") else 1.0
            char_num[i, 3] = 1.0 if c.get("is_active") else 0.0
            char_num[i, 4] = float(AURA_TO_INDEX.get(int(c.get("aura", 0) or 0), 0))
            attached = c.get("attached_definition_ids", [])[:4]
            for j, a in enumerate(attached):
                attached_ids[i, j] = self.vocabs.character_status.encode(a)
                attached_mask[i, j] = 1.0
            fp = c.get("skill_fingerprint")
            if fp and isinstance(fp, list) and len(fp) == CSF_DIM:
                for j in range(CSF_DIM):
                    char_csf[i, j] = float(fp[j])
        # Summons -----------------------------------------------------------
        summons = side.get("summons", [])[:MAX_SUMMONS]
        summon_ids = torch.zeros(MAX_SUMMONS, dtype=torch.long)
        summon_mask = torch.zeros(MAX_SUMMONS, dtype=torch.float)
        summon_num = torch.zeros(MAX_SUMMONS, 1, dtype=torch.float)
        for i, e in enumerate(summons):
            summon_ids[i] = self.vocabs.summon.encode(e.get("definition_id"))
            summon_mask[i] = 1.0
            summon_num[i, 0] = float(e.get("usage", 0) or 0)
        # Supports ----------------------------------------------------------
        supports = side.get("supports", [])[:MAX_SUPPORTS]
        support_ids = torch.zeros(MAX_SUPPORTS, dtype=torch.long)
        support_mask = torch.zeros(MAX_SUPPORTS, dtype=torch.float)
        support_num = torch.zeros(MAX_SUPPORTS, 1, dtype=torch.float)
        for i, e in enumerate(supports):
            support_ids[i] = self.vocabs.support.encode(e.get("definition_id"))
            support_mask[i] = 1.0
            support_num[i, 0] = float(e.get("usage", 0) or 0)
        # Combat statuses ---------------------------------------------------
        cs = side.get("combat_statuses", [])[:MAX_COMBAT_STATUSES]
        cs_ids = torch.zeros(MAX_COMBAT_STATUSES, dtype=torch.long)
        cs_mask = torch.zeros(MAX_COMBAT_STATUSES, dtype=torch.float)
        for i, e in enumerate(cs):
            cs_ids[i] = self.vocabs.combat_status.encode(e.get("definition_id"))
            cs_mask[i] = 1.0
        # Hand --------------------------------------------------------------
        hand = side.get("hand", [])[:MAX_HAND]
        hand_ids = torch.zeros(MAX_HAND, dtype=torch.long)
        hand_mask = torch.zeros(MAX_HAND, dtype=torch.float)
        for i, c in enumerate(hand):
            hand_ids[i] = self.vocabs.hand_card.encode(c.get("definition_id"))
            hand_mask[i] = 1.0
        return {
            "char_ids": char_ids,
            "char_mask": char_mask,
            "char_num": char_num,
            "attached_ids": attached_ids,
            "attached_mask": attached_mask,
            "char_csf": char_csf,
            "summon_ids": summon_ids,
            "summon_mask": summon_mask,
            "summon_num": summon_num,
            "support_ids": support_ids,
            "support_mask": support_mask,
            "support_num": support_num,
            "cs_ids": cs_ids,
            "cs_mask": cs_mask,
            "hand_ids": hand_ids,
            "hand_mask": hand_mask,
            "side_meta": torch.tensor(
                [
                    1.0 if side.get("declared_end") else 0.0,
                    1.0 if side.get("legend_used") else 0.0,
                    float(side.get("hand_size", 0)) / 12.0,
                    float(side.get("pile_size", 0)) / 30.0,
                    # V31 F3: active character element (DiceType 0..7) normalised.
                    float(side.get("active_element", 0) or 0) / 7.0,
                    # V31 F5: presence of any immune-to-defeat charge on this side.
                    1.0
                    if any(
                        float(c.get("immune_remaining", 0) or 0) > 0
                        for c in side.get("characters", [])
                    )
                    else 0.0,
                    # V31 F6 / D7 (schema v3): coin-flip first-mover flag — the
                    # only asymmetric signal in pure mirror matchups. Sole
                    # feature that lets the encoder distinguish the two sides
                    # in a perfectly symmetric position.
                    1.0 if side.get("is_first_player") else 0.0,
                ],
                dtype=torch.float,
            ),
            "dice": torch.tensor(
                _pad_to(side.get("dice_counts", []), DICE_BUCKETS),
                dtype=torch.float,
            ),
        }



def _pad_to(arr: list[Any], length: int) -> list[float]:
    out = [float(arr[i] if i < len(arr) else 0) for i in range(length)]
    return out


# ---------------------------------------------------------------------------
# Encoder model
# ---------------------------------------------------------------------------


class DeepSetsPool(nn.Module):
    """Permutation-invariant pool: mean ⊕ max ⊕ sum (each dim-D)."""

    def forward(
        self,
        x: torch.Tensor,
        mask: torch.Tensor,
    ) -> torch.Tensor:
        # x: [B, N, D], mask: [B, N]
        m = mask.unsqueeze(-1)
        masked = x * m
        denom = mask.sum(dim=1, keepdim=True).clamp_min(1.0)
        mean = masked.sum(dim=1) / denom
        # max with masked → −∞
        neg_inf = torch.tensor(-1e9, device=x.device, dtype=x.dtype)
        max_vals = torch.where(m.bool(), x, neg_inf).max(dim=1).values
        # if entire set is empty, max would be -1e9: zero it out.
        any_present = (mask.sum(dim=1, keepdim=True) > 0).float()
        max_vals = max_vals * any_present
        sum_vals = masked.sum(dim=1)
        return torch.cat([mean, max_vals, sum_vals], dim=-1)


def _mlp(in_dim: int, hidden: int, out_dim: int, dropout: float) -> nn.Sequential:
    return nn.Sequential(
        nn.Linear(in_dim, hidden),
        nn.GELU(),
        nn.Dropout(dropout),
        nn.Linear(hidden, out_dim),
    )


class V30Encoder(nn.Module):
    def __init__(self, vocabs: Vocabularies, hp: HParams) -> None:
        super().__init__()
        self.hp = hp
        E = hp.embed_dim
        H = hp.hidden_dim
        S = hp.state_repr_dim
        A = hp.action_repr_dim
        self.aura_emb = nn.Embedding(len(AURA_VOCAB) + 1, 4)
        self.case_emb = nn.Embedding(NUM_ACTION_CASES, 8)

        self.char_emb = nn.Embedding(len(vocabs.character), E, padding_idx=0)
        self.summon_emb = nn.Embedding(len(vocabs.summon), E, padding_idx=0)
        self.support_emb = nn.Embedding(len(vocabs.support), E, padding_idx=0)
        self.cs_emb = nn.Embedding(len(vocabs.combat_status), E, padding_idx=0)
        self.cstat_emb = nn.Embedding(len(vocabs.character_status), E, padding_idx=0)
        self.hand_emb = nn.Embedding(len(vocabs.hand_card), E, padding_idx=0)
        self.target_emb = nn.Embedding(len(vocabs.action_target), E, padding_idx=0)

        # MLP per token type before pooling.
        # Char input = char_emb (E) + 4 numeric (hp/energy/alive/active) + attached_pool (E) + CSF (CSF_DIM)
        self.char_proj = _mlp(E + 4 + E + CSF_DIM, H, S // 2, hp.dropout)
        self.summon_proj = _mlp(E + 1, H, S // 2, hp.dropout)
        self.support_proj = _mlp(E + 1, H, S // 2, hp.dropout)
        self.cs_proj = _mlp(E, H, S // 2, hp.dropout)
        self.hand_proj = _mlp(E, H, S // 2, hp.dropout)

        self.pool = DeepSetsPool()
        # Pooled dim = 3 * (S//2)
        side_repr_in = 5 * (3 * (S // 2)) + 7 + DICE_BUCKETS  # 5 sets + side_meta(7, V31 D7) + dice
        self.side_proj = _mlp(side_repr_in, H, S, hp.dropout)
        # State = self ⊕ opp + global_meta(3)
        self.state_proj = _mlp(2 * S + 3, H, S, hp.dropout)
        self.value_head = nn.Sequential(
            nn.Linear(S, H), nn.GELU(), nn.Dropout(hp.dropout), nn.Linear(H, 1)
        )

        # Action representation
        action_in = E + 8 + COST_BUCKETS + PREVIEW_VECTOR_DIM + 6  # flags(6, V31 F3)
        self.action_proj = _mlp(action_in, H, A, hp.dropout)
        self.advantage_head = nn.Sequential(
            nn.Linear(S + A, H),
            nn.GELU(),
            nn.Dropout(hp.dropout),
            nn.Linear(H, 1),
        )

    def encode_side(
        self,
        prefix: str,
        batch: dict[str, torch.Tensor],
    ) -> torch.Tensor:
        char_ids = batch[f"{prefix}_char_ids"]
        char_mask = batch[f"{prefix}_char_mask"]
        char_num = batch[f"{prefix}_char_num"]
        attached_ids = batch[f"{prefix}_attached_ids"]
        attached_mask = batch[f"{prefix}_attached_mask"]
        # Per-character attached pool (E)
        att_emb = self.cstat_emb(attached_ids)  # [B, C, K, E]
        am = attached_mask.unsqueeze(-1)
        att_pool = (att_emb * am).sum(dim=2) / am.sum(dim=2).clamp_min(1.0)  # [B, C, E]
        char_emb = self.char_emb(char_ids)
        # V31 F9: Character Skill Fingerprint (256 dims), zeros for missing/legacy.
        char_csf = batch.get(f"{prefix}_char_csf")
        if char_csf is None:
            char_csf = torch.zeros_like(char_emb[:, :, :CSF_DIM])  # fallback
        char_in = torch.cat([char_emb, char_num[..., :4], att_pool, char_csf], dim=-1)
        char_proj = self.char_proj(char_in)
        char_pool = self.pool(char_proj, char_mask)

        summon_ids = batch[f"{prefix}_summon_ids"]
        summon_mask = batch[f"{prefix}_summon_mask"]
        summon_num = batch[f"{prefix}_summon_num"]
        summon_in = torch.cat([self.summon_emb(summon_ids), summon_num], dim=-1)
        summon_pool = self.pool(self.summon_proj(summon_in), summon_mask)

        support_ids = batch[f"{prefix}_support_ids"]
        support_mask = batch[f"{prefix}_support_mask"]
        support_num = batch[f"{prefix}_support_num"]
        support_in = torch.cat([self.support_emb(support_ids), support_num], dim=-1)
        support_pool = self.pool(self.support_proj(support_in), support_mask)

        cs_ids = batch[f"{prefix}_cs_ids"]
        cs_mask = batch[f"{prefix}_cs_mask"]
        cs_pool = self.pool(self.cs_proj(self.cs_emb(cs_ids)), cs_mask)

        hand_ids = batch[f"{prefix}_hand_ids"]
        hand_mask = batch[f"{prefix}_hand_mask"]
        hand_pool = self.pool(self.hand_proj(self.hand_emb(hand_ids)), hand_mask)

        meta = batch[f"{prefix}_side_meta"]
        dice = batch[f"{prefix}_dice"]
        side_in = torch.cat(
            [char_pool, summon_pool, support_pool, cs_pool, hand_pool, meta, dice],
            dim=-1,
        )
        return self.side_proj(side_in)

    def state_repr(self, batch: dict[str, torch.Tensor]) -> torch.Tensor:
        self_repr = self.encode_side("self", batch)
        opp_repr = self.encode_side("opp", batch)
        glob = batch["global_meta"]
        return self.state_proj(torch.cat([self_repr, opp_repr, glob], dim=-1))

    def forward(
        self, batch: dict[str, torch.Tensor]
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        s = self.state_repr(batch)  # [B, S]
        v = self.value_head(s).squeeze(-1)  # [B]

        target_emb = self.target_emb(batch["action_target_ids"])  # [B, K, E]
        case_emb = self.case_emb(batch["action_case_ids"])  # [B, K, 8]
        a_in = torch.cat(
            [
                target_emb,
                case_emb,
                batch["action_cost"],
                batch["action_preview"],
                batch["action_flags"],
            ],
            dim=-1,
        )
        a_repr = self.action_proj(a_in)  # [B, K, A]
        s_expand = s.unsqueeze(1).expand(-1, a_repr.shape[1], -1)
        adv = self.advantage_head(torch.cat([s_expand, a_repr], dim=-1)).squeeze(-1)
        # Mask invalid candidates so they don't pollute the mean baseline.
        mask = batch["action_mask"]  # [B, K]
        masked_adv = adv * mask + (1.0 - mask) * (-1e9)
        # Replace -1e9 with 0 for the baseline mean (only valid count).
        valid_count = mask.sum(dim=1, keepdim=True).clamp_min(1.0)
        adv_zeroed = adv * mask
        adv_baseline = adv_zeroed.sum(dim=1, keepdim=True) / valid_count
        # Dueling Q
        q = v.unsqueeze(1) + (adv - adv_baseline)  # [B, K]
        q = q * mask + (1.0 - mask) * (-1e9)
        return q, v, masked_adv

    def forward_v_only(self, batch: dict[str, torch.Tensor]) -> torch.Tensor:
        """V-only forward for the mirror anti-symmetric regularizer.

        Skips the action representation (action_proj + advantage_head) which
        accounts for ~94% of the full-forward FLOP count. The mirror swap pass
        only needs V(s), so this avoids wasted compute on the action path.
        """
        s = self.state_repr(batch)
        return self.value_head(s).squeeze(-1)


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------


def collate(batch: list[dict[str, torch.Tensor]]) -> dict[str, torch.Tensor]:
    keys = batch[0].keys()
    return {k: torch.stack([b[k] for b in batch], dim=0) for k in keys}


def compute_loss(
    q: torch.Tensor,
    v: torch.Tensor,
    selected: torch.Tensor,
    label: torch.Tensor,
    weight: torch.Tensor,
    mask: torch.Tensor,
    v_head_weight: float,
    v_target: torch.Tensor | None = None,
    policy_target: torch.Tensor | None = None,
    has_policy_target: torch.Tensor | None = None,
    policy_weight: float = 0.0,
    v_swap: torch.Tensor | None = None,
    is_mirror: torch.Tensor | None = None,
    mirror_weight: float = 0.0,
) -> tuple[torch.Tensor, dict[str, float]]:
    # Q of selected candidate as logit for sigmoid → label
    selected_q = q.gather(1, selected.unsqueeze(1)).squeeze(1)
    bce = F.binary_cross_entropy_with_logits(selected_q, label, reduction="none")
    weighted_bce = (bce * weight).sum() / weight.sum().clamp_min(1.0)

    # V31 F6 (V30 §21.9): supervise V head against the bootstrapped TD target
    # when provided (γ·V(s_next)); fall back to the terminal label otherwise.
    # The V head emits a logit; we regress its sigmoid (win-prob) against the
    # target so this matches how `evaluate_v30_v_head` reads V downstream
    # (sigmoid(v) as the win-probability proxy) and keeps targets in [0,1].
    vt = v_target if v_target is not None else label
    v_prob = torch.sigmoid(v)
    v_loss = ((v_prob - vt) ** 2 * weight).sum() / weight.sum().clamp_min(1.0)

    # V31 F6 / D3 — policy-distillation loss (AlphaZero flywheel engine).
    # Distil the encoder's masked Q-softmax policy onto the search target
    # pi_MCTS: cross-entropy H(pi_MCTS, softmax(Q)) summed over candidates,
    # averaged over the rows that actually carry a search target. This is what
    # lets generation N+1 absorb generation N's ISMCTS improvement (V30 §7).
    policy_loss = torch.zeros((), device=q.device)
    if (
        policy_weight > 0.0
        and policy_target is not None
        and has_policy_target is not None
    ):
        # log-softmax over valid candidates only (masked entries → -inf in q).
        log_pi = torch.log_softmax(q, dim=1)  # [B, K]
        # Cross-entropy with the (already-normalised) search target.
        ce = -(policy_target * log_pi).sum(dim=1)  # [B]
        # Guard NaNs from -inf * 0 on padded slots.
        ce = torch.nan_to_num(ce, nan=0.0, posinf=0.0, neginf=0.0)
        row_w = weight * has_policy_target
        denom = row_w.sum().clamp_min(1.0)
        policy_loss = (ce * row_w).sum() / denom

    loss = weighted_bce + v_head_weight * v_loss + policy_weight * policy_loss

    # V31 F6 / D7 — mirror anti-symmetric regularizer.
    # In a pure mirror position (same character multiset on both sides) the two
    # perspectives must produce win-probs that sum to 1: one side winning is
    # exactly the other losing. The gen3/gen4 collapse (mirror brackets 0/2 in
    # D5/D6) was the encoder outputting a symmetric V (~0.5 both perspectives,
    # i.e. V(s) + V(swap(s)) ≈ 1 trivially but with vanishing Q-distinction)
    # rather than learning an asymmetric tie-breaker on `is_first_player`. The
    # hinge below penalises the *deviation* from the sum-to-1 invariant only
    # on mirror rows, leaving non-mirror rows untouched. Combined with the new
    # `is_first_player` side_meta feature it gives the encoder a unique
    # tie-breaker to anchor on.
    mirror_v_loss = torch.zeros((), device=q.device)
    if (
        mirror_weight > 0.0
        and v_swap is not None
        and is_mirror is not None
        and is_mirror.sum() > 0
    ):
        p = torch.sigmoid(v)
        p_swap = torch.sigmoid(v_swap)
        delta = (p + p_swap - 1.0) ** 2
        row_w = weight * is_mirror
        denom = row_w.sum().clamp_min(1.0)
        mirror_v_loss = (delta * row_w).sum() / denom
        loss = loss + mirror_weight * mirror_v_loss

    with torch.no_grad():
        pred = (selected_q >= 0).float()
        acc = ((pred == label).float() * weight).sum() / weight.sum().clamp_min(1.0)
    return loss, {
        "loss": float(loss.item()),
        "bce": float(weighted_bce.item()),
        "v_loss": float(v_loss.item()),
        "policy_loss": float(policy_loss.item()) if isinstance(policy_loss, torch.Tensor) else float(policy_loss),
        "mirror_v_loss": float(mirror_v_loss.item()) if isinstance(mirror_v_loss, torch.Tensor) else float(mirror_v_loss),
        "acc": float(acc.item()),
    }


def evaluate(
    model: V30Encoder,
    loader: DataLoader[dict[str, torch.Tensor]],
    device: torch.device,
    v_head_weight: float,
    policy_weight: float = 0.0,
    mirror_weight: float = 0.0,
) -> dict[str, float]:
    model.eval()
    total_loss = 0.0
    total_bce = 0.0
    total_v = 0.0
    total_policy = 0.0
    total_mirror = 0.0
    total_acc = 0.0
    total_w = 0.0
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            q, v, _ = model(batch)
            v_swap = None
            if mirror_weight > 0.0 and "is_mirror" in batch and batch["is_mirror"].sum() > 0:
                swapped = swap_sides_in_batch(batch)
                v_swap = model.forward_v_only(swapped)
            loss, m = compute_loss(
                q,
                v,
                batch["selected_action"],
                batch["label"],
                batch["weight"],
                batch["action_mask"],
                v_head_weight,
                batch.get("v_target"),
                batch.get("policy_target"),
                batch.get("has_policy_target"),
                policy_weight,
                v_swap=v_swap,
                is_mirror=batch.get("is_mirror"),
                mirror_weight=mirror_weight,
            )
            w = float(batch["weight"].sum().item())
            total_loss += m["loss"] * w
            total_bce += m["bce"] * w
            total_v += m["v_loss"] * w
            total_policy += m["policy_loss"] * w
            total_mirror += m.get("mirror_v_loss", 0.0) * w
            total_acc += m["acc"] * w
            total_w += w
    if total_w == 0:
        return {"loss": float("nan"), "bce": float("nan"), "v_loss": float("nan"), "policy_loss": float("nan"), "mirror_v_loss": float("nan"), "acc": float("nan")}
    return {
        "loss": total_loss / total_w,
        "bce": total_bce / total_w,
        "v_loss": total_v / total_w,
        "policy_loss": total_policy / total_w,
        "mirror_v_loss": total_mirror / total_w,
        "acc": total_acc / total_w,
    }


def train_loop(
    model: V30Encoder,
    train_loader: DataLoader[dict[str, torch.Tensor]],
    val_loader: DataLoader[dict[str, torch.Tensor]] | None,
    hp: HParams,
    device: torch.device,
    vocabs: Vocabularies | None = None,
    checkpoint_path: str | os.PathLike[str] | None = None,
    report_path: str | os.PathLike[str] | None = None,
    online_td: "OnlineTdState | None" = None,
    checkpoint_metric: str = "loss",
) -> dict[str, Any]:
    # V30 Stage 3 — Targeted regularization for Genius Invokation random
    # structure (R2: 抽牌 → embedding memorization).
    # Embedding tables receive 10× larger weight_decay than MLPs so the model
    # cannot simply memorize "this card_id correlates with win". This forces
    # signal to flow through the numeric / preview features.
    embedding_params = []
    mlp_params = []
    for name, p in model.named_parameters():
        if not p.requires_grad:
            continue
        if name.endswith("_emb.weight"):
            embedding_params.append(p)
        else:
            mlp_params.append(p)
    opt = torch.optim.AdamW(
        [
            {"params": embedding_params, "weight_decay": hp.weight_decay * 10},
            {"params": mlp_params,        "weight_decay": hp.weight_decay},
        ],
        lr=hp.learning_rate,
    )
    history: list[dict[str, Any]] = []
    best_val = math.inf
    best_state: dict[str, torch.Tensor] | None = None
    best_epoch = -1
    for epoch in range(hp.epochs):
        # V31 F6 online-TD: before each epoch (except the very first, where the
        # untrained V is meaningless), refresh `v_target` with γ·V_θ(s_next) using
        # the *current* frozen model. This is the half-gradient TD(0) bootstrap
        # that gives the V head real per-state structure (V30 §21.9 fix).
        if online_td is not None and epoch >= online_td.warmup_epochs:
            v_pred = _v_predictions(
                model, online_td.refresh_loader, device, len(online_td.records)
            )
            refresh_td_targets(
                online_td.records, online_td.successor, v_pred, online_td.gamma
            )
            online_td.refresh_dataset_targets()
        model.train()
        t0 = time.time()
        running = {"loss": 0.0, "bce": 0.0, "v_loss": 0.0, "policy_loss": 0.0, "mirror_v_loss": 0.0, "acc": 0.0}
        running_w = 0.0
        for batch in train_loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            q, v, _ = model(batch)
            v_swap = None
            if hp.mirror_weight > 0.0 and "is_mirror" in batch and batch["is_mirror"].sum() > 0:
                swapped = swap_sides_in_batch(batch)
                v_swap = model.forward_v_only(swapped)
            loss, m = compute_loss(
                q,
                v,
                batch["selected_action"],
                batch["label"],
                batch["weight"],
                batch["action_mask"],
                hp.v_head_weight,
                batch.get("v_target"),
                batch.get("policy_target"),
                batch.get("has_policy_target"),
                hp.policy_weight,
                v_swap=v_swap,
                is_mirror=batch.get("is_mirror"),
                mirror_weight=hp.mirror_weight,
            )
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), hp.grad_clip)
            opt.step()
            w = float(batch["weight"].sum().item())
            for k in running:
                running[k] += m[k] * w
            running_w += w
        train_metrics = {k: (v / running_w if running_w > 0 else float("nan")) for k, v in running.items()}
        val_metrics = (
            evaluate(model, val_loader, device, hp.v_head_weight, hp.policy_weight, hp.mirror_weight) if val_loader else {}
        )
        rec = {
            "epoch": epoch + 1,
            "elapsed_s": round(time.time() - t0, 2),
            "train": train_metrics,
            "val": val_metrics,
        }
        history.append(rec)
        print(json.dumps(rec), flush=True)
        # V31 F6: select best checkpoint by `checkpoint_metric` (default total
        # val loss). Use `v_loss` to keep the epoch with the healthiest V head
        # (total loss is dominated by Q-head BCE, which overfits and would
        # discard the better-V epochs the online-TD bootstrap produces).
        cur_metric = val_metrics.get(checkpoint_metric, math.inf) if val_metrics else math.inf
        if val_metrics and cur_metric < best_val:
            best_val = cur_metric
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            best_epoch = epoch + 1
            # Persist BEST checkpoint immediately so SIGINT / crash mid-train
            # never throws away the best epoch's weights.
            if checkpoint_path is not None and vocabs is not None:
                # Temporarily swap model state to best for export, then restore.
                live_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
                model.load_state_dict(best_state)
                try:
                    export_weights(model, vocabs, hp, checkpoint_path)
                finally:
                    model.load_state_dict(live_state)
        # Persist incremental report after every epoch.
        if report_path is not None:
            partial_report = {
                "schema_version": SCHEMA_VERSION,
                "history": history,
                "best_val_loss": best_val,
                "best_epoch": best_epoch,
                "hparams": {
                    "embed_dim": hp.embed_dim,
                    "hidden_dim": hp.hidden_dim,
                    "state_repr_dim": hp.state_repr_dim,
                    "action_repr_dim": hp.action_repr_dim,
                    "dropout": hp.dropout,
                    "weight_decay": hp.weight_decay,
                    "v_head_weight": hp.v_head_weight,
                    "lr": hp.learning_rate,
                    "batch_size": hp.batch_size,
                    "epochs_target": hp.epochs,
                },
                "in_progress": True,
            }
            Path(report_path).parent.mkdir(parents=True, exist_ok=True)
            with open(report_path, "wt", encoding="utf-8") as fh:
                json.dump(partial_report, fh, indent=2)
    if best_state is not None:
        model.load_state_dict(best_state)
    return {"history": history, "best_val_loss": best_val, "best_epoch": best_epoch}


# ---------------------------------------------------------------------------
# Weights export
# ---------------------------------------------------------------------------


def state_dict_to_json(state_dict: dict[str, torch.Tensor]) -> dict[str, Any]:
    """Serialise weights to plain JSON tensors for the TS runtime."""
    out: dict[str, Any] = {}
    for k, t in state_dict.items():
        out[k] = {
            "shape": list(t.shape),
            "dtype": str(t.dtype).replace("torch.", ""),
            "values": t.detach().cpu().reshape(-1).tolist(),
        }
    return out


def export_weights(
    model: V30Encoder,
    vocabs: Vocabularies,
    hp: HParams,
    out_path: str | os.PathLike[str],
) -> None:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "h_params": {
            "embed_dim": hp.embed_dim,
            "hidden_dim": hp.hidden_dim,
            "state_repr_dim": hp.state_repr_dim,
            "action_repr_dim": hp.action_repr_dim,
            "dropout": hp.dropout,
        },
        "vocabularies": vocabs.to_json(),
        "constants": {
            "MAX_CHARS": MAX_CHARS,
            "MAX_SUMMONS": MAX_SUMMONS,
            "MAX_SUPPORTS": MAX_SUPPORTS,
            "MAX_COMBAT_STATUSES": MAX_COMBAT_STATUSES,
            "MAX_HAND": MAX_HAND,
            "MAX_CANDIDATES": MAX_CANDIDATES,
            "DICE_BUCKETS": DICE_BUCKETS,
            "COST_BUCKETS": COST_BUCKETS,
            "PREVIEW_VECTOR_DIM": PREVIEW_VECTOR_DIM,
            "ACTION_CASES": list(ACTION_CASES),
            "AURA_VOCAB": list(AURA_VOCAB),
        },
        "state_dict": state_dict_to_json(model.state_dict()),
    }
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True, help="train.ndjson path")
    parser.add_argument("--val", default=None, help="optional test/val.ndjson path")
    parser.add_argument("--out", required=True, help="weights.json output path")
    parser.add_argument("--report", default=None, help="optional report.json output path")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--num-workers", type=int, default=0,
                        help="DataLoader worker count. > 0 can speed up data loading "
                        "on multi-core systems (Windows: may need --num-workers 0).")
    parser.add_argument("--prefetch-factor", type=int, default=2,
                        help="Prefetch batches per worker.")
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--embed-dim", type=int, default=32)
    parser.add_argument("--hidden-dim", type=int, default=128)
    parser.add_argument("--state-repr-dim", type=int, default=128)
    parser.add_argument("--action-repr-dim", type=int, default=96)
    parser.add_argument("--dropout", type=float, default=0.05,
                        help="Dropout probability inside MLPs. Higher → stronger regularization.")
    parser.add_argument("--weight-decay", type=float, default=1e-4,
                        help="AdamW weight decay (L2). Higher → stronger regularization.")
    parser.add_argument("--v-head-weight", type=float, default=0.5)
    parser.add_argument(
        "--policy-weight",
        type=float,
        default=0.0,
        help="V31 F6/D3: weight on the policy-distillation loss (cross-entropy "
        "of the Q-softmax against the recorded pi_MCTS search target). > 0 turns "
        "on the AlphaZero flywheel objective; rows without a policy_target are "
        "skipped automatically. Default 0 (pure value+BCE, legacy behaviour).",
    )
    parser.add_argument(
        "--mirror-weight",
        type=float,
        default=0.0,
        help="V31 F6/D7: weight on the mirror anti-symmetric V-head regularizer. "
        "> 0 forwards each pure-mirror row twice (sides swapped) and adds "
        "(sigmoid V(s) + sigmoid V(swap(s)) - 1)^2 to the loss. Combined with the "
        "new is_first_player side_meta feature this breaks the gen3/gen4 mirror "
        "collapse (0/2 bracket losses, §F6.D5/D6 #3). Recommended 0.3-0.5.",
    )
    parser.add_argument(
        "--td-lambda",
        type=float,
        default=-1.0,
        help="V31 F6: if >= 0, compute TD(λ) V targets with this λ (and --td-gamma) "
        "and supervise the V head against them instead of the terminal label. "
        "Default -1 disables (legacy single-step proxy).",
    )
    parser.add_argument(
        "--td-gamma",
        type=float,
        default=0.95,
        help="Discount γ for TD(λ) V targets (used only when --td-lambda >= 0).",
    )
    parser.add_argument(
        "--online-td",
        action="store_true",
        help="V31 F6 (V30 §21.9): half-gradient TD(0). Before each epoch (after "
        "warmup), refresh v_target = γ·V_θ(s_next) using the current model "
        "(s_next paired by trajectory). Fixes the V-head collapse that the "
        "offline terminal-label / λ-return proxy cannot. Recommended over "
        "--td-lambda.",
    )
    parser.add_argument(
        "--online-td-warmup",
        type=int,
        default=1,
        help="Epochs to train on terminal-label V targets before enabling the "
        "online-TD bootstrap (the untrained V is meaningless). Default 1.",
    )
    parser.add_argument(
        "--checkpoint-metric",
        choices=["loss", "v_loss", "bce", "policy_loss", "mirror_v_loss"],
        default="loss",
        help="V31 F6: validation metric used to pick the best checkpoint. Use "
        "'v_loss' when the V head (leaf value for ISMCTS) is the priority — total "
        "'loss' is dominated by the Q-head BCE which overfits and discards the "
        "epochs where online-TD produces the healthiest V head.",
    )
    parser.add_argument(
        "--pre-encode",
        action="store_true",
        help="Pre-encode all samples into tensors once at startup (uses more memory "
        "but avoids re-parsing JSON dicts on every epoch). Recommended for large datasets.",
    )
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument(
        "--max-train-samples",
        type=int,
        default=0,
        help="Truncate training set after N samples (0 = no cap).",
    )
    args = parser.parse_args(argv)

    torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() and not args.cpu else "cpu")
    print(f"[v30-encoder] device={device}", file=sys.stderr)

    train_records = read_ndjson(args.train)
    if args.max_train_samples > 0:
        train_records = train_records[: args.max_train_samples]
    val_records = read_ndjson(args.val) if args.val else []
    validate_schema_version(train_records, args.train)
    if val_records:
        validate_schema_version(val_records, args.val)

    # V31 F6 (V30 §21.9): bootstrapped TD(λ) V targets to fix the V-head collapse.
    if args.td_lambda >= 0.0:
        td_lambda_targets(train_records, gamma=args.td_gamma, lam=args.td_lambda)
        if val_records:
            td_lambda_targets(val_records, gamma=args.td_gamma, lam=args.td_lambda)
        print(
            f"[v30-encoder] TD(λ) V targets enabled (γ={args.td_gamma} λ={args.td_lambda})",
            file=sys.stderr,
        )

    print(
        f"[v30-encoder] train={len(train_records)} val={len(val_records)}",
        file=sys.stderr,
    )

    vocabs = fit_vocabularies(train_records)
    print(
        f"[v30-encoder] vocab sizes: chars={len(vocabs.character)} summons={len(vocabs.summon)}"
        f" supports={len(vocabs.support)} cs={len(vocabs.combat_status)}"
        f" cstat={len(vocabs.character_status)} hand={len(vocabs.hand_card)}"
        f" target={len(vocabs.action_target)}",
        file=sys.stderr,
    )

    hp = HParams(
        embed_dim=args.embed_dim,
        hidden_dim=args.hidden_dim,
        state_repr_dim=args.state_repr_dim,
        action_repr_dim=args.action_repr_dim,
        dropout=args.dropout,
        weight_decay=args.weight_decay,
        learning_rate=args.lr,
        epochs=args.epochs,
        batch_size=args.batch_size,
        v_head_weight=args.v_head_weight,
        policy_weight=args.policy_weight,
        mirror_weight=args.mirror_weight,
        seed=args.seed,
    )
    pre_encode = args.pre_encode and len(train_records) < 50000
    train_ds = StateObservationDataset(train_records, vocabs, pre_encode=pre_encode)
    val_ds = StateObservationDataset(val_records, vocabs, pre_encode=pre_encode) if val_records else None
    if pre_encode:
        print(f"[v30-encoder] pre-encoded {len(train_ds)} train / {len(val_ds) if val_ds else 0} val samples", file=sys.stderr)
    n_workers = max(0, args.num_workers)
    loader_kw = dict(batch_size=hp.batch_size, collate_fn=collate)
    if n_workers > 0:
        loader_kw["num_workers"] = n_workers
        loader_kw["prefetch_factor"] = args.prefetch_factor
        loader_kw["persistent_workers"] = True
    train_loader = DataLoader(train_ds, shuffle=True, **loader_kw)
    val_loader = (
        DataLoader(val_ds, shuffle=False, **loader_kw)
        if val_ds is not None
        else None
    )

    model = V30Encoder(vocabs, hp).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[v30-encoder] model params={n_params}", file=sys.stderr)

    # V31 F6 (V30 §21.9): build online-TD state — an in-order (no-shuffle) refresh
    # loader + trajectory successor index. Before each epoch the V head's target
    # is re-bootstrapped as γ·V_θ(s_next).
    online_td = None
    if args.online_td:
        successor = build_successor_index(train_records)
        refresh_loader = DataLoader(
            train_ds, shuffle=False, **loader_kw,
        )
        online_td = OnlineTdState(
            records=train_records,
            successor=successor,
            refresh_loader=refresh_loader,
            gamma=args.td_gamma,
            warmup_epochs=max(0, args.online_td_warmup),
        )
        n_terminal = sum(1 for s in successor if s < 0)
        print(
            f"[v30-encoder] online-TD enabled (γ={args.td_gamma} warmup={args.online_td_warmup}); "
            f"{len(train_records) - n_terminal} bootstrap / {n_terminal} terminal targets",
            file=sys.stderr,
        )

    summary = train_loop(
        model,
        train_loader,
        val_loader,
        hp,
        device,
        vocabs=vocabs,
        checkpoint_path=args.out,
        report_path=args.report,
        online_td=online_td,
        checkpoint_metric=args.checkpoint_metric,
    )
    export_weights(model, vocabs, hp, args.out)

    report = {
        "schema_version": SCHEMA_VERSION,
        "n_params": n_params,
        "hyperparams": vars(args),
        "history": summary["history"],
        "best_val_loss": summary["best_val_loss"],
        "best_epoch": summary.get("best_epoch", -1),
        "in_progress": False,
        "vocab_sizes": {
            "character": len(vocabs.character),
            "summon": len(vocabs.summon),
            "support": len(vocabs.support),
            "combat_status": len(vocabs.combat_status),
            "character_status": len(vocabs.character_status),
            "hand_card": len(vocabs.hand_card),
            "action_target": len(vocabs.action_target),
        },
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        with open(args.report, "wt", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
    print(json.dumps({"out": args.out, "report": args.report, "best_val": summary["best_val_loss"]}))


if __name__ == "__main__":
    main()
