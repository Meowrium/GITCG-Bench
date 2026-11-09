# 对战 AI 改进方案 v3

> 基于 `replay-hidden-constraints-analysis.md` 的分析结论，对照项目代码的实际状态，制定的具体改进方案。
> 充分考虑 v2 对采样偏差的修正（H1-H8 仍然成立，P1-P9 需要同策略验证数据）。

---

## 〇、现状评估：哪些"已实现"，哪些"已声明但空洞"

| 约束 | 声明层 | 实际效果 | 差距 |
|------|--------|---------|------|
| H1 爆发窗口 | `burst_online_bonus` shaping + `burst_convert` plan | 仅给 burst_online 事件一口平价奖励，不感知"角色还能活几步" | **关键差距**：充能角色在爆发兑现窗口期无保护优先级 |
| H2 功能层级保护 | `self_role_integrity_score` derived feature | 仅作为宏观指标传入值函数，baseline policy 中角色保护无区分 | **关键差距**：核心角色与辅助角色被同等对待 |
| H3 多步规划 | `CombatWindowLibrary` + `plan-search` + `remaining_actions` | combat window 是事后模板匹配，非实时搜索；宏观计划 `remaining_actions` 是粗略计数 | **关键差距**：无真正的回合内操作序列前瞻 |
| H4 反应链规划 | `ReactionChainTemplates` + `reaction_ready_bonus` | 模板只检查 aura 存在，不检查手牌/骰子/站位可执行性；bonus 太小（0.03~0.7×0.1） | **中等差距**：匹配太粗，权重太低 |
| H5 骰子经济学 | `diceSkillAlignment` feature + `computeDiceQualityMetrics` | 仅在 baseline 打分时计算，没用于回合初规划 | **中等差距**：骰子规划是逐个动作贪心而非回合初统筹 |
| H6 阶段感知 | `GamePlan` + `detectGamePhase` | 阶段检测存在但仅影响宏观计划类型，不影响 baseline 评分权重 | **中等差距**：阶段切换权重无动态调整 |
| H7 角色数量适应 | `selfAliveCount` feature | 仅作为 ML 特征传入，无策略模式切换 | **小差距**：2 角色时仍用 3 角色策略 |
| H8 HP 非线性价值 | `healUrgency` + `focusKill bonus` | 治疗紧急度仅基于 HP 比例，焦点击杀仅看对手低血 | **中等差距**：不同角色的同一 HP 兆不同保护价值 |

**核心发现**：项目已具备"声明层基础设施"（特征、shaping、宏观计划），但 **baseline policy 的 `rankCandidate` 是逐个动作贪心打分，缺乏回合级规划和角色级区分**。改进的杠杆点在于：

1. 在现有 `rankCandidate` 评分函数中注入 **回合级上下文特征**
2. 增量改造 **宏观计划系统**，使其承载更丰富的规划信息
3. 新增 **角色价值评估模块**，为保护/切换决策提供依据
4. 调整 **shaping reward** 的权重和结构，让 RL 训练信号更强

---

## 一、P0 改进：爆发窗口约束（H1）+ 多步规划（H3）

### 1.1 爆发窗口紧迫度特征

**问题**：当前 `energyGain` 评分 `energyGain * urgency * energyWeight` 中的 `urgency` 只看 active 角色的 `energyGap ≤ 1 ? 1.3 : 0.8`，不区分角色功能层级，也不考虑角色还能存活多少步。

**改动**：在 `baseline-policy.ts` 的 `rankCandidate` 中引入 **burst_window_urgency**：

```typescript
/**
 * 爆发窗口紧迫度 — 衡量"充能角色还需多少步才能兑现爆发"的紧迫性。
 *
 * 核心洞察：元素爆发不一定要在当前回合开。"紧迫度"不是"能量满了就得开"，
 * 而是"这个角色的爆发兑现窗口还有多宽"——取决于角色存活概率和爆发时机的
 * 边际价值。
 *
 * 三层评估：
 * 1. 窗口坍缩风险：角色是否在对手下一轮攻击后可能死亡（基于对手伤害容量估计）
 * 2. 爆发递延价值：推迟爆发是否能通过反应链或元素附着获得更多收益
 * 3. 爆发就绪程度：能量接近满的角色是否应该在下个决策点被优先保护
 */
function burstWindowUrgency(
  character: CharacterInfo,
  opponentDamageCapacity: number,  // 对手当前轮可打出的最大伤害估计
  hasReactionChainSetup: boolean,  // 当前场面是否有未兑现的反应链
): number {
  const energyGap = (character.max_energy ?? 3) - (character.energy ?? 0)
  const hpRatio = (character.hp ?? 0) / Math.max(1, character.max_hp ?? 10)

  // 能量未接近满 → 无紧迫感，但充能仍有价值
  if (energyGap >= 3) return 0.5

  // --- 窗口坍缩风险评估 ---
  // 对手伤害容量 vs 角色当前 HP：角色能否存活到下一个爆发兑现窗口？
  const survivalRisk = Math.min(1, opponentDamageCapacity / Math.max(1, character.hp))

  // --- 爆发递延价值评估 ---
  // 如果场面有未兑现的反应链（如已挂元素待触发），推迟爆发可能获得更高总伤害
  const deferValue = hasReactionChainSetup ? 0.3 : 0.0

  // 能量快满（gap ≤ 1）时的紧迫度计算
  if (energyGap <= 1) {
    if (survivalRisk >= 0.8) {
      // 窗口即将坍缩：角色很可能在下轮死亡，必须在当前或近期兑现
      return 3.0 - deferValue
    }
    if (survivalRisk >= 0.4) {
      // 窗口有压力但不紧迫：保护优先级提高，但不必立即爆发
      return 1.8
    }
    // 窗口安全：可以等待更好的爆发时机
    return 1.2 + deferValue
  }

  // 能量 gap = 2：中等紧迫
  if (energyGap === 2) {
    return 1.0
  }

  return 1.0
}
```

**关键设计要点**：

1. **爆发递延**：`hasReactionChainSetup` 允许推迟爆发以先兑现反应链加成。例如，如果场景上已有水元素附着，可以先打蒸发再开爆发，而非立即开爆发。

2. **存活风险驱动**：紧迫度取决于 `opponentDamageCapacity / hp`，而非简单的 HP 阈值。这意味着 4HP 角色对抗高爆发卡组紧迫度高（survivalRisk ≈ 0.8+），但对抗慢速卡组紧迫度低（survivalRisk ≈ 0.3）。

3. **保护与兑现的分离**：高紧迫度不等于"必须立即开爆发"，而是"必须保护该角色直到爆发兑现"。这体现在：
   - `burstWindowUrgency > 1.5` → 保护该角色（不被暴露在前台、治疗优先）
   - 检测到 `survivalRisk ≥ 0.8` 且 `energyGap ≤ 1` → 考虑在当前回合兑现爆发（而非再等一轮）

在 `rankCandidate` 的 `energyGain` 评分中使用：
```typescript
const opponentDmgCap = estimateOpponentDamageCapacity(digest)
const hasReactionSetup = reactionChainMatches.length > 0 && reactionChainMatches[0].completed_steps > 0
const burstUrgency = burstWindowUrgency(activeChar, opponentDmgCap, hasReactionSetup)
const energyScore = energyGain * burstUrgency * p.energyWeight
```

在保护决策中使用（切人/治疗评分）：
```typescript
// 当角色爆发窗口紧迫度高时，提高保护优先级
// 切人：目标不是保护角色时，如果保护角色暴露在前台 → 加重惩罚
if (actionCase === "useSkill" && !tags.includes("skill_type:burst") && burstUrgency >= 2.0) {
  // 核心充能角色不应在前台做非爆发操作——应该切走或等待爆发时机
  score -= burstUrgency * 0.5
  reasons.push(`burst_window_risk=-${(burstUrgency * 0.5).toFixed(2)}`)
}
```

**新增 shaping reward**：在 `reward-config.ts` 中增加 `burst_waste_penalty`：
```typescript
/**
 * 爆发浪费惩罚 — 角色死亡时浪费的能量值
 *
 * 注意：惩罚不是"角色有能量就一定要在下一轮爆发"，而是惩罚"角色的爆发窗口
 * 因角色死亡而永久关闭"。惩罚强度与浪费能量量成比例，但不惩罚"合理递延"。
 */
burst_waste_penalty_coef: 0.04  // 每点浪费能量惩罚 0.04（略低于原始提案 0.05，
                                 // 因为并非所有浪费都应被等权惩罚）
```

在 `computeRewardBreakdownV1` 中计算：
```typescript
function computeBurstWastePenalty(previous: ObservationV1, next: ObservationV1): number {
  let penalty = 0
  for (const prevChar of previous.self.characters) {
    if (!prevChar.alive) continue
    const nextChar = next.self.characters.find(c => c.definition_id === prevChar.definition_id)
    if (nextChar && nextChar.alive) continue

    // 角色从 alive → dead：计算浪费的能量
    const wastedEnergy = prevChar.energy
    // 爆发就绪（能量满）的浪费惩罚更重
    const multiplier = prevChar.energy >= prevChar.max_energy ? 1.5 : 1.0
    penalty += wastedEnergy * multiplier
  }
  return penalty
}
```
### 1.2 回合初规划注入

**问题**：当前 AI 在每个 `rankCandidate` 调用中独立评估每个候选动作，不知道"如果我先做 A，后面的 B 就做不了了"。

**改动**：利用已有的 `CombatWindowLibrary` 和 `plan-search.ts`，在回合开始时（第一个决策点）生成 **TurnPlan**，传给后续每个 `rankCandidate` 调用。

在 `PolicyDecisionContext` 中新增字段：

```typescript
// types.ts 新增
export interface TurnPlan {
  /** 本回合计划执行的动作类型序列（如 ["useSkill", "switchActive", "useSkill"]） */
  plannedActionSequence: string[]
  /** 本回合的计划宏类型 */
  planKind: RuntimeMacroPlanKind
  /** 关键骰子需求（哪些颜色、各需多少） */
  diceRequirements: Map<DiceType, number>
  /** 保护角色 ID 列表（本回合不应暴露在前台的角色） */
  protectedCharacterIds: number[]
  /** 是否有爆发兑现窗口（本回合应释放 burst） */
  hasBurstWindow: boolean
  /** 是否有反应链兑现窗口 */
  hasReactionWindow: boolean
}
```

在 `GiMlPolicy.choose()` 中，当 `observation.point.action_count_in_round === 0` 时，生成 TurnPlan：

```typescript
if (observation.point.action_count_in_round === 0) {
  const turnPlan = generateTurnPlan(digest, observation, macroPlanState.plan, reactionChainMatches)
  context.turnPlan = turnPlan
}
```

`generateTurnPlan` 的核心逻辑：
1. 从 combat window library 获取匹配的窗口计划
2. 从 reaction chain matches 获取下一步需要的元素
3. 从 self characters 中识别 burst-online 角色和其存活窗口
4. 计算骰子需求汇总 → `diceRequirements`
5. 标记保护角色 → `protectedCharacterIds`

在 `rankCandidate` 和 `scoreCandidateAgainstMacroPlan` 中使用 TurnPlan：

```typescript
// 如果候选动作会让保护角色暴露在前台 → 惩罚
const protectedIds = context?.turnPlan?.protectedCharacterIds ?? []
if (actionCase === "switchActive" && protectedIds.includes(targetCharId)) {
  score -= 2.0
  reasons.push("protect_char=-2.00")
}

// 如果有爆发窗口但候选动作不是爆发 → 惩罚
if (context?.turnPlan?.hasBurstWindow && actionCase !== "useSkill" &&
    !tags.includes("skill_type:burst")) {
  score -= 1.0
  reasons.push("burst_window_miss=-1.00")
}
```

### 1.3 骰子规划前置（回合初统筹）

**问题**：当前骰子使用是逐动作贪心，Agent 常出现"前几步用掉了关键骰子，后面无法执行计划操作"。

**改动**：在回合开始时（rerollDice 阶段后），基于 TurnPlan 的 `diceRequirements` 计算 **dice_reservation**，传给每个 `rankCandidate` 调用。

在 `PolicyDecisionContext` 中新增：

```typescript
export interface DiceReservation {
  /** 保留给后续关键操作的骰子（颜色 → 数量） */
  reserved: Map<DiceType, number>
  /** 回合剩余动作数估计 */
  estimatedRemainingActions: number
  /** 保留操作的目的（用于调试和日志） */
  reservedForReason: string
  /** 是否建议调和以配合计划 */
  tuningSuggested: boolean
  /** 调和建议的目标元素（如果有的话） */
  tuningTarget: DiceType | null
}
```

骰子预留的设计思想：

**核心原则**：骰子预留不是刚性锁定，而是"软约束"。预留的骰子可以在以下条件被释放：

1. **当前动作是序列中必须的一步**：如果 `TurnPlan.plannedActionSequence` 明确规划了"第一步 A → 第二步 B"的序列，且 A 需要消耗某颜色骰子，那么这个骰子的消耗是"序列内合理的"，不触发预留惩罚。
2. **序列完成后无更高优先级操作**：如果序列已执行完毕，所有预留骰子释放。
3. **适度的调和以提升计划成功率**：如果骰子颜色不匹配计划需求，鼓励调和——但调和的卡牌有保留价值时需权衡。

在 `rankCandidate` 中的实现：

```typescript
const reservation = context?.diceReservation
if (reservation && reservation.reserved.size > 0) {
  const costMap = buildCostMapFromCandidate(candidate)
  
  // 检查当前动作是否在计划的序列中 → 如果是，预留骰子消耗是合理的
  const isInPlannedSequence = context?.turnPlan?.plannedActionSequence
    ?.some(plannedCase => actionCase === plannedCase) ?? false
  
  for (const [type, count] of costMap) {
    const reservedCount = reservation.reserved.get(type as DiceType) ?? 0
    if (count > 0 && reservedCount > 0) {
      if (isInPlannedSequence) {
        // 序列内的骰子消耗: 只收轻微惩罚（1/3 全额），因为计划本身就预期这步消耗
        const softPenalty = Math.min(count, reservedCount) * 0.25
        score -= softPenalty
        if (softPenalty > 0) reasons.push(`dice_seq_consume=-${softPenalty.toFixed(2)}`)
      } else {
        // 非序列动作消耗预留骰子: 全额惩罚
        const conflictPenalty = Math.min(count, reservedCount) * 0.8
        score -= conflictPenalty
        reasons.push(`dice_reservation=-${conflictPenalty.toFixed(2)}`)
      }
    }
  }
}

// 对调和动作的特殊处理：如果调和方向与计划需求一致 → 奖励
if (actionCase === "elementalTuning" && reservation.tuningSuggested && reservation.tuningTarget != null) {
  const tuningDestElement = /* 从 candidate 中提取调和目标元素 */
  if (tuningDestElement === reservation.tuningTarget) {
    score += 0.5
    reasons.push("tune_for_plan=+0.50")
  }
}
```

调和的鼓励机制：在 `GiMlPolicy.choose()` 生成 DiceReservation 时，如果发现骰子颜色缺口可以由调和弥补：

```typescript
// 生成 tuningSuggestion 的逻辑
const unmatchedDiceGap = computeDiceGap(diceValues, turnPlan.diceRequirements)
const tunableCards = handCards.filter(c => isTuningCard(c))
const hasTuningOption = tunableCards.length > 0

diceReservation.tuningSuggested = unmatchedDiceGap > 0 && hasTuningOption
diceReservation.tuningTarget = unmatchedDiceGap > 0
  ? identifyMostNeededElement(unmatchedDiceGap, turnPlan.diceRequirements)
  : null
```

---

## 二、P1 改进：功能层级保护（H2）+ 反应链规划（H4）

### 2.1 角色功能层级评估

**问题**：当前 AI 不区分角色的战略重要性。迪希雅作为核心挂火角色和 2301 作为 9HP 脆弱角色被同等对待。

**改动**：新增 `character-value-evaluator.ts`，为每个角色计算 **功能价值分**：

```typescript
export interface CharacterValueAssessment {
  characterDefinitionId: number
  /** 功能层级：core / tactical / residual */
  functionalTier: "core" | "tactical" | "residual"
  /** 功能坍缩距离：当前 HP 相对于"功能失效阈值"的距离 */
  collapseDistance: number  // 0~1, 越小越接近坍缩
  /** 爆发兑现紧迫度 */
  burstUrgency: number     // 0~3, 越高越需要尽快爆发
  /** 在卡组中的战略角色标签 */
  strategicTags: string[]
}

export function assessCharacterValue(
  character: CharacterObservation,
  deckArchetype: string,
  opponentArchetype: OpponentArchetype,
  gamePhase: GamePhaseKind,
): CharacterValueAssessment
```

**功能层级判定逻辑**：

```typescript
// 基于卡组 archetype 和角色能力判断核心角色
// 核心角色 = 卡组胜利路径的关键执行者
// 战术角色 = 提供关键功能（挂元素、减伤、切人）但不是主要输出
// 残余角色 = 功能已基本兑现或对当前阶段贡献有限

function determineFunctionalTier(
  charId: number,
  deckArchetype: string,
  energy: number,
  maxEnergy: number,
  hp: number,
  maxHp: number,
  phase: GamePhaseKind,
): "core" | "tactical" | "residual" {
  // 基于卡组 archetype 的角色映射表
  const roleMap = DECK_ROLE_MAP[deckArchetype]
  if (!roleMap) return "tactical"  // 未知卡组默认战术级

  const role = roleMap[charId]
  if (role === "core_dps" || role === "core_burst") {
    // 核心输出角色
    if (phase === "closing" && hp / maxHp > 0.5) return "core"
    if (phase === "setup" && energy / maxEnergy < 0.5) return "tactical"  // 展开期还未充能
    return "core"
  }
  if (role === "enabler" || role === "aura_applier") {
    // 辅助角色: 挂元素/减伤
    if (phase === "execution" || phase === "closing") return "residual"  // 后期功能已兑现
    return "tactical"
  }
  return "tactical"
}
```

**DECK_ROLE_MAP** 需要一个从卡组角色映射到功能层级的查找表。初期可硬编码 8 套对局卡组，后续通过数据分析枚举。

在 `rankCandidate` 中使用角色功能层级：

```typescript
// 切人保护：如果当前角色是核心且对方有威胁 → 不应切换到脆弱角色
const activeTier = assessCharacterValue(activeChar, deckArchetype, oppArchetype, phase)
if (actionCase === "switchActive") {
  const targetId = /* 目标角色 ID */
  const targetTier = assessCharacterValue(targetChar, deckArchetype, oppArchetype, phase)
  // 切到残余角色 → 轻微惩罚
  if (targetTier.functionalTier === "residual") {
    score -= 0.5
    reasons.push("residual_target=-0.50")
  }
  // 从核心角色切走时 → 如果核心角色 hp 安全且应该站场输出，惩罚
  if (activeTier.functionalTier === "core" && activeHpRatio > 0.5) {
    score -= 0.3
    reasons.push("leaving_core=-0.30")
  }
}

// 治疗/保护优先级：核心角色低血量比战术角色低血量更紧急
if (healing > 0) {
  const targetTier = assessCharacterValue(healTarget, ...)
  const tierMultiplier = targetTier.functionalTier === "core" ? 1.5
    : targetTier.functionalTier === "tactical" ? 1.0
    : 0.6
  score += healing * tierMultiplier * p.healingWeight
}

// expose_penalty: 不应将低HP核心角色暴露在前台承受伤害
if (activeTier.collapseDistance < 0.35 && activeTier.functionalTier === "core") {
  // 核心角色功能坍缩距离近 → 切走或治疗优先
  if (actionCase === "useSkill" && !tags.includes("skill_type:burst")) {
    score -= 0.8
    reasons.push("core_collapse_risk=-0.80")
  }
}
```

### 2.2 增强反应链规划

**问题**：当前 `ReactionChainTemplates` 只检查对手 active 角色的 aura，不检查：
- 我方手牌是否有对应元素技能
- 我方骰子是否能支付该技能
- 是否需要先切角色才能施放技能

**改动**：扩展 `matchReactionChainTemplates` 的匹配逻辑：

```typescript
export interface ReactionChainMatch {
  template: ReactionChainTemplate
  match_score: number
  completed_steps: number
  next_element_needed: ElementKind | null
  // 新增
  executable: boolean           // 当前手牌/骰子能否执行下一步
  requires_switch: boolean     // 是否需要切角色才能执行
  switch_target_id: number | null  // 需要切到哪个角色
}

// 在匹配时增加可执行性检查
function checkChainExecutability(
  match: ReactionChainMatch,
  characters: CharacterObservation[],
  diceValues: number[],
  handCards: CardObservation[],
): ReactionChainMatch {
  const neededElement = match.next_element_needed
  if (!neededElement) return { ...match, executable: false, requires_switch: false, switch_target_id: null }

  // 查找能施放该元素技能的角色
  const charactersWithElement = characters
    .filter(c => c.alive)
    .filter(c => canApplyElement(c, neededElement))

  if (charactersWithElement.length === 0) {
    return { ...match, executable: false, requires_switch: false, switch_target_id: null }
  }

  // 检查骰子是否足够
  const activeChar = characters.find(c => c.is_active)
  const canPayWithActive = charactersWithElement.some(c =>
    c === activeChar && canPayForSkill(c, diceValues, handCards)
  )

  if (canPayWithActive) {
    return { ...match, executable: true, requires_switch: false, switch_target_id: null }
  }

  // 需要切到对应角色
  const switchTarget = charactersWithElement.find(c => canPayForSkill(c, diceValues, handCards))
  if (switchTarget) {
    return {
      ...match,
      executable: true,
      requires_switch: true,
      switch_target_id: switchTarget.definition_id,
      match_score: match.match_score * 0.85,  // 需要切人稍微降低匹配分
    }
  }

  return { ...match, executable: false, requires_switch: false, switch_target_id: null }
}
```

同时提高 `scoreReactionChainPrior` 的权重：当前 `bestScore = matchScore * priority * 0.1`，**最大只有 ~1.0**，在总评分中几乎无影响。

建议改为：
```typescript
// 可执行的反应链获得更高加分
const baseBonus = match.match_score * match.template.priority * 0.15
const executableBonus = match.executable ? baseBonus * 1.5 : baseBonus
const totalBonus = match.completed_steps > 0 ? executableBonus * 1.3 : executableBonus
```

并在 `GiMlPolicy` 中提高 `reactionChainWeight` 从 0.7 到 **1.2**。

---

## 三、P2 改进：骰子经济学（H5）+ 阶段感知（H6）

### 3.1 回合级骰子规划器

**改动**：在回合初（第一个决策点）执行骰子规划：

```typescript
export interface DicePlan {
  /** 各颜色骰子的分配计划 */
  allocations: DiceAllocation[]
  /** 保留关键骰子的类型和数量 */
  reservedTypes: Map<DiceType, number>
  /** 是否需要调和（以及调和什么） */
  tuningSuggestions: DiceType[]
}

export function planDiceAllocation(
  candidates: PolicyCandidateAction[],
  diceValues: number[],
  turnPlan: TurnPlan | null,
  macroPlan: RuntimeMacroPlan | null,
): DicePlan {
  // 1. 汇总所有合法候选的骰子需求
  // 2. 优先分配给高优先级动作（burst_convert > reaction_window > board_setup）
  // 3. 保留必需颜色给关键操作
  // 4. 建议调和方向
}
```

在 `GiMlPolicy.choose()` 中，对调和（elementalTuning）候选动作使用骰子规划：

```typescript
// 在已有的 runtimeGuardrailAdjustment 基础上
// 如果调和建议的方向与 turnPlan 一致 → 额外奖励
// 如果调和的卡牌有高保留价值 → 额外惩罚（已有 retention_value_proxy 检查，加强）
```

### 3.2 动态阶段权重调整

**问题**：当前 `selectProfile()` 只根据 macro plan kind 和回合数选择 5 个固定 profile，缺乏更细粒度的阶段感知。

**改动**：在 `baseline-policy.ts` 的 `rankCandidate` 中，基于 `gamePhase` 对核心权重做 **连续调整**：

```typescript
function computePhaseAdjustedWeights(
  phase: GamePhaseKind,
  baseWeights: HeuristicProfile,
  round: number,
  selfAliveCount: number,
  opponentAliveCount: number,
): HeuristicProfile {
  const adjusted = { ...baseWeights }

  switch (phase) {
    case "setup":
      // 展开期：降低直接伤害权重，提高铺设权重
      adjusted.damage = /* not in HeuristicProfile, but we add it or use tempoWeight */
      adjusted.equipmentWeight *= 1.4
      adjusted.supportWeight *= 1.3
      adjusted.summonWeight *= 1.3
      adjusted.drawWeight *= 1.2
      adjusted.energyWeight *= 1.1
      adjusted.tempoWeight *= 0.7
      break
    case "execution":
      // 执行期：提高伤害和节奏权重
      adjusted.tempoWeight *= 1.5
      adjusted.reactionWeight *= 1.3
      adjusted.energyWeight *= 1.2
      adjusted.equipmentWeight *= 0.7
      adjusted.drawWeight *= 0.8
      break
    case "closing":
      // 收束期：大幅提高伤害和斩杀权重
      adjusted.tempoWeight *= 1.8
      adjusted.reactionWeight *= 1.5
      adjusted.healingWeight *= 0.6  // 收束期治疗价值下降
      adjusted.equipmentWeight *= 0.5  // 不再铺设
      adjusted.energyWeight *= 0.7   // 不再长线充能
      break
    case "transition":
      // 过渡期：温和调整
      break
  }

  // 角色数量修正：2 角色时提高伤害权重（骰子预算增加但轮转灵活性下降）
  if (selfAliveCount === 2) {
    adjusted.tempoWeight *= 1.2
    adjusted.healingWeight *= 0.8
    adjusted.supportWeight *= 0.7  // 2 人支援价值下降
  }

  return adjusted
}
```

同时，在 `GamePlan.detectGamePhase` 中增加内生检测——不仅看 setup completion，还看 **关键事件触发器**：

```typescript
// 新增阶段触发器
const firstKo = observation.opponent.characters.some(c => !c.alive) ||
                observation.self.characters.some(c => !c.alive)
const selfBurstOnline = observation.self.characters.some(
  c => c.alive && c.energy >= c.max_energy && c.max_energy > 0
)

// 如果关键角色被击倒 → 强制进入执行期
if (firstKo && setupCompletion < 0.5) {
  // 展开尚未完成但首杀已发生 → 早期执行
  return "execution"
}

// 如果爆发就绪 → 提高执行期倾向
if (selfBurstOnline && setupCompletion >= 0.3) {
  return "execution"
}
```

---

## 四、P3 改进：角色数量适应（H7）+ HP 非线性价值（H8）

### 4.1 角色数量触发的策略模式切换

**改动**：在 `macro-plan.ts` 的 `buildHeuristicMacroPlan` 中，增加角色数量分支：

```typescript
// 当我方只剩 2 个角色时，策略模式根本性变化
const selfAliveCount = observation?.self.characters.filter(c => c.alive).length ?? 3
const oppAliveCount = observation?.opponent.characters.filter(c => c.alive).length ?? 3

if (selfAliveCount === 2) {
  // 2 角色模式：攻击性提高，轮转减少，支援牌价值下降
  // 但如果对方也是 2 角色 → 双方都进入斩杀竞速
  const shouldAggro = oppAliveCount <= 2 || activeHpRatio >= 0.5

  if (shouldAggro) {
    return {
      kind: "tempo_pressure",
      intent: "two_char_aggro_push",
      source: "heuristic",
      confidence: 0.7,
      prefer_action_cases: ["useSkill", "switchActive"],
      prefer_tags: ["direct_damage", "skill_type:burst"],
      avoid_tags: ["effectless", "support_create"],
      resource_policy: "aggressive",
      remaining_actions: 2,
    }
  } else {
    return {
      kind: "stabilize",
      intent: "two_char_survive_push",
      source: "heuristic",
      confidence: 0.65,
      prefer_action_cases: ["useSkill", "playCard", "switchActive"],
      prefer_tags: ["healing", "survive", "direct_damage"],
      avoid_tags: ["effectless"],
      resource_policy: "balanced",
      remaining_actions: 3,
    }
  }
}
```

### 4.2 功能坍缩距离替代绝对 HP

**改动**：新增 `collapseDistance` 特征，替代所有使用绝对 HP / HP ratio 做保护优先级的地方：

```typescript
/**
 * 计算角色的功能坍缩距离。
 * 返回 [0, 1]：1 = 完全安全，0 = 功能已坍缩或即将坍缩。
 *
 * 核心原则：坍缩不是"HP 低于某个固定阈值"，而是"
 * 对手能在接下来的行动中通过基础伤害+增伤组合打出多少伤害，
 * 角色是否会在这些伤害下丧失核心功能"。
 *
 * 坍缩距离 = 1 - opponentDestabilizeProbability
 * 其中 opponentDestabilizeProbability 依赖于对手的伤害容量和增伤结构。
 *
 * 层级区分：
 * - core: 坍缩阈值更低（更容易被认为"危险"），因为核心角色需要更多保护
 * - tactical: 坍缩阈值适中
 * - residual: 坍缩阈值较高（只有在真正接近死亡时才触发保护）
 *
 * 此外，如果有爆发就绪（energy >= max_energy），
 * 坍缩阈值提高（更激进地保护即将爆发的角色）
 */
export function computeCollapseDistance(
  hp: number,
  maxHp: number,
  energy: number,
  maxEnergy: number,
  tier: "core" | "tactical" | "residual",
  opponentDamageCapacity: number,
  opponentReactionAmplifier: number,
): number {
  const hpRatio = hp / Math.max(1, maxHp)

  // --- 对手威胁模型：基础伤害 + 反应增伤的组合结构 ---
  // opponentDamageCapacity: 对手当前轮可打出的最大单次伤害估计
  // opponentReactionAmplifier: 对手通过反应链可获得的伤害倍率（如蒸发2.0、融化2.0）
  // 综合威胁 = 基础伤害 × max(1, 增伤倍率)
  const opponentThreat = opponentDamageCapacity * Math.max(1, opponentReactionAmplifier)

  // --- 坍缩阈值：角色在多少威胁下会"功能失效" ---
  // core 角色：被一次技能+反应增伤打中就可能功能坍缩
  // tactical 角色：需要更严重的伤害才会坍缩
  // residual 角色：只有接近死亡才考虑保护
  const collapseHpThreshold = tier === "core" ? 0.40
    : tier === "tactical" ? 0.25
    : 0.15

  // --- 爆发就绪角色的坍缩阈值提高 ---
  // 如果角色能量已满，其存活价值更高（因为可以兑现爆发）
  const burstUrgencyShift = (energy >= maxEnergy && maxEnergy > 0) ? 0.15 : 0

  // --- 计算存活到下一步的概率 ---
  // 坍缩概率 ≈ 对手威胁 / 角色HP（capped at 1.0）
  // 注意：这不是线性计算，而是考虑了"基础伤害+增伤"的结构
  const destabilizeProbability = Math.min(1.0, opponentThreat / Math.max(1, hp))

  // --- 坍缩距离 ---
  // 将坍缩阈值纳入考虑：如果 HP 已经低于坍缩阈值，距离很小
  // 如果 HP 远高于阈值且对手威胁低，距离接近 1
  const effectiveThreshold = collapseHpThreshold + burstUrgencyShift
  const adjustedHpRatio = Math.max(0, hpRatio - effectiveThreshold) / Math.max(0.01, 1 - effectiveThreshold)
  
  // 综合坍缩距离 = HP安全比例 × (1 - 被击杀概率)
  const collapseDistance = adjustedHpRatio * (1 - destabilizeProbability)

  return Math.max(0, Math.min(1, collapseDistance))
}
```

**关键设计变更说明**：

1. **不再使用固定 HP 阈值**：原方案中 `core: 0.30, tactical: 0.20, residual: 0.10` 是静态阈值。新方案中坍缩距离取决于 `opponentDamageCapacity × opponentReactionAmplifier`，即对手的实际威胁能力。

2. **增伤组合结构**：`opponentReactionAmplifier` 不是简单的线性乘数，而是反映对手能否打出反应增伤。例如：
   - 对手阵容为水+火 → `amplifier` 接近 2.0（蒸发/融化倍率）
   - 对手阵容为岩+任意 → `amplifier` 接近 1.0（结晶无增伤）
   - 对手已挂元素 → `amplifier` 根据可触发的反应链计算

3. **destabilizeProbability 的非线性**：4HP 的角色面对 3 点基础伤害 + 蒸发增伤时，destabilizeProbability 不只是 `3/4 = 0.75`，而是 `(3 × 2.0) / 4 = 1.5 → capped at 1.0`，意味着几乎必然被击杀。而面对纯 3 点伤害（无增伤），概率是 `3/4 = 0.75`，仍有生存空间。

4. **`opponentDamageCapacity` 的来源**：从 `ObservationV1.derived.opp_damage_capacity_now` 获取，结合对手角色的技能伤害数据。`opponentReactionAmplifier` 从 `reaction_ready_score` 和对手阵容元素组合推断。

在 `rankCandidate` 的所有使用 `selfActiveHpRatio` 的地方，改为使用 `collapseDistance`：

```typescript
// 原来的 healUrgency
const healUrgency = (1 - selfActiveHpRatio) * 0.7 + (1 - selfAvgHpRatio) * 0.3

// 改为基于坍缩距离
const oppDmgCap = observation?.derived.opp_damage_capacity_now ?? 5
const oppReactionAmp = estimateReactionAmplifier(observation?.opponent)
const activeTier = assessCharacterValue(activeChar, ...)
const activeCollapseDist = computeCollapseDistance(
  activeHp, activeMaxHp, activeEnergy, activeMaxEnergy,
  activeTier.functionalTier, oppDmgCap, oppReactionAmp
)
const avgCollapseDistance = computeAvgCollapseDistance(selfChars, oppDmgCap, oppReactionAmp)
const healUrgency = (1 - activeCollapseDist) * 0.7 + (1 - avgCollapseDistance) * 0.3

// 原来的 risk 评分
score -= risk * p.riskWeight

// 改为：如果动作让功能层级高的角色坍缩风险增大 → 加权惩罚
const riskMultiplier = activeTier.functionalTier === "core" ? 1.5
  : activeTier.functionalTier === "tactical" ? 1.0
  : 0.6
score -= risk * p.riskWeight * riskMultiplier
```

`estimateReactionAmplifier` 的逻辑：

```typescript
/**
 * 根据对手阵容元素组合和场面状态，估计对手的反应增伤倍率。
 * 这不是精确模拟，而是基于阵容元素的启发式估计。
 */
function estimateReactionAmplifier(opponent: PlayerObservationV1 | null): number {
  if (!opponent) return 1.0

  // 收集对手角色元素
  const elements = opponent.characters
    .filter(c => c.alive)
    .map(c => getElementFromDefinitionId(c.definition_id))
  const elementSet = new Set(elements.filter(e => e !== "void"))

  // 对手出战角色是否已有元素附着（这是触发反应的前提）
  const oppActive = opponent.characters.find(c => c.is_active)
  const activeAura = oppActive?.aura

  // 基于阵容的反应倍率估计
  let amplifier = 1.0

  // 蒸发/融化组合（2.0x 增伤）
  if (elementSet.has("pyro") && elementSet.has("hydro")) amplifier = Math.max(amplifier, 2.0)
  if (elementSet.has("pyro") && elementSet.has("cryo")) amplifier = Math.max(amplifier, 2.0)

  // 感电/超导/超载组合（1.5x 增伤）
  if (elementSet.has("electro") && elementSet.has("hydro")) amplifier = Math.max(amplifier, 1.5)
  if (elementSet.has("electro") && elementSet.has("cryo")) amplifier = Math.max(amplifier, 1.5)
  if (elementSet.has("electro") && elementSet.has("pyro")) amplifier = Math.max(amplifier, 1.5)

  // 扩散（可以触发后台反应）
  if (elementSet.has("anemo") && elementSet.size >= 2) amplifier = Math.max(amplifier, 1.5)

  return amplifier
}
```
---

## 五、Reward Shaping 调整

基于分析文档的第五节，调整现有 shaping 权重和新增 shaping 项：

### 5.1 权重调整

| Shaping 项 | 当前值 | 建议值 | 理由 |
|-----------|-------|-------|------|
| `damage_coef` | 0.02 | **0.025** | 提高伤害信号权重，让 agent 更重视每一次伤害 |
| `ko_bonus` | 0.15 | **0.20** | 击倒是最重要的游戏事件 |
| `energy_coef` | 0.015 | **0.02** | 略提高，与 burst_waste_penalty 配合 |
| `burst_online_bonus` | 0.04 | **0.06** | 爆发就绪是关键转折点 |
| `reaction_ready_bonus` | 0.03 | **0.04** | 反应就绪信号太弱 |
| `focus_damage_bonus` | 0.03 | **0.05** | 集中伤害比分散伤害重要得多 |

### 5.2 新增 Shaping 项

| 新增项 | 系数 | 定义 |
|-------|------|------|
| `burst_waste_penalty` | **0.04** | 角色死亡时每点浪费能量给予惩罚（爆发就绪×1.5加重），但不惩罚"合理递延" |
| `collapse_penalty` | **0.03** | 角色功能坍缩距离减少时给予惩罚（基于对手伤害容量+反应增伤模型） |
| `phase_alignment_bonus` | **0.02** | 作出符合当前阶段（setup/execution/closing）的操作时奖励 |
| `dice_efficiency_bonus` | **0.01** | 回合结束时有最少未使用骰子时奖励 |
| `key_char_protect_bonus` | **0.04** | 核心角色存活到执行期时奖励 |

---

## 六、Feature Extractor 扩展

在 `ScoringFeatureVector` 中新增以下特征：

```typescript
// ── H1: Burst window ──
burstWindowUrgency: number        // 出战角色爆发窗口紧迫度 (0~3)，考虑对手伤害容量和反应链
anyCharacterNearBurst: number     // 有角色能量 gap ≤ 1 (0/1)

// ── H2: Character functional tier ──
activeCharTier: number            // 0=residual, 1=tactical, 2=core
coreCharHpRatio: number          // 核心角色的 HP 比例（最低）
coreCharCollapseDistance: number  // 核心角色的坍缩距离（基于对手威胁估计）

// ── H3: Turn plan alignment ──
turnPlanAlignment: number         // 当前动作是否与回合计划一致 (0/1)

// ── H7: Character count adaptation ──
selfCharacterAdvantage: number    // selfAliveCount - opponentAliveCount

// ── H8: Functional collapse (基于对手威胁模型) ──
minCollapseDistance: number        // 我方所有角色中最小坍缩距离
avgCollapseDistance: number        // 我方所有角色平均坍缩距离
opponentMinCollapseDistance: number // 对手最小坍缩距离
opponentDamageCapacity: number    // 对手当前轮最大伤害容量估计
opponentReactionAmplifier: number // 对手反应增伤倍率估计

// ── Burst waste tracking ──
wastedEnergyThisGame: number      // 本局已浪费的总能量
```

---

## 七、实现优先级与里程碑

### Phase 0（立即，1-2 天）

1. **burstWindowUrgency** — 修改 `baseline-policy.ts` 的 `rankCandidate`，引入对手伤害容量估计和反应链递延价值，而非简单的 HP 阈值
2. **collapseDistance** — 新增 `character-value-evaluator.ts`，修改 `rankCandidate` 中的 HP 相关逻辑，使用对手威胁模型（damage_capacity × reaction_amplifier）替代固定阈值
3. **Phase-adjusted weights** — 新增 `computePhaseAdjustedWeights`，修改 baseline 打分流程
4. **Reaction chain executability** — 扩展 `reaction-chain-templates.ts`
5. **estimateReactionAmplifier** — 新增对手反应增伤倍率估计函数，用于坍缩距离和爆发窗口计算

### Phase 1（1 周）

6. **TurnPlan + dice reservation** — 修改 `types.ts`、`gi-ml-policy.ts`，骰子预留采用软约束（序列内消耗轻惩罚 + 调和奖励）
7. **Character count strategy switching** — 修改 `macro-plan.ts`
8. **Shaping reward adjustments** — 修改 `reward-config.ts`，burst_waste_penalty 考虑爆发就绪加重

### Phase 2（2 周）

8. **Feature extractor expansion** — 修改 `feature-extractor.ts`
9. **New shaping items** — `burst_waste_penalty`, `collapse_penalty`, `phase_alignment_bonus`
10. **Character value assessment integration** — 在 ML policy 中接入功能层级

### Phase 3（持续）

11. **DECK_ROLE_MAP 数据驱动** — 从对局数据中自动学习角色功能层级
12. **TurnPlan 深度规划** — 2-3 步前瞻搜索（利用 `bounded-searcher.ts`）
13. **RL 训练数据对称化** — 执行 v2 文档建议的 P0/P1 交替配置

---

## 八、v2 修正影响

基于 `replay-hidden-constraints-v2.md` 的修正结论：

1. **H1-H8 仍然成立** — 这些约束只依赖游戏机制，不依赖策略对比，原有改进方向不变
2. **RL 训练数据需要对称化** — v2 指出当前 self-play 数据 P0 恒为训练模型导致偏差。应在 `training-protocol.ts` 中配置 P0/P1 交替，并确保 observation 包含 `isFirstPlayer` 特征
3. **评估应分离因素** — benchmark 报告应区分 P0/P1 胜率，并增加同策略镜像对弈的胜率表
4. **对局数据应增大回放采样** — 从 `maxGamesPerMatchup=1` 提升到至少 5-10 场，以减少随机性

这些数据层面的修正与上述算法改进 **独立且互补**——算法改进提供更强策略，数据修正提供更准确的训练信号和评估基准。
