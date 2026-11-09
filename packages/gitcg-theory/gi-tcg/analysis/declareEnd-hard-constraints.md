# declareEnd 硬约束：替代 learned bias 的博弈论方案

> 源：V17 benchmark 0% WR → 定位到 `declareEnd` action-case bias 从 V16 的 +0.22 飙升至 +1.3185（6×），形成「消极均衡」恶性循环。
> 核心论点：**declareEnd 不应依赖可学习的 bias 参数**，而应交由基于博弈论和游戏机制的硬约束条件决定。
> 理论参照：`action-rationality-constraints.md`、`framework.md`、`three-character-collapse.md`、`framework-missing-modules.md`

---

## 一、问题定位

### 1.1 V17 的 declareEnd 偏差

| 版本 | declareEnd bias | useSkill bias | 结果 |
|------|:---:|:---:|------|
| V16 | +0.22 | — | WR 6.25% |
| **V17** | **+1.3185** | **-0.099** | **WR 0% (80局全败)** |

V17 的 ranker 学到的信号是：结束回合的价值是使用技能的 **13 倍**。这在任何正常对局中都是错误的。

### 1.2 为什么 learned bias 会失效

MCTS 自对弈数据中，`declareEnd` 的正反馈循环：

```
模型倾向 declareEnd
  → 自对弈数据中 declareEnd 占比高
    → 训练放大 declareEnd 的 bias
      → 下一轮更倾向 declareEnd
        → （恶性循环）
```

P0 约束（R1-R2 禁止 declareEnd）只延缓了症状——R3+ 的 declareEnd 信号仍然污染了训练数据。**learned bias 本质上是数据分布的函数，而非游戏机制的函数。**

### 1.3 替代方案

用 **4 条博弈论/游戏机制级约束** 替代 declareEnd 的 learned bias。这些约束统一为 prior penalty（非硬禁止），具有以下属性：

- **确定性**：不依赖训练数据质量，由当前游戏状态直接计算
- **可解释**：每条约束有明确的理论来源和失效条件
- **可组合**：约束之间正交，可独立开关和调参

---

## 二、四条约束

### 约束 1：斩杀阈值绝对禁止（Kill Threshold Override）

**理论来源**：`action-rationality-constraints.md` §⑤（P0 优先），`framework.md` §9.1.2 `K_now`

**约束陈述**：

> 如果存在任意 `useSkill` 动作的预估伤害 ≥ 对手当前出战角色 HP，则 **禁止 declareEnd**。
> （若多个技能均可斩杀，还应进一步禁止非斩杀动作，但那是另一个约束。）

**博弈论基础**：击杀 = 删除对手一个角色的全部未来行动权。`framework.md` §9.1.2 将其归类为 `K_now`（即时击倒收益），指出这是 **局面结构的跳变** 而非普通伤害累加。`action-rationality-constraints.md` 明确批评平滑 value 函数的「斩杀盲区」。

**形式化**：

```
∀ a ∈ candidates:
  if a.type == useSkill ∧ a.estimated_damage(opp_active) ≥ opp_active.hp:
    forbid(declareEnd)
```

**边界条件**（待细化）：
- [需要考虑 ] 预估伤害的计算精度：是否需要考虑护盾、减伤、冻结等阻拦状态？（`action-level-features.md` §2.2.3 已列出这些状态特征）
- [当前伤害消耗免死效果，为后续伤害的击倒做铺垫 ] 如果对手有免死效果（如 女士、无相之雷、无相之冰的被动），斩杀窗口是否仍为硬禁止？
  - **用户回答**：仍然是硬禁止——消耗免死效果为后续击倒铺路本身是有价值的。
- [斩杀的同时对手需要战斗行动切换的决策加快一动、减少1骰消耗（自动切人） ] 如果斩杀后对手强制切人可能触发更危险的局面（如换上满能量角色），是否应放宽？
  - **用户回答**：不应放宽。斩杀迫使对手战斗行动切人，等于加速一动 + 减少我方 1 骰消耗（自动切人 vs 手动切人）——这是节奏优势。

**当前实现状态**：`action-rationality-constraints.md` L206-220 已有伪代码，`candidate_numeric_slots.lethal_bonus` 在 V17 artifact 中存在（weight=+0.434，ranked #5）。

---

### 约束 2：对手已结束时的免费行动窗口（Last-Mover Advantage）

**理论来源**：`action-rationality-constraints.md` §④（对抗响应，L56-63），博弈论「后动优势」

**约束陈述**：

> 如果 `opponent.declared_end == true`，且存在至少一个期望价值 > 0 的动作，则 **禁止 declareEnd**。
> 对手已结束意味着你的后续动作 **零对抗响应风险**——这是免费的伤害/资源窗口。

**博弈论基础**：GI-TCG 是交替回合制零和博弈。对手未结束时，你的每个战斗行动都给对手完整的报复窗口（`action-rationality-constraints.md` L58-61）。对称地，对手已结束时你获得了无报复的行动自由。`framework.md` §9.1.4 `T_now` 将这种「立刻形成站位优势」归入即时节奏收益。

**形式化**：

```
if opponent.declared_end ∧ ∃ a ∈ candidates: E[Q(s,a)] > 0:
  forbid(declareEnd)
```

**实际判例**：`action-rationality-constraints.md` L202-246 的 `computeOppPressure` 函数：当对手骰子充裕时压迫强。对手已结束 = 压迫归零 = 最大化行动价值。

**边界条件**：
- [用value模型评估 ] 「期望价值 > 0」的阈值如何定义？需要 value model 参与还是纯规则判断？
- [不应禁止 ] 如果所有剩余动作的期望价值都接近 0（如残局只剩切人），是否还应禁止？
  - **用户回答**：不应禁止。但注意回合末的出战角色选择往往会导致切人并非 0 收益行为（可正可负）。
- [允许 ] 对手已结束但我方骰子全部无法有效使用（如全杂色且无调和手牌），是否允许结束？
  - **用户回答**：允许。

**当前实现状态**：`ObservationV1` 已有 `opponent.declared_end` 字段（`rl-implementation-spec.md` L168）。需要在 candidate ranking 或 leaf eval 中检查。

---

### 约束 3：骰子预算下限（Dice Budget Floor）

**理论来源**：`action-rationality-constraints.md` §①（骰子预算约束），`framework.md` §9.2.1 `R_now`（即时资源代价）

**约束陈述**：

> 如果剩余骰子 ≥ 最低技能消耗，且存在至少一个期望伤害 > 0 的技能动作，则 **禁止 declareEnd**。
> 有骰子 + 能攻击 + 攻击有收益 → 不攻击直接结束是严格劣策略。

**博弈论基础**：这是 **占优策略（dominance）** 的直接应用。令 `END` 为 declareEnd，`ATTACK` 为最低成本攻击动作。如果 `Q(END) < Q(ATTACK)` 在所有对手策略下成立（因为 ATTACK 至少产生非负伤害而不额外消耗不可再生资源），则 END 被 ATTACK 严格占优。

`three-character-collapse.md` §1 补充了骰子预算的动态性：角色数减少时，每角色预算上升，剩余的每个动作机会成本更高。

**形式化**：

```
min_skill_cost = min({ s.diceCost | s ∈ available_skills })
has_useful_attack = ∃ a ∈ candidates:
  a.type == useSkill ∧ a.expected_damage > 0

if remaining_dice ≥ min_skill_cost ∧ has_useful_attack:
  forbid(declareEnd)
```

**边界条件**：
- [应该详细考虑。另外还有抢先/后手的考究 ] 「期望伤害 > 0」是否过于宽松？某些攻击虽有伤害但会触发不利反应（如给对手挂元素）——这种 case 是否应例外？
  - **用户回答**：应该详细考虑。还包括抢先/后手（先手方有一次对手无法响应应对的行动轮次，后手方可以往后拖一个轮次）的考量，可能需要一次较深的MCTS模拟？**这是约束 3 落地前最核心的开放问题。**
- [消耗卡牌的价值与当前攻击的收益（即时收益+后续连招的收益）的比较 ] 调和消耗手牌换骰子后再攻击的价值如何评估？
  - **用户回答**：需要比较消耗手牌的价值与攻击的收益（即时 + 后续连招收益）。不是简单的「调和后能攻击 = 应该攻击」。
- [允许用行动牌进行蓄爆，若没有且不需要抢先则还是打技能 ] 如果唯一的可用技能是普攻（1 骰，低伤），且对手满血——是否仍禁止 declareEnd？还是允许保留骰子到下一轮？
  - **用户回答**：允许用行动牌蓄爆（打装备/支援/事件牌）。如果没有蓄爆能力且不需要抢先手，则仍然打技能。
- [天守阁要求有不同颜色的骰子（万能骰可视作任意一种，天守阁计数时尽可能地记作不重复颜色），涉及天守阁或吞星之鲸时添加特例 ] 是否存在「战略性保留骰子」的场景？
  - **用户回答**：存在。天守阁需要保留不同颜色骰子以最大化收益（万能骰尽量计作不重复颜色）；吞星之鲸需要保留特定费用骰做主动调和。这两种情况需添加特例检测。

**当前实现状态**：MCTS 的 `simulateAction()` 已经检查骰子支付（`action-rationality-constraints.md` L142-143），但 `candidate-generator` 层面未将骰子余量作为 declareEnd 的前置过滤。

---

### 约束 4：回合阶段感知（Phase-Aware Guidance）→ 降级为 LLM 辅助软约束

**理论来源**：`framework-missing-modules.md` §C（对局阶段），`replay-hidden-constraints-analysis.md` H6，`missing-modules-guiding-questions.md` C1-C4

**约束陈述**：

> 对局阶段影响 declareEnd 的合理时机。展开期（R1-R2）过早结束浪费节奏优势；收束期可以更自由地结束。
> **但阶段划分无法从通用状态特征中可靠推断**——需要 LLM 级别的语义理解。

**为什么降级**：用户明确指出以下关键限制：

1. **阶段检测无通用代理变量**（C1 回答）：「没有泛用的、具体的标志。阶段转换通常与卡组关键的技能/手牌相关」。回合数、HP 分布、存活角色数等通用特征无法可靠推断阶段——这已被标记为「完全不可能」。

2. **行动密度不是 well-defined 概念**（C2 回答）：不能只靠行动数衡量是否应该结束回合。快攻卡组在一回合内可能只有 1 次战斗行动（外加多次快速行动），但已经完成了全部展开→执行的阶段转换。

3. **快攻卡组的展开期可以极短**（C2 回答）：可能不到一回合，甚至仅需 1 次战斗行动 + 若干快速行动——按回合数或行动计数硬划分必然出错。

4. **archetype 区分不够精细**（C4 回答）：仅区分 aggro/midrange/control 不足以给出足够精细的阶段划分。

**建议方向**：委托给 LLM（`gi-tcg-gameplan` skill）生成 deck-specific 的阶段感知 plan，包括：
- 该卡组在当前 matchup 下的典型阶段转换触发条件
- 每阶段 declareEnd 的合理时机建议
- 这些建议作为软 prior 注入 ranking，而非硬过滤

**形式化**（LLM-assisted，非规则）：

```
// 不硬编码阶段分类——由 LLM 生成的 game plan 提供
phase_hints = gameplan.get_phase_hints(round, matchup_context)
declareEnd_prior *= phase_hints.declareEnd_weight  // 软调整
```

**边界条件**：
- [初期人工审阅。流程成熟后可转为自动审阅，与实战benchmark分开。 ] LLM 生成的阶段提示如何验证正确性？（人工审阅？benchmark？）
- [用简单启发式策略生成 ] 如果 LLM game plan 不可用（如离线 mode），是否完全跳过阶段感知？
- [合并 ] 阶段感知与 macroPlan 的关系：是否应合并到 macroPlan 中，而非独立实现？

**当前实现状态**：`ObservationV1` 已包含 `round_number` 和 `action_count_in_round`。`gi-tcg-gameplan` skill 已存在。缺少的是将 game plan 的阶段提示注入 declareEnd prior 的管道。

---

### ~~约束 5：角色数量感知骰子预算~~ → 已废弃

**废弃原因**：`dice_per_char = remaining_dice / alive_count` 这个指标的前提假设是 **每个角色每回合都需要均分骰子**——这在 GI-TCG 中完全不成立。

实际对局中：
- 主 DPS 可能一回合消耗 6-8 骰子（连续攻击）
- 辅助/挂元素角色可能 0 骰子（已在场上挂好元素，或已在后台等待）
- 三角色时某一角色可能整回合不行动，骰子完全集中在另外两个角色身上

`three-character-collapse.md` §1 中的 ~2-3 / ~3-4 骰子估算是 **有效行动组合数** 的量级估算，不是角色实际消费的均分——不能直接转化为 declareEnd 的硬约束。

该约束试图捕捉的实质——「剩余骰子是否还能产生有价值的行为」——已被约束 3（有骰不攻）充分覆盖。角色数量变化对 declareEnd 的影响通过 **合法动作集 A(s) 的自然变化** 间接体现：
- 三角色时 A(s) 包含切人选项，消耗骰子更多
- 单角色时 A(s) 不含切人，但技能选择更少，本身就更可能无有效动作

因此不需要额外按存活角色数施加 declareEnd 惩罚。

---

## 三、架构决策：废除硬禁止，统一为 prior penalty

### 3.1 决策

用户选择方案 (c)：**不做硬禁止，全程用大幅惩罚 prior**。理由：

- 硬禁止（FORBIDDEN）与 MCTS exploration 存在根本矛盾——MCTS 依赖 prior distribution 引导搜索，删除一个合法动作会扭曲整个树的 prior 分布（§3.3 「不知道」问题）
- `ranking 阶段`（D.1）+ `保留 learned bias`（D.2）= 天然适合 prior penalty 方案：ranker 学到的 declareEnd bias 作为 baseline，硬约束作为 overrides
- Layer 0 的「斩杀」「对手已结束」场景中，如果 declareEnd 真的因某种极端原因是最优选择（几乎不可能但不应完全排除），MCTS 仍有机会通过 exploration 发现

### 3.2 统一 prior penalty 公式

所有约束合并为对 declareEnd 候选动作的 **复合 prior penalty**，在 ranking 阶段计算：

```
declareEnd.prior_penalty = max(   // 取最保守（最反对结束）的约束
  penalty_kill,                   // 约束 1：斩杀阈值
  penalty_opp_ended,              // 约束 2：对手已结束
  penalty_dice_budget,            // 约束 3：骰子预算（核心，E.1 重点）
  penalty_special_cards           // 天守阁/吞星之鲸例外反向调整
) * phase_weight                  // 约束 4：阶段感知软调整
```

每个 `penalty_*` 输出 **≥ 0** 的值（0 = 不惩罚，正数 = 惩罚幅度）。`max()` 聚合意味着只要有一条约束认为「不该结束」，declareEnd 就受到强惩罚。MCTS 的 prior 为：

```
adjusted_prior = softmax( raw_score^(1/T) — penalty )
```

其中 `raw_score` 来自 ranker（含 learned declareEnd bias），`penalty` 来自约束系统，`T` 为 prior temperature。

### 3.3 约束 1/2 的 penalty 定义

**penalty_kill**（约束 1：斩杀阈值）：

```
if ∃ a ∈ candidates: a.type == useSkill ∧ a.estimated_damage(opp_active) ≥ opp_active.hp:
  penalty_kill = KILL_PENALTY     // 极高值，逼近硬禁止但不完全排除
else:
  penalty_kill = 0
```

`KILL_PENALTY` 应大到使 declareEnd 在 softmax 后概率趋近于 0，但 > 0 保留 MCTS 探索可能。建议值：使 adjusted prior 降为原先的 ~1e-6。

**penalty_opp_ended**（约束 2：对手已结束）：

```
if opponent.declared_end ∧ value_model.max_Q_non_end > 0:
  penalty_opp_ended = OPP_ENDED_PENALTY   // 高值
else:
  penalty_opp_ended = 0
```

`value_model.max_Q_non_end` 由现有 value model 对所有非 declareEnd candidate 的 Q 值 max 得到。

**penalty_special_cards**（天守阁/吞星之鲸例外）：

```
if has_tenkaku ∧ dice_color_diversity < 3:
  penalty_special_cards = -SPECIAL_REDUCTION  // 负值，减轻其他 penalty
if has_whale ∧ homogeneous_dice_count < 3:
  penalty_special_cards = -SPECIAL_REDUCTION
```

这是对 penalty_dice_budget 的反向调整——特殊卡组需要保留骰子时有理由结束。

---

## 四、E.1 深入分析：约束 3 的骰子-攻击阈值

### 4.1 问题重述

原始约束 3 的条件 `剩余骰子 ≥ min_skill_cost ∧ 期望伤害 > 0` 过于粗糙：
- 「期望伤害 > 0」忽略了攻击的负面效应（触发不利反应、暴露关键角色）
- 无法区分 1 点普攻伤害 vs 斩杀级伤害
- 忽略了先后手的信息不对称
- 忽略了用行动牌蓄爆（比打低伤技能更有价值）的场景

### 4.2 核心洞察：end-vs-act 是 MCTS 自然优势

**MCTS 天然擅长回答「继续行动 vs 结束回合哪个更好」**——因为它在搜索树中同时展开了两种路径，并回溯 Q 值。问题不在于「是否应该用 MCTS」，而在于「如何把 MCTS 的信息提炼为一个先于 MCTS 的 prior penalty」。

关键矛盾：我们想在 MCTS 运行**之前**对 declareEnd 施加 prior penalty，但判断「declareEnd 是不是劣策略」需要 MCTS 运行**之后**的信息。

**解决方案**：分层——首次 action selection 的 MCTS 已经包含 declareEnd 节点。该 MCTS 运行完毕后，其根节点的 visit count 分布提供了「declareEnd 在当前局面下是否值得探索」的强信号。这个信号可以：
- 直接用于当前决策（declareEnd 访问量足够高就允许）
- 作为下一轮训练的 feature，让 ranker 学习

但更方便的做法是：**prior penalty 只依赖 cheap features**（骰子、技能伤害、先后手），把精确判断留给 MCTS 的 tree search。即：prior penalty 足够强以避免 declareEnd 被 ranker 的 bias 带偏，但 MCTS 仍可通过充分 exploration 发现 declareEnd 在特殊情况下是最优的。

### 4.3 penalty_dice_budget 的因子分解

```
penalty_dice_budget = BASE_PENALTY × dice_factor × attack_factor × mover_factor
```

#### 4.3.1 dice_factor：骰子充裕度

| 剩余骰子 | 相对于 min_skill_cost | dice_factor | 解释 |
|:---:|------|:---:|------|
| ≥ 2× min_cost | 可打 2+ 次攻击 | **1.5** | 大量骰子未用——极高机会成本 |
| ≥ min_cost | 可打 1 次攻击 | **1.0** | 还有攻击能力 |
| < min_cost | 不够出招 | **0** | 没骰子攻击，不惩罚 |

例外：如果剩余骰子仅 ≥ min_cost 但全部是杂色且无调和手牌 → dice_factor = 0（实际无法攻击）。

#### 4.3.2 attack_factor：攻击质量（E.1 核心）

这是最需要细化的因子。不用单一 damage 阈值，改用 **分层评估**：

| 层级 | 条件 | attack_factor | 解释 |
|:---:|------|:---:|------|
| L0 | 任意技能 damage ≥ opp_active.HP | **极大**（由 penalty_kill 处理） | 斩杀——独立约束 |
| L1 | 伤害 ≥ 3 **且** 可触发增伤反应（蒸发/融化） | **1.2** | 高质量攻击，反应放大收益 |
| L1' | 伤害 ≥ 3，无反应但无负面 | **1.0** | 中等攻击 |
| L2 | 伤害 1-2，无负面效应 | **0.6** | 低伤但无害 |
| L2' | 伤害 1-2，给对手挂元素（对手可利用） | **0.3** | 低伤且有风险 |
| L3 | 无可用攻击，但有可用行动牌（蓄爆） | **0** | 不惩罚——蓄爆是合理的 |
| L3' | 普攻低伤 + 对手满血，无蓄爆牌 | **0.2** | 弱攻击，可能要保留骰子 |
| L∞ | 无任何有效动作（包括切人/调和） | **0** | 自然允许结束 |

**「期望伤害」的计算**（需要精确化的点）：
- base_damage：从 temporal profile 或 candidate slots 获取技能基础伤害
- 装备修正：武器/圣遗物增伤
- 反应预估：当前对手附着 + 技能元素 → 反应类型 → 伤害加成
- 阻拦状态：护盾量、减伤效果
- 这些数据在 V17 artifact 的 candidate_numeric_slots 中已有对应 slot（如 `damage_estimate`, `reaction_damage_bonus`, `target_shield_value`），可直接复用

#### 4.3.3 mover_factor：先后手不对称（用户核心洞察）

| 条件 | mover_factor | 博弈论解释 |
|------|:---:|------|
| **P0（先手），本回合对手尚未行动** | **1.5** | 先手有一次「对手无法响应的行动轮次」——这是免费的攻击窗口，应更积极 |
| P0，对手已行动但未结束 | 1.2 | 攻击后对手还能回应，但先手已建立了态势 |
| P0，对手已结束 | 1.0 | 双方都已暴露意图（约束 2 已单独处理） |
| **P1（后手），对手已行动未结束** | **0.8** | 后手看到了对手的操作——有信息优势，可以更精准地判断是否该结束 |
| P1，对手已结束 | **1.5 → 由 penalty_opp_ended 处理** | 对手结束 = 免费窗口（约束 2 主导） |
| P1，对手尚未行动（首回合） | 1.0 | 无信息，中性 |

**先后手不对称的理论基础**：
- `action-rationality-constraints.md` §④ 指出交替回合制下「回合初打牌 = 给对手 8 骰报复窗口」。对称地，**P0 的第一次攻击没有先行报复**——这是 P0 的结构性优势。
- `turn-order-and-opening-analysis.md` §2.1-2.3 区分了先后手敏感/不敏感场景，但未给出量化——本节的 mover_factor 是首次量化尝试。
- `missing-modules-guiding-questions.md` 多处提到先后手（如 B3 骰子规划顺序），确认先后手影响决策但未形式化。

### 4.4 蓄爆动作的识别

用户指出 `允许用行动牌进行蓄爆`——打装备/支援/事件牌不应被视为「浪费骰子」。识别逻辑：

```ts
has_setup_action = ∃ a ∈ candidates:
  a.type == playCard ∧ (
    a.card.category ∈ {equipment, support} ∨   // 装备/支援牌
    a.card.effect_family ∈ {dice_fix, draw_cards}  // 产骰/抽牌效果族
    // 注：实际 EFFECT_FAMILY_TAGS（static-priors.ts:53-65）包含：
    // direct_damage, heal_now, energy_gain, dice_fix, draw_cards,
    // summon_create, support_create, reaction_enable, burst_enable,
    // force_switch, future_random_value
  )
```

如果 `has_setup_action` 为 true 且 `attack_factor` 在 L2 或更低 → 不施加 penalty（允许用行动牌替代低质量攻击）。效果族分类来自 `static-priors.ts` 的 EFFECT_FAMILY_TAGS。

> **已修正（2026-05-11）**：文档原先引用 `dice_engine` 和 `card_draw`，实际代码中为 `dice_fix` 和 `draw_cards`。蓄爆检测可额外考虑 `energy_gain`、`summon_create`、`support_create`。

### 4.5 天守阁/吞星之鲸特例检测

```ts
// 天守阁 (Tenshukaku, defId: 321007) — 需要保留异色骰
// 源: data/src/cards/support/place.ts:126
// 机制: 行动阶段开始时，非万能骰种类 + 万能骰数 ≥ 5 → 生成 1 万能元素
has_tenkaku = deck_or_hand_contains(321007) ∨ supports_contains(321007)

// 吞星之鲸 (AlldevouringNarwhal, charId: 2204) — 需要保留手牌供 E 技能舍弃
// 源: data/src/characters/hydro/alldevouring_narwhal.ts:229
// 机制: 迸落星雨(22042) 舍弃手牌 → 触发被动增 HP
has_whale = deck_characters_contains(2204)

// 若检测到，penalty_dice_budget 在计算后减去 SPECIAL_REDUCTION
```

**天守阁检测细化（2026-05-11 修正）**：

天守阁收益发生在**行动阶段开始时**，条件为 `effectiveDiversity = nonOmniDiceTypes.size + omniCount ≥ 5`。但骰子在回合间不继承——多样性决策实际发生在**投骰/重投阶段**。天守阁对 declareEnd 决策的影响有限但存在：如果当前骰子多样性接近触发线（≥4 且 <5+omniCount），使用任何非万能骰都可能使 diversity 跌到 5 以下 → 施加 SPECIAL_REDUCTION 减免，允许保留骰子等待下轮天守阁触发。

**吞星之鲸检测细化**：鲸的核心机制是通过舍弃高费手牌触发被动（无尽食欲）增加最大 HP。如果手牌 ≥ 2 张，保留骰子到后续回合舍弃手牌是有价值的 → 施加 SPECIAL_REDUCTION 减免。

**已确认 ID**：

| 对象 | 代码名 | ID | 源文件 |
|------|------|:---:|------|
| 天守阁 | Tenshukaku | **321007** | `data/src/cards/support/place.ts` L121-126 |
| 吞星之鲸 | AlldevouringNarwhal | **2204** | `data/src/characters/hydro/alldevouring_narwhal.ts` L229 |

### 4.6 与 MCTS 的最终集成

1. **根节点前**：计算 `declareEnd.prior_penalty`，将 ranker 的 raw_score 减去 penalty 后送入 softmax
2. **MCTS 运行**：在 adjusted prior 下正常搜索——declareEnd 仍有非零概率被探索
3. **自然平衡**：如果 declareEnd 在特定局面确实最优（如残局无有效动作），MCTS 的 visit count 会反映这一点，即使 prior 很低

这保留了 `保留 learned bias`（D.2）的灵活性——ranker 学到的 declareEnd bias 作为 baseline，约束系统作为 safety net。

---

## 五、实施指南

### 5.1 改动范围

主要改动集中在以下位置：

| 文件 | 改动 | 约束 |
|------|------|:---:|
| `rank-candidates.ts` 或 prior 计算 | 计算 `declareEnd.prior_penalty` 并应用于 prior distribution | 1, 2, 3, 4 |
| `candidate-slots.ts` 或等效 | 暴露候选动作的 damage/reaction/cost 信息（供 penalty 计算） | 1, 3 |
| `leaf_eval` / MCTS node evaluator | value model 的 max_Q_non_end（供 penalty_opp_ended） | 2 |
| LLM gameplan 集成 | 阶段感知提示注入 declareEnd prior 管道 | 4 |
| 特殊卡组检测 | 天守阁/吞星之鲸的 deck/hand 扫描逻辑 | 3 |

### 5.2 数据依赖

所有约束所需的数据均可在 MCTS prior 注入点获取：

| 数据 | 来源 | 约束 |
|------|------|:---:|
| `opponent.chars[active].hp` | `ActionPhaseSnapshot.chars[].hp` | 1 |
| `skill.estimated_damage` | `PolicyCandidateAction.damage_estimate` + 静态查表补充 (`SKILL_BASE_DAMAGE`) | 1 |
| `opponent.declared_end` | `ActionPhaseSnapshot.declaredEnd` | 2 |
| `self.dice` (count + types) | `ActionPhaseSnapshot.dice` (DiceVector) | 3 |
| `skill.dice_cost` | `PolicyCandidateAction` via `extractDiceCost()` | 3 |
| `round_number` | `ActionPhaseSnapshot.roundNumber` | P0 R1-R2 |
| `handDefIds`（检测天守阁） | `ActionPhaseSnapshot.handDefIds` | 3 |
| `supports[].definitionId`（检测天守阁） | `ActionPhaseSnapshot.supports[]` | 3 |
| `chars[].definitionId`（检测吞星之鲸） | `ActionPhaseSnapshot.chars[]` | 3 |
| 先后手 | `ActionPhaseSnapshot.who`（0=P0先手） | 3 |

> **已修正（2026-05-11）**：原文档引用不存在的 `candidate_numeric_slots`。实际数据全部来自 `ActionPhaseSnapshot` + `PolicyCandidateAction`，两者在 MCTS prior 计算注入点均可用。

### 5.3 验证方案

- **单元测试**：对每个约束构造 3-5 个测试 case（应禁止 / 应允许 / 边界）
- **Benchmark**：`bun run --smol src/evaluation/benchmark/run-benchmark.ts bench-v18.json ...`
  - 与 V17（0% WR）对比，预期大幅改善
  - 与 V15（10% WR）对比，作为下限参考
- **Replay 审阅**：随机抽取 10 局，人工对照约束 checklist（`action-rationality-constraints.md` L316-323）验证

---

## 六、与现有理论文档的交叉引用

| 约束 | 主文档 | 辅文档 |
|:---:|------|------|
| 1. 斩杀禁止 | `action-rationality-constraints.md` §⑤ | `framework.md` §9.1.2, `action-level-features.md` §2.2.3 |
| 2. 对手已结束 | `action-rationality-constraints.md` §④ | `framework.md` §9.1.4 |
| 3. 有骰不攻 | `action-rationality-constraints.md` §①, §⑥ | `three-character-collapse.md` §1, `missing-modules-guiding-questions.md` B1-B4, `turn-order-and-opening-analysis.md` §2 |
| 4. 阶段感知 | `framework-missing-modules.md` §C | `missing-modules-guiding-questions.md` C1-C4, `replay-hidden-constraints-analysis.md` H6, `gi-tcg-gameplan` skill |
| ~~5~~ | 已废弃，实质被约束 3 覆盖 | — |
| E.1 分析 | 本文 §四 | `static-effect-meta-priors-for-rl.md` §2.1, `turn-order-and-opening-analysis.md` §2.1-2.3 |

---

## 七、待用户修改的问题清单

以下问题标记为待用户进一步细化和决策。用户已回答的问题标注为 ✅。

### A. 阶段划分（约束 4）
- ✅ ~~是否完全委托给 LLM gameplan？~~ → 是
- ✅ ~~LLM game plan 不可用时？~~ → 保留启发式输出
- ✅ ~~阶段感知与 macroPlan 的关系？~~ → 合并
- ✅ ~~按 archetype 区分~~ → 用户：archetype 区分不够精细，建议 LLM 完成
- ✅ ~~从通用状态特征推断~~ → 用户：完全不可能

### B. 阈值校准（约束 3）
- [ ] **attack_factor 的分层阈值**（§4.3.2）：L1/L1'/L2/L2' 的具体 damage 边界值（目前暂定 ≥3 / 1-2）需要 benchmark 校准
- ✅ ~~天守阁/吞星之鲸的 defId~~ → 321007 / 2204（已从 `data/` 源码确认）
- [ ] 调和→攻击的价值比较：消耗手牌价值 vs 攻击收益（即时 + 后续连招）
- ✅ ~~`DICE_PER_CHAR_*`~~ → 随约束 5 废弃

### C. 例外处理（约束 1/2/3）
- [ ] 蓄爆动作的识别（§4.4）：effect_family 分类的完整性——是否覆盖所有常见蓄爆效果族？已修正名称 `dice_engine`→`dice_fix`, `card_draw`→`draw_cards`
- ✅ 约束 1 免死效果 → 仍强惩罚
- ✅ 约束 1 斩杀后对手换人风险 → 不应放宽
- ✅ 约束 2 对手已结束 + 仅剩切人 → 不应惩罚
- ✅ 约束 2 对手已结束 + 骰子完全无法使用 → 允许

### D. 架构决策
- ✅ ~~硬约束在 candidate generation 还是 ranking 阶段？~~ → ranking 阶段（MCTS prior 计算注入点）
- ✅ ~~是否保留 declareEnd 的 learned bias？~~ → 保留（作为 baseline）
- ✅ ~~阶段检测是否委托给 gameplan？~~ → 是
- ✅ ~~硬禁止 vs prior penalty？~~ → 选择 prior penalty（§3.1）

### E. 核心开放问题（未解决）

1. [ ] **attack_factor 的数值校准**（§4.3.2）：L1-L3' 的 attack_factor 值（1.2, 1.0, 0.6, 0.3, 0, 0.2）和 damage 边界（≥3, 1-2）是理论推导——需要通过 benchmark 校准。

2. ✅ ~~BASE_PENALTY / KILL_PENALTY / OPP_ENDED_PENALTY 的量级~~ → 已推算：KILL=14, OPP_ENDED=8, BASE=4, SPECIAL_REDUCTION=2。基于实际 logit 空间 ln(score^(1/T))，T=3，heuristicScore 范围。[0.01, ~12]。需 benchmark 验证。

3. [ ] **mover_factor 的数值校准**（§4.3.3）：P0=1.5, P1=0.8 等值是理论推导——需要从先后手对称 self-play 数据中验证。`turn-order-and-opening-analysis.md` §4.1 建议添加后手对局数据，正是为了这类校准。
- ✅ ~~MCTS exploration vs 硬禁止~~ → 通过选择 prior penalty 方案自然消解

### F. 实现状态（2026-05-11 新增）

- ✅ **约束系统模块**：`packages/gi-agent/src/runtime/policy/declare-end-constraints.ts` 已创建，包含 4 条约束的完整实现
- ✅ **约束1 damage estimate**：Option B（静态查表 `SKILL_BASE_DAMAGE` + 装备修正 + 反应预估），覆盖 60+ 角色
- ✅ **约束2 max_Q_non_end**：Value model 模拟（复用 `this.valueFn`）+ 规则 fallback
- ✅ **约束3 penalty 因子分解**：`BASE × dice_factor × attack_factor × mover_factor` 完整实现
- ✅ **特殊卡组检测**：天守阁(321007) / 吞星之鲸(2204) 检测 + SPECIAL_REDUCTION 减免
- ✅ **MCTS 集成**：`gi-ml-mcts-policy.ts` 的 `choose()` 中注入，覆盖 ranker-based 和 value-model-based 两条 prior 路径
- [ ] **约束4 LLM 管道**：phase_weight 暂设为 1.0，LLM gameplan 注入管道待后续实现
- [ ] **benchmark 验证**：需要在 full benchmark（80 局）上验证 WR 改善

---

## 八、不覆盖的 declareEnd 场景

以下场景明确**不在**本文约束范围内（但可能有独立文档覆盖）：

- **P0 强制约束**（R1-R2 禁止 declareEnd）：已在 self-play config 中实现，不在此讨论
- **调和→declareEnd 的序列**：是否应先调和再结束？`missing-modules-guiding-questions.md` B2 指出「先调和再行动」，暗示调和后应继续行动而非结束
- **时间压力下的 declareEnd**（接近 15 回合上限）：`framework-critical-gaps.md` §3.4 提及但未展开，属于收束期策略的独立子问题
- **macroPlan 引导的 declareEnd**：`v7-macroplan-benchmark-postmortem.md` 指出 macroPlan 无前置条件/禁止规则是更深层问题——需要 macroPlan 层面的修改，不在动作阶段约束范围内
