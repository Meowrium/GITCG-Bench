#!/usr/bin/env python3
"""
B 类行为计数器 — 从 benchmark replay logs 统计 declareEnd、支援位、先后手等行为频率。

用法:
    python3 count-behaviors.py <game-replay.json> [--data-dir DATA_DIR]

输出:
    JSON 格式的行为计数摘要，可直接聚合多个文件。

对应文档: docs/v26-hidden-constraints-validation-plan.md §2-§9
"""
import json, os, re, sys
from collections import defaultdict

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
    
    # 提取骰子类型分布
    dice_types = defaultdict(int)
    if isinstance(dice_arr, list):
        for d in dice_arr:
            t = d if isinstance(d, (int, str)) else deref(store, d)
            dice_types[str(t)] += 1
    
    # 提取场上实体 (支援/召唤物)
    entities = deref(store, pd.get("combatStatuses"))
    entity_ids = set()
    if isinstance(entities, list):
        for e in entities:
            ed = deref(store, e)
            if isinstance(ed, dict):
                defn = deref(store, ed.get("definition"))
                if isinstance(defn, dict):
                    entity_ids.add(defn.get("id", 0))
    
    return {
        "hand_ids": hand_ids,
        "dice_count": dice_count,
        "dice_types": dict(dice_types),
        "entity_ids": entity_ids,
        "active_id": pd.get("activeCharacterId", 0),
        "declared_end": pd.get("declaredEnd", False),
    }


def analyze_behaviors(store, log):
    """
    从 replay log 提取 B1/B4/B7 行为计数。
    
    返回:
        counters: dict of counter_name -> count
        per_round: list of per-round stats
    """
    counters = defaultdict(int)
    per_round_stats = []
    
    # 解析 turn states
    turn_states = {}  # (round, turn) -> [(P0 state, P1 state), ...]
    
    for entry in log:
        s = deref(store, entry.get("s"))
        if not isinstance(s, dict) or s.get("phase") != "action":
            continue
        rnd = s["roundNumber"]
        turn = s.get("currentTurn", 0)
        key = (rnd, turn)
        
        players = deref(store, s.get("players"))
        if not isinstance(players, list) or len(players) < 2:
            continue
        
        p0 = deref(store, players[0])
        p1 = deref(store, players[1])
        
        if key not in turn_states:
            turn_states[key] = []
        turn_states[key].append((get_player_state(store, p0), get_player_state(store, p1)))
    
    # 按回合分析
    for (rnd, turn) in sorted(turn_states.keys()):
        states = turn_states[(rnd, turn)]
        if not states:
            continue
        
        first_state = states[0]  # 初始状态
        last_state = states[-1]  # 最终状态
        p0_first, p1_first = first_state
        p0_last, p1_last = last_state
        
        # ─── B7: 先后手节奏 ───
        side = turn  # 0 = P0 行动, 1 = P1 行动
        opp_side = 1 - turn
        
        actor = p0_last if side == 0 else p1_last
        opp = p1_last if side == 0 else p0_last
        
        # ─── B1: declareEnd 检测 ───
        # 该 turn 是否有 dice 消耗?
        dice_before = (p0_first["dice_count"] if side == 0 else p1_first["dice_count"])
        dice_after = (p0_last["dice_count"] if side == 0 else p1_last["dice_count"])
        hand_before = len(p0_first["hand_ids"] if side == 0 else p1_first["hand_ids"])
        hand_after = len(p0_last["hand_ids"] if side == 0 else p1_last["hand_ids"])
        
        dice_spent = dice_before - dice_after
        hand_change = hand_after - hand_before
        
        # 行动类型检测
        action_type = "unknown"
        if dice_spent > 0:
            # 有骰子消耗
            active_changed = (p0_last["active_id"] if side == 0 else p1_last["active_id"]) != \
                            (p0_first["active_id"] if side == 0 else p1_first["active_id"])
            if active_changed:
                action_type = "switch"
            elif hand_change < 0:  # 手牌减少
                action_type = "play_card"
            else:
                action_type = "skill"
        elif dice_spent == 0 and hand_change == 0:
            # 无骰无手牌变化 — 可能是 declareEnd 或被动等待
            if actor["dice_count"] > 0:
                # 有骰但未行动 = declareEnd 或空闲状态
                # 实际判断需要看 entry 的 action
                action_type = "declareEnd_possible"
        
        # ─── B4: 支援位检测 ───
        # 跟踪实体数量变化
        entities_before = p0_first["entity_ids"] if side == 0 else p1_first["entity_ids"]
        entities_after = p0_last["entity_ids"] if side == 0 else p1_last["entity_ids"]
        new_entities = entities_after - entities_before
        support_played = len(new_entities) if action_type == "play_card" else 0
        
        # ─── 计数累加 ───
        # B7: R1 技能率
        if rnd == 1 and turn == 0:
            counters["r1_p0_turns"] += 1
            if action_type in ("skill", "play_card", "switch"):
                counters["r1_p0_action_taken"] += 1
            if action_type == "skill":
                counters["r1_p0_skill"] += 1
        
        if rnd == 1 and turn == 1:
            counters["r1_p1_turns"] += 1
            if action_type in ("skill", "play_card", "switch"):
                counters["r1_p1_action_taken"] += 1
            if action_type == "skill":
                counters["r1_p1_skill"] += 1
        
        # B1: declareEnd 相关
        if action_type == "declareEnd_possible":
            counters["declare_end_with_dice_remaining"] += 1
            
            # 对手是否已结束
            opp_ended = p1_last.get("declared_end", False) if side == 0 else p0_last.get("declared_end", False)
            if opp_ended:
                counters["declare_end_with_opp_ended"] += 1
        
        # B4: 支援位压力
        if action_type == "play_card" and support_played > 0:
            counters["support_played_total"] += support_played
            # 检查支援位状态
            support_count = len(entities_before)  # 近似
            if support_count >= 4:
                counters["support_replacement"] += 1
            elif support_count >= 3:
                counters["support_played_slot4"] += 1
            elif support_count >= 2:
                counters["support_played_slot3"] += 1
            
            # 首次攻击前打支援
            if rnd == 1:
                counters["support_before_first_skill_r1"] += 1
        
        # B4: Chain switch 检测
        if action_type == "switch":
            if rnd == 1:
                counters["r1_switches"] += 1
        
        # 记录 per-round
        per_round_stats.append({
            "round": rnd,
            "turn": turn,
            "side": side,
            "action_type": action_type,
            "dice_spent": dice_spent,
            "dice_remaining": actor["dice_count"],
            "hand_size": len(actor["hand_ids"]),
            "entities_count": len(actor["entity_ids"]),
        })
    
    # 计算比率
    if counters.get("r1_p0_turns", 0) > 0:
        counters["r1_p0_skill_rate"] = counters.get("r1_p0_skill", 0) / counters["r1_p0_turns"]
    if counters.get("r1_p1_turns", 0) > 0:
        counters["r1_p1_skill_rate"] = counters.get("r1_p1_skill", 0) / counters["r1_p1_turns"]
    
    return dict(counters), per_round_stats


def parse_replay_for_behaviors(path, data_dir):
    """解析单个 replay 文件，返回行为计数器。"""
    with open(path) as f:
        replay = json.load(f)
    
    store = replay.get("store", replay if isinstance(replay, list) else [])
    log = replay.get("log", [])
    
    if not log:
        # 可能是旧格式 — 数组格式
        return {"error": "no log found", "path": path}
    
    # 找 winner
    winner = None
    max_rnd = 0
    for entry in reversed(log):
        s = deref(store, entry.get("s", {}))
        if isinstance(s, dict):
            if s.get("winner") is not None:
                winner = s["winner"]
            max_rnd = max(max_rnd, s.get("roundNumber", 0))
    
    counters, per_round = analyze_behaviors(store, log)
    
    # 尝试用 entry 级别更精确地检测 declareEnd
    # (当 phaselog 直接记录 declareEnd action)
    declare_end_explicit = 0
    for entry in log:
        s = deref(store, entry.get("s", {}))
        if isinstance(s, dict) and s.get("phase") == "action":
            action = deref(store, entry.get("action", {}))
            if isinstance(action, dict) and action.get("case") == "declareEnd":
                declare_end_explicit += 1
    
    if declare_end_explicit > 0:
        counters["declare_end_explicit"] = declare_end_explicit
    
    return {
        "path": path,
        "winner": winner,
        "rounds": max_rnd,
        "counters": counters,
        "per_round_count": len(per_round),
    }


def aggregate_game_results(results):
    """聚合多个游戏的计数器为汇总报告。"""
    total = defaultdict(int)
    game_count = len(results)
    
    # 可聚合的计数器
    summable = [
        "r1_p0_turns", "r1_p0_action_taken", "r1_p0_skill",
        "r1_p1_turns", "r1_p1_action_taken", "r1_p1_skill",
        "declare_end_with_dice_remaining", "declare_end_with_opp_ended",
        "declare_end_explicit",
        "support_played_total", "support_replacement",
        "support_played_slot3", "support_played_slot4",
        "support_before_first_skill_r1",
        "r1_switches",
    ]
    
    rate_keys = ["r1_p0_skill_rate", "r1_p1_skill_rate"]
    
    for r in results:
        c = r.get("counters", {})
        for k in summable:
            total[k] += c.get(k, 0)
    
    # 比率取平均
    for k in rate_keys:
        vals = [r.get("counters", {}).get(k, 0) for r in results if r.get("counters", {}).get(k, 0) > 0]
        if vals:
            total[k] = sum(vals) / len(vals)
    
    # 重新计算全局比率
    if total.get("r1_p0_turns", 0) > 0:
        total["r1_p0_skill_rate"] = total.get("r1_p0_skill", 0) / total["r1_p0_turns"]
    if total.get("r1_p1_turns", 0) > 0:
        total["r1_p1_skill_rate"] = total.get("r1_p1_skill", 0) / total["r1_p1_turns"]
    
    return {
        "total_games": game_count,
        "aggregate_counters": dict(total),
    }


def format_report(aggregate):
    """格式化汇总报告。"""
    c = aggregate["aggregate_counters"]
    games = aggregate["total_games"]
    
    print("=" * 70)
    print(f"  B 类行为计数器报告 ({games} 场对局)")
    print("=" * 70)
    
    print(f"\n## B1 — declareEnd 与行动权")
    print(f"  R1 P0 总回合数:          {c.get('r1_p0_turns', 0)}")
    print(f"  R1 P0 技能使用率:        {c.get('r1_p0_skill_rate', 0)*100:.1f}%  (目标 ≥60%)")
    print(f"  R1 P1 技能使用率:        {c.get('r1_p1_skill_rate', 0)*100:.1f}%")
    print(f"  declareEnd (显式):       {c.get('declare_end_explicit', 0)}")
    print(f"  declareEnd (有骰残留):   {c.get('declare_end_with_dice_remaining', 0)}")
    print(f"  declareEnd (对手已结束): {c.get('declare_end_with_opp_ended', 0)}")
    
    print(f"\n## B4 — 支援/召唤位")
    print(f"  支援牌打出总数:          {c.get('support_played_total', 0)}")
    print(f"  支援替换 (满位):         {c.get('support_replacement', 0)}")
    print(f"  R1 首次攻击前打支援:     {c.get('support_before_first_skill_r1', 0)}")
    print(f"  R1 切人次数:             {c.get('r1_switches', 0)}")
    
    print(f"\n## B7 — 先后手节奏")
    rate_p0 = c.get('r1_p0_skill_rate', 0)
    rate_p1 = c.get('r1_p1_skill_rate', 0)
    p0_flag = "✅" if rate_p0 >= 0.6 else "⚠️"
    print(f"  R1 P0 技能率: {p0_flag} {rate_p0*100:.1f}%  (目标 ≥60%)")
    print(f"  R1 P1 技能率:             {rate_p1*100:.1f}%")
    
    print(f"\n{'='*70}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 count-behaviors.py <game-replay.json> [--data-dir DIR] [--aggregate file1.json file2.json ...]")
        print("       python3 count-behaviors.py --batch <dir> [--data-dir DIR]  # batch all *.json in dir")
        sys.exit(1)
    
    DATA_DIR = os.environ.get("GITCG_DATA_DIR", 
        os.path.expanduser("~/gi-tcg/packages/data/src"))
    
    if "--data-dir" in sys.argv:
        idx = sys.argv.index("--data-dir")
        DATA_DIR = sys.argv[idx + 1]
    
    if "--batch" in sys.argv:
        idx = sys.argv.index("--batch")
        batch_dir = sys.argv[idx + 1]
        results = []
        for fname in sorted(os.listdir(batch_dir)):
            if fname.endswith(".json"):
                path = os.path.join(batch_dir, fname)
                try:
                    r = parse_replay_for_behaviors(path, DATA_DIR)
                    results.append(r)
                except Exception as e:
                    print(f"Error parsing {fname}: {e}", file=sys.stderr)
        
        aggregate = aggregate_game_results(results)
        json.dump(aggregate, sys.stdout, indent=2, ensure_ascii=False)
        print()  # newline after JSON
        format_report(aggregate)
    
    elif "--aggregate" in sys.argv:
        idx = sys.argv.index("--aggregate")
        results = []
        for fname in sys.argv[idx + 1:]:
            if fname.startswith("--"):
                continue
            try:
                r = parse_replay_for_behaviors(fname, DATA_DIR)
                results.append(r)
            except Exception as e:
                print(f"Error parsing {fname}: {e}", file=sys.stderr)
        
        aggregate = aggregate_game_results(results)
        json.dump(aggregate, sys.stdout, indent=2, ensure_ascii=False)
        print()
        format_report(aggregate)
    
    else:
        path = sys.argv[1]
        DATA_DIR = os.environ.get("GITCG_DATA_DIR", 
            os.path.expanduser("~/gi-tcg/packages/data/src"))
        
        if "--data-dir" in sys.argv:
            idx = sys.argv.index("--data-dir")
            if idx + 1 < len(sys.argv) and not sys.argv[idx + 1].startswith("--"):
                DATA_DIR = sys.argv[idx + 1]
        
        result = parse_replay_for_behaviors(path, DATA_DIR)
        print(json.dumps(result, indent=2, ensure_ascii=False))
