# Temporal Opportunity Roadmap

> **⚠️ 状态：部分过时** — V15 路线图。P0-1 Profile 生成和 P0-3 Portfolio 已有后续演进；P0-4 微模拟尚未完成。整体路线仍有参考价值。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

> 日期: 2026-05-02  
> 范围: `packages/gi-agent` 时序推理 / temporal option / option portfolio 后续工作  
> 关联文档: `docs/v5-temporal-reasoning-report.md`, `docs/combat-window-pipeline.md`, `docs/ai-improvement-plan.md`

## 1. 当前已落地

当前已经不再把 `cardPurposeAlignment` 作为单独的窄规则实现，而是落成第一版 `TemporalOpportunityModel`：

- `src/runtime/policy/temporal-opportunity.ts`
  - 评估延迟收益卡牌，例如立本、派蒙类 action/end phase 引擎。
  - 评估条件协同引擎，例如卯师傅需要 food、蒂玛乌斯需要 artifact。
  - 评估支援格压力和 delayed support 密度。
  - 在展开已经饱和时，给 `useSkill` / pivot / conversion 动作一个小额兑现奖励。
  - 协同检查同时看 observation 手牌和当前候选动作。
- `src/runtime/policy/gi-ml-policy.ts`
  - 新增 `temporalOpportunityWeight`。
  - 将 temporal score 作为独立可解释信号并入最终排序。
- `src/runtime/policy/temporal-opportunity.test.ts`
  - 直接读取 `packages/data/src/cards/support/ally.ts` 做数据源哨兵测试。
  - 覆盖立本、卯师傅、蒂玛乌斯、支援格拥挤、候选动作协同、展开饱和后转化。
- 验证状态
  - `bun test src/runtime/policy` 通过。
  - `bun run check` 通过。

这版仍然是一个可解释启发式层，不是完整的在线 option planner。下面是剩余待完成部分。

## 2. 总体目标

目标不是继续无限增加动作权重，而是把 AI 的决策核心迁移到这个结构：

```text
候选动作价值 =
  立即战斗收益
  + 它开启/推进/完成的 temporal options
  - 它占用的支援格、骰子、手牌、行动窗口
  - 对手在同一时间轴上抢先兑现的风险
```

最终在线决策应当先构建 `OptionPortfolio`，再对候选动作计算：

```text
DeltaPortfolioEV = PortfolioEV(state_after_action) - PortfolioEV(state)
```

现有 `TemporalOpportunityModel` 是这个方向的第一层近似。

## 3. P0 剩余工作

### P0-1: 从手工小表升级为可生成的卡牌时序 Profile

当前问题：

- `SUPPORT_SYNERGY_REQUIREMENTS` 仍是手工小表。
- 立本、卯师傅、蒂玛乌斯等已经校准，但无法覆盖所有 support/event/equipment。
- `triggerOn` 标签只能表达触发时机，不能表达触发条件、收益数量、持续时间、消耗变量。

目标产物：

```ts
interface TemporalCardProfile {
  definitionId: number
  optionKind: "deferred_bank" | "recurring_engine" | "conditional_engine" | "converter" | "burst_enabler" | "defense"
  triggerWindows: Array<"on_play" | "action_phase" | "end_phase" | "round_start" | "round_end" | "reactive">
  prerequisites: TemporalPrerequisite[]
  payoff: TemporalPayoffVector
  footprint: TemporalFootprint
  lifecycle: TemporalLifecycle
  confidence: "exact" | "source_parsed" | "sim_inferred" | "heuristic"
}
```

实施步骤：

1. 先新增 `src/knowledge/temporal-profiles/`。
2. 用 `packages/data/src` 源码解析 support cards 的常见 DSL：
   - `.on("playCard", (_, e) => e.hasCardTag("food"))`
   - `.on("deductAllDiceCard", (_, e) => e.hasCardTag("artifact"))`
   - `.on("endPhase").addVariable(...)`
   - `.on("actionPhase").generateDice(...)`
   - `.drawCards(n)`, `.generateDice(...)`, `.deductAllCost()`, `.heal(...)`, `.damage(...)`
3. 生成 `TemporalCardProfile` JSON artifact。
4. `TemporalOpportunityModel` 改为读取 profile，不再直接维护大 hard-coded 表。

验收标准：

- 支援牌 ally/location/item 三类至少 80% 能生成 profile。
- 立本、派蒙、蒂玛乌斯、瓦格纳、卯师傅、阿圆、常九爷 profile 与源码测试一致。
- 无 profile 的卡牌 graceful fallback 到现有 static tags。

### P0-2: Effect IR 或 source parser 的长期选择

当前问题：

- 编译后的 `SkillDefinition` 把效果放在 opaque closure 里，运行时不可内省。
- source parser 能快速推进，但会依赖 DSL 文本模式。
- 更干净的方案是 builder DSL 同步生成可序列化 Effect IR。

选项：

- 短期: source parser + micro-simulation 校准。
- 长期: 在 `@gi-tcg/core/builder` 里生成 Effect IR。

推荐路线：

1. 先做 source parser，保证两周内能扩大覆盖。
2. 并行设计 Effect IR schema，但不马上改 core builder。
3. 当 parser 规则超过 20 条或误报开始影响 benchmark，再迁移到 builder IR。

Effect IR 最小字段：

```ts
interface EffectIrNode {
  trigger: string
  condition?: {
    cardTag?: string
    skillType?: string
    diceCostAtLeast?: number
    variableAtLeast?: { name: string; value: number }
  }
  effects: Array<
    | { kind: "draw"; count: number; withTag?: string }
    | { kind: "generate_dice"; count: number; diceType: string }
    | { kind: "damage"; amount: number; element: string }
    | { kind: "heal"; amount: number }
    | { kind: "cost_reduction"; amount?: number; all?: boolean; tag?: string }
    | { kind: "variable_delta"; name: string; delta: number }
  >
}
```

验收标准：

- 任一 profile 都能说明来源：`exact_ir` / `source_parser` / `sim_inferred` / `manual_patch`。
- `temporal-opportunity.test.ts` 不再只测试少数 hard-coded ids，而是测试 profile artifact。

### P0-3: OptionPortfolio 在线评估器

当前问题：

- `TemporalOpportunityModel` 只给单个候选动作打分。
- 它没有维护“当前局面已有多少 option、哪些正在进行、哪些互斥”。
- 支援格密度只是局部近似，没有完整 portfolio EV。

目标产物：

```ts
interface TemporalOption {
  id: string
  sourceDefinitionId: number | null
  status: "available" | "active" | "progressing" | "ready_to_cash" | "expired"
  kind: TemporalCardProfile["optionKind"]
  expectedPayoff: TemporalPayoffVector
  remainingHorizon: number
  resourceFootprint: TemporalFootprint
  prerequisites: TemporalPrerequisite[]
  confidence: number
}

interface OptionPortfolio {
  active: TemporalOption[]
  available: TemporalOption[]
  readyToCash: TemporalOption[]
  blocked: TemporalOption[]
  aggregate: {
    setupSaturation: number
    delayedPayoffEV: number
    conversionEV: number
    supportSlotPressure: number
    diceBankPressure: number
  }
}
```

实施步骤：

1. 从 observation 的 supports/summons/status/hand/candidates 构建 portfolio。
2. 对每个候选动作估计 `PortfolioDelta`。
3. `scoreTemporalOpportunity` 改为薄封装：
   - `buildOptionPortfolio(...)`
   - `estimateCandidatePortfolioDelta(...)`
4. 将原因输出从单项规则改为 portfolio 解释：
   - `portfolio_setup_saturated`
   - `portfolio_cash_ready`
   - `portfolio_synergy_blocked`
   - `portfolio_slot_pressure`

验收标准：

- 在“已有 2-3 个 delayed support”局面，技能/反应动作自然高于继续铺无协同 support。
- 在“卯师傅 + food 候选”局面，卯师傅价值高于普通低收益支援。
- 在“蒂玛乌斯无 artifact”局面，蒂玛乌斯不被当作通用 delayed engine 高估。

### P0-4: 微模拟验证器

当前问题：

- source parser 或手工 profile 都可能和真实引擎偏离。
- 需要用本地模拟器对 profile 的关键声明做 spot check。

目标：

- 对每个 profile 生成 1-3 个最小 state。
- 执行动作或推进阶段，检查 exposed mutations 是否符合 profile。

示例：

- 立本：
  - endPhase 后 `collected` 增加。
  - actionPhase 满 3 后 draw 2 + generate 2 Omni + dispose。
- 卯师傅：
  - 打 food 后生成骰。
  - 非 food 不触发。
- 蒂玛乌斯：
  - artifact 候选可触发 cost reduction。

验收标准：

- profile artifact 附带 `validation_status`。
- 至少 P0 关键卡 20 张有 micro-sim 验证。

## 4. P1 剩余工作

### P1-1: 扩展卡牌覆盖

优先顺序：

1. Support cards
   - ally: 立本、派蒙、卯师傅、蒂玛乌斯、瓦格纳、阿圆、常九爷、凯瑟琳等。
   - location: 费用修正、抽牌、元素/反应相关场地。
   - item: 资源和行动密度类支援。
2. Event cards
   - food / resonance / dice fixing / draw / fast action / switch cards。
3. Equipment cards
   - weapon/artifact/talent 的 on-enter、cost reduction、damage modifier。
4. Summons and statuses
   - endPhase damage/heal。
   - usage/duration。
   - shield/damage modifier。
5. Character passives
   - 莫娜速切。
   - 虚影/泡影类威胁评估。
   - 复杂 stance/state machine 角色。

验收标准：

- 生成 profile 覆盖常用 benchmark deck 中 95% 被打出的牌。
- 未覆盖牌在 benchmark report 中列出 top misses。

### P1-2: 训练数据与特征导出

当前问题：

- temporal score 是 runtime hand-written signal。
- ranker/value 训练集还没有完整 temporal features。

待扩展字段：

- Observation:
  - `self_temporal_setup_saturation`
  - `self_ready_to_cash_option_count`
  - `self_blocked_synergy_option_count`
  - `opp_ready_to_cash_option_count`
  - `support_slot_pressure`
- Candidate:
  - `candidate_option_kind`
  - `candidate_temporal_horizon`
  - `candidate_prereq_satisfied`
  - `candidate_portfolio_delta_ev`
  - `candidate_cashout_alignment`

实施步骤：

1. 扩展 `learning/rl/types.ts`。
2. 扩展 `candidate-exporter.ts` / `observation-exporter.ts`。
3. 更新 branch-eval report slots。
4. 重训 ranker/value/Q。

验收标准：

- 新 artifact 版本号显式包含 temporal feature schema。
- 旧 artifact 缺字段时 runtime fallback 正常。

### P1-3: Option-guided search

当前问题：

- BoundedSearcher 仍以 action-level heuristic 排序。
- cross-round 搜索刚有基础参数，但没有 option-aware expansion。

目标：

- 搜索扩展时优先保留：
  - cash-ready option 的兑现动作。
  - 能完成关键 prerequisite 的动作。
  - 对手下一动高威胁时的防守/打断动作。

实施步骤：

1. 在 search node 上缓存 `OptionPortfolio`。
2. expansion scoring 加入 `PortfolioDelta`。
3. leaf value 加入 portfolio aggregate。
4. 对 declareEnd 增加跨回合 option 风险评估。

验收标准：

- 慢速镜像中，搜索线不再长时间只铺支援。
- 斩杀/冻结/反应窗口中，搜索能保留 2-4 步兑现线。

### P1-4: Combat Window 与 Temporal Option 合并

当前问题：

- CombatWindowLibrary 能召回类似窗口，但输出仍是 tag/action guidance。
- 它没有和 runtime portfolio 共享 option 表达。

目标：

- `combat_window_plan.nodes` 映射到 `TemporalOption` 或 `OptionTransition`。
- online selector 返回的不只是 prefer_tags，还应返回：
  - active option kind
  - expected cashout action
  - interrupt condition
  - fallback option

实施步骤：

1. 扩展 combat window analysis schema。
2. tree-validator 校验 option transition。
3. selector 输出 `OptionGuidance`。
4. `MacroPlan` 只保留粗相位，具体执行交给 option guidance。

验收标准：

- 同一 combat window 能解释“为何此时不再铺场而是打技能”。
- selector miss 时仍退回 heuristic portfolio。

### P1-5: 对手时序风险模型

当前问题：

- 当前 risk/opponent model 偏静态。
- 没有估计对手是否比我方更快完成 burst/freeze/lethal option。

待实现：

- 对手 `OptionPortfolio`。
- `OpponentCashoutRisk`：
  - 下一个行动能否斩杀。
  - 结束阶段召唤物/支援触发威胁。
  - 对手声明结束后我方是否有安全窗口。
- hidden hand estimate 与 archetype prior 结合。

验收标准：

- 莫娜虚影/泡影、召唤物 endPhase 伤害、对手 burst online 会影响我方是否抢先兑现或防守。

## 5. P2 剩余工作

### P2-1: 骰子资源建模

待完成：

- per-element dice embedding。
- 调谐目标元素选择。
- 调谐后 unlock potential。
- delayed dice bank 的 EV 与当前骰子浪费风险关联。

与 temporal option 的关系：

- 立本价值取决于回合末剩骰分布。
- 派蒙价值取决于后续 action phase 的高价值动作费用。
- 调谐牺牲牌要扣除被牺牲牌的 option retention value。

验收标准：

- 元素调谐不只因 `dice_fix` 加分，而是明确说明解锁了哪个 option/action。

### P2-2: MacroPlan 简化与动态参数

当前 `MacroPlan` 有用，但不应继续承担所有时序逻辑。

目标分工：

- MacroPlan: 粗粒度态势，例如 setup / convert / burst / stabilize。
- TemporalOption: 具体卡牌/技能/窗口的执行结构。
- Search: 在 action 层验证可行线。

待完成：

- `MacroPlan.remaining_actions` 由 portfolio 状态决定。
- `buildHeuristicMacroPlan` 使用 setup saturation、cashout readiness。
- 移除与 temporal model 重复的硬编码 phase heuristics。

### P2-3: Concept bottleneck window scope

待完成：

- `scope = "window"` 不再退化成 state。
- concept 支持 option-level 输入。
- 增加 concept 交互：
  - `burst_window_enable × dice_unlock`
  - `reaction_window_enable × aura_ready`
  - `deferred_engine × support_slot_pressure`

验收标准：

- concept 输出能解释一个 2-4 步窗口，而不只是单点 state/action。

### P2-4: Value/Q model temporal feature 重训

待完成：

- 更新数据集 schema。
- 重新导出 self-play / branch-eval 数据。
- 重训 GBDT ranker/value/Q。
- 做 artifact compatibility check。

验收标准：

- temporal features 在 feature importance 中有非零贡献。
- A/B benchmark 不低于当前 baseline。

## 6. P3 / 架构性工作

### P3-1: Builder Effect IR

长期目标：

- 在 `@gi-tcg/core/builder` 生成可序列化 IR。
- 数据包 build 时输出 profile artifact。
- gi-agent 不再解析 TS 源码。

风险：

- 影响 core/data 构建链。
- 需要确保不改变游戏规则执行语义。

触发条件：

- source parser 维护成本过高。
- 卡牌覆盖超过 100 张后误报/漏报开始影响 benchmark。

### P3-2: Artifact 与 runtime 包解耦

待完成：

- gi-agent 不再从 `gi-ml/src/...` 深路径 import。
- 增加 `@gi-tcg/ml-runtime` 或明确 runtime export。
- temporal profile artifact、ranker artifact、value artifact 做版本兼容检查。

### P3-3: 自动 benchmark gate

待完成：

- 每次 temporal profile 或 runtime scorer 改动后自动跑：
  - smoke benchmark。
  - 水巴 vs 水凝慢速镜像。
  - cross-deck benchmark。
  - old artifact compatibility。
- 输出按 matchup 的 delta。

建议 gate：

- 小样本 smoke 不低于 baseline 48%。
- cross-deck 至少不显著低于当前 v5。
- 慢速镜像平均回合数下降或无明显上升。

## 7. 推荐实施顺序

### 第一阶段: Profile 生成和覆盖

1. 新建 `knowledge/temporal-profiles`。
2. 实现 support ally parser。
3. 用哨兵测试覆盖 10 张关键支援。
4. 替换 `SUPPORT_SYNERGY_REQUIREMENTS`。

完成标准：

- 不改变 runtime 策略结果也可以，先让 profile artifact 可生成、可校验。

### 第二阶段: Portfolio 在线建模

1. 实现 `buildOptionPortfolio`。
2. 从 observation + candidates 构建 active/available/blocked/ready options。
3. 将现有 `scoreTemporalOpportunity` 改为 portfolio delta。
4. 加慢速镜像回归测试。

完成标准：

- 能解释“停止铺场并开始技能兑现”。

### 第三阶段: 搜索与训练接入

1. BoundedSearcher 读取 portfolio delta。
2. RL export 增加 temporal features。
3. branch-eval report slots 增加 temporal slots。
4. 重训 ranker/value/Q。

完成标准：

- temporal signal 从手写 runtime heuristic 变成模型可学习特征。

### 第四阶段: Builder IR

1. 设计 Effect IR。
2. 在少数 builder DSL 方法上试点。
3. data build 输出 profile。
4. source parser 退为 fallback。

完成标准：

- 新卡牌可以自动进入 temporal profile，不需要手工加 id 表。

## 8. 风险与注意事项

- 不要让 temporal score 权重过高。它应该修正“时序机会成本”，不应该压过明确斩杀和生存线。
- profile 置信度必须进入评分。source parsed / sim inferred / heuristic 的权重不同。
- benchmark 必须按 matchup 拆分。慢速镜像改善可能牺牲爆发卡组开局，不应只看全局均值。
- 不要把 LLM 输出当 runtime 真值。LLM 适合离线归纳 schema 和失败分析，runtime 必须依赖模拟器、profile、branch-eval、训练 artifact。
- 文档中的 hard-coded card ids 只应用于校准和测试，最终应由 profile artifact 替代。

## 9. 当前剩余清单总览

| 优先级 | 工作项 | 当前状态 | 主要文件/目录 |
|--------|--------|----------|---------------|
| P0 | TemporalCardProfile 生成 | 未开始 | `src/knowledge/temporal-profiles/` |
| P0 | source parser 覆盖 support DSL | 未开始 | 同上 |
| P0 | Effect IR schema 设计 | 未开始 | `packages/core/src/builder/` 或新文档 |
| P0 | OptionPortfolio 在线模型 | 未开始 | `src/runtime/policy/temporal-opportunity.ts` |
| P0 | micro-simulation profile 验证 | 未开始 | `src/knowledge/temporal-profiles/` |
| P1 | 扩展 support/event/equipment/summon 覆盖 | 未开始 | `packages/data/src/cards/**` |
| P1 | temporal features 导出到 RL 数据 | 未开始 | `src/learning/rl/` |
| P1 | option-guided search | 未开始 | `src/runtime/search/bounded-searcher.ts` |
| P1 | CombatWindow 与 option schema 合并 | 未开始 | `src/learning/combat-windows/` |
| P1 | 对手 OptionPortfolio / cashout risk | 未开始 | `src/runtime/policy/opponent-model.ts`, `risk-model.ts` |
| P2 | 骰子资源/调谐 unlock 建模 | 部分已有 followup heuristic | `gi-ml-policy.ts`, `baseline-policy.ts` |
| P2 | MacroPlan 简化和动态参数 | 部分已有 | `macro-plan.ts` |
| P2 | concept window scope | 未开始 | `gi-ml/src/runtime/concept-model.ts` |
| P2 | temporal feature 重训 | 未开始 | `gi-ml`, `src/learning/rl/` |
| P3 | Builder Effect IR | 未开始 | `packages/core/src/builder/` |
| P3 | runtime/artifact 包解耦 | 未开始 | `gi-ml`, `gi-agent` |
| P3 | 自动 benchmark gate | 部分脚本已有 | `src/evaluation/benchmark/`, scripts |

---

## 参见

- **[tempo-reasoning-analysis](tempo-reasoning-analysis.md)** — 时序推理分析：从搜索瓶颈到状态估值
- **[combat-window-pipeline](combat-window-pipeline.md)** — Combat Window 流水线设计
- **[v14-model-requirements](v14-model-requirements.md)** — V14 模型需求及特征设计
- **[v25-implicit-matchup-encoding](v25-implicit-matchup-encoding.md)** — V25 隐式卡组编码实验

