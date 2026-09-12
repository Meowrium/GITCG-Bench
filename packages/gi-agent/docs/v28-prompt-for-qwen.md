# V28 遗留架构难题 — 对标 V27 的提示词

> 投喂用文档。包含项目背景、当前状态、三项待解决的核心难题。期望输出：形式化数学方案 + 可计算伪代码 + 可证伪实验设计。
>
> ⚠️ 这不是代码审查请求。不要列 bug 清单、不要建议重构文件结构、不要关注 venv/gitignore/license header 等运维问题。我需要的是**架构级的数学形式化**。

---

## 项目背景

### 我们在做什么

为《七圣召唤》（Genius Invokation TCG）构建 AI 决策系统。

当前架构演进路线：
```
V15-25:       启发式权重 + GBDT Ranker + Self-play 训练
V26 (GPT):    架构审查，识别"线性叠加已到天花板"，提出 transition-based 范式
V27 (GPT):    Transition 范式数学形式化 + H1-H9 隐藏约束形式化（1639 行设计稿）
V28 (实施):   部分采纳 V26/V27 建议，修复了 EvaluatorPolicy 继承绕过、启用了 transition-scorer、清理了包边界
```

### 当前 V28 代码状态（关键文件）

```
packages/gi-agent/src/
  runtime/policy/
    gi-ml-policy.ts          (1723 行) — 主策略，20+ 信号线性叠加
    baseline-policy.ts        (1091 行) — 基础策略 + 5 种 profile
    evaluator-policy.ts       (99 行)  — 评估器策略（已修复继承绕过）
    scorers/                  — 评分组件目录（拆分进行中）
  learning/
    scoring/
      transition-scorer.ts   — Transition-based 评分（已启用但未充分发挥）
    rl/                       — RL 训练类型和 pipeline
  mcts/
    mcts.ts                   (405 行) — MCTS 引擎（PUCT）
  runtime/plan/               — SPL 编译器/状态机（9 个文件）

packages/gi-ml/src/
  contracts/                  — 数据契约
  ranker/slot-linear-ranker.ts (268 行) — 线性排序器
  value/                      — Linear/GBDT/MLP/MoE 价值模型
  runtime/bridge.ts           — 在线推理 bridge
  python/                     — Python 训练脚本
```

### V25 的核心发现（V28 仍然成立）

1. **隐式卡组编码假说被拒绝**：统一 ranker 训练的模型，镜像对局 WR 跨度 20%-80%（StdDev=21%）
2. **线性叠加已达上限**：per-deck GBDT ranker NDCG@1 仅 0.31-0.34，仍有大量系统性决策失误
3. **根因**：当前假设"每个动作可独立评估"，实际动作价值取决于它对后续回合的影响

### V28 与 V27 的差距

V27 设计了完整的 transition-based 范式（`S → T(S,a) → V(S')-V(S)` + 9 约束），但 V28 只实现了最小子集：
- ✅ transition-scorer 已启用（`enabled: true`）
- ❌ H1-H9 约束大部分仍是启发式，没有进入 transition delta
- ❌ MCTS 仍用轻量快照模拟，不是真实 engine continuation
- ❌ deck/matchup prior 仍为 side-level bonus（所有候选动作加同一个常数，不影响排序）
- ❌ temporal portfolio 还不是真正的 `EV(after) - EV(before)`
- ❌ 没有 window/intent 统一模型

**核心问题**：我们有一个 1639 行的形式化设计稿（v27），但实施只走了 10%。以下三个难题需要你给出**能达到 v27 深度**的方案。

---

## 难题一：Transition-based Scoring 的完整实施方案

### 背景

V26/V27 提出的核心洞察：动作价值 = 局面变化价值，不是动作属性打分。

当前 transition-scorer 已有一个骨架（`TransitionState`、`TransitionResult`、四级 transition quality），但它在实战中的表现尚未验证，且存在以下结构性问题：

1. **投影质量不统一**：`projectTransitionState` 在 engine/replay/observation 三种模式下置信度差异大，但 transition scorer 没有据此调整贡献权重
2. **门控缺失**：V27 设计的 `gate(S,a)` 机制（lethal_gate、declare_end_gate、dice_bottleneck_gate 等）完全未实现
3. **与现有 ranker 的融合是线性叠加**：`finalScore = existingScore + w_T * transitionDelta`，没有门控、没有硬约束优先、没有不确定性折扣
4. **hard constraint 未实现**：V27 列出的硬约束（能斩杀却 declareEnd、牺牲唯一 combo key 调谐等）目前只散布在 BaselinePolicy 各处

### 需要形式化的内容

#### 1.1 投影可信度与权重自适应

给定当前三种投影源（`engine_snapshot` 0.95-1.0, `replay` 0.85-1.0, `observation` 0.6-0.9），设计一个权重自适应机制：

```
transitionContribution = confidence * gate(S,a) * w_T * normalizedDelta
                         - (1-confidence) * penalty
```

要求：
- 低置信度 transition 不能压过高置信度的硬斩杀/硬防守
- 如果 `S.source.confidence < threshold`，某些高影响 gate（如 lethal_gate）应强制走 engine exact 或 fallback 到静态评估
- 给出 threshold 的设定逻辑（数据驱动？理论推导？）

#### 1.2 门控函数设计

V27 定义的门控：

```
gate(S,a) = max(lethal_gate, declare_end_gate, dice_bottleneck_gate,
                aura_window_gate, support_slot_gate, opponent_cashout_gate, tuning_gate)
```

需要：
- 每个子 gate 的具体计算逻辑（不能用 if-else 堆砌，需要数学定义）
- gate 阈值如何标定？（从 self-play 数据估计？人工设定？）
- 如何确保 gate 机制不会引入新的不连续性（一个动作突然从 0.1 跳到 0.9）

#### 1.3 硬约束的统一框架

V27 列了硬约束：
- 能立即斩杀却 declareEnd
- R1/R2 有可用有效动作却无理由 declareEnd
- 选择导致己方核心角色被已知公开伤害击杀
- 元素调谐牺牲唯一 combo key 且未解锁更高价值动作

但这些判断分散在 BaselinePolicy、MCTS prior、declare-end-constraints 中。

需要：
- 定义 `HardConstraint` 的统一接口，每个约束输出 `{violated: boolean, severity: number, reason: string}`
- 硬约束在 score 中的处理方式：`if violated: score = -Infinity` 还是 `score -= large_penalty`？给出选择逻辑
- 硬约束之间是否有优先级？冲突时如何仲裁？

#### 1.4 与 MCTS 的集成

当前 MCTS 用 ranker score 做 PUCT prior。如果 transition scorer 上线：
- MCTS 内部节点是否应该重新计算 transition delta？
- 如果 MCTS 深度 3-5，transition 的累积误差如何控制？
- MCTS leaf evaluation 是否应改用 transition-based value 而非纯 ranker score？

---

## 难题二：9 个隐藏约束的当前状态审计与升级路径

### 背景

V27 对 H1-H9 每个给出了数学定义、伪代码、特征依赖、复杂度和独立验证方案。但实际代码中这些约束的状态参差不齐。

请审计以下 9 个约束在 V28 代码中的实际状态，并为每个约束给出**从当前状态到 V27 设计**的具体升级路径：

#### H1: 行动权约束
- 当前代码：`declare-end-constraints.ts`（MCTS prior penalty）+ BaselinePolicy 散落的 declareEnd 处理
- V27 设计：`ActionRightsEvaluator` 统一评估，输出 `declareEndClass` 六类 + score
- 差距在哪里？升级的最小改动集是什么？

#### H2: 骰子稀缺元素
- 当前代码：`diceFitness`、`computeDiceQualityMetrics`、调谐 unlock potential
- V27 设计：`DiceOpportunityCost(S,a) = FutureActionValue(S, D) - FutureActionValue(T_D(S,a), D-cost(a))`
- 当前缺失什么？能否在不重写整个骰子系统的情况下接入？

#### H3: 元素附着债务
- 当前代码：`reaction_value`、`reactionChainPrior`（只奖励当前反应）
- V27 设计：`C_aura = AuraCashoutGain + AuraSetupGain - AuraDebt - OppAuraGiftRisk`
- 当前有"破坏下一步反应窗口"的惩罚吗？加这个惩罚需要什么信息？

#### H4: 支援/召唤位边际价值
- 当前代码：`PortfolioSnapshot` 有 `slotPressure`、`deferredCount`
- V27 设计：`new_support_EV - replaced_support_retention_EV` 精确比较
- 当前替换支援的 EV 差计算了吗？如果没算，缺什么数据？

#### H5: 角色功能完整性
- 当前代码：`BaselinePolicy` 有 `FunctionalTier` 和 collapse distance，但 `DECK_DEFAULT_ROLE_MAP` 为空
- V27 设计：`DeckRoleProfile` 从 deck code 自动推断角色功能
- 当前 deck role 为什么没进入评分主链？自动推断的可行方案是什么？

#### H6: 对手 cashout readiness
- 当前代码：`OpponentModel` 描述风格/aggression，不是可执行威胁
- V27 设计：`OpponentCashoutRisk` 包含 `nextActionLethal`、`endPhaseExpectedDamage`、`burstOnlineCharacters`
- 当前对手威胁评估能回答"对手下一动能否杀我"吗？如果能，为什么没进入 scoring？

#### H7: 先后手与轮次节奏
- 当前代码：散落在 tempo/declareEnd/MCTS prior
- V27 设计：`RoundTempoState` 统一表达，被 declareEnd、tempo、MCTS prior、training feature 共用
- 为什么同一个概念散落在四个地方？统一后最可能出问题的地方在哪？

#### H8: 手牌 option retention
- 当前代码：调谐有 unlock potential，但没有被调谐掉牌的机会成本
- V27 设计：`HandCardOptionValue` 计算每张牌的保留价值，`tuning_score = unlocked_EV - sacrificed_retention_EV`
- 手牌保留价值如何估算？（从 deck code 静态分析？从 self-play 统计？从 profile？）

#### H9: 随机性与隐藏信息
- 当前代码：`hidden-info-estimator.ts` 存在但未进入 runtime scoring 主链
- V27 设计：用风险区间 `[lower_bound, upper_bound]` 替代点估计
- 已经有了估计器，为什么没能进入评分？接口不匹配？计算开销？置信度不够？

### 期望输出格式

对每个 H1-H9：
1. **当前状态**：2-3 句描述代码实际做了什么（引用具体文件和函数）
2. **与 V27 的差距**：缺失了什么关键计算？
3. **升级路径**：最小改动集 + 预估工作量
4. **风险**：升级后可能出现的退化和如何检测

---

## 难题三：Deck/Matchup 条件化的真正路径

### 背景

V25 实验的核心发现：统一 ranker 在不同卡组间 WR 标准差 21%。这意味着"一个模型服务所有卡组"的策略失败了。

V26 提出：把 deck/matchup prior 从 side-level bonus 改为 action-conditional bonus。即：

```
当前: priorBaseScore 对所有候选动作加同一个常数 → 不影响排序
目标: 每个 (deck, matchup, action) 组合有独立的 prior 贡献
```

当前 `EvaluatorPolicy` 的 `priorMatrix` benchmark 显示 prior 开关"看起来有差异"，但实际是因为随机性而非条件化。

### 需要形式化

#### 3.1 条件化 prior 的数学框架

定义：
```
ActionPrior(deck_self, deck_opp, action, state) → score

不是：
  prior_base = f(deck_self, deck_opp)  // 所有动作相同
  score += prior_base * scale

而是：
  for each action a_i:
    score_i += f(deck_self, deck_opp, semantic_tags(a_i), state_features)
```

需要：
- `semantic_tags(action)` 的提取方式（从 action type 推断？从 candidate preview 提取？从 engine mutation 获取？）
- deck 特征如何影响每个 tag 的权重（怎么学到"快攻卡组惩罚 setup 型动作"？）
- 与现有 GBDT ranker 的集成方式（加特征列？独立模型？门控？）

#### 3.2 可学习性分析

当前 self-play 数据约 12 万样本、8 套卡组。

- 8 套卡组足够学到有意义的 per-deck 差异吗？
- 如果不够，是否需要更多的 deck mirror 对局？
- action-conditional prior 是应该从 self-play 数据学，还是应该从 deck code 静态分析规则引擎生成？

#### 3.3 可证伪实验

设计一个实验验证"action-conditional prior 优于 side-level prior"：
- 用什么指标？（mirror WR stddev？same-decision-point top-1 change？）
- 最小测试集是什么？
- 什么结果算"假说被证实"？什么结果算"假说被拒绝"？

---

## 补充信息

### 可用数据
- Self-play 对局数据：约 12 万样本，8 套卡组，RL dataset manifest 格式
- Benchmark 对局记录：每 matchup 多场 replay（完整 game state 序列）
- Engine 源码：TypeScript，完整游戏规则实现（`packages/core/src/`、`packages/data/src/`）
- V26/V27 设计文档：架构建议（459 行）+ 隐藏约束验证（579 行）+ 形式化方案（1639 行）
- Combat Window Pipeline：24 个文件的窗口提取/验证/树库管线
- SPL 模块：9 个文件的编译器/状态机/Dice budget

### 技术约束
- 运行环境：Bun (JavaScriptCore) + TypeScript
- 推理速度目标：每候选动作额外开销 ≤ 5ms（MCTS 200 迭代 × 10 候选）
- 训练：self-play pipeline 在阿里云 ECI (8C/16G)
- 内存：16GB 上限

### 相关文档（供参考）
- `v26-ai-architecture-recommendations.md` — GPT 写的架构建议
- `v26-hidden-constraints-validation-plan.md` — GPT 写的约束验证计划
- `v27-transition-constraints-formalization.md` — GPT 写的数学形式化方案（1639 行）
- `v15-agent-ml-code-review-and-improvement-plan.md` — 历史审查
- `v25-implicit-matchup-encoding.md` — V25 实验详细结果
- `v14-model-requirements.md` — 模型应满足的数学性质

### 代码入口供溯源
```
policy 主循环:  packages/gi-agent/src/runtime/policy/gi-ml-policy.ts → choose()
transition:     packages/gi-agent/src/learning/scoring/transition-scorer.ts
MCTS:          packages/gi-agent/src/mcts/mcts.ts → search()
ranker:        packages/gi-ml/src/ranker/slot-linear-ranker.ts
value:         packages/gi-ml/src/value/unified-value-predictor.ts
constraints:   packages/gi-agent/src/runtime/policy/declare-end-constraints.ts
portfolio:     packages/gi-agent/src/knowledge/temporal-profiles/
SPL:           packages/gi-agent/src/runtime/plan/
```

---

## 特别提醒

1. **不要泛泛而谈**。需要具体的数学公式、类型签名、计算步骤。不是"应该考虑骰子机会成本"，而是"骰子机会成本 = Σ_{后续需要此色骰的动作} P(该动作最优 | S') × 所需骰数 × 权重"。

2. **不要忽略现有系统**。新方案必须能接入 `GiMlPolicy.choose()` 中，作为可开关的组件。所有修改不能破坏现有的 self-play → 训练 → benchmark 闭环。

3. **给出可证伪预言**。每个方案附一个具体的实验："如果方案 X 正确，我们应该在 Y 类对局中看到 Z 现象，否则方案 X 不对"。

4. **数理优先**。优先给出数学上正确、优雅的建模。工程实现细节可以简略，但不能省略复杂度分析和边界条件处理。

5. **这不是代码审查**。不要建议拆分文件、不要列 bug 清单、不要关注代码风格和项目卫生。聚焦在**算法级架构决策**上。

6. **参考 V27 的深度**。V27 的 transition 形式化达到 1639 行，每个 H 约束都有数学定义 + 伪代码 + 复杂度分析。本次输出应达到同等或更高的深度。
