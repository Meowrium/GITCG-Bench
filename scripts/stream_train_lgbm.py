#!/usr/bin/env python3
"""
Streaming RL → Value dataset builder (no TS loader, no OOM).

Reads the RL dataset manifest, processes shards one at a time,
builds a compact value dataset, and passes it to LightGBM trainer.

Usage:
  cd packages/gi-agent
  python ../../scripts/stream_train_lgbm.py \
    --manifest output/iter-training/iter-001/rl-dataset.manifest.json \
    --output-dir output/iter-training/iter-001/artifacts \
    --prefix iter001 \
    --estimators 80 --depth 5 --lr 0.06 --top-features 128 \
    --max-samples 40000
"""

import argparse
import json
import os
import sys
import subprocess
from pathlib import Path

# Import the LGBM trainer functions
SCRIPT_DIR = Path(__file__).resolve().parent
LGBM_TRAINER = SCRIPT_DIR.parent / "packages/gi-ml/python/gitcg_ml/train_lgbm_value.py"
sys.path.insert(0, str(LGBM_TRAINER.parent))

# We'll call the trainer as a subprocess after building the value dataset

def flatten_slots(slots, prefix=""):
    """Recursively flatten nested feature_slots (mirrors TS buildObservationValueFeatureSlots)."""
    result = {}
    if isinstance(slots, dict):
        for k, v in slots.items():
            full_key = f"{prefix}{k}" if not prefix else f"{prefix}.{k}"
            if isinstance(v, dict):
                result.update(flatten_slots(v, full_key))
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                result[full_key] = float(v)
    return result

def build_value_features(obs):
    """Replicate TS buildObservationValueFeatureSlots() logic."""
    self = obs.get("self", {})
    opp = obs.get("opponent", {})
    derived = obs.get("derived", {})
    pt = obs.get("point", {})
    pub = obs.get("public_state", {})
    hand = self.get("hand", {})
    visible_cards = hand.get("visible_cards", [])

    # Active characters
    self_chars = self.get("characters", [])
    opp_chars = opp.get("characters", [])
    self_active_idx = self.get("active_character_index")
    opp_active_idx = opp.get("active_character_index")
    self_active = self_chars[self_active_idx] if self_active_idx is not None and self_active_idx < len(self_chars) else {}
    opp_active = opp_chars[opp_active_idx] if opp_active_idx is not None and opp_active_idx < len(opp_chars) else {}

    # Character features
    self_char_features = {}
    for i in range(3):
        ch = self_chars[i] if i < len(self_chars) else None
        prefix = f"c{i}"
        if ch is None:
            self_char_features.update({f"{prefix}_alive": 0, f"{prefix}_hp": 0, f"{prefix}_hp_ratio": 0,
                                        f"{prefix}_energy_ratio": 0, f"{prefix}_equip_count": 0, f"{prefix}_definition_id": 0})
        else:
            self_char_features[f"{prefix}_alive"] = 1 if ch.get("alive") else 0
            self_char_features[f"{prefix}_hp"] = ch.get("health", 0)
            self_char_features[f"{prefix}_hp_ratio"] = ch.get("health", 0) / max(ch.get("max_health", 1), 1)
            self_char_features[f"{prefix}_energy_ratio"] = ch.get("energy", 0) / max(ch.get("max_energy", 1), 1)
            self_char_features[f"{prefix}_equip_count"] = len(ch.get("equipment_ids", []))
            self_char_features[f"{prefix}_definition_id"] = ch.get("definition_id", 0)

    opp_char_features = {}
    for i in range(3):
        ch = opp_chars[i] if i < len(opp_chars) else None
        prefix = f"c{i}"
        if ch is None:
            opp_char_features.update({f"{prefix}_alive": 0, f"{prefix}_hp": 0, f"{prefix}_hp_ratio": 0,
                                       f"{prefix}_energy_ratio": 0, f"{prefix}_equip_count": 0, f"{prefix}_definition_id": 0})
        else:
            opp_char_features[f"{prefix}_alive"] = 1 if ch.get("alive") else 0
            opp_char_features[f"{prefix}_hp"] = ch.get("health", 0)
            opp_char_features[f"{prefix}_hp_ratio"] = ch.get("health", 0) / max(ch.get("max_health", 1), 1)
            opp_char_features[f"{prefix}_energy_ratio"] = ch.get("energy", 0) / max(ch.get("max_energy", 1), 1)
            opp_char_features[f"{prefix}_equip_count"] = len(ch.get("equipment_ids", []))
            opp_char_features[f"{prefix}_definition_id"] = ch.get("definition_id", 0)

    # Hand composition
    event_count = 0
    support_count = 0
    equipment_count = 0
    food_count = 0
    other_count = 0
    card_ids = {}
    for i in range(10):
        card = visible_cards[i] if i < len(visible_cards) else None
        card_ids[f"card{i}_definition_id"] = card.get("definition_id", 0) if card else 0
        if card:
            all_tags = list(card.get("tags", [])) + list(card.get("static_effect_tags", []))
            all_tags_str = [str(t) for t in all_tags]
            if any(t == "tag:food" or t == "food" for t in all_tags_str):
                food_count += 1
            elif any(t == "support_card" or t == "support_create" for t in all_tags_str):
                support_count += 1
            elif any(t == "equipment_card" or t == "weapon" or t == "artifact" for t in all_tags_str):
                equipment_count += 1
            elif any(t == "event" for t in all_tags_str):
                event_count += 1
            else:
                other_count += 1

    # Opponent bench
    min_hp = float('inf')
    min_hp_index = -1
    for i, ch in enumerate(opp_chars):
        if not ch.get("alive") or ch.get("is_active"):
            continue
        if ch.get("health", float('inf')) < min_hp:
            min_hp = ch["health"]
            min_hp_index = i
    if min_hp_index == -1:
        min_hp = 0

    # Opponent active features
    is_frozen = 0
    is_stunned = 0
    if opp_active:
        entities = opp_active.get("entities", [])
        for e in entities:
            if e.get("definition_id") == 106:
                is_frozen = 1
            if e.get("definition_id") == 116033:
                is_stunned = 1
    shield = sum(
        cs.get("variable_value", 0) or 0
        for cs in opp.get("combat_statuses", [])
        if (cs.get("variable_name") or "").lower().find("shield") >= 0
    )

    # Pending method one-hot
    pm = pt.get("pending_method")
    pending = {
        "is_action": 1 if pm == "action" else 0,
        "is_choose_active": 1 if pm == "chooseActive" else 0,
        "is_reroll_dice": 1 if pm == "rerollDice" else 0,
        "is_switch_hands": 1 if pm == "switchHands" else 0,
        "is_select_card": 1 if pm == "selectCard" else 0,
    }

    total_dice = self.get("dice", {}).get("total_count", 0)

    # Build nested feature_slots (mirrors TS)
    feature_slots = {
        "round": pt.get("round_number", 1),
        "current_turn": pt.get("current_turn", 0),
        "action_count_in_round": pt.get("action_count_in_round", 0),
        "self": {
            "hand_count": hand.get("card_count", 0),
            "dice_count": total_dice,
            "omni_count": self.get("dice", {}).get("omni_count", 0),
            "support_count": len(self.get("supports", [])),
            "summon_count": len(self.get("summons", [])),
            "alive_count": sum(1 for ch in self_chars if ch.get("alive")),
            "total_health": sum(ch.get("health", 0) for ch in self_chars),
            "total_energy": sum(ch.get("energy", 0) for ch in self_chars),
            "active_health": self_active.get("health", 0),
            "active_energy": self_active.get("energy", 0),
            "can_afford_normal": 1 if total_dice >= 3 else 0,
            "can_afford_skill": 1 if total_dice >= 3 else 0,
            "can_afford_burst": 1 if total_dice >= 4 else 0,
        },
        "opponent": {
            "hand_count": opp.get("hand", {}).get("card_count", 0),
            "dice_count": opp.get("dice", {}).get("total_count", 0),
            "omni_count": opp.get("dice", {}).get("omni_count", 0),
            "support_count": len(opp.get("supports", [])),
            "summon_count": len(opp.get("summons", [])),
            "alive_count": sum(1 for ch in opp_chars if ch.get("alive")),
            "total_health": sum(ch.get("health", 0) for ch in opp_chars),
            "total_energy": sum(ch.get("energy", 0) for ch in opp_chars),
            "active_health": opp_active.get("health", 0),
            "active_energy": opp_active.get("energy", 0),
        },
        "self_characters": self_char_features,
        "opponent_characters": opp_char_features,
        "opponent_bench": {"min_hp": min_hp, "min_hp_index": min_hp_index},
        "hand_composition": {
            "total": hand.get("card_count", 0),
            "event_count": event_count,
            "support_count": support_count,
            "equipment_count": equipment_count,
            "food_count": food_count,
            "other_count": other_count,
            **card_ids,
        },
        "public_state": {
            "self_declared_end": pub.get("self_declared_end", False),
            "opponent_declared_end": pub.get("opponent_declared_end", False),
            "self_support_count": pub.get("self_support_count", 0),
            "opponent_support_count": pub.get("opponent_support_count", 0),
            "self_summon_count": pub.get("self_summon_count", 0),
            "opponent_summon_count": pub.get("opponent_summon_count", 0),
        },
        "derived": {
            "self_damage_capacity_now": derived.get("self_damage_capacity_now", 0),
            "opp_damage_capacity_now": derived.get("opp_damage_capacity_now", 0),
            "self_ko_pressure_now": derived.get("self_ko_pressure_now", 0),
            "opp_ko_pressure_now": derived.get("opp_ko_pressure_now", 0),
            "self_resource_score": derived.get("self_resource_score", 0),
            "opp_resource_score": derived.get("opp_resource_score", 0),
            "self_reaction_ready_score": derived.get("self_reaction_ready_score", 0),
            "opp_reaction_ready_score": derived.get("opp_reaction_ready_score", 0),
            "self_burst_online_count": derived.get("self_burst_online_count", 0),
            "opp_burst_online_count": derived.get("opp_burst_online_count", 0),
            "self_role_integrity_score": derived.get("self_role_integrity_score", 0),
            "opp_role_integrity_score": derived.get("opp_role_integrity_score", 0),
            "self_window_score": derived.get("self_window_score", 0),
            "opp_window_score": derived.get("opp_window_score", 0),
            # P2: Extended
            "dice_efficiency": derived.get("dice_efficiency", 0),
            "summon_pressure": derived.get("summon_pressure", 0),
            "action_economy_ratio": derived.get("action_economy_ratio", 1),
            # P2-2: Temporal
            "self_temporal_setup_saturation": derived.get("self_temporal_setup_saturation", 0),
            "self_ready_to_cash_option_count": derived.get("self_ready_to_cash_option_count", 0),
            "self_blocked_synergy_option_count": derived.get("self_blocked_synergy_option_count", 0),
            "self_available_deferred_option_count": derived.get("self_available_deferred_option_count", 0),
            "opp_temporal_setup_saturation": derived.get("opp_temporal_setup_saturation", 0),
            "opp_ready_to_cash_option_count": derived.get("opp_ready_to_cash_option_count", 0),
            "opp_blocked_synergy_option_count": derived.get("opp_blocked_synergy_option_count", 0),
            "opp_available_deferred_option_count": derived.get("opp_available_deferred_option_count", 0),
        },
        "static_priors": {
            "self_effect_family_counts": self.get("effect_family_counts", {}),
            "self_meta_prior_slots": self.get("meta_prior_slots", {}),
            "opponent_public_effect_family_counts": opp.get("effect_family_counts", {}),
            "opponent_public_meta_prior_slots": opp.get("meta_prior_slots", {}),
        },
        "pending_method": pending,
        "self_active": {
            "skill_damage_normal": 2,
            "skill_damage_skill": 3,
            "skill_damage_burst": 4,
            "energy_full": 1 if (self_active.get("max_energy", 1) > 0 and 
                                 self_active.get("energy", 0) >= self_active.get("max_energy", 1)) else 0,
        },
        "opponent_active": {
            "is_frozen": is_frozen,
            "is_stunned": is_stunned,
            "shield": shield,
        },
        "opponent_hand_estimate": build_opponent_hand_estimate_features(obs.get("hidden_estimate")),
        "opp_history": build_opponent_history_features(obs),
    }
    return feature_slots


def build_opponent_hand_estimate_features(hidden):
    """Mirrors buildOpponentHandEstimateFeatures() in rl-value.ts."""
    if not hidden:
        return {
            "hidden_hand_count": 0,
            "deck_remaining": 0,
            "expected_event": 0,
            "expected_equipment": 0,
            "expected_support": 0,
            "expected_food": 0,
            "expected_resonance": 0,
            "response_heal": 0,
            "response_dice_fix": 0,
            "response_swap": 0,
            "response_burst": 0,
            "known_revealed_cards": 0,
            "deck_draw_ratio": 0,
        }
    total_deck = hidden.get("hidden_hand_count", 0) + hidden.get("remaining_deck_count", 0)
    etc = hidden.get("expected_type_counts", {})
    erb = hidden.get("expected_response_buckets", {})
    return {
        "hidden_hand_count": hidden.get("hidden_hand_count", 0),
        "deck_remaining": hidden.get("remaining_deck_count", 0),
        "expected_event": etc.get("event", 0),
        "expected_equipment": etc.get("equipment", 0),
        "expected_support": etc.get("support", 0),
        "expected_food": etc.get("food", 0),
        "expected_resonance": etc.get("resonance", 0),
        "response_heal": erb.get("heal_like", 0),
        "response_dice_fix": erb.get("dice_fix_like", 0),
        "response_swap": erb.get("swap_like", 0),
        "response_burst": erb.get("burst_enable_like", 0),
        "known_revealed_cards": len(hidden.get("known_revealed_definition_ids", [])),
        "deck_draw_ratio": hidden.get("remaining_deck_count", 0) / max(total_deck, 1),
    }


def build_opponent_history_features(obs):
    """Mirrors buildOpponentHistoryFeatures() in rl-value.ts."""
    opp = obs.get("opponent", {})
    opp_chars = opp.get("characters", [])
    opp_active_idx = opp.get("active_character_index")
    opp_active = opp_chars[opp_active_idx] if opp_active_idx is not None and opp_active_idx < len(opp_chars) else {}
    opp_dice = opp.get("dice", {})
    pub = obs.get("public_state", {})
    pt = obs.get("point", {})
    derived = obs.get("derived", {})

    opp_dice_total = opp_dice.get("total_count", 0)
    opp_omni = opp_dice.get("omni_count", 0)
    opp_elemental = opp_dice_total - opp_omni
    dice_spent = max(0, 8 - opp_dice_total)

    opp_declared_end = 1 if pub.get("opponent_declared_end") else 0
    opp_actions_in_round = pt.get("action_count_in_round", 0)

    opp_alive = sum(1 for ch in opp_chars if ch.get("alive"))
    opp_total_hp = sum(ch.get("health", 0) for ch in opp_chars if ch.get("alive"))
    opp_max_hp = sum(ch.get("max_health", 0) for ch in opp_chars)
    active_hp_ratio = (opp_active.get("health", 0) / max(opp_active.get("max_health", 1), 1)) if opp_active else 0

    burst_ready = 0
    burst_near = 0
    for ch in opp_chars:
        if not ch.get("alive"):
            continue
        if ch.get("max_energy", 0) > 0 and ch.get("energy", 0) >= ch.get("max_energy", 0):
            burst_ready += 1
        elif ch.get("max_energy", 0) > 0 and ch.get("energy", 0) >= ch.get("max_energy", 0) - 1:
            burst_near += 1

    board_development = len(opp.get("supports", [])) + len(opp.get("summons", []))
    opp_hp_ratio = opp_total_hp / max(opp_max_hp, 1)
    ko_pressure = (1 - opp_hp_ratio) * opp_alive if opp_alive > 0 else 0
    damage_capacity = opp_alive * 2 if opp_dice_total >= 3 else opp_alive

    return {
        "dice_spent_this_round": dice_spent,
        "omni_remaining": opp_omni,
        "elemental_remaining": opp_elemental,
        "omni_ratio": opp_omni / max(opp_dice_total, 1),
        "actions_in_round": opp_actions_in_round,
        "active_hp_ratio": active_hp_ratio,
        "burst_ready_count": burst_ready,
        "burst_near_count": burst_near,
        "board_development": board_development,
        "alive_count": opp_alive,
        "declared_end": opp_declared_end,
        "ko_pressure": ko_pressure,
        "damage_capacity": damage_capacity,
        "action_economy_ratio": derived.get("action_economy_ratio", 1) or 1,
        "temporal_setup_sat": derived.get("opp_temporal_setup_saturation", 0) or 0,
        "ready_to_cash": derived.get("opp_ready_to_cash_option_count", 0) or 0,
        "blocked_synergy": derived.get("opp_blocked_synergy_option_count", 0) or 0,
        "available_deferred": derived.get("opp_available_deferred_option_count", 0) or 0,
    }


def build_value_dataset_streaming(manifest_path, max_samples=None, sample_every=1):
    """Stream through RL shards, build value samples, yield one at a time."""
    manifest_dir = os.path.dirname(os.path.abspath(manifest_path))
    with open(manifest_path) as f:
        manifest = json.load(f)

    shards = manifest.get("shards", [])
    total_loaded = 0
    total_built = 0

    for shard_info in shards:
        rel_path = shard_info["relative_path"]
        shard_path = os.path.join(manifest_dir, rel_path)
        # Fallback: shards may be in rl-dataset.shards/ subdirectory
        if not os.path.exists(shard_path):
            shard_path = os.path.join(manifest_dir, "rl-dataset.shards", rel_path)
        if not os.path.exists(shard_path):
            shard_path = os.path.join(manifest_dir, "self-play-rl", rel_path)
        print(f"  Processing {rel_path} ({shard_info['sample_count']} samples)...")
        with open(shard_path) as f:
            shard = json.load(f)

        for sample in shard.get("samples", []):
            total_loaded += 1
            if total_loaded % sample_every != 0:
                continue

            obs = sample.get("observation", {})
            outcome = sample.get("outcome_label")
            if outcome is None:
                continue

            reward = sample.get("reward_breakdown", {}) or {}
            weight = max(0.25, min(0.5 + abs(reward.get("terminal") or 0) + abs(reward.get("clipped_shaping_total") or 0), 2))

            feature_slots = build_value_features(obs)

            value_sample = {
                "sample_id": sample.get("decision_point", {}).get("decision_point_id", f"s{total_built}"),
                "source": "self_play",
                "state_ref": obs.get("point", {}).get("decision_point_id", ""),
                "target_value": outcome,
                "weight": weight,
                "context_slots": {
                    "matchup_id": sample.get("matchup_id", ""),
                    "side": sample.get("side", 0),
                    "round": obs.get("point", {}).get("round_number", 1),
                    "phase": obs.get("point", {}).get("phase", ""),
                    "pending_method": obs.get("point", {}).get("pending_method", ""),
                    "current_turn": obs.get("point", {}).get("current_turn", 0),
                    "action_count_in_round": obs.get("point", {}).get("action_count_in_round", 0),
                    "reward_total": reward.get("total", 0),
                    "reward_terminal": reward.get("terminal", 0),
                    "reward_shaping_total": reward.get("clipped_shaping_total", 0),
                },
                "feature_slots": feature_slots,
            }
            total_built += 1
            yield value_sample

            if max_samples and total_built >= max_samples:
                print(f"  Reached max_samples={max_samples}, stopping.")
                return

    print(f"  Total loaded: {total_loaded}, built: {total_built}")


def main():
    parser = argparse.ArgumentParser(description="Stream RL shards → value dataset → LightGBM")
    parser.add_argument("--manifest", required=True, help="RL dataset manifest JSON")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--prefix", default="lgbm")
    parser.add_argument("--estimators", type=int, default=80)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--lr", type=float, default=0.06)
    parser.add_argument("--top-features", type=int, default=128)
    parser.add_argument("--min-child", type=int, default=8)
    parser.add_argument("--subsample", type=float, default=0.8)
    parser.add_argument("--max-samples", type=int, default=40000)
    parser.add_argument("--sample-every", type=int, default=1)
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    args.output_dir = os.path.abspath(args.output_dir)

    # Step 1: Build value dataset via streaming
    print(f"[StreamTrain] Building value dataset from {args.manifest}...")
    samples = list(build_value_dataset_streaming(
        args.manifest,
        max_samples=args.max_samples,
        sample_every=args.sample_every,
    ))
    print(f"[StreamTrain] Built {len(samples)} value samples (max_samples={args.max_samples})")

    # Step 2: Write value dataset
    value_dataset = {
        "dataset_id": f"rl_value_stream__{len(samples)}",
        "created_at": "stream",
        "metadata": {"source": "self_play", "sample_count": len(samples)},
        "samples": samples,
    }

    value_path = os.path.abspath(os.path.join(args.output_dir, f"{args.prefix}.value-dataset.json"))
    print(f"[StreamTrain] Writing value dataset to {value_path}...")
    with open(value_path, "w") as f:
        json.dump(value_dataset, f)

    # Step 3: Run LightGBM trainer
    artifact_path = os.path.abspath(os.path.join(args.output_dir, f"{args.prefix}.gbdt-value-artifact.json"))
    eval_path = os.path.abspath(os.path.join(args.output_dir, f"{args.prefix}.gbdt-value-eval.json"))

    python = sys.executable
    cmd = [
        python, str(LGBM_TRAINER),
        "--input", value_path,
        "--output-artifact", artifact_path,
        "--output-eval", eval_path,
        "--estimators", str(args.estimators),
        "--depth", str(args.depth),
        "--lr", str(args.lr),
        "--top-features", str(args.top_features),
        "--min-child", str(args.min_child),
        "--subsample", str(args.subsample),
        "--prefix", args.prefix,
    ]

    print(f"[StreamTrain] Launching LightGBM: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=os.path.dirname(LGBM_TRAINER))
    if result.returncode != 0:
        print(f"[StreamTrain] LightGBM failed with code {result.returncode}")
        sys.exit(result.returncode)

    # Step 4: Read back evaluation
    try:
        with open(eval_path) as f:
            ev = json.load(f)
        print(f"\n[StreamTrain] Training Complete")
        print(f"  Artifact: {artifact_path}")
        print(f"  Evaluation: {eval_path}")
        print(f"  Samples: {ev.get('sample_count', '?')}")
        print(f"  MAE: {ev.get('mae', '?'):.4f}" if isinstance(ev.get('mae'), float) else f"")
        print(f"  RMSE: {ev.get('rmse', '?'):.4f}" if isinstance(ev.get('rmse'), float) else f"")
    except Exception as e:
        print(f"[StreamTrain] Done (could not read eval: {e})")


if __name__ == "__main__":
    main()
