#!/usr/bin/env python3
"""
Reusable parser for render-game-log.ts Markdown output.
Parses per-game headers + per-ply action tables into structured data.

Usage as module:
    from parse_game_logs import parse_file, parse_directory, aggregate_stats

Usage as CLI:
    python parse_game_logs.py <dir> [--summary] [--per-deck] [--json] [--deck deck_name]
"""

import re, os, json, sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Optional, Union
from pathlib import Path


@dataclass
class PlyAction:
    ply: int
    round: int
    turn: int          # 0 or 1 (player side)
    side: int          # 0 or 1
    action_raw: str    # raw action string from MD
    action_type: str   # "skill", "burst", "passive", "switch", "play", "tune", "declareEnd"
    dice_cost: int     # dice spent
    energy_cost: int   # energy spent
    consumes_legend: bool
    changes_active: bool
    hp_delta_self: str
    hp_delta_opp: str
    mcts_top3: list[tuple[str, float, bool]]  # (action_desc, share%, is_chosen)

    @classmethod
    def parse_table_row(cls, row_cells: list[str]) -> Optional["PlyAction"]:
        """Parse a single | ply | R/T | side | action | dice/nrg | HP delta | top-3 | row."""
        if len(row_cells) < 7:
            return None
        try:
            ply = int(row_cells[0].strip())
        except ValueError:
            return None

        rt = row_cells[1].strip()
        m = re.match(r"R(\d+)T(\d)", rt)
        if not m:
            return None
        rnd = int(m.group(1))
        turn = int(m.group(2))

        side_str = row_cells[2].strip()
        side = 0 if side_str == "p0" else 1

        action_raw = row_cells[3].strip()

        # Parse dice/energy/legend/active-change cost
        cost_str = row_cells[4].strip()
        dice_cost = 0
        energy_cost = 0
        consumes_legend = False
        changes_active = False
        cost_parts = [p.strip() for p in cost_str.split("/")]
        if cost_parts and cost_parts[0].isdigit():
            dice_cost = int(cost_parts[0])
        if "↔" in cost_str:
            changes_active = True
        if "★" in cost_str:
            consumes_legend = True
        # Look for ⚡N energy cost
        em = re.search(r"⚡(\d+)", cost_str)
        if em:
            energy_cost = int(em.group(1))

        hp_delta_self = row_cells[5].strip()
        hp_delta_opp = row_cells[5].strip()

        delta_str = row_cells[5].strip()
        # Format: "self:ch0:-1 | opp:ch0:-2" or "no-hp-change" or "(end of trajectory)"
        self_d = "—"
        opp_d = "—"
        dm = re.match(r"self:(.*?)\s*\|\s*opp:(.*)", delta_str)
        if dm:
            self_d = dm.group(1).strip()
            opp_d = dm.group(2).strip()
        elif delta_str == "no-hp-change":
            self_d = "—"
            opp_d = "—"
        elif delta_str == "(end of trajectory)":
            pass

        mcts_str = row_cells[6].strip()

        # Parse MCTS top-3: "★1107(Cryo).skill=63%, switch→1605(Geo)=20%, declareEnd=11%"
        mcts_top3 = []
        if mcts_str != "—":
            for item in mcts_str.split(","):
                item = item.strip()
                is_chosen = item.startswith("★")
                clean = item.lstrip("★").strip()
                eq_idx = clean.rfind("=")
                if eq_idx >= 0:
                    desc = clean[:eq_idx].strip()
                    pct_str = clean[eq_idx+1:].strip().rstrip("%")
                    try:
                        pct = float(pct_str)
                    except ValueError:
                        pct = 0.0
                    mcts_top3.append((desc, pct, is_chosen))

        # Classify action type
        action_type = "other"
        if "declareEnd" in action_raw:
            action_type = "declareEnd"
        elif action_raw.startswith("switch→"):
            action_type = "switch"
        elif action_raw.startswith("play "):
            action_type = "play"
        elif action_raw.startswith("tune→"):
            action_type = "tune"
        elif ".burst" in action_raw:
            action_type = "burst"
        elif ".passive" in action_raw:
            action_type = "passive"
        elif ".skill" in action_raw:
            action_type = "skill"

        return cls(
            ply=ply,
            round=rnd,
            turn=turn,
            side=side,
            action_raw=action_raw,
            action_type=action_type,
            dice_cost=dice_cost,
            energy_cost=energy_cost,
            consumes_legend=consumes_legend,
            changes_active=changes_active,
            hp_delta_self=self_d,
            hp_delta_opp=opp_d,
            mcts_top3=mcts_top3,
        )


@dataclass
class GameLog:
    game_id: str
    matchup_tag: str
    rounds: int
    plies: int
    winner: str          # "p0", "p1", or "draw"
    first_mover: str     # "p0", "p1", or "unknown"
    p0_chars: list[str]  # ["1605(Geo)", "1309(Pyro)", "1602(Geo)"]
    p1_chars: list[str]
    actions: list[PlyAction] = field(default_factory=list)

    @property
    def p0_won(self) -> bool:
        return self.winner == "p0"

    @property
    def p1_won(self) -> bool:
        return self.winner == "p1"

    @property
    def is_draw(self) -> bool:
        return self.winner == "draw"

    @property
    def p0_deck(self) -> str:
        """Extract deck name from matchup tag."""
        parts = self.matchup_tag.split("-vs-")
        return parts[0] if parts else "unknown"

    @property
    def p1_deck(self) -> str:
        """Extract opponent deck name from matchup tag."""
        parts = self.matchup_tag.split("-vs-")
        if len(parts) >= 2:
            # Remove trailing -N from "deckname-N"
            return parts[1].split("-")[0]
        return "unknown"

    @property
    def matchup_pair(self) -> str:
        return f"{self.p0_deck}-vs-{self.p1_deck}"

    def actions_by_round(self, rnd: int) -> list[PlyAction]:
        return [a for a in self.actions if a.round == rnd]

    def actions_by_side(self, side: int) -> list[PlyAction]:
        return [a for a in self.actions if a.side == side]

    def actions_by_type(self, action_type: str) -> list[PlyAction]:
        return [a for a in self.actions if a.action_type == action_type]

    def count_chain_switches(self, side: Optional[int] = None) -> int:
        """Count consecutive switch actions by the same side."""
        actions = self.actions if side is None else [a for a in self.actions if a.side == side]
        count = 0
        for i in range(1, len(actions)):
            if actions[i].action_type == "switch" and actions[i - 1].action_type == "switch":
                if actions[i].side == actions[i - 1].side:
                    count += 1
        return count

    def count_loop_switches(self, side: Optional[int] = None) -> int:
        """Count 3-switch cycles returning to same character."""
        actions = self.actions if side is None else [a for a in self.actions if a.side == side]
        count = 0
        for i in range(2, len(actions)):
            a0, a1, a2 = actions[i - 2], actions[i - 1], actions[i]
            if a0.action_type == a1.action_type == a2.action_type == "switch":
                if a0.side == a1.side == a2.side:
                    # Check if we returned to the starting character
                    start_char = a0.action_raw.split("→")[0].strip() if "→" in a0.action_raw else ""
                    end_char = a2.action_raw.split("→")[-1].split("→")[0].strip() if "→" in a2.action_raw else ""
                    # Simple heuristic: 3 consecutive switches
                    count += 1
        return count


def parse_file(filepath: str) -> Optional[GameLog]:
    """Parse a single render-game-log.ts Markdown file."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    lines = content.strip().split("\n")

    game_id = ""
    matchup_tag = ""
    rounds = 0
    plies = 0
    winner = "draw"
    first_mover = "unknown"
    p0_chars = []
    p1_chars = []

    for line in lines:
        line = line.strip()
        if line.startswith("# Game "):
            game_id = re.search(r"`(.+?)`", line).group(1) if "`" in line else ""
        elif line.startswith("- matchup tag:"):
            m = re.search(r"`(.+?)`", line)
            if m:
                matchup_tag = m.group(1)
        elif line.startswith("- rounds played:"):
            try:
                rounds = int(re.search(r"(\d+)", line).group(1))
            except (ValueError, AttributeError):
                pass
        elif line.startswith("- decisions captured:"):
            try:
                plies = int(re.search(r"(\d+)", line).group(1))
            except (ValueError, AttributeError):
                pass
        elif line.startswith("- winner:"):
            if "p0" in line:
                winner = "p0"
            elif "p1" in line:
                winner = "p1"
            elif "draw" in line:
                winner = "draw"
        elif line.startswith("- first-mover:"):
            if "p0" in line:
                first_mover = "p0"
            elif "p1" in line:
                first_mover = "p1"
            else:
                first_mover = "unknown"
        elif line.startswith("- p0 chars:"):
            chars_str = line.split(":", 1)[1].strip()
            p0_chars = [c.strip() for c in chars_str.split(",") if c.strip()]
        elif line.startswith("- p1 chars:"):
            chars_str = line.split(":", 1)[1].strip()
            p1_chars = [c.strip() for c in chars_str.split(",") if c.strip()]

    # Parse the table
    actions = []
    in_table = False
    for line in lines:
        if line.startswith("| ply |"):
            in_table = True
            continue
        if not in_table:
            continue
        if not line.startswith("|"):
            continue
        cells = line.split("|")
        # Filter empty leading/trailing
        cells = [c for c in cells if c.strip()]
        if not cells or cells[0].strip() in ("ply", ":---:"):
            continue
        try:
            int(cells[0].strip())
        except (ValueError, IndexError):
            continue
        ply = PlyAction.parse_table_row(cells)
        if ply:
            actions.append(ply)

    if not game_id:
        return None

    return GameLog(
        game_id=game_id,
        matchup_tag=matchup_tag,
        rounds=rounds,
        plies=plies,
        winner=winner,
        first_mover=first_mover,
        p0_chars=p0_chars,
        p1_chars=p1_chars,
        actions=actions,
    )


def parse_directory(dirpath: str, file_pattern: str = "*.md") -> list[GameLog]:
    """Parse all matching Markdown files in a directory. Skips index.md."""
    logs = []
    dirpath = Path(dirpath)
    for fpath in sorted(dirpath.glob(file_pattern)):
        if fpath.name == "index.md":
            continue
        log = parse_file(str(fpath))
        if log:
            logs.append(log)
    return logs


# ── Aggregated statistics ──

@dataclass
class MatchupStats:
    matchup: str
    games: int
    wins_p0: int
    wins_p1: int
    draws: int
    avg_rounds: float
    avg_plies: float
    # Action breakdown
    skills_p0: int = 0
    switches_p0: int = 0
    plays_p0: int = 0
    tunes_p0: int = 0
    ends_p0: int = 0
    chain_sw_p0: int = 0
    loop_sw_p0: int = 0
    skills_p1: int = 0
    switches_p1: int = 0
    plays_p1: int = 0
    tunes_p1: int = 0
    ends_p1: int = 0
    chain_sw_p1: int = 0
    loop_sw_p1: int = 0
    dice_p0: int = 0
    dice_p1: int = 0

    @property
    def win_rate_p0(self) -> float:
        return self.wins_p0 / self.games if self.games > 0 else 0.0

    @property
    def switch_ratio_p0(self) -> float:
        total = self.skills_p0 + self.switches_p0
        return self.switches_p0 / total if total > 0 else 0.0

    @property
    def switch_ratio_p1(self) -> float:
        total = self.skills_p1 + self.switches_p1
        return self.switches_p1 / total if total > 0 else 0.0


def aggregate_stats(logs: list[GameLog]) -> dict:
    """Aggregate statistics across all game logs."""
    by_matchup: dict[str, MatchupStats] = {}
    by_deck: dict[str, dict] = {}

    for log in logs:
        pair = log.matchup_pair
        if pair not in by_matchup:
            by_matchup[pair] = MatchupStats(matchup=pair, games=0, wins_p0=0, wins_p1=0, draws=0, avg_rounds=0.0, avg_plies=0.0)

        ms = by_matchup[pair]
        ms.games += 1
        ms.avg_rounds += log.rounds
        ms.avg_plies += log.plies
        if log.p0_won:
            ms.wins_p0 += 1
        elif log.p1_won:
            ms.wins_p1 += 1
        else:
            ms.draws += 1

        for a in log.actions:
            if a.side == 0:
                if a.action_type in ("skill", "burst", "passive"):
                    ms.skills_p0 += 1
                elif a.action_type == "switch":
                    ms.switches_p0 += 1
                elif a.action_type == "play":
                    ms.plays_p0 += 1
                elif a.action_type == "tune":
                    ms.tunes_p0 += 1
                elif a.action_type == "declareEnd":
                    ms.ends_p0 += 1
                ms.dice_p0 += a.dice_cost
            else:
                if a.action_type in ("skill", "burst", "passive"):
                    ms.skills_p1 += 1
                elif a.action_type == "switch":
                    ms.switches_p1 += 1
                elif a.action_type == "play":
                    ms.plays_p1 += 1
                elif a.action_type == "tune":
                    ms.tunes_p1 += 1
                elif a.action_type == "declareEnd":
                    ms.ends_p1 += 1
                ms.dice_p1 += a.dice_cost

        ms.chain_sw_p0 += log.count_chain_switches(0)
        ms.loop_sw_p0 += log.count_loop_switches(0)
        ms.chain_sw_p1 += log.count_chain_switches(1)
        ms.loop_sw_p1 += log.count_loop_switches(1)

    # Finalize averages
    for ms in by_matchup.values():
        if ms.games > 0:
            ms.avg_rounds /= ms.games
            ms.avg_plies /= ms.games

    return {
        "total_games": len(logs),
        "by_matchup": {k: asdict(v) for k, v in by_matchup.items()},
    }


def print_summary(logs: list[GameLog]):
    """Print human-readable summary."""
    stats = aggregate_stats(logs)
    print(f"\n{'='*80}")
    print(f"  Game Log Analysis Summary — {stats['total_games']} games")
    print(f"{'='*80}")

    # Overall win rates
    wins_p0 = sum(1 for log in logs if log.p0_won)
    wins_p1 = sum(1 for log in logs if log.p1_won)
    draws = sum(1 for log in logs if log.is_draw)
    print(f"  Overall: P0 wins={wins_p0} ({wins_p0/len(logs)*100:.1f}%)  "
          f"P1 wins={wins_p1} ({wins_p1/len(logs)*100:.1f}%)  "
          f"Draws={draws}")

    # Per-deck win rates (as P0)
    deck_wins: dict[str, tuple[int, int, int]] = {}
    for log in logs:
        d = log.p0_deck
        if d not in deck_wins:
            deck_wins[d] = (0, 0, 0)
        w, l, d2 = deck_wins[d]
        deck_wins[d] = (w + (1 if log.p0_won else 0), l + (1 if log.p1_won else 0), d2 + (1 if log.is_draw else 0))

    print(f"\n  Per-deck P0 performance:")
    print(f"  {'Deck':<20} {'W':>4} {'L':>4} {'D':>4} {'Win%':>7} {'Games':>6} {'Avg Rnds':>8}")
    print(f"  {'-'*20} {'-'*4} {'-'*4} {'-'*4} {'-'*7} {'-'*6} {'-'*8}")
    for deck in sorted(deck_wins.keys()):
        w, l, d = deck_wins[deck]
        total = w + l + d
        wr = w / total * 100 if total > 0 else 0
        deck_logs = [log for log in logs if log.p0_deck == deck]
        avg_rnds = sum(log.rounds for log in deck_logs) / len(deck_logs) if deck_logs else 0
        print(f"  {deck:<20} {w:>4} {l:>4} {d:>4} {wr:>6.1f}% {total:>6} {avg_rnds:>8.1f}")

    # Per-matchup details
    print(f"\n  Matchup Details:")
    print(f"  {'Matchup':<48} {'W':>4} {'L':>4} {'D':>4} {'WR%':>6} {'Sw%P0':>7} {'ChSw':>5} {'Loop':>5}")
    print(f"  {'-'*48} {'-'*4} {'-'*4} {'-'*4} {'-'*6} {'-'*7} {'-'*5} {'-'*5}")
    for k, ms in sorted(stats["by_matchup"].items()):
        g = ms["games"]
        wr = ms["wins_p0"] / g * 100 if g > 0 else 0
        total_skill_sw = max(ms["skills_p0"] + ms["switches_p0"], 1)
        sw_pct = ms["switches_p0"] / total_skill_sw * 100
        print(f"  {k:<48} {ms['wins_p0']:>4} {ms['wins_p1']:>4} {ms['draws']:>4} "
              f"{wr:>5.1f}% {sw_pct:>6.1f}% {ms['chain_sw_p0']:>5} {ms['loop_sw_p0']:>5}")


def print_per_matchup(logs: list[GameLog], deck_filter: Optional[str] = None):
    """Print detailed per-matchup breakdown."""
    stats = aggregate_stats(logs)
    print(f"\n{'='*80}")
    if deck_filter:
        print(f"  Matchup Breakdown for deck: {deck_filter}")
    else:
        print(f"  Full Matchup Breakdown")
    print(f"{'='*80}")

    for k, ms in sorted(stats["by_matchup"].items()):
        if deck_filter and not k.startswith(f"{deck_filter}-vs-"):
            continue
        g = ms["games"]
        wr = ms["wins_p0"] / g * 100 if g > 0 else 0
        print(f"\n  {k} ({ms['games']} games, WR={wr:.1f}%, avg {ms['avg_rounds']:.1f} rounds)")
        print(f"  P0: skills={ms['skills_p0']} switches={ms['switches_p0']} plays={ms['plays_p0']} "
              f"tunes={ms['tunes_p0']} ends={ms['ends_p0']} dice={ms['dice_p0']}")
        print(f"  P1: skills={ms['skills_p1']} switches={ms['switches_p1']} plays={ms['plays_p1']} "
              f"tunes={ms['tunes_p1']} ends={ms['ends_p1']} dice={ms['dice_p1']}")
        print(f"  Chain-switches: P0={ms['chain_sw_p0']} P1={ms['chain_sw_p1']}  "
              f"Loop-switches: P0={ms['loop_sw_p0']} P1={ms['loop_sw_p1']}")


# ── CLI ──

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python parse_game_logs.py <dir> [--summary] [--per-matchup] [--json] [--deck deck_name]")
        print("  --summary     Print aggregate summary")
        print("  --per-matchup Print per-matchup breakdown")
        print("  --json        Output JSON statistics")
        print("  --deck NAME   Filter to specific deck as P0")
        sys.exit(1)

    dirpath = sys.argv[1]
    logs = parse_directory(dirpath)

    if not logs:
        print(f"No game logs found in {dirpath}", file=sys.stderr)
        sys.exit(1)

    if "--summary" in sys.argv:
        print_summary(logs)
    elif "--per-matchup" in sys.argv:
        deck_filter = None
        if "--deck" in sys.argv:
            idx = sys.argv.index("--deck")
            if idx + 1 < len(sys.argv):
                deck_filter = sys.argv[idx + 1]
        print_per_matchup(logs, deck_filter)
    elif "--json" in sys.argv:
        stats = aggregate_stats(logs)
        print(json.dumps(stats, indent=2, ensure_ascii=False))
    else:
        print_summary(logs)
