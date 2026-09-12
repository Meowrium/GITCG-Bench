#!/usr/bin/env python3
"""GI-TCG replay log parser — extracts per-turn player actions with switch-loop detection.

Usage:
    python3 scripts/parse_replay.py <game-NNNN.json> [--summary] [--max-rounds N]

Output modes:
    --summary : Per-side aggregate stats (skills, switches, plays, dice, chain_switches, loop_switches)
    default   : Turn-by-turn action log
"""

import json, os, re, sys

def build_name_map(data_dir):
    names = {}
    for root, dirs, files in os.walk(os.path.join(data_dir, "characters")):
        for fname in files:
            if not fname.endswith(".ts"): continue
            content = open(os.path.join(root, fname)).read()
            for m in re.finditer(r'\*\s*@id\s+(\d+)\s*\n\s*\*\s*@name\s+([^\n]+)', content):
                names[int(m.group(1))] = m.group(2).strip()
    for root, dirs, files in os.walk(os.path.join(data_dir, "cards")):
        for fname in files:
            if not fname.endswith(".ts"): continue
            content = open(os.path.join(root, fname)).read()
            for m in re.finditer(r'\*\s*@id\s+(\d+)\s*\n\s*\*\s*@name\s+([^\n]+)', content):
                names[int(m.group(1))] = m.group(2).strip()
    return names

def deref(store, v):
    if isinstance(v, dict) and "$" in v:
        return store[v["$"]]
    return v

def get_player_state(store, pd):
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
    return {
        "hand_ids": hand_ids,
        "dice_count": dice_count,
        "active_id": pd.get("activeCharacterId", 0),
    }

def get_char_info(store, pd, CARD):
    chars = deref(store, pd.get("characters"))
    active_id = pd.get("activeCharacterId", 0)
    result = []
    if isinstance(chars, list):
        for c in chars:
            cd = deref(store, c)
            if not isinstance(cd, dict): continue
            defn = deref(store, cd.get("definition"))
            v = deref(store, cd.get("variables"))
            cid = defn.get("id", 0) if isinstance(defn, dict) else 0
            result.append({
                "id": cid,
                "name": CARD.get(cid, f"#{cid}"),
                "hp": v.get("health", 0) if isinstance(v, dict) else 0,
                "energy": v.get("energy", 0) if isinstance(v, dict) else 0,
                "alive": v.get("alive", 1) == 1 if isinstance(v, dict) else True,
                "active": (cd.get("id") == active_id),
            })
    return result

def analyze_turn(states):
    actions = []
    prev = None
    prev_action = None
    switch_history = []

    for st in states:
        if prev is None:
            prev = st; continue

        dl = prev["dice_count"] - st["dice_count"]
        hl = set(prev["hand_ids"]) - set(st["hand_ids"])
        hg = set(st["hand_ids"]) - set(prev["hand_ids"])
        ac = st["active_id"] != prev["active_id"]

        if dl > 0:
            if ac:
                tag = "SWITCH"
                if prev_action == "switch":
                    tag = "CHAIN_SWITCH"
                switch_history.append(st["active_id"])
                if len(switch_history) >= 3 and switch_history[-1] == switch_history[-3]:
                    tag = "LOOP_SWITCH"
                actions.append(f"{tag}: {prev['active_id']}→{st['active_id']} (-{dl}骰)")
                prev_action = "switch"
            elif hl:
                actions.append(f"PLAY: {len(hl)} cards (-{dl}骰)")
                prev_action = "play"
            else:
                actions.append(f"SKILL: (-{dl}骰)")
                prev_action = "skill"
            switch_history = switch_history[-3:]
        elif hg and not hl:
            actions.append(f"DRAW: +{len(hg)} cards")
        elif ac and not dl:
            actions.append(f"FAST_SWITCH: {prev['active_id']}→{st['active_id']}")
            prev_action = "switch"
        else:
            prev_action = "other"
        prev = st

    return actions

def parse_replay(path, DATA_DIR):
    CARD = build_name_map(DATA_DIR)

    with open(path) as f:
        replay = json.load(f)
    store = replay["store"]
    log = replay["log"]

    turn_states = {}
    for entry in log:
        s = deref(store, entry["s"])
        if not isinstance(s, dict) or s.get("phase") != "action":
            continue
        rnd = s["roundNumber"]
        turn = s["currentTurn"]
        key = (rnd, turn)
        players = deref(store, s.get("players"))
        if not isinstance(players, list) or len(players) < 2:
            continue
        p = deref(store, players[turn])
        if key not in turn_states:
            turn_states[key] = []
        turn_states[key].append(get_player_state(store, p))

    results = []
    stats = {0: {"skills":0,"switches":0,"plays":0,"other":0,"dice":0},
             1: {"skills":0,"switches":0,"plays":0,"other":0,"dice":0}}

    for (rnd, turn) in sorted(turn_states.keys()):
        states = turn_states[(rnd, turn)]
        if len(states) < 2:
            continue

        actions = analyze_turn(states)
        if not actions:
            continue

        first = None
        for entry in log:
            s = deref(store, entry["s"])
            if isinstance(s, dict) and s.get("phase") == "action" and s["roundNumber"] == rnd and s["currentTurn"] == turn:
                players = deref(store, s.get("players"))
                p = deref(store, players[turn])
                opp = deref(store, players[1 - turn])
                first = (p, opp)
                break

        if first:
            p, opp = first
            chars = get_char_info(store, p, CARD)
            opp_front = CARD.get(opp.get("activeCharacterId", 0), "?")
        else:
            chars = []
            opp_front = "?"

        results.append({
            "rnd": rnd, "turn": turn,
            "chars": chars, "opp_front": opp_front,
            "actions": actions,
        })

        for a in actions:
            if a.startswith("SKILL:"): stats[turn]["skills"] += 1
            elif a.startswith("SWITCH:") or a.startswith("CHAIN_SWITCH:") or a.startswith("LOOP_SWITCH:") or a.startswith("FAST_SWITCH:"): stats[turn]["switches"] += 1
            elif a.startswith("PLAY:"): stats[turn]["plays"] += 1
            else: stats[turn]["other"] += 1
            dm = re.search(r'\(-(\d+)', a)
            if dm: stats[turn]["dice"] += int(dm.group(1))

    winner = None
    max_rnd = 0
    for entry in reversed(log):
        s = deref(store, entry["s"])
        if isinstance(s, dict):
            if s.get("winner") is not None: winner = s["winner"]
            max_rnd = max(max_rnd, s.get("roundNumber", 0))

    return results, stats, winner, max_rnd, CARD


def print_turn_by_turn(results, winner, max_rnd, CARD):
    for r in results:
        char_str = " | ".join(
            f"{'▶' if c['active'] else ''}{c['name']}({c['hp']}hp{' E'+str(c['energy']) if c['energy'] else ''}{' [DEAD]' if not c['alive'] else ''})"
            for c in r["chars"]
        )
        side = f"P{r['turn']}"
        print(f"\n{'='*60}")
        print(f"R{r['rnd']} {side} | Opp front: {r['opp_front']}")
        print(f"  Chars: {char_str}")
        for a in r["actions"]:
            print(f"  → {a}")

    wn = "DRAW" if winner is None else f"P{winner}"
    print(f"\n{'='*60}")
    print(f"WINNER: {wn} | Rounds: {max_rnd}")


def print_summary(stats):
    for t in [0, 1]:
        s = stats[t]
        total = s["skills"] + s["switches"] + s["plays"] + s["other"]
        side = f"P{t}"
        print(f"{side}: skills={s['skills']} switches={s['switches']} plays={s['plays']} other={s['other']} total_actions={total} dice_spent={s['dice']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 parse_replay.py <game-NNNN.json> [--summary] [--max-rounds N]")
        sys.exit(1)

    DATA_DIR = os.environ.get("GITCG_DATA_DIR", os.path.expanduser("~/gi-tcg/packages/data/src"))
    path = sys.argv[1]
    summary = "--summary" in sys.argv
    max_rounds = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--max-rounds=")), "0") or "99")

    results, stats, winner, max_rnd, CARD = parse_replay(path, DATA_DIR)

    if max_rounds < 99:
        results = [r for r in results if r["rnd"] <= max_rounds]

    if summary:
        print_summary(stats)
    else:
        print_turn_by_turn(results, winner, max_rnd, CARD)
