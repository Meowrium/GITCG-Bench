#!/usr/bin/env python3
"""Per-Deck 诊断报告生成器
从 benchmark 结果 JSON 或 pipeline log 中提取 per-deck 多维度诊断指标。

用法:
  python3 per-deck-diagnostics.py <benchmark-result.json>
  python3 per-deck-diagnostics.py --from-log <pipeline-log.txt>
"""
import json, sys, os
from collections import defaultdict

# ─── v9c 数据（从 ECI pipeline log 提取） ───
# 手动录入 benchmark log 中的完整 8×8 矩阵
V9C_RAW = {
    "水八": {"水八":40,"神宵":80,"水债":40,"水凝":100,"红牛":0,"莫优":20,"雷鹤":0,"雷狼":40},
    "神宵": {"水八":20,"神宵":40,"水债":0,"水凝":40,"红牛":20,"莫优":40,"雷鹤":60,"雷狼":0},
    "水债": {"水八":80,"神宵":80,"水债":60,"水凝":60,"红牛":20,"莫优":80,"雷鹤":80,"雷狼":40},
    "水凝": {"水八":60,"神宵":40,"水债":40,"水凝":20,"红牛":0,"莫优":80,"雷鹤":80,"雷狼":40},
    "红牛": {"水八":80,"神宵":80,"水债":100,"水凝":100,"红牛":40,"莫优":80,"雷鹤":100,"雷狼":60},
    "莫优": {"水八":0,"神宵":20,"水债":40,"水凝":20,"红牛":20,"莫优":20,"雷鹤":20,"雷狼":60},
    "雷鹤": {"水八":0,"神宵":80,"水债":60,"水凝":20,"红牛":20,"莫优":40,"雷鹤":40,"雷狼":60},
    "雷狼": {"水八":60,"神宵":60,"水债":60,"水凝":60,"红牛":0,"莫优":80,"雷鹤":20,"雷狼":40},
}

DECKS = list(V9C_RAW.keys())

def compute_per_deck_stats():
    """从 RAW 矩阵计算 per-deck 诊断"""
    stats = {}
    for deck in DECKS:
        matchups = V9C_RAW[deck]
        wr_list = list(matchups.values())
        mean_wr = sum(wr_list) / len(wr_list)
        mirror_wr = matchups[deck]
        
        # 首攻 vs 后手（当前数据不区分先后手，全部是 sideA=P0）
        # 找出弱 matchup（WR < 30%）
        weak = [(opp, wr) for opp, wr in matchups.items() if wr < 30 and opp != deck]
        strong = [(opp, wr) for opp, wr in matchups.items() if wr > 70 and opp != deck]
        
        stats[deck] = {
            "mean_wr": mean_wr,
            "mirror_wr": mirror_wr,
            "best_matchup": max(matchups.items(), key=lambda x: x[1]),
            "worst_matchup": min(matchups.items(), key=lambda x: x[1]),
            "weak_matchups": weak,
            "strong_matchups": strong,
            "std_dev": (sum((w - mean_wr)**2 for w in wr_list) / len(wr_list)) ** 0.5,
        }
    return stats

def compute_matchup_asymmetry():
    """计算镜像对局不对称性"""
    total_asym = 0
    pairs = []
    for i, d1 in enumerate(DECKS):
        for d2 in DECKS[i+1:]:
            wr_a = V9C_RAW[d1][d2]
            wr_b = 100 - V9C_RAW[d2][d1]  # d2 as A vs d1 as B, convert to d1 perspective
            asym = abs(wr_a - wr_b)
            total_asym += asym
            pairs.append((d1, d2, wr_a, wr_b, asym))
    return pairs, total_asym / len(pairs) if pairs else 0

def generate_report():
    stats = compute_per_deck_stats()
    asym_pairs, avg_asym = compute_matchup_asymmetry()
    
    print("=" * 80)
    print("  V9C Per-Deck 多维度诊断报告")
    print("  Benchmark: V25-8deck-GBDT vs baseline (320 games, 5 per matchup)")
    print("=" * 80)
    
    # ─── 全局指标 ───
    global_wr = sum(s["mean_wr"] for s in stats.values()) / len(stats)
    global_std = (sum((s["mean_wr"] - global_wr)**2 for s in stats.values()) / len(stats)) ** 0.5
    mirror_std = (sum((s["mirror_wr"] - 50)**2 for s in stats.values()) / len(stats)) ** 0.5
    
    print(f"\n## 全局指标")
    print(f"  Mean WR:          {global_wr:.1f}%")
    print(f"  Per-Deck StdDev:  {global_std:.1f}%")
    print(f"  Mirror WR StdDev: {mirror_std:.1f}%  (距 50% 偏差)")
    print(f"  Avg Asymmetry:    {avg_asym:.1f}%  (A vs B 不对称度)")
    
    # ─── Per-Deck 概要 ───
    print(f"\n## Per-Deck 概要")
    print(f"  {'Deck':<6} {'Mean WR':>7} {'Mirror':>7} {'StdDev':>7} {'Best':>12} {'Worst':>12} {'Weak N':>7}")
    print(f"  {'-'*6} {'-'*7} {'-'*7} {'-'*7} {'-'*12} {'-'*12} {'-'*7}")
    
    for deck in DECKS:
        s = stats[deck]
        best_opp, best_wr = s["best_matchup"]
        worst_opp, worst_wr = s["worst_matchup"]
        print(f"  {deck:<6} {s['mean_wr']:6.1f}% {s['mirror_wr']:6.0f}% {s['std_dev']:6.1f}% "
              f"{best_opp}:{best_wr:3.0f}%  {worst_opp}:{worst_wr:3.0f}%  {len(s['weak_matchups']):>5}")
    
    # ─── Per-Deck 详细 ───
    print(f"\n## Per-Deck 详细分析")
    for deck in DECKS:
        s = stats[deck]
        print(f"\n### {deck}")
        print(f"  综合 WR: {s['mean_wr']:.1f}%  |  Mirror: {s['mirror_wr']:.0f}%  |  StdDev: {s['std_dev']:.1f}%")
        
        if s["mirror_wr"] < 40:
            print(f"  ⚠️  Mirror WR < 40% — 策略对自身卡组存在系统性偏见")
        elif s["mirror_wr"] > 60:
            print(f"  ℹ️  Mirror WR > 60% — P0/P1 不对称 (可能先后手优势)")
        
        if s["strong_matchups"]:
            strong_str = ", ".join(f"{opp}({wr}%)" for opp, wr in s["strong_matchups"])
            print(f"  强 matchup: {strong_str}")
        if s["weak_matchups"]:
            weak_str = ", ".join(f"{opp}({wr}%)" for opp, wr in s["weak_matchups"])
            print(f"  弱 matchup: {weak_str}")
    
    # ─── 不对称性分析 ───
    print(f"\n## 镜像对局不对称性 (Top 10)")
    asym_pairs_sorted = sorted(asym_pairs, key=lambda x: -x[4])
    for d1, d2, wr_a, wr_b, asym in asym_pairs_sorted[:10]:
        if asym > 20:
            flag = "⚠️"
        else:
            flag = "  "
        print(f"  {flag} {d1} vs {d2}: A→{wr_a}%  B→{wr_b}%  asym={asym}%")
    
    # ─── 8×8 热力图 ───
    print(f"\n## 8×8 WR 矩阵 (sideA 行 vs sideB 列)")
    header = "       " + "".join(f"{d:<8}" for d in DECKS)
    print(header)
    for deck in DECKS:
        row = f"  {deck:<4} "
        for opp in DECKS:
            wr = V9C_RAW[deck][opp]
            if wr >= 80:
                bar = "██"
            elif wr >= 60:
                bar = "▓▓"
            elif wr >= 40:
                bar = "▒▒"
            elif wr >= 20:
                bar = "░░"
            else:
                bar = "  "
            row += f"{bar}{wr:3d}%   "
        print(row)
    
    # ─── 分类诊断 ───
    print(f"\n## 分类诊断")
    
    dominant = [d for d in DECKS if stats[d]["mean_wr"] >= 60]
    struggling = [d for d in DECKS if stats[d]["mean_wr"] < 35]
    volatile = [d for d in DECKS if stats[d]["std_dev"] > 25]
    
    print(f"  统治级 (>60%):   {', '.join(dominant) if dominant else '无'}")
    print(f"  挣扎级 (<35%):   {', '.join(struggling) if struggling else '无'}")
    print(f"  波动级 (std>25): {', '.join(volatile) if volatile else '无'}")
    
    # ─── 预估对应隐藏约束 ───
    print(f"\n## 隐藏约束对应建议")
    mappings = {
        "红牛": "H5(role profile) + H7(tempo) — 快攻策略理解优秀",
        "水债": "H4(support slot) + H3(aura) — 支援节奏和反应链较优",
        "莫优": "H5(role) + H2(dice) — 卡组策略未表达, 骰子利用不足",
        "神宵": "H2(dice) + H8(hand retention) — 调谐牺牲关键牌",
        "雷鹤": "H3(aura debt) — 元素附着债务建模不足",
        "雷狼": "H1(declareEnd) + H6(opp threat) — 终盘决策欠佳",
        "水八": "H4(support slot) + P0-1(deck prior) — 支援过度铺场",
        "水凝": "H6(opp threat) + H5(role) — 防守/保护不足",
    }
    for deck in DECKS:
        print(f"  {deck:<6} → {mappings.get(deck, '待分析')}")
    
    print(f"\n{'='*80}")
    print(f" 报告生成完毕。建议与 AI_VALIDATION_MATRIX.md 对照使用。")
    
    return stats, asym_pairs

if __name__ == "__main__":
    generate_report()
