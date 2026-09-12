# V29 Transition Scoring 深化方案

> 日期: 2026-05-22
> 输入: `v28-prompt-for-qwen.md`
> 状态: 形式化设计稿，对标 V27 深度
> 前置: `v27-transition-constraints-formalization.md`（1639 行设计稿）

---

## 1. 目录

1. [Transition 置信度自适应与门控](#1-transition-置信度自适应与门控)
2. [硬约束统一框架](#2-硬约束统一框架)
3. [MCTS 集成方案](#3-mcts-集成方案)
4. [H1-H9 约束升级路径](#4-h1-h9-约束升级路径)
5. [Deck/Matchup 条件化](#5-deckmatchup-条件化)
6. [可证伪实验](#6-可证伪实验)
7. [实施路线图](#7-实施路线图)

---

## 1. Transition 置信度自适应与门控

### 1.1 投影可信度与权重自适应

设投影源置信度为 $c \in [0,1]$，定义自适应 transition 贡献函数：

$$
\Phi(S, a, c) = \alpha(c) \cdot g(S,a) \cdot w_T \cdot \text{norm}\Delta(S,a) - \beta(c) \cdot \text{penalty}(S,a)
$$

其中：

$$
\alpha(c) = c^{\gamma}, \quad \beta(c) = (1 - c)^{\gamma}, \quad \gamma = 2
$$

**设计意图**：$\gamma=2$ 时 $c=0.9 \to \alpha=0.81$（接近全量），$c=0.7 \to \alpha=0.49$（半量），$c=0.6 \to \alpha=0.36$。平方衰减确保低置信度 transition 自然被压制。

**penalty 定义**：

$$
\text{penalty}(S,a) = |\text{norm}\Delta(S,a)| \cdot \mathbf{1}[|\text{norm}\Delta| > \tau_{\text{penalty}}], \quad \tau_{\text{penalty}} = 1.5
$$

只有 transition delta 绝对值超过阈值时才施加惩罚，防止低置信度的大摆动误导排序。

#### 门控强制升级

高影响 gate（lethal_gate）在低置信度下必须强制升级投影或 fallback：

```
if gate(S,a) ≥ 0.8 and c < 0.85:
  if engine_available:
    upgrade to engine_exact (c → 0.95)
  else:
    Φ(S,a,c) = 0  // 静默，不贡献 transition delta
```

#### threshold 设定逻辑

| 场景 | threshold | 推导 |
|------|-----------|------|
| lethal_gate 强制升级 | $c_{\text{critical}} = 0.85$ | 斩杀需 HP 精确，observation 模式下 HP 可能偏差 ±1 |
| declare_end_gate 抑制 | $c_{\text{suppress}} = 0.75$ | declareEnd 是终局决策，错误代价极高 |
| 普通动作衰减 | 无 threshold，靠 $\alpha(c)=c^2$ 自然衰减 | 低风险动作即使不精确也不至灾难 |

#### 伪代码

```typescript
function adaptiveTransitionContribution(
  state: TransitionState,
  candidate: PolicyCandidateAction,
  gate: number,
  normalizedDelta: number,
  config: TransitionConfig
): number {
  const c = state.source.confidence
  const gamma = 2

  // High-impact gate + low confidence → force upgrade or suppress
  if (gate >= 0.8 && c < 0.85) {
    if (config.engineProvider) {
      const exact = config.engineProvider.projectExact(state, candidate)
      if (exact) return exact.contribution
    }
    return 0  // suppress
  }

  const alpha = Math.pow(c, gamma)
  const beta = Math.pow(1 - c, gamma)
  const penalty = Math.abs(normalizedDelta) > 1.5
    ? Math.abs(normalizedDelta)
    : 0

  return alpha * gate * config.weight * normalizedDelta
       - beta * penalty * config.penaltyWeight
}
```

复杂度：$O(1)$ 额外开销（不含 engine upgrade）。

---

### 1.2 连续化门控：Smooth Maximum

#### 问题

当前 V28 gate 是 if-else 链：
```
declareEnd → 1.0
tuning → 0.8
support near-full → 0.8
4+ dmg skill → 0.6
default → 0.1
```

两个结构性缺陷：
1. **不连续性**：3 伤害 skill gate=0.1，4 伤害 gate=0.6，跳变 6 倍
2. **缺乏组合**：R1 declareEnd 和 R3 declareEnd 风险不同但 gate 相同

#### 设计：LogSumExp Smooth Max

$$
g(S,a) = \frac{1}{\beta}\ln\left(\sum_i e^{\beta \cdot g_i}\right), \quad \beta = 8
$$

$\beta=8$ 时行为接近 max，但在边界处连续可微。最大跳变幅度受 $\frac{1}{\beta}\ln(7) \approx 0.24$ 限制。

#### 七个子 gate

##### $g_1$: Lethal Gate（斩杀门控）

$$
g_{\text{lethal}}(S,a) = \sigma\left(\frac{\text{previewDmg}(a,S) - \text{oppActiveHp}(S)}{\delta_{\text{lethal}}}\right)
$$

$\sigma$ 为 sigmoid，$\delta_{\text{lethal}} = 1.0$。伤害 ≥ 对手血量 $g \to 1$，差 1 点 $g \approx 0.27$，差 2 点 $g \approx 0.12$。

##### $g_2$: Declare End Gate（结束门控）

$$
g_{\text{end}}(S,a) = \mathbf{1}[a = \text{declareEnd}] \cdot \left(0.3 + 0.7 \cdot f_{\text{urgency}}(S)\right)
$$

$$
f_{\text{urgency}}(S) = \max\left(\frac{\text{usefulActions}(S)}{N_{\max}},\; \mathbf{1}[\text{oppEnded}],\; \frac{\text{remainingDice}}{D_{\max}}\right)
$$

$N_{\max} = 5$，$D_{\max} = 8$。R1 有大量有用动作时 gate 高（不应结束），R3 无动作时 gate 低。

##### $g_3$: Dice Bottleneck Gate（骰子瓶颈门控）

$$
g_{\text{dice}}(S,a) = \sigma\left(\frac{\text{cost}(a) - \text{available}_{\text{matching}}(S)}{1.5}\right) \cdot \frac{\text{demand}(S)}{D_{\max}}
$$

$\text{demand}(S)$ 是当前骰子能支持的后续高价值动作数。

##### $g_4$: Aura Window Gate（元素窗口门控）

$$
g_{\text{aura}}(S,a) = \text{reactionWindowEV}(S) \cdot \mathbf{1}[\text{modifiesAura}(a)]
$$

只有改变附着的动作才触发此 gate。

##### $g_5$: Support Slot Gate（支援位门控）

$$
g_{\text{support}}(S,a) = \mathbf{1}[\text{isSupport}(a)] \cdot \sigma\left(\frac{\text{slotsUsed}(S) - 2.5}{1.0}\right)
$$

slotsUsed=3 时 $g \approx 0.62$，=4 时 $g \approx 0.82$。低 slot 随便放，高 slot 需仔细评估替换。

##### $g_6$: Opponent Cashout Gate（对手兑现门控）

$$
g_{\text{oppCashout}}(S,a) = \mathbf{1}[a = \text{declareEnd} \lor \text{isPassive}(a)] \cdot \text{oppThreatLevel}(S)
$$

$\text{oppThreatLevel}(S) = \min(1, \text{oppBurstDmg}(S) / \text{selfActiveHp}(S))$。

##### $g_7$: Tuning Gate（调谐门控）

$$
g_{\text{tuning}}(S,a) = \mathbf{1}[a = \text{elementalTuning}] \cdot \left(0.3 + 0.7 \cdot \frac{\text{unlockPotential}(S,a)}{\text{maxUnlock}}\right)
$$

#### 阈值标定

不从 self-play 数据估计（循环依赖）。从**合成状态单调性测试**标定：对每个 gate 构造 20 对状态，调整参数使正确动作的 gate > 错误动作的 gate，margin ≥ 0.3。

---

## 2. 硬约束统一框架

### 2.1 接口定义

```typescript
interface HardConstraint {
  id: string               // "HC_LETHAL_MISS" | "HC_FREE_WINDOW_WASTE" | ...
  evaluate(
    state: TransitionState,
    candidate: PolicyCandidateAction,
    allCandidates: PolicyCandidateAction[]
  ): HardConstraintResult
}

interface HardConstraintResult {
  violated: boolean
  severity: number         // [0, 1], 1 = absolute violation
  reason: string
  alternativesExist: boolean  // 是否有安全替代动作
}
```

### 2.2 四条硬约束

#### HC1: 能斩杀却 declareEnd

```typescript
const HC_LETHAL_MISS: HardConstraint = {
  id: "HC_LETHAL_MISS",
  evaluate(state, candidate, all) {
    if (candidate.actionCase !== "declareEnd")
      return { violated: false, severity: 0, ... }

    const lethalCandidates = all.filter(a => {
      if (a.actionCase !== "useSkill") return false
      const dmg = Math.max(
        a.previewDamage ?? 0,
        staticSkillDamage(state.self.active, a.skillType)
      )
      return dmg >= state.opponent.active.hp
    })

    if (lethalCandidates.length === 0)
      return { violated: false, severity: 0, ... }

    return {
      violated: true,
      severity: 1.0,
      reason: `Can kill opp active (HP=${state.opponent.active.hp}) with ${lethalCandidates.length} skill(s)`,
      alternativesExist: true
    }
  }
}
```

#### HC2: R1/R2 有可用动作却 declareEnd

$$
\text{HC2}(S,a) = \mathbf{1}[a=\text{declareEnd}] \cdot \mathbf{1}[R \leq 2] \cdot \mathbf{1}[\text{usefulActions}(S) \geq 2] \cdot \mathbf{1}[\text{dice}(S) \geq 3]
$$

severity = $\min(1, \text{usefulActions}(S) / 4)$

#### HC3: 导致核心角色被已知伤害击杀

$$
\text{HC3}(S,a) = \mathbf{1}[\text{willBeKilled}(T(S,a).\text{active}, \text{oppPublicDmg})] \cdot \mathbf{1}[\text{safeAlt}(S)]
$$

severity = $1 - \frac{\text{role}(a.\text{target}).\text{cashoutImportance}}{\max}$

#### HC4: 调谐牺牲唯一 combo key

$$
\text{HC4}(S,a) = \mathbf{1}[a=\text{tuning}] \cdot \mathbf{1}[\text{isUniqueComboKey}(\text{discardedCard}, S)] \cdot \mathbf{1}[\text{unlockGain}(a) < \text{retention}(\text{discardedCard})]
$$

### 2.3 处理方式：大惩罚而非 $-\infty$

不用 $-\infty$ 的原因：
1. MCTS PUCT 中 $-\infty$ 导致数值问题
2. hard constraint 可能误判（observation 模式下信息不完整）
3. 需要保留 reasons 可解释性

使用**大惩罚 + severity 加权**：

$$
\text{score}_{\text{final}} = \text{score}_{\text{existing}} - \text{HC}_{\text{penalty}} \cdot \text{severity} \cdot \text{confidence}
$$

$\text{HC}_{\text{penalty}} = 50$（典型 score 范围的 10 倍）：
- severity=1.0 → 惩罚 50，几乎不可被其他信号覆盖
- severity=0.5 → 惩罚 25，极端情况下可被 override
- alternativesExist=false → severity 降半（无安全替代时放松）

### 2.4 优先级与仲裁

约束间**不设优先级**，取最大惩罚：

$$
\text{hcTotal}(S,a) = \max_{i: \text{violated}_i} (\text{HC}_{\text{penalty}} \cdot \text{severity}_i \cdot c)
$$

最严重的已足够压制，叠加会导致过度惩罚。冲突时（如 HC1 应斩杀 vs HC3 不应暴露核心）自然以 severity=1.0 的 HC1 为准。

---

## 3. MCTS 集成方案

### Root 节点：完整 transition scoring

```
MCTS root children:
  for each action a:
    prior[a] = softmax(existingScore[a] + transitionContribution(S, a))
```

### Inner 节点：cheap transition

不重新计算完整 H1-H9。只用：

$$
\text{innerPrior}(a) = \text{softmax}\left(\text{baseline}(S,a) + \text{hcTotal}(S,a) + \text{cheapDelta}(S,a)\right)
$$

$\text{cheapDelta}$ 只算 H2（骰子）和 H7（tempo），复杂度 $O(1)$。

### Leaf evaluation：transition-based value

当前 leaf 用 $V_{\text{model}}(\phi(S))$。改为：

$$
V_{\text{leaf}}(S) = V_{\text{model}}(\phi(S)) + w_{\text{portfolio}} \cdot V_{\text{portfolio}}(S) + w_{\text{terminal}} \cdot V_{\text{terminal}}(S)
$$

$w_{\text{portfolio}} = 0.15$，$w_{\text{terminal}} = 0.25$。

### 累积误差控制

MCTS 深度 $d$ 时，置信度按指数衰减：

$$
\text{confidence}_{\text{depth } d} = c_0 \cdot (1 - \epsilon)^d, \quad \epsilon = 0.15
$$

depth=3 时 $c \approx 0.58$，$\alpha = 0.34$，transition 贡献自然衰减到 1/3。depth=5 时 $c \approx 0.42$，$\alpha \approx 0.18$。这是正确行为——MCTS 深层应由 value model 而非 heuristic transition 主导。

---

## 4. H1-H9 约束升级路径

### 4.1 当前完成度总览

| 约束 | 当前完成度 | 缺失核心 | 工作量 | 风险 |
|------|-----------|---------|--------|------|
| H1 行动权 | 60% | shortActionValue 量化 | 2天 | 低 |
| H2 骰子 | 30% | FutureActionValue + Scarcity | 3天 | 中 |
| H3 附着 | 40% | ReactionWindowEV | 4天 | 中 |
| H4 支援位 | 50% | RetentionEV 桥接 | 2天 | 低 |
| H5 角色 | 20% | DeckRoleProfile 推断 | 3天 | 高 |
| H6 对手威胁 | 40% | 一动斩杀 + endPhase | 3天 | 中 |
| H7 节奏 | 50% | 统一 RoundTempoState | 2天 | 低 |
| H8 手牌 | 30% | cardRetentionValue | 3天 | 中 |
| H9 隐藏信息 | 15% | 桥接 hidden-info-estimator | 2天 | 中 |

### 4.2 H1: 行动权约束

**缺失**：`shortActionValue` 未量化（只判断有无有用动作），OpportunityLoss 不是差值而是固定 -3.0，CashoutGain 未量化，与 `declare-end-constraints.ts` 重复。

**升级**：
1. 为每个候选动作添加 `shortActionValue`（复用 `rankCandidate` heuristic score，归一化到 [0,3]）
2. declareEnd OpportunityLoss = $\max_{b \neq \text{end}} \text{normalizedScore}(b)$
3. 合并 declare-end-constraints 的 penalty 作为 H1 硬约束部分

### 4.3 H2: 骰子稀缺元素

**缺失**：无 FutureActionValue 计算，无 Scarcity/Demand/Importance 分解，无同色骰瓶颈识别。

**升级**：
1. `scarcityWeight(e, S) = 1 / (1 + \text{available}_e + \text{omni})`
2. `futureDemand(e, S)`：扫描 allCandidates 中需要元素 $e$ 的高分动作数
3. H2 raw = $\sum_e \text{consumed}_e \cdot \text{scarcity}(e) \cdot \text{demand}(e)$
4. ALIGNED cost 特殊处理：如果动作需要 N 个同色且 $\text{available}_e < N+1$，demand 翻倍

### 4.4 H3: 元素附着债务

**缺失**：无 ReactionWindowEV 计算，无"破坏下一步反应窗口"惩罚，aura debt 是常数 0.3。

**升级**：
1. `reactionWindowEV(S, side)`：遍历 side 角色，对每个有附着的角色计算队友中匹配技能的期望伤害
2. debt = $\text{reactionWindowEV}(S) - \text{reactionWindowEV}(T(S,a))$
3. setupGain = $\max(0, \text{reactionWindowEV}(T(S,a)) - \text{reactionWindowEV}(S))$
4. 物理/岩队若 $\text{reactionReliance} < 0.2$，H3 weight 设为 0

### 4.5 H4: 支援/召唤位边际价值

**缺失**：无 RetentionEV 计算，newValue 是常数 1.5，ReplacementPenalty 硬编码 0.25。

**升级**：
1. 从 `PortfolioSnapshot.active` 获取每个支援的 `expectedPayoff`
2. `retentionEV(slot_i) = active[i].expectedPayoff * (1 - \text{usageDecay})`
3. `newSupportEV(a) = profilePayoff(a) - deployCost(a)`
4. 替换 delta = `newSupportEV - min(retentionEV) - 0.25`

### 4.6 H5: 角色功能完整性

DECK_DEFAULT_ROLE_MAP 为空，所有角色默认走 "tactical" 推断，只用 maxEnergy/maxHp。

**升级**：从 deck 构成静态推断角色：
- 角色有 burst 卡配合 → carry
- 角色技能给队友挂元素 → enabler
- 角色 maxHp 最高且有护盾卡 → protector
- riskWeight = cashoutImportance × 1.5

先在 8 套 benchmark deck 上手工验证，确认正确率 > 90%。

### 4.7 H6: 对手 cashout readiness

**缺失**：无一动斩杀检测，无 endPhaseExpectedDamage，OpponentModel 是风格描述而非可执行威胁。

**升级**：
1. `opponentOneStepLethal(S)`：遍历对手角色技能，检查 max(skillBaseDmg + reactionBonus) ≥ selfActiveHp
2. `endPhaseDamage(S)`：从对手召唤物/状态的 endPhase 效果累加
3. ThreatVector 权重：$p_{\text{lethal}} = 3.0$, burst = 1.5, endPhase = 1.0, reaction = 1.0
4. 骰子可行性折扣：对手无足够匹配骰时 $p_{\text{lethal}} \times 0.3$

### 4.8 H7: 先后手与轮次节奏

tempo 概念分散在四处（H7、baseline tempo、declare-end moverFactor、MCTS prior）。

**升级**：
1. 定义 `RoundTempoState` 类型，在 scoring 入口处计算一次
2. H7 raw = `tempoMultiplier(S) × tempoActionValue(S, a)`
3. baseline tempo 和 declare-end-constraints 均引用同一个 `RoundTempoState`
4. 记录 tempo 总贡献，若 > 2.0 说明重复计算

### 4.9 H8: 手牌 option retention

unlockGain 是常数 0.5，无 SynergyProviderEV，对 playCard 不生效。

**升级**：
1. `cardRetentionValue(card, S)`：
   - `playableEV`：从 temporal profile 获取
   - `futureOptionEV`：下回合能打出且 payoff > 0.5 则 0.3
   - `synergyProviderEV`：是 reaction chain 组件则 0.4
   - `duplicateDiscount`：手牌有同 ID 牌则 ×0.5
2. `unlockGain` = tuning 后最高分动作 vs 当前最高分的差值
3. 对 playCard 也生效：`raw = -futureOptionEV(card)`

### 4.10 H9: 随机性与隐藏信息

hidden-info-estimator.ts（237 行）存在但未接入 runtime scoring 主链。原因：输出 per-card 概率，scoring 需要 per-action 风险。

**升级**：
1. 桥接 `batchCardProbabilities` 到 H9
2. `hiddenLethalProb`：对手可能持有斩杀卡的概率上限
3. H9 raw = `-hiddenLethalProb × riskExposure(S,a) - diceFailProb × planDependency(S,a)`
4. deck profile 先验：若对手卡组不含斩杀卡，`hiddenLethalProb` 设为 0

---

## 5. Deck/Matchup 条件化

### 5.1 数学框架

目标：从 side-level bonus（所有动作加同一常数）升级为 action-conditional prior。

$$
\text{ActionPrior}(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, a, S) = \mathbf{w}^T \cdot \phi(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, \text{tags}(a), S)
$$

特征交叉函数：

$$
\phi(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, \mathbf{t}, S) = \mathbf{d}_{\text{self}} \otimes \mathbf{t} \;\|\; \mathbf{d}_{\text{opp}} \otimes \mathbf{t} \;\|\; (\mathbf{d}_{\text{self}} - \mathbf{d}_{\text{opp}}) \otimes \mathbf{t} \;\|\; \mathbf{t} \;\|\; S_{\text{phase}}
$$

### 5.2 semantic_tags 提取

```typescript
interface ActionSemanticTags {
  // 动作类型
  isSkill: number; isBurst: number; isSwitch: number
  isPlayCard: number; isTuning: number; isDeclareEnd: number

  // 效果标签（从 candidate preview 提取）
  dealsDamage: number; triggersReaction: number; heals: number
  drawsCards: number; createsSupport: number; createsSummon: number

  // 战略标签（从 engine mutation 推断）
  isSetup: number      // creates future value
  isCashout: number    // realizes existing value
  isDefensive: number  // switch, heal, shield
  isTempo: number      // fast action, doesn't end turn
}
```

提取来源优先级：action type（可靠）→ candidate preview（中等）→ engine mutation（高可靠但贵，仅 root 节点）。

### 5.3 与 GBDT ranker 集成

**加特征列**（非独立模型，非门控）：

```
features = existingFeatures ∪ {
  prior_score: ActionPrior(d_self, d_opp, a, S),
  prior_x_tempo: ActionPrior × tempoPush_self,
  prior_x_round: ActionPrior × (1/round),
}
```

让 GBDT 在训练时自动学到 prior 的可信度。

### 5.4 可学习性分析

8 套卡组 × 8 = 64 个 matchup，每个约 1875 样本。交叉特征维度 ≈ 579，参数/样本比 ≈ 0.31，**过拟合风险高**。

解决方案：
1. **降维**：只学 top-K=30 有意义的交叉特征
2. **正则化**：L2 λ=0.1 或 GBDT min_child_samples=50
3. **分层学习**：先 per-archetype（aggressive/control/combo），再 per-deck fine-tune
4. **Ridge regression 从规则引擎初始化**：

$$
\mathbf{w}^* = \arg\min_{\mathbf{w}} \sum_i (y_i - \mathbf{w}^T \phi_i)^2 + \lambda \|\mathbf{w} - \mathbf{w}_0\|^2
$$

$\mathbf{w}_0$ 是规则引擎初始权重，$\lambda$ 控制向先验收缩的强度。

---

## 6. 可证伪实验

### 6.1 实验 A: Transition 置信度自适应

**配置**：
| 组 | 配置 |
|----|------|
| A0 | 当前 V28 |
| A1 | + smooth maximum 门控 |
| A2 | + $c^2$ 置信度衰减 |
| A3 | + 硬约束统一框架 |

**可证伪预言**：
- A2/A3 在 hidden constraint counters 上应显著改善
- A1 若 WR 下降说明 smooth max 参数需调整
- A3 若镜像 WR 退化说明硬约束过强或 role 错误

### 6.2 实验 B: 合成状态单调性

构造状态对，只改变一个因素（是否 free window、是否关键同色骰、是否有 aura window、支援位是否满、是否有 opponent one-step lethal）。

预期：`score_transition(correct_action) - score_transition(bad_action) > 0.5`

### 6.3 实验 C: Deck Prior 条件化

**假说**：action-conditional learned prior 优于 rule-based prior。

**最小测试集**（4 matchup × 40 场 = 160 场）：
1. 快攻 vs 控制（tempo vs longGame 差异大）
2. 反应队 vs 物理队（reactionReliance 差异大）
3. Mirror match（检验 prior 不引入噪声）
4. 支援引擎 vs 反支援（supportReliance vs antiSupport 冲突）

**判定标准**：
- **证实**：全 matchup WR ≥ Baseline + 2%，mirror WR stddev ≤ Baseline − 3%，top-1 change rate ≥ 5%
- **拒绝**：WR < Baseline，stddev 不降，top-1 change rate < 1%
- **部分成立**：WR 提升但 stddev 不降，或只在部分 matchup 有效

---

## 7. 实施路线图

```
Phase 1 (Week 1-2): 基础架构
  - c² 置信度自适应
  - smooth maximum 门控替换
  - HardConstraint 统一接口
  - H1 升级 (shortActionValue)
  - H4 升级 (RetentionEV 桥接)
  → 验收：合成状态单调性测试全通过

Phase 2 (Week 3-4): 约束升级
  - H7 统一 (RoundTempoState)
  - H2 升级 (Scarcity/Demand)
  - H8 升级 (cardRetentionValue)
  - MCTS inner node cheap transition
  → 验收：benchmark WR ≥ baseline, declareEnd error rate ↓ 30%

Phase 3 (Week 5-6): 高级约束 + Deck Prior
  - H6 升级 (一动斩杀检测)
  - H3 升级 (ReactionWindowEV)
  - Deck prior 条件化 + 可证伪实验 C（160 场）
  → 验收：mirror WR stddev ↓ 5%+

Phase 4 (Week 7-8): 收尾
  - H5 升级 (DeckRoleProfile)
  - H9 升级 (hidden-info-estimator 桥接)
  - 全链路 ablation benchmark
  → 验收：V27 §23 可证伪标准全部满足
```
