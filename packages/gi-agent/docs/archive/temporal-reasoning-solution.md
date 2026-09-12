# 时序推理去 LLM 化方案

> **⚠️ 状态：部分过时** — v1.0 方案文档。三层两引擎架构已被 V25 的 self-play+GBDT 路线部分替代，但 PhaseStateMachine/DeckStrategy 概念被 SPL 继承。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

> 目标：将人类玩家的 7 节点层次递进决策转化为确定性算法，移除 LLM 依赖。

---

## 架构：三层分层 + 两个引擎

```
                   ┌──────────────────────────────────────────┐
                   │          战略层 (DeckStrategy)             │
                   │  · 卡组模板匹配 → 预设战略剧本               │
                   │  · 换牌/骰子重投规则（编译时生成）            │
                   └──────────────┬───────────────────────────┘
                                  │
                   ┌──────────────▼───────────────────────────┐
                   │       时序引擎 (PhaseStateMachine)         │
                   │  · 阶段检测：Opening → Midgame → Closing    │
                   │  · 转换触发：召唤物就绪 / 敌方减员 / HP阈值   │
                   │  · 变招检测：对方抢先手 / 被克制 / 骰子灾难    │
                   └──────────────┬───────────────────────────┘
                                  │
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
┌─────────────────┐   ┌──────────────────┐   ┌────────────────────┐
│  骰子分桶引擎     │   │   斩杀链计算器     │   │   候选评分 (GBDT)   │
│  (DiceBucketer)  │   │ (LethalPlanner)  │   │  · 剪枝后打分       │
│  · 回合初规划     │   │ · 多步序列搜索     │   │  · 骰子匹配度加成    │
│  · 桶预算分配     │   │ · 精确伤害计算     │   │  · 阶段对齐校验     │
│  · 缺口调和方案   │   │ · 骰子可行性验证   │   │                    │
└─────────────────┘   └──────────────────┘   └────────────────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────────────────┐
                   │           操作层 (FragmentResolver)         │
                   │  · 从候选池选最优动作                        │
                   │  · 执行后 Critic 反馈验证                    │
                   └──────────────────────────────────────────┘
```

---

## 组件 1：战略模板 (DeckStrategy Template)

### 工作方式
卡组代码 → 角色/卡牌解析 → 匹配预定义模板 → 生成战略剧本

### 模板结构

```typescript
interface DeckStrategy {
  archetype: "aggro" | "midrange" | "control" | "combo";
  
  // 核心获胜条件（可多个，有优先级）
  winConditions: WinCondition[];
  
  // 角色角色定位
  roles: {
    opener: number;      // 开局角色 ID
    dps: number[];       // 输出角色 ID
    support: number[];   // 辅助角色 ID
  };
  
  // 阶段行为定义
  phases: {
    opening: PhasePlan;   // T1 计划
    midgame: PhasePlan;   // T2 计划
    closing: PhasePlan;   // T3+ 计划
  };
  
  // 变招触发规则
  replanTriggers: ReplanTrigger[];
}

interface WinCondition {
  type: "elemental_reaction_chain" | "burst_oneshot" | "sustained_control";
  description: string;
  requiredState: StatePredicate;
  actions: string[];  // 关键动作名称
}
```

### 模板示例：莫优流（莫娜+流浪者+优菈）

```typescript
const MoYouStrategy: DeckStrategy = {
  archetype: "midrange",
  winConditions: [
    {
      type: "elemental_reaction_chain",
      description: "莫娜挂水 → 流浪者扩散 → 优菈冻结收尾",
      requiredState: {
        allyHasCharacter: [1107],  // 莫娜
        allyHasCharacter: [1407],  // 流浪者
        allyHasCharacter: [1104],  // 优菈
      },
      actions: ["mona_skill", "wanderer_skill", "eula_skill_or_burst"],
    },
  ],
  roles: { opener: 1107, dps: [1407], support: [1104] },
  phases: {
    opening: {
      goal: "建立水召唤物 + 打蓄爆牌 + 抢先手",
      idealSequence: [
        { char: 1107, action: "elemental_skill" }, // 莫娜 E
        { char: -1, action: "play_investment_cards" }, // 支援牌
        { char: -1, action: "end_turn_early" }, // 抢先手
      ],
      diceBudget: { [WATER]: 3, [SAME]: 3 },
    },
    midgame: {
      goal: "扩散出伤 + 减员",
      idealSequence: [
        { char: 1407, action: "switch_fast" },    // 莫娜被动切流浪者
        { char: 1407, action: "elemental_skill" }, // 风附魔
        { char: 1407, action: "normal_attack" },   // 扩散 AOE
      ],
      diceBudget: { [ANEMO]: 3, [ANY]: 4 },
    },
    closing: {
      goal: "冻结锁定剩余目标",
      idealSequence: [
        { char: 1104, action: "switch_fast" },
        { char: 1104, action: "elemental_skill" },
      ],
    },
  },
  replanTriggers: [
    {
      id: "enemy_early_end",
      condition: "opponent.ended_turn AND phase == 'opening' AND NOT summon_established",
      action: "replan: skip_investment, go_direct_pressure",
    },
    {
      id: "freeze_lock_open",
      condition: "all_alive_opponents_have_hydro AND ally_has_cryo",
      action: "phase_transition: opening|midgame → closing(freeze)",
    },
    {
      id: "dice_catastrophe",
      condition: "matching_dice / required_dice < 0.5",
      action: "replan: reduce_budget_or_end_early",
    },
  ],
};
```

**关键设计决策**：模板是人类玩家知识的**结构化编码**。不是让 AI 学习模板，而是**预定义模板**。8 套卡组 = 8 个模板。

---

## 组件 2：时序引擎 (PhaseStateMachine)

### 状态定义

```typescript
type GamePhase = "opening" | "midgame" | "closing";
type WindowKind = "setup" | "pivot" | "burst" | "exit" | "sustain";

interface PhaseState {
  phase: GamePhase;
  window: WindowKind;
  round: number;
  actorsRemaining: number;  // 己方存活角色数
  enemyActorsRemaining: number;
}
```

### 转换规则（确定性有限状态机）

```
opening ──(自我召唤物就绪 AND 投资牌打出 AND round≥2)──→ midgame
midgame ──(敌方角色数 ≤ 2)──→ closing
closing ──(敌方角色数 ≤ 1)──→ terminal
```

### 战术窗口节点图

```
setup ──(召唤物就绪)──→ pivot ──(DPS在位)──→ burst ──(斩杀可行)──→ exit
                                                        │
                                                        └──(需控场)──→ sustain
```

**每步执行后 Critic 验证**：
- 当前动作是否符合当前窗口？
- 是否触发了阶段转换条件？
- 是否触发了变招条件？

---

## 组件 3：骰子分桶引擎 (DiceBucketer)

### 算法

```
回合开始时：
1. 从 PhaseState 获取当前阶段 → 查询 DeckStrategy 中的 PhasePlan
2. PhasePlan.idealSequence → 提取各动作所需骰子
3. 建立骰子桶：Bucket_i = { type, required_count, priority }
4. 遍历实际骰子池 D，将每枚骰子分配至匹配的桶
5. 计算 Fitness(D, Plan) = min(available/required) across buckets
6. IF Fitness < 0.7:
   a. 调和：浪费价值最低的非匹配骰子换色
   b. 降级：减少计划动作数（如跳过支援牌，只打技能）
7. 标记剩余骰子（存入投资牌 或 提前结束）
```

### Fitness 公式

```
Fitness(D, Plan) = product_over_buckets(
  min(1.0, count(matching_dice_in_D, bucket.type) / bucket.required)
)
```

**性质**：Fitness 是 0-1 之间的值，0 = 计划完全不可行，1 = 完美匹配。**不是线性系数**，是**计划可行性**的度量。

---

## 组件 4：斩杀链计算器 (LethalPlanner)

### 算法（宽度优先搜索）

```
输入：当前游戏状态 S，目标角色 Target
输出：最优动作序列 Seq（使得 Target.HP - total_damage(Seq) ≤ 0）

BFS 搜索：
  Queue ← [empty_sequence]
  while Queue not empty:
    seq ← dequeue
    currentHP ← simulate(seq, S).getHP(Target)
    if currentHP ≤ 0:
      return seq  // 找到斩杀序列
    
    // 剪枝：序列过长（>4步）或骰子消耗超预算
    if len(seq) > MAX_LETHAL_DEPTH(4) or diceCost(seq) > maxBudget:
      continue
    
    for each action in available_actions:
      if action.isPlayCard and action.cardCost > remainingDice:
        continue  // 骰子不足，跳过
      if action.targets.includes(Target) or action.isAOE:
        newSeq ← seq + [action]
        enqueue(newSeq)
  
  return null  // 无斩杀序列
```

### 优化

1. **伤害预计算**：GBDT 的 value network 可用于评估中间状态，指导搜索方向（A* 启发式）
2. **充能转移**：白垩之术等卡牌自动纳入搜索空间
3. **反应加成**：元素反应带来的额外伤害在伤害计算中直接累加

---

## 实现路线图

### Phase 1：模板系统 + 时序引擎（1-2 周）

- [ ] 编写 8 套卡组的 DeckStrategy 模板
- [ ] 实现 PhaseStateMachine（状态转换 + 变招触发）
- [ ] 实现 PhasePlan → 动作候选池的映射
- [ ] 集成到现有 PolicyPlayerIO 中，替换换牌+骰子重投逻辑

### Phase 2：骰子分桶引擎（1 周）

- [ ] 实现 DiceBucketer（桶分配 + Fitness 计算）
- [ ] 实现调和/降级逻辑
- [ ] 在回合开始阶段调用，修改候选池评分权重

### Phase 3：斩杀链计算器（1 周）

- [ ] 实现 BFS 搜索 + 伤害模拟
- [ ] 集成充能转移卡牌
- [ ] 在 Phase = midgame/closing 时激活

### Phase 4：端到端验证（1 周）

- [ ] Smoke test：5 局 × 8 卡组 vs baseline
- [ ] Full benchmark：10 局 × 64 matchup
- [ ] 人工回放分析：Timeline 对比框架预期

---

## 关键设计原则

1. **确定性 > 概率性**：阶段转换和变招触发用 `if-then` 规则，不用分值阈值
2. **计划驱动骰子**：骰子价值 = Fitness(当前计划序列) → 不同阶段 Fitness 不同
3. **模板是知识编码**：不指望 AI 自己学会，直接用人类专家知识
4. **GBDT 退化为操作层评分器**：在时序引擎剪枝后的候选池中做微调排序

---

*方案版本: v1.0 | 基于 ai-decision-framework-v2.md + Moyou-battlelog.md 提炼*

---

## 参见

- **[tempo-reasoning-analysis](tempo-reasoning-analysis.md)** — 时序推理分析：从搜索瓶颈到状态估值
- **[temporal-opportunity-roadmap](temporal-opportunity-roadmap.md)** — 时序机会路线图：Temporal Opportunity 层设计
- **[expert-system-feasibility](expert-system-feasibility.md)** — LLM→专家系统方案可行性评估
- **[ai-decision-framework-v2](ai-decision-framework-v2.md)** — AI 决策框架 V2：三层递进架构
