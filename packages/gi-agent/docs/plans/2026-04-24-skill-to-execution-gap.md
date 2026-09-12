# Strategic Plan Layer (SPL) — 从 Skill 分析到可执行决策

## 日期：2026-04-24
## 状态：人工检查完毕

---

## 一、问题诊断

### 1.1 现象

Skill 通过 `genius-invokation-deck-analyzer` 生成的中文策略分析与 AI 的实际对战操作之间存在系统性断层。以 申鹤/雷电将军/重云 卡组的 mirror 对局为例：

| 回合 | Skill 预期行为 | AI 实际行为 (BaselinePolicy) | 根因 |
|------|-------------|---------------------------|------|
| T1 | 雷电将军召唤雷罚恶曜之眼 | 打最好的伙伴 + 自由的新风×2 + 切来切去，0伤害0召唤物 | 骰子无冰，diceFix 权重触发了资源牌优先 |
| T2 | 申鹤生成冰翎，莲花酥保护重云 | 派蒙 + 运筹帷幄，不防守不反打 | supportWeight × earlyRoundFactor = 2.73×，远超 damageWeight=1.0 |
| T3 | 重云展开霜领域 | 重云已被斩杀 | 前两回合完全没有识别对手威胁 |

### 1.2 根因：声明式策略 vs 过程式决策

```
Skill 输出:            "前期召唤雷罚恶曜之眼和冰翎建立双召唤物压制"
                       ↑ 声明式：描述"应该做什么"，但不含执行约束、时机、骰子预算

BaselinePolicy 执行:   对每个动作独立打分，选最高分
                       ↑ 过程式但无上下文：不知道"现在处于前期"，不知道"目标是召唤物"

缺失的中间层:          回合目标 × 骰子预算 × 威胁响应 × 动作筛选
                       ↑ 需要将 Skill 声明编译为可被每轮决策消费的状态机
```

### 1.3 为什么 RL/ML 无法自行填补这个鸿沟

- **Concept Model** 学习的是"动作标签 × 状态特征"的模式（如 `concept:branch-eval:action-case:useSkill`），粒度停留在单动作层面
- **Slot-Linear Ranker** 学习的是成对偏好（"动作 A > 动作 B"），但训练数据由同一个贪心 BaselinePolicy 生成——模型学到的只是"更好的贪心"
- **Value Model** 预测 `V(s)` 但没有被有效整合到动作排序中（GiMlPolicy 仅将 V(s')-V(s) 作为一个小修正项）
- **训练数据来源**是 self-play，种子策略是 BaselinePolicy，形成自我强化的回音壁：贪心策略生成数据→ML 学到的仍是贪心模式

**结论**：Skill 提供的卡组战略知识是外部高质量先验，不应通过数据间接学习，而应直接编译进决策流程。

---

## 二、当前架构回顾

### 2.1 现有决策管道

```
Round start
    ↓
PolicyPlayerIO.buildPolicyTurnDigest(notificationState, side, actions)
    ↓
policy.choose(digest, context)  ← BaselinePolicy / EvaluatorPolicy / GiMlPolicy
    │
    ├─ resolveProfile: 选择权重配置 (AGGRESSIVE/DEFENSIVE/EARLY/LATE)
    ├─ generateTurnPlan: 回合级反应链模板
    ├─ computeDiceReservation: 骰子预留
    ├─ For each candidate:
    │   └─ rankCandidate(candidate, digest) → { score, dimensions }
    │       ├─ 20维启发式打分 (damageWeight, drawWeight, supportWeight, …)
    │       ├─ ML slot-linear score (GiMlPolicy)
    │       ├─ Q-value adjustment (GBDT)
    │       ├─ Value delta V(s')-V(s)
    │       ├─ Combat window library match
    │       └─ 反应链/对手模型 微调
    └─ sort by finalScore desc → PolicyDecision
    ↓
chooseActionWithSearch (beam search re-rank, 可选)
    ↓
actionIndex → Game Engine
```

### 2.2 现有体系的问题

| 问题 | 表现 | 影响 |
|------|------|------|
| **权重阶段化但无上下文** | `setup` 阶段 universally 提升 supportWeight/drawWeight，与对手压力无关 | T2 在重云半血时仍选派蒙 |
| **零费快速动作无代价** | 自由的新风 +2.8 分，无条件优于所有有费动作 | T1 浪费秘传牌 |
| **骰子不足时全体动作负分** | diceFix 动作（最好的伙伴）成为唯一正分动作 | T1 空过整回合 |
| **无"禁止"语义** | 无法表达"setup 阶段禁止交给我吧"、"重云残血时禁止玩资源牌" | 关键回合做错事 |
| **turnPlan 形同虚设** | `generateTurnPlan` 仅给出反应链模板，无强约束 | 计划与执行脱钩 |

---

## 三、新架构：Strategic Plan Layer (SPL)

### 3.1 总体设计

在现有 BaselinePolicy/GiMlPolicy 之上增加一个 **StrategicPlanStateMachine**，作为权重调制和动作过滤的中间层。

```
                        ┌──────────────────────────┐
                        │  Skill Analysis (LLM)     │  ← deck-analyzer 输出
                        │  DeckAnalysis JSON        │
                        └────────────┬─────────────┘
                                     ▼
                        ┌──────────────────────────┐
                        │  GamePlanCompiler         │  ★ 新增
                        │  JSON → PlanStateMachine  │
                        └────────────┬─────────────┘
                                     ▼
        ┌────────────────────────────────────────────────────┐
        │              StrategicPlanStateMachine              │  ★ 新增
        │                                                    │
        │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │
        │  │ Phase    │  │ Goal     │  │ Threat       │    │
        │  │ Tracker  │  │ Verifier │  │ Detector     │    │
        │  └──────────┘  └──────────┘  └──────────────┘    │
        │  ┌──────────┐  ┌──────────────────────────┐      │
        │  │ Dice     │  │ Action Priority Rules     │      │
        │  │ Budget   │  │ (primary/secondary/ban)   │      │
        │  └──────────┘  └──────────────────────────┘      │
        │                                                    │
        │  输出到 PolicyPlayerIO:                             │
        │  { phaseWeights, actionBanList, diceBudget,        │
        │    priorityOverrides }                             │
        └────────────────────┬───────────────────────────────┘
                             ▼
        ┌────────────────────────────────────────────────────┐
        │  BaselinePolicy / GiMlPolicy  (保留)                │
        │  修改: rankCandidate 接受外部 phaseWeightsOverride  │
        │        候选集预过滤 (actionBanList)                  │
        │        骰子预算违规惩罚 (diceBudget)                 │
        └────────────────────┬───────────────────────────────┘
                             ▼
        ┌────────────────────────────────────────────────────┐
        │  BoundedSearcher (保留)                             │
        │  修改: 搜索空间中跳过 banned 动作                    │
        └────────────────────────────────────────────────────┘
```

### 3.2 核心类型定义

```typescript
// packages/gi-agent/src/runtime/plan/types.ts

/** 一个 Plan 的阶段定义 */
interface PlanPhase {
  phaseId: string                    // 如 "setup_summons" | "build_energy" | "execute_burst"
  turnRange: { min: number, max: number } // 回合范围约束

  /** 进入此阶段的前置条件（全部满足才进入） */
  preconditions: Condition[]

  /** 阶段完成条件（完成后切换到下一阶段） */
  completionConditions: Condition[]

  /** 动作优先级 */
  actionPriorities: {
    primary: ActionPattern[]     // 高优先级模式，匹配时 +bonus
    secondary: ActionPattern[]   // 中优先级
    banned: ActionPattern[]      // 禁止，匹配时 score = -Infinity
  }

  /** 骰子预算：本阶段必须保留的骰子 */
  diceBudget: DiceReservation[]

  /** 威胁响应规则 */
  threatRules: ThreatRule[]

  /** 偏离后的回退阶段 */
  fallbackPhaseId: string | null

  /** 阶段专用权重覆盖 */
  weightOverrides: Partial<PhaseWeights>
}

/** 条件谓词 */
type Condition =
  | { type: "summon_active"; characterId: number } // 某个召唤物在场
  | { type: "character_energy"; characterId: number; minEnergy: number }
  | { type: "character_hp"; characterId: number; minHp: number }
  | { type: "card_in_hand"; cardId: number }
  | { type: "dice_count"; element: string; min: number }
  | { type: "round_gte"; round: number }
  | { type: "opponent_energy"; minEnergy: number }

/** 动作模式 */
type ActionPattern =
  | { type: "play_card"; cardId: number }
  | { type: "play_card_class"; cardClass: "weapon" | "artifact" | "support" | "event" | "food" | "talent" | "arcane" }
  | { type: "use_skill"; skillId: number }
  | { type: "use_skill_of"; characterId: number }
  | { type: "switch_to"; characterId: number }
  | { type: "normal_attack"; characterId: number }
  | { type: "elemental_skill"; characterId: number }
  | { type: "elemental_burst"; characterId: number }
  | { type: "declare_end" }

/** 骰子预留 */
interface DiceReservation {
  element: string          // "cryo" | "electro" | "omni" | "any"
  count: number
  purpose: string          // 人类可读的描述
  priority: number         // 1=必须, 2=建议, 3=可放弃
}

/** 威胁→响应规则 */
interface ThreatRule {
  threat: Condition        // 检测威胁的条件
  response: {
    priorityActions: ActionPattern[]  // 响应动作
    bonusMultiplier: number           // 匹配时权重倍率（如 100x）
  }
}

/** 阶段权重 */
interface PhaseWeights {
  damageWeight: number
  tempoWeight: number
  healWeight: number
  drawWeight: number
  energyWeight: number
  supportWeight: number
  summonWeight: number
  equipmentWeight: number
  diceFixWeight: number
  costWeight: number
  selfSwitchWeight: number
  forceSwitchWeight: number
  endTurnPenalty: number
  tuneWeight: number
}
```

### 3.3 DeckAnalysis → PlanStateMachine 编译规则

从 deck-analyzer 的 `DeckAnalysis` JSON 自动编译 `PlanPhase[]`：

```typescript
function compileDeckAnalysisToPlan(analysis: DeckAnalysis, deckCharacters: CharacterDef[]): PlanPhase[] {
  const phases: PlanPhase[] = []

  // 1. 从 gamePlan 提取阶段结构
  if (analysis.gamePlan.earlyGame) {
    phases.push(buildPhase("early_setup", {
      turnRange: { min: 1, max: 3 },
      weightOverrides: {
        supportWeight: 1.8,   // 鼓励召唤物
        summonWeight: 2.0,
        drawWeight: 0.5,       // 压制过牌（先做事后补牌）
        equipmentWeight: 1.3,
        diceFixWeight: 0.6,    // 降低骰子修正优先级
      },
      // 禁止：终结类动作、铺场过度
      banned: [
        { type: "declare_end" },
      ],
    }))
  }

  if (analysis.gamePlan.midGame) {
    phases.push(buildPhase("mid_execution", {
      turnRange: { min: 3, max: 6 },
      weightOverrides: {
        damageWeight: 2.0,
        energyWeight: 1.5,
        supportWeight: 1.0,
        drawWeight: 1.0,
      },
    }))
  }

  if (analysis.gamePlan.lateGame) {
    phases.push(buildPhase("late_burst", {
      turnRange: { min: 5, max: 15 },
      weightOverrides: {
        damageWeight: 2.5,
        energyWeight: 2.0,
        healWeight: 1.5,       // 保护核心角色
        supportWeight: 0.3,    // 别在后期下派蒙
        drawWeight: 0.5,
      },
    }))
  }

  // 2. 从 commonLines 提取动作序列作为阶段内 primary 模式
  for (const line of analysis.commonLines) {
    const sequence = line.sequence
    // "雷电将军 元素战技 → 申鹤 元素战技 → 申鹤 普通攻击"
    // → 解析为 primary ActionPattern[]
    const patterns = parseSequenceToPatterns(sequence, deckCharacters)
    // 注入到对应阶段
    injectPatternsToPhase(phases, patterns, "early_setup")
  }

  // 3. 从 matchupNotes 和 weaknesses 生成威胁规则
  for (const weakness of analysis.weaknesses) {
    if (weakness.includes("集火")) {
      // 生成 threatRule: 核心角色 HP < burst阈值 → 莲花酥 / 切人
    }
    if (weakness.includes("充能")) {
      // 生成 threatRule: 对手充能满 → 减伤 / 切人
    }
  }

  // 4. 从 keyCards 提取关键卡牌的 targetPhase
  for (const keyCard of analysis.keyCards) {
    if (keyCard.usage.includes("斩杀")) {
      // 标记为 late_burst 阶段的 primary 动作
    }
    if (keyCard.usage.includes("启动")) {
      // 标记为 early_setup 阶段
    }
    if (keyCard.usage.includes("保护")) {
      // 追加到所有阶段的威胁响应
    }
  }

  return phases
}
```

### 3.4 对局内的执行流程

`PolicyPlayerIO.rpc(action)` 修改后的流程：

```typescript
rpc(action: ActionRequest): ActionResponse {
  // ... 现有逻辑：构建 digest、observation、gamePlan 更新 ...

  // ★ 新增：SPL 运行时更新
  const planContext = this.planStateMachine.update({
    round: digest.round,
    selfCharacters: digest.selfCharacters,
    opponentCharacters: digest.opponentCharacters,
    summons: digest.selfSummons,
    dice: digest.dice,
    hand: digest.handCards,
    opponentMutations: this.lastObservedMutations,
  })

  // ★ 新增：候选动作预过滤
  const validActions = actions.filter(a => {
    // 检查是否在 banned 模式中
    return !planContext.actionBanList.some(pattern => matchPattern(pattern, a))
  })

  // ★ 修改：传递 phaseWeightsOverride
  const decision = this.policy.choose(digest, {
    ...context,
    phaseWeightsOverride: planContext.phaseWeights,  // ← 新字段
    diceBudget: planContext.diceBudget,               // ← 新字段
    threatBonusMap: planContext.threatBonusMap,        // ← 新字段
  })

  // ... 后续不变 ...
}
```

`BaselinePolicy.rankCandidate` 修改：

```typescript
rankCandidate(candidate: PolicyCandidateAction, digest: PolicyTurnDigest, context: PolicyContext): CandidateScore {
  // ★ 新增：加载阶段权重覆盖（覆盖默认 profile 权重）
  const weights = context.phaseWeightsOverride ?? this.getProfileWeights(context.profile)

  // ★ 新增：威胁响应奖励
  let threatBonus = 0
  if (context.threatBonusMap) {
    for (const [threatId, bonus] of context.threatBonusMap) {
      if (matchPattern(bonus.pattern, candidate)) {
        threatBonus += bonus.multiplier
      }
    }
  }

  // ★ 新增：骰子预算违规惩罚
  let budgetPenalty = 0
  if (context.diceBudget) {
    const violations = checkDiceBudgetViolations(candidate, context.diceBudget, digest.dice)
    budgetPenalty = violations * 2.0  // 每次违规 -2.0
  }

  // ... 现有打分逻辑，使用 weights 而非 this.config ...

  return {
    score: baseScore × weights[candidate.type] + threatBonus - budgetPenalty,
    // ...
  }
}
```

---

## 四、实施文件清单

### 4.1 新增文件

| 文件路径 | 行数估算 | 作用 |
|---------|---------|------|
| `packages/gi-agent/src/runtime/plan/types.ts` | ~200 | 核心类型定义：PlanPhase, Condition, ActionPattern, ThreatRule, DiceReservation, PhaseWeights |
| `packages/gi-agent/src/runtime/plan/compiler.ts` | ~500 | GamePlanCompiler：DeckAnalysis JSON → PlanPhase[] 的编译逻辑 |
| `packages/gi-agent/src/runtime/plan/state-machine.ts` | ~400 | StrategicPlanStateMachine：阶段切换、目标验证、威胁检测、骰子预算 |
| `packages/gi-agent/src/runtime/plan/pattern-matcher.ts` | ~250 | ActionPattern 匹配器：将 RPC 候选动作与模式定义做匹配 |
| `packages/gi-agent/src/runtime/plan/dice-budget.ts` | ~200 | DiceBudgetPlanner：骰子贪心分配算法，检查违规 |
| `packages/gi-agent/src/runtime/plan/scorer-adapter.ts` | ~250 | PlanAwareScorer：包装 BaselinePolicy，注入阶段权重和威胁奖励 |
| `packages/gi-agent/src/runtime/plan/index.ts` | ~30 | 模块导出 |

**新增代码量合计约 1830 行。**

### 4.2 修改现有文件

| 文件路径 | 改动描述 | 改动量 |
|---------|---------|--------|
| `packages/gi-agent/src/runtime/policy/types.ts` | `PolicyContext` 增加 `phaseWeightsOverride?`, `diceBudget?`, `threatBonusMap?` | ~30行 |
| `packages/gi-agent/src/runtime/policy/baseline-policy.ts` | `rankCandidate` 接受阶段权重覆盖和威胁奖励；增加 `bannedPatterns` 参数 | ~50行 |
| `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts` | 传递 `phaseWeightsOverride` 到父类；威胁奖励叠加到 ML 分数 | ~30行 |
| `packages/gi-agent/src/runtime/io/policy-player-io.ts` | 初始化 `PlanStateMachine`，在 `rpc()` 中调用更新和候选过滤 | ~60行 |
| `packages/gi-agent/src/runtime/search/bounded-searcher.ts` | 搜索空间过滤 banned 动作 | ~10行 |

**修改代码量合计约 180 行。**

### 4.3 依赖关系

```
plan/types.ts                     ← 纯类型，无依赖
plan/pattern-matcher.ts           ← 依赖 types.ts + core 的类型定义
plan/dice-budget.ts               ← 依赖 types.ts
plan/compiler.ts                  ← 依赖 types.ts + @gi-tcg/llm-deck-analyzer 的 DeckAnalysis 类型
plan/state-machine.ts             ← 依赖 types.ts + pattern-matcher + dice-budget
plan/scorer-adapter.ts            ← 依赖 types.ts + state-machine + baseline-policy
plan/index.ts                     ← 聚合导出
```

---

## 五、实施步骤（分3个迭代）

### Iteration 1：类型定义 + 编译器的"申鹤卡组"固定配置验证（2天）

**目标**：为申鹤/雷电将军/重云卡组硬编码一份 `PlanPhase[]`，在 policy-player-io 中接入，验证威胁检测能否拦住 T2 的"派蒙优先"错误。

1. 创建 `plan/types.ts`（纯类型，无逻辑）
2. 手动构造 `LeiHePlanV1`（直接写 PlanPhase[]，不跑编译器）
3. 在 `policy-player-io.ts` 中增加 `if (deckFingerprint === 'LeiHe') { planStateMachine = createStaticPlan(LeiHePlanV1) }`
4. 运行 LeiHe-mirror 对局，验证：
   - T2 检测到 P1 申鹤 2 充能时，莲花酥被推到优先队列
   - 派蒙不再是 T2 最高分动作
5. 基线对比：新旧决策在相同种子下 replay，P0 能否活过 T3

### Iteration 2：通用编译器 + DeckAnalysis 驱动（3天）

**目标**：从任意 `DeckAnalysis` 自动生成 `PlanPhase[]`，不再需要手动写 PlanPhase。

1. 实现 `plan/compiler.ts`：解析 `DeckAnalysis.gamePlan.*`、`commonLines`、`keyCards`、`weaknesses`
2. 实现 `plan/pattern-matcher.ts`：将 Skill 分析中的中文动作描述匹配到候选动作
3. 实现 `plan/dice-budget.ts`：根据角色技能费率和 `commonLines` 计算骰子预算
4. 用多套卡组的 DeckAnalysis 测试编译结果合理性
5. 确保 GiMlPolicy 也能接收 phaseWeightsOverride

### Iteration 3：运行时状态机 + 偏离检测 + 回退（3天）

**目标**：阶段切换、威胁检测、骰子预算跟踪全部上线。

1. 实现 `plan/state-machine.ts`：
   - 每轮开始时检查阶段转换条件
   - 每步执行后更新阶段内目标完成度
   - 检测计划偏离（骰子大量浪费、核心角色被击倒、关键卡牌缺失）
2. 实现威胁检测：读取对手充能状态 → 匹配威胁规则 → 生成 threatBonusMap
3. 实现回退逻辑：偏离后切到 fallbackPhaseId，或触发"通用生存"阶段
4. 实现 `plan/scorer-adapter.ts`：统一包装层
5. Cross-matchup benchmark：用 LeiHe 卡组对 8 个对手各打 10 局，新 vs 旧 BaselinePolicy 胜率对比

---

## 六、验证方案

### 6.1 单卡组回归测试

对 LeiHe 卡组的 mirror 对局，固定 randomSeed=1832767415（replay 中使用的种子），运行新旧版本各一次，断言：
- 新版本 T1 不会打出自由的新风
- 新版本 T2 在检测到对手 2 充能时会打出莲花酥或切人
- 新版本 P0 角色存活回合数 ≥ 旧版本

### 6.2 跨卡组 Benchmark

对 iter-265/replay-logs-baseline 下的 64 组 matchup，每组打 20 局（10 局先手 + 10 局后手），对比新旧版本胜率。所需脚本：

```bash
pnpm run packages/gi-agent/src/sandbox/runner.ts \
  --deck LeiHe \
  --opponents all \
  --policy baseline \
  --plan-strategy compiled \
  --games 20 \
  --output benchmark-spl-v1.json
```

### 6.3 人工审查 Checklist

- [ ] 编译器为每套卡组生成的 PlanPhase[] 是否合理（各阶段目标、权重覆盖）
- [ ] 威胁规则是否覆盖了卡组的主要弱点
- [ ] banned 动作列表是否有误杀（禁止了合理的低优先级动作）
- [ ] diceBudget 是否与实际骰子产生率匹配（不会过度预留导致死锁）

---

## 七、风险与回退

| 风险 | 缓解方案 |
|------|---------|
| 编译器输出质量差，PlanPhase 不合理 | Iteration 1 硬编码验证思路可行性后再写编译器 |
| 阶段权重覆盖导致动作选择僵化 | 保留 BaselinePolicy 作为 fallback；威胁奖励使用乘法而非替换 |
| 骰子预算过度预留导致无动作可做 | budget 违规是惩罚而非禁止；priority=3 的预算可被打破 |
| GiMlPolicy 的 ML 评分与阶段权重冲突 | ML 评分仅作为调整项叠加，不覆盖阶段权重 |
| 不同卡组需要不同的 weightOverrides 调参 | 编译器提供合理的默认值（按 setup/mid/burst 通用模板），微调留给人审 |

---

## 八、与 plan-v3.md 的关系

本计划是 `plan-v3.md`（2026-03-13）的补充，聚焦于 **Phase 0（评分系统重构）未覆盖的问题**：

- plan-v3 Phase 0 解决的是"评分函数本身的数学缺陷"（线性加法无耦合、actionBias 主导、风险无量纲）
- 本计划解决的是"评分函数缺乏战略上下文"——即使评分函数数学上完美，没有 PlanStateMachine 提供的阶段编码和威胁感知，仍然不会玩卡组

两者互补：修复后的 Logistic 评分器 + SPL 的阶段上下文 = 能执行卡组战略的完整 Agent。

---

## 九、完整训练路径：RL 的重新定位

### 9.1 核心原则：Skill 提供骨架，RL 校准细节

SPL 引入后，RL/ML 的职责从"发现策略"转变为"校准战术执行"。原因如下：

| 决策层面 | 来源 | 是否需要训练 | 原因 |
|---------|------|:---:|------|
| **阶段切换**（何时从 setup 进 burst） | Skill → Compiler | ✕ | `round >= 3 AND 重云充能=3 AND 仙跳墙在手 → 进入 execute_burst`——这是卡组知识，编译即可 |
| **禁止动作**（setup 阶段不玩资源牌） | Skill → Compiler | ✕ | 由 `commonLines` 和卡组角色定位推导 |
| **威胁响应**（对手满充能→打莲花酥） | Skill → weaknesses | ✕ | 直接来自卡组劣势分析 |
| **骰子预留**（给申鹤 E 留 3 冰） | Skill → 技能费用表 | ✕ | 角色技能费用是静态数据 |
| **PhaseWeights 数值**（summonWeight=1.8 够不够？） | Compiler 默认值 | **→ 需要校准** | 1.8 还是 2.2 取决于卡组实际节奏，应通过数据拟合 |
| **阶段内战术选择**（setup 阶段，切雷神还是打交织之冰？） | 启发式打分 | **→ 需要 RL 训练** | 这取决于具体的骰子、血量、对方站位——纯规则写不完 |
| **Concept Model**（"这个动作是好的收尾"） | ML 训练 | **→ 需要** | 概念学习需要大量样本，但 SPL 提供阶段特征作为强先验 |
| **V(s) 胜率预测** | ML 训练 | **→ 需要** | 用于 BoundedSearcher 的叶节点评估，SPL 提供 phase 作为额外特征 |
| **对手风格建模** | 贝叶斯后验 | **→ 需要** | 对手是激进还是龟缩，影响同阶段内的权重微调 |

### 9.2 完整数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│  阶段 A：一次性编译（每套卡组跑一次，无需训练）                              │
│                                                                         │
│  卡组代码                                                                 │
│    ↓                                                                    │
│  deck-analyzer (LLM 增强)                                               │
│    ↓                                                                    │
│  DeckAnalysis JSON { winCondition, gamePlan, keyCards,                  │
│                      commonLines, strengths, weaknesses, matchupNotes } │
│    ↓                                                                    │
│  GamePlanCompiler.compile()                                             │
│    ↓                                                                    │
│  PlanPhase[]  (阶段结构、preconditions、banned 动作、威胁规则、骰子预算)    │
│    ↓                                                                    │
│  PhaseWeightsTemplate  (各阶段的 sumWeight/drawWeight/... 默认值)        │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  阶段 B：初始化自对弈（SPL 引导，生成高质量训练数据）                        │
│                                                                         │
│  SPL 引导的 BaselinePolicy                                               │
│    ├─ PlanStateMachine 提供 phaseWeightsOverride                        │
│    ├─ 禁止动作被过滤                                                      │
│    └─ 威胁响应注入 threatBonusMap                                        │
│    ↓                                                                    │
│  Self-play (SPL-guided vs SPL-guided)  ← 对手池多样化                    │
│    ↓                                                                    │
│  replay-logs (高质量：每步有 phase 标签，无明显的贪心资源错误)               │
│    ↓                                                                    │
│  导出为 RL Dataset V1 (ObservationV1 + phase 特征)                        │
│    特征空间新增:                                                          │
│    - plan_phase_id: 当前阶段                                              │
│    - plan_target_goal_completed: 阶段目标达成率                            │
│    - threat_active: 是否有活跃威胁                                        │
│    - budget_violation_count: 预算违规次数                                 │
│    - is_primary_pattern_match: 候选动作是否匹配 primary 模式               │
│    - is_banned_pattern: 候选动作是否匹配 banned 模式（用于诊断）             │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  阶段 C：权重校准（Logistic Regression，gi-ml pipeline）                   │
│                                                                         │
│  训练目标: PhaseWeights fine-tuning                                      │
│  ─────────────────────────────────                                      │
│  数据: SPL 自对弈中每步的动作选择 (chosen vs not chosen)                    │
│  特征: [action_type, phase_id, damage, heal, draw, energy,               │
│          summon_create, support_create, threat_active, ...]              │
│  方法: 按 phase 分组，对每组做 Logistic Regression                         │
│                                                                         │
│  示例输出 (LeiHe 卡组):                                                  │
│  {                                                                      │
│    "setup_summons": {                                                   │
│      "summonWeight": 2.18,     // ← 从默认 2.0 校准为 2.18              │
│      "damageWeight": 1.05,     // ← 从默认 1.0 校准为 1.05              │
│      "drawWeight": 0.42,       // ← 从默认 0.5 校准为 0.42              │
│      "equipmentWeight": 1.43   // ← 从默认 1.3 校准为 1.43              │
│    },                                                                   │
│    "mid_execution": { ... },                                            │
│    "late_burst": { ... }                                                │
│  }                                                                      │
│                                                                         │
│  校验: 校准后的权重必须使 threatBonus 触发时莲花酥得分 > 派蒙得分            │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  阶段 D：战术模式训练（Concept Model + Slot-Linear Ranker）               │
│                                                                         │
│  Concept Model (binary LR per concept)                                   │
│  ─────────────────────────────────                                      │
│  训练数据: SPL 自对弈样本                                                 │
│  新增概念: 由 phase 状态衍生的概念                                         │
│    - concept:phase:setup_summons::playSummon                            │
│    - concept:phase:execute_burst::playFood                              │
│    - concept:threat:opponent_full_energy::playDefend                    │
│  训练方式: 对每个概念，用 phase-aware 特征训练二元分类器                     │
│                                                                         │
│  Slot-Linear Ranker (pairwise preference)                                │
│  ──────────────────────────────────────                                  │
│  训练数据: SPL 自对弈的成对偏好 (winner actions vs loser actions)          │
│  特征增量:                                                                │
│    - phase_id one-hot encoding                                           │
│    - plan_target_goal_completed (连续值)                                  │
│    - is_primary_pattern_match (bool)                                    │
│    - threat_active × candidate_defense_score (交互项)                    │
│  预期效果: phase 作为强特征，rank-learned 模型不再需要"学习"阶段概念，        │
│            而是直接用阶段约束来缩小动作搜索空间                              │
│                                                                         │
│  Value Model V(s)                                                        │
│  ────────────────                                                        │
│  训练数据: SPL 自对弈的终局结果                                            │
│  特征增量:                                                                │
│    - current_phase_id                                                    │
│    - phase_progress (0~1)                                                │
│    - phases_completed / total_phases                                     │
│    - behind_plan (bool: 阶段目标未按期完成)                                │
└─────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────┐
│  阶段 E：权重服务与部署                                                    │
│                                                                         │
│  CalibratedPhaseWeights JSON                                             │
│    ├─ 按卡组/版本存储: data/phase-weights/LeiHe-v1.json                  │
│    └─ 字段: { deckFingerprint, version, createdAt,                      │
│               phases: { [phaseId]: PhaseWeights },                      │
│               trainingMeta: { sampleCount, holdoutAccuracy, ... } }     │
│                                                                         │
│  GiMlPolicy 加载顺序:                                                    │
│    1. 加载卡组对应的 CalibratedPhaseWeights                               │
│    2. 加载 Concept Model artifact                                        │
│    3. 加载 Slot-Linear Ranker artifact                                  │
│    4. 加载 Value Model artifact                                          │
│                                                                         │
│  决策时融合:                                                              │
│    finalScore =                                                          │
│      baselineScore(calibratedPhaseWeights)   ← 校准后的阶段权重           │
│    + mlRankerScore(phaseAwareFeatures)        ← 带 phase 特征的排名器     │
│    + threatBonus(threatMap)                   ← SPL 注入的威胁响应        │
│    + valueDelta × 0.1                         ← V(s')-V(s) 轻微修正      │
│    - budgetPenalty                            ← 骰子预算违规              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 9.3 RL 的具体角色与不需要 RL 的部分

**需要 RL/ML 的部分**（训练）= 约 40% 的决策权重：

| 训练项 | 方法 | 数据量需求 | 收敛难度 |
|--------|------|:---:|:---:|
| PhaseWeights 校准 | 按 phase 分组的 Logistic Regression | 每卡组 ~500 局 | 低——phase 分组后样本空间小 |
| Concept Model | 二元 LR，phase 作为特征 | 每卡组 ~2000 样本 | 低——引入 phase 强先验 |
| Slot-Linear Ranker | 成对偏好训练，phase_id 作为 one-hot | ~10 万偏好对 | 中——但 phase 约束大幅缩小搜索 |
| Value Model V(s) | 逻辑回归/GBDT，phase_progress 作为特征 | ~5 万状态样本 | 中 |
| 对手风格权重微调 | 贝叶斯后验（已有 opponent-model.ts） | 每局实时更新 | 低——贝叶斯无需离线训练 |

**不需要 RL 的部分**（编译）= 约 60% 的决策约束：

| 编译项 | 来源 | 对决策的影响方式 |
|--------|------|----------------|
| 阶段切换条件 | Skill gamePlan | 状态机直接切换 phaseWeightsOverride |
| 禁止动作列表 | Skill keyCards + commonLines | 候选集预过滤（score = -Infinity） |
| 威胁响应规则 | Skill weaknesses | threatBonusMap 注入（乘法奖励，~100×） |
| 骰子预算 | Skill 技能费用 | budgetPenalty 注入（惩罚而非禁止） |
| 优先级动作模式 | Skill commonLines | primary 匹配时 +2.0 固定奖励 |

### 9.4 为什么需要 RL 而不能纯规则

即使 SPL 提供了完整的阶段框架，以下情况仍然需要 ML 拟合：

1. **PhaseWeights 的精确值**：编译器默认 `setup_summons.summonWeight=2.0`，但实际最优值可能是 1.8 或 2.3，取决于该卡组与其他卡组的互动模式。这是一个连续参数，穷举不可行。

2. **特征交互**：`damageWeight` 和 `healWeight` 不是独立的——当对手有穿透伤害时，治疗优先级的上升幅度取决于对手的具体队伍。这种交互项很难写规则。

3. **阶段边界模糊**：卡组并非严格在 `round=3` 进入 execution。有时骰子特别好的 T2 就应该提前进攻。`phase_progress` 连续的校准需要数据驱动。

4. **"两个动作都符合 primary 模式"时的抉择**：例如 setup 阶段，primary 模式同时包含"切到雷神"和"打交织之冰"——选哪个取决于当前的具体骰子分布而非全局战略。这是战术级决策，适合 ML。

### 9.5 训练数据采集策略

旧体系的问题：BaselinePolicy 自对弈生成的数据质量差（贪心模式自我强化）。

新体系的数据采集策略：

```typescript
// SPL 引导的自对弈，带探索
const collector = new SelfPlayCollector({
  policy: splGuidedPolicy,
  exploration: {
    type: "epsilon_greedy",
    epsilon: 0.15,        // 15% 随机探索（高于旧体系的 5%）
    temperature: 1.2,     // softmax 温度（略高，鼓励尝试 phase 内不同动作）
    phaseAware: true,     // ★ 新：探索仅在 phase.primary 候选集内进行
    bannedActions: true,  // ★ 新：绝不探索 banned 动作
  },
  opponentPolicy: opponentPool, // 50% mirror, 30% checkpoint, 20% other decks
  matchupSchedule: matchupRotator, // 均匀覆盖所有 matchup
  targetSamplesPerPhase: 2000, // ★ 新：每个 phase 至少 2000 个决策样本
})

// 采集流程
// 1. 初始 200 局（epsilon=0.3）→ 生成 PhaseWeights 初稿
// 2. 校准 PhaseWeights（Logistic Regression）
// 3. 用校准权重再打 500 局（epsilon=0.1）→ 训练 Concept Model + Ranker
// 4. 用完整模型再打 500 局 → 训练 Value Model
// 5. A/B 对比
```

### 9.6 训练频次

| 触发条件 | 执行内容 |
|---------|---------|
| 新卡组首次分析 | 编译 PlanPhase[] + PhaseWeights 默认值 |
| 新卡组采集 200 局后 | PhaseWeights 校准（Logistic Regression） |
| 新卡组采集 700 局后 | Concept Model + Slot-Linear Ranker 训练 |
| 新卡组采集 1200 局后 | Value Model 训练 |
| 每新增 500 局 | 增量更新 Ranker + Value Model |
| 卡组胜率波动 >5% | 触发全量重训练 |
| 游戏版本更新 | 增量编译 PlanPhase（新卡牌/角色），保留已有权重，仅对新内容重新校准 |

### 9.7 训练成本对比

| 维度 | 旧体系 (无 SPL) | 新体系 (SPL 引导) | 降幅 |
|------|:---:|:---:|:---:|
| 每卡组收敛所需对局数 | ~5000 局 | ~1200 局 | **76%** |
| 每卡组训练时间（8 核） | ~6 小时 | ~1.5 小时 | **75%** |
| RL 数据中的"无效"样本占比 | ~60%（贪心错误模式） | ~15%（SPL 过滤后） | **75%** |
| 泛化到新卡组的能力 | 需重新训练全套模型 | 仅需校准 PhaseWeights + 增量训练 | — |
| 是否需要 GiMlPolicy | **是**（主决策引擎） | **是**（但作为战术微调层） | 角色变化 |

### 9.8 风险：过度约束导致策略僵化

如果 SPL 的约束过于严格，Agent 可能无法适应对手的非标准打法。

**缓解方案**：

1. **PhaseWeights 的 fallback**：当所有候选的 SPL 调整后得分均为负时，回退到纯 BaselinePolicy 打分（跳过 SPL）
2. **威胁检测的置信度阈值**：只有当 `threat_confidence > 0.7` 时才注入 bonus
3. **banned 动作的"软禁止"选项**：某些 banned 模式使用大惩罚（`score *= 0.01`）而非 `-Infinity`，保留极端情况下打破规则的可能性
4. **偏离后的回退阶段**：当 core character 被击倒后，自动进入 `emergency_recovery` 阶段（权重：healWeight=3.0, damageWeight=1.0），不再坚持原定的 execute_burst 阶段
5. **探索时不应用 banned 列表**：自对弈探索模式（epsilon）跳过 banned 过滤，以采集边界数据
