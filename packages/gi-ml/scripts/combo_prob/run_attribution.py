"""
Run attribution pipeline on benchmark replays.

Integrates: replay_adapter (parsing) → attribution_engine (scoring)
"""

import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

from replay_adapter import parse_replay
from dice_lookup import DiceDistribution, load_or_build


# ─── Scoring Model ─────────────────────────────────────────────────────

class SimpleScorer:
    """Heuristic value function for game state evaluation."""

    def evaluate(self, state: Dict) -> float:
        """Return value from P0's perspective, normalized to [-1, 1].

        Higher = better for P0.
        """
        players = state.get("players", [])
        if len(players) < 2:
            return 0.0

        p0 = players[0]
        p1 = players[1]

        # Total HP + shield
        p0_hp = sum(c.get("health", 0) + c.get("shield", 0)
                     for c in p0.get("characters", []))
        p1_hp = sum(c.get("health", 0) + c.get("shield", 0)
                     for c in p1.get("characters", []))

        max_start_hp = 30  # 3 chars × 10 HP
        hp_adv = (p0_hp - p1_hp) / max_start_hp  # ~[-1, 1]

        # Alive characters
        p0_alive = sum(1 for c in p0.get("characters", [])
                       if c.get("alive", 0) > 0)
        p1_alive = sum(1 for c in p1.get("characters", [])
                       if c.get("alive", 0) > 0)

        alive_adv = 0.0
        if p0_alive + p1_alive > 0:
            alive_adv = (p0_alive - p1_alive) / 3.0

        # Summon + support advantage
        p0_board = p0.get("n_summons", 0) + p0.get("n_supports", 0) * 0.5
        p1_board = p1.get("n_summons", 0) + p1.get("n_supports", 0) * 0.5
        board_adv = 0.05 * (p0_board - p1_board)

        # Energy advantage (energy is a resource for bursts)
        p0_energy = sum(c.get("energy", 0) for c in p0.get("characters", []))
        p1_energy = sum(c.get("energy", 0) for c in p1.get("characters", []))
        energy_adv = 0.02 * (p0_energy - p1_energy)

        value = 0.65 * hp_adv + 0.2 * alive_adv + 0.1 * board_adv + 0.05 * energy_adv
        return max(-1.0, min(1.0, value))


# ─── Attribution Engine ─────────────────────────────────────────────────

class AttributionEngine:
    """Attribute game outcome to dice luck, draw luck, and strategy."""

    def __init__(self, scorer=None, dice_dist=None):
        self.scorer = scorer or SimpleScorer()
        self.dice_dist = dice_dist or load_or_build()

    def attribute_game(self, replay_data: Dict) -> Dict:
        """Decompose one replay into luck components."""
        decisions = replay_data.get("decisions", [])
        if not decisions:
            return self._empty_result(replay_data)

        # Group decisions by round
        round_map = defaultdict(list)
        for d in decisions:
            round_map[d["round"]].append(d)

        rounds_sorted = sorted(round_map.keys())

        # Per-round attribution
        round_results = []
        total_dice_luck_p0 = 0.0
        total_dice_luck_p1 = 0.0

        for r_num in rounds_sorted:
            round_decs = round_map[r_num]
            rr = self._attribute_round(r_num, round_decs)
            round_results.append(rr)
            total_dice_luck_p0 += rr["dice_luck"][0]
            total_dice_luck_p1 += rr["dice_luck"][1]

        return {
            "game_id": replay_data.get("matchupId", "unknown"),
            "matchup": replay_data.get("matchup", "unknown"),
            "winner": replay_data.get("winner", -1),
            "n_rounds": len(rounds_sorted),
            "n_decisions": len(decisions),
            "dice_luck": [total_dice_luck_p0, total_dice_luck_p1],
            "rounds": round_results,
        }

    def _attribute_round(self, r_num: int, decisions: List[Dict]) -> Dict:
        """Attribute one round of decisions."""
        result = {
            "round": r_num,
            "dice_luck": [0.0, 0.0],
            "n_decisions": [0, 0],
            "hp_progression": [],
        }

        if not decisions:
            return result

        # Round-start state (first decision in the round)
        first_state = decisions[0].get("state", {})
        if not first_state:
            return result

        # Dice luck: V(state|actual_dice) - E[V(state)]
        # We compute this per decision point by comparing actual value
        # to the expected value (which accounts for average dice)
        for dec in decisions:
            player = dec.get("player", -1)
            if player not in (0, 1):
                continue

            state = dec.get("state", {})
            if not state:
                continue

            # Current V(state)
            current_v = self.scorer.evaluate(state)

            # Dice luck: how much does the actual dice outcome contribute to V?
            # We approximate this by the delta in V from round-start
            # This is a simplification — proper computation requires
            # E[V | all_possible_dice] which needs dice distribution sampling
            dice_luck = self._estimate_dice_luck(state, player)

            idx = 0 if player == 0 else 1
            result["dice_luck"][idx] += dice_luck
            result["n_decisions"][idx] += 1

        # HP progression
        for dec in decisions:
            state = dec.get("state", {})
            players = state.get("players", [])
            if len(players) >= 2:
                hp0 = sum(c.get("health", 0) + c.get("shield", 0)
                          for c in players[0].get("characters", []))
                hp1 = sum(c.get("health", 0) + c.get("shield", 0)
                          for c in players[1].get("characters", []))
                result["hp_progression"].append([hp0, hp1])

        return result

    def _estimate_dice_luck(self, state: Dict, player: int) -> float:
        """Estimate dice luck for a player at a decision point.

        Measures: V(state) - V(baseline state with average dice).
        For simplicity, approximate baseline as the average V across
        the game so far.

        Returns a small number — dice luck accumulates across many decisions.
        """
        players = state.get("players", [])
        if player >= len(players):
            return 0.0

        p_state = players[player]
        dice = p_state.get("dice", [])

        if not dice:
            return 0.0

        # Calculate expected omni count from 8d8
        # Each die has 1/8 chance of being omni (type 8)
        expected_omni = len(dice) / 8.0
        actual_omni = sum(1 for d in dice if d == 8)

        # Omni surplus/deficit relative to expectation
        omni_delta = (actual_omni - expected_omni) / 8.0  # Normalized

        # Also check element diversity — having the "right" elements
        # For now, use # of unique elements as proxy
        unique = len(set(d for d in dice if d != 8))
        # 8 dice, 7 non-omni elements, expected unique ≈ 7 * (1 - (6/7)^8) ≈ 5.2
        expected_unique = 7 * (1 - (6/7)**8)  # ≈ 5.2
        diversity_delta = (unique - expected_unique) / 7.0

        return 0.05 * omni_delta + 0.02 * diversity_delta

    def _empty_result(self, replay_data: Dict) -> Dict:
        return {
            "game_id": replay_data.get("matchupId", "unknown"),
            "matchup": replay_data.get("matchup", "unknown"),
            "winner": -1,
            "n_rounds": 0,
            "n_decisions": 0,
            "dice_luck": [0.0, 0.0],
            "rounds": [],
        }


# ─── Batch Processor ───────────────────────────────────────────────────

def process_replay_dir(replay_dir: str,
                       output_path: str = None,
                       max_games: int = None) -> List[Dict]:
    """Process all replays in a directory."""
    engine = AttributionEngine()
    results = []

    replay_path = Path(replay_dir)
    json_files = sorted(replay_path.glob("game-*.json"))

    # Filter: prefer -p0.json files to avoid double-counting
    p0_files = [f for f in json_files if f.name.endswith("-p0.json")]
    if p0_files:
        json_files = p0_files
    if max_games:
        json_files = json_files[:max_games]

    print(f"Processing {len(json_files)} replays from {replay_dir}")
    print(f"  Format: compact game-state replay\n")

    for i, fpath in enumerate(json_files):
        try:
            # Parse replay
            game_data = parse_replay(str(fpath))

            # Attribute
            attr = engine.attribute_game(game_data)
            results.append(attr)

            if (i + 1) % 5 == 0 or i == 0:
                dl = attr["dice_luck"]
                print(f"  [{i+1}/{len(json_files)}] {attr['game_id'][:40]}... "
                      f"R={attr['n_rounds']} D={attr['n_decisions']} "
                      f"dice_luck=[{dl[0]:+.3f},{dl[1]:+.3f}]")

        except Exception as e:
            import traceback
            print(f"  [{i+1}/{len(json_files)}] ERROR: {fpath.name}: {e}")
            traceback.print_exc()

    if results:
        _print_summary(results)

    if output_path:
        _save_results(results, output_path)

    return results


def _print_summary(results: List[Dict]):
    """Print aggregate statistics across all games."""
    n = len(results)
    print(f"\n{'='*65}")
    print(f"  ATTRIBUTION SUMMARY ({n} games)")
    print(f"{'='*65}")

    # Aggregate
    total_dice_p0 = sum(abs(a["dice_luck"][0]) for a in results)
    total_dice_p1 = sum(abs(a["dice_luck"][1]) for a in results)
    total_rounds = sum(a["n_rounds"] for a in results)
    total_decisions = sum(a["n_decisions"] for a in results)

    print(f"  Total rounds:    {total_rounds}")
    print(f"  Total decisions: {total_decisions}")
    print(f"  Avg rounds/game: {total_rounds/n:.1f}")
    print(f"  Avg decisions/game: {total_decisions/n:.1f}")
    print()

    print(f"  {'Component':<20} {'P0':>10} {'P1':>10} {'Total':>10}")
    print(f"  {'-'*20} {'-'*10} {'-'*10} {'-'*10}")
    print(f"  {'Dice Luck (abs)':<20} {total_dice_p0:>10.3f} {total_dice_p1:>10.3f} {total_dice_p0+total_dice_p1:>10.3f}")

    avg_dice_p0 = total_dice_p0 / n
    avg_dice_p1 = total_dice_p1 / n
    print(f"\n  Avg |dice_luck|/game: P0={avg_dice_p0:.3f}  P1={avg_dice_p1:.3f}")

    # Mirror matchup analysis
    mirror_games = []
    for a in results:
        m = a.get("matchup", "")
        if " vs " in m:
            left, right = m.split(" vs ")
            if left == right:
                mirror_games.append(a)

    if mirror_games:
        print(f"\n  Mirror matchups ({len(mirror_games)} games):")
        p0_wins = sum(1 for a in mirror_games if a["winner"] == 0)
        p1_wins = sum(1 for a in mirror_games if a["winner"] == 1)
        total = len(mirror_games)
        draws = total - p0_wins - p1_wins
        if total > 0:
            print(f"    P0 (先手): {p0_wins} ({p0_wins/total*100:.0f}%)")
            print(f"    P1 (后手): {p1_wins} ({p1_wins/total*100:.0f}%)")
            if draws:
                print(f"    Draws:    {draws}")
            # Mirror dice luck analysis
            mirror_dice_p0 = sum(abs(a["dice_luck"][0]) for a in mirror_games)
            mirror_dice_p1 = sum(abs(a["dice_luck"][1]) for a in mirror_games)
            if len(mirror_games) > 0:
                print(f"    Dice luck avg: P0={mirror_dice_p0/len(mirror_games):.3f}  P1={mirror_dice_p1/len(mirror_games):.3f}")

    # Per-deck breakdown
    deck_stats = defaultdict(lambda: {"n": 0, "dice_p0": 0.0, "dice_p1": 0.0})
    for a in results:
        m = a.get("matchup", "unknown")
        deck_stats[m]["n"] += 1
        deck_stats[m]["dice_p0"] += abs(a["dice_luck"][0])
        deck_stats[m]["dice_p1"] += abs(a["dice_luck"][1])

    if len(deck_stats) > 1:
        print(f"\n  Per-deck dice luck:")
        for matchup, stats in sorted(deck_stats.items()):
            n = stats["n"]
            avg_p0 = stats["dice_p0"] / n
            avg_p1 = stats["dice_p1"] / n
            print(f"    {matchup[:50]:<50} n={n:>2}  P0={avg_p0:.3f} P1={avg_p1:.3f}")


def _save_results(results: List[Dict], output_path: str):
    """Save results to JSON."""
    output = {
        "version": "1.0",
        "description": "GI TCG attribution — dice luck decomposition",
        "n_games": len(results),
        "games": [
            {
                "game_id": a["game_id"],
                "matchup": a["matchup"],
                "winner": a["winner"],
                "n_rounds": a["n_rounds"],
                "n_decisions": a["n_decisions"],
                "dice_luck": a["dice_luck"],
                "rounds": a["rounds"],
            }
            for a in results
        ],
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n  Results saved: {output_path}")


# ─── CLI ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="GI TCG Attribution — decompose replays into luck components"
    )
    parser.add_argument("replay_dir", help="Directory with replay JSON files")
    parser.add_argument("--output", "-o", default="attribution_results.json",
                        help="Output JSON file")
    parser.add_argument("--max-games", "-n", type=int, default=20,
                        help="Max games to process (default: 20)")
    args = parser.parse_args()

    process_replay_dir(args.replay_dir, args.output, args.max_games)
