# 七圣召唤 AI 训练瓶颈分析：对局隐藏约束挖掘

> **状态**: 临时工作文档，供人工评估  
> **生成日期**: 2026-04-08  
> **数据来源**: `packages/gi-agent/output/iter-training/` (iter-000, iter-009, iter-032) + `packages/gitcg-theory/` (全12份文档)

---

## 一、背景数据汇总

### 1.1 训练进度现状

| 迭代 | pairwiseSupport | Value MAE | Value RMSE | 是否晋升 |
|------|----------------|-----------|-----------|---------|
| iter-000 | 0.8008 | 0.368 | 0.397 | ✓ |
| iter-009 | 0.8415 | 0.259 | 0.323 | ✓ |
| iter-032 | 0.8394 | 0.251 | 0.314 | ✓ |

**观察**：iter-009 → iter-032 跨越了 23 次迭代，但 pairwiseSupport **下降了 0.2%**，Value MAE 仅改善 3%。训练已陷入明显平台期。

### 1.2 对局结果矩阵（iter-032 自我对弈）

| 对局类型 | 总场数 | 平局场数 | 平局率 |
|----------|--------|---------|-------|
| **HongNiu 镜像** | 24 | 11 | **45.8%** ⚠️ |
| **ShuiZhai 镜像** | 24 | 3 | 12.5% |
| **LeiHe 镜像** | 24 | 2 | 8.3% |
| **ShuiBa 镜像** | 24 | 0 | 0% |
| **所有交叉对局** | 120 | 0 | **0%** |
| LeiHe vs HongNiu | 20 | 0 | 0% |
| LeiLang vs ShenXiao | 20 | 0 | 0% |
| MoYou vs ShuiNing | 20 | 0 | 0% |

**关键信号**：镜像对局平局率与交叉对局形成鲜明对比，且不同卡组镜像的平局率差异极大。

### 1.3 训练数据效率

- 总自我对弈场次：216
- 有效插入样本：20,505（86.5%）
- 跳过样本：3,207（13.5%）
- HongNiu 镜像跳过率明显高于其他对局（平局场次无有效奖励信号）

---

## 二、现有理论框架的覆盖边界

通过对比 `gitcg-theory/` 全部文档与 `gi-agent/src/` 实现代码，梳理出以下理论已覆盖和尚未覆盖的领域：

### 2.1 理论已覆盖

| 领域 | 覆盖状态 | 文档位置 |
|------|---------|---------|
| 总评估函数分解（G_now, G_plan, R） | ✅ 完整 | framework.md |
| RL 观测/候选/奖励规范 | ✅ 完整 | rl-implementation-spec.md |
| 阈值跳变（能量/血量/技能解锁） | ✅ 识别 | dynamic-thresholds-and-conditional-features.md |
| 三角色坍缩不可逆性 | ✅ 完整 | three-character-collapse.md |
| 强耦合机制与构筑论失效 | ✅ 完整 | strong-coupling-and-deckbuilding.md |
| 信息效应（威慑价值） | ✅ 识别 | dynamic-thresholds-and-conditional-features.md |
| 快攻七维评估 | ✅ 实战 | 七圣召唤快攻攻略_导出.txt |

### 2.2 理论部分覆盖（有概念，无建模）

| 领域 | 覆盖状态 | 已知问题 |
|------|---------|---------|
| 骰子经济学 | ⚠️ 提及 | "每回合8颗"硬约束有，资源转换效率未建模 |
| 元素反应体系 | ⚠️ 提及 | 反应收益提了，但对战略时序的影响未深展 |
| 对局阶段切换标志 | ⚠️ 有框架 | setup/transition/execution/closing 定义了，但切换点不稳定 |
| 隐藏信息（手牌概率） | ⚠️ 有公式 | 公式存在，信念状态更新未使用 |

### 2.3 理论空白（对局中出现，文档中未触及）

**本文档重点关注此区域。**

---

## 三、从对局数据挖掘的高层隐藏约束

以下每条约束均从对局数据中发现，并与现有理论的覆盖边界做了对比。评估维度：**可能正确性**（基于数据的推断可信度） × **泛用性**（是否适用于多个卡组/局面）。

---

### HC-01：「对称策略均衡」 —— 镜像对局中 AI 收敛到局部纳什均衡

**现象**  
HongNiu 镜像对局有 45.8% 平局率，ShuiZhai 镜像 12.5%，LeiHe 镜像 8.3%，ShuiBa 镜像 0%。所有 120 场交叉对局无一平局。

**推断约束**  
当双方使用完全相同的策略网络（同一模型权重）和完全相同的卡组时，若该卡组的「最优对称策略」是反复 `declareEnd`（即等待对方先动，双方同时等待），则博弈会陷入纳什均衡导致平局。

具体地：若卡组 X 在对称策略下满足：
```
E[先出手收益] < E[等待收益]
```
则双方均选择等待（都 `declareEnd`），直到回合上限触发平局。

**卡组类型差异的解释**
- **HongNiu（平局率 45.8%）**：该卡组可能具有强「后发优势」，先出手实际上会暴露关键角色或骰子信息，而等待允许对手先暴露。对称情况下，双方都等待 → 平局。
- **ShuiBa（平局率 0%）**：该卡组的最优动作很可能与对称策略无关（如固定出手序列强于等待），对称博弈也能产生决策性动作。
- **LeiHe（平局率 8.3%）**：介于中间，偶有对称等待局。
- 用户注：在人类玩家对局中，这3套均属于伤害充足、爆发高的中速套牌的卡组，几乎不可能平局。
**理论空白**  
现有框架识别了「节奏」概念但已建议删除，未建模「先手/后手动态价值」作为卡组全局属性。理论中的 T_now（即时节奏）和 T_plan（未来节奏）描述的是单个动作的节奏价值，缺乏针对「对称博弈均衡稳定性」的抽象。

**泛用性评估**  
- **不同卡组间有差异**，但「是否陷入对称均衡」是关于卡组属性的高层性质，理论上适用于所有卡组。
- 该约束影响训练数据质量：高平局率卡组产生差训练信号（draw reward = 0），降低迭代效率。
- 用户注：反复切人消耗动数的策略在人类对局中仅存在于控制卡组内战中。中速卡组中，主动出伤是一定可以打破这种纳什均衡、且不太容易被反打的。
**可操作建议**  
1. 对 HongNiu 镜像加入随机探索扰动（epsilon-greedy policy 而非纯贪心）来打破均衡。
2. 引入「对称均衡检测器」：若连续 N 步双方均 `declareEnd`，强制切换到探索模式。
3. 对「后发优势」类卡组，研究是否可以调整 `endTurnPenalty` 参数。

---

### HC-02：「回合先后手动态价值」 —— endTurnPenalty 是全局常数，但先手优劣因局面而异

**现象**  
当前 `endTurnPenalty = 5`（硬编码全局常数）。在所有对局中均等惩罚 `declareEnd`，无论当前是否处于后手优势局面。

**推断约束**  
先手动态价值 $V_{\text{先手}} - V_{\text{后手}}$ 随以下因素动态变化，但现有系统未建模：

```
场景1：当自身角色正在「冻结/石化」状态 → 先出手价值低，后手价值高
场景2：当对手召唤物即将到期（本回合结算） → 先出手可能触发更多召唤物伤害链，先出手价值高（用户注：这个逻辑很奇怪没看懂，像是AI幻觉加重了）
场景3：当双方均能完成斩杀 → 先出手价值极高（抢先斩杀）
场景4：支援区爆满且自方有重要支援需要放置 → 先出手价值低（对手触发结算）
场景5：能量充满（大招就绪）且等待可以观察对手换人 → 后手价值高
```

**理论空白**  
`framework.md` 识别了 `T_now`（即时节奏：「交换先后手、迫使劣响应、改变行动顺序」），但将其列为「混合项（平时低权、关键窗口高权）」。实现中将节奏简化为单一权重（`tempoWeight = 0.8`），完全丢失了上述动态特性。

**与对局数据的关联**  
平局游戏中观察到「双方均反复 `declared_end:true` → `declared_end:false` 的循环」，显示两个 AI 都在试图后手，但两者互为镜像导致无限等待。这正是 $V_{\text{先手}} < V_{\text{后手}}$ 时的均衡输出。

**泛用性评估**  
极高。先后手动态价值是七圣召唤博弈的核心机制，影响每个动作的决策。现有系统用常数近似动态值，这是训练平台期的可能根源之一。

**可操作建议**  
1. 将 `endTurnPenalty` 改为条件函数：`endTurnPenalty(state) = f(召唤物状态, 能量状态, 血线, 对手出手情况)`。
2. 在 54 特征向量中加入「当前回合中我方是否已行动」「对手最后一个行动是否为 declareEnd」等特征。
3. 利用历史对局数据，对不同局面下的 `declareEnd` 行为结果（赢/平/负）做回归，近似动态惩罚值。

---

### HC-03：「多步斩杀序列规划」 —— 单步最优不等于多步最优

**现象**  
分析赢局与平局对局中的决策序列：
- 赢局（4 轮结束）：血量以 10 → 8 → 7 → 4 的递减模式下降，显示稳定的多轮伤害积累
- 平局（5+ 轮）：双方血量长期维持高位，无有效伤害积累

**推断约束**  
AI 的贪心单步评估可能错过「多步斩杀序列」的价值。七圣召唤中，某些高价值操作序列具有严格的**顺序依赖**：

```
典型多步斩杀模板：
Step 1: 附着元素 A（单独价值低）
Step 2: 施放技能 B 触发反应（依赖上一步元素，组合价值才高）
Step 3: 触发增伤/召唤（依赖前两步状态）
↓
组合伤害 >> 单步评估之和
```

单步评估系统对 Step 1 的评分往往偏低（因为元素附着本身不造成伤害），导致 AI 可能优先选择其他「立即见效」的高评分动作，破坏了最优多步序列。

**理论空白**  
`framework.md` 中的 `L_plan`（展开轴解锁：「关键组件满足、组合技顺序」）识别了这个问题的存在，但没有给出如何在单步评分系统中体现「为序列铺路」的价值。`S_plan`（中间状态：「元素附着、召唤物续存」）同样提及但未量化。

**与 reward shaping 的关联**  
当前 reward shaping 中有 `setup_realization_bonus (0.025)`，理论上可以捕捉「setup → damage」的转化。但系数较小（0.025），且只捕捉单回合内的转化，不足以奖励跨多回合的序列规划。

**泛用性评估**  
高。几乎所有依赖元素反应的卡组都有这个问题。对于爆发型和反应型卡组尤为明显。

**可操作建议**  
1. 在特征向量中加入「当前出战角色元素附着状态」「对手出战角色元素附着状态」特征。
2. 对 reward shaping 中的 `setup_realization_bonus` 提高系数，或改为多回合滑动平均。
3. 考虑为「元素反应链」引入专门的序列奖励：当连续 N 步建立元素附着+触发反应时，给予额外正向奖励。

---

### HC-04：「支援区资源竞争」 —— 支援位上限（4 个）未被充分建模为战略约束

**现象**  
対局中观察到 support_count 从 0 逐步增长到 4 的过程中，AI 的支援放置行为与后期行为存在断层：支援位满后，AI 是否能主动「踢出」旧支援为新支援腾位的决策没有观察到清晰的战略考量。

**推断约束**  
支援位上限（4 个）不仅是技术资源约束，更是**战略资源竞争约束**：

```
约束 A：支援位满时，放置新支援 = 强制淘汰一个旧支援（固定效果丢失）
约束 B：对手也有 4 个支援位，若对手速度更快占满支援位，
        则我方无法放置关键支援（2702 角色问题：token 需要 4 次计数，满位则失效）
约束 C：支援的「剩余存续价值」应动态计算，
        以便在必要时主动淘汰低价值支援
```

**理论空白**  
`framework-critical-gaps.md` (3.3 节) 明确指出：「支援/召唤区价值粗估可用'剩余存续期 × 每轮收益'，但未深化」，并提及「支援位满导致计数冲突（2702例）是高阶约束」。

当前实现中：
- `createSupportValue * supportWeight if supportRoom > 0` — 支援位有空间才加分
- 当 `supportRoom == 0` 时，放置新支援的评分被**完全忽略**（不计算「踢出旧支援 + 放入新支援」的净价值）

**泛用性评估**  
高。任何需要整场维持多种支援效果的卡组（即所有非极速卡组）都会遇到此约束。

**可操作建议**  
1. 修改评分逻辑：当 `supportRoom == 0` 时，计算「放入新支援同时踢出最低价值旧支援」的净价值（新支援价值 - 最低价值旧支援未来剩余价值）。
2. 引入「支援剩余存续价值」特征：`support_remaining_value = Σ(remaining_turns_i × per_turn_value_i)`。
3. 在特征向量中加入「双方支援位使用率」（`supportCount / 4`）以允许模型学习支援资源竞争策略。

---

### HC-05：「角色健在顺序」 —— 角色死亡顺序未被显式建模为战略目标

**现象**  
分析对局数据中的血量变化模式：AI 在做伤害决策时似乎没有明显的「优先集中击杀特定角色」的行为，而是分散伤害。

**推断约束**  
在七圣召唤中，角色死亡顺序是极为关键的战略约束：

```
约束 A：集中消灭一个角色比「平均打伤三个」价值高得多
        （击倒一个 = 强制对手换人 + 减少对手可用功能数）
约束 B：选择「先击倒哪个角色」是全局战略选择
        （击倒对手核心输出角色 vs 击倒薄血辅助角色）
约束 C：自己角色的死亡顺序也需要规划（让哪个先倒）
        （三角色坍缩论的核心）
约束 D：角色倒下后，对手换人动作本身是一个「危险窗口」
        （对手换人时我方可以获得行动权）
```

当前实现中：
- `canKillTarget = 1 if damageEstimate ≥ oppActiveHp` — 有斩杀检测
- `lethalBonus = +4` — 有斩杀奖励
- 但**没有**「集中打一个角色还是分散打三个角色」的全局最优化考量

**理论空白**  
`three-character-collapse.md` 详细分析了角色减少的不可逆性，指出「三人→二人→一人的坍缺每步都是结构性转变」。但框架中没有将「加速对手角色坍缆」转化为可度量的战略目标特征。

**泛用性评估**  
极高。击倒目标选择是所有七圣召唤决策中最重要的高层战略之一，几乎所有卡组都需要考虑。

**可操作建议**  
1. 在特征向量中加入「对手各角色血量分布」（具体到低血量角色的比例），而非仅 `opponentTeamAvgHpRatio`。
2. 加入「集中击杀系数」：当所有伤害集中到同一个最低血量角色时给予额外奖励。
3. 修改斩杀奖励逻辑：区分「精确斩杀」（damage ≥ 剩余血量）和「过度伤害」（damage >> 剩余血量），后者应有小幅惩罚。
4. 将 `three-character-collapse.md` 的生态位理论翻译为可训练特征：「对手存活角色数」作为独立奖励塑形信号。

---

### HC-06：「骰子类型组合效率」 —— 骰子颜色组合的实际价值未被建模

**现象**  
分析 RL 特征向量中的骰子相关特征，发现仅有 `diceCount`（总量）和 `omniCount`（万能骰数量），缺少骰子颜色组合的效率指标。

当前使用 `poorDiceFactor = max(0, 1 - omniCount/diceCount)` 作为骰子质量代理指标，但这只能体现「万能骰比例」而非「骰子与技能需求的匹配程度」。

**推断约束**  
骰子的实际价值不是其数量，而是其与**当前手牌+技能需求**的匹配程度：

```
场景 A：拥有 8 颗骰子，但全是 8 种不同颜色 → 实际上大多数技能都打不出
场景 B：拥有 5 颗骰子，但 3 颗水+2 颗万能 → 可以完整施放水属性3费技能
场景 C：拥有 6 颗骰子，但与手牌中唯一可打的牌颜色不匹配 → 实际可用动作集为空
```

当前系统的「骰子对齐度 0.25-0.75」数据表明，大量游戏帧中骰子利用效率偏低，但系统没有直接优化这个维度。

**理论空白**  
`framework.md` 中 `M_now`（即时资源）和调和机制（`def 1. 操作`）涉及骰子，`framework-critical-gaps.md` 的 2.3 节明确指出「骰子随机性与调和」是未深化模块，「调和策略值得纳入框架」。

**泛用性评估**  
高。骰子效率是每个回合每个决策的基本约束，但不同卡组的骰子需求差异较大（单色技能 vs 多色支援牌）。

**可操作建议**  
1. 在特征向量中加入「骰子-技能匹配度」：`dice_skill_alignment = 可负担的技能数 / 全部可用技能数`。
2. 加入「骰子与手牌需求的匹配熵」：骰子颜色分布越集中于当前手牌所需颜色，值越高。
3. 将「调和」（elementalTuning）的评分改为基于手牌需求的动态计算——当骰子颜色与手牌需求高度不匹配时，调和价值显著上升。
4. 在 reward shaping 中加入「骰子浪费惩罚」：若连续回合骰子剩余量偏高（未被充分利用），给予小幅负向信号。

---

### HC-07：「反应链时序约束」 —— 出战角色的元素状态是时序敏感资源

**现象**  
在对局记录中，元素附着相关的状态会在角色切换、受攻击、时间推移等事件中改变，但 AI 对出战角色「有/无元素附着」的决策价值似乎仅通过 `reactionValue > 0` 的二值信号处理，缺乏对元素状态「持续时间」和「叠加规律」的建模。

**推断约束**  
元素附着在七圣召唤中具有独特的时序约束：

```
约束 A：元素附着在下一次被相同元素攻击时「叠加」或「被强型元素覆盖」
约束 B：快速行动的附着与战斗行动的附着在时序面存在插入点差异
约束 C：对手出战角色的元素状态是「可读」的（不完美信息中的完美子集）
约束 D：元素附着被消耗（触发反应后清除）是不可逆的状态转变
约束 E：三角色坍缩后，反应链 A→B→A 的维护成本上升
        （只剩两个角色时，反应循环节奏从三元降为二元）
```

**理论空白**  
`three-character-collapse.md` 提到了「元素反应的三元结构：三人时可形成 A→B→C→A 反应链；二人时链断成 A→B→A（节奏变慢，维护难度提高）」，这是正确的分析但未转化为可训练特征。

当前 54 特征向量中有 `hasReaction = 1 if reactionValue > 0`，但缺少：
- 「当前出战角色上的元素附着类型」
- 「对手出战角色上的元素附着类型」
- 「预期的后续反应触发可能性」

**泛用性评估**  
高。元素反应是七圣召唤最核心的机制之一，几乎所有卡组都涉及，但对依赖特定反应的卡组（如蒸发、激化体系）影响更大。

**可操作建议**  
1. 在特征向量中加入「双方出战角色的元素附着状态」（可用独热编码或元素 ID）。
2. 引入「反应链完整性评分」：当具备维持 A→B→A 反应循环所需角色时，给予结构性加分。
3. 将元素附着的获取（attach）和消耗（trigger reaction）分别作为 reward shaping 信号。

---

### HC-08：「回合数上限压力」 —— 接近回合上限（15 回合）的策略质变未建模

**现象**  
平局游戏中，游戏轮数明显高于赢局（5-7 轮 vs 4 轮）。当前训练样本中有平局案例，但 draw reward = 0 的设计对于「接近回合上限时的策略变化」缺乏引导。

**推断约束**  
回合数是七圣召唤中的隐性压力变量：

```
约束 A：接近回合上限时，「慢慢积累优势」的策略应转变为「快速决战」
约束 B：若己方处于弱势且临近上限，主动追求平局可能是最优策略
约束 C：若己方处于优势且临近上限，阻止平局（加速斩杀）是最优策略
约束 D：回合数作为「时间资源」，其边际价值在接近上限时非线性急剧上升
```

**理论空白**  
`framework-critical-gaps.md` 3.4 节明确指出「接近 15 回合上限时策略是否质变未讨论，平局条件判定规则未明确」。

当前 54 特征向量中有 `round` 特征，但模型需要学习「当 round 接近上限时如何调整策略」，而训练数据中接近上限的样本（平局样本）的奖励信号为 0，无法给出正确的梯度方向。

**泛用性评估**  
高。对于慢速卡组（HongNiu 型）尤为关键——高平局率正是此约束被忽视的直接后果。

**可操作建议**  
1. 将 `round` 特征替换为「剩余回合比例」：`round_ratio = (max_round - current_round) / max_round`，并在接近上限时使评估权重非线性变化。
2. 对接近上限的平局样本，若己方当前血量优势则赋予小正奖励（「应该赢但未能赢」）；若己方处于劣势则赋予小负奖励（「平局是次优结果」）——而非始终赋予 0。
3. 在 reward shaping 中加入「时间压力系数」：当 `round > 10` 时，伤害/斩杀的 shaping 奖励系数增大。

---

### HC-09：「手牌质量与可操作性」 —— 手牌数量 ≠ 手牌价值

**现象**  
当前特征向量中，手牌用 `cardsInHand`（数量）代理。分析对局中支援卡的放置模式，发现有大量游戏帧中手牌数量较高但 AI 选择结束回合，暗示手牌实际「可操作性」低（有牌但打不出来，或打了无益）。

**推断约束**  
手牌的实际价值分布极为不均匀：

```
约束 A：同样 5 张手牌，3 张关键组件 vs 3 张废牌的局面价值天壤之别
约束 B：可操作手牌数 = 骰子数 × 每骰子可打牌数（受骰子颜色匹配约束）
约束 C：手牌中的关键牌（如神子装备牌）的「当前可用性」随骰子状态变化
约束 D：调和（消耗手牌+骰子换万能骰）的价值取决于手牌质量：
        废牌调和价值高，关键牌调和价值低
```

**理论空白**  
`framework-critical-gaps.md` 3.2 节明确指出「手牌'质量'维度未细化（3 张废牌 vs 1 张关键组件的区别）。调和转换何时值得仍无明确阈值。」

**泛用性评估**  
极高。手牌质量评估是所有卡组决策的基础，但对依赖特定关键牌的组合卡组影响最大。

**可操作建议**  
1. 加入「可立即出手的牌数」特征：不仅计手牌总数，还计「当前骰子状态下可支付费用的牌数」。
2. 加入「手牌中组件完成度」特征（参考 GamePlan 的 `hand_card` 组件检测）。
3. 调和行为的评分应动态计算：`elementalTuning value = f(被调和牌的冗余度, 缺少的骰子颜色需求)`.

---

### HC-10：「阶段切换的迟滞效应」 —— 从 Setup 到 Execution 阶段切换可能过早或过晚

**现象**  
当前阶段检测阈值固定：
- `setupCompletion ≥ 0.8` → Execution（切换到攻击模式）
- `setupCompletion ≥ 0.5` → Transition

但这些阈值是硬编码常数，不随对手压力或剩余回合数调整。

**推断约束**  
阶段切换时机是对抗性动态决策，存在「迟滞」问题：

```
约束 A：对手施压时，即使 setupCompletion < 0.5，也可能需要提前进入 Execution
约束 B：对手慢速展开时，即使 setupCompletion ≥ 0.8，延迟 Execution 继续积累可能更优
约束 C：「完成度 0.8」的判断基于组件数量，但关键组件的权重应随对手威胁动态变化
约束 D：如果对手意图（快攻/控制/组合）未被正确识别，阶段切换判断将大幅偏移
```

**理论空白**  
`game-plan.ts` 的阶段检测逻辑是静态规则树，`framework.md` 的路线图文件（P0-P4）中明确了阶段切换的优先级，但对「对手压力自适应」的阈值调整没有建模。

**泛用性评估**  
中等偏高。对于快速卡组（LeiHe）影响较小（阶段切换较快），对慢速卡组（HongNiu）影响最大（迟滞效应更明显）。

**可操作建议**  
1. 引入「威胁感知修正系数」：将 `opponentActiveHpRatio`、`opponentAliveCount`、`opponentBurstReady` 组合为「对手威胁分」，动态调整 Execution 切换阈值。
2. 将阶段切换逻辑从硬规则改为可学习：在 GamePlan 状态中加入「当前阶段」作为额外特征，让模型自行学习最优切换时机。
3. 在 reward shaping 中加入「阶段-时机适配度奖励」：过早进入 Execution（setup 不足就开始强攻）应有惩罚，过晚（setup 完成后仍在积累）也应有惩罚。

---

## 四、隐藏约束汇总表

| ID | 约束名称 | 数据证据强度 | 理论空白程度 | 泛用性 | 实现优先级 |
|----|---------|------------|------------|-------|---------|
| HC-01 | 对称策略均衡 | ⭐⭐⭐⭐⭐ | 中（节奏概念已识别） | 高（所有镜像对局） | P1 |
| HC-02 | 先后手动态价值 | ⭐⭐⭐⭐ | 高（常数惩罚未动态化） | 极高（所有对局） | P1 |
| HC-03 | 多步斩杀序列规划 | ⭐⭐⭐ | 高（L_plan识别但未量化） | 高（反应型卡组） | P2 |
| HC-04 | 支援区资源竞争 | ⭐⭐⭐ | 中（gaps文档提及） | 高（所有非速攻） | P2 |
| HC-05 | 角色死亡顺序战略 | ⭐⭐⭐⭐ | 高（坍缩论未转化特征） | 极高（所有卡组） | P1 |
| HC-06 | 骰子颜色匹配效率 | ⭐⭐⭐ | 高（gaps文档提及） | 高（所有卡组） | P2 |
| HC-07 | 反应链时序约束 | ⭐⭐⭐ | 中（三角色文档提及） | 高（反应型） | P2 |
| HC-08 | 回合数上限压力 | ⭐⭐⭐⭐ | 高（gaps明确指出） | 高（慢速卡组） | P1 |
| HC-09 | 手牌质量与可操作性 | ⭐⭐⭐ | 高（gaps明确指出） | 极高（所有卡组） | P2 |
| HC-10 | 阶段切换迟滞效应 | ⭐⭐ | 中（静态阈值已识别） | 中（慢速卡组为主） | P3 |

---

## 五、对训练瓶颈的假设

综合所有发现，当前 iter-009 → iter-032 的训练平台期可能同时由以下因素叠加导致：

### 5.1 主要假设（数据支持较强）

1. **对称均衡导致训练信号退化**（HC-01, HC-08）  
   HongNiu 镜像 45.8% 平局 → draw reward = 0 → 无有效梯度 → 模型无法从镜像对局中学习  
   
2. **先后手决策被常数惩罚误导**（HC-02）  
   `endTurnPenalty = 5` 在不同局面有不同的真实最优值，常数近似导致系统性错误  

3. **缺乏角色击倒集中化策略**（HC-05）  
   AI 分散伤害而非集中斩杀，延长对局、降低决定性奖励信号频率  

### 5.2 次要假设（需进一步验证）

4. **多步序列价值低估**（HC-03）导致不最优的行动顺序
5. **骰子颜色效率**（HC-06）导致部分回合实际可用动作集缩水
6. **手牌可操作性**（HC-09）导致高手牌数但低行动密度的局面

---

## 六、人工评估维度

请对每条隐藏约束（HC-01 到 HC-10）从以下维度进行人工评分（满分 5 分）：

| 评估维度 | 说明 |
|---------|------|
| **正确性** | 该约束是否真实存在于七圣召唤机制中？ |
| **重要性** | 忽略该约束对强度的影响有多大？ |
| **泛用性** | 该约束适用于多少卡组/局面？ |
| **可实现性** | 在当前代码框架下，实现对应特征或改动的难度如何？（5=容易 1=困难） |

**评估表格：**

| ID | 正确性(1-5) | 重要性(1-5) | 泛用性(1-5) | 可实现性(1-5) | 备注 |
|----|-----------|-----------|-----------|------------|------|
| HC-01 |3 |2 |1 |5 |这个不要做|
| HC-02 |4 |5 |5 |5 | |
| HC-03 |5 |5 |5 |5 | |
| HC-04 |5 |5 |4 |5 | |
| HC-05 |5 |5 |5 |5 | |
| HC-06 |5 |5 |5 |4 | |
| HC-07 |5 |5 |5 |5 | |
| HC-08 |2 |1 |1 |1 |这个不做 |
| HC-09 |1 |5 |1 |5 |手牌数和手牌价值没有必然联系，实际上AI目前的更多行为是没有充分利用，甚至浪费手牌资源的 |
| HC-10 |4 |5 |5 |5 | |

---

## 七、参考：现有系统（已实现）vs 本文提出（待评估）

| 领域 | 现有实现 | 本文提出的补充 |
|------|---------|-------------|
| endTurn 惩罚 | 常数 -5 | 动态函数 f(局面) |
| 骰子质量 | omniCount/diceCount | 骰子-技能匹配度 |
| 手牌数量 | cardsInHand | 可操作手牌数 + 组件完整度 |
| 对手血量 | avgHpRatio | 各角色血量分布（含最低值） |
| 元素反应 | hasReaction (bool) | 附着状态 + 反应链完整性 |
| 回合数 | round (raw) | 剩余回合比例 + 非线性紧迫度 |
| 阶段切换 | 固定阈值规则 | 对手威胁自适应阈值 |
| 支援位 | supportRoom > 0 才计分 | 净价值（新支援 - 被踢出的旧支援） |
| 角色死亡 | 无集中化奖励 | 集中击杀系数 + 生态位坍缩奖励 |
| 镜像均衡 | 无探索机制 | ε-greedy 扰动 + 均衡检测器 |

---

## 八、人工评估汇总与决策

### 评估结果解读

根据评分，采纳的约束（按综合得分排序）：

| 优先级 | ID | 约束 | 综合得分 | 用户备注 |
|--------|-----|------|---------|---------|
| **P0** | HC-03 | 多步斩杀序列规划 | 20/20 | — |
| **P0** | HC-05 | 角色死亡顺序战略 | 20/20 | — |
| **P0** | HC-07 | 反应链时序约束 | 20/20 | — |
| **P0** | HC-02 | 先后手动态价值 | 19/20 | — |
| **P0** | HC-06 | 骰子颜色匹配效率 | 19/20 | 可实现性4 |
| **P0** | HC-10 | 阶段切换迟滞效应 | 19/20 | — |
| **P1** | HC-04 | 支援区资源竞争 | 19/20 | 泛用性4 |
| **跳过** | HC-01 | 对称策略均衡 | — | 用户明确：不做（本质问题是AI出伤不足） |
| **跳过** | HC-08 | 回合数上限压力 | — | 用户明确：不做 |
| **重新定义** | HC-09 | 手牌资源浪费 | 重要性5 | 核心问题不是质量度量，而是AI浪费手牌资源 |

### 用户关键洞察

1. **HC-01/HC-09 的共同根因**：HongNiu/ShuiZhai/LeiHe 都是「伤害充足、爆发高的中速卡组」，人类对局中几乎不可能平局。AI 陷入平局的本质原因是**不会主动出伤**，而非对称均衡机制本身。
2. **HC-09 的重新定义**：手牌数和价值确实无必然联系，但实际问题是 AI **浪费手牌资源**（打了不该打的牌，或不打该打的牌），而非无法评估手牌质量。
3. **HC-02 场景2**：AI 生成的「召唤物到期 → 先出手价值高」逻辑被用户标记为疑似幻觉，已从方案中移除。

---

## 九、下一步改进方案

基于评估结果，将 7 条被采纳的约束转化为 **4 个工程阶段**，每阶段可独立完成和验证。

### 阶段 0：特征向量扩展（Foundation）

**目标**：将 54 维特征向量扩展到约 70 维，为后续学习提供更丰富的信号。

**涉及文件**：`packages/gi-agent/src/learning/scoring/feature-extractor.ts`

**新增特征列表**：

```typescript
// ── HC-05: 角色死亡顺序 ──
opponentMinHpRatio: number      // 对手最低血量角色的 HP/maxHP（集中火力目标）
opponentMinHp: number           // 对手最低血量角色的绝对 HP 值
selfMinHpRatio: number          // 自身最低血量角色 HP/maxHP
damageToMinHpTarget: number     // 本动作对最低血量目标的预估伤害占其剩余HP比例
                                // (canKillTarget 的精细化版本)

// ── HC-07: 元素反应链 ──
oppActiveHasAura: number        // 对手出战角色是否有元素附着 (0/1)
selfActiveHasAura: number       // 自身出战角色是否有元素附着 (0/1)
reactionChainReady: number      // 是否满足反应链条件
                                // (复用 reaction-chain-templates.ts 的 matchReactionChains)

// ── HC-06: 骰子颜色匹配 ──
diceSkillAlignment: number      // 当前骰子可负担的候选动作数 / 总候选数
                                // （需从 digest 中的 candidate_actions 计算）
diceColorEntropy: number        // 骰子颜色分布熵（越低=越集中=越好）
                                // = -Σ(p_i * log(p_i)) 其中 p_i = count_i / total

// ── HC-02: 先后手 ──
opponentDeclaredEnd: number     // 对手本回合是否已声明结束 (0/1)
                                // 来自 observation.public_state.opponent_declared_end
selfActionCountInRound: number  // 本回合自方已执行的动作数
                                // 来自 observation.point.action_count_in_round

// ── HC-10: 阶段切换 ──
gamePhaseEstimate: number       // 当前阶段估计 (0=setup, 1=transition, 2=execution, 3=closing)
                                // 来自 observation.derived.game_phase_estimate
setupCompletion: number         // 展开完成度 (0~1)
                                // 来自 observation.derived.game_setup_completion
opponentThreatScore: number     // 对手威胁评分 = opp_damage_capacity_now + opp_ko_pressure_now
                                // 来自 observation.derived
```

**数据来源验证**（全部字段在 observation 中已存在，无需新增接口）：
- `aura`: `CharacterObservationV1.aura` ✓
- `dice.counts_by_type`: `DicePoolObservationV1.counts_by_type` ✓
- `opponent_declared_end`: `PublicBoardObservationV1.opponent_declared_end` ✓
- `action_count_in_round`: `ObservationV1.point.action_count_in_round` ✓
- `game_phase_estimate`: `DerivedObservationFeaturesV1.game_phase_estimate` ✓
- `game_setup_completion`: `DerivedObservationFeaturesV1.game_setup_completion` ✓
- `reaction-chain-templates.ts`: 已存在完整的 `matchReactionChains()` 函数 ✓

**实现要点**：
- `ScoringFeatureVector` 接口新增上述字段
- `extract()` 方法中新增提取逻辑（大部分是直接读 observation 字段）
- `featureNames()` 数组尾部追加新字段名
- 向量维度从 54 → ~70
- **注意**：扩展特征向量后，已有的训练模型 artifact 将不兼容，需要重新训练

**验证方式**：运行 `pnpm test packages/gi-agent` 确认无回归

---

### 阶段 1：评分逻辑增强（Scoring）

**目标**：改进 baseline-policy 的启发式评分，使其在学习模型尚未训练时也能更好地决策。

#### 1A: 动态 endTurnPenalty（HC-02）

**涉及文件**：`packages/gi-agent/src/runtime/policy/baseline-policy.ts`

**当前逻辑**：
```typescript
if (actionCase === "declareEnd") {
  score -= this.options.endTurnPenalty  // 固定 -5
}
```

**改进逻辑**：
```typescript
if (actionCase === "declareEnd") {
  let penalty = this.options.endTurnPenalty  // 基础值 5

  // 如果对手已 declareEnd，我方 declareEnd 只意味着结束本回合
  // 此时惩罚应降低（因为此时我方所有行动对手都无法响应）
  if (opponentDeclaredEnd) {
    // 对手已结束 → 我方继续行动无对抗收益，但可以继续积累
    // 适度降低惩罚，鼓励在有价值行动时继续，无价值时可以果断结束
    penalty *= 0.6
    reasons.push("opp_ended_discount")
  }

  // 能量已满但大招可以造成大伤害 → 不该结束
  if (selfActiveEnergyGap === 0) {
    penalty += 1.5
    reasons.push("burst_ready=+1.50")
  }

  score -= penalty
  reasons.push(`declareEnd=-${penalty.toFixed(2)}`)
}
```

**关键**：需要从 digest 或 observation 中获取 `opponentDeclaredEnd` 信号。当前 `PolicyTurnDigest` 中可能需要透传此字段（可从 `observation.public_state.opponent_declared_end` 获取）。

#### 1B: 集中击杀激励（HC-05）

**涉及位置**：`baseline-policy.ts` 的 `rankCandidate()` 中，在现有 lethal bonus 后追加

```typescript
// 现有：lethal bonus +4（可斩杀当前出战角色）
if (damage >= currentOpponentActiveHp(digest) && damage > 0) {
  score += 4
  reasons.push("lethal=+4.00")
}

// 新增：集中击杀激励 —— 对低血量角色造成伤害时额外奖励
// 鼓励 AI 优先打低血量角色（与选择打谁的决策耦合）
const oppActiveHp = currentOpponentActiveHp(digest)
const oppActiveMaxHp = currentOpponentActiveMaxHp(digest)
if (damage > 0 && oppActiveHp <= oppActiveMaxHp * 0.5) {
  const focusBonus = Math.min(1.5, (1 - oppActiveHp / oppActiveMaxHp) * 2)
  score += focusBonus
  reasons.push(`focusKill=+${focusBonus.toFixed(2)}`)
}
```

#### 1C: 支援位满时的净价值计算（HC-04）

**当前逻辑**（支援位满时完全忽略新支援）：
```typescript
if (createSupport !== 0 && supportRoom > 0) {
  // 只有有空间才计分
  const supportScore = createSupport * (1 + earlyRoundFactor(digest) * 0.5) * this.options.supportWeight
  score += supportScore
}
```

**改进逻辑**：
```typescript
if (createSupport !== 0) {
  if (supportRoom > 0) {
    // 有空位：正常计分
    const supportScore = createSupport * (1 + earlyRoundFactor(digest) * 0.5) * this.options.supportWeight
    score += supportScore
    reasons.push(`support=+${supportScore.toFixed(2)}`)
  } else {
    // 无空位：计算「放入新支援 - 踢出最弱旧支援」的净价值
    // 此处用 createSupport 的原始价值打折代替精确计算
    const replacementScore = createSupport * 0.4 * this.options.supportWeight
    if (replacementScore > 0.5) {
      score += replacementScore
      reasons.push(`supportReplace=+${replacementScore.toFixed(2)}`)
    }
  }
}
```

---

### 阶段 2：Reward Shaping 增强

**目标**：为训练提供更丰富的中间奖励信号。

**涉及文件**：`packages/gi-agent/src/learning/rl/reward-config.ts`

#### 2A: 新增 element_application 奖励（HC-07 反应链）

**逻辑**：当自方对对手角色成功附着元素（为后续反应铺路）时给予正向信号。

```typescript
// 新增 shaping 系数
element_application_bonus: 0.02    // 元素附着奖励

// 计算逻辑
function computeElementApplicationSwing(previous: ObservationV1, next: ObservationV1): number {
  // 检查对手出战角色的 aura 是否从 null → 非 null（我方成功挂上元素）
  const prevOppAura = getActiveCharAura(previous.opponent)
  const nextOppAura = getActiveCharAura(next.opponent)
  const selfApplied = (prevOppAura === null && nextOppAura !== null) ? 1 : 0

  // 检查自方出战角色的 aura 是否从 null → 非 null（对手挂上元素，负向信号）
  const prevSelfAura = getActiveCharAura(previous.self)
  const nextSelfAura = getActiveCharAura(next.self)
  const oppApplied = (prevSelfAura === null && nextSelfAura !== null) ? 1 : 0

  return selfApplied - oppApplied
}
```

#### 2B: 新增 focus_damage 奖励（HC-05 集中击杀）

**逻辑**：奖励将伤害集中到同一个目标上（而非分散）。

```typescript
// 新增 shaping 系数
focus_damage_bonus: 0.03    // 集中伤害奖励

// 计算逻辑
function computeFocusDamageSwing(previous: ObservationV1, next: ObservationV1): number {
  // 如果对手某个角色的血量从 alive 变为 dead（被击倒），
  // 这是最极端的「集中」结果，给大奖
  const oppKos = Math.max(0, countAlive(previous.opponent) - countAlive(next.opponent))
  if (oppKos > 0) return oppKos * 2

  // 否则，检查伤害是否集中在单一角色上
  // 如果对手出战角色的血量下降 > 0 且后台角色血量未变，给小奖
  const prevActiveHp = getActiveCharHp(previous.opponent)
  const nextActiveHp = getActiveCharHp(next.opponent)
  const activeHpDrop = Math.max(0, prevActiveHp - nextActiveHp)

  const prevBackHp = sumBacklineHealth(previous.opponent)
  const nextBackHp = sumBacklineHealth(next.opponent)
  const backHpDrop = Math.max(0, prevBackHp - nextBackHp)

  if (activeHpDrop > 0 && backHpDrop === 0) return 1  // 纯集中伤害
  return 0
}
```

#### 2C: 加入 `enabled_events` 注册

在 `DEFAULT_ENABLED_EVENTS` 和 `DEFAULT_REWARD_CONFIG_V1.shaping` 中注册新事件。

---

### 阶段 3：阶段切换自适应（HC-10）

**目标**：让阶段切换阈值随对手威胁动态调整。

**涉及文件**：`packages/gi-agent/src/runtime/policy/game-plan.ts`

**当前逻辑**：
```typescript
export function detectGamePhase(plan, observation, setupCompletion): GamePhaseKind {
  if (oppAllLow) return "closing"
  if (setupCompletion >= 0.8) return "execution"
  if (setupCompletion >= 0.5) return "transition"
  return "setup"
}
```

**改进逻辑**：
```typescript
export function detectGamePhase(plan, observation, setupCompletion): GamePhaseKind {
  if (oppAllLow) return "closing"

  // 对手威胁评分：对手伤害输出能力 + 击倒压力
  const oppThreat = observation.derived.opp_damage_capacity_now
    + observation.derived.opp_ko_pressure_now * 2

  // 自身血线压力
  const selfAvgHpRatio = avgAliveHpRatio(observation.self)

  // 动态阈值修正：对手威胁越高 或 自身血线越低 → 提前进入 execution
  // oppThreat 典型范围 [0, 10]，归一化到 [0, 0.2] 的阈值下调量
  const urgencyShift = Math.min(0.2, oppThreat * 0.02 + (1 - selfAvgHpRatio) * 0.15)

  const executionThreshold = Math.max(0.4, 0.8 - urgencyShift)
  const transitionThreshold = Math.max(0.2, 0.5 - urgencyShift)

  if (setupCompletion >= executionThreshold) return "execution"
  if (setupCompletion >= transitionThreshold) return "transition"
  return "setup"
}
```

**效果**：
- 对手高威胁时，AI 会在 setupCompletion 60% 就进入 execution（提前反击）
- 自身低血线时，AI 不再执着于完成 setup，转而寻求输出
- 无威胁时，行为与之前相同（阈值不变）

---

### 实施路线图

```
阶段 0 (特征扩展)           阶段 1 (评分增强)         阶段 2 (奖励信号)       阶段 3 (阶段自适应)
┌──────────────┐       ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ feature-     │       │ baseline-    │       │ reward-      │       │ game-plan.ts │
│ extractor.ts │──────▶│ policy.ts    │──────▶│ config.ts    │──────▶│              │
│ 54→70 features│       │ 动态endTurn  │       │ 新shaping信号 │       │ 自适应阈值    │
│              │       │ 集中击杀     │       │ 元素/集中奖励 │       │              │
│              │       │ 支援替换     │       │              │       │              │
└──────────────┘       └──────────────┘       └──────────────┘       └──────────────┘
      │                       │                       │                      │
      ▼                       ▼                       ▼                      ▼
  重新训练模型            即时改善baseline       需重新训练验证          需重新训练验证
  (不兼容旧artifact)      (不依赖训练)          (与阶段0一起)          (与阶段0一起)
```

**建议实施顺序**：
1. **先做阶段 1**（评分逻辑增强）— 不改特征维度，不破坏现有 artifact，可立即用 baseline 测试效果
2. **再做阶段 0 + 2 + 3 一起**（特征扩展 + 奖励信号 + 阶段自适应）— 因为特征维度变化后必须重新训练，所以把需要重训的改动合并

### 每阶段验证方案

| 阶段 | 验证方式 | 成功标准 |
|------|---------|---------|
| 阶段 0 | `pnpm test packages/gi-agent` | 单元测试通过，特征维度正确 |
| 阶段 1 | 用 baseline policy 跑 benchmark 对局 | HongNiu 镜像平局率降低（目标 < 20%）；LeiHe vs HongNiu 胜率变化 |
| 阶段 2 | iter-training 完整跑一轮新迭代 | 新迭代的 pairwiseSupport 应高于 iter-032 的 0.8394 |
| 阶段 3 | 观察 game_phase_estimate 分布变化 | 对手高威胁时 execution 进入时间提前 |

---

### 实施记录

**执行日期**: 2026-04-08

**已完成修改**（全部 4 阶段，所有文件 TypeScript 类型检查通过）：

| 阶段 | 修改文件 | 修改内容 | 状态 |
|------|---------|---------|------|
| 0 | `packages/gi-agent/src/learning/scoring/feature-extractor.ts` | 特征向量 54→67 维；新增 13 个 HC 相关特征；`extract()` 增加可选 `observation` 参数 | ✅ |
| 1A | `packages/gi-agent/src/runtime/policy/baseline-policy.ts` | 动态 endTurnPenalty（对手结束×0.6；大招就绪+1.5） | ✅ |
| 1B | `packages/gi-agent/src/runtime/policy/baseline-policy.ts` | 集中击杀激励（低血量目标加分，最高+1.5） | ✅ |
| 1C | `packages/gi-agent/src/runtime/policy/baseline-policy.ts` | 支援位满时替换净价值（0.4×打折） | ✅ |
| 1\* | `packages/gi-agent/src/runtime/policy/types.ts` | `PolicyTurnDigest` 增加 `opponent_declared_end` 字段 | ✅ |
| 1\* | `packages/gi-agent/src/runtime/policy/candidate-semantics.ts` | 两个 builder 函数填充 `opponent_declared_end` | ✅ |
| 2A | `packages/gi-agent/src/learning/rl/reward-config.ts` | 新增 `element_application` 奖励事件（系数 0.02） | ✅ |
| 2B | `packages/gi-agent/src/learning/rl/reward-config.ts` | 新增 `focus_damage` 奖励事件（系数 0.03） | ✅ |
| 2\* | `packages/gi-agent/src/learning/rl/types.ts` | `RewardConfigV1.shaping` 和 `RewardBreakdownV1` 增加新字段 | ✅ |
| 3 | `packages/gi-agent/src/runtime/policy/game-plan.ts` | `detectGamePhase` 自适应阈值（urgencyShift 基于 oppThreat + selfAvgHpRatio） | ✅ |

**后续步骤**：
1. 运行 `pnpm test packages/gi-agent` 验证所有单元测试通过
2. 用 baseline policy 跑 benchmark 验证 Phase 1 效果（HongNiu 镜像平局率）
3. 完整迭代一轮训练验证 Phase 0+2+3 效果（需重新训练模型）
