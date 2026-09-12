# "输出节奏"方案 (thought-char-comb) 可行性评估与细化

> 基于对 `@gi-tcg/core` 引擎架构、`@gi-tcg/data` 中 133 个角色实现、
> 以及 plan-tactic-search-v2 模拟驱动方案的深度分析。

---

## 0. 总体判断

**原方案的核心直觉是对的**——角色确实存在可量化的"输出节奏"，且这个节奏在组队和构筑中
有实际决策价值。但原方案的表述停留在概念层面，缺少与引擎实际数据结构的对接，
需要大幅细化才能落地。以下逐一评估并给出修订建议。

---

## 1. 对原方案的逐项质疑

### 1.1 "输出节奏"定义过于模糊

**原文**：用"回合数"和"资源消耗"来表示每次有效输出的时间间隔。

**质疑**：

这个定义混淆了三个不同层次的问题：

| 层次 | 例子 | 是否可静态确定 |
|------|------|--------------|
| **单技能成本** | 迪卢克 E = 3火骰 | ✅ 完全确定（`requiredCost` 字段） |
| **技能循环周期** | 优菈 E→E→Q→普×N→光降之剑爆发 | ⚠️ 部分确定（充能需求+技能序列可推导，但最优序列依赖对手） |
| **条件输出节奏** | 纳西妲种子触发频率、丝柯克蛇之狡谋积累速率 | ❌ 不可静态确定（依赖元素反应触发频率、队友行动） |

原方案将三者笼统归为"输出节奏"，但它们需要完全不同的计算方法。

**结论**：需要分层定义，不能一刀切。

### 1.2 "行动牌参与的节奏区间"缺少机制对接

**原文**：引入行动牌类型（增伤/加速/控制），设定增速或延迟系数。

**质疑**：

引擎中的行动牌效果远比"增伤/加速/控制"分类复杂：

- **派蒙** (322001)：每回合产 2 万能骰，持续 2 回合 → 改变**资源曲线**而非节奏
- **凯瑟琳** (322002)：切人变快速行动 → 改变**回合经济**
- **提米** (322007)：积累鸽子→一次性爆发 → **延迟收益**
- **绝缘之旗印**类：特定条件减费 → **条件性资源节省**
- **元素共鸣**：特定队伍配置触发 → **构筑约束**

用"增速/延迟系数"无法表达这些异质效果。实际上，行动牌对节奏的影响路径至少有：

1. **骰子经济**：产骰/减费 → 同回合可多执行一个动作
2. **回合经济**：快速行动/额外行动 → 不消耗对手响应窗口
3. **伤害乘区**：增伤buff → 改变每个动作的输出密度
4. **手牌循环**：抽牌/生成手牌 → 改变可用选项的时间线
5. **状态延续**：延长buff持续时间 → 拉长有效输出窗口

**结论**：需要按影响路径分类，而非按牌的"类型"分类。

### 1.3 "协同加成系数"过度简化

**原文**：设定协同加成系数表示角色间配合度。

**质疑**：

实际代码中的角色协同远超线性系数能表达的范围。以 7 个角色为例：

| 角色 | 协同机制 | 能否用系数表示 |
|------|---------|--------------|
| **达达利亚** | 近战姿态下所有断流目标+1伤害 → 需要队友先挂水 | ❌ 跨角色状态传播 |
| **纳西妲** | 种子触发依赖队友的元素反应 + 队中有火/雷/水各增效 | ❌ 团队组成条件检测 |
| **优菈** | 光降之剑层数随普攻/E累积 → 纯自身 | ✅ 可量化 |
| **丝柯克** | 蛇之狡谋依赖冻结/扩散/超导反应触发 | ❌ 反应依赖 |
| **刻晴** | 雷楔手牌 → 切人+释放E → 需要手牌状态追踪 | ⚠️ 部分可量化 |
| **闲云** | 风翎累积依赖切人次数 → 天赋卡加成 | ⚠️ 依赖切人策略 |
| **香菱** | 锅巴/旋火轮独立运作 | ✅ 完全可量化 |

在 133 个角色中，约 70% 的竞技常用角色包含运行时条件分支。
"协同加成系数"只能覆盖最简单的 ~30% 的情况。

**结论**：协同不是一个系数，而是一个**条件函数**。

### 1.4 缺少与 plan-v2 方案的关系定位

**质疑**：原方案没有说明它与模拟驱动搜索（plan-v2）的关系：
- 是替代方案？→ 覆盖面不足
- 是补充方案？→ 如何分工？
- 是预过滤层？→ 如何对接？

这是最关键的定位问题。下文给出明确建议。

---

## 2. 与 plan-tactic-search-v2 的关系定位

### 2.1 两个方案解决不同问题

| 维度 | thought-char-comb (本方案) | plan-tactic-search-v2 |
|------|--------------------------|----------------------|
| **目标** | 构筑阶段：选哪3个角色+30张牌 | 对局中：当前局面打什么 |
| **输入** | 角色池 + 卡牌池 | 具体的 GameState |
| **输出** | 牌组配置推荐 + 配合度评估 | 行动序列 + combo |
| **计算时机** | 离线/对局前 | 在线/每个决策点 |
| **精度需求** | 粗粒度排序即可 | 需要精确模拟 |

**关键洞察**：本方案的最佳定位是 **plan-v2 的上游预过滤器**——

```
角色池(133) × 卡牌池(数百)
    ↓ [本方案：节奏兼容性筛选]
候选牌组(~50-200个)
    ↓ [plan-v2：模拟驱动评估]
高质量牌组(~5-20个)
    ↓ [plan-v2 ComboRegistry：对局内决策]
行动序列推荐
```

### 2.2 分工划定

**本方案负责**（静态/半静态分析，不需要运行引擎）：
1. 角色的**固有属性档案**（可从 builder DSL 静态提取）
2. 角色间的**元素兼容性**（反应覆盖矩阵）
3. 角色间的**节奏兼容性**（充能周期对齐、费用曲线互补）
4. 行动牌与角色的**静态相性**（减费条件匹配、武器/元素tag匹配）

**plan-v2 负责**（需要运行引擎模拟）：
1. 具体的行动序列搜索
2. 非线性收益评估
3. 条件性协同的精确量化
4. 对手响应建模

---

## 3. 细化方案：角色输出档案 (Character Output Profile)

### 3.1 设计原则

1. **只提取可静态确定的信息**——不试图用公式逼近需要模拟的效果
2. **与引擎数据结构直接对接**——从 `CharacterDefinition`、`SkillDefinition` 自动提取
3. **输出供 plan-v2 消费的结构化数据**——不是独立系统，而是 plan-v2 的输入

### 3.2 角色输出档案 (Character Output Profile)

```typescript
interface CharacterOutputProfile {
  definitionId: number;
  name: string;
  version: string;           // 最后更新的游戏版本

  // ──── 基础属性（从 CharacterDefinition 直接提取）────
  base: {
    element: DamageType;     // 角色元素
    weapon: WeaponTag;       // 武器类型
    nation: NationTag;       // 国家
    health: number;          // 生命值
    maxEnergy: number;       // 最大充能
    tags: string[];          // 所有标签
  };

  // ──── 技能档案（从 SkillDefinition 直接提取）────
  skills: SkillProfile[];

  // ──── 固有输出节奏（从技能档案推导）────
  rhythm: {
    // 最小爆发周期：从0充能到满充能释放Q需要的最少战斗行动数
    minBurstCycle: number;
    // 最小爆发周期所需总骰子成本
    burstCycleTotalDiceCost: number;
    // 每战斗行动的平均伤害密度（不含反应加成）
    rawDamagePerCombatAction: number;
    // 是否有快速行动输出能力
    hasFastActionDamage: boolean;
    // 是否有持续伤害（召唤物/状态的回合结束伤害）
    hasDoTOutput: boolean;
    // 持续伤害每回合期望值
    dotDamagePerRound: number;
    // 是否有延迟爆发（如优菈光降之剑）
    hasDeferredBurst: boolean;
  };

  // ──── 资源特征（从技能费用提取）────
  resourceProfile: {
    // 主要消耗元素（占比最高的骰子颜色）
    primaryElement: DiceType;
    // 每回合理想消耗骰子数（满操作）
    idealDicePerRound: number;
    // 是否有自产骰/减费能力
    hasSelfFunding: boolean;
    // 是否有特殊资源系统（替代充能等）
    hasCustomResource: boolean;
    customResourceDescription?: string;
  };

  // ──── 复杂度标记（影响后续处理策略）────
  complexity: {
    // 是否需要模拟才能准确评估
    requiresSimulation: boolean;
    // 运行时条件分支数（.if() / .do() 中的分支）
    conditionalBranchCount: number;
    // 是否有跨角色交互
    hasCrossCharacterInteraction: boolean;
    // 是否依赖元素反应触发
    requiresReactionTrigger: boolean;
    // 是否有状态机（姿态切换等）
    hasStateMachine: boolean;
  };
}

interface SkillProfile {
  definitionId: number;
  name: string;
  type: "normal" | "elemental" | "burst" | "technique" | "passive";

  // ──── 费用（从 requiredCost 直接读取）────
  cost: {
    elementDice: number;     // 同元素骰子需求
    voidDice: number;        // 无色骰子需求
    anyDice: number;         // 任意骰子需求
    energyCost: number;      // 充能消耗
    totalDice: number;       // 总骰子数
  };

  // ──── 输出（从 builder 链中的 .damage() 提取）────
  output: {
    mainDamageType: DamageType;
    mainDamageValue: number;
    // 附带的额外伤害（穿透伤害等）
    additionalDamage: { type: DamageType; value: number; target: "active" | "standby" | "all" }[];
    // 是否产生召唤物
    createsSummon: boolean;
    summonProfile?: { endPhaseDamage: number; duration: number; element: DamageType };
    // 是否施加状态
    createsStatus: boolean;
    statusProfile?: { type: string; duration: number; effect: string };
  };

  // ──── 充能经济 ────
  gainEnergy: number;        // 释放后获得的充能
  isFast: boolean;           // 是否快速行动
}
```

### 3.3 自动提取流程

从 `@gi-tcg/data` 的 builder DSL 中自动提取，**不需要运行引擎**：

```typescript
// 伪代码：遍历所有角色定义，提取 profile
function extractProfile(charDef: CharacterDefinition): CharacterOutputProfile {
  const skills = charDef.skills.map(extractSkillProfile);

  // 推导最小爆发周期
  const burst = skills.find(s => s.type === "burst");
  const energyGenerators = skills.filter(s => s.gainEnergy > 0);
  const bestGenerator = maxBy(energyGenerators, s => s.gainEnergy);

  let minBurstCycle = Infinity;
  if (burst && bestGenerator) {
    const energyNeeded = burst.cost.energyCost;
    const turnsToCharge = Math.ceil(energyNeeded / bestGenerator.gainEnergy);
    minBurstCycle = turnsToCharge + 1; // +1 for burst itself
  }

  // 推导每战斗行动平均伤害
  const combatSkills = skills.filter(s => !s.isFast && s.type !== "passive");
  const avgDamage = mean(combatSkills.map(s =>
    s.output.mainDamageValue + sum(s.output.additionalDamage.map(d => d.value))
  ));

  // 推导DoT（召唤物回合结束伤害）
  const dotSummons = skills.flatMap(s =>
    s.output.createsSummon && s.output.summonProfile ? [s.output.summonProfile] : []
  );
  const dotPerRound = sum(dotSummons.map(s => s.endPhaseDamage));

  return {
    definitionId: charDef.id,
    base: { element: charDef.tags[0], ... },
    skills,
    rhythm: {
      minBurstCycle,
      burstCycleTotalDiceCost: /* sum of skill costs in optimal rotation */,
      rawDamagePerCombatAction: avgDamage,
      hasFastActionDamage: skills.some(s => s.isFast && s.output.mainDamageValue > 0),
      hasDoTOutput: dotSummons.length > 0,
      dotDamagePerRound: dotPerRound,
      hasDeferredBurst: /* 检测是否有光降之剑类延迟机制 */,
    },
    resourceProfile: { ... },
    complexity: {
      requiresSimulation: /* 根据条件分支数和反应依赖判定 */,
      conditionalBranchCount: /* 统计 .if()/.do() 调用次数 */,
      ...
    },
  };
}
```

### 3.4 具体角色的档案示例

#### 香菱（低复杂度）

```json
{
  "definitionId": 1301,
  "name": "香菱",
  "base": { "element": "Pyro", "weapon": "polearm", "health": 10, "maxEnergy": 2 },
  "skills": [
    { "name": "白案功夫", "type": "normal", "cost": { "elementDice": 1, "voidDice": 2, "totalDice": 3 },
      "output": { "mainDamageType": "Physical", "mainDamageValue": 2 }, "gainEnergy": 1 },
    { "name": "锅巴出击", "type": "elemental", "cost": { "elementDice": 3, "totalDice": 3 },
      "output": { "mainDamageType": "Pyro", "mainDamageValue": 0, "createsSummon": true,
                  "summonProfile": { "endPhaseDamage": 2, "duration": 2, "element": "Pyro" } },
      "gainEnergy": 1 },
    { "name": "旋火轮", "type": "burst", "cost": { "elementDice": 4, "energyCost": 2, "totalDice": 4 },
      "output": { "mainDamageType": "Pyro", "mainDamageValue": 3,
                  "createsStatus": true, "statusProfile": { "type": "combatStatus", "duration": 2, "effect": "+2 Pyro after skill" } },
      "gainEnergy": 0 }
  ],
  "rhythm": {
    "minBurstCycle": 3,
    "burstCycleTotalDiceCost": 10,
    "rawDamagePerCombatAction": 2.5,
    "hasFastActionDamage": false,
    "hasDoTOutput": true,
    "dotDamagePerRound": 2,
    "hasDeferredBurst": false
  },
  "complexity": {
    "requiresSimulation": false,
    "conditionalBranchCount": 1,
    "hasCrossCharacterInteraction": false,
    "requiresReactionTrigger": false,
    "hasStateMachine": false
  }
}
```

#### 纳西妲（高复杂度）

```json
{
  "definitionId": 1702,
  "name": "纳西妲",
  "base": { "element": "Dendro", "weapon": "catalyst", "health": 10, "maxEnergy": 2 },
  "rhythm": {
    "minBurstCycle": 3,
    "burstCycleTotalDiceCost": 9,
    "rawDamagePerCombatAction": 2.3,
    "hasFastActionDamage": false,
    "hasDoTOutput": false,
    "dotDamagePerRound": 0,
    "hasDeferredBurst": false
  },
  "complexity": {
    "requiresSimulation": true,
    "conditionalBranchCount": 6,
    "hasCrossCharacterInteraction": true,
    "requiresReactionTrigger": true,
    "hasStateMachine": false
  }
}
```

纳西妲的**实际输出节奏极度依赖队伍组成**（火角色→种子变草伤、雷角色→种子重置次数+1、
水角色→摩耶之殿+1回合），无法用固有节奏描述，但 complexity 标记告诉 plan-v2
需要对她做更深度的模拟。

---

## 4. 细化方案：节奏兼容性矩阵

### 4.1 三维兼容性

原方案笼统地谈"配合度"，实际应拆分为三个独立维度：

#### 维度A：元素兼容性（Elemental Compatibility）

基于元素反应表的静态推导。可以完全从代码中的反应表提取。

```typescript
interface ElementalCompatibility {
  // 这对角色能触发哪些反应
  possibleReactions: Reaction[];
  // 反应收益等级（蒸发/融化 > 超载/感电 > 结晶/扩散辅助）
  reactionTier: "S" | "A" | "B" | "C" | "none";
  // 是否满足特定角色的团队元素需求
  // 例如纳西妲需要队伍中有火/雷/水
  satisfiesTeamElementRequirement: boolean;
}
```

#### 维度B：费用兼容性（Cost Compatibility）

同元素角色争抢骰子，异元素角色允许元素调和。这可以从 `requiredCost` 静态计算。

```typescript
interface CostCompatibility {
  // 骰子需求重叠度（0=完全互补, 1=完全重叠）
  diceConflictRate: number;
  // 两角色同时满操作需要的最少骰子总量
  // （考虑万能骰 + 元素调和后的最优分配）
  minDiceForFullRotation: number;
  // 是否可在同一回合双角色输出
  canDualOutputInOneRound: boolean;
}
```

**计算方法**：

```
角色A消耗 = [3火, 0无色] (E技能)
角色B消耗 = [3水, 0无色] (E技能)
→ 无冲突，minDice=6, canDual=true (if 8 dice available)

角色A消耗 = [3火, 0无色] (E技能)
角色C消耗 = [4火, 0无色] (Q技能)
→ 高冲突，minDice=7 (需要全火骰), canDual=false (typically)
```

#### 维度C：节奏兼容性（Tempo Compatibility）

这是原方案最想表达的内容——角色的输出节奏是否互补。

```typescript
interface TempoCompatibility {
  // 充能周期对齐度：两角色是否可以在相近回合同时蓄满Q
  burstSyncScore: number;     // 0~1, 1=完美对齐
  // 输出空隙互补度：A输出时B蓄力，B输出时A蓄力
  gapComplementScore: number; // 0~1, 1=完美互补
  // 前台/后台分工清晰度
  roleClarityScore: number;   // 0~1, 1=分工明确
  // 切人成本：两角色切换所需额外骰子消耗
  switchCostBetween: number;
}
```

**计算方法**（简化示例）：

```
香菱: minBurstCycle=3, 主要后台输出（锅巴+旋火轮持续触发）
行秋: minBurstCycle=3, 主要后台输出（雨帘剑减伤+水伤害跟随）
→ burstSyncScore=1.0（周期一致）
→ gapComplementScore=0.3（都是后台，缺前台主C）
→ roleClarityScore=0.3（角色定位重叠）

香菱: 后台输出
迪卢克: minBurstCycle=3, 前台火C, E→E→E输出
→ burstSyncScore=1.0（周期一致）
→ gapComplementScore=0.8（香菱后台挂火，迪卢克前台输出，切换自然）
→ roleClarityScore=0.9（分工清晰）
```

### 4.2 三角色牌组兼容性评分

七圣召唤牌组固定3角色，因此兼容性是三角色的组合评估：

```typescript
interface DeckCompatibilityScore {
  characters: [number, number, number]; // definition IDs

  elemental: {
    reactionCoverage: number;     // 能触发的反应种类数 / 总反应种类数
    teamElementSatisfaction: number; // 满足多少角色的团队元素需求
  };

  cost: {
    overallDiceConflict: number;  // 三角色骰子冲突度
    elementDiversity: number;     // 需要的不同元素骰种类数
    canTwoCharacterRound: boolean; // 8骰是否够两角色操作
  };

  tempo: {
    burstAlignment: number;       // 三角色爆发周期对齐度
    outputContinuity: number;     // 每回合是否都有角色在输出
    mainDpsIdentified: boolean;   // 是否有明确的主C
    supportCoverage: number;      // 辅助覆盖度（治疗/护盾/增伤）
  };

  // 综合评分
  overallScore: number;

  // 需要 plan-v2 模拟验证的标记
  needsSimulationVerification: boolean;
  simulationPriorityReasons: string[];
}
```

---

## 5. 行动牌与角色的静态相性

### 5.1 可静态判定的相性

以下相性可以从牌的 builder DSL 中的 tag 匹配和条件检查自动提取：

```typescript
interface CardCharacterAffinity {
  cardDefinitionId: number;
  characterDefinitionId: number;

  // 匹配类型
  affinityType:
    | "talent"           // 角色专属天赋牌
    | "weapon_match"     // 武器匹配（如"狼牙"对单手剑角色）
    | "element_match"    // 元素匹配（如"绝缘旗印"对雷角色减费）
    | "artifact_match"   // 圣遗物匹配
    | "cost_reduction"   // 通用减费（如派蒙产骰对高费角色更有价值）
    | "damage_buff"      // 增伤相性
    | "reaction_synergy" // 反应相关增益
    | "none";            // 无特殊相性

  // 相性强度 (0~1)
  strength: number;

  // 是否需要模拟验证实际收益
  needsSimulation: boolean;
}
```

### 5.2 不可静态判定的相性

以下相性**必须**留给 plan-v2 的模拟系统：

- 时机依赖：某些增伤食物在"蒸发斩杀回合"打出的价值远超普通回合
- 顺序依赖：料理卡打出顺序影响是否能在关键回合使用
- 对手依赖：控制卡的价值完全取决于对手阵容

---

## 6. 实现路线建议

### Phase A：角色档案提取器 (CharacterProfileExtractor)

**输入**：`@gi-tcg/data` 的所有 `CharacterDefinition`
**输出**：133 个 `CharacterOutputProfile` JSON 文件

**实现要点**：
- 遍历 `CharacterDefinition.skills`，提取 `requiredCost`、`damage()` 参数、`gainEnergy`
- 解析 builder 链中的 `.summon()`、`.combatStatus()`、`.characterStatus()` 来识别DoT/状态
- 统计 `.if()`、`.do()` 调用次数来推导复杂度
- 识别 `.on("xxx")` 事件订阅来判定是否有跨角色交互

**难点**：builder DSL 的链式调用不完全是声明式的（`.do()` 中有命令式逻辑），
需要对部分复杂角色做人工标注或启发式分类。

**交付**：
- `CharacterProfileExtractor` 类
- 133 个角色的 JSON 档案
- 人工标注的复杂度校准（抽检 20 个角色验证）

### Phase B：兼容性矩阵计算器 (CompatibilityCalculator)

**输入**：133 个 `CharacterOutputProfile` + 元素反应表
**输出**：三维兼容性矩阵（133×133×3维度）

**实现要点**：
- 元素兼容性：从引擎的反应表(`reaction.ts`)静态提取
- 费用兼容性：从 `requiredCost` 字段计算骰子冲突
- 节奏兼容性：从 `minBurstCycle` 和技能类型推导

**交付**：
- `CompatibilityCalculator` 类
- 兼容性矩阵数据（可序列化为 JSON）
- Top-50 最佳三角色组合排名（作为 baseline）

### Phase C：行动牌相性分析 (CardAffinityAnalyzer)

**输入**：所有卡牌定义 + 角色档案
**输出**：卡牌-角色相性矩阵

**实现要点**：
- Tag 匹配（武器/元素/国家）
- 减费条件检测（从 `deductCost` 事件提取）
- 天赋牌自动关联

**交付**：
- `CardAffinityAnalyzer` 类
- 卡牌相性数据

### Phase D：对接 plan-v2 的输出接口

**输出物**：
- 候选牌组列表 → 输入给 plan-v2 的离线挖掘
- 复杂度标记 → 指导 plan-v2 分配计算预算（高复杂度角色分配更大 beam width）
- 节奏档案 → 输入给 plan-v2 的 `StateEvaluator` 作为先验权重参考

---

## 7. 与 plan-v2 的具体对接点

| 本方案输出 | plan-v2 消费方 | 用途 |
|-----------|---------------|------|
| `CharacterOutputProfile.rhythm` | `StateEvaluator` 权重初始化 | 角色的基准 DPT 作为评估参考线 |
| `DeckCompatibilityScore` | 离线挖掘的牌组选择 | 优先搜索高兼容性牌组 |
| `complexity.requiresSimulation` | `BoundedSearcher` 预算分配 | 高复杂度牌组分配更大 beam width |
| `CardCharacterAffinity` | `ComboRegistry` 的初始候选 | 高相性卡牌优先纳入搜索 |
| `TempoCompatibility.gapComplementScore` | `StateDelta.turnsConsumed` 权重 | 互补性高的队伍对回合消耗惩罚更宽容 |

---

## 8. 开放问题

### Q1：角色档案的更新频率

每次游戏版本更新（通常2-3周），可能有新角色加入或现有角色调整。
档案提取器需要设计为**可增量运行**——只重新提取变更的角色。

### Q2：复杂角色的"等效节奏"

对于纳西妲、丝柯克等高复杂度角色，固有节奏数据的参考价值有限。
是否需要为这些角色维护**多个场景下的条件节奏配置文件**？

建议：P-A阶段先用复杂度标记跳过，P-D阶段根据 plan-v2 的模拟结果回填。

### Q3：meta 偏差

兼容性矩阵是理论最优排序，但实战 meta 受流行趋势影响。
是否需要引入"对手分布"假设来加权？

建议：初期不考虑，P5（自对弈校准）阶段自然形成 meta 感知。

### Q4：静态分析的精度上界

原方案想用系数和公式量化一切，但实际精度上界受限于：
- ~30% 角色可完全静态量化（如香菱、优菈）
- ~40% 角色可部分静态量化（如闲云、刻晴）
- ~30% 角色基本不可静态量化（如纳西妲、丝柯克）

**因此本方案的价值定位应是"快速粗筛"而非"精准评估"**。
精准评估是 plan-v2 的模拟系统负责的。

---

## 9. 总结

| 项目 | 原方案 | 修订建议 |
|------|-------|---------|
| 定位 | 独立的量化系统 | plan-v2 的上游预过滤器 |
| 输出节奏 | 单一"回合数"指标 | 分层：单技能成本→循环周期→条件节奏 |
| 行动牌影响 | 增速/延迟系数 | 按影响路径分类（骰子/回合/伤害/手牌/状态） |
| 协同量化 | 单一系数 | 三维兼容性矩阵（元素/费用/节奏） |
| 覆盖范围 | 试图覆盖全部角色 | 分级处理（简单→静态，复杂→标记给模拟） |
| 与模拟系统关系 | 未定义 | 明确为预过滤层+先验提供者 |
