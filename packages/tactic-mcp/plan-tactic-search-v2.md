# 七圣召唤AI：模拟驱动的组合博弈挖掘系统开发计划书

> v2 — 基于对 `@gi-tcg/core` 引擎源码（builder DSL、不可变状态树、PreviewContext、
> 四阶段伤害/费用管线、元素反应系统）和 `@gi-tcg/data`（134 角色、全部卡牌）的深度分析
> 而制定。核心策略是**复用已有游戏引擎做模拟**而非重建符号规则系统。
>
> 前版（plan-tactic-search.txt）基于"符号AI与标签原子化"路线，经评估后发现该路线
> 因条件逻辑密集、非反应联动普遍、非线性收益显著等原因不可行，故全面修订。

---

## 1. 项目概述

### 1.1 项目背景

七圣召唤是一款具有高随机性、非线性收益特征的回合制卡牌游戏。该游戏的复杂性体现在：

*   **条件逻辑密集**：约 70% 的竞技常用角色包含运行时条件分支（HP 阈值、姿态状态机、
    跨实体联动、全局对局记忆），无法用静态标签系统表达。典型案例：
    -   达达利亚：远程/近战双姿态状态机 + 断流跨角色传导
    -   纳西妲：自定义事件连锁 + 队伍组成条件检测（火/雷/水各增一效果）
    -   优菈：累积延迟爆发 + 有条件不获得充能
    -   丝柯克：完全自定义资源系统（蛇之狡谋替代充能）
*   **非反应联动普遍**：大量高收益组合由位置逻辑（前台/后台）、行动计数、切换事件链、
    充能操纵、手牌生成循环等非元素反应机制驱动。典型案例：
    -   黄金剧团的奖赏：后台累积报酬 → 前台消耗减费（位置逻辑）
    -   闲云天赋：切换角色累积风翎 → 普攻消耗风翎增伤（切换→资源转化）
    -   赛索斯天赋：普攻不获充能 + 消耗充能造成穿透伤害（充能体系替代）
    -   刻晴：元素战技 → 生成雷楔手牌 → 打出手牌切换附魔（手牌循环）
*   **非线性收益显著**：单一的"理论收益 × 完成率系数"无法准确建模斩杀线附近的价值跃升、
    骰子边际价值递增、回合节奏的非对称代价等效应。

### 1.2 核心目标

构建一套**基于游戏引擎模拟的自动化组合挖掘系统**，覆盖全部 134 个角色和所有卡牌版本。

该系统需具备以下能力：

*   **自动组合挖掘**：通过 beam search + 引擎模拟，无人工监督地发现高收益行动序列，
    包括元素反应组合、非反应联动、单卡驱动组合等。
*   **多维非线性评估**：使用多维状态 delta 向量替代单一系数，通过非线性聚合函数
    综合伤害、资源、节奏、位置、防御等维度。
*   **博弈对抗**：对手响应模型从同一组合库搜索，形成 minimax + beam search 结构。
*   **结构化输出**：面向 AI agent 的 JSON 结构化输出，对接已有 tactic-mcp schema 体系。

### 1.3 设计原则

1.  **引擎复用 > 规则重建**：不重新实现伤害计算/反应/费用逻辑，直接调用 `@gi-tcg/core`
    的 `PreviewContext` / `StateMutator` / `ActionPreviewer`。
2.  **模拟 > 静态分析**：通过差分模拟（有/无某卡的状态对比）自动捕捉任意复杂的卡牌效果，
    不需要理解或编码其文本语义。
3.  **最小人工干预**：避免手工模式库引入先验偏置；组合的发现、评估、入库均为全自动流程。
4.  **概率内嵌 > 预过滤**：资源可行性（骰子/手牌达成率）嵌入搜索评估循环内部，
    而非作为预过滤层丢失高价值低概率组合。

---

## 2. 系统架构

```
┌───────────────────────────────────────────────────────────────────┐
│  Layer 4: MCP 输出接口                                             │
│  对接 decision-shard-v1 / plan-v2 / critic-result-v1 schema       │
│  结构化 JSON + 可选固定格式 annotation                              │
├───────────────────────────────────────────────────────────────────┤
│  Layer 3: 组合库 (ComboRegistry)                                   │
│  自动入库 + 去重 + 按牌组/局面索引查询                               │
│  双方共享：对手响应也从该库搜索                                       │
├───────────────────────────────────────────────────────────────────┤
│  Layer 2: 状态评估器 (StateEvaluator)                              │
│  ExposedMutation → 多维 StateDelta 向量 → 非线性聚合评分            │
│  含资源可行性维度（MC 骰子采样 / 手牌依赖度）                         │
├───────────────────────────────────────────────────────────────────┤
│  Layer 1: 受限搜索器 (BoundedSearcher)                             │
│  beam search (宽度 8~15, 深度 4~6) + 启发式剪枝                     │
│  战斗行动节点后嵌入对手 minimax 响应                                  │
├───────────────────────────────────────────────────────────────────┤
│  Layer 0: 模拟引擎适配层 (SimAdapter)                              │
│  封装 PreviewContext/StateMutator → (state, action) → state'       │
│  IO 中断点确定性默认策略 + 合法动作枚举                               │
└───────────────────────────────────────────────────────────────────┘
          ↑ 复用                           ↑ 复用
    @gi-tcg/core                     @gi-tcg/tactic-mcp
    (PreviewContext,                  (schema 校验器,
     StateMutator,                    tool contracts,
     ActionPreviewer,                 plan-v2 / decision-shard-v1 /
     Game.availableActions)           critic-result-v1)
```

---

## 3. 模块详细设计

### 3.1 Layer 0：模拟引擎适配层 (SimAdapter)

**职责**：将 `@gi-tcg/core` 的异步预览系统封装为搜索器可用的确定性接口。

**核心接口**：

```typescript
interface SimAdapter {
  // 核心：执行一个动作，返回新状态 + 变更记录
  step(state: GameState, action: ActionInfoBase): SimResult;

  // 枚举当前所有合法动作（复用 Game.availableActions 的逻辑）
  legalActions(state: GameState, who: 0 | 1): ActionInfo[];

  // 构造特定牌组的初始状态（用于离线挖掘）
  createInitialState(deck0: DeckConfig, deck1: DeckConfig): GameState;
}

interface SimResult {
  newState: GameState;
  mutations: ExposedMutation[];  // 变更记录（伤害/治疗/实体创建/销毁等）
  stopped: boolean;              // 是否因 IO 中断而截断
}
```

**实现要点**：

*   **基于 PreviewContext**：创建 `StateMutator`（IO 回调为空操作），用 `SkillExecutor`
    在 preview 模式下执行技能。`GameState` 本身是不可变的（基于 immer），每次 `step()`
    返回的 `newState` 是结构共享的新对象，无需显式克隆。
*   **IO 中断默认策略**：当模拟中需要异步 IO（如角色被击败 → 选择新出战角色）时，
    `PreviewContext` 会抛出 `GiTcgPreviewAbortedError`。适配层捕获此异常后：
    -   被击败选人：自动选择血量最高的存活角色
    -   selectCard：自动选择第一个候选
    -   记录 `stopped = true`，供搜索器判断路径置信度
*   **不修改 core 代码**：纯适配层，通过 `@gi-tcg/core` 的公开 API 组合实现。
*   **中断率监控**：P0 阶段需统计不同角色/技能组合的中断率。若某类技能中断率 >15%，
    考虑向 core 提 PR 扩展 preview 模式的 IO fallback 接口。

### 3.2 Layer 1：受限搜索器 (BoundedSearcher)

**职责**：在有限计算预算内枚举高质量行动路径。

**算法：Beam Search**

```typescript
interface SearchConfig {
  maxDepth: number;          // 最大前推步数，建议 4~6
  beamWidth: number;         // 每层保留候选数，建议 8~15
  evalFn: StateEvaluator;    // 评估函数（Layer 2）
  perspective: 0 | 1;        // 搜索视角玩家
  enableMinimax: boolean;    // 战斗行动节点后是否嵌入对手响应
  minimaxDepth: number;      // 对手响应搜索深度，建议 1~2
}

interface SearchResult {
  path: ActionInfoBase[];    // 行动序列
  stateAfter: GameState;     // 终态
  score: number;             // 综合评分
  deltas: StateDelta[];      // 每步的 delta 向量
  feasibility: number;       // 资源可行性（当前回合 = 1.0）
}
```

**计算量控制**：

*   beam width = 10, depth = 5 时，最坏评估次数 ≈ 10^5 = 100,000
*   每次评估 = 1 次 `SimAdapter.step` + delta 提取 + 聚合评分
*   实际经剪枝后远小于此上界

**启发式剪枝规则**：

1.  **资源不可行剪枝**：引擎 `legalActions()` 已自动排除费用不足的动作，无需额外处理
2.  **明显无效动作剪枝**：跳过对满血己方角色的治疗、无意义的重复元素调和等
3.  **等价动作合并**：同类型装备装同一角色、功能等价的手牌等合并为单个候选
4.  **快速行动优先展开**：快速行动不消耗回合，分支成本低，优先纳入候选

**对手响应（Minimax 嵌入）**：

当路径中出现战斗行动（`isFast = false`）时，回合交给对手。若 `enableMinimax`：

1.  在对手视角调用 `BoundedSearcher`（深度 = `minimaxDepth`，通常 1~2）
2.  取对手最优响应路径
3.  在对手执行完毕后的状态上继续我方搜索
4.  我方评分 = 我方 delta - 对手 delta（零和博弈视角）

双方共享同一 `StateEvaluator` 和 `ComboRegistry`，不需要为对手单独建模。

### 3.3 Layer 2：状态评估器 (StateEvaluator)

**职责**：将模拟产生的 `ExposedMutation[]` 转换为多维评分。

#### 3.3.1 状态 Delta 向量

```typescript
interface StateDelta {
  // ──── 伤害维度 ────
  damageDealt: number;           // 造成的伤害总量
  reactions: Reaction[];         // 触发的元素反应列表
  defeatedCount: number;         // 击败角色数（0/1/2/3）

  // ──── 资源维度 ────
  diceSpent: number;             // 消耗骰子数
  diceGained: number;            // 获得骰子数（支援牌/教官帽/产骰效果等）
  cardsDrawn: number;            // 抓牌数
  energyDelta: number;           // 己方充能净变化
  entitiesCreated: number;       // 创建的有利实体数（出战状态/召唤物/装备）
  entitiesRemoved: number;       // 消除的敌方实体数

  // ──── 节奏维度 ────
  turnsConsumed: number;         // 消耗的回合数（战斗行动 = 1，快速行动 = 0）
  opponentWindowsGiven: number;  // 给对手的响应窗口数（= 路径中战斗行动数）

  // ──── 位置维度 ────
  myActiveChanged: boolean;      // 我方出战角色是否变化
  oppActiveForced: boolean;      // 是否强制对手切人（超载等）
  auraApplied: number;           // 施加在对方的元素附着（Aura 值）

  // ──── 防御维度 ────
  shieldsCreated: number;        // 创建的护盾数
  healingDone: number;           // 治疗量
  myHealthLost: number;          // 己方损失血量（含自残）

  // ──── 资源可行性维度 ────
  diceFeasibility: number;       // 当前回合 = 1.0；下回合 = MC 采样率
  handDependencyTurns: number;   // 还需几回合集齐所需手牌（0 = 无依赖）
  tuningOpportunities: number;   // 可用元素调和次数
  diceGenPotential: number;      // 路径中触发的产骰效果总量
}
```

#### 3.3.2 Delta 提取

从 `SimResult.mutations` (即 `ExposedMutation[]`) 中解析：

*   `damage` mutation → `damageDealt` 累加，检测 `isSkillMainDamage`
*   `modifyEntityVar` (health 变化) → `myHealthLost` / `healingDone`
*   `modifyEntityVar` (energy 变化) → `energyDelta`
*   `createEntity` / `removeEntity` → `entitiesCreated` / `entitiesRemoved`
*   `switchActive` → `myActiveChanged` / `oppActiveForced`
*   `applyAura` → `auraApplied`
*   `resetDice` → `diceGained`

反应信息从引擎的 `DamageInfo.fromReaction` 字段提取。

#### 3.3.3 非线性聚合函数

```
score(δ) = Σ_i  w_i · f_i(δ_i, context)
```

各维度的非线性映射 `f_i`：

| 维度 | 非线性特征 | 原因 |
|------|-----------|------|
| `f_damage` | 击败对方角色时跃升（`defeatedCount > 0` → 大幅加分） | 减少对手一个角色 = 永久资源优势 |
| `f_damage` | 接近斩杀线时加速增长 | 将对手角色从 3HP 打到 0 的价值 >> 从 10HP 打到 7HP |
| `f_dice` | 剩余骰子越少，边际价值越高 | 最后 2 骰远比前 2 骰宝贵 |
| `f_turns` | 对手越接近宣布结束，战斗行动代价越高 | 追速回合浪费战斗行动 = 白送对手先手 |
| `f_feasibility` | `rate^α`，α ∈ [0.5, 1.5] | α < 1 倾向冒险，α > 1 倾向保守 |
| `f_handDep` | `β^turns`，β ≈ 0.7 | 每等 1 回合，combo 价值打折（局势变化可能使其失效） |

**权重 w_i 的校准**：

*   P0~P4 阶段使用均匀初值（不依赖先验）
*   P5 阶段通过自对弈胜率做后验回归：记录每个 combo 的使用频率和对局胜率贡献，
    反向优化 w_i 使高胜率 combo 获得高评分

#### 3.3.4 资源可行性评估（嵌入搜索而非预过滤）

**当前回合**（骰子已确定）：

*   `legalActions()` 已通过 `checkDice()` 校验费用可行性
*   `diceFeasibility = 1.0`（引擎保证合法）

**下一回合规划**（骰子未投）：

使用蒙特卡洛采样替代解析枚举（解析法在多色需求 + 元素调和 + 支援产骰场景下组合爆炸）：

```typescript
interface DiceFeasibility {
  sampleCount: number;           // 采样次数，建议 500~1000
  feasibleCount: number;         // combo 可执行的采样数
  feasibilityRate: number;       // feasibleCount / sampleCount
  avgDiceDeficit: number;        // 不可行时的平均骰子缺口
}
```

*   直接复用引擎的 `randomDice()` 生成骰面 + 最优重掷策略
*   天然支持元素调和（弃牌换出战角色元素骰）和支援牌产骰效果
*   1000 次采样的概率估计标准误 ≈ 3%，足够用于 beam 排序

**多回合规划**（手牌未集齐）：

不做精确概率计算，改用"手牌依赖度"：

```typescript
interface HandDependency {
  requiredCardIds: number[];       // combo 需要的手牌 definition IDs
  inHandNow: number[];             // 当前已在手中的
  notInHand: number[];             // 当前不在手中的
  remainingInPile: number;         // 牌堆中剩余几张（精确值）
  expectedTurnToComplete: number;  // 预期几回合后集齐（每回合抽 2 张）
  isGuaranteedThisTurn: boolean;   // 本回合是否确定可行
}
```

*   当前回合手牌已知 → 确定性判断
*   跨回合：仅追踪"还需几回合"，比概率值更有决策价值
*   `handDependencyTurns` 作为评估向量的一个维度，通过 `β^turns` 自然降权

**已有 6_4Prob/dice*.py 的处置**：

保留作为 MC 采样器的 unit test ground truth——用解析解验证采样器在简单场景下的准确性。

### 3.4 Layer 3：组合库 (ComboRegistry)

**职责**：存储已发现的高质量组合，支持按局面状态快速查询。

#### 3.4.1 组合条目结构

```typescript
interface ComboEntry {
  id: string;                     // 内容哈希 ID

  // ──── 牌组上下文 ────
  deckContext: {
    characters: number[];          // 涉及角色 definition IDs
    requiredCards: number[];       // 涉及卡牌 definition IDs
  };

  // ──── 前置条件（结构化，机器可读）────
  preconditions: {
    phase: "early" | "mid" | "late";
    myActive?: {
      definitionId: number;
      element: DamageType;
      minEnergy?: number;
      hasStatus?: number[];        // 需要持有的状态 IDs
    };
    myStandby?: {
      definitionId: number;
      element: DamageType;
    }[];
    opponentActive?: {
      aura?: Aura;
      maxHealth?: number;          // 斩杀线
    };
    minDice?: number;
    requiredHandCards?: number[];
    positionRequirements?: Record<number, "active" | "standby">;
  };

  // ──── 行动序列 ────
  actionSequence: {
    step: number;
    type: "useSkill" | "playCard" | "switchActive" | "elementalTuning";
    definitionId: number;          // 技能/卡牌/角色 definition ID
    isFast: boolean;
    annotation?: string;           // 固定格式摘要（见 3.5.2）
  }[];

  // ──── 评估结果 ────
  evaluation: {
    totalScore: number;
    delta: StateDelta;
    scoreBreakdown: Record<string, number>;  // 各维度贡献
    riskFactors: {
      opponentResponseWindows: number;   // 对手响应窗口数
      comboBreakProbability: number;     // 被中断概率（模拟统计）
      resourceOvercommit: boolean;       // 是否过度消耗资源
    };
  };

  // ──── 元信息 ────
  discoveredBy: "beam-search" | "self-play" | "differential";
  gameVersion: string;
  sampleCount: number;             // 在多少个局面中被观测到
  avgWinrateContribution: number;  // 自对弈统计的胜率贡献
}
```

#### 3.4.2 离线挖掘流程

```
对每个合法牌组配置 (deck0, deck1)：
  构造 N 个不同的初始局面（随机骰面/手牌/先手方）

  对每个局面的每个决策点：
    1. BoundedSearcher 输出 top-K 路径
    2. 筛选 score 超过阈值 θ 的路径 → 候选 combo
    3. 变体检验：在 M 个不同骰面/手牌变体下重新模拟
       - 统计 combo 的可行率和 score 稳定性
       - 过滤掉仅在极端运气下才成立的路径
    4. 写入 ComboRegistry
    5. 去重：合并 actionSequence 等价的条目（取最宽松 preconditions）

  按牌组粒度并行，天然可分布式调度
```

#### 3.4.3 查询接口

```typescript
interface ComboQuery {
  state: GameState;               // 当前局面
  who: 0 | 1;                    // 查询视角
  topK: number;                   // 返回数量
  minScore?: number;              // 最低评分
  mustIncludeCards?: number[];    // 必须包含特定卡牌
}

function queryCombo(query: ComboQuery): ComboEntry[];
```

对手搜索也用此接口——输入对手视角的 `state` + `who`，返回对手的最优应对。

### 3.5 Layer 4：MCP 输出接口

**职责**：将 combo 查询结果封装为 MCP 工具输出，对接已有 schema 体系。

#### 3.5.1 输出格式（结构化 JSON，对接 decision-shard-v1）

```typescript
interface ComboRecommendation {
  combo_id: string;
  priority: number;                    // 1~100

  // 直接映射到 decision-shard-v1 的 candidate_policies
  preconditions: string[];             // 机器可读条件表达式
  action_sequence: {
    step: number;
    tool: "choose_action" | "choose_active" | "elemental_tuning";
    args: {
      definition_id: number;
      skill_type?: "normal" | "elemental" | "burst" | "technique";
      target_definition_id?: number;
    };
    is_fast: boolean;
  }[];

  evaluation: {
    total_score: number;
    damage_dealt: number;
    dice_efficiency: number;           // damage / dice_spent
    turns_consumed: number;
    dice_feasibility: number;          // MC 采样率 (0~1)，当前回合 = 1.0
    hand_dependency_turns: number;     // 手牌集齐还需回合数
    risk_factors: {
      opponent_response_windows: number;
      combo_break_probability: number;
      resource_overcommit: boolean;
    };
  };

  annotation?: string;                 // 可选，固定格式摘要
}
```

#### 3.5.2 Annotation 格式规范

固定格式，可正则解析，AI agent 优先读 JSON 结构，annotation 仅供日志/调试：

```
[{action_type}:{definition_name}({cost},{fast|combat})] → ... | dmg={N} dice={M} turns={T} feas={F}
```

示例：

```
[switch:行秋(1任,fast)] → [skill:画雨笼山(3水,combat)] → [skill:黎明(4火+3能,combat)] | dmg=14 dice=8 turns=2 feas=1.0
```

#### 3.5.3 与已有 Schema 的对接

| 已有 Schema | 对接方式 |
|---|---|
| `plan-v2` (开局计划) | 离线挖掘中的"开局向"combo 子集 → 生成 `turn_priorities` |
| `decision-shard-v1` (决策分片) | 每个匹配 combo → 一个 `candidate_policy`，preconditions → schema 的 preconditions，action_sequence → action_template |
| `critic-result-v1` (后评估) | 模拟验证结果 → `score` + `violations` |

---

## 4. 关键技术挑战与应对

### 4.1 PreviewContext 中断率

**问题**：复杂技能链（如触发击败 → 选人 → 连锁效果）可能导致 preview 中断。

**应对**：
*   P0 阶段量化统计不同技能组合的中断率
*   中断率 < 15%：使用默认策略（选血量最高角色），在 `SimResult` 中标记 `stopped = true`，
    搜索器对 `stopped` 路径施加置信度折扣
*   中断率 > 15%：向 `@gi-tcg/core` 提 PR，扩展 `PreviewContext` 支持可配置的 IO fallback

### 4.2 搜索宽度不足遗漏创新组合

**问题**：beam width 有限，某些非直觉组合可能在早期被剪枝淘汰。

**应对**：
*   自对弈中的"意外高胜率路径"反向扩充搜索：当某个未入库的行动在实际自对弈中
    表现优于预期时，以该路径的前缀扩展 beam
*   定期用更大 beam width（如 50~100）做全量扫描，代价更高但可发现罕见组合
*   差分模拟辅助发现：对每张卡牌做"有/无"对比，边际贡献显著的单卡 → 围绕它专项搜索

### 4.3 134 角色 × 数百卡牌的全覆盖计算量

**应对**：
*   按牌组粒度并行——每个牌组配置独立搜索，天然可分布式
*   优先覆盖竞技常用牌组，再逐步扩展到冷门配置
*   增量更新：新版本角色/卡牌仅需重新搜索涉及该角色的牌组

### 4.4 评估函数权重偏差

**应对**：
*   P0~P4 阶段使用均匀权重（避免引入先验偏置）
*   P5 阶段用自对弈数据做后验校准
*   持续监控"评估分数高但实际胜率低"的 combo，这类案例暴露 f_i 或 w_i 的偏差

---

## 5. 开发路线图

### Phase 0：模拟引擎适配层 (SimAdapter)

**任务**：
*   封装 `PreviewContext` + `StateMutator`，实现 `step()` / `legalActions()` 接口
*   实现 IO 中断默认策略（击败选人、selectCard 等）
*   统计中断率 benchmark（对 20+ 个常用角色的单步和双步 combo）
*   实现 `createInitialState()`，支持指定牌组配置构造局面

**交付**：
*   `SimAdapter` 类，通过单元测试验证与引擎的一致性
*   中断率统计报告

**验证**：
*   迪卢克 E → E → E 三连，验证第三次 +2 伤害
*   行秋 E → 雨帘剑状态创建，验证减伤逻辑
*   火+水 → 蒸发反应触发，验证 +2 伤害

### Phase 1：状态评估器 (StateEvaluator)

**任务**：
*   实现 `ExposedMutation[]` → `StateDelta` 的提取逻辑
*   实现非线性聚合函数（均匀权重初值）
*   实现 MC 骰子采样器（用于下回合可行性）
*   实现手牌依赖度追踪

**交付**：
*   `StateEvaluator` 类
*   用 `6_4Prob/dice.py` 的解析解验证 MC 采样器准确性的测试用例

**验证**：
*   对比两条已知路径（蒸发斩杀 vs 普攻磨血），验证前者得分显著高于后者
*   验证黄金剧团"后台累积 → 前台消耗"的差分收益被正确捕捉

### Phase 2：受限搜索器 (BoundedSearcher)

**任务**：
*   实现 beam search 框架
*   实现启发式剪枝规则（无效动作、等价合并、快速优先）
*   集成 SimAdapter + StateEvaluator

**交付**：
*   `BoundedSearcher` 类
*   可对单个局面输出 top-K 行动路径

**验证**：
*   经典局面测试：迪卢克+行秋 vs 甘雨+莫娜，验证蒸发/冻结路径被发现
*   资源受限局面：仅 3 骰子时，验证搜索结果全部资源可行

### Phase 3：组合库 (ComboRegistry)

**任务**：
*   实现存储/去重/查询接口
*   实现离线挖掘脚本（单牌组 → 多局面 → 多决策点 → 批量搜索 → 入库）
*   实现变体检验（跨骰面/手牌验证 combo 稳定性）

**交付**：
*   `ComboRegistry` 类 + 持久化存储（JSON 文件或 SQLite）
*   首批 3~5 个牌组的 combo 库

### Phase 4：MCP 工具封装

**任务**：
*   在 tactic-mcp 注册新工具：`query_combos` / `evaluate_position`
*   输出格式对接 `decision-shard-v1` schema
*   实现 `annotation` 固定格式生成

**交付**：
*   可通过 MCP 协议调用的 combo 查询和局面评估工具
*   通过 `TacticToolContractValidator` 校验的请求/响应样例

### Phase 5：自对弈校准

**任务**：
*   搭建自对弈框架（两个 AI agent 使用 combo 库 + beam search 对弈）
*   记录每个 combo 的使用频率和对局胜率贡献
*   回归优化评估函数权重 w_i
*   淘汰低胜率贡献的 combo，提升高胜率 combo 的权重

**交付**：
*   校准后的评估函数参数
*   combo 库的胜率标注

### Phase 6：对手响应集成

**任务**：
*   在 BoundedSearcher 的战斗行动节点后嵌入对手 minimax 搜索
*   对手也从 ComboRegistry 查询最优响应
*   实现零和评分（我方 score - 对手 score）

**交付**：
*   带 minimax 的完整搜索器
*   对抗测试验证

---

## 6. 预期成果示例

### 系统输入（GameState 的结构化摘要）

```json
{
  "my": {
    "active": { "id": 1301, "name": "迪卢克", "hp": 10, "energy": 3, "maxEnergy": 3 },
    "standby": [
      { "id": 1202, "name": "行秋", "hp": 10, "energy": 1, "maxEnergy": 2 }
    ],
    "dice": ["Pyro","Pyro","Pyro","Pyro","Hydro","Hydro","Hydro","Omni"],
    "hand": [213011, 322004]
  },
  "opp": {
    "active": { "id": 1101, "name": "甘雨", "hp": 4, "energy": 2, "aura": "Hydro" }
  }
}
```

### 系统输出

```json
{
  "recommendations": [
    {
      "combo_id": "a3f7c...",
      "priority": 95,
      "action_sequence": [
        { "step": 1, "tool": "choose_action", "args": { "definition_id": 322004 }, "is_fast": true },
        { "step": 2, "tool": "choose_active", "args": { "definition_id": 1202 }, "is_fast": true },
        { "step": 3, "tool": "choose_action", "args": { "definition_id": 12022, "skill_type": "elemental" }, "is_fast": false },
        { "step": 4, "tool": "choose_action", "args": { "definition_id": 13013, "skill_type": "burst" }, "is_fast": false }
      ],
      "evaluation": {
        "total_score": 87.3,
        "damage_dealt": 14,
        "dice_efficiency": 1.75,
        "turns_consumed": 2,
        "dice_feasibility": 1.0,
        "hand_dependency_turns": 0,
        "risk_factors": {
          "opponent_response_windows": 1,
          "combo_break_probability": 0.12,
          "resource_overcommit": false
        }
      },
      "annotation": "[card:交给我吧(0费,fast)] → [switch:行秋(fast)] → [skill:画雨笼山(3水,combat)] → [skill:黎明(4火+3能,combat)] | dmg=14 dice=7 turns=2 feas=1.0"
    },
    {
      "combo_id": "b82e1...",
      "priority": 45,
      "action_sequence": [
        { "step": 1, "tool": "choose_action", "args": { "definition_id": 13012, "skill_type": "elemental" }, "is_fast": false },
        { "step": 2, "tool": "choose_action", "args": { "definition_id": 13012, "skill_type": "elemental" }, "is_fast": false }
      ],
      "evaluation": {
        "total_score": 38.1,
        "damage_dealt": 6,
        "dice_efficiency": 1.0,
        "turns_consumed": 2,
        "dice_feasibility": 1.0,
        "hand_dependency_turns": 0,
        "risk_factors": {
          "opponent_response_windows": 2,
          "combo_break_probability": 0.45,
          "resource_overcommit": false
        }
      },
      "annotation": "[skill:逆焰之刃(3火,combat)] → [skill:逆焰之刃(3火,combat)] | dmg=6 dice=6 turns=2 feas=1.0"
    }
  ]
}
```

---

## 7. 依赖与约束

### 7.1 引擎依赖

| 包 | 用途 | 版本要求 |
|---|---|---|
| `@gi-tcg/core` | PreviewContext, StateMutator, GameState 类型, ActionPreviewer | 当前 workspace 版本 |
| `@gi-tcg/data` | 全部角色/卡牌定义, GameData 注册 | 同上 |
| `@gi-tcg/typings` | ExposedMutation, PreviewData 等类型 | 同上 |
| `@gi-tcg/utils` | checkDice, chooseDice 等工具函数 | 同上 |

### 7.2 tactic-mcp 已有资产

| 资产 | 复用方式 |
|---|---|
| `TacticToolContractValidator` | 校验新工具的请求/响应格式 |
| `plan-v2.schema.json` | combo 库的开局子集导出为 plan |
| `decision-shard-v1.schema.json` | combo 推荐直接映射为 candidate_policy |
| `critic-result-v1.schema.json` | 模拟验证结果映射为评估报告 |
| MCP tool contracts | 新增 `query_combos` / `evaluate_position` 工具注册 |

### 7.3 语言与运行环境

*   TypeScript（与 core 引擎一致）
*   Node.js 运行时
*   无外部数据库依赖（combo 库用 JSON 文件或 SQLite）

---

## 附录

### A. 原方案废弃原因

原计划（plan-tactic-search.txt）基于"符号AI + 标签原子化 + DFS 全路径搜索"路线。
经对 `@gi-tcg/core` 和 `@gi-tcg/data` 源码的深度分析，确认该路线存在以下根本性问题：

1.  **标签原子化不可行**：约 70% 的角色技能包含运行时条件分支（HP 阈值、姿态状态机、
    跨实体联动、`.do()` 块中的命令式逻辑），无法映射为 `{id, type, cost, outputs}` 的扁平结构。
2.  **DFS 状态空间爆炸**：每行动点约 15~20 分支，5 步深度 = 20^5 ≈ 3.2×10^6 节点（仅我方），
    加上对手响应为指数级增长，不做激进剪枝在单回合内即不可行。
3.  **重复实现引擎逻辑**：手工编码反应规则表、伤害计算等 = 重写 @gi-tcg/core 的子集，
    维护成本极高且容易与引擎不一致。
4.  **单一系数无法建模非线性**："理论收益 × 完成率系数"丢失了斩杀线跃升、骰子边际递增、
    回合节奏非对称等关键非线性效应。

### B. 已有骰子概率计算代码

`6_4Prob/dice*.py` 实现了多色骰子需求的解析概率计算（多项分布 + 重投策略）。
在本方案中保留作为 MC 采样器的验证基准：

*   `dice.py`：多色联合需求 `[x火, y水]` 的精确概率
*   `dice_3any.py`：任意 3 同色的概率
*   `dice_3any_restrict.py`：带转换约束的概率

用于 Phase 1 中验证 MC 采样器在简单场景下与解析解的一致性（误差 < 3%）。

### C. 核心游戏参数

| 参数 | 默认值 |
|---|---|
| 每回合掷骰数 | 8 |
| 骰子上限 | 16 |
| 初始手牌 | 5 |
| 手牌上限 | 10 |
| 每回合结束阶段抽牌 | 2 |
| 最大回合数 | 15 |
| 骰面分布 | 7 元素 + 万能，各 1/8 |
| 重投次数 | 1（可被效果增加） |
| 召唤物上限 | 4 |
| 支援区上限 | 4 |

### D. 快速行动 vs 战斗行动的引擎建模

*   角色主动技能（normal/elemental/burst/technique）：`shouldFast = false`，均为战斗行动
*   事件卡：`shouldFast = !tags.includes("action")`，无 "action" tag = 快速行动
*   `ActionInfo.fast` 字段决定执行后是否消耗回合
