# V26 七圣召唤 AI 架构改进建议

> 日期: 2026-05-16  
> 范围: `packages/gi-agent`, `packages/gi-ml`  
> 状态: 设计评审建议  
> 关联文档: `v14-model-requirements.md`, `v15-agent-ml-code-review-and-improvement-plan.md`, `v25-mcts-long-horizon.md`, `v25-implicit-matchup-encoding.md`, `temporal-opportunity-roadmap.md`

## 1. 背景

当前 `gi-agent` 已经从早期的 LLM battle graph 实验，演进为以本地 policy、benchmark、self-play、ranker/value 训练为主的实验包。这个方向是正确的：LLM 适合做离线分析和窗口归纳，不适合成为 runtime 真值。

本次评审基于 `packages/gi-agent/docs.bak` 下的理论文档，并抽样检查了当前源码。需要注意：`packages/gi-agent/docs` 当前是一个不可遍历的 reparse point，因此本文写入 `docs.bak`。

当前已有明显进展：

- temporal profile artifact 已存在，运行时不再直接从 `packages/data/src` 读取 profile。
- `PortfolioSnapshot` 已开始读取实体变量，并把 option 分成 active、progressing、readyToCash、available、blocked。
- reward contract 已升级到 `reward.v3`，相关导出和训练协议测试通过。
- `gi-agent` 已通过公开 `@gi-tcg/ml/*` exports 使用 runtime/ranker/value 类型，不再是 `../../../../gi-ml/src` 深路径导入。
- `gi-ml` 的 concept scope 已把旧的 `window` 语义改名为 `aggregate_candidate`，避免误称为真实窗口模型。

但这些改动仍未解决最关键的决策瓶颈：

1. deck/matchup 先验没有真正参与动作排序。
2. MCTS 仍依赖轻量快照模拟，无法可信处理复杂卡牌、费用、元素附着和跨回合状态。
3. temporal option 仍是启发式 delta，不是严格的 `EV(state_after) - EV(state_before)`。
4. combat window、macro plan、temporal portfolio、ranker/value 仍是多套并列信号，缺少统一 transition contract。
5. 训练和 runtime 合约边界仍不干净，`gi-ml` 仍依赖 `@gi-tcg/agent` 的 RL 类型。

## 2. 总体判断

不要继续把主要精力放在 `finalScore = signal1 + signal2 + ...` 上。线性叠加已经足够表达许多局部启发，但它不能解决七圣召唤的主要困难：

- 一步动作的价值高度依赖后续窗口。
- 同一动作在不同卡组中语义不同。
- declareEnd、元素调谐、切人、支援铺场都带有强约束，不是普通动作。
- 支援格、骰子元素、行动权和元素附着的机会成本常常大于即时收益。

推荐把主架构收敛成：

```text
ObservationV1
  -> CandidateSemanticDigest
  -> Deck/Matchup Context
  -> PortfolioSnapshot(before)
  -> CandidateTransitionEstimate
  -> PortfolioSnapshot(after)
  -> Window/Intent Guidance
  -> Search/Continuation
  -> Ranker/Value fusion
  -> Action selection + explanation
```

所有 runtime 信号应尽量回到同一个问题：

```text
这个动作使当前局面进入了哪个更好的可验证后继状态？
```

## 3. 优先级总览

| 优先级 | 项目 | 建议 |
|---|---|---|
| P0 | Deck/matchup 条件化 | 重写当前 prior 注入方式，改为动作条件化或 artifact router |
| P0 | MCTS adapter | 重写为真实 engine continuation 优先，轻量模拟只保留为 fallback |
| P0 | Temporal transition | 将 `PortfolioSnapshot` 升级为真实 before/after delta |
| P1 | Window/intent 模型 | 用 combat-window/静态 intent 形成序列级 guidance，不再用平均 candidate 概念替代 |
| P1 | Contract boundary | 把 RL dataset/model contracts 从 `gi-agent` 挪到共享包或 `@gi-tcg/ml/contracts` |
| P1 | Benchmark gate | 每次策略改动必须输出 matchup 拆分和行为统计 |
| P2 | Effect IR | 从 source parser 迁到 builder-level serializable IR |

## 4. P0-1: 重写 deck/matchup prior 注入

### 当前问题

`EvaluatorPolicy` 当前计算 prior 的方式是：

```text
finalScore = baseline + learnedContribution + priorBaseScore * priorScoreScale
```

`priorBaseScore` 只由当前 self deck、opponent deck、matchup 特征决定，不看 candidate。也就是说，在一个决策点内所有候选动作会加上同一个常数。这个常数对排序没有影响。

结果：

- prior matrix benchmark 看起来有开关，但动作选择基本不受影响。
- V25 文档指出 unified model 无法隐式理解卡组策略差异，但现有 prior 还没有真正提供“该卡组此时应该偏好什么动作”的信息。
- per-deck 调优只能靠独立 artifact，而不能通过统一模型里的条件化特征表达。

### 建议重写

把 prior 从 side-level bonus 改为 action-conditional bonus：

```ts
interface DeckActionPriorInput {
  selfDeck: DeckFeaturesV2
  opponentDeck: DeckFeaturesV2
  matchup: MatchupFeaturesV2
  candidate: PolicyCandidateAction
  observation: ObservationV1 | null
  portfolio: PortfolioSnapshot | null
}

interface DeckActionPriorOutput {
  score: number
  reasons: string[]
}
```

典型规则：

- selfDeck 是 support_engine 且当前支援格空、round <= 2：支援和抽牌动作加分。
- matchupPunishGreedySetupDelta 高且对手是快攻：延迟支援减分，useSkill、防守、治疗加分。
- selfRouteReaction 高：带元素附着、反应推进、扩散/冻结窗口的动作加分。
- selfRouteResource 高：立本、派蒙、骰子修正、元素调谐按 unlock potential 加分。
- opponentAntiSupport 高：继续铺支援减分。

### 推荐实现顺序

1. 新增 `runtime/policy/deck-action-prior.ts`。
2. 保留 `DeckPriorFeatureVector`，但不要直接作为 score 常数。
3. 在 `EvaluatorPolicy` 和 `GiMlPolicy` 中都接入 action prior。
4. benchmark 中保留 `priorMode`，但要求 prior 开关改变同一决策点内的 top-1 分布。

### 验收标准

- 在同一 digest 下，prior 开关导致至少 20% 决策点的 top-3 顺序变化。
- prior reason 必须能解释到动作层，例如 `matchup_punish_setup`, `route_reaction_skill`, `resource_route_dice_unlock`。
- 镜像对局 WR 标准差下降，而不是只提高全局均值。
- prior matrix 的 `none/prior` 差异不能只来自随机性。

## 5. P0-2: 重写 MCTS adapter

### 当前问题

`MctsEngine` 本身是一个可用骨架，但当前 runtime adapter 有三个严重问题。

第一，轻量模拟不可信。`state-snapshot.ts` 用手写逻辑近似技能、反应和卡牌效果。复杂角色、召唤物、支援、状态、装备、附着顺序、被动技能都难以覆盖。

第二，action generator 在树内复用根节点候选。树节点状态变化后，合法动作集合应该重新从引擎状态产生，而不是继续用根候选改造。

第三，`GiMlMctsPolicy` 的 `useValueModelPrior` 分支先构造空 `parentDecision`，随后遇到 `ranked.length <= 1` 会早退，导致这个模式可能无法实际搜索。

### 建议重写

MCTS 不应该继续扩展轻量 simulator。建议改成两层 continuation：

```text
Fast path:
  engine clone / replay state
  apply candidate
  ask engine for next observation/candidates
  cache state hash

Fallback path:
  lightweight snapshot simulator
  only用于 smoke / no-engine 环境
```

新的 MCTS adapter 应显式区分：

- `SearchState`: 可由 core engine 恢复或推进的状态。
- `SearchAction`: 与原始 candidate/action id 可逆绑定。
- `SearchTransition`: 包含 legality、mutation digest、next observation、terminal、error。
- `LeafEvaluator`: value artifact + portfolio EV + hard constraints。

### Progressive widening

由于真实 engine continuation 变慢，必须用 action grouping 降低分支：

```text
候选动作
  -> hard constraints 过滤
  -> action semantic group
  -> representative sample
  -> progressive widening
  -> engine continuation
```

分组不应手写成固定 `setup/pressure/burst/save`。推荐从 deck-specific intent 和 candidate semantic tags 生成：

- lethal / kill line
- reaction enable / reaction cash
- energy build / burst cash
- support setup
- dice unlock / tuning
- defensive stabilize
- switch / pivot
- pass / declareEnd

### 验收标准

- 搜索树内每个节点的候选动作来自该节点状态，而不是根候选。
- 轻量 simulator 与真实 engine 对同一 sentinel action 的 mutation diff 一致率可报告。
- MCTS search report 输出：expanded nodes、engine transition cache hit、illegal transitions、top line。
- 在 2-4 步斩杀、冻结、burst cashout 的合成局面中，MCTS 能保留正确线。

## 6. P0-3: Temporal portfolio 改为真实 transition delta

### 当前状态

`PortfolioSnapshot` 已经优于早期 `TemporalOpportunityModel`：

- 能读取支援实体变量。
- 能把 option 分类为 progressing 和 readyToCash。
- 能计算 slotPressure、expectedFutureValue、deferredCount。
- `scoreTemporalOpportunity` 已经通过 snapshot cache 调用 `estimatePortfolioTransition`。

这部分应继续推进，而不是回退到旧的单动作规则。

### 剩余问题

当前 transition 仍主要按 candidate 类型和 profile payoff 加减分。例如部署支援时按 `optionEV * 0.3` 加分，declareEnd 对 ready/progressing option 做固定惩罚。它还不是：

```text
PortfolioEV(after applying action) - PortfolioEV(before)
```

因此会有这些盲点：

- 支援被替换时的真实损失没有精确计算。
- 立本这类变量阈值只在 observation 已暴露变量时可靠。
- 元素调谐牺牲手牌的 option retention value 未进入成本。
- declareEnd 对 end phase、round start、先后手、对手 cashout 的影响仍不足。

### 建议重写

拆成三个明确模块：

```text
portfolio-snapshot.ts
  只负责从 ObservationV1 提取当前 option 状态

portfolio-transition.ts
  负责用 engine/micro-sim 估计 action 后的 snapshot

portfolio-evaluator.ts
  负责 PortfolioEV 和 delta explanation
```

接口建议：

```ts
interface PortfolioTransitionResult {
  before: PortfolioSnapshot
  after: PortfolioSnapshot | null
  deltaEV: number
  legality: "exact" | "estimated" | "fallback"
  resourceCost: ResourceCost
  lostOptions: TemporalOptionInstance[]
  advancedOptions: TemporalOptionInstance[]
  createdOptions: TemporalOptionInstance[]
  cashedOptions: TemporalOptionInstance[]
  risks: PortfolioRiskBreakdown
  reasons: string[]
}
```

### 验收标准

- 立本、派蒙、卯师傅、蒂玛乌斯、瓦格纳、阿圆、常九爷有 exact sentinel tests。
- declareEnd 至少覆盖：安全结束、浪费现金流、给对手斩杀窗口、end phase cashout。
- 每次 temporal 加分都能输出 before EV、after EV、delta EV。
- profile confidence 进入 EV 折扣，`source_parsed` 不应等价于 `exact_ir`。

## 7. P1-1: 建立真正的 window/intent 模型

### 当前状态

`gi-ml` 已把旧 `window` scope 改名为 `aggregate_candidate`。这比误用 window 更准确，但它仍然只是候选集合上的概率聚合，不表达动作顺序。

combat-window pipeline 已经有窗口提取、LLM 分析、tree-lake、验证、replay 对齐、branch-eval 导入和 library 检索。这条线应该进入 runtime guidance，但不能直接当成真值。

### 建议统一表达

把 window 和 intent 都转成 `OptionTransition`：

```ts
interface RuntimeWindowLine {
  lineId: string
  horizon: number
  entryConditions: WindowEntryCondition[]
  requiredResources: ResourceCost
  requiredActiveCharacterId?: number
  steps: WindowStep[]
  expectedOutcome: WindowOutcome
  failureReasons: string[]
  evidence: {
    source: "combat_window" | "static_intent" | "branch_eval" | "self_play_cluster"
    confidence: number
  }
}
```

runtime 不要问“这个窗口概念概率是多少”，而要问：

```text
当前动作是否进入、推进、破坏或兑现某条 line？
```

### 推荐来源

- combat-window tree library: 提供真实对局中出现过的 2-4 动作窗口。
- static deck intent discovery: 从 deck code 和游戏规则枚举可行序列，聚类终态。
- branch-eval: 给窗口首步和 continuation 提供胜率证据。
- self-play cluster: 发现模型实际频繁进入但未被人工描述的路线。

### 验收标准

- 合成测试能区分“低即时收益但开启两步斩杀”和“高即时收益但破坏斩杀线”。
- window explanation 包含 line id、horizon、required dice、expected payoff、failure reason。
- selector miss 时必须记录缺失原因：deck mismatch、state mismatch、resource mismatch、low confidence。

## 8. P1-2: 清理 `gi-ml` / `gi-agent` contract boundary

### 当前问题

虽然 runtime import 已改用 `@gi-tcg/ml/*` public exports，但 `gi-ml` package 仍依赖 `@gi-tcg/agent`。多处 dataset、ranker streaming、CLI 直接 import `ObservationV1`、`RlDatasetV1` 等 agent 类型。

这会导致：

- 训练包和 runtime 包循环认知。
- 数据 contract 无法独立版本化。
- `gi-ml` 的测试和构建依赖 agent 内部演进。

### 建议

短期把 RL dataset contracts 移到 `@gi-tcg/ml/contracts`：

- `ObservationV1`
- `ActionV1`
- `DecisionPointV1`
- `RlDatasetV1`
- `RlDatasetShardV1`
- `RlDatasetManifestV1`
- reward/model artifact manifest

中期如果多个包都要用，再抽 `@gi-tcg/ai-contracts`。

### 验收标准

- `packages/gi-ml/package.json` 不再依赖 `@gi-tcg/agent`。
- `rg "@gi-tcg/agent" packages/gi-ml/src` 为空。
- `gi-agent` 可以依赖 `@gi-tcg/ml/contracts`，但 `gi-ml` 不依赖 `gi-agent`。
- dataset manifest 有 schema/reward/model/card pool 版本。

## 9. P1-3: Scoring component registry

`GiMlPolicy.rankCandidateWithGiMl` 仍包含大量硬编码 scoring component。当前已经有 `CandidateScoreBreakdown` 类型，但还没有组件 registry。

建议改为：

```ts
interface ScoringComponent {
  id: string
  enabled(ctx: ScoringContext): boolean
  score(ctx: ScoringContext): ScoringContribution
}

interface ScoringContribution {
  raw: number
  weight: number
  weighted: number
  reasons: string[]
  confidence?: number
}
```

好处：

- 每个信号可以单独测试。
- 可以在 benchmark report 里统计各信号对 top-1 的贡献。
- 可以做 plan-gated 或 deck-gated weight，而不把逻辑继续塞进单个函数。

验收标准：

- 每个 component 有独立测试。
- 决策日志能输出完整 breakdown。
- 可以通过配置关闭任意 component 进行 ablation benchmark。

## 10. P2: Builder Effect IR

source parser 已经能覆盖 support ally/item/place，并通过部分 sentinel tests。但长期仍不可靠：

- TS DSL 可以写任意 closure。
- regex/AST parser 难以理解条件、变量、分支和目标选择。
- profile confidence 很难提升到 exact。

建议设计 builder-level serializable Effect IR，让 `@gi-tcg/core/builder` 在构建卡牌数据时同步输出可解释效果。

最小 IR：

```ts
interface EffectIrNode {
  trigger: string
  condition?: EffectIrCondition
  effects: EffectIrMutation[]
  sourceDefinitionId: number
  sourceSkillId?: number
}
```

迁移策略：

1. source parser 继续服务当前 profile artifact。
2. 新 IR 只先覆盖常用 builder 方法：draw、generateDice、damage、heal、cost reduction、variable delta、dispose。
3. profile generator 优先读 IR，失败再 fallback 到 source parser。
4. benchmark report 输出 profile source 分布：exact_ir/source_parsed/sim_inferred/heuristic。

## 11. Benchmark gate

任何上述改动都不应只看总胜率。推荐最小 gate：

| 指标 | 目标 |
|---|---|
| overall WR | 不低于上一稳定 artifact 5 个百分点 |
| mirror WR stddev | deck-specific 改动后应下降 |
| R1 declareEnd with usable skill | < 5% |
| R1 skill usage | >= 60% 或按卡组策略解释 |
| support overplay ratio | 慢速镜像下降 |
| average useful dice spent R1/R2 | 上升或保持 |
| lethal miss count | 合成局面为 0 |
| profile coverage | 常用 benchmark 打出牌覆盖 >= 95% |
| temporal explanation coverage | top-1 有明确 reason 的比例 >= 90% |

推荐每次策略改动至少跑：

```bash
cd packages/gi-agent
pnpm test src/knowledge/temporal-profiles src/runtime/policy src/learning/rl
pnpm run benchmark benchmark.tempo-smoke.json
pnpm run benchmark examples/configs/benchmark.prior.batch.example.json --concurrency 4
```

如果改动 MCTS 或 continuation，还应跑：

```bash
cd packages/gi-agent
pnpm test src/mcts src/evaluation/branch-eval
```

## 12. 推荐实施顺序

1. 修复 docs 路径或把新文档正式迁回 `packages/gi-agent/docs`。
2. 重写 deck/matchup prior 为 action-conditional。
3. 给 `GiMlPolicy` 建 scoring component registry，并接入 prior ablation。
4. 将 temporal transition 拆成 snapshot/transition/evaluator。
5. 新建 MCTS engine-continuation adapter。
6. 把 combat-window/static intent 输出统一映射为 `RuntimeWindowLine`。
7. 清理 `gi-ml -> gi-agent` 依赖。
8. 设计 builder Effect IR，并逐步替换 source parser。

## 13. 不建议继续投入的方向

- 不建议继续给 `BaselinePolicy` 添加大量单点权重，除非它们是 hard constraint 或 benchmark counter 所需。
- 不建议把 `aggregate_candidate` 当成 window model 扩展。
- 不建议依赖 LLM runtime 决策。LLM 输出必须经过本地验证、branch-eval 或 profile/micro-sim 校准。
- 不建议用全局 WR 掩盖 matchup 退化。所有报告必须按 deck pair 拆分。
- 不建议用统一 ranker 期待隐式学会所有卡组策略。V25 mirror 分析已经反驳了这个假设。
