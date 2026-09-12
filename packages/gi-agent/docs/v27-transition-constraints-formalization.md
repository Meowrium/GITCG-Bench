# V27 Transition-based 决策与隐藏约束形式化方案

> 日期: 2026-05-17  
> 输入: `v27-prompt-for-gpt.md`  
> 范围: `GiMlPolicy` 附加评分组件、transition delta、H1-H9 隐藏约束  
> 状态: 形式化设计稿，可拆成后续实现计划

## 1. 设计目标

V26 的结论是：继续堆叠 `score(action) = Σ w_i signal_i(action, state)` 的收益已经接近上限。V27 的目标不是推翻现有 ranker/value/self-play pipeline，而是在现有 `GiMlPolicy` 上增加一个可开关的 transition scoring component，使动作价值从“静态属性”转向“状态变化”。

核心定义：

```text
TransitionScore(S, a)
  = E[V(S') - V(S)]
  - Cost(S, a)
  - Risk(S, a)
  + ConstraintDelta(S, a)

where S' = T(S, a)
```

这里的 `ConstraintDelta` 由 H1-H9 九个隐藏约束组成。每个约束必须是可计算函数，而不是文字规则。

目标接入方式：

```text
finalScore(a)
  = existingScore(a)
  + transitionWeight * normalizedTransitionScore(S, a)
```

这样能保留当前 ranker、GBDT、macro plan、temporal opportunity、benchmark 和 self-play 闭环。

## 2. 记号

| 符号 | 含义 |
|---|---|
| `G` | 完整 `@gi-tcg/core` 引擎状态 |
| `O` | `ObservationV1`，当前可观测状态 |
| `A(S)` | 状态 `S` 下的合法候选动作集合 |
| `a` | 一个候选动作 |
| `S` | runtime transition state，完整状态的紧凑投影 |
| `T(S, a)` | transition 算子，返回后继投影状态 |
| `S'` | 动作 `a` 后的后继状态 |
| `V(S)` | value model 或 hybrid evaluator 对状态的价值估计 |
| `Q_R(S, a)` | 现有 ranker 对动作的相对偏好 |
| `C_k(S, a)` | 第 `k` 个隐藏约束的贡献 |
| `U(S, a)` | transition 估计的不确定性 |

价值统一使用己方视角：

```text
V(S) > 0  表示我方优势
V(S) < 0  表示对手优势
```

## 3. Transition State `S`

### 3.1 数学结构

定义：

```text
S = (
  R,
  P_self,
  P_opp,
  D_self,
  D_opp,
  H_self,
  H_opp_pub,
  B_self,
  B_opp,
  E,
  I,
  M,
  Omega
)
```

字段：

- `R`: 轮次、行动序号、当前行动者、先后手、双方是否 declareEnd。
- `P_self`, `P_opp`: 双方角色状态。
- `D_self`, `D_opp`: 骰子向量。
- `H_self`: 我方可见手牌。
- `H_opp_pub`: 对手公开手牌信息和估计摘要，不包含完整隐藏手牌。
- `B_self`, `B_opp`: 支援、召唤物、战斗状态、装备。
- `E`: 元素附着图。
- `I`: 行动权与 tempo 状态。
- `M`: deck/matchup/role profile。
- `Omega`: temporal option portfolio，包括 active/progressing/ready/blocked/available。

### 3.2 TypeScript 结构

```ts
interface TransitionState {
  point: RoundPointState
  self: PlayerTransitionState
  opponent: PlayerTransitionState
  aura: AuraState
  actionRights: ActionRightsState
  matchup: MatchupTransitionContext
  portfolio: {
    self: PortfolioSnapshot
    opponent: PortfolioSnapshot
  }
  hidden: HiddenInfoSummary
  source: {
    observationId: string
    projectionMode: "observation" | "engine_snapshot" | "replay"
    confidence: number
  }
}

interface PlayerTransitionState {
  activeIndex: number
  characters: CharacterTransitionState[]
  dice: DiceVectorByType
  hand: HandTransitionState
  supports: BoardEntityState[]
  summons: BoardEntityState[]
  combatStatuses: BoardEntityState[]
  declaredEnd: boolean
}

interface CharacterTransitionState {
  definitionId: number
  hp: number
  maxHp: number
  energy: number
  maxEnergy: number
  alive: boolean
  aura: ElementAura[]
  equipmentDefinitionIds: number[]
  role?: CharacterRole
}
```

### 3.3 紧凑性

`S` 不要求保存完整 engine closure，也不保存所有 private state。它只保留会影响短期 transition 和 value 的变量：

- 血量、充能、附着、装备。
- 骰子类型计数。
- 支援/召唤物 definition id、usage、变量。
- 手牌 definition id、tags、profile。
- 先后手和 declareEnd。
- deck role、matchup prior、option portfolio。

对 MCTS 来说，`S` 的 hash 应稳定且可缓存：

```text
hash(S) = hash(
  round, actor, turnIndex,
  self active/declared/dice/chars/entities/hand ids,
  opp active/declared/public chars/entities,
  portfolio summary,
  hidden summary version
)
```

## 4. 投影函数 `Pi(G, O) -> S`

定义：

```text
Pi: (GameState | null, ObservationV1, MatchupContext) -> TransitionState
```

投影分三档：

| 模式 | 来源 | 用途 | 置信度 |
|---|---|---|---|
| `engine_snapshot` | core `GameState` | benchmark/self-play/MCTS | 0.95-1.0 |
| `replay` | replay log entry | branch-eval/offline validation | 0.85-1.0 |
| `observation` | `ObservationV1` | runtime policy fallback | 0.6-0.9 |

原则：

1. 如果有 engine state，优先从 engine 投影。
2. 如果只有 observation，允许缺失隐藏信息，但要降低 confidence。
3. `S.source.confidence` 必须进入 transition score，低置信度 transition 不应压过硬斩杀或硬防守。

伪代码：

```ts
function projectTransitionState(input: ProjectionInput): TransitionState {
  const base = input.gameState
    ? projectFromEngine(input.gameState, input.side)
    : projectFromObservation(input.observation)

  const matchup = buildMatchupTransitionContext(input.deckContext)
  const selfPortfolio = buildPortfolioSnapshot(input.observation, input.candidates)
  const opponentPortfolio = buildOpponentPortfolio(input.observation, matchup)
  const actionRights = buildActionRightsState(input.observation)
  const hidden = estimateHiddenInfo(input.observation, matchup)

  return {
    ...base,
    matchup,
    portfolio: { self: selfPortfolio, opponent: opponentPortfolio },
    actionRights,
    hidden,
  }
}
```

复杂度：

```text
O(C + E + H + A)

C = 角色数，固定 6
E = 实体数，通常 < 20
H = 手牌数，通常 <= 10
A = 候选动作数，通常 10-60
```

## 5. Transition 算子 `T(S, a)`

### 5.1 定义

```text
T(S, a) = (S', m, q)
```

其中：

- `S'`: 后继状态投影。
- `m`: mutation summary，记录动作造成的核心变化。
- `q`: transition quality，表示 exact/estimated/fallback 和置信度。

```ts
interface TransitionResult {
  before: TransitionState
  action: PolicyCandidateAction
  after: TransitionState | null
  mutation: TransitionMutationSummary
  quality: TransitionQuality
  elapsedMs: number
  errors: string[]
}

interface TransitionQuality {
  mode: "engine_exact" | "micro_sim" | "profile_estimated" | "static_fallback"
  confidence: number
  keyFieldsExact: {
    hp: boolean
    energy: boolean
    aura: boolean
    dice: boolean
    board: boolean
    hand: boolean
  }
}
```

### 5.2 四级 transition

| 层级 | 名称 | 说明 | 目标开销 |
|---|---|---|---|
| L0 | static fallback | 不模拟，仅用 candidate preview 和 profile | < 0.1ms |
| L1 | profile estimated | 应用 temporal profile、dice、hand、slot delta | < 0.5ms |
| L2 | micro-sim | 只模拟血量、充能、附着、骰子、实体变量 | < 2ms |
| L3 | engine exact | clone/replay engine 后执行动作 | 2-10ms，可缓存 |

runtime 默认策略：

```text
if candidate is high-impact:
  use L2 or L3
else:
  use L1
```

high-impact 定义：

- 可能斩杀。
- burst。
- declareEnd。
- 元素调谐。
- 支援位满时 playCard support。
- 会改变 active character。
- 能 cash ready option。
- 对手存在 one-step cashout risk。

### 5.3 投影一致性

对 `S'` 的关键字段设置一致性要求：

| 字段 | 要求 |
|---|---|
| HP | L2/L3 必须精确或有误差界 |
| Energy | L2/L3 必须精确 |
| Aura | L2 允许近似，但必须标记 confidence |
| Dice | L1 以上必须精确扣除当前动作费用 |
| Hand | play/tuning 必须精确扣手牌，抽牌可用 placeholder |
| Board entities | support/summon 创建可用 profile，复杂变量需降置信度 |

transition 不能静默失败。失败时返回：

```ts
{
  after: null,
  quality: { mode: "static_fallback", confidence: 0 },
  errors: [...]
}
```

## 6. Transition Value `V_T(S, a)`

### 6.1 基本定义

```text
V_T(S, a) = E[V(S') - V(S)] - lambda_U * U(S, a)
```

`U(S, a)` 是不确定性惩罚：

```text
U(S, a) =
  (1 - transition_confidence)
  + value_model_uncertainty
  + hidden_info_variance
```

最终：

```text
TransitionDelta(S, a)
  = clip(V_T(S, a), -deltaMax, deltaMax)
```

### 6.2 `V(S)` 的组成

不要只依赖现有 GBDT value。建议使用 hybrid value：

```text
V(S) =
  w_model * V_model(phi(S))
  + w_portfolio * V_portfolio(S)
  + w_terminal * V_terminal(S)
  + w_constraints * V_constraints(S)
```

字段说明：

- `V_model(phi(S))`: 现有 GBDT/linear value model。
- `V_portfolio(S)`: temporal option 组合价值。
- `V_terminal(S)`: 斩杀/全灭/必败硬边界。
- `V_constraints(S)`: 行动权、骰子、附着、支援格等约束状态价值。

推荐初始权重：

```text
w_model = 0.55
w_portfolio = 0.20
w_terminal = 0.15
w_constraints = 0.10
```

这些权重必须通过 ablation benchmark 调整。

### 6.3 Value model 输入特征

现有 value model 可复用，但需要补充 transition-specific features：

```text
state:
  round, actor, first/second mover
  self/opp total hp, active hp, min hp
  self/opp energy online count
  self/opp dice vector
  self/opp support/summon pressure
  self/opp ready_to_cash option count
  self/opp one-step lethal availability
  aura window score
  hand retention value
  hidden risk summary
```

如果旧 artifact 缺字段：

```text
missing feature = 0
artifact_feature_schema != runtime_schema => lower confidence
```

### 6.4 置信区间

对每个 `V_T` 输出：

```text
mean = V(S') - V(S)
variance =
  sigma_model^2
  + sigma_transition^2
  + sigma_hidden^2
```

可用保守估计：

```text
lower = mean - z * sqrt(variance)
upper = mean + z * sqrt(variance)
```

默认 `z = 1.0`。在 critical defense/declareEnd 场景用 `z = 1.64`。

决策使用风险调整值：

```text
riskAdjustedDelta =
  if action is risky or irreversible:
    lower
  else:
    mean - riskAversion * sqrt(variance)
```

## 7. 与现有 ranker 融合

### 7.1 加权和不是唯一选择

基础形式：

```text
score_final(S, a)
  = score_existing(S, a)
  + w_T * normalize(V_T(S, a))
```

但这会让 transition delta 也变成另一个线性项。更好的做法是门控融合：

```text
score_final =
  score_existing
  + gate(S, a) * w_T * normalize(V_T)
```

gate 定义：

```text
gate(S, a) = max(
  lethal_gate,
  declare_end_gate,
  dice_bottleneck_gate,
  aura_window_gate,
  support_slot_gate,
  opponent_cashout_gate,
  tuning_gate
)
```

每个 gate 在 `[0, 1]`：

- 普通低风险动作 gate 小，避免 transition 噪声扰动所有排序。
- 高影响动作 gate 大，让 transition 真正参与。

### 7.2 硬约束优先

某些约束不应只是加减分：

```text
if action violates hard constraint:
  score_final = -Infinity or large negative
```

硬约束包括：

- 能立即斩杀却 declareEnd。
- R1/R2 有可用有效动作却无理由 declareEnd。
- 选择会导致己方核心角色立即被已知公开伤害击杀，且有安全替代。
- 元素调谐牺牲唯一 combo key，且没有解锁更高价值动作。

### 7.3 组件接口

```ts
interface TransitionScoringComponent {
  id: "transition_delta.v1"
  score(input: TransitionScoringInput): TransitionScoringOutput
}

interface TransitionScoringInput {
  state: TransitionState
  candidate: PolicyCandidateAction
  existingScore: number
  context: PolicyDecisionContext
  config: TransitionScoringConfig
}

interface TransitionScoringOutput {
  rawDelta: number
  normalizedDelta: number
  gate: number
  contribution: number
  confidence: number
  constraints: ConstraintContribution[]
  transition: TransitionResult | null
  reasons: string[]
}
```

### 7.4 接入伪代码

```ts
function rankCandidateWithTransition(ctx: RankContext): RankedPolicyCandidate {
  const existing = rankCandidateWithGiMlExisting(ctx)

  if (!ctx.options.transitionScoringEnabled) {
    return existing
  }

  const state = projectTransitionState({
    gameState: ctx.context.stateProvider?.() ?? null,
    observation: ctx.context.observation,
    deckContext: ctx.context.deckContext,
    candidates: ctx.digest.candidate_actions,
  })

  const transitionScore = transitionScorer.score({
    state,
    candidate: ctx.candidate,
    existingScore: existing.finalScore,
    context: ctx.context,
    config: ctx.options.transitionConfig,
  })

  return {
    ...existing,
    finalScore: existing.finalScore + transitionScore.contribution,
    reasons: [
      ...existing.reasons,
      ...transitionScore.reasons,
    ],
    breakdown: {
      ...existing.breakdown,
      transitionDelta: transitionScore.contribution,
    },
  }
}
```

## 8. 计算复杂度

设候选动作数为 `N`，手牌数 `H`，实体数 `E`，高影响动作数 `K`。

### 8.1 单候选

| 操作 | 复杂度 | 典型耗时 |
|---|---|---|
| static fallback | `O(1)` | < 0.1ms |
| profile transition | `O(H + E)` | 0.2-0.5ms |
| micro-sim | `O(E + C)` | 0.5-2ms |
| engine exact | engine dependent | 2-10ms |
| value eval GBDT | `O(trees * depth)` | 0.1-1ms |
| constraints H1-H9 | `O(N + H + E)` worst | 0.5-2ms |

### 8.2 每决策点

推荐预算：

```text
N = 20-60
K = 3-8 high-impact actions

total cost =
  project S once
  + N * L1
  + K * L2/L3
  + value batch eval
```

目标：

```text
普通 policy 决策: < 50ms
MCTS root prior: < 100ms
MCTS inner node: only L0/L1 or cached
```

关键优化：

- 对 `S` 和 `T(S,a)` 做 hash cache。
- 同一 decision point 批量计算 constraints。
- value model 批量预测。
- high-impact gate 控制 L2/L3 数量。
- MCTS 内层不跑完整 H1-H9，只跑 hard constraints + cheap deltas。

## 9. 可证伪实验

### 实验 A: Transition delta ablation

配置：

```text
A0: existing GiMlPolicy
A1: + transition delta, gate disabled, all actions applied
A2: + gated transition delta
A3: + gated transition delta + hard constraints
```

可证伪预言：

- 如果 transition framework 有效，A2/A3 在 hidden constraint counters 上应显著改善。
- A1 若全局 WR 下降，说明 transition 噪声大，需要 gate。
- A3 若 WR 提升但某些 matchup 退化，说明 hard constraint 过强或 deck role 错误。

### 实验 B: 合成状态单调性

构造状态对，只改变一个因素：

- 是否有 free window。
- 是否有关键同色骰。
- 是否有 aura window。
- 支援位是否满。
- 是否有 opponent one-step lethal。

预期：

```text
score_transition(correct_action) - score_transition(bad_action)
  > margin
```

每个 margin 初始取 `0.5`，后续按 score scale 校准。

### 实验 C: Branch-eval 验证

对被 transition component 翻转的 top-1 决策点抽样：

```text
old_top1 = existing policy top action
new_top1 = transition policy top action
```

跑 continuation：

```text
EV(new_top1) - EV(old_top1) > 0
```

可证伪预言：

- 如果小样本 branch-eval 中 new_top1 lift <= 0，则 transition scoring 方向不可信。
- 如果只在部分 deck 有 lift，说明需要 deck-conditioned weights。

## 10. H1-H9 约束总公式

定义总约束贡献：

```text
C(S, a) =
  α1 * C_action_rights(S, a)
  + α2 * C_dice(S, a)
  + α3 * C_aura(S, a)
  + α4 * C_slot(S, a)
  + α5 * C_role(S, a)
  + α6 * C_opp_threat(S, a)
  + α7 * C_round_tempo(S, a)
  + α8 * C_hand_retention(S, a)
  + α9 * C_hidden(S, a)
```

每个 `C_i` 输出：

```ts
interface ConstraintContribution {
  id: string
  raw: number
  confidence: number
  costMs: number
  hardViolation?: boolean
  reasons: string[]
}
```

用于 transition value：

```text
V_T(S, a)
  = V(S') - V(S)
  + C(S, a)
  - λU * U(S, a)
```

默认权重建议：

| 约束 | 初始权重 |
|---|---:|
| H1 action rights | 1.5 |
| H2 dice opportunity | 1.0 |
| H3 aura delta | 1.0 |
| H4 support slot | 0.8 |
| H5 role integrity | 0.7 |
| H6 opponent threat | 1.2 |
| H7 round tempo | 0.6 |
| H8 hand retention | 0.9 |
| H9 hidden risk | 0.5 |

这些权重只用于第一轮实现，必须通过 ablation 调整。

## 11. H1 行动权约束

### 数学定义

定义行动权状态：

```text
I(S) = (
  actor,
  selfEnded,
  oppEnded,
  selfUsefulActions,
  oppUsefulActions,
  firstMover,
  freeWindow
)
```

动作对行动权的影响：

```text
ActionRightsDelta(S, a)
  = FreeWindowValue(S, a)
  + InitiativeValue(S, a)
  - OpportunityLoss(S, a)
```

对 `declareEnd`：

```text
if a = declareEnd:
  OpportunityLoss =
    max_{b in A_useful(S)} Q_short(S, b) - Q_short(S, declareEnd)

  FreeWindowLoss =
    1[oppEnded = true] * max_{b in A_useful(S)} Q_short(S, b)

  CashoutGain =
    EndPhaseEV(S) + ReadyOptionCashEV(S)

  C_action_rights =
    CashoutGain
    - β1 * OpportunityLoss
    - β2 * FreeWindowLoss
    - β3 * OppContinuationRisk(S)
```

对非 declareEnd：

```text
C_action_rights(S, a)
  = UsefulActionValue(S, a) * RoundTempoMultiplier(S)
```

### 特征依赖

- `opponent.declared_end`
- `self.dice.total_count`
- legal candidates
- candidate preview value
- end phase summon/support damage
- readyToCash option count
- actor first/second mover

### 复杂度

```text
O(N)
```

每个决策点先计算一次 `max Q_short` 和 useful action set。

### 独立验证

可以独立验证。只需构造 declareEnd 成对状态。

### 优先级

P0。实现成本低，错误影响极高。

### 伪代码

```ts
function scoreActionRights(S: TransitionState, a: Action): ConstraintContribution {
  const useful = usefulActions(S)
  const bestUseful = maxBy(useful, b => shortActionValue(S, b))

  if (a.case !== "declareEnd") {
    return contribution("H1", shortActionValue(S, a) * roundTempo(S), ["useful_action"])
  }

  const opportunityLoss = Math.max(0, shortActionValue(S, bestUseful) - shortActionValue(S, a))
  const freeWindowLoss = S.opponent.declaredEnd ? shortActionValue(S, bestUseful) : 0
  const cashoutGain = endPhaseCashoutEV(S) + readyOptionCashEV(S)
  const oppRisk = opponentContinuationRisk(S)

  const raw = cashoutGain - 1.2 * opportunityLoss - 1.5 * freeWindowLoss - 1.0 * oppRisk
  return contribution("H1", raw, explainDeclareEnd(raw, opportunityLoss, freeWindowLoss, cashoutGain))
}
```

## 12. H2 骰子稀缺元素约束

### 数学定义

定义骰子向量：

```text
D = (d_cryo, d_hydro, d_pyro, d_electro, d_anemo, d_geo, d_dendro, d_omni)
```

动作消耗：

```text
cost(a) = (c_cryo, ..., c_omni)
```

未来动作集合价值：

```text
FutureActionValue(S, h)
  = Σ_{b in A_h(S)} P*(b | S, h) * max(0, Q_short(S, b))
```

其中 `h` 是 horizon，初始取 `h = 1` 或 `2`。

骰子机会成本：

```text
DiceOpportunityCost(S, a)
  = FutureActionValue(S, h; D)
  - FutureActionValue(T_D(S, a), h; D - cost(a))
```

如果不做完整枚举，可近似：

```text
DiceOpportunityCost(S, a)
  = Σ_e consumed_e(a)
      * Scarcity(e, S)
      * Demand(e, S)
      * Importance(e, S)
```

其中：

```text
Scarcity(e, S) = 1 / (1 + available_e + omni)
Demand(e, S) = count_future_high_value_actions_requiring_e
Importance(e, S) = max_future_value_requiring_e / max_future_value
```

### 特征依赖

- 当前骰子向量。
- 每个候选动作的 required cost。
- active character element。
- hand card costs。
- burst/skill readiness。
- next-round deck plan 或 static intent。

### 复杂度

精确一层：

```text
O(N * cost_check)
```

两层枚举：

```text
O(N * K)
```

其中 `K` 是保留的 high-value future actions，推荐 `K <= 8`。

### 独立验证

可以独立验证。只需比较消耗关键同色骰前后的 legal high-value actions。

### 优先级

P0。骰子是七圣召唤核心资源。

### 伪代码

```ts
function scoreDiceOpportunity(S: TransitionState, a: Action): ConstraintContribution {
  const before = topFutureActionValue(S, 1)
  const Sdice = applyDiceCostOnly(S, a)
  const after = topFutureActionValue(Sdice, 1)
  const loss = Math.max(0, before - after)
  const unlock = Math.max(0, after - before)
  return contribution("H2", unlock - loss, [
    `dice_unlock=${unlock.toFixed(2)}`,
    `dice_loss=${loss.toFixed(2)}`,
  ])
}
```

## 13. H3 元素附着债务约束

### 数学定义

定义 aura 图：

```text
E(S): character_id -> multiset<Element>
```

动作 aura transition：

```text
AuraDelta(S, a) = E(T(S, a)) - E(S)
```

反应窗口价值：

```text
ReactionWindowEV(S)
  = max_{line in ReactionLines(S)}
      P(line feasible | S) * DamageEV(line) * TimingFactor(line)
```

附着债务：

```text
AuraDebt(S, a)
  = ReactionWindowEV(S) - ReactionWindowEV(T(S, a))
```

附着收益：

```text
AuraSetupGain(S, a)
  = max(0, ReactionWindowEV(T(S, a)) - ReactionWindowEV(S))
```

当前兑现：

```text
AuraCashoutGain(S, a)
  = immediate_reaction_damage(a, S)
    + reaction_side_effect_value(a, S)
```

约束贡献：

```text
C_aura = AuraCashoutGain + AuraSetupGain - AuraDebt - OppAuraGiftRisk
```

### 特征依赖

- 当前双方角色 aura。
- candidate apply element。
- reaction preview。
- self/opponent next high-value elemental skills。
- active/bench character elements。

### 复杂度

```text
O(R)
```

`R` 为候选 reaction lines 数，建议只保留 top 6。

### 独立验证

可以。构造只改变 aura 的状态对。

### 优先级

P0/P1。反应队高优先级，纯物理或岩队较低。

### 伪代码

```ts
function scoreAuraDelta(S: TransitionState, a: Action, S2: TransitionState): ConstraintContribution {
  const cashout = immediateReactionValue(S, a)
  const before = reactionWindowEV(S, "self")
  const after = reactionWindowEV(S2, "self")
  const oppBefore = reactionWindowEV(S, "opponent")
  const oppAfter = reactionWindowEV(S2, "opponent")

  const setupGain = Math.max(0, after - before)
  const debt = Math.max(0, before - after)
  const oppGift = Math.max(0, oppAfter - oppBefore)

  return contribution("H3", cashout + setupGain - debt - oppGift, [
    `aura_cashout=${cashout.toFixed(2)}`,
    `aura_setup=${setupGain.toFixed(2)}`,
    `aura_debt=${debt.toFixed(2)}`,
    `opp_aura_gift=${oppGift.toFixed(2)}`,
  ])
}
```

## 14. H4 支援/召唤位边际价值约束

### 数学定义

定义支援位集合：

```text
Slots(S) = {slot_1, ..., slot_4}
```

每个已占用 slot 有剩余价值：

```text
RetentionEV(slot_i, S)
  = RemainingPayoffEV(option_i, S)
    * TriggerProbability(option_i, S)
    * Confidence(option_i)
```

新支援价值：

```text
NewSupportEV(a, S)
  = ExpectedPayoffEV(profile(a), S)
    - DeployCost(a, S)
```

如果未满：

```text
SupportSlotValue(S, a) = NewSupportEV(a, S) * EmptySlotMultiplier(k)
```

其中 `k = used_slots`，`EmptySlotMultiplier(k)` 可取：

```text
k=0: 1.15
k=1: 1.0
k=2: 0.75
k=3: 0.45
```

如果已满：

```text
SupportSlotValue(S, a)
  = max_i (NewSupportEV(a, S) - RetentionEV(slot_i, S) - ReplacementPenalty)
```

### 特征依赖

- 支援/召唤物 slots。
- 每个实体 profile、usage、变量。
- support replacement legality。
- 当前 hand/candidate support profile。

### 复杂度

```text
O(4)
```

固定支援位数量。

### 独立验证

可以。支援位矩阵单元测试即可。

### 优先级

P0。能直接减少 support overplay。

### 伪代码

```ts
function scoreSupportSlot(S: TransitionState, a: Action): ConstraintContribution {
  if (!isSupportCard(a)) return zero("H4")

  const newEv = supportProfileEV(S, a) - deployCost(S, a)
  const used = S.self.supports.length

  if (used < 4) {
    const mult = [1.15, 1.0, 0.75, 0.45][used] ?? 0.45
    return contribution("H4", newEv * mult, [`support_empty_slot_mult=${mult}`])
  }

  const replace = minBy(S.self.supports, s => retentionEV(S, s))
  const replaceDelta = newEv - retentionEV(S, replace) - 0.25
  return contribution("H4", replaceDelta, [`support_replace_delta=${replaceDelta.toFixed(2)}`])
}
```

## 15. H5 角色功能完整性约束

### 数学定义

定义 deck role profile：

```text
RoleProfile(deck) = {
  role(c): CharacterRole,
  riskWeight(c): R+,
  cashoutImportance(c): R+,
  protectUntil(c): Condition
}
```

角色血量损失代价：

```text
HpLossCost(S, a)
  = Σ_c riskWeight(c) * max(0, hp_c(S) - hp_c(T(S,a))) / maxHp_c
```

核心暴露风险：

```text
ExposureRisk(S, a)
  = 1[target_after(a) is core]
    * P_opp_lethal(target_after | T(S,a))
    * cashoutImportance(target_after)
```

角色功能贡献：

```text
C_role = -HpLossCost - ExposureRisk + RoleAlignmentGain
```

`RoleAlignmentGain`：

- enabler 进场挂元素后切走，加分。
- core burst ready 且能兑现，加分。
- core burst ready 却切走，减分。
- 工具人低血但完成任务，风险权重下降。

### 特征依赖

- deck code / character ids。
- character HP、energy、active status。
- opponent one-step damage estimate。
- role profile。
- planned phase / deck intent。

### 复杂度

```text
O(C + N_opp)
```

`C = 3`，`N_opp` 是对手候选数或 top threats 数。

### 独立验证

部分独立。需要 role profile，可先手工给 8 套 benchmark deck 标注。

### 优先级

P1。对复杂卡组收益大，但依赖 role profile 质量。

### 伪代码

```ts
function scoreRoleIntegrity(S: TransitionState, a: Action, S2: TransitionState): ConstraintContribution {
  let cost = 0
  for (const c of S.self.characters) {
    const c2 = findChar(S2.self, c.definitionId)
    const role = S.matchup.roleProfile.self[c.definitionId]
    const hpLoss = Math.max(0, c.hp - c2.hp) / c.maxHp
    cost += role.riskWeight * hpLoss
  }

  const exposed = activeCharacter(S2.self)
  const role = S.matchup.roleProfile.self[exposed.definitionId]
  const exposure = opponentLethalProbability(S2, exposed) * role.cashoutImportance

  const alignment = roleAlignmentGain(S, a, S2)
  return contribution("H5", alignment - cost - exposure, [
    `role_cost=${cost.toFixed(2)}`,
    `exposure=${exposure.toFixed(2)}`,
  ])
}
```

## 16. H6 对手 cashout readiness 约束

### 数学定义

定义对手威胁向量：

```text
Threat(S) = (
  p_lethal_1,
  p_lethal_2,
  burst_damage_ev,
  reaction_cashout_ev,
  freeze_control_ev,
  end_phase_damage_ev,
  hidden_hand_threat
)
```

对手 cashout 风险：

```text
OpponentThreatEV(S)
  = θ · Threat(S)
```

我方动作后的风险变化：

```text
C_opp_threat(S, a)
  = OpponentThreatEV(S) - OpponentThreatEV(T(S, a))
```

如果动作导致对手威胁上升：

```text
C_opp_threat < 0
```

如果动作降低威胁，例如斩杀、冻结、切防御角色：

```text
C_opp_threat > 0
```

### 特征依赖

- 对手公开角色 HP/energy/aura。
- 对手骰子。
- 对手支援/召唤物 end phase damage。
- 对手可见/估计手牌。
- matchup archetype。

### 复杂度

一动威胁：

```text
O(N_opp)
```

两动威胁：

```text
O(K_opp^2)
```

推荐 `K_opp <= 6`。

### 独立验证

可以独立验证一动公开威胁。隐藏手牌部分需要统计模型。

### 优先级

P0/P1。对 declareEnd、防守、抢杀关键。

### 伪代码

```ts
function opponentThreatVector(S: TransitionState): ThreatVector {
  const actions = estimateOpponentLegalActions(S)
  const top = topK(actions, 6, a => opponentShortValue(S, a))
  return {
    pLethal1: any(top, a => isLethal(S, a)) ? 1 : 0,
    pLethal2: estimateTwoStepLethal(S, top),
    burstDamageEV: maxEV(top, a => burstDamage(S, a)),
    reactionCashoutEV: maxEV(top, a => reactionValue(S, a)),
    freezeControlEV: maxEV(top, a => freezeValue(S, a)),
    endPhaseDamageEV: endPhaseDamage(S.opponent),
    hiddenHandThreat: hiddenThreatEstimate(S),
  }
}

function scoreOpponentThreat(S: TransitionState, a: Action, S2: TransitionState): ConstraintContribution {
  const before = dot(THREAT_WEIGHTS, opponentThreatVector(S))
  const after = dot(THREAT_WEIGHTS, opponentThreatVector(S2))
  return contribution("H6", before - after, [`opp_threat_delta=${(before - after).toFixed(2)}`])
}
```

## 17. H7 先后手与轮次节奏约束

### 数学定义

定义 round tempo:

```text
Tempo(S) = (
  round,
  actorRole: first_mover | second_mover,
  actionCountSelf,
  actionCountOpp,
  oppEnded,
  selfEnded,
  remainingUsefulActionsSelf,
  remainingUsefulActionsOpp
)
```

节奏乘子：

```text
RoundTempoMultiplier(S, a)
  = base(round, actorRole)
    * urgency(S)
    * freeWindowFactor(S)
    * actionTypeFactor(a)
```

建议：

```text
base(R1, first_mover) = 1.25 for proactive skill
base(R1, second_mover) = 1.10 for response action
freeWindowFactor = 1.4 if oppEnded and a != declareEnd
```

约束贡献：

```text
C_round_tempo(S, a)
  = RoundTempoMultiplier(S, a) * TempoActionValue(S, a)
```

### 特征依赖

- round number。
- current turn / actor。
- action count in round。
- declaredEnd。
- candidate action case。

### 复杂度

```text
O(1)
```

### 独立验证

可以。构造先后手成对状态。

### 优先级

P1。应先与 H1 合并实现，避免重复 declareEnd 逻辑。

### 伪代码

```ts
function scoreRoundTempo(S: TransitionState, a: Action): ConstraintContribution {
  const mult = roundTempoMultiplier(S, a)
  const val = tempoActionValue(S, a)
  return contribution("H7", mult * val, [`round_tempo=${mult.toFixed(2)}`])
}
```

## 18. H8 手牌 option retention 约束

### 数学定义

每张手牌的保留价值：

```text
Retention(card, S)
  = CurrentPlayableEV(card, S)
  + FutureOptionEV(card, S)
  + SynergyProviderEV(card, S)
  - DuplicateDiscount(card, S)
```

元素调谐代价：

```text
TuningCost(S, a)
  = Retention(discarded_card(a), S)
```

调谐收益：

```text
TuningUnlockGain(S, a)
  = max_{b in A(T(S,a))}
      max(0, Q_short(T(S,a), b) - Q_short(S, b))
```

贡献：

```text
C_hand_retention(S, a)
  = TuningUnlockGain(S, a) - TuningCost(S, a)
```

对普通 playCard：

```text
C_hand_retention(S, a)
  = - FutureOptionEV(card(a), S)
```

如果该 card 当前就是要兑现的 option，则由 transition value 的 `V(S') - V(S)` 抵消。

### 特征依赖

- hand visible cards。
- card tags/profile。
- duplicate count。
- deck role/intent。
- candidate unlock after tuning。

### 复杂度

```text
O(H + N)
```

可预先为每张手牌计算 retention。

### 独立验证

可以。构造 tuning sacrifice matrix。

### 优先级

P0/P1。元素调谐是高频动作，错误成本大。

### 伪代码

```ts
function handRetentionValue(S: TransitionState, card: HandCard): number {
  return playableEV(S, card)
    + futureOptionEV(S, card)
    + synergyProviderEV(S, card)
    - duplicateDiscount(S, card)
}

function scoreHandRetention(S: TransitionState, a: Action, S2: TransitionState): ConstraintContribution {
  if (a.case !== "elementalTuning") return zero("H8")
  const card = tunedCard(a)
  const cost = handRetentionValue(S, card)
  const gain = tuningUnlockGain(S, a, S2)
  return contribution("H8", gain - cost, [
    `tuning_gain=${gain.toFixed(2)}`,
    `discard_retention=${cost.toFixed(2)}`,
  ])
}
```

## 19. H9 随机性与隐藏信息约束

### 数学定义

隐藏状态：

```text
Z = (opp_hand, self_deck_order, opp_deck_order, next_dice)
```

当前无法观测，只能维护分布：

```text
P(Z | history, deck_prior)
```

隐藏风险：

```text
HiddenInfoRisk(S, a)
  = E_Z[V(T(S_Z, a))]
    - ρ * Std_Z[V(T(S_Z, a))]
```

也可以输出区间：

```text
CI_hidden(S, a) = [lower, upper]
```

对于高风险动作，使用 lower bound：

```text
V_hidden_adjusted(S, a)
  = lower(CI_hidden)
```

对于普通动作，使用 mean：

```text
V_hidden_adjusted(S, a)
  = mean(CI_hidden)
```

### 特征依赖

- 对手已打出卡。
- 对手卡组 profile。
- 当前手牌数量。
- self deck remaining cards。
- dice reroll model。
- matchup history。

### 复杂度

精确采样：

```text
O(M * transition_cost)
```

推荐 runtime 只用摘要：

```text
O(1)
```

例如：

- `hidden_lethal_prob`
- `self_draw_combo_prob`
- `next_round_dice_fail_prob`

### 独立验证

部分独立。需要 replay 或 self-play 统计校准概率。

### 优先级

P2。它重要，但依赖数据统计，第一轮可以只做风险摘要。

### 伪代码

```ts
function scoreHiddenRisk(S: TransitionState, a: Action): ConstraintContribution {
  const hidden = S.hidden
  const riskPenalty =
    hidden.opponentHiddenLethalProb * riskExposure(S, a)
    + hidden.nextRoundDiceFailProb * planDependency(S, a)
    + hidden.selfComboMissingProb * greedySetupExposure(S, a)

  return contribution("H9", -riskPenalty, [`hidden_risk=${riskPenalty.toFixed(2)}`])
}
```

## 20. 约束优先级排序

按可实现性和预期收益综合排序：

| 排名 | 约束 | 优先级 | 理由 |
|---:|---|---|---|
| 1 | H1 行动权 | P0 | 易实现，直接修复 declareEnd 系统错误 |
| 2 | H2 骰子机会成本 | P0 | 高频资源决策，影响技能/调谐/支援 |
| 3 | H4 支援位边际价值 | P0 | 直接对应 support overplay |
| 4 | H8 手牌保留价值 | P0/P1 | 调谐高频，能解释 unlock 与牺牲成本 |
| 5 | H6 对手 cashout | P0/P1 | 影响防守、抢杀和 declareEnd |
| 6 | H3 元素附着债务 | P1 | 反应队关键，但需要 aura transition 校准 |
| 7 | H7 先后手节奏 | P1 | 应并入 H1 tempo state |
| 8 | H5 角色功能完整性 | P1 | 对复杂卡组重要，依赖 role profile |
| 9 | H9 隐藏信息 | P2 | 重要但需统计校准，先做摘要 |

## 21. 最小实现切片

第一轮不要一次实现 H1-H9。推荐最小切片：

```text
TransitionScorer V0:
  - Projection from ObservationV1
  - L1 profile transition
  - H1 ActionRights
  - H2 DiceOpportunity
  - H4 SupportSlot
  - H8 HandRetention for tuning
  - gated fusion into GiMlPolicy
```

该切片不需要 engine exact transition，也不需要新训练。

### 21.1 V0 接口

```ts
interface TransitionScorerV0Config {
  enabled: boolean
  weight: number
  maxContribution: number
  enabledConstraints: Array<"H1" | "H2" | "H4" | "H8">
}
```

### 21.2 V0 验收

- declareEnd 错误率下降。
- support overplay 下降。
- 元素调谐净 EV reason 可解释。
- 至少 10% 决策点 top-3 顺序变化。
- 小样本 benchmark 不低于 baseline 5 个百分点。

## 22. 后续训练接入

当 runtime V0 通过 benchmark 后，再把 transition features 导出到 RL dataset：

```text
candidate_numeric_slots:
  transition_delta_mean
  transition_delta_lower
  transition_confidence
  h1_action_rights
  h2_dice_opportunity
  h3_aura_delta
  h4_slot_value
  h5_role_integrity
  h6_opp_threat_delta
  h7_round_tempo
  h8_hand_retention
  h9_hidden_risk
```

训练目标：

- ranker 学会在不同 deck/matchup 中调节这些约束权重。
- value model 学会把 `S'` 的 portfolio/constraint 状态纳入局面价值。
- MCTS 使用 transition score 作为 root prior，inner node 只用 cheap constraints。

## 23. 最终可证伪标准

V27 方案成立需要同时满足：

1. 合成单元测试中，每个约束的方向性正确。
2. 被 transition scorer 翻转的 top-1 动作，在 branch-eval 中平均 lift > 0。
3. mirror WR 标准差下降，尤其是复杂卡组。
4. hidden constraint counters 改善，而不是只提升总 WR。
5. 对部分 matchup 无效时，reason 能解释是 role/profile/hidden estimate 错误，而不是黑箱分数变化。

如果只看到总 WR 小幅上升，但 declareEnd、support overplay、tuning sacrifice、aura debt counters 没有改善，则说明 transition component 只是另一个噪声权重，不应继续扩大。
