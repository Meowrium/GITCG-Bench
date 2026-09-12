#!/usr/bin/env python3
"""Analyze MCTS benchmark sample logs for V_immediate/V_terminal ρ.
Usage: python3 analyze_mcts_rho.py <sample_logs_dir> <output_dir>"""
import json, sys
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('./output/mcts-rho-sample-logs')
OUTPUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('./output')

# ── Same replay parser as v22_analysis.py ──
def deref_store(val, store):
    if isinstance(val, dict):
        if '$' in val and len(val)==1:
            idx = val['$']
            if isinstance(idx, int) and 0 <= idx < len(store):
                return deref_store(store[idx], store)
        if '$$' in val and len(val)==1:
            for entry in store:
                if isinstance(entry, dict) and entry.get('$$')==val['$$']:
                    return deref_store(entry, store)
        if '__type' in val and val['__type']=='map':
            result = {}
            for entry in val.get('entries',[]):
                if isinstance(entry, list) and len(entry)>=2:
                    result[str(deref_store(entry[0],store))] = deref_store(entry[1],store)
            return result
        result = {}
        for k,v in val.items():
            if k=='$$': continue
            result[k] = deref_store(v, store)
        return result
    elif isinstance(val, list):
        return [deref_store(v, store) for v in val]
    return val

def get_team_hp(player_state):
    chars = player_state.get('characters',[])
    if not isinstance(chars, list): return 0
    total = 0
    for c in chars:
        if isinstance(c, dict):
            vars = c.get('variables',{})
            hp = vars.get('health',0) if isinstance(vars, dict) else 0
            if isinstance(hp, (int,float)): total += hp
    return total

def get_game_outcome(log, store):
    for entry in reversed(log):
        state = deref_store(entry.get('s',{}), store)
        for ext in state.get('extensions',[]):
            if isinstance(ext, dict) and 'state' in ext:
                es = ext['state']
                if isinstance(es, dict) and 'win' in es and isinstance(es['win'], list) and len(es['win'])==2:
                    return {0: es['win'][0], 1: es['win'][1]}
    return None

def compute_rho(actions):
    n = len(actions)
    if n<5: return 0.0
    vi_idx = sorted(range(n), key=lambda i: (actions[i]['V_immediate'], i))
    vi_ranks = [0]*n; i=0
    while i<n:
        j=i
        while j<n and actions[vi_idx[j]]['V_immediate']==actions[vi_idx[i]]['V_immediate']: j+=1
        avg=(i+j+1)/2
        for k in range(i,j): vi_ranks[vi_idx[k]]=avg
        i=j
    vt_idx = sorted(range(n), key=lambda i: (actions[i]['V_terminal'], i))
    vt_ranks = [0]*n; i=0
    while i<n:
        j=i
        while j<n and actions[vt_idx[j]]['V_terminal']==actions[vt_idx[i]]['V_terminal']: j+=1
        avg=(i+j+1)/2
        for k in range(i,j): vt_ranks[vt_idx[k]]=avg
        i=j
    d2 = sum((vi_ranks[i]-vt_ranks[i])**2 for i in range(n))
    return 1 - 6*d2/(n*(n**2-1))

def parse_all(data_dir):
    actions = []
    for fpath in sorted(data_dir.rglob('*.json')):
        try:
            with open(fpath) as f: raw = json.load(f)
        except: continue
        store = raw.get('store',[]); log = raw.get('log',[])
        if len(log)<2: continue
        outcome = get_game_outcome(log, store)
        if outcome is None: continue
        prev_players = None; prev_actor = None
        for entry in log:
            state = deref_store(entry.get('s',{}), store)
            if state.get('phase')!='action': continue
            players = state.get('players',[])
            if not isinstance(players,list) or len(players)<2:
                prev_players = players; prev_actor = state.get('currentTurn',0); continue
            current_turn = state.get('currentTurn',0)
            if prev_players is not None and prev_actor is not None and isinstance(prev_players,list) and len(prev_players)>=2:
                ai, oi = prev_actor, 1-prev_actor
                dmg = max(0, get_team_hp(prev_players[oi]) - get_team_hp(players[oi]))
                heal = max(0, get_team_hp(players[ai]) - get_team_hp(prev_players[ai]))
                sdmg = max(0, get_team_hp(prev_players[ai]) - get_team_hp(players[ai]))
                actions.append({
                    'round': state.get('roundNumber',0),
                    'V_immediate': dmg + heal - sdmg,
                    'V_terminal': 1.0 if outcome.get(ai, False) else 0.0,
                })
            prev_players = players; prev_actor = current_turn
    return actions

def main():
    if not DATA_DIR.exists():
        print(f"Data dir not found: {DATA_DIR}")
        return

    actions = parse_all(DATA_DIR)
    if not actions:
        print("No actions found!")
        return

    n = len(actions)
    rho = compute_rho(actions)
    vi = [a['V_immediate'] for a in actions]
    nonzero = sum(1 for v in vi if v != 0)

    print(f"=== MCTS ρ Analysis ===")
    print(f"  Sample logs: {DATA_DIR}")
    print(f"  Actions: {n}, ρ={rho:.4f}, nonzero={nonzero} ({100*nonzero/n:.1f}%)")

    round_actions = defaultdict(list)
    for a in actions: round_actions[a['round']].append(a)

    print(f"\n  By round:")
    for rnd in sorted(round_actions.keys()):
        acts = round_actions[rnd]
        if len(acts) < 5: continue
        print(f"    R{rnd:2d}: n={len(acts):5d}, ρ={compute_rho(acts):.4f}")

if __name__ == '__main__':
    main()
