"""
Adapter for compact game-state replays → attribution engine format.

Replay structure (v0.19.1+):
  { v, store: [...], log: [{s:{$:int}, e:[], r:bool}], gv }
  
  - store: list of state snapshots with internal {$:int} references
  - log entries reference store indices via s.$
  - State graph must be recursively resolved
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def resolve_store(store: list) -> callable:
    """Return a resolver function closed over the store."""
    def _resolve(obj, depth=0):
        if depth > 50:
            return obj
        if isinstance(obj, dict) and "$" in obj and len(obj) == 1:
            idx = obj["$"]
            if isinstance(idx, int) and 0 <= idx < len(store):
                return _resolve(store[idx], depth + 1)
            return obj
        elif isinstance(obj, dict):
            return {k: _resolve(v, depth) for k, v in obj.items()
                    if not (k == "$" and len(obj) == 1)}
        elif isinstance(obj, list):
            return [_resolve(v, depth) for v in obj]
        else:
            return obj
    return _resolve


def parse_replay(path: str) -> Dict:
    """Parse a compact replay file into engine-consumable format."""
    with open(path) as f:
        raw = json.load(f)

    store = raw.get("store", [])
    log = raw.get("log", [])

    if not isinstance(store, list) or not isinstance(log, list):
        raise ValueError(f"Bad replay format: store={type(store)}, log={type(log)}")

    resolve = resolve_store(store)

    # Extract winner from final states
    winner = _find_winner(log, store, resolve)

    # Extract matchup from character IDs
    matchup = _find_matchup(log, store, resolve)

    # Extract decision points
    decisions = _extract_decisions(log, store, resolve)

    return {
        "matchup": matchup,
        "matchupId": matchup,
        "winner": winner,
        "decisions": decisions,
    }


def _find_winner(log: List[Dict], store: list, resolve) -> int:
    """Find winner from game log, scanning backwards."""
    for entry in reversed(log):
        sid = entry.get("s", {}).get("$")
        if sid is None or not (0 <= sid < len(store)):
            continue
        state = resolve(store[sid])
        w = state.get("winner")
        if w in (0, 1):
            return w
        if state.get("phase") == "gameEnd":
            return state.get("winner", -1)
    return -1


def _find_matchup(log: List[Dict], store: list, resolve) -> str:
    """Extract deck matchup from character definition IDs."""
    if not log:
        return "unknown"
    sid = log[0].get("s", {}).get("$")
    if sid is None or not (0 <= sid < len(store)):
        return "unknown"

    state = resolve(store[sid])
    players = state.get("players", [])

    names = []
    for p in players[:2]:
        chars = p.get("characters", [])
        cids = []
        for c in chars:
            cid = c.get("definition", {}).get("id", "?")
            cids.append(str(cid))
        names.append("+".join(cids))

    return " vs ".join(names) if len(names) == 2 else "unknown"


def _extract_decisions(log: List[Dict], store: list, resolve) -> List[Dict]:
    """Extract action-phase decision points from the log."""
    decisions = []

    for i, entry in enumerate(log):
        if not isinstance(entry, dict) or not entry.get("r"):
            continue

        sid = entry.get("s", {}).get("$")
        if sid is None or not (0 <= sid < len(store)):
            continue

        state = resolve(store[sid])

        # Only action phase (exclude initHands, initActives, roll, gameEnd)
        if state.get("phase") != "action":
            continue

        current_turn = state.get("currentTurn", 0)
        round_num = state.get("roundNumber", 0)

        # Action taken from next log entry's events
        action_taken = {"type": "unknown"}
        if i + 1 < len(log):
            events = log[i + 1].get("e", [])
            if events:
                action_taken = _parse_action(events)

        simple_state = _simplify_state(state)

        decisions.append({
            "round": round_num,
            "player": current_turn,
            "action": action_taken,
            "state": simple_state,
        })

    return decisions


def _parse_action(events: List[Dict]) -> Dict:
    """Parse action type from mutation events."""
    for e in events:
        if not isinstance(e, dict):
            continue
        et = e.get("type", "")

        if et == "useSkill":
            skill = e.get("skill", {})
            sid = skill.get("definition", {}).get("id", skill.get("id", "?"))
            return {"type": "useSkill", "skill": str(sid)}

        if et == "switchActive":
            return {"type": "switchActive"}

        if et in ("playCard", "playCardToTarget"):
            card = e.get("card", {})
            cid = card.get("definition", {}).get("id", card.get("id", "?"))
            return {"type": "playCard", "card": str(cid)}

        if et == "declareEnd":
            return {"type": "declareEnd"}

        if et == "elementalTuning":
            return {"type": "elementalTuning"}

    return {"type": "unknown"}


def _simplify_state(state: Dict) -> Dict:
    """Extract scoring-relevant fields from resolved state."""
    players = state.get("players", [])

    simple_players = []
    for p in players:
        sp = {
            "characters": [],
            "n_combat_statuses": len(p.get("combatStatuses", [])),
            "n_summons": len(p.get("summons", [])),
            "n_supports": len(p.get("supports", [])),
            "dice": p.get("dice", []),
            "declared_end": p.get("declaredEnd", False),
        }

        for c in p.get("characters", []):
            vars_ = c.get("variables", {})
            sc = {
                "health": vars_.get("health", 0),
                "max_health": vars_.get("maxHealth", 0),
                "energy": vars_.get("energy", 0),
                "max_energy": vars_.get("maxEnergy", 0),
                "alive": vars_.get("alive", 0),
                "aura": vars_.get("aura", 0),
                "def_id": c.get("definition", {}).get("id", "?"),
            }
            # Shield from entities (equipment)
            shield = 0
            for ent in c.get("entities", []):
                svars = ent.get("variables", {})
                shield += svars.get("shield", 0)
            sc["shield"] = shield
            sp["characters"].append(sc)

        simple_players.append(sp)

    return {
        "players": simple_players,
        "roundNumber": state.get("roundNumber", 0),
        "currentTurn": state.get("currentTurn", 0),
    }


# ─── CLI test ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    from collections import Counter

    p = argparse.ArgumentParser()
    p.add_argument("replay", nargs="?", default=None)
    args = p.parse_args()

    path = args.replay or (
        "/mnt/d/AI/GTCG/genius-invokation/packages/gi-agent/output/"
        "benchmark-logs/mcts-smoke/game-0001-p0.json"
    )

    result = parse_replay(path)
    print(f"Matchup: {result['matchup']}")
    print(f"Winner:  player {result['winner']}")
    print(f"Decisions: {len(result['decisions'])}")
    print()

    round_counts = Counter(d["round"] for d in result["decisions"])
    action_counts = Counter(d["action"]["type"] for d in result["decisions"])

    for r in sorted(round_counts):
        print(f"  Round {r}: {round_counts[r]} decisions")
    print(f"\n  Actions: {dict(action_counts)}")

    # Show HP progression
    print("\n  HP progression (selected points):")
    step = max(1, len(result["decisions"]) // 8)
    for d in result["decisions"][::step]:
        p0 = d["state"]["players"][0]
        p1 = d["state"]["players"][1]
        hp0 = sum(c["health"] + c["shield"] for c in p0["characters"])
        hp1 = sum(c["health"] + c["shield"] for c in p1["characters"])
        print(f"    R{d['round']} P{d['player']}: HP {hp0} vs {hp1} | {d['action']['type']}")
