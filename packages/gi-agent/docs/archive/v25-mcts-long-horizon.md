# MCTS 长时规划改进方案 (A-H)

> **日期**: 2026-05-14  
> **关联**: `v14-model-requirements.md`, `v25-implicit-matchup-encoding.md`  
> **状态**: 待决策

## 问题表述

GITCG 的决策时间线跨越 3-4 轮 (~20 步)，MCTS 深度 3-5 仅覆盖 ~1 轮。当前 `macroPlan`、`value function`、`temporal profiles` 提供了部分跨轮信息，但 MCTS 搜索本身仍局限于短时视野。

```
MCTS 搜索空间:  a₁ → a₂ → a₃ → a₄  (深度4, ~1轮)
实际决策需要:   R1攒骰 → R2设场 → R3爆发  (3轮, ~20步)
```

## 方案矩阵

```
                      需要训练/数据量
                   低 ←──────────→ 高
             ┌──────────────────────────────┐
深           │ D: Action Grouping           │ F: Learned World Model
度     高    │ E: Progressive Widening      │ G: Multi-Time Scale MCTS
↑           │                               │
│     低    │ B: Subgoal Library           │ C: Option Framework + RL
│           │ A: Plan Scripts              │ H: Learned Rollout Policy
             └──────────────────────────────┘
```

---

## 方案 A: 回合级 Macro-Action

MCTS 搜索 "回合意图" 而非单步动作。

**核心**: `{setup, pressure, burst, save}` 四种回合级意图作为 macro-action。回合内部用 ranker 选具体动作。

**问题**: 意图可变。对手一回合杀掉前台，"R2设场"计划直接作废。macro-action 刚性过强。

**改进 — 软承诺替代硬计划**: 不选单一意图，每回合产出意图概率分布。每步动作后重新计算，计划随状态漂移。

```ts
probs = softmax(scores)  // { setup: 0.52, pressure: 0.25, save: 0.23 }
// MCTS prior 按意图分布加权每个候选动作
```

---

## 方案 B: 逆向规划 — 关键轮次锚定

从终局目标倒推：第 R 轮需要 Q 可用 → 需要 N 能量 → 需要提前 E/Talent。

**问题**: 锚点动态变化。对手加血推迟斩杀，加速充能提前爆发。

**改进 — 瓶颈状态替代固定锚点**: 不锚定"R3开Q"，而是识别"Q能量≥2"为瓶颈状态。无论它出现在哪轮，MCTS 检测到瓶颈就自动加深搜索。瓶颈签名从 self-play 统计数据自动提取。

---

## 方案 C: 卡组级静态意图发现

Sutton 的 Options（时间扩展动作，有 initiation/termination 条件）需要 RL 训练，贪心自对弈数据有分布偏差。

**核心思路**：不学习 option 条件，也不人手定义通用模板（"<3费 E = setup"在红牛等卡组中无意义）。改为**从卡组静态分析自动发现每个卡组独有的意图模式**，零数据依赖。

### 三层意图发现

**第 1 层：静态动作序列枚举（BFS, depth ≤ 6）**

```
输入: deck_code + 游戏规则 DB
输出: 所有合法动作序列及其终态结果

BFS 展开规则:
- 只剪引擎判定为 ILLEGAL 的动作
- 不剪"看起来没意义"的合法动作:
  * 重复切人（A→B→A）→ 合法防御策略，保留
  * endTurn → 合法选择，保留
  * 主动放弃技能 → 合法，保留
- 行动牌减费/加骰效果（卯师傅、交给我吧等）纳入骰子可用量计算
- 回合可用动作数由游戏规则计算，非固定值
```

实际枚举量远小于理论 `50^6`：引擎合法性剪枝 + 骰子约束 + target 约束，最终序列约 10⁴ 量级。离线 run 一次，<1 分钟/卡组。

**第 2 层：按终态结果聚类（不按动作类型分类）**

```python
# 不关心"用了什么动作"，关心"序列结束后的结果"
outcome = {
  damage_dealt,       # 预期总伤害
  energy_gained,      # 前台充能
  board_state,        # "角色B在前台,附火"
  dice_remaining,     # 剩余资源
  cards_spent,        # 消耗的手牌
}
# k-means 聚类 → 每个 cluster = 一个卡组独有的意图
# 不强制 4 类：红牛可能 3 个 cluster，水凝可能 5 个
```

**第 3 层：提取意图签名（centroid → template）**

```python
# 每个 cluster 的 centroid 是意图的静态签名
intent_signature = {
  precondition: {element_active: pyro, energy: 2},
  typical_sequence: ["E(A)", "switch(B)", "E(B)", "Q(A)"],
  expected_outcome: {damage: 15, energy_remaining: 1},
  estimated_min_turns: 2,
}
```

过程完全离线、零对局数据，输入 deck code + 游戏 DB 即可。结果缓存在 NAS 供 MCTS 查询。

---

## 方案 D: 自适应粒度 + 瓶颈感知搜索

50+ 动作合并为 ~6 组，MCTS 搜索组而非单动作。ranker 在组内选具体动作。

**合并规则**：不按人手分类，从方案 C 的意图聚类结果派生——每个 intent cluster 的自然语言描述映射为一个动作组。

```
原始: endTurn, switch(x3), playCard(~12), useSkill(~9) = ~50
合并: [pass], [switch], [setup意图组], [pressure意图组], [burst意图组], [save意图组]
```

**核心机制 — 瓶颈状态检测**：不锚定固定轮次（"R3 开 Q"），而是根据状态阈值动态检测瓶颈。

```python
bottleneck_vector(state) = {
  energy_proximity:   min_over_chars( (cost - current) / cost )  # 0=已满, 1=零
  hp_cliff:           min_over_chars( hp / max_attack_on_board )  # <1=可被秒
  combo_ready:        1 if all_dependencies_satisfied else 0
  turn_remaining:     actions_left / typical_actions_per_turn
  elemental_setup:    applied_elements / needed_for_best_reaction
}
# 任意维度 > 0.7 → 进入瓶颈 → MCTS 切细粒度
```

**自适应粒度切换**：状态紧迫度 = `max(bottleneck_vector)`，控制粒度连续可调而非二值。

```
urgency > 0.5  → 细粒度（单动作搜索，depth +3，优先深度利用）
urgency ≤ 0.5  → 粗粒度（动作组搜索，广度优先，快速覆盖远轮）
```

关键：粒度在每个 MCTS 节点独立判断。一个决策点可能前半步粗、后半步细——对手突然切出关键角色使 hp_cliff 骤降，MCTS 立刻从粗搜索切换到细搜索。

**文献**: Churchill & Buro (2013) "Portfolio Greedy Search" — StarCraft AI 的自适应粒度。

---

## 方案 E: 动作嵌入 + 代表性采样

MCTS 每个节点只展开 top-N 候选（ranker 排序），其余快速 value 评估。深度翻倍。

**问题**: 剪枝可能丢失关键动作。ranker 训练自贪心数据，它的 top-3 不等于 MCTS 最优路径。

**改进 — 动作嵌入 + 代表性采样替代剪枝**: 把所有动作映射到低维空间，MCTS 从每个区域各采样一个代表。未搜索的动作通过嵌入连续性插值估值。不丢信息，只降维度。

### 嵌入空间维度选定

**方法 1：PCA 数据驱动**（推荐）

```python
# 从 self-play 日志取 100K 决策点，每候选动作的 ranker 特征向量（67 维）
features = [action_vector for game in logs for dp in game]
pca = PCA(n_components=3).fit(features)
print(pca.explained_variance_ratio_)  # 看前 3 PC 能否解释 >80% 方差
# 如果 < 80%，增加到 4-5 维
# 每个 PC 的语义由其最高载荷的原始特征命名
```

**方法 2：手工定义**（需验证正交性）

```
进攻性 (Offensive):   E[本动作伤害] / max_damage_possible   → 0 到 1
资源消耗 (Cost):      dice_cost + card_cost + energy_cost    → 归一化
即时性 (Immediacy):   effect_delay (0=立即, 1=下回合/后续)  → 0 到 1
```

**无论哪种方法，必须验证**：
1. 维度间 Pearson r < 0.3（正交性）
2. 每个象限至少覆盖 5% 的动作（无空象限）
3. 同象限内动作的 value 方差 < 跨象限方差（判别力）

### 代表性采样

```
MCTS 决策点有 50 个候选动作：
  1. 将每个动作映射到 3 维嵌入坐标
  2. 将空间按中位数切分为 8 个象限
  3. 每象限各取 1 个代表（共 8 个候选 → MCTS 展开）
  4. 未展开的动作 value = 其象限代表 value × cosine_similarity(embed, rep)
```

**文献**: Couëtoux et al. (2011) "Continuous Upper Confidence Trees"。

---

## 方案 F: Learned World Model

训练快速近似世界模型，MCTS 在模型里模拟。速度 2.2s/game → 0.05s/game。

**代价**: GITCG 状态空间复杂（手牌、骰子、召唤物），学准确模型极难。当前不推荐。

---

## 方案 G: Multi-Time Scale MCTS

同时在动作/回合/轮次三个时间尺度搜索。不同尺度的节点用不同粒度的动作空间。

**代价**: 实现复杂度极高，需要三层 MCTS 协调。当前不推荐。

---

## 方案 H: Learned Rollout Policy

用 self-play 数据训练 lightweight rollout policy，替代随机 rollout。

**问题**: 分布偏移。Learned rollout 在贪心数据上训练，MCTS 搜索时的状态分布不同，rollout 在陌生状态上过度自信。

**改进 — 值函数截断替代 Rollout**: 不做 learned rollout。MCTS 深度到 10 后直接截断，用 value function 估值。要求 value function 和 MCTS 在同分布数据上训练（MCTS self-play → 训练 value → 再用 MCTS）。

**文献**: AlphaZero — 完全不用 rollout。

---

## 关键补充：静态意图 → 动态实战

**核心矛盾**: 方案 C 产出的意图序列（"E→E→Q"）在静态世界中完美，但实战中被干扰拆分重组：
- 对手 R2 杀掉你的前台 → 序列断裂
- 没抽到天赋卡 → 替代路径
- 骰子颜色不对 → 被迫改计划

**答案：不用序列做剧本，用序列的"终态"做指南针。**

### 意图签名作为优化目标

MCTS 每个决策点的搜索偏向**所有匹配的意图签名**：

```python
for intent in deck_intents:
    # 当前状态离意图起点的距离
    start_fit = match_score(state, intent.precondition)
    if start_fit < 0.3: continue  # 完全不匹配，跳过

    for candidate in legal_actions:
        next_state = simulate(candidate, state)
        # 执行本动作后离意图终态的距离（这才是关键）
        goal_distance = distance(next_state, intent.expected_outcome)
        # 离终态越近 → 此意图给本动作的加分越高
        candidate.score += start_fit * (1 - goal_distance)

    # 额外加分：如果此动作恰好匹配意图典型序列的当前步
    if candidate matches intent.typical_sequence[step]:
        candidate.score += bonus
```

### 为什么序列被拆碎仍然有效

```
静态意图:  E(A) → switch(B) → E(B) → Q(A)
实战版本:  E(A) → [被对手打断,切人去后台] → [两回合后用其他牌攒了能量] → switch(B) → Q(A)

MCTS 视角:
- 被对手打断后 precondition 仍然满足（能量还在）→ intent 仍然激活
- "switch(B) → Q(A)" 这两步仍匹配意图后缀 → 得到加分
- 中间插入的其他动作（攒能量/防御）虽不匹配序列，但不扣分
- goal_distance 计算的是"离终态还有多远"而非"离序列还有多远"
```

关键设计：**意图签名不要求严格按序执行**。只要当前动作让终态更近，就加分。对手干扰只改变状态，不改变目标终态的吸引力。

### 意图切换

```
对手斩杀前台角色A → precondition 完全失效（A已死亡）
→ start_fit 降为 0 → 此意图不再给任何动作加分
→ MCTS 自然转移到下一个匹配的意图（如防御/save）
```

切换是隐式的——不需要显式"放弃计划"逻辑，start_fit 降到 0 就自然断开。

---

## 推荐统一架构

```
Layer 0: 模板意图识别器（基于规则）
  ↓
Layer 1: 软意图分类器 (P(intent|state))
  ↓
Layer 2: 瓶颈感知 MCTS（自适应粒度 + 深度）
  ↓
Layer 3: 动作嵌入采样（降维不降信息）
  ↓
Layer 4: 值函数截断（不用 learned rollout）
```

### 实施优先级

| 优先级 | 组件 | 新增代码量 | 依赖 |
|---|---|---|---|
| P0 | 模板意图识别 + 软分类器 | ~200行 | 卡组静态分析 |
| P1 | 瓶颈状态检测 + 自适应粒度 | ~300行 | self-play 统计数据 |
| P2 | 动作嵌入 + 代表性采样 | ~250行 | MCTS 改造 |
| P3 | 值截断替代 rollout | ~50行 | MCTS self-play 训练 value |

P0+P1 即可让 MCTS 在关键状态获得 2-3 倍有效深度，无分布偏移风险。
