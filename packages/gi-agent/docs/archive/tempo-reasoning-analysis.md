# 七圣召唤时序推理：从搜索瓶颈到状态估值

> **⚠️ 状态：部分过时** — 搜索瓶颈→状态估值分析已被采纳。Tempo 评分已从 tempoBonus 演进到 temporal-opportunity 层。撰写于 V5。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

> 问题重述：BoundedSearcher 深度搜索能发现莫优流 T1 抢先手→T2 扩散的时间线，但 sim.step 代价使每局
> 36秒。字符级硬编码（"莫娜有速切就给 declareEnd +2"）不可扩展——抢先/后博弈是七圣核心机制，任何
> 有速切+召唤的组合都产生同样的博弈。

---

## 1. 为什么搜索正确但太慢

### 1.1 搜索路径分析

莫优流 T1 抢先手的时间线：

```
T1 my turn:  莫娜E(挂水+召唤) → declareEnd
T1 opp turn: [对手可能继续行动——这是关键未知]
T2 opp turn: 对手先动（可能攻击/切人）
T2 my turn:  快速切流浪者 → E(扩散) → 伤害爆发
```

这条链在 BoundedSearcher 中的搜索实际上是：

```
depth=0: 莫娜E                (我方，expanded)
depth=1: declareEnd           (我方，expanded)  
depth=2: 对手剩余 T1 行动     (simulateOpponentTurn, 2-3 steps)
depth=3: 对手 T2 先动         (simulateOpponentTurn, 1 step)
depth=4: 快速切流浪者         (expandCrossRoundInitiative)
depth=5: 流浪者E扩散           (expandCrossRoundInitiative)
```

每层 expansion 调用 `sim.step()` → 创建 `new Game(state)` → 运行完整的游戏引擎（效果解析、反应链、
事件触发）→ 返回。**一次 step ≈ 20-30ms**。depth=5 时每个 beam 节点产生 ~80 次 step 调用。

### 1.2 性能分解

| 操作 | 每决策点调用次数 | 单次耗时 | 总计 |
|------|-----------------|---------|------|
| sim.step (我方行动) | ~25 | ~25ms | ~0.6s |
| sim.step (对手模拟) | ~40 | ~25ms | ~1.0s |
| sim.step (跨回合扩展) | ~15 | ~25ms | ~0.4s |
| 其他 (legalActions, 评分) | ~20 | ~5ms | ~0.1s |
| **每决策点总计** | | | **~2.1s** |
| **每局 (14 决策点)** | | | **~30s** |

瓶颈清晰：`sim.step` 是对完整游戏引擎的调用。在 WSL/i7 上每 step ~25ms，无法通过 JS 层面优化。

### 1.3 关键洞察

**时序推理的真正价值不在搜索本身，而在状态属性。** `declareEnd` 的价值不取决于对手的具体行动
（对手打 E 还是 Q 还是切人），而取决于：

- 我有多少召唤伤害会在回合开始时触发？
- 我是否能在下回合先动（快速行动优势）？
- 对手是否也已经结束（我已经抢占先手）？
- 结束回合的风险（会被对手下回合第一动斩杀吗）？

这些全是可以从 `GameState` 直接计算的状态属性——不需要搜索。

---

## 2. 七圣时序博弈的通用结构

### 2.1 时序的五层博弈

```
Layer 1: 快速行动链 (Fast Action Chain)
  └─ 谁能在对手不动的情况下连打多个快速行动？
  └─ 例：莫娜被动速切 + 流浪者E  = 2个快速行动链

Layer 2: 回合结束博弈 (End Declaration Game)
  └─ 谁先 declareEnd？
  └─ 后结束方获得下回合先手权

Layer 3: 召唤/状态跨回合压力 (Round-Boundary Pressure)
  └─ 回合开始时触发召唤伤害、状态效果
  └─ 先手方可以在召唤伤害后立即衔接技能

Layer 4: 元素持久化利用 (Element Persistence)
  └─ 元素附着跨回合保持
  └─ 先手方可以立即触发反应

Layer 5: 骰子/手牌非对称消耗 (Resource Asymmetry)
  └─ 一方消耗少、另一方消耗多时，结束回合迫使对手浪费骰子
```

### 2.2 为什么这是系统机制而非角色专属

| 机制 | 触发条件 | 涉及角色 |
|------|---------|---------|
| 快速切换 | 角色被动/天赋赋予"切换视为快速行动" | 莫娜、刻晴、神里绫华、宵宫(Q) …… |
| 召唤物跨回合伤害 | 回合开始阶段触发召唤效果 | 所有有召唤技能的角色 |
| 元素附着保持 | 角色身上的元素在回合结束后不清除 | 全角色通用 |
| 骰子消耗差异 | declareEnd 后对方仍需行动 | 全卡组通用 |
| 抢先手 | 对方已 declareEnd，我仍可行动 | 全卡组通用 |

**这不是莫优流专属——这是七圣的基础规则。**

当前 bounded-searcher 中的 magic numbers：
```typescript
// Line 154: bounded-searcher.ts
if (hasFastSwitch) { initiativeBonus = 2.0; }

// Line 163:
if (crossRound && isFast && node.totalDepth > 3) {
  crossRoundBonus = 1.5;
}
```

问题：
1. `hasFastSwitch` 检测的是 `entity.definition.tags` 中是否有 `"fastSwitch"` tag，这不完整
2. `2.0` 和 `1.5` 是魔法数字，没有物理意义
3. 无法区分"快速切一个残血角色"和"快速切满血角色触发反应"——价值差异巨大
4. 对手召唤伤害、元素附着风险等完全没有建模

---

## 3. 方案：状态驱动的时序价值计算

### 3.1 核心思想

**用 state 的属性计算 declareEnd 和快速行动的价值，而不是搜索。**

时序价值 = f(gameState, perspective) 是一个纯函数：

```
initiativeValue = 
  + summonPressure(perspective)           // 我方召唤回合开始伤害
  - summonPressure(opponent)              // 对方召唤伤害威胁
  + fastActionAdvantage(perspective)      // 快速行动能力优势
  + elementPersistenceValue(perspective)  // 元素附着+反应潜力
  + resourceBluffValue(perspective)       // 骰子差值的博弈价值
  - lethalRisk(perspective)              // 被斩杀风险（高惩罚）
```

每项都可以从 `GameState` 计算，O(1) 时间。

### 3.2 各分量计算方法

#### (a) 召唤压力 summonPressure(who)
```typescript
// 计算 who 的召唤物将在回合开始时造成的总伤害
function summonPressure(state, who): number {
  const player = state.players[who];
  let pressure = 0;
  for (const summon of player.summons) {
    // 从 entity definition 查询 usage 和预估伤害
    // 每个 usage 代表一次触发机会
    const dmg = estimateSummonDamage(summon);
    pressure += dmg * summon.variables.usage;
  }
  // 也考虑 combat statuses（如激化领域）
  for (const status of player.combatStatuses) {
    pressure += estimateStatusDamage(status);
  }
  return pressure;
}
```

#### (b) 快速行动优势 fastActionAdvantage(who, opp)
```typescript
function fastActionAdvantage(state, who, opp): number {
  const myFastSwitches = countFastSwitchCapable(state, who);
  const oppFastSwitches = countFastSwitchCapable(state, opp);
  
  // 对手是否已 declareEnd？
  const oppEnded = state.players[opp].declaredEnd;
  
  if (oppEnded) {
    // 对手已结束 → 我必然先手 → 巨大优势
    return myFastSwitches > 0 ? 3.0 : 1.5;
  }
  
  // 对手未结束 → 如果我有快速行动而对手没有 → 优势
  if (myFastSwitches > oppFastSwitches) {
    return (myFastSwitches - oppFastSwitches) * 0.8;
  }
  
  return 0;
}
```

#### (c) 元素持久化价值 elementPersistenceValue(who, opp)
```typescript
function elementPersistenceValue(state, who, opp): number {
  // 对手活跃角色身上的元素 → 我下回合第一动可以触发反应
  const oppActive = getActiveCharacter(state, opp);
  const myBench = getBenchCharacters(state, who);
  
  let value = 0;
  for (const aura of oppActive.elementalAura) {
    // 检查我是否有 bench 角色可以触发反应
    for (const benchChar of myBench) {
      if (canTriggerReaction(benchChar.element, aura)) {
        value += estimateReactionDamage(aura, benchChar) * 0.5;
      }
    }
  }
  return value;
}
```

#### (d) 资源博弈价值 resourceBluffValue(who, opp)
```typescript
function resourceBluffValue(state, who, opp): number {
  const myDice = state.players[who].dice.length;
  const oppDice = state.players[opp].dice.length;
  const oppEnded = state.players[opp].declaredEnd;
  
  if (oppEnded) return 0; // 对手已结束，无博弈
  
  // 对手有骰子但我在逼他们消耗
  if (myDice <= 2 && oppDice >= 5) {
    return 1.0; // 我逼对手浪费骰子
  }
  if (myDice <= 3 && oppDice >= 3) {
    return 0.5;
  }
  return 0;
}
```

#### (e) 斩杀风险 lethalRisk(who, opp)
```typescript
function lethalRisk(state, who, opp): number {
  const oppActive = getActiveCharacter(state, opp);
  const myActive = getActiveCharacter(state, who);
  
  // 对手下一动是否能击杀我的活跃角色？
  const oppMaxDamage = estimateMaxSkillDamage(oppActive);
  const oppHasElement = hasElementalAura(myActive); // 有元素附着 → 反应增伤
  
  const adjustedDamage = oppHasElement ? oppMaxDamage * 1.5 : oppMaxDamage;
  
  if (adjustedDamage >= myActive.variables.health) {
    return -10.0; // 结束意味着送死——巨大负分
  }
  if (adjustedDamage >= myActive.variables.health * 0.7) {
    return -3.0; // 有重伤风险
  }
  return 0;
}
```

### 3.3 集成方式

**方案 A：注入到 gi-ml-policy.ts 评分管线**

```typescript
// gi-ml-policy.ts rankCandidateWithGiMl() 中：

// ── Tempo: initiative value (general, state-driven) ──
let tempoBonus = 0;
if (candidate.action_case === "declareEnd" && context?.observation) {
  tempoBonus = computeInitiativeValue(
    context.observation, 
    digest.self_side ?? 0
  );
} else if (candidate.action_type === "fast" && context?.observation) {
  // 快速行动本身就有抢夺先手的价值
  tempoBonus = computeFastActionTempoValue(
    context.observation,
    candidate,
    digest.self_side ?? 0
  );
}

finalScore = ... + tempoBonus;
```

**方案 B：喂入 GBDT 作为新特征**

将上述分量作为特征加入 GBDT 训练数据中，让模型自己学权重。

**推荐：方案 A 先落地（可控、可解释），后续将分量作为特征喂入 GBDT（方案 B）。**

### 3.4 不需要的：搜索深度和魔法数字

- ❌ `maxDepth=5` 对手回合模拟 → 去掉，回归 `maxDepth=2`
- ❌ `simulateOpponentTurn()` → 仅保留轻量 minimax 响应（现有逻辑）
- ❌ `expandCrossRoundInitiative()` → 去掉，由 `computeInitiativeValue` 替代
- ❌ magic `initiativeBonus = 2.0` → 由状态计算
- ❌ magic `crossRoundBonus = 1.5` → 由状态计算

保留的搜索：
- ✅ `maxDepth=2` 的我方行动 minimax（快速、稳定）
- ✅ `extendFastActions` 的快速行动链检测（但分值改为状态驱动）

---

## 4. 与现有系统的关系

### 4.1 与 MacroPlan / GamePlan 的协同

MacroPlan 的 `tempo_pressure` 模式描述了"需要抢节奏"的宏观意图。`computeInitiativeValue` 提供微观执行：

```
MacroPlan: tempo_pressure (宏观)
    ↓
computeInitiativeValue (微观): 量化具体行动的节奏价值
    ↓
finalScore: 宏观意图 + 微观估值 → 统一决策
```

### 4.2 与 OpponentModel 的协同

OpponentModel 估计对手 archetype。时序价值应根据对手风格调整：

- vs Aggro: declareEnd 风险更高（对手可能秒杀）→ lethalRisk 权重提升
- vs Control: declareEnd 价值更高（逼对手浪费骰子）→ resourceBluffValue 权重提升

### 4.3 与 ReactionChain 的协同

`elementPersistenceValue` 可以复用 ReactionChain templates 的反应伤害评估。

---

## 5. 实施计划

### Phase 1: 状态估值器（今天）
1. 创建 `src/runtime/policy/tempo-value.ts`
2. 实现 `computeInitiativeValue(state, perspective)` 
3. 实现 `computeFastActionTempoValue(state, action, perspective)`
4. 单元测试：用已知对局状态验证输出

### Phase 2: 集成到 GiMlPolicy（今天）
1. 在 `rankCandidateWithGiMl()` 增加 tempo 分支
2. 添加 `tempoValueWeight` 配置项（默认 1.0）
3. `declareEnd` candidate → computeInitiativeValue
4. `fast` action candidate → computeFastActionTempoValue

### Phase 3: 简化 BoundedSearcher（后续）
1. 回退 `maxDepth` 到 2
2. 移除 `simulateOpponentTurn` 深度模拟
3. 移除 magic `initiativeBonus`/`crossRoundBonus`
4. 保留 `expandCrossRoundInitiative` 但分值从状态计算

### Phase 4: 验证（后续）
1. Smoke test: 确认每局 ≤ 5s
2. MoYou 镜像 10 局验证 declareEnd 决策
3. 与 V5 baseline 对比 WR

---

## 6. 理论依据

时序策略在卡牌游戏 AI 中有成熟的理论框架：

| 概念 | 七圣对应 | 计算方式 |
|------|---------|---------|
| **Tempo** (节奏) | 快速行动链 + 抢先手 | fastActionAdvantage |
| **Initiative** (先手权) | declareEnd 博弈 | summonPressure + oppEnded |
| **Clock** (回合压力) | 召唤物倒计时 | summonPressure |
| **Bluff equity** (诈唬价值) | 逼对手消耗骰子 | resourceBluffValue |
| **Lethal respect** (斩杀回避) | 不结束如果会被杀 | lethalRisk |

七圣的独特之处在于"快速行动"可以不消耗回合交替权——这使抢先手博弈比一般 TCG 更复杂。
但正因如此，**状态估值（而非搜索）是最佳解**：时序价值是所有状态属性的函数，不是对手具体行动的函数。

---

## 7. 与搜索方案的本质区别

| 维度 | 搜索方案 (当前) | 状态估值方案 (提议) |
|------|----------------|-------------------|
| 通用性 | 限于搜索能覆盖的路径 | 全卡组通用 |
| 速度 | 30s/局 | 0s 额外开销 |
| 可解释性 | 路径评分，难解释 | 每项分量有语义 |
| 可优化性 | 改搜索参数 | 改权重，可学 |
| 完整性 | 覆盖搜索树内的路径 | 考虑所有状态属性 |
|| 对手建模 | 通过 OpponentModel 调权重 ||

---

## 参见

- **[temporal-opportunity-roadmap](temporal-opportunity-roadmap.md)** — 时序机会路线图：Temporal Opportunity 层设计及 Profile 生成
- **[temporal-reasoning-solution](temporal-reasoning-solution.md)** — 时序推理去 LLM 化方案：三层两引擎架构
- **[v25-mcts-long-horizon](v25-mcts-long-horizon.md)** — V25 MCTS 长 horizon 搜索实验
- **[v14-model-requirements](v14-model-requirements.md)** — V14 模型需求及特征设计
