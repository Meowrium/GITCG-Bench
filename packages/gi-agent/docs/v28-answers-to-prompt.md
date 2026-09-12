# V28 遗留架构难题 — 形式化方案回答

> 日期: 2026-05-22  
> 输入: `v28-prompt-for-qwen.md`  
> 状态: 形式化方案回答，对标 V27 深度  
> 前置阅读: `v27-transition-constraints-formalization.md`（1639 行设计稿）

---

## 难题一：Transition-based Scoring 完整实施方案

### 1.1 投影可信度与权重自适应

#### 数学定义

设投影源置信度为 $c \in [0,1]$，定义**自适应 transition 贡献函数**：

$$
\Phi(S, a, c) = \alpha(c) \cdot g(S,a) \cdot w_T \cdot \text{norm}\Delta(S,a) - \beta(c) \cdot \text{penalty}(S,a)
$$

其中：

$$
\alpha(c) = c^{\gamma}, \quad \gamma = 2
$$

$$
\beta(c) = (1 - c)^{\gamma}
$$

**设计意图**：$\gamma=2$ 使得 $c=0.9$ 时 $\alpha=0.81$（几乎全量贡献），$c=0.7$ 时 $\alpha=0.49$（半量），$c=0.6$ 时 $\alpha=0.36$。平方衰减确保低置信度 transition 自然被压制。

**penalty 定义**：

$$
\text{penalty}(S,a) = |\text{norm}\Delta(S,a)| \cdot \mathbf{1}[|\text{norm}\Delta| > \tau_{\text{penalty}}]
$$

即只有当 transition delta 绝对值超过阈值 $\tau_{\text{penalty}}$ 时才施加惩罚，防止低置信度的大摆动误导排序。$\tau_{\text{penalty}} = 1.5$（对应一个中等强度反应伤害的 delta）。

#### 门控强制升级

对于高影响 gate（lethal\_gate），当 $c < c_{\text{critical}}$ 时必须强制升级投影或 fallback：

$$
c_{\text{critical}} = 0.85
$$

规则：

```
if gate(S,a) ≥ 0.8 and c < c_critical:
  if engine_available:
    upgrade to engine_exact (c → 0.95)
  else:
    Φ(S,a,c) = 0  // 强制静默，不贡献 transition delta
    flag: "transition_suppressed_low_confidence_high_impact"
```

#### threshold 设定逻辑

| 场景 | threshold | 推导 |
|------|-----------|------|
| lethal\_gate 强制升级 | $c_{\text{critical}} = 0.85$ | 斩杀判断需要 HP 精确。observation 模式 HP 可能因隐藏护盾/状态偏差 ±1，对应 0.85 以下不可信 |
| declare\_end\_gate 抑制 | $c_{\text{suppress}} = 0.75$ | declareEnd 是终局决策，错误代价极高。0.75 以下 observation 的 dice/hand 估计不可靠 |
| 普通动作衰减 | 无 threshold，靠 $\alpha(c)=c^2$ 自然衰减 | 低风险动作即使 transition 不精确也不会导致灾难 |

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
      // Upgrade to engine exact
      const exact = config.engineProvider.projectExact(state, candidate)
      if (exact) return exact.contribution // c is now 0.95+
    }
    // Suppress: don't let uncertain transition affect high-stakes decisions
    return 0
  }
  
  const alpha = Math.pow(c, gamma)
  const beta = Math.pow(1 - c, gamma)
  const penaltyThreshold = 1.5
  const penalty = Math.abs(normalizedDelta) > penaltyThreshold 
    ? Math.abs(normalizedDelta) 
    : 0
  
  return alpha * gate * config.weight * normalizedDelta 
       - beta * penalty * config.penaltyWeight
}
```

**复杂度**：$O(1)$ 额外开销（不含 engine upgrade）。

---

### 1.2 门控函数设计

#### 问题诊断

当前 V28 的 gate 是一个简单 if-else 链：
```
declareEnd → 1.0
tuning → 0.8
support near-full → 0.8
4+ dmg skill → 0.6
default → 0.1
```

这有两个结构性缺陷：
1. **不连续性**：3 伤害的 skill gate=0.1，4 伤害的 gate=0.6，跳变 6 倍
2. **缺乏组合**：一个在 R1 的 declareEnd（gate=1.0）可能比 R3 的 declareEnd 危害小得多，但 gate 相同

#### 连续化门控设计

定义门控为各子 gate 的 **smooth maximum**（而非硬 max），确保平滑过渡：

$$
g(S,a) = \frac{1}{\beta}\ln\left(\sum_i e^{\beta \cdot g_i}\right), \quad \beta = 8
$$

$\beta=8$ 时行为接近 max，但在边界处连续可微。

#### 七个子 gate 的精确定义

##### $g_1$: Lethal Gate（斩杀门控）

$$
g_{\text{lethal}}(S,a) = \sigma\left(\frac{\text{previewDmg}(a,S) - \text{oppActiveHp}(S)}{\delta_{\text{lethal}}}\right)
$$

$\sigma$ 为 sigmoid，$\delta_{\text{lethal}} = 1.0$。当伤害 ≥ 对手血量时 $g \to 1$，差 1 点时 $g \approx 0.27$，差 2 点时 $g \approx 0.12$。

##### $g_2$: Declare End Gate（结束门控）

$$
g_{\text{end}}(S,a) = \mathbf{1}[a = \text{declareEnd}] \cdot \left(0.3 + 0.7 \cdot f_{\text{urgency}}(S)\right)
$$

其中：

$$
f_{\text{urgency}}(S) = \max\left(\frac{\text{usefulActions}(S)}{N_{\max}}, \; \mathbf{1}[\text{oppEnded}], \; \frac{\text{remainingDice}}{D_{\max}}\right)
$$

$N_{\max} = 5$，$D_{\max} = 8$。这样 R1 有大量有用动作时 gate 高（不应结束），R3 无动作时 gate 低（结束合理）。

##### $g_3$: Dice Bottleneck Gate（骰子瓶颈门控）

$$
g_{\text{dice}}(S,a) = \sigma\left(\frac{\text{cost}(a) - \text{available}_{\text{matching}}(S)}{1.5}\right) \cdot \frac{\text{demand}(S)}{D_{\max}}
$$

其中 $\text{demand}(S)$ 是当前骰子能支持的后续高价值动作数。当动作花费超过可用匹配骰时 gate 升高。

##### $g_4$: Aura Window Gate（元素窗口门控）

$$
g_{\text{aura}}(S,a) = \text{reactionWindowEV}(S) \cdot \mathbf{1}[\text{modifiesAura}(a)]
$$

$\text{reactionWindowEV}(S) \in [0,1]$ 归一化。只有改变附着的动作才触发此 gate。

##### $g_5$: Support Slot Gate（支援位门控）

$$
g_{\text{support}}(S,a) = \mathbf{1}[\text{isSupport}(a)] \cdot \sigma\left(\frac{\text{slotsUsed}(S) - 2.5}{1.0}\right)
$$

slotsUsed=3 时 $g \approx 0.62$，=4 时 $g \approx 0.82$。低 slot 时 gate 低（随便放），高 slot 时 gate 高（需要仔细评估替换）。

##### $g_6$: Opponent Cashout Gate（对手兑现门控）

$$
g_{\text{oppCashout}}(S,a) = \mathbf{1}[a = \text{declareEnd} \lor \text{isPassive}(a)] \cdot \text{oppThreatLevel}(S)
$$

$\text{oppThreatLevel}(S) = \min(1, \text{oppBurstDmg}(S) / \text{selfActiveHp}(S))$。当对手能一刀切且我方做被动动作时，gate 高。

##### $g_7$: Tuning Gate（调谐门控）

$$
g_{\text{tuning}}(S,a) = \mathbf{1}[a = \text{elementalTuning}] \cdot \left(0.3 + 0.7 \cdot \frac{\text{unlockPotential}(S,a)}{\text{maxUnlock}}\right)
$$

#### 阈值标定

**不从 self-play 数据估计**，原因：
1. 当前 self-play 的 transition scoring 本身就是 V0，用它标定 gate 会循环依赖
2. Gate 是结构性参数，不是学习效果参数

**推荐方法**：从**合成状态单调性测试**标定。对每个 gate 构造 20 对状态，调整 $\delta$ 和 sigmoid 参数使得正确动作的 gate > 错误动作的 gate，margin ≥ 0.3。

#### 不连续性保证

smooth maximum ($\beta=8$) 保证：
- 任何单变量连续变化 → gate 连续变化
- 两个 gate 接近时不会跳变（softmax 的平滑性质）
- 最大跳变幅度受 $\frac{1}{\beta} \ln(7) \approx 0.24$ 限制

---

### 1.3 硬约束统一框架

#### HardConstraint 接口

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

#### 四条硬约束

##### HC1: 能斩杀却 declareEnd

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
      severity: 1.0,  // absolute
      reason: `Can kill opp active (HP=${state.opponent.active.hp}) ` +
              `with ${lethalCandidates.length} skill(s)`,
      alternativesExist: true
    }
  }
}
```

##### HC2: R1/R2 有可用动作却 declareEnd

$$
\text{HC2}(S,a) = \mathbf{1}[a=\text{declareEnd}] \cdot \mathbf{1}[R \leq 2] \cdot \mathbf{1}[\text{usefulActions}(S) \geq 2] \cdot \mathbf{1}[\text{dice}(S) \geq 3]
$$

severity = $\min(1, \text{usefulActions}(S) / 4)$

##### HC3: 导致核心角色被已知伤害击杀

$$
\text{HC3}(S,a) = \mathbf{1}[\text{willBeKilled}(T(S,a).\text{active}, \text{oppPublicDmg})] \cdot \mathbf{1}[\text{safeAlt}(S)]
$$

severity = $1 - \frac{\text{role}(a.\text{target}).\text{cashoutImportance}}{\max}$

##### HC4: 调谐牺牲唯一 combo key

$$
\text{HC4}(S,a) = \mathbf{1}[a=\text{tuning}] \cdot \mathbf{1}[\text{isUniqueComboKey}(\text{discardedCard}, S)] \cdot \mathbf{1}[\text{unlockGain}(a) < \text{retention}(\text{discardedCard})]
$$

#### 硬约束在 score 中的处理方式

**不用 $-\infty$**，原因：
1. MCTS PUCT 中 $-\infty$ 会导致数值问题
2. 硬约束可能误判（observation 模式下信息不完整）
3. 需要保留 reasons 可解释性

**使用大惩罚 + severity 加权**：

$$
\text{score}_{\text{final}} = \text{score}_{\text{existing}} - \text{HC}_{\text{penalty}} \cdot \text{severity} \cdot \text{confidence}
$$

其中 $\text{HC}_{\text{penalty}} = 50$（约为典型 score 范围的 10 倍），confidence 来自投影置信度。

**选择逻辑**：
- severity = 1.0（确定斩杀错过）→ 惩罚 50，几乎不可能被其他信号覆盖
- severity = 0.5（可能击杀但有不确定性）→ 惩罚 25，仍有极端情况下被 override 的可能
- alternativesExist = false → severity 降半（没有安全替代时硬约束放松）

#### 硬约束优先级

硬约束之间**不设优先级**，而是**取最大惩罚**：

$$
\text{hcTotal}(S,a) = \max_{i: \text{violated}_i} (\text{HC}_{\text{penalty}} \cdot \text{severity}_i \cdot c)
$$

原因：同时违反多个硬约束时，最严重的那个已经足够压制。叠加可能导致过度惩罚（$-\infty$ 效应）。

冲突仲裁：当 HC1（应斩杀）和 HC3（不应暴露核心）冲突时，HC1 severity=1.0 而 HC3 severity<1.0（因为有安全替代），自然以 HC1 为准。

---

### 1.4 与 MCTS 的集成

#### 当前状态

MCTS 使用 `policyPrior` 回调获取 log-priors 作为 PUCT prior。leaf evaluation 用 value model。inner node 用 `simulateAction` 轻量投影。

#### 集成方案

##### Root 节点：完整 transition scoring

```
MCTS root children:
  for each action a:
    prior[a] = softmax(existingScore[a] + transitionContribution(S, a))
    // transition 使用 engine_exact (如果 useEngineRoot=true)
```

##### Inner 节点：cheap transition

Inner 节点**不重新计算完整 H1-H9**（太贵），只用：

$$
\text{innerPrior}(a) = \text{softmax}\left(\text{baseline}(S,a) + \text{hcTotal}(S,a) + \text{cheapDelta}(S,a)\right)
$$

其中 $\text{cheapDelta}$ 只算 H2（骰子）和 H7（tempo），复杂度 $O(1)$。

##### Leaf evaluation：transition-based value

当前 leaf 用 $V_{\text{model}}(\phi(S))$。改为：

$$
V_{\text{leaf}}(S) = V_{\text{model}}(\phi(S)) + w_{\text{portfolio}} \cdot V_{\text{portfolio}}(S) + w_{\text{terminal}} \cdot V_{\text{terminal}}(S)
$$

其中：
- $V_{\text{terminal}}(S)$：如果一方 HP=0 返回 ±1，否则 0
- $V_{\text{portfolio}}(S)$：从 PortfolioSnapshot 的 expectedFutureValue

$w_{\text{portfolio}} = 0.15$，$w_{\text{terminal}} = 0.25$（terminal 必须准确）。

#### 累积误差控制

MCTS 深度 3-5 时，transition 的 L1 投影在 inner node 会累积误差。控制方法：

$$
\text{confidence}_{\text{depth } d} = c_0 \cdot (1 - \epsilon)^d
$$

其中 $\epsilon = 0.15$（每层衰减 15%）。depth=3 时 $c = 0.95 \times 0.85^3 \approx 0.58$，此时 $\alpha(c) = 0.58^2 \approx 0.34$，transition 贡献自然衰减到 1/3。

depth=5 时 $c \approx 0.42$，$\alpha \approx 0.18$，几乎不影响排序。这是**正确行为**——MCTS 深层节点的价值应由 value model 而非 heuristic transition 主导。

---

## 难题二：H1-H9 审计与升级路径

### H1: 行动权约束

#### 当前状态

`transition-scorer.ts` 的 H1 scorer（约 80 行）实现了：
- declareEnd 时：如果存在有用动作（有伤害/治疗/抽牌/支援/召唤候选），罚 -3.0
- 对手已结束时 declareEnd：额外罚 -3.0（free window 浪费）
- R1 declareEnd：额外罚 -2.0
- 非 declareEnd 且有实体时：+0.5 cashout bonus

`declare-end-constraints.ts`（655 行）提供了独立的 MCTS prior penalty 系统，包含 kill threshold（14）、opponent ended（8）、dice budget floor（4×乘子）等。

#### 与 V27 的差距

1. **缺少 `shortActionValue` 计算**：V27 要求对每个有用动作计算 $Q_{\text{short}}(S,b)$，当前只用 binary（有/无有用动作）
2. **OpportunityLoss 不是差值**：V27 要求 $\max_b Q(S,b) - Q(S,\text{declareEnd})$，当前只给固定 -3.0
3. **CashoutGain 未量化**：endPhaseEV 和 readyOptionCashEV 未计算
4. **与 declare-end-constraints.ts 重复**：两套系统独立运行，可能冲突
5. **非 declareEnd 动作的 ActionRightsDelta 缺失**：V27 要求对每个动作评估其行动权价值

#### 升级路径

**最小改动集**：
1. 为每个候选动作添加 `shortActionValue` 估计（复用 `rankCandidate` 的 heuristic score，归一化到 [0,3]）
2. declareEnd 的 OpportunityLoss = $\max_{b \neq \text{end}} \text{normalizedScore}(b)$
3. 合并 declare-end-constraints 的 penalty 作为 H1 的硬约束部分（不删除，但让 H1 引用它）

**工作量**：~2 天。核心是修改 `scoreActionRights()` 约 40 行。

#### 风险

- 合并两套 declareEnd 系统可能导致双重惩罚。**检测**：监控 declareEnd 的平均 penalty 变化，如果翻倍说明重复。
- `shortActionValue` 归一化不当会导致 H1 贡献量级与其他约束不平衡。**检测**：记录 H1 的 raw 分布，与 H2-H9 对比。

---

### H2: 骰子稀缺元素

#### 当前状态

`transition-scorer.ts` 的 H2（约 40 行）：
- 计算动作骰子花费 `diceSpent`
- 效率奖励：`dmgPerDie = damage / diceSpent`，`efficiencyBonus = min(dmgPerDie * 0.5, 1.0)`
- 惩罚：`diceSpent * 0.3 - efficiencyBonus`

`baseline-policy.ts` 的 `computeDiceFitness` 和 `diceFitness` scoring component 独立计算骰子适配度。

#### 与 V27 的差距

1. **无 FutureActionValue 计算**：V27 要求评估「消耗这些骰子后，未来高价值动作还能不能做」
2. **无 Scarcity/Demand/Importance 分解**：当前只看花费量，不看该颜色骰子是否稀缺
3. **无同色骰瓶颈识别**：ALIGNED cost（需要 N 个同色骰）的特殊性未处理
4. **无后续动作枚举**：V27 的 `topFutureActionValue(S, h)` 未实现

#### 升级路径

**最小改动**：
1. 实现 `scarcityWeight(e, S) = 1 / (1 + \text{available}_e + \text{omni})$
2. 实现 `futureDemand(e, S)`：扫描 allCandidates 中需要元素 $e$ 的高分动作数
3. 将 H2 raw 改为 $\sum_e \text{consumed}_e \cdot \text{scarcity}(e) \cdot \text{demand}(e)$
4. 特别处理 ALIGNED cost：如果动作需要 N 个同色且 $\text{available}_e < N+1$，demand 翻倍

**工作量**：~3 天。主要是 `futureDemand` 需要遍历候选和角色技能。

#### 风险

- `futureDemand` 只看当前轮候选，看不到下一轮的需求。**缓解**：用 deck profile 的 `finisherDensity` 和 `reactionReliance` 作为 next-round 需求代理。
- 可能与 `diceFitness` scoring component 重复。**检测**：如果两者 Pearson 相关 > 0.7，考虑合并。

---

### H3: 元素附着债务

#### 当前状态

`transition-scorer.ts` 的 H3（约 50 行）：
- 追踪 self/opp 的 aura 变化（before vs after）
- `cashout`：立即反应伤害（从 candidate preview 获取）
- `setupGain`：新增附着价值（0.3 per new aura）
- `debt`：失去附着惩罚（-0.3 per lost aura）
- `oppGift`：给对手挂元素的惩罚

`baseline-policy.ts` 有 `reactionChainPrior`（reaction_chain scoring component），通过 `reaction-chain-templates.ts` 模板匹配奖励反应链。

#### 与 V27 的差距

1. **无 ReactionWindowEV 计算**：V27 要求评估「当前反应窗口的期望价值」和「动作后反应窗口的期望价值」的差值
2. **无"破坏下一步反应窗口"的惩罚**：当前只奖励触发了反应的 skill，不惩罚消耗了附着导致后续无法反应
3. **aura debt 是常数 0.3**：没有根据附着对后续反应的重要性加权
4. **无 oppGift 风险评估**：给对手挂元素后对手能否反打，未评估

#### 升级路径

**最小改动**：
1. 实现 `reactionWindowEV(S, side)`：遍历 side 的角色，对每个有附着的角色计算「队友中谁有对应元素技能 + 该技能的伤害 × 可用概率」
2. debt 改为 $\text{reactionWindowEV}(S) - \text{reactionWindowEV}(T(S,a))$
3. setupGain 改为 $\max(0, \text{reactionWindowEV}(T(S,a)) - \text{reactionWindowEV}(S))$

**需要的信息**：
- 每个角色的元素类型（已有，从 observation 获取）
- 每个角色的技能元素（需要从 character definition 查询，已有 skill profile）
- 骰子是否足够释放技能（需要查骰子状态）

**工作量**：~4 天。reactionWindowEV 是最复杂的子函数。

#### 风险

- 反应窗口 EV 估计不准（不知道队友是否真的能切换到位）。**缓解**：引入 `switchCost` 折扣因子 0.7。
- 物理/岩队此约束几乎为 0，可能引入噪声。**缓解**：如果 $\text{reactionReliance} < 0.2$，H3 weight 设为 0。

---

### H4: 支援/召唤位边际价值

#### 当前状态

`transition-scorer.ts` 的 H4（约 40 行）：
- 按 slot 位置给乘子：[1.15, 1.0, 0.75, 0.45]
- slot 4 替换：`(newValue - 1.5) * mult`
- 非 support 动作返回 0

`portfolio-snapshot.ts` 有 `slotPressure` 计算（supportSlotsUsed / MAX_SUPPORT_SLOTS），用于 temporal opportunity 组件。

#### 与 V27 的差距

1. **无 RetentionEV 计算**：被替换的支援的剩余价值未计算
2. **newValue 是常数 1.5**：不是从 temporal profile 推导的 `ExpectedPayoffEV`
3. **ReplacementPenalty 是硬编码 0.25**：V27 要求基于被替换实体的剩余价值

#### 升级路径

**最小改动**：
1. 从 `PortfolioSnapshot.active` 获取每个支援的 `expectedPayoff`
2. `retentionEV(slot_i) = active[i].expectedPayoff * (1 - \text{usageDecay})$
3. `newSupportEV(a) = profilePayoff(a) - deployCost(a)`（从 temporal profile registry 获取）
4. 替换 delta = `newSupportEV - min(retentionEV) - 0.25`

**工作量**：~2 天。核心是桥接 PortfolioSnapshot 的数据到 H4。

#### 风险

- 如果 temporal profile 的 payoff 估计不准，替换决策会更差。**检测**：在 benchmark 中监控 support replacement 频率变化。

---

### H5: 角色功能完整性

#### 当前状态

`transition-scorer.ts` 的 H5（约 50 行）：
- 从 maxEnergy/maxHp 推断简单角色：carry（maxEnergy≤2 & maxHp≥10）、enabler（maxEnergy≥3）、protector（maxHp≥12 & maxEnergy≥3）、hybrid
- carry burst ready (+1.5)、HP loss cost、exposure risk

`baseline-policy.ts` 有 `FunctionalTier` 和 `DECK_DEFAULT_ROLE_MAP`（**为空**）。

#### 与 V27 的差距

1. **DECK_DEFAULT_ROLE_MAP 为空**：所有角色默认走 "tactical" 推断
2. **角色推断太粗糙**：只用 maxEnergy/maxHp，不看技能效果、不看 deck 构成
3. **无 DeckRoleProfile**：V27 要求从 deck code 自动推断每个角色的功能角色
4. **riskWeight 和 cashoutImportance 未分化**：V27 要求 per-character 权重

#### 升级路径

**可行方案**：从 deck 构成静态推断角色：

```typescript
function inferDeckRoleProfile(deckCards: number[]): DeckRoleProfile {
  const characters = extractCharacters(deckCards)
  const supportEngine = countSupportEngine(deckCards)
  const reactionCards = countReactionEnablers(deckCards)
  
  return {
    roles: characters.map(c => ({
      id: c.definitionId,
      role: inferRole(c, deckCards),      // carry/enabler/protector
      riskWeight: inferRiskWeight(c, deckCards),
      cashoutImportance: inferCashout(c, deckCards),
    }))
  }
}
```

推断规则：
- 角色有 burst 卡配合 → carry
- 角色技能给队友挂元素 → enabler
- 角色 maxHp 最高且有护盾卡 → protector
- riskWeight = cashoutImportance × 1.5

**工作量**：~3 天。主要是 `inferRole` 的 heuristic 规则库。

#### 风险

- 推断错误（把 carry 标成 enabler）会导致整个 H5 方向反。**缓解**：先在 8 套 benchmark deck 上手工验证推断结果，确认正确率 > 90%。

---

### H6: 对手 cashout readiness

#### 当前状态

`transition-scorer.ts` 的 H6（约 60 行）：
- 计算对手威胁 delta（before vs after）
- 威胁因子：burst readiness（+2.0 if energy full）、dice availability（+0.5）、active HP in kill range（+2.0 for ≤2）、summon count、reaction window
- raw = delta × 0.5

`opponent-model.ts` 维护 `OpponentModelState`（archetype posterior、aggression 等），但**未进入 H6 计算**。

#### 与 V27 的差距

1. **无一动斩杀检测**：V27 的 `p_lethal_1` 要求回答「对手下一动能否杀我」
2. **无 endPhaseExpectedDamage**：对手的召唤物/状态在结束阶段能造成多少伤害
3. **无 burstOnlineCharacters**：对手有几个角色已充满能
4. **OpponentModel 是风格描述，不是可执行威胁**：aggression 不直接转化为伤害估计

#### 升级路径

**最小改动**：
1. 实现 `opponentOneStepLethal(S)`：遍历对手角色技能，检查 max(skillBaseDmg + reactionBonus) ≥ selfActiveHp
2. 实现 `endPhaseDamage(S)`：从对手召唤物/状态的 `endPhase` 效果累加
3. 将 H6 raw 改为 `threatBefore - threatAfter`，其中 `threat = θ · ThreatVector`
4. ThreatVector 的权重 θ 从 V27 推荐值开始：$p_{\text{lethal}} = 3.0$, burst = 1.5, endPhase = 1.0, reaction = 1.0

**工作量**：~3 天。`opponentOneStepLethal` 需要查 skill profile 和骰子状态。

#### 风险

- 对手一动斩杀估计过于保守（不考虑骰子不够的情况）。**缓解**：引入 `diceFeasibility` 折扣：如果对手没有足够的匹配骰，`p_lethal` 乘以 0.3。

---

### H7: 先后手与轮次节奏

#### 当前状态

`transition-scorer.ts` 的 H7（约 30 行）：
- 按轮次给乘子：R1 first=1.25, R1 second=1.10, R2-3=1.1/1.0, late=1.15
- 按动作类型给因子：skill=1.0, switch=0.8, playCard=0.9
- free window 加 +0.4

`baseline-policy.ts` 有 `tempo` scoring component（权重 0.3）。`declare-end-constraints.ts` 有 `moverFactor`。MCTS prior 也有 mover 调整。

#### 与 V27 的差距

1. **四处散落**：tempo 概念分散在 H7、baseline tempo、declare-end moverFactor、MCTS prior 中
2. **无统一 RoundTempoState**：V27 要求一个共享数据结构
3. **乘子未与 action value 关联**：当前只乘 action type 因子，不乘动作的实际价值

#### 升级路径

**最小改动**：
1. 定义 `RoundTempoState` 类型，在 scoring 入口处计算一次
2. H7 raw = `tempoMultiplier(S) × tempoActionValue(S, a)`
3. baseline tempo component 改为引用同一个 `RoundTempoState`（不重复计算）
4. declare-end-constraints 的 moverFactor 从 RoundTempoState 获取

**最可能出问题的地方**：baseline tempo 和 H7 双重计算。如果两处都贡献 tempo bonus，快节奏动作会被过度奖励。**检测**：记录 tempo 总贡献，如果 > 2.0 说明重复。

**工作量**：~2 天。

#### 风险

- 统一后如果 RoundTempoState 计算有 bug，影响面扩大。**缓解**：保留 baseline tempo 作为 fallback，H7 通过 config flag 开关。

---

### H8: 手牌 option retention

#### 当前状态

`transition-scorer.ts` 的 H8（约 40 行）：
- 只对 elementalTuning 生效
- `unlockGain = 0.5`（常数）
- `retentionValue`：基于 meta_effect_slots（从 candidate 获取）
- `reactionValue`、`finisherLoss`、`setupLoss` 都是 heuristic 估计

`baseline-policy.ts` 有 `guardrail` scoring component（权重 1.0），惩罚浪费调谐。

#### 与 V27 的差距

1. **unlockGain 是常数 0.5**：V27 要求 $\max_b (Q(T(S,a),b) - Q(S,b))$
2. **无每张牌的 Retention 计算**：V27 要求 `CurrentPlayableEV + FutureOptionEV + SynergyProviderEV - DuplicateDiscount`
3. **无 SynergyProviderEV**：被调谐掉的牌是否是某个 combo 的必要组件
4. **对 playCard 不生效**：V27 要求对 playCard 也计算 `-FutureOptionEV(card)`

#### 升级路径

**最小改动**：
1. 实现 `cardRetentionValue(card, S)`：
   - `playableEV` = 从 temporal profile 获取 payoff（如果有），否则按 card type 给默认值
   - `futureOptionEV` = 如果下回合能打出且 payoff > 0.5，给 0.3；否则 0
   - `synergyProviderEV` = 如果 card 是某 reaction chain 的组件，给 0.4
   - `duplicateDiscount` = 如果手牌中有同 definitionId 的牌，× 0.5
2. `unlockGain` = 扫描 tuning 后能做的动作中 score 最高的 vs 当前最高分的差值
3. 对 playCard 也生效：`raw = -futureOptionEV(card)`

**工作量**：~3 天。

#### 风险

- retention 估计偏高会导致调谐过少。**检测**：监控 tuning 频率变化，如果下降 > 30% 说明 retention 过高。

---

### H9: 随机性与隐藏信息

#### 当前状态

`transition-scorer.ts` 的 H9（约 20 行）：
- `handVariance`：基于对手手牌数量的 heuristic（`handSize * 0.1`）
- `healthPressure`：`1 - selfActiveHp / selfActiveMaxHp`
- raw = `-(handVariance + healthPressure * 0.3)`

`hidden-info-estimator.ts`（237 行）在 `src/learning/rl/` 下，提供 `cardInHandProbabilityUpperBound` 和 `batchCardProbabilities`，但**未进入 runtime scoring 主链**。

#### 与 V27 的差距

1. **hidden-info-estimator 未接入**：有概率估计器但没用在 scoring 中
2. **无风险区间**：V27 要求输出 `[lower, upper]` 而非点估计
3. **当前只是 heuristic proxy**：手牌数量 × 0.1 不是真正的隐藏信息风险

#### 升级路径

**最小改动**：
1. 将 `hidden-info-estimator` 的 `batchCardProbabilities` 接入 H9
2. 计算 `hiddenLethalProb`：对手可能持有斩杀卡的概率上限
3. H9 raw = `-hiddenLethalProb × riskExposure(S,a) - diceFailProb × planDependency(S,a)`
4. `riskExposure`：如果 a 是 declareEnd 或 passive，= 1.0；否则 = 0.3

**为什么之前没接入**：接口不匹配——hidden-info-estimator 输出的是 per-card 概率，而 scoring 需要 per-action 风险。需要桥接函数。

**工作量**：~2 天。

#### 风险

- 概率上界过于保守（总是假设对手有最强卡）。**缓解**：引入 deck profile 先验——如果对手卡组不含斩杀卡，`hiddenLethalProb` 设为 0。

---

### H1-H9 升级总览

| 约束 | 当前完成度 | 缺失核心 | 工作量 | 风险等级 |
|------|-----------|---------|--------|---------|
| H1 行动权 | 60% | shortActionValue 量化 | 2天 | 低 |
| H2 骰子 | 30% | FutureActionValue + Scarcity | 3天 | 中 |
| H3 附着 | 40% | ReactionWindowEV | 4天 | 中 |
| H4 支援位 | 50% | RetentionEV 桥接 | 2天 | 低 |
| H5 角色 | 20% | DeckRoleProfile 推断 | 3天 | 高 |
| H6 对手威胁 | 40% | 一动斩杀 + endPhase | 3天 | 中 |
| H7 节奏 | 50% | 统一 RoundTempoState | 2天 | 低 |
| H8 手牌 | 30% | cardRetentionValue | 3天 | 中 |
| H9 隐藏信息 | 15% | 桥接 hidden-info-estimator | 2天 | 中 |

**推荐升级顺序**：H1 → H4 → H7 → H2 → H8 → H6 → H3 → H5 → H9

总计约 24 天工作量。

---

## 难题三：Deck/Matchup 条件化真正路径

### 3.1 条件化 prior 数学框架

#### 当前问题分析

当前 `deck-action-prior.ts` 已实现 action-conditional prior（51 个 DeckPriorFeatureVector 特征 → per-action bonus），但它是**规则引擎**（`if feature > 0.3 → bonus = feature × multiplier`），不是从数据学到的。

核心问题：规则是手工设定的 threshold 和 multiplier，没有自适应能力。

#### 条件化 prior 的形式化定义

$$
\text{ActionPrior}(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, a, S) = \mathbf{w}^T \cdot \phi(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, \text{tags}(a), S)
$$

其中 $\phi$ 是特征交叉函数：

$$
\phi(\mathbf{d}_{\text{self}}, \mathbf{d}_{\text{opp}}, \mathbf{t}, S) = \mathbf{d}_{\text{self}} \otimes \mathbf{t} \;\|\; \mathbf{d}_{\text{opp}} \otimes \mathbf{t} \;\|\; (\mathbf{d}_{\text{self}} - \mathbf{d}_{\text{opp}}) \otimes \mathbf{t} \;\|\; \mathbf{t} \;\|\; S_{\text{phase}}
$$

$\otimes$ 是外积（或 element-wise product 以控制维度），$\|$ 是拼接。

#### semantic\_tags(action) 提取

```typescript
interface ActionSemanticTags {
  // 动作类型（one-hot 或 multi-hot）
  isSkill: number          // useSkill
  isNormalAttack: number   // normal attack specifically
  isElementalSkill: number
  isBurst: number
  isSwitch: number
  isPlayCard: number
  isTuning: number
  isDeclareEnd: number
  
  // 效果标签（从 candidate preview 提取）
  dealsDamage: number      // 0 or 1
  damageAmount: number     // normalized [0, 1]
  triggersReaction: number
  heals: number
  drawsCards: number
  createsSupport: number
  createsSummon: number
  createsEquipment: number
  gainsEnergy: number
  costsDice: number        // normalized [0, 1]
  usesSameElement: number  // requires aligned dice
  
  // 战略标签（从 engine mutation 推断）
  isSetup: number          // creates future value (support, summon, equipment)
  isCashout: number        // realizes existing value (burst, reaction)
  isDefensive: number      // switch, heal, shield
  isTempo: number          // fast action, doesn't end turn
}
```

**提取方式**：混合使用三种来源：
1. **action type**（可靠）：case 字段直接推断 isSkill/isSwitch/etc
2. **candidate preview**（中等可靠）：previewDamage、healing、createSupport 等字段
3. **engine mutation**（高可靠但贵）：只在 root 节点使用

#### deck 特征如何影响 tag 权重

定义 deck archetype vector $\mathbf{d} \in \mathbb{R}^{11}$：

```
d = (setupSpeed, tempoPush, longGameValue, defensiveStability,
     finisherDensity, reactionReliance, supportReliance,
     talentReliance, equipmentReliance, summonReliance, dependencyRisk)
```

交叉特征的语义：
- $\mathbf{d}_{\text{self}}.\text{tempoPush} \times \mathbf{t}.\text{isSetup}$：快攻卡组惩罚 setup 动作
- $\mathbf{d}_{\text{self}}.\text{reactionReliance} \times \mathbf{t}.\text{triggersReaction}$：反应队奖励反应触发
- $(\mathbf{d}_{\text{self}}.\text{longGameValue} - \mathbf{d}_{\text{opp}}.\text{longGameValue}) \times \mathbf{t}.\text{isSetup}$：长期价值优势时奖励 setup

#### 与 GBDT ranker 的集成

**方案：加特征列**（不是独立模型，不是门控）。

将 ActionPrior 的输出作为 ranker 的**额外特征**，让 GBDT 自己学习在什么状态下 trust prior：

```
features = existingFeatures ∪ {
  prior_score: ActionPrior(d_self, d_opp, a, S),
  prior_x_tempo: ActionPrior × tempoPush_self,
  prior_x_round: ActionPrior × (1/round),
}
```

原因：独立模型无法利用 ranker 已有的 state features；门控增加复杂度但收益不明确。加特征列让 GBDT 在训练时自动学到 prior 的可信度。

---

### 3.2 可学习性分析

#### 8 套卡组够不够？

**不够，但可以用**。分析如下：

设 per-deck prior 有 $p$ 个参数。当前 $\mathbf{d} \in \mathbb{R}^{11}$，$\mathbf{t} \in \mathbb{R}^{17}$，交叉特征维度 $= 11 \times 17 \times 3 + 17 + 1 \approx 579$。

8 套卡组 → 8 × 8 = 64 个 matchup（含 mirror），每个 matchup 约 $120000 / 64 \approx 1875$ 样本。

579 个参数 vs 1875 样本 → 参数/样本比 ≈ 0.31，**过拟合风险高**。

**解决方案**：

1. **降维**：不学全交叉，只学 top-K 有意义的交叉特征。从 deck archetype 的先验知识选 K=30 个交叉特征。
2. **正则化**：L2 正则 $\lambda = 0.1$，或 GBDT 的 `min_child_samples = 50`。
3. **分层学习**：先学 per-archetype（aggressive/control/combo 三类），再 per-deck fine-tune。

#### 需要更多 deck mirror 吗？

**Mirror 对局不需要增加**，因为 mirror 的 deck prior 差分为零（$\mathbf{d}_{\text{self}} = \mathbf{d}_{\text{opp}}$），prior 贡献退化为只依赖 action tags 和 state。Mirror 对局的差异主要来自 state features 而非 deck prior。

**需要增加的是非 mirror 对局的多样性**：当前 8 套 × 7 非 mirror = 56 个非 mirror matchup，每个约 1875 样本。增加到 12 套卡组会更好（132 个 matchup），但工程成本较高。

#### 从 self-play 学 vs 从 deck code 静态分析？

**混合方案**：

1. **静态分析生成 prior**：从 deck code 提取 archetype vector $\mathbf{d}$（已有 `card-affinity-analyzer.ts`），用规则引擎生成 initial prior（已有 `deck-action-prior.ts`）。
2. **self-play 数据调整 multiplier**：将规则引擎的 multiplier 作为初始权重，用 self-play 数据做 ridge regression 调整。

$$
\mathbf{w}^* = \arg\min_{\mathbf{w}} \sum_i (y_i - \mathbf{w}^T \phi_i)^2 + \lambda \|\mathbf{w} - \mathbf{w}_0\|^2
$$

$\mathbf{w}_0$ 是规则引擎的初始权重，$\lambda$ 控制向先验收缩的强度。

---

### 3.3 可证伪实验

#### 实验设计

**假说**：action-conditional learned prior 优于 rule-based action-conditional prior。

**配置**：

| 组 | 配置 |
|----|------|
| Baseline | 当前 V28：rule-based deck-action-prior |
| Treatment | ridge regression 学到的 prior weights |

**指标**：

1. **Primary**：全 matchup benchmark WR（8×8×2=128 方向，每方向 20 场 = 2560 场）
2. **Secondary**：mirror WR stddev（衡量 per-deck 泛化）
3. **Diagnostic**：same-decision-point top-1 change rate（prior 实际改变了多少决策）

#### 最小测试集

不需要全 128 方向。选 4 个最可能受 prior 影响的 matchup：

1. 快攻 vs 控制（tempo vs longGame 差异大）
2. 反应队 vs 物理队（reactionReliance 差异大）
3. Mirror match（检验 prior 不引入噪声）
4. 支援引擎 vs 反支援（supportReliance vs antiSupport 冲突）

每个 matchup 40 场（双向各 20），共 160 场。

#### 判定标准

**假说被证实**：
- Treatment 全 matchup WR ≥ Baseline + 2%（绝对值）
- Treatment mirror WR stddev ≤ Baseline stddev − 3%
- top-1 change rate ≥ 5%（prior 确实在改变决策，不是无效特征）

**假说被拒绝**：
- Treatment WR < Baseline（prior 引入噪声）
- mirror WR stddev 不下降（prior 没有 per-deck 泛化效果）
- top-1 change rate < 1%（prior 权重过正则化，退化为零）

**假说部分成立**：
- 总 WR 提升但 stddev 不降（学到了全局 prior 但没有 per-deck 差异化）
- 只在部分 matchup 有效（需要更细粒度的条件化）

---

## 总结

### 核心要点

1. **Transition scoring**：通过 $c^2$ 置信度衰减 + smooth maximum 门控 + 大惩罚硬约束实现完整的 confidence-aware scoring
2. **H1-H9**：V0 骨架已存在但普遍缺少量化计算（FutureActionValue、ReactionWindowEV、RetentionEV 等），升级路径以「桥接现有数据源」为主，每项 2-4 天，总计约 24 天
3. **Deck prior**：从规则引擎升级到 ridge regression 学习，用特征交叉降维控制过拟合，4-matchup 160 场最小实验验证

### 实施优先级路线图

```
Phase 1 (Week 1-2):
  - 1.1 投影可信度自适应
  - 1.2 smooth maximum 门控替换
  - 1.3 HardConstraint 统一接口
  - H1 升级 (shortActionValue)
  - H4 升级 (RetentionEV 桥接)
  → 验收：合成状态单调性测试全通过

Phase 2 (Week 3-4):
  - H7 统一 (RoundTempoState)
  - H2 升级 (Scarcity/Demand)
  - H8 升级 (cardRetentionValue)
  - 1.4 MCTS 集成 (inner node cheap transition)
  → 验收：benchmark WR ≥ baseline, declareEnd error rate ↓ 30%

Phase 3 (Week 5-6):
  - H6 升级 (一动斩杀检测)
  - H3 升级 (ReactionWindowEV)
  - 3.1-3.3 Deck prior 条件化 + 可证伪实验
  → 验收：mirror WR stddev ↓ 5%+

Phase 4 (Week 7-8):
  - H5 升级 (DeckRoleProfile)
  - H9 升级 (hidden-info-estimator 桥接)
  - 全链路 ablation benchmark
  → 验收：V27 §23 可证伪标准全部满足
```
