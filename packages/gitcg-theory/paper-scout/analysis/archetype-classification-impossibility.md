# 为什么 GI TCG 的卡组不应该用离散 Archetype 标签

**Date**: 2026-05-25 | **Analyst**: Paper Scout Deep Analysis Agent
**Context**: 2026-W22 深度分析中发现 llm-deck-analyzer 的 archetype 分类对 GI TCG 完全失效（8/10 卡组标为 "midrange"，planProfile 五个维度 range ≤ 0.5）

---

## 核心论点

**GI TCG 的游戏机制（共享卡池 + 3 角色 + 30 张卡）先天决定了离散 archetype 分类不可行。**

这不是"模型不够好"的问题——是游戏结构不支持。

---

## 一、三种卡牌游戏的结构对比

| 维度 | Hearthstone | MTG | GI TCG |
|------|------------|-----|--------|
| 卡池 | **职业锁**（猎人只能选猎人卡） | **颜色锁**（蓝白 deck 只能用蓝/白卡） | **完全共享**（~200 张卡对所有角色可用） |
| 卡组大小 | 30 张 | 60 张 | 30 张 + 3 角色 |
| 身份标识 | 英雄技能 + 职业卡 = 强 archetype 信号 | 颜色 pie = 弱但存在 archetype 信号 | 角色技能 = 弱信号，但共享卡池稀释 |
| 构筑灵活性 | 低 — 猎人不可能突然变控制（卡池限制） | 中 — 颜色 pie 约束但 splashing 可行 | **高 — 同一组角色换 5 张卡可变成完全不同的打法** |
| archetype 边界 | 相对清晰 | 模糊但有颜色边界 | **根本不存在清晰边界** |

### GI TCG 的特殊性

- Hearthstone 的 Face Hunter 不可能变成 Control Hunter：猎人卡池没有足够的治疗/清场/资源卡。archetype 是**卡池决定的**。
- MTG 的 Blue-White Control 有明确的颜色 identity：蓝色=抽牌反击，白色=清场治疗。archetype 是**颜色 pie 决定的**。
- GI TCG 的同一副 3 角色组合（如 申鹤+重云+芭芭拉），可以配成 freeze control（多带回复/拖后），也可以配成 aggressive tempo（多带速攻/直伤）。**卡组不是被卡池定义的，是被 30 张卡的具体选择定义的。** 而 30 张从 ~200 张共享池中挑选——构筑空间是连续的。

---

## 二、实证：llm-deck-analyzer 的失效

2026-05-25 的实证分析显示：

- 10 副 GI TCG 卡组中，**8 副被 heuristic 层标为 "midrange"**
- LLM 增强后 archetype 分布不变（DeepSeek 没有纠正它）
- planProfile 五维度（setupSpeed, tempoPush, longGameValue, defensiveStability, finisherDensity）的 range 仅 0.3-0.5——**完全无法区分不同风格的卡组**
- LLM 的 strength 评分全部集中在 7.0-7.5（range=0.5, stddev=0.05）——等于在随机猜测

这是构造性失效，不是"prompt 不够好"。

---

## 三、学术界研究空白

2026-05-25 的扩充搜索（跨 cs.AI, cs.GT, cs.NE, nlin.AO, cs.HC 五个领域，20+ queries）确认：

**没有任何一篇学术论文直接讨论 "archetype 边界模糊/离散标签不成立" 问题。**

最接近的三篇：

| 论文 | 贡献 | 局限性 |
|------|------|--------|
| 2008.07663 (nlin.AO) | 用 Shannon 熵分析 Hearthstone archetype 频率分布 | 隐含用分布替代标签，但仍是 Hearthstone（有职业锁）|
| 1907.01623 (cs.AI) | 用 matchup matrix 替代 archetype 标签做平衡 | 回避而非解决分类问题 |
| 2112.03534 (cs.NE) | MAP-Elites 用连续 behavior space 表示 deck | 唯一用连续谱的工作，但仍是 Hearthstone |

这说明：**共享卡池导致的 archetype 分类无效化是一个未被学术界识别的问题。GI TCG 在这个维度上是独特的研究对象。**

---

## 四、解决方案：连续行为谱 (Continuous Behavior Spectrum)

### 核心思路

不要问"这副卡组是什么 archetype？"
要问"这副卡组的行为描述是什么？"

### 候选 Behavior Descriptor

```
deck_behavior = {
  // Tempo 维度
  avg_damage_per_round:     [R1, R2, R3, ...],  // 随时间变化的出伤曲线
  first_kill_round:         2.5,                  // 首次击杀的平均回合
  round_distribution:       [0.3, 0.5, 0.2],     // 对局结束的回合分布

  // 资源维度
  dice_efficiency:          0.82,                 // 骰子利用率
  resource_cycle_count:     1.3,                  // 每局平均资源循环数
  card_play_rate:           0.75,                 // 手牌使用率

  // 交互维度
  swap_frequency:           2.1,                  // 每局平均切人次数
  reaction_rate:            0.45,                 // 触发元素反应的比例
  proactive_vs_reactive:    0.60,                 // 主动行动 vs 响应行动的比值

  // CGT 维度
  cold_hot_score:           0.35,                 // 位置的平均 cold-hot 程度
  number_probability:       0.68,                 // 位置可被分类为 Number 的概率
  reversibility_ratio:      0.15,                 // 可逆动作占所有动作的比例
}
```

### 获取方式

1. **从 replay 数据无监督提取**：跑 100+ 局 replay → 提取每局行为统计 → 聚类 → 自然形成谱系
2. **从 deck 构成预测**：训练一个 `deck_code → behavior_vector` 模型，输入卡组代码输出行为预测
3. **接入 MCTS**：behavior vector 替代 planProfile 作为 deck prior

### 优势

- 连续的、可度量的、可从数据学习的
- 不同卡组之间的"距离"可以用 cosine similarity 度量（"申鹤冰和莫优的 behavior vector 相似度 0.7" vs "申鹤冰是 midrange，莫优也是 midrange——identical"）
- 不受共享卡池影响——因为衡量的是**行为**而非构成
- 可以对接 CGT 分析（cold-hot score, number-probability 天然是 CGT 维度的行为化）

---

## 五、与 2410.06299 (CCG Taxonomy) 的关系

2410.06299 从 AI 视角给 CCG 分类。如果它的 taxonomy 包含 "card pool accessibility" 维度，GI TCG 将形成一个独特的子类：共享卡池 CCG。

这一子类的关键特征：
- 离散 archetype 分类先天不可行
- 卡组间的距离是连续的（一副卡组可以通过替换 5 张卡平滑变形为另一副）
- behavior-based representation 是更自然的建模方式
- 这使 GI TCG 不仅是一个"又一个 CCG AI benchmark"，而是一个**需要新方法的 domain-innovative testbed**

---

## 六、相关论文索引

| ID | Title | Relevance to this analysis |
|----|-------|---------------------------|
| 2008.07663 | Information theory and player archetype choice in Hearthstone | 用分布建模 archetype（非标签），Shannon entropy |
| 2410.06299 | A Taxonomy of Collectible Card Games from a Game-Playing AI Perspective | CCG 分类学——检查是否包含共享卡池维度 |
| 1907.01623 | Evolving the Hearthstone Meta | Matchup matrix 替代 archetype 标签 |
| 2112.03534 | Deep Surrogate Assisted MAP-Elites for Automated Hearthstone Deckbuilding | 连续 behavior space 表示 deck |
