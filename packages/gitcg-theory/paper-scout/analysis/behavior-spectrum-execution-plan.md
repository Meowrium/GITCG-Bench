# 连续行为谱 (Continuous Behavior Spectrum) — 执行计划

**Date**: 2026-05-25 | **Owner**: Paper Scout Deep Analysis Agent
**Context**: 共享卡池导致离散 archetype 分类先天不可行，需转向连续行为谱方案

---

## 背景

实证发现：
- llm-deck-analyzer 的离散 archetype（aggro/midrange/control/combo）对 GI TCG 完全无效
- 10 副卡组中 8 副被标为 "midrange"，planProfile 五维度 range ≤ 0.5
- DeepSeek LLM 的 strength 评分（7.0-7.5）与实际胜率零相关
- 根因：GI TCG 共享卡池 + 3 角色 + 30 张卡的设计，使卡组可在连续空间中自由变形

详细论证：`paper-scout/analysis/archetype-classification-impossibility.md`

---

## 目标

用 **replay 数据无监督提取的连续行为向量** 替代离散 archetype 标签，作为 deck prior 的输入。

## Step 1: 生成跨卡组 Replay 数据

**当前状态**：`packages/gi-agent/output/benchmark-logs/` 下有 ~39 局，主要是 mirror match

**需求**：
- 10 副卡组 × 10 副卡组 两两对局
- 每个 matchup 5-10 局（随机种子不同）
- 总计 ~500-1000 局 replay
- 用已有的 benchmark 框架跑：`packages/gi-agent/src/evaluation/benchmark/`

**输出**：`benchmark-logs/` 目录下的 `game-NNNN-pX.json` 文件

---

## Step 2: 提取 Behavior Metrics

**输入**：Step 1 产出的 replay JSON 文件
**工具**：扩展现有 `packages/gi-agent/scripts/parse_replay.py`

**每条 replay 产出一个结构化 JSON**：

```json
{
  "deck_code": "APBw4CAO...",
  "opponent_deck": "AABQ7xUO...",
  "winner": 0,
  "total_rounds": 5,
  "behaviors": {
    "damage_per_round": [0, 3, 7, 5, 12],
    "first_kill_round": 3,
    "swap_count": 4,
    "chain_swap_count": 1,
    "loop_switch_count": 0,
    "skill_distribution": {"A": 3, "E": 5, "Q": 2},
    "card_plays": 7,
    "avg_dice_spent_per_turn": 3.2,
    "dice_efficiency": 0.82,
    "support_zone_fill_round": 2,
    "declare_end_frequency": 0.4
  }
}
```

**提取脚本位置**：`packages/gi-agent/scripts/extract_behavior_metrics.py`

---

## Step 3: 聚类 + 验证

**输入**：Step 2 产出的 behavior metrics 集合

**流程**：
1. 按 deck_code 聚合：每副卡组的多局 replay → 平均 behavior vector
2. UMAP 降维到 2D，可视化验证是否形成自然谱系
3. HDBSCAN 无监督聚类，看 cluster 数量和分布
4. 对比 `llm-deck-analyzer` 的 planProfile：
   - planProfile range vs behavior spectrum range
   - 哪种表示对 deck 之间的区分度更高（silhouette score）

**输出**：
- 可视化图（UMAP scatter，按 deck 着色）
- 聚类报告（cluster count, silhouette score）
- 与 planProfile 的对比分析

---

## 参考论文

| ID | Title | 借鉴点 |
|----|-------|--------|
| 2112.03534 | MAP-Elites for Hearthstone Deckbuilding | 用连续 behavior space 表示 deck（唯一先例） |
| 2008.07663 | Information theory and player archetype choice in Hearthstone | Shannon 熵度量 meta 多样性 |
| 2410.06299 | Taxonomy of CCGs from AI Perspective | GI TCG 作为共享卡池子类的定位 |

---

## 后续对接

Behavior spectrum 验证通过后，替代 `llm-deck-analyzer` 的 planProfile：
- `packages/gi-agent/src/learning/features/llm-deck-prior-provider.ts` 中的 LLM blend 用 behavior vector 替代
- `packages/llm-deck-analyzer/src/features/extractor.ts` 的 DeckFeaturesV2 增加 behavior 维度
- CGT 冷热分析（P2/P3）可以用 behavior metrics 中的 `damage_per_round` 曲线和 `swap_count` 做校准
