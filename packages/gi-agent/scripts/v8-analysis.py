#!/usr/bin/env python3
"""
V8 MCTS Benchmark Analysis
- Cross-deck win rate aggregation
- Game log sampling (worst matchups and best matchups)
- Action-level analysis: skills/plays/switches per deck
- Mistake pattern detection (loop switches, card overplay, R1 passivity)
"""
import json, sys, os, re
from pathlib import Path
from collections import defaultdict

BENCHMARK_DIR = Path("output/benchmark-logs")
CHAR_IDS = {
    1104: "重云", 1105: "神里绫华", 1106: "优菈", 1107: "申鹤",
    1201: "芭芭拉", 1203: "莫娜", 1205: "珊瑚宫心海",
    1305: "宵宫", 1309: "迪希雅",
    1401: "菲谢尔", 1407: "雷电将军", 1408: "八重神子",
    1506: "流浪者",
    1601: "凝光", 1602: "诺艾尔", 1605: "荒泷一斗",
    2201: "纯水精灵·洛蒂娅", 2301: "火之债务处理人",
}
DICE_NAMES = {0:"无", 1:"冰", 2:"水", 3:"火", 4:"雷", 5:"风", 6:"岩", 7:"草", 8:"万能"}

# ─── Card ID → Name mapping (from data source) ───
# To be filled by scanning packages/data/src/
CARD_NAMES = {}

def deref(store, v):
    if isinstance(v, dict) and "$" in v:
        return store[v["$"]]
    return v

def load_card_names():
    """Scan data source files for card id → name mapping"""
    data_root = Path("../../data/src")
    if not data_root.exists():
        data_root = Path("packages/data/src")
    if not data_root.exists():
        return
    card_dirs = [
        data_root / "cards" / "equipment",
        data_root / "cards" / "event",
        data_root / "cards" / "support",
    ]
    import subprocess
    for d in card_dirs:
        if not d.exists():
            continue
        for f in d.glob("*.ts"):
            try:
                content = f.read_text()
                # Find card(id, ...) → name mappings
                for m in re.finditer(r'card\((\d+)\).*?[\n\r]\s*\.name\("([^"]+)"\)', content, re.DOTALL):
                    CARD_NAMES[int(m.group(1))] = m.group(2)
            except:
                pass
    # Character talent cards
    char_dirs = list((data_root / "characters").glob("*/*.ts"))
    for f in char_dirs:
        try:
            content = f.read_text()
            for m in re.finditer(r'card\((\d+)\).*?[\n\r]\s*\.name\("([^"]+)"\)', content, re.DOTALL):
                CARD_NAMES[int(m.group(1))] = m.group(2)
        except:
            pass

def extract_actions(replay_path):
    """Extract P0 (MCTS) actions from a replay file"""
    try:
        with open(replay_path) as f:
            data = json.load(f)
    except:
        return None

    store = data.get("store", [])
    log = data.get("log", [])

    actions = []
    prev_state = None
    for entry in log:
        s = deref(store, entry.get("s", {}))
        if not isinstance(s, dict):
            continue
        if s.get("phase") != "action":
            continue
        if s.get("currentTurn") != 0:  # Only P0 actions
            continue

        players = deref(store, s.get("players"))
        if not isinstance(players, list) or len(players) < 2:
            continue

        p0 = deref(store, players[0])
        p1 = deref(store, players[1])
        if not isinstance(p0, dict) or not isinstance(p1, dict):
            continue

        # Extract current state
        dice = deref(store, p0.get("dice"))
        if isinstance(dice, list):
            dice_count = len(dice)
        else:
            dice_count = 0

        hands = deref(store, p0.get("hands"))
        if isinstance(hands, list):
            hand_ids = set()
            for h in hands:
                hh = deref(store, h)
                if isinstance(hh, dict):
                    hdef = deref(store, hh.get("definition"))
                    if isinstance(hdef, dict):
                        hand_ids.add(hdef.get("id", 0))
            hand_count = len(hand_ids)
        else:
            hand_ids = set()

        active = p0.get("activeCharacterId")

        # Opponent active char HP
        opp_active = p1.get("activeCharacterId")
        opp_chars = deref(store, p1.get("characters"))
        opp_hp = None
        if isinstance(opp_chars, list):
            for c_ref in opp_chars:
                c = deref(store, c_ref)
                if isinstance(c, dict) and c.get("id") == opp_active:
                    vars_ = deref(store, c.get("variables"))
                    if isinstance(vars_, dict):
                        opp_hp = vars_.get("health", 0)
                    break

        state = {
            "round": s.get("roundNumber", 0),
            "dice": dice_count,
            "hands": hand_count,
            "active": active,
            "opp_hp": opp_hp,
            "winner": s.get("winner"),
        }

        if prev_state:
            # Detect action type
            dice_delta = prev_state["dice"] - dice_count
            active_changed = active != prev_state["active"] and active is not None

            if dice_delta == 0 and not active_changed:
                prev_state = state
                continue  # No player action

            action_type = "UNKNOWN"
            if active_changed and dice_delta == 0:
                action_type = "FAST_SWITCH"
            elif active_changed and dice_delta >= 1:
                action_type = "SWITCH"
            elif dice_delta >= 3 and not active_changed:
                action_type = "SKILL"
            elif dice_delta >= 1 and not active_changed:
                action_type = "PLAY"
            elif dice_delta == 0:
                action_type = "DECLARE_END" if dice_count == 8 else "OTHER"

            # Detect card ID played
            card_id = None
            if action_type == "PLAY":
                prev_hand_ids = prev_state.get("hand_ids", set())
                removed = prev_hand_ids - hand_ids
                if len(removed) == 1:
                    card_id = removed.pop()

            actions.append({
                "round": state["round"],
                "type": action_type,
                "dice_cost": dice_delta,
                "card_id": card_id,
                "active": active,
                "prev_active": prev_state["active"],
                "opp_hp": opp_hp,
            })

        prev_state = {**state, "hand_ids": hand_ids.copy()}

    return actions

def classify_actions(actions):
    """Classify and count actions"""
    stats = {"skills": 0, "plays": 0, "switches": 0, "fast_switches": 0,
             "loops": 0, "chains": 0, "other": 0, "total": 0}
    cards_played = []
    rounds = defaultdict(lambda: {"skills": 0, "plays": 0, "switches": 0})

    for i, a in enumerate(actions):
        stats["total"] += 1
        r = a["round"]
        if a["type"] == "SKILL":
            stats["skills"] += 1
            rounds[r]["skills"] += 1
        elif a["type"] == "PLAY":
            stats["plays"] += 1
            rounds[r]["plays"] += 1
            if a["card_id"]:
                cards_played.append(a["card_id"])
        elif a["type"] == "SWITCH":
            stats["switches"] += 1
            rounds[r]["switches"] += 1
        elif a["type"] == "FAST_SWITCH":
            stats["fast_switches"] += 1
            rounds[r]["switches"] += 1
        else:
            stats["other"] += 1

    # Detect loops (A→B→A within same turn)
    turn_switches = []
    for a in actions:
        if a["type"] in ("SWITCH", "FAST_SWITCH"):
            turn_switches.append(a)
        if a["type"] not in ("SWITCH", "FAST_SWITCH") or a != actions[-1]:
            if len(turn_switches) >= 2:
                # Check for A→B→A loop
                for j in range(len(turn_switches) - 1):
                    if turn_switches[j]["prev_active"] == turn_switches[j+1]["active"]:
                        stats["loops"] += 1
                        break
            if len(turn_switches) >= 3:
                stats["chains"] += 1
            turn_switches = []

    return stats, rounds, cards_played

def analyze():
    load_card_names()

    # Find all benchmark log directories
    log_dirs = list(BENCHMARK_DIR.glob("*v8*"))
    if not log_dirs:
        print("ERROR: No v8 benchmark log directories found!")
        print(f"Contents of {BENCHMARK_DIR}:")
        for d in sorted(BENCHMARK_DIR.iterdir()):
            print(f"  {d.name}")
        return

    print(f"Found {len(log_dirs)} v8 matchup directories\n")

    # Per-deck aggregation
    deck_stats = defaultdict(lambda: {
        "wins": 0, "losses": 0, "draws": 0,
        "games": [],
    })

    all_games = []

    for log_dir in sorted(log_dirs):
        matchup_id = log_dir.name
        # Extract deck name from directory name
        # Format: DeckName-v5-vs-Opponent  (P0=DeckName)
        parts = matchup_id.split("-vs-")
        if len(parts) != 2:
            continue
        deck_name = parts[0]

        games = list(log_dir.glob("game-*.json"))
        for g in sorted(games):
            gname = g.name
            # game-NNNN-p0.json = P0 won, game-NNNN-p1.json = P1 won
            if gname.endswith("-p0.json"):
                result = "win"
            elif gname.endswith("-p1.json"):
                result = "loss"
            elif "draw" in gname:
                result = "draw"
            else:
                continue

            actions = extract_actions(str(g))
            if actions is None:
                continue

            stats, rounds, cards = classify_actions(actions)

            game_info = {
                "matchup": matchup_id,
                "deck": deck_name,
                "game": gname.replace(".json", ""),
                "result": result,
                "actions": actions,
                "stats": stats,
                "rounds": rounds,
                "cards": cards,
            }
            all_games.append(game_info)

            if result == "win":
                deck_stats[deck_name]["wins"] += 1
            elif result == "loss":
                deck_stats[deck_name]["losses"] += 1
            else:
                deck_stats[deck_name]["draws"] += 1

            deck_stats[deck_name]["games"].append(game_info)

    # ─── Per-Deck Summary ───
    print("=" * 70)
    print("PER-DECK WIN RATES (MCTS-heuristic-v8)")
    print("=" * 70)
    print(f"{'Deck':<12} {'W':>3} {'L':>3} {'D':>3} {'Win%':>6} {'Skill':>6} {'Play':>5} {'Switch':>7} {'Loop':>5}")
    print("-" * 70)

    for deck in sorted(deck_stats.keys()):
        ds = deck_stats[deck]
        total = ds["wins"] + ds["losses"] + ds["draws"]
        wr = ds["wins"] / total * 100 if total > 0 else 0

        # Aggregate action stats
        total_skills = sum(g["stats"]["skills"] for g in ds["games"])
        total_plays = sum(g["stats"]["plays"] for g in ds["games"])
        total_switches = sum(g["stats"]["switches"] for g in ds["games"])
        total_loops = sum(g["stats"]["loops"] for g in ds["games"])
        n_games = len(ds["games"])
        avg_skills = total_skills / n_games if n_games > 0 else 0
        avg_plays = total_plays / n_games if n_games > 0 else 0
        avg_switches = total_switches / n_games if n_games > 0 else 0
        avg_loops = total_loops / n_games if n_games > 0 else 0

        marker = "🔴" if wr < 40 else ("🟡" if wr < 50 else "🟢")
        print(f"{marker} {deck:<10} {ds['wins']:>3} {ds['losses']:>3} {ds['draws']:>3} {wr:>5.1f}% {avg_skills:>5.1f} {avg_plays:>5.1f} {avg_switches:>6.1f} {avg_loops:>4.1f}")

    # ─── Aggregate WR ───
    total_w = sum(d["wins"] for d in deck_stats.values())
    total_l = sum(d["losses"] for d in deck_stats.values())
    total_d = sum(d["draws"] for d in deck_stats.values())
    total_g = total_w + total_l + total_d
    print("-" * 70)
    print(f"{'OVERALL':<12} {total_w:>3} {total_l:>3} {total_d:>3} {total_w/total_g*100:>5.1f}%  ({total_g} games)")
    print()

    # ─── Worst Matchups ───
    print("=" * 70)
    print("WORST MATCHUPS (MCTS win rate ≤ 20%)")
    print("=" * 70)
    matchup_results = defaultdict(lambda: {"w": 0, "l": 0, "d": 0})
    for g in all_games:
        m = g["matchup"]
        if g["result"] == "win":
            matchup_results[m]["w"] += 1
        elif g["result"] == "loss":
            matchup_results[m]["l"] += 1
        else:
            matchup_results[m]["d"] += 1

    for m, r in sorted(matchup_results.items(), key=lambda x: x[1]["w"]/(x[1]["w"]+x[1]["l"]+x[1]["d"]) if sum(x[1].values()) > 0 else 0):
        total = r["w"] + r["l"] + r["d"]
        wr = r["w"] / total * 100 if total > 0 else 0
        if wr <= 20:
            print(f"  {m}: {r['w']}-{r['l']}-{r['d']} ({wr:.1f}%)")

    # ─── Sample Analysis: Worst Loss Games ───
    print()
    print("=" * 70)
    print("SAMPLED GAME LOGS — Worst Losses (up to 5)")
    print("=" * 70)

    loss_games = [g for g in all_games if g["result"] == "loss"]
    loss_games.sort(key=lambda g: len([a for a in g["actions"] if a["type"] in ("SWITCH", "FAST_SWITCH")]), reverse=True)

    for g in loss_games[:5]:
        actions = g["actions"]
        stats = g["stats"]
        print(f"\n--- {g['deck']} vs {g['matchup'].split('-vs-')[1]} ({g['game']}) ---")
        print(f"  Skills: {stats['skills']}  Plays: {stats['plays']}  Switches: {stats['switches']}  Loops: {stats['loops']}")

        # Print R1 actions
        print(f"  R1 actions:")
        for a in actions:
            if a["round"] != 1:
                break
            card_name = ""
            if a["card_id"]:
                card_name = CARD_NAMES.get(a["card_id"], f"card#{a['card_id']}")
                if not card_name:
                    card_name = f"card#{a['card_id']}"
            print(f"    [{a['type']}] dice={a['dice_cost']} {card_name}")

        # Print full action sequence (compact)
        print(f"  Full seq: ", end="")
        seq = []
        for a in actions:
            s = a["type"][:1]
            if a["card_id"] and a["type"] == "PLAY":
                cn = CARD_NAMES.get(a["card_id"], f"#{a['card_id']}")
                s = f"P({cn[:12]})"
            seq.append(s)
        print(" → ".join(seq))

    # ─── R1 Analysis ───
    print()
    print("=" * 70)
    print("R1 OPENER ANALYSIS")
    print("=" * 70)
    print(f"{'Deck':<12} {'R1 Skill':>8} {'R1 Play':>8} {'R1 Switch':>10} {'TooPassive':>10}")
    print("-" * 70)

    for deck in sorted(deck_stats.keys()):
        ds = deck_stats[deck]
        r1_skills = []
        r1_plays = []
        r1_switches = []
        passive_count = 0

        for g in ds["games"]:
            rounds = g["rounds"]
            r1 = rounds.get(1, {"skills": 0, "plays": 0, "switches": 0})
            r1_skills.append(r1["skills"])
            r1_plays.append(r1["plays"])
            r1_switches.append(r1["switches"])
            if r1["skills"] < 2:
                passive_count += 1

        avg_s = sum(r1_skills)/len(r1_skills) if r1_skills else 0
        avg_p = sum(r1_plays)/len(r1_plays) if r1_plays else 0
        avg_sw = sum(r1_switches)/len(r1_switches) if r1_switches else 0

        print(f"{deck:<12} {avg_s:>8.1f} {avg_p:>8.1f} {avg_sw:>10.1f} {passive_count:>5}/{len(r1_skills):<4}")

    # ─── Opponent Kill Windows ───
    print()
    print("=" * 70)
    print("MISSED KILL WINDOWS (opp_hp ≤ 3, played card instead of skill)")
    print("=" * 70)
    missed = 0
    for g in all_games:
        if g["result"] != "loss":
            continue
        for a in g["actions"]:
            if a["type"] == "PLAY" and a["opp_hp"] is not None and a["opp_hp"] <= 3:
                card_name = CARD_NAMES.get(a["card_id"], f"card#{a['card_id']}") if a["card_id"] else "?"
                print(f"  {g['deck']} {g['game']} R{a['round']}: played {card_name} with opp_hp={a['opp_hp']}")
                missed += 1
    if missed == 0:
        print("  (none detected)")

    print()

if __name__ == "__main__":
    os.chdir(Path(__file__).parent.parent)  # cd to packages/gi-agent
    analyze()
