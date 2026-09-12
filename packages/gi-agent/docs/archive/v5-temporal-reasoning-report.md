# 七圣召唤 AI 决策框架 — 时序推理深度分析报告

> **分支**: `v5-temporal-reasoning`  
> **报告生成**: 2026-05-01  
> **工作目录**: `packages/gi-agent/`

---

## 目录

1. [参考文档索引](#1-参考文档索引)
2. [对局记录深度分析](#2-对局记录深度分析)
3. [模拟器/引擎组件](#3-模拟器引擎组件)
4. [AI 框架设计演进](#4-ai-框架设计演进)
5. [当前进度与剩余工作](#5-当前进度与剩余工作)
6. [技术明细：DSL 萃取实现](#6-技术明细dsl-萃取实现)

---

## 1. 参考文档索引

| 文档 | 路径 | 用途 |
|------|------|------|
| **手工对局提炼** | `ai-decision-framework-v2.md` | 人类玩家（流浪者/莫娜/优菈 vs 神里绫华/宵宫/申鹤）完整 31 步决策逻辑分层提炼 |
| **对局原始记录** | `Moyou-battlelog.md` (3650 行) | 完整的人—LLM 对话记录，包含逐步战术讲解、MCP 架构分析、schema 探索 |
| **AI 改进方案** | `ai-improvement-plan.md` | 系统性改进建议：15+ 启发式权重、7 个 P0-P2 改进项、架构解耦计划 |
| **Combat Window Pipeline** | `combat-window-pipeline.md` | 连招窗口提取/分析/验证流水线 — LLM 赛后结构化分析 → tree-lake 种子库 |
| **卡牌数据库 DSL** | `packages/data/src/cards/support/ally.ts` 等 | 所有卡牌、角色、召唤物的完整游戏规则定义（`.on("endPhase").absorbDice(...)` 模式） |
| **模拟器核心 API** | `packages/core/src/base/skill.ts` | SkillDefinition / InitiativeSkillDefinition / TriggeredSkillDefinition 类型体系 |
| **静态先验** | `packages/gi-agent/src/learning/rl/static-priors.ts` | 卡牌语义标签生成 + 候选动作评分特征 |
| **ML 决策核心** | `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts` (1609 行) | 13 信号加权融合：ranker/qValue/value/tempo/plan/opponent... |

---

## 2. 对局记录深度分析

### 2.1 对局概况

- **己方（后手，人类）**: 流浪者 / 莫娜 / 优菈
- **对方（先手，AI/MCP）**: 神里绫华 / 宵宫 / 申鹤
- **模式**: Human-vs-AI，MCP standalone，`fragmented-decision` 模式，`aiPlayerWho=0`
- **结果**: 后手方在 Round 3 胜利

### 2.2 LLM 捕捉到的决策分层结构

LLM（GLM-5 通过 OpenCode）在与人类合作分析时，成功提炼出 **三层递进决策架构**：

```
战略层 (PlanV2)
  ├─ 全局目标: "蓄爆→扩散→冻结" 三阶段战略线
  ├─ 回合优先级: T1 蓄爆、T2 扩散斩杀、T3 冻结收尾
  └─ 风险规则: 角色阵亡→replan、对方先结束→评估
         │
         ▼
战术层 (DecisionShardV1)
  ├─ 作战窗口: setup → pivot → burst → exit 节点图
  ├─ 候选策略链: 每窗口内 2-4 个候选动作
  └─ 退出条件: 反应就绪/核心角色阵亡
         │
         ▼
操作层 (per-action)
  ├─ 骰子分桶: 计划驱动骰子分配，非反向
  ├─ 斩杀链: 4 步精确算血 + 骰子预算
  └─ 阶段转换: 离散触发（绫华死→立即冻结思维）
```

### 2.3 时序推理缺口：LLM 捕获了结构但未给出精确推导

**LLM 做对了什么**（框架文档 §7.2-7.3）：
1. ✅ 识别出三层递进关系（战略→战术→操作）
2. ✅ 识别出离散的阶段转换触发器（非渐进）
3. ✅ 识别出斩杀链的 4 步精确算血逻辑
4. ✅ 识别出骰子是"计划匹配度"而非"线性价值"模型
5. ✅ 识别出手牌价值是 `f(strategic_goal, phase, tactical_state)` 的动态函数

**LLM 没做到的**（当前核心瓶颈）：
1. ❌ **"立本 vs 卯师傅"的战略差异**：LLM 知道支援牌需要"蓄爆"，但无法从游戏规则中自动推导立本（骰子银行，适合 T1-T2 部署）和卯师傅（食物协同，需要特定手牌）在使用时机上的本质区别
2. ❌ **卡牌时序收益的量化**：LLM 说"投资牌期望 > 1.5x"，但未给出每张投资牌的具体收益曲线（如立本：T1 打 → T2 兑现 4 骰+2手牌，净收益 +100%）
3. ❌ **铺场密度控制**：未能从对局中归纳"当场上已有 2 张 endPhase 触发卡时，再铺第三张会浪费支援格，应改用技能"
4. ❌ **条件协同匹配**：卯师傅需要 food 标签手牌，构筑中没有食物时不应打出 — 这个条件判断 LLM 未自动推导

### 2.4 核心洞察：框架对→执行细节错

对战记录暴露的 7 个时序推理节点中，LLM 提供的框架**结构完全正确**，但每个节点的**具体执行逻辑**（即 AI 需要程序化执行的规则）仍需手工编码：

| 节点 | 框架结构 | 缺失的具体规则 |
|------|---------|--------------|
| 换牌 | ✅ 策略先行 | ❌ 哪些卡牌属于"投资型"（立本 vs 卯师傅无法区分）|
| T1 蓄爆 | ✅ 单动+铺牌 | ❌ 何时停止铺场切换到攻击（场上已有 2 张 endPhase 卡应减少再铺）|
| T2 扩散 | ✅ 扩散窗口确认 | ❌ 扩散前是否需要先清掉对方护盾（虚影/泡影的威胁程度评估）|
| 斩杀链 | ✅ 4 步算血 | ❌ 斩杀链中间步骤的备选方案（如果对方切人/治疗）|
| 阶段转换 | ✅ 条件分叉 | ❌ 阶段转换的精确触发阈值（绫华 HP < 多少才是"可斩杀"）|
| 冻结锁定 | ✅ 全水附着→冰 | ❌ 对方可能通过切人/元素反应打破冻结的条件评估 |
| 收尾 | ✅ 精确算血 | ❌ 多源伤害的时间顺序（召唤物先触发 vs Q 先触发的影响）|

---

## 3. 模拟器/引擎组件

### 3.1 核心模拟器 (`@gi-tcg/core`)

```
packages/core/src/
├── base/
│   ├── skill.ts      SkillDefinition / InitiativeSkillDefinition / TriggeredSkillDefinition
│   ├── entity.ts     EntityDefinition (id, type, tags, skills[], varConfigs)
│   ├── character.ts  CharacterDefinition (extends entity + element/weapon/nation tags)
│   ├── state.ts      GameState (运行时状态 — 骰子、手牌、角色、元素附着)
│   └── mutation.ts   ExposedMutation (damage / createEntity / switchActive / ...)
├── builder/
│   ├── registry.ts   Registry → GameData { entities, characters, extensions, attachments }
│   ├── skill.ts      skill(12031).type("normal").costHydro(1).damage(Hydro, 1)
│   ├── card.ts       card(322008).costSame(3).support("ally").on("endPhase")...
│   ├── entity.ts     summon(112031).endPhaseDamage(Hydro, 1)...
│   └── attachment.ts attachment(201).addCost(...)
└── game.ts           class Game { step(), action(), players[].io }
```

### 3.2 数据编译管线

```
packages/data/src/cards/support/ally.ts  (DSL 源码)
    │  .on("endPhase").absorbDice("diff", 3 - collected)
    │  .on("actionPhase").drawCards(2).generateDice(Omni, 2)
    ▼
Registry (编译时聚合)
    │  registry.resolve() → GameData
    ▼
OFFICIAL_DATA = getData()   (运行时可用)
    │  entities: Map<id, EntityDefinition>
    │  characters: Map<id, CharacterDefinition>
    ▼
static-priors.ts → buildDefinitionPriorMap()
    │  从 definition.tags / type → 机械标签 (card:support, support_create, ...)
    │  从 definition.skills[].triggerOn → V5 时序标签 (timing:endPhase, ...)
    │  从 definition.skills[].initiativeSkillConfig → V5 技能标签 (skill:burst, ...)
    ▼
gi-ml-policy.ts → rankCandidateWithGiMl()
    │  13 信号加权融合 → finalScore
    ▼
BoundedSearcher (Beam + minimax)
```

### 3.3 运行时数据模型（关键类型）

```typescript
// EntityDefinition — 卡牌/召唤物/状态/装备的统一表示
interface EntityDefinition {
  id: number
  type: "eventCard" | "support" | "equipment" | "summon" | "status" | "combatStatus"
  tags: readonly EntityTag[]           // "food" | "talent" | "weapon" | ...
  skills: readonly SkillDefinition[]  // ⬅️ 我们从中萃取触发时序
  varConfigs: { usage?: VariableConfig, duration?: VariableConfig, ... }
  disableTuning: boolean
}

// SkillDefinition — 触发器+效果的编译产物
type SkillDefinition =
  | InitiativeSkillDefinition        // triggerOn: "initiative"
  | TriggeredSkillDefinition         // triggerOn: "onEndPhase" | "onPlayCard" | ...
// ⚠️ 重要: 具体效果 (drawCards, generateDice, heal...) 在 opaque 函数闭包中，
//    运行时无法内省。只能从 triggerOn 和 initiativeSkillConfig 提取。
```

---

## 4. AI 框架设计演进

### 4.1 版本时间线

```
v1 (Baseline only)        ← 15 个硬编码启发式权重
    │
v2 (GiMlPolicy)           ← SlotLinearRanker + ConceptModel
    │
v3 (GBDT value/ranker)    ← 非线性模型替代线性
    │
v4 (Reaction chain +      ← 宏观态势 + 连招窗口 + 反应链模板
     combat windows)
    │
v5 (Temporal reasoning)   ← 当前分支 ← 我们在这里
    ├─ 5.1: DSL 技能标签萃取       ✅ 已完成 (static-priors.ts)
    ├─ 5.2: 门控式 Tempo 评分       ✅ 已完成 (gi-ml-policy.ts)
    ├─ 5.3: 阶段对齐 + 骰子适配     ✅ 已完成 (gi-ml-policy.ts)
    ├─ 5.4: Lethal chain + risk     ✅ 已完成 (gi-ml-policy.ts)
    ├─ 5.5: cardPurposeAlignment     🔲 待实现 (本次输出)
    └─ 5.6: 完整基准测试验证         🔲 待执行
```

### 4.2 各信号权重现状

```typescript
// gi-ml-policy.ts rankCandidateWithGiMl() 最终评分公式
finalScore =
    giMlScore                    // SlotLinearRanker 多槽线性评分 (核心)
  + guardrail                    // 运行时护栏 (极端惩罚: 自杀/浪费)
  + qValueAdjustment             // Q(s,a) 价值 (权重 1.5)
  + valueAdjustment              // V(s) 近似转移价值 (权重 1.0)
  + followupAdjustment           // 元素调谐后续收益 (权重 0.35)
  + macroPlanAdjustment          // 5 种宏观态势评分 (权重 0.6)
  + searchAdjustment             // 搜索引导 (权重 0.8)
  + strategicValueAdjustment     // 战略价值评分 (权重 0.5)
  + reactionChainAdjustment      // 反应链先验 (权重 1.2)
  + opponentAdjustment           // 对手模型调整 (低幅度)
  + lethalChainBonus             // V5: 斩杀链第一步奖励 (0.3 × 阶段倍率)
  + riskResponseBonus            // V5: 风险响应 (critical 时 +0.2)
  + phaseAlignment.score         // V5: 阶段对齐 (回合+宏观计划匹配)
  + diceFitness.score            // V5: 骰子适配度
  + tempoBonus                   // V5: 门控式 Tempo (仅对手已结束时加分)
  + cardPurposeBonus             // V5: 🔲 卡牌意图对齐 (本次新增)
```

### 4.3 已尝试的方案及其结果

| 尝试 | 方案 | 结果 | 结论 |
|------|------|------|------|
| **Tempo V1** | 全量给 playCard/useSkill 加速行加分 | 全局 WR 下降 | 系统性偏差：偏袒铺场，慢速镜像更糟 |
| **Tempo V2 cap** | 限制 tempo 加分上限 | 依然系统性偏差 | cap 不能消除"铺场优于攻击"的方向性误导 |
| **Tempo V3 gate** | 仅对手已 declareEnd 时加分 | 全局 cross-deck 280 局 WR 56.43% (vs 基线) | ✅ 有效！vs 莫优 90% WR |
| **静态标签增强** | 基于 tag/type 扩充 static-priors | 立本=卯师傅=support_create | ❌ 粒度不足，无法区分战略差异 |
| **DSL 萃取 (本次)** | 从 triggerOn 自动提取时序标签 | 立本→timing:endPhase, 卯师傅→timing:reactive | ✅ 区分成功 |

### 4.4 水巴 vs 水凝慢速镜像问题

**已诊断的根因**：
- 双方前 3 回合 77% 行动为铺支援/事件卡，极少技能攻击
- 原因：`supportWeight=1.1` + `entityCreatedValue=2.0` + 门控 tempo 不惩罚铺场 → 铺场收益高
- 立本、派蒙等 `timing:endPhase` 卡牌相互竞争支援格，形成"铺→等→铺→等"死循环
- **DSL 萃取标签直接暴露了**：这些卡都有 `timing:endPhase`，可以在评分层做密度控制

---

## 5. 当前进度与剩余工作

### 5.1 已完成

| 任务 | 状态 | 改动文件 |
|------|------|----------|
| DSL 触发时序标签萃取 | ✅ | `static-priors.ts` +130 行 |
| 卡牌技能类型标签 (N/E/Q/T) | ✅ | 同上 |
| 角色技能标签 (含 energyGain/fast) | ✅ | 同上 |
| 门控式 Tempo 评分 | ✅ | `gi-ml-policy.ts` |
| 阶段对齐评分 (phaseAlignment) | ✅ | `gi-ml-policy.ts` |
| 骰子适配评分 (diceFitness) | ✅ | `gi-ml-policy.ts` |
| Lethal chain 第一步奖励 | ✅ | `gi-ml-policy.ts` |
| Risk response 加分 | ✅ | `gi-ml-policy.ts` |
| Cross-deck 280 局基准 (Tempo V3) | ✅ | WR 56.43% |

### 5.2 待实现

| 优先级 | 任务 | 依赖 | 预计改动 |
|--------|------|------|----------|
| **P0** | 实现 `cardPurposeAlignment` 评分 | 当前萃取标签就绪 | `gi-ml-policy.ts` +50 行 |
| **P0** | 铺场密度控制（基于 timing:endPhase 计数） | P0 的子项 | 同上 |
| **P0** | 协同条件匹配（卯师傅+food 检查） | 同上 | 同上 |
| **P0** | 收益时机 vs 回合阶段对齐 | 同上 | 同上 |
| **P1** | 水巴 vs 水凝小规模验证 | P0 完成 | benchmark 配置 |
| **P1** | 完整 cross-deck 基准测试 | P0 完成 | benchmark 运行 |
| **P2** | 角色被动技能感知（莫娜虚影/泡影的威胁评估） | 萃取标签已就绪 | `macro-plan.ts` 等 |
| **P2** | equipment 装备牌的 skill 萃取（天赋入场即用技能） | 萃取标签已就绪 | `static-priors.ts` |

### 5.3 关键未决问题

1. **效果萃取的不完整性**：`TriggeredSkillDefinition` 的具体效果（如 `c.drawCards(2)`）在编译后是不可内省的函数闭包。当前只能从 `triggerOn`（触发时机）提取。要想知道"抽 2 张牌"还是"生成 2 万能骰"，需要额外信息源（如 DSL 注释解析或手工映射表）。

2. **卡牌协同网络**：卯师傅需要 food 标签、蒂玛乌斯需要 artifact 标签——这些条件在 `skill.filter` 函数中，同样不可内省。当前方案只能通过已有标签（`tag:food`、`tag:artifact`）做启发式匹配，无法 100% 精确。

3. **训练数据的特征覆盖**：新标签通过 `buildHandCardStaticAnnotation` → `CandidateStaticPriorInputV1` 流入评分，但 GBDT ranker/value 模型是在旧特征集上训练的。新标签可能在训练数据中缺乏对应权重。

---

## 6. 技术明细：DSL 萃取实现

### 6.1 数据流

```
EntityDefinition.skills: readonly SkillDefinition[]
    │
    ├─ TriggeredSkillDefinition (skill.triggerOn !== "initiative")
    │   └─ TRIGGER_TAG_MAP[triggerOn] → 时序标签
    │       例: "onEndPhase" → ["timing:endPhase"]
    │           "onPlayCard" → ["timing:reactive", "effect:triggerOnPlayCard"]
    │           "modifyDamage1" → ["effect:modifyDamage", "effect:damageIncrease"]
    │           "decreaseDamaged" → ["effect:damageReduction", "effect:shield"]
    │           ...
    │
    └─ InitiativeSkillDefinition (skill.triggerOn === "initiative")
        └─ initiativeSkillConfig
             ├─ skillType → SKILL_TYPE_TAG_MAP[skillType]
             │   例: "normal" → ["skill:normal"]
             │       "burst" → ["skill:burst", "burst_enable"]
             ├─ gainEnergy → effect:energyGain + energy_gain
             ├─ shouldFast → effect:fastAction
             └─ hidden → skill:hidden
```

### 6.2 标签结果验证

实测 12 张关键卡牌的萃取结果：

| 卡牌 | V5 萃取标签 | 战略含义 |
|------|-----------|---------|
| **立本** (322008) | `timing:endPhase`, `timing:actionPhase` | 结束阶段收集 → 行动阶段兑现 (deferred value) |
| **卯师傅** (322005) | `timing:reactive`, `effect:triggerOnPlayCard` | 打食物时触发 (conditional synergy) |
| **派蒙** (322001) | `timing:actionPhase` | 行动阶段立即产骰 (recurring value) |
| **凯瑟琳** (322002) | `timing:roundEnd`, `effect:fastAction`, `effect:tempoSwitch` | 快速切换引擎 |
| **蒂玛乌斯** (322003) | `timing:endPhase`, `timing:onDeploy`, `effect:deductAllCost` | 装备免费 + 回合间补充材料 |
| **莫娜(E)** (12032) | `skill:elemental`, `effect:energyGain` | 元素战技 + 充能 |
| **莫娜(被动)** (12034) | `effect:fastAction`, `effect:tempoSwitch` | 速切能力 |
| **虚影** (112031) | `timing:endPhase`, `effect:damageDecrease`, `effect:modifyDamage` | 结束阶段伤害 + 护盾 |
| **泡影** (112032) | `effect:damageMultiply`, `effect:modifyDamage` | 伤害倍增器 |
| **土豆饼** (333011) | `effect:fastAction` | 即时食物 |

### 6.3 改动详情

**文件**: `packages/gi-agent/src/learning/rl/static-priors.ts`

**新增代码** (约 170 行):
1. `RuntimeSkillDef` 接口 — 运行时的类型桥接（因为 `@gi-tcg/core` 不导出 `SkillDefinition`）
2. `TRIGGER_TAG_MAP` — 30+ 触发事件 → 语义标签的映射表
3. `SKILL_TYPE_TAG_MAP` — 4 种技能类型→语义标签
4. `extractSkillSemanticTags()` — 核心函数，遍历 `skills[]` 并提取标签
5. 两个集成点：`buildDefinitionPriorMap()` 中对实体和角色均调用萃取

**零侵入**:
- 不修改 `@gi-tcg/data` 或 `@gi-tcg/core`
- 不破坏现有 `STATIC_PRIOR_BY_DEFINITION_ID` 结构
- 新标签作为 `.static_effect_tags` 的扩展字段，完全向后兼容

---

*报告完毕。下一阶段：实现 `cardPurposeAlignment` 到 `gi-ml-policy.ts`。*
