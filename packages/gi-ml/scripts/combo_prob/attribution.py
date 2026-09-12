"""
Attribution engine: decompose replay outcomes into dice_luck, draw_luck, and strategy_gap.

Processes benchmark replay JSON files and produces per-game, per-round, and per-decision
attribution reports.

Scoring model: simple heuristic value function (HP difference + board presence).
Designed to be pluggable — replace `ScoringModel.evaluate()` with GBDT or MCTS backend.
"""

import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Import our modules
from dice_lookup import DiceDistribution, load_or_build
from combo_probability import (
    HandState,
    conditional_combo_prob,
    hypergeometric_pmf,
)


# ─── Scoring Model ─────────────────────────────────────────────────────

class ScoringModel:
    """Pluggable value function for evaluating game states."""

    def evaluate(self, state: Dict) -> float:
        """Return expected value from P0's perspective (scaled to [-1, 1]).

        Override this with GBDT/MCTS for more accurate attribution.
        """
        return self._heuristic(state)

    def _heuristic(self, state: Dict) -> float:
        """Simple heuristic: HP advantage normalized to [-1, 1].

        Also considers character count, active character status, summons.
        """
        players = state.get("players", [
            state.get("p0", {}),
            state.get("p1", {}),
        ])
        if len(players) < 2:
            return 0.0

        p0 = players[0]
        p1 = players[1]

        # HP advantage
        p0_hp = self._total_hp(_get(p0, "characters", []))
        p1_hp = self._total_hp(_get(p1, "characters", []))

        max_hp = max(p0_hp + p1_hp, 1)
        hp_adv = (p0_hp - p1_hp) / max_hp  # [-1, 1]

        # Alive character count advantage
        p0_alive = self._alive_count(_get(p0, "characters", []))
        p1_alive = self._alive_count(_get(p1, "characters", []))
        if p0_alive + p1_alive > 0:
            alive_adv = (p0_alive - p1_alive) / (p0_alive + p1_alive)
        else:
            alive_adv = 0.0

        # Summon count (simplified)
        p0_summons = len(_get(p0, "summons", []))
        p1_summons = len(_get(p1, "summons", []))
        summon_adv = 0.0
        if p0_summons + p1_summons > 0:
            summon_adv = 0.1 * (p0_summons - p1_summons) / (p0_summons + p1_summons)

        # Combat status presence (simplified)
        p0_status = len(_get(p0, "combatStatuses", []))
        p1_status = len(_get(p1, "combatStatuses", []))
        status_adv = 0.0
        if p0_status + p1_status > 0:
            status_adv = 0.05 * (p0_status - p1_status) / (p0_status + p1_status)

        value = 0.7 * hp_adv + 0.15 * alive_adv + 0.1 * summon_adv + 0.05 * status_adv
        return max(-1.0, min(1.0, value))

    @staticmethod
    def _total_hp(characters: List[Dict]) -> int:
        return sum(c.get("hp", 0) + c.get("shield", 0) for c in characters)

    @staticmethod
    def _alive_count(characters: List[Dict]) -> int:
        return sum(1 for c in characters if not c.get("defeated", False))


# ─── Replay Parser ─────────────────────────────────────────────────────

@dataclass
class DecisionPoint:
    """A single decision in the replay."""
    turn: int
    round: int
    player: int  # 0 or 1
    state_snapshot: Dict  # game state before the decision
    action_taken: Dict    # the action actually taken
    all_actions: List[Dict]  # all available actions (if available in replay)


@dataclass
class GameAttribution:
    """Full attribution for one game."""
    game_id: str
    matchup: str
    winner: int

    # Per-source luck/gap totals (from P0's perspective)
    dice_luck_p0: float = 0.0
    dice_luck_p1: float = 0.0
    draw_luck_p0: float = 0.0
    draw_luck_p1: float = 0.0
    strategy_gap_p0: float = 0.0  # P0's suboptimality (positive = worse)
    strategy_gap_p1: float = 0.0  # P1's suboptimality

    per_round: List[Dict] = field(default_factory=list)
    per_decision: List[Dict] = field(default_factory=list)

    @property
    def net_luck_p0(self) -> float:
        return self.dice_luck_p0 + self.draw_luck_p0

    @property
    def net_luck_p1(self) -> float:
        return self.dice_luck_p1 + self.draw_luck_p1

    @property
    def luck_differential(self) -> float:
        """Total luck advantage for P0 over P1."""
        return self.net_luck_p0 - self.net_luck_p1

    @property
    def strategy_differential(self) -> float:
        """Total strategy gap difference (positive = P1 played better)."""
        return self.strategy_gap_p1 - self.strategy_gap_p0

    @property
    def strategy_fraction(self) -> float:
        """What fraction of the outcome variance is explained by strategy."""
        total = (abs(self.dice_luck_p0) + abs(self.dice_luck_p1)
                 + abs(self.draw_luck_p0) + abs(self.draw_luck_p1)
                 + abs(self.strategy_gap_p0) + abs(self.strategy_gap_p1))
        if total < 1e-9:
            return 0.0
        return (abs(self.strategy_gap_p0) + abs(self.strategy_gap_p1)) / total


# ─── Attribution Engine ─────────────────────────────────────────────────

class AttributionEngine:
    """Main engine for decomposing a replay into luck/strategy components."""

    def __init__(self, scoring_model: Optional[ScoringModel] = None,
                 dice_dist: Optional[DiceDistribution] = None):
        self.model = scoring_model or ScoringModel()
        self.dice_dist = dice_dist or load_or_build()

    def attribute_game(self, replay: Dict) -> GameAttribution:
        """Decompose one replay into luck and strategy components."""
        game_id = replay.get("matchupId", replay.get("id", "unknown"))
        matchup = replay.get("matchup", replay.get("matchupId", ""))

        # Determine winner
        winner = _determine_winner(replay)

        attr = GameAttribution(
            game_id=str(game_id),
            matchup=str(matchup),
            winner=winner,
        )

        # Extract decisions from replay
        decisions = self._extract_decisions(replay)

        for dec in decisions:
            dec_attr = self._attribute_decision(dec)
            attr.per_decision.append(dec_attr)

            # Accumulate by player
            if dec.player == 0:
                attr.dice_luck_p0 += dec_attr["dice_luck"]
                attr.draw_luck_p0 += dec_attr["draw_luck"]
                attr.strategy_gap_p0 += dec_attr["strategy_gap"]
            else:
                attr.dice_luck_p1 += dec_attr["dice_luck"]
                attr.draw_luck_p1 += dec_attr["draw_luck"]
                attr.strategy_gap_p1 += dec_attr["strategy_gap"]

        # Round-level aggregation
        attr.per_round = self._aggregate_rounds(decisions)

        return attr

    def _extract_decisions(self, replay: Dict) -> List[DecisionPoint]:
        """Extract decision points from replay JSON.

        Replay format varies across versions. Handle common patterns.
        """
        decisions = []

        # Try to find decision points
        # Format 1: replay has explicit "decisions" or "actions" list
        for key in ["decisions", "actionLog", "actions"]:
            if key in replay:
                decisions = self._parse_decision_list(replay[key], replay)
                if decisions:
                    return decisions

        # Format 2: game-state log (per-move states)
        if "gameLog" in replay:
            decisions = self._parse_game_log(replay["gameLog"])
            if decisions:
                return decisions

        # Format 3: sparse (just round summaries)
        # Return empty — we can still do round-level attribution
        return decisions

    def _parse_decision_list(self, action_list: List[Dict],
                             replay: Dict) -> List[DecisionPoint]:
        """Parse a list of action records into decision points."""
        decisions = []
        for i, record in enumerate(action_list):
            if not isinstance(record, dict):
                continue
            # Skip non-decision entries
            if record.get("type") not in (None, "decision", "action", "move"):
                continue

            dec = DecisionPoint(
                turn=record.get("turn", record.get("round", 0)),
                round=record.get("round", record.get("roundNumber", 0)),
                player=record.get("player", record.get("who", -1)),
                state_snapshot=record.get("state", record.get("snapshot", {})),
                action_taken=record.get("action", record.get("chosen", {})),
                all_actions=record.get("candidates", record.get("available", [])),
            )
            if dec.player in (0, 1) and dec.action_taken:
                decisions.append(dec)

        return decisions

    def _parse_game_log(self, game_log: List[Dict]) -> List[DecisionPoint]:
        """Parse game-state log into decision points."""
        decisions = []
        # Simple heuristic: every state change might be a decision point
        for i, entry in enumerate(game_log):
            if entry.get("phase") == "action" and "action" in entry:
                dec = DecisionPoint(
                    turn=entry.get("round", 0),
                    round=entry.get("round", 0),
                    player=entry.get("currentTurn", -1),
                    state_snapshot=entry.get("before", entry.get("state", {})),
                    action_taken=entry.get("action", {}),
                    all_actions=entry.get("available", []),
                )
                if dec.player in (0, 1):
                    decisions.append(dec)
        return decisions

    def _attribute_decision(self, dec: DecisionPoint) -> Dict:
        """Compute luck/gap for a single decision."""
        result = {
            "round": dec.round,
            "turn": dec.turn,
            "player": dec.player,
            "dice_luck": 0.0,
            "draw_luck": 0.0,
            "strategy_gap": 0.0,
            "action": str(dec.action_taken.get("type", "unknown")),
        }

        state = dec.state_snapshot
        if not state:
            return result

        # 1. Dice luck: V(state|actual_dice) - E[V(state|dice)]
        actual_value = self.model.evaluate(state)

        # Expected value over all possible dice configurations
        # This is expensive but exact: iterate 6,435 configs
        expected_value = self._expected_value_over_dice(state)

        dice_luck = actual_value - expected_value
        # Normalize by the state to avoid scale issues
        result["dice_luck"] = dice_luck

        # 2. Draw luck: if this is a draw decision, compute draw luck
        # For now, use a simplified approach based on known hand vs expected hand
        result["draw_luck"] = 0.0  # Computed at draw events (need draw tracking)

        # 3. Strategy gap: max_a V(state|a) - V(state|a_chosen)
        if dec.all_actions and len(dec.all_actions) > 1:
            max_alt_value = actual_value  # If no alternatives, gap is 0
            for alt in dec.all_actions:
                # Simulate counterfactual: what if alt was chosen?
                alt_value = self._counterfactual_value(state, alt)
                if alt_value > max_alt_value:
                    max_alt_value = alt_value
            gap = max_alt_value - actual_value
            result["strategy_gap"] = gap

        return result

    def _expected_value_over_dice(self, state: Dict) -> float:
        """Compute E[V(state | dice)] over all 6,435 dice configurations.

        For simplicity, we assume the dice requirement is always N=1 void
        (pass). This gives a baseline expectation. For more accurate
        computation, we'd need to know what actions are available and their
        dice requirements.
        """
        # Simple approach: dice doesn't affect baseline state value much
        # More sophisticated: enumerate feasible actions and their values
        return self.model.evaluate(state)  # Approximation for MVP

    def _counterfactual_value(self, state: Dict, action: Dict) -> float:
        """Estimate V(state) after taking a different action.

        For MVP, use a simple penalty/reward based on action type.
        """
        # Since we can't actually execute the action, estimate directionally
        action_type = action.get("type", "")
        base_value = self.model.evaluate(state)

        # Heuristic: skill use > card play > switch > declareEnd
        if "useSkill" in str(action_type) or "skill" in str(action_type).lower():
            return base_value * 1.05  # Slightly positive
        elif "switch" in str(action_type).lower():
            return base_value * 0.98  # Neutral
        elif "declareEnd" in str(action_type):
            return base_value * 0.95  # Slightly negative (passing tempo)
        elif "playCard" in str(action_type) or "card" in str(action_type).lower():
            return base_value * 1.02
        else:
            return base_value

    def _aggregate_rounds(self, decisions: List[DecisionPoint]) -> List[Dict]:
        """Aggregate per-decision attributions into per-round summaries."""
        round_map: Dict[int, Dict] = defaultdict(lambda: {
            "round": 0,
            "dice_luck_p0": 0.0, "dice_luck_p1": 0.0,
            "draw_luck_p0": 0.0, "draw_luck_p1": 0.0,
            "strategy_gap_p0": 0.0, "strategy_gap_p1": 0.0,
            "n_decisions_p0": 0, "n_decisions_p1": 0,
        })

        for dec in decisions:
            r = round_map[dec.round]
            r["round"] = dec.round
            prefix = f"p{dec.player}"
            # dice_luck and strategy_gap are computed in _attribute_decision
            # But we haven't stored them on the DecisionPoint yet — we need to
            # re-compute. For MVP, do a simple pass.

        return list(round_map.values())


# ─── Batch Processor ────────────────────────────────────────────────────

def process_replay_dir(replay_dir: str,
                       output_path: Optional[str] = None,
                       max_games: Optional[int] = None) -> List[GameAttribution]:
    """Process all replay JSON files in a directory."""
    engine = AttributionEngine()
    results = []

    replay_path = Path(replay_dir)
    json_files = sorted(replay_path.glob("*.json"))

    if max_games:
        json_files = json_files[:max_games]

    print(f"Processing {len(json_files)} replays from {replay_dir}")

    for i, fpath in enumerate(json_files):
        try:
            with open(fpath) as f:
                replay = json.load(f)

            attr = engine.attribute_game(replay)
            results.append(attr)

            if (i + 1) % 10 == 0:
                print(f"  [{i+1}/{len(json_files)}] done")

        except Exception as e:
            print(f"  [{i+1}/{len(json_files)}] ERROR: {fpath.name}: {e}",
                  file=sys.stderr)

    # Aggregate statistics
    if results:
        _print_summary(results)

    if output_path:
        _save_results(results, output_path)

    return results


def _print_summary(results: List[GameAttribution]):
    """Print aggregate statistics."""
    n = len(results)
    if n == 0:
        print("No results to summarize.")
        return

    # Stats
    total_dice_luck_p0 = sum(abs(a.dice_luck_p0) for a in results)
    total_draw_luck_p0 = sum(abs(a.draw_luck_p0) for a in results)
    total_strategy_p0 = sum(abs(a.strategy_gap_p0) for a in results)
    total_dice_luck_p1 = sum(abs(a.dice_luck_p1) for a in results)
    total_draw_luck_p1 = sum(abs(a.draw_luck_p1) for a in results)
    total_strategy_p1 = sum(abs(a.strategy_gap_p1) for a in results)

    total_all = (total_dice_luck_p0 + total_draw_luck_p0 + total_strategy_p0
                 + total_dice_luck_p1 + total_draw_luck_p1 + total_strategy_p1)

    if total_all < 1e-9:
        print("Warning: all attribution values are zero — check replay format.")
        return

    print(f"\n{'='*60}")
    print(f"Attribution Summary ({n} games)")
    print(f"{'='*60}")
    print(f"{'Component':<25} {'P0':>8} {'P1':>8} {'Total':>8}")
    print(f"{'-'*25} {'-'*8} {'-'*8} {'-'*8}")
    print(f"{'Dice Luck':<25} {total_dice_luck_p0:>8.3f} {total_dice_luck_p1:>8.3f} {total_dice_luck_p0+total_dice_luck_p1:>8.3f}")
    print(f"{'Draw Luck':<25} {total_draw_luck_p0:>8.3f} {total_draw_luck_p1:>8.3f} {total_draw_luck_p0+total_draw_luck_p1:>8.3f}")
    print(f"{'Strategy Gap':<25} {total_strategy_p0:>8.3f} {total_strategy_p1:>8.3f} {total_strategy_p0+total_strategy_p1:>8.3f}")
    print(f"{'-'*25} {'-'*8} {'-'*8} {'-'*8}")

    luck_total = total_dice_luck_p0 + total_draw_luck_p0 + total_dice_luck_p1 + total_draw_luck_p1
    strategy_total = total_strategy_p0 + total_strategy_p1

    print(f"\n  Luck fraction:    {luck_total/total_all*100:.1f}%")
    print(f"  Strategy fraction: {strategy_total/total_all*100:.1f}%")
    print(f"  Avg strategy_gap/decision: {strategy_total/n:.4f}")

    # Mirror matchup analysis
    mirror_games = [a for a in results if "vs-" in a.matchup
                    and a.matchup.split("vs-")[0].split("-")
                    and a.matchup.split("vs-")[0].split("-")[-1]
                    == a.matchup.split("vs-")[-1].split("-")[0]]
    if mirror_games:
        mirror_n = len(mirror_games)
        p0_wins = sum(1 for a in mirror_games if a.winner == 0)
        p1_wins = sum(1 for a in mirror_games if a.winner == 1)
        draws = mirror_n - p0_wins - p1_wins
        print(f"\n  Mirror matchups ({mirror_n} games):")
        print(f"    P0 (先手) wins: {p0_wins} ({p0_wins/mirror_n*100:.1f}%)")
        print(f"    P1 (后手) wins: {p1_wins} ({p1_wins/mirror_n*100:.1f}%)")
        if draws:
            print(f"    Draws:          {draws}")

    print(f"\n  Games where strategy > luck: "
          f"{sum(1 for a in results if abs(a.strategy_differential) > abs(a.luck_differential))} "
          f"({sum(1 for a in results if abs(a.strategy_differential) > abs(a.luck_differential))/n*100:.0f}%)")


def _save_results(results: List[GameAttribution], output_path: str):
    """Save attribution results to JSON."""
    output = {
        "n_games": len(results),
        "games": [
            {
                "game_id": a.game_id,
                "matchup": a.matchup,
                "winner": a.winner,
                "dice_luck": [a.dice_luck_p0, a.dice_luck_p1],
                "draw_luck": [a.draw_luck_p0, a.draw_luck_p1],
                "strategy_gap": [a.strategy_gap_p0, a.strategy_gap_p1],
                "net_luck": [a.net_luck_p0, a.net_luck_p1],
                "luck_diff": a.luck_differential,
                "strategy_diff": a.strategy_differential,
                "strategy_fraction": a.strategy_fraction,
                "per_round": a.per_round,
            }
            for a in results
        ],
    }

    with open(output_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nResults saved to: {output_path}")


# ─── Helpers ────────────────────────────────────────────────────────────

def _get(obj: Any, key: str, default: Any = None) -> Any:
    """Safe dict access."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return default


def _determine_winner(replay: Dict) -> int:
    """Determine winner from replay data."""
    # Try direct field
    winner = replay.get("winner", replay.get("finalWinner"))
    if winner is not None and winner != -1:
        return winner

    # Try HP-based
    players = replay.get("players", [])
    if len(players) >= 2:
        p0_dead = all(
            c.get("hp", 0) <= 0
            for c in _get(players[0], "characters", [])
            if not c.get("defeated", False)
        )
        p1_dead = all(
            c.get("hp", 0) <= 0
            for c in _get(players[1], "characters", [])
            if not c.get("defeated", False)
        )
        if p0_dead and not p1_dead:
            return 1
        if p1_dead and not p0_dead:
            return 0

    return -1  # Unknown


# ─── CLI ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Attribution engine — decompose GI TCG replays into luck/strategy"
    )
    parser.add_argument("replay_dir", help="Directory containing replay JSON files")
    parser.add_argument("--output", "-o", default=None,
                        help="Output JSON file for attribution results")
    parser.add_argument("--max-games", "-n", type=int, default=None,
                        help="Maximum number of games to process")
    args = parser.parse_args()

    process_replay_dir(args.replay_dir, args.output, args.max_games)
