#!/usr/bin/env python3
"""
CGT Reversibility Analysis — validates the reversibility pruning hypothesis
using game replay state logs.

Reads game-NNNN.json replay files, extracts decision points (action phases),
classifies each action as reversible/irreversible per CGT heuristics,
and reports statistics.

Usage:
    python3 scripts/cgt_reversibility.py <replay_dir>/*.json
"""

import json, sys, os
from collections import defaultdict

# ── Replay parsing (based on parse_replay.py) ──

def deref(store, v):
    if isinstance(v, dict) and "$" in v:
        return store[v["$"]]
    return v

def get_player_state(store, pd):
    """Extract key player state from a player descriptor."""
    hands = deref(store, pd.get("hands"))
    hand_ids = []
    if isinstance(hands, list):
        for h in hands:
            hd = deref(store, h)
            if isinstance(hd, dict):
                defn = deref(store, hd.get("definition"))
                if isinstance(defn, dict):
                    hand_ids.append(defn.get("id", 0))
    dice_arr = deref(store, pd.get("dice"))
    dice_count = len(dice_arr) if isinstance(dice_arr, list) else 0
    chars = deref(store, pd.get("characters"))
    char_states = []
    if isinstance(chars, dict) and "entities" not in chars:
        char_entities = deref(store, chars)
        if isinstance(char_entities, list):
            for ce in char_entities:
                ced = deref(store, ce)
                if isinstance(ced, dict):
                    char_states.append({
                        "hp": ced.get("health", 0),
                        "max_hp": ced.get("maxHealth", 10),
                        "energy": ced.get("energy", 0),
                        "max_energy": ced.get("maxEnergy", 3),
                        "alive": ced.get("alive", 0),
                    })
    
    combat_statuses = []
    cs = deref(store, pd.get("combatStatuses"))
    if isinstance(cs, list):
        for c in cs:
            cd = deref(store, c)
            if isinstance(cd, dict):
                defn = deref(store, cd.get("definition"))
                if isinstance(defn, dict):
                    combat_statuses.append(defn.get("id", 0))
    
    return {
        "hand_ids": hand_ids,
        "dice_count": dice_count,
        "active_id": pd.get("activeCharacterId", 0),
        "characters": char_states,
        "combat_statuses": combat_statuses,
        "declared_end": pd.get("declaredEnd", False),
        "summons": len(deref(store, pd.get("summons")) or []) if isinstance(deref(store, pd.get("summons")), list) else 0,
    }


def parse_replay_log(path):
    """Parse a replay JSON and return list of (phase, player_states) tuples."""
    with open(path, "r") as f:
        data = json.load(f)
    
    store = data.get("store", [])
    log = data.get("log", [])
    gv = data.get("gv", "unknown")
    
    action_phases = []
    
    for entry in log:
        s = entry.get("s", {})
        # Dereference state from store
        state = deref(store, s)
        if not isinstance(state, dict):
            continue
        
        phase = state.get("phase", "")
        players = deref(store, state.get("players"))
        if not isinstance(players, list) or len(players) < 2:
            continue
        
        ct = state.get("currentTurn", 0)
        
        p0 = get_player_state(store, players[0])
        p1 = get_player_state(store, players[1])
        
        if phase == "action":
            action_phases.append({
                "round": state.get("roundNumber", 0),
                "turn": ct,
                "who": state.get("who", ct),
                "players": [p0, p1],
            })
    
    return action_phases, gv


# ── CGT Reversibility Classification ──

def is_reversible(action_case: str, action_cost: int, player_state: dict, opponent_state: dict) -> tuple:
    """
    Classify an action as reversible or irreversible per CGT heuristics.
    
    Returns: (is_reversible: bool, reason: str)
    """
    # Rule 1: Switch character (1 cost) — opponent can also switch for 1 cost
    if action_case == "switchActive":
        opp_can_switch = (
            opponent_state.get("dice_count", 0) >= 1 and
            any(c["alive"] and not c.get("active") for c in opponent_state.get("characters", []))
        )
        if opp_can_switch:
            return True, "switchActive: opponent has >=1 die and backline characters"
        return False, "switchActive: opponent cannot switch back"
    
    # Rule 2: Use skill — reversible if opponent can respond with equal-cost skill 
    # that neutralizes the effect (e.g., heal back, shield, switch to immune)
    if action_case == "useSkill":
        # Check if opponent can play a skill of similar cost
        opp_dice = opponent_state.get("dice_count", 0)
        if opp_dice >= action_cost:
            # Heuristic: if the skill deals damage, opponent can heal/switch
            # If it applies element, opponent can switch to immune/clear
            return True, f"useSkill: opponent has {opp_dice} dice to respond"
        return False, f"useSkill: opponent has only {opp_dice} dice (need {action_cost})"
    
    # Rule 3: Play card (equipment/support/event) — generally reversible 
    # unless it's a key talent card or combat event
    if action_case == "playCard":
        # Equipment and support cards are low-tempo, opponent can ignore
        return True, "playCard: low-tempo, opponent can continue their plan"
    
    # Rule 4: Declare end — not reversible (commits to end turn)
    if action_case == "declareEnd":
        return False, "declareEnd: commits to ending turn"
    
    # Default
    return False, f"{action_case}: unknown action type"


def classify_action_from_state(prev_state: dict, curr_state: dict, who: int):
    """
    Infer what action was taken by comparing consecutive states.
    """
    prev = prev_state.get("players", [{}])[who]
    curr = curr_state.get("players", [{}])[who]
    opp_prev = prev_state.get("players", [{}])[1 - who]
    
    prev_dice = prev.get("dice_count", 0)
    curr_dice = curr.get("dice_count", 0)
    prev_hands = len(prev.get("hand_ids", []))
    curr_hands = len(curr.get("hand_ids", []))
    prev_active = prev.get("active_id", 0)
    curr_active = curr.get("active_id", 0)
    
    # Infer action
    if curr.get("declared_end") and not prev.get("declared_end"):
        return "declareEnd", prev_dice - curr_dice
    
    if prev_active != curr_active and curr_active != 0:
        return "switchActive", prev_dice - curr_dice
    
    dice_used = prev_dice - curr_dice
    hands_used = prev_hands - curr_hands
    
    if dice_used > 0:
        if hands_used > 0:
            return "playCard", dice_used
        return "useSkill", dice_used
    
    if hands_used > 0:
        return "playCard", 0  # 0-cost card
    
    return "unknown", 0


# ── Main Analysis ──

def analyze_replay(replay_path):
    """Analyze a single replay file for reversibility statistics."""
    action_phases, gv = parse_replay_log(replay_path)
    
    if len(action_phases) < 2:
        return None
    
    results = []
    for i in range(len(action_phases) - 1):
        prev = action_phases[i]
        curr = action_phases[i + 1]
        
        # Only analyze when it's the same player's consecutive action
        if prev["who"] != curr["who"]:
            continue
        
        action_case, cost = classify_action_from_state(prev, curr, prev["who"])
        reversible, reason = is_reversible(
            action_case, cost,
            prev["players"][prev["who"]],
            prev["players"][1 - prev["who"]],
        )
        
        results.append({
            "round": prev["round"],
            "who": prev["who"],
            "action": action_case,
            "cost": cost,
            "reversible": reversible,
            "reason": reason,
            "dice_self": prev["players"][prev["who"]]["dice_count"],
            "dice_opp": prev["players"][1 - prev["who"]]["dice_count"],
        })
    
    return results


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 cgt_reversibility.py <replay_dir>/*.json")
        sys.exit(1)
    
    all_results = []
    total_actions = 0
    reversible_count = 0
    by_action = defaultdict(lambda: {"total": 0, "reversible": 0})
    
    for path in sys.argv[1:]:
        if not os.path.isfile(path):
            continue
        try:
            results = analyze_replay(path)
            if results:
                all_results.extend(results)
                for r in results:
                    total_actions += 1
                    if r["reversible"]:
                        reversible_count += 1
                    by_action[r["action"]]["total"] += 1
                    if r["reversible"]:
                        by_action[r["action"]]["reversible"] += 1
        except Exception as e:
            print(f"  [SKIP] {os.path.basename(path)}: {e}", file=sys.stderr)
    
    if total_actions == 0:
        print("No actions found.")
        return
    
    # ── Report ──
    print("=" * 60)
    print("CGT Reversibility Analysis")
    print("=" * 60)
    print(f"\nTotal replays analyzed: {len(set(p for p in sys.argv[1:] if os.path.isfile(p)))}")
    print(f"Total decision points: {total_actions}")
    print(f"Reversible actions: {reversible_count} ({reversible_count/total_actions*100:.1f}%)")
    print(f"Irreversible actions: {total_actions - reversible_count} ({(total_actions-reversible_count)/total_actions*100:.1f}%)")
    
    print(f"\n{'-'*40}")
    print(f"{'Action Type':<20} {'Total':>6} {'Reversible':>10} {'%':>8}")
    print(f"{'-'*40}")
    for action, counts in sorted(by_action.items()):
        total = counts["total"]
        rev = counts["reversible"]
        print(f"{action:<20} {total:>6} {rev:>10} {rev/total*100:>7.1f}%")
    
    # ── CGT Hypothesis Check ──
    print(f"\n{'='*60}")
    print("Hypothesis: Reversibility pruning eliminates 30-50% of search nodes")
    print(f"Observed: {reversible_count/total_actions*100:.1f}% of actions are reversible")
    
    if 30 <= reversible_count/total_actions*100 <= 50:
        print("✅ HYPOTHESIS CONFIRMED — reversibility rate in predicted range")
    elif reversible_count/total_actions*100 > 50:
        print("⚠️ Reversibility rate HIGHER than expected (>50%) — pruning potential even larger")
    else:
        print(f"⚠️ Reversibility rate LOWER than expected ({reversible_count/total_actions*100:.1f}% < 30%)")
        print("   Possible reasons: limited action types detected, conservative classification")
    
    # ── Dice cooling hypothesis ──
    print(f"\n{'='*60}")
    print("Secondary Hypothesis: Dice count inversely correlates with search depth need")
    low_dice = [r for r in all_results if r["dice_self"] <= 3]
    high_dice = [r for r in all_results if r["dice_self"] >= 7]
    
    if low_dice:
        low_rev = sum(1 for r in low_dice if r["reversible"]) / len(low_dice) * 100
        print(f"Low dice (≤3) positions: {len(low_dice)} actions, {low_rev:.1f}% reversible")
    if high_dice:
        high_rev = sum(1 for r in high_dice if r["reversible"]) / len(high_dice) * 100
        print(f"High dice (≥7) positions: {len(high_dice)} actions, {high_rev:.1f}% reversible")
    
    if low_dice and high_dice:
        print(f"Delta: {low_rev - high_rev:+.1f}% (low dice should be MORE reversible — easier to counter)")
    
    print(f"\n{'='*60}")
    print("Sample actions (first 15):")
    print(f"{'Round':>5} {'Who':>4} {'Action':<15} {'Cost':>4} {'Rev':>3} {'SelfDice':>8} {'OppDice':>8} {'Reason'}")
    print("-" * 80)
    for r in all_results[:15]:
        print(f"{r['round']:>5} {r['who']:>4} {r['action']:<15} {r['cost']:>4} {'Y' if r['reversible'] else 'N':>3} {r['dice_self']:>8} {r['dice_opp']:>8} {r['reason'][:50]}")


if __name__ == "__main__":
    main()
