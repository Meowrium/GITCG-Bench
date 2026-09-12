# V26 隐藏约束假说与验证方案

> 日期: 2026-05-16  
> 范围: 七圣召唤 AI 决策约束、benchmark counters、可证伪实验  
> 状态: 实验设计  
> 关联文档: `v14-model-requirements.md`, `v25-implicit-matchup-encoding.md`, `v25-mcts-long-horizon.md`, `v26-ai-architecture-recommendations.md`

## 1. 目标

七圣召唤的很多关键决策不是普通的线性价值比较，而是受隐藏约束支配。这里的“隐藏”不是指规则不可见，而是指当前架构没有把这些约束作为一等公民表达。

本文把这些约束整理成可证伪假说，并给出验证方案。每个假说都应能回答：

- 它可能解释哪个失败模式？
- 当前架构为什么没有充分利用？
- 如何构造最小测试？
- 如何进入 benchmark counter？
- 若假说成立，应改哪个模块？

## 2. H1: 行动权与 declareEnd 约束

### 假说

`declareEnd` 不是普通动作。它改变后续行动权、免费行动窗口和下轮先手。当前如果只把它当作一个低收益动作，会低估以下情况：

- 对手已经结束，我方还有有效行动，declareEnd 等于放弃免费窗口。
- 我方先手且 R1/R2 有可用技能，declareEnd 等于放弃先手压制。
- 我方有 end phase cashout，declareEnd 可能是合理动作。
- 我方低骰且没有有效行动，declareEnd 是自然动作。

### 当前利用不足

已有 `declare-end-constraints.ts`，但主要用于 MCTS prior penalty。普通 `BaselinePolicy` 和 `GiMlPolicy` 仍有多套分散的 declareEnd 处理：baseline penalty、tempo bonus、temporal portfolio penalty、MCTS hard filter。它们没有共享同一个 action-rights contract。

### 验证实验

构造成对状态，只改变 `opponent_declared_end` 和剩余行动：

```text
S1: opp not ended, self 8 dice, usable skill
S2: opp ended, self 8 dice, same usable skill
S3: opp ended, self 1 dice, no meaningful action
S4: self has ready end-phase cashout, declareEnd triggers payoff
```

预期：

- S1/S2 中 declareEnd 不应高于任意有效攻击或关键 setup。
- S2 的非 end 动作相对 declareEnd 差距应大于 S1。
- S3 中 declareEnd 可以成为 top-1。
- S4 中 declareEnd 需要由 portfolio cashout 明确解释。

### Benchmark counter

新增 counters：

- `declare_end_when_skill_usable`
- `declare_end_after_opp_ended_with_action`
- `declare_end_with_ready_cashout`
- `declare_end_safe_no_action`
- `free_window_actions_taken`

### 架构建议

把 declareEnd 判断集中到 `ActionRightsEvaluator`：

```ts
interface ActionRightsEvaluation {
  declareEndClass:
    | "forbidden"
    | "bad_free_window_loss"
    | "bad_skill_opportunity_loss"
    | "neutral_no_action"
    | "good_cashout"
    | "good_initiative_lock"
  score: number
  reasons: string[]
}
```

所有 policy/search 只消费这个 evaluator，不再各自手写 declareEnd 规则。

## 3. H2: 骰子稀缺元素约束

### 假说

骰子的价值不是总数线性函数，而取决于后续动作集合。某一颗同色骰可能是后续 burst、元素战技、装备或反应线的唯一瓶颈。消耗这颗骰子的动作即使即时收益高，也可能破坏更高价值窗口。

### 当前利用不足

已有 `diceFitness`、`computeDiceQualityMetrics`、调谐 unlock potential，但它们多是当前动作可付费或调谐后可解锁动作的局部判断。缺少：

- 消耗后未来 legal action set 的变化。
- 元素类别的边际价值。
- 被元素调谐牺牲的手牌 option value。

### 验证实验

对每个候选动作计算：

```text
future_unlock_loss =
  high_value_actions_legal_before
  - high_value_actions_legal_after_action
```

构造状态：

- 3 个关键同色骰，1 个高价值 E/Q 可用。
- 一个低收益支援也需要同色/任意骰。
- 支援即时 score 高，但打出后 E/Q 不可用。

预期：

- 若消耗后破坏高价值技能，支援动作应明显降分。
- 元素调谐应说明“牺牲了哪张牌，解锁了哪个动作”。

### Benchmark counter

- `dice_unlock_gain`
- `dice_unlock_loss`
- `spent_reserved_element_dice`
- `tuning_card_option_loss`
- `post_action_legal_high_value_count`

### 架构建议

新增 `DiceOpportunityModel`：

```ts
interface DiceOpportunityDelta {
  unlockedActions: string[]
  lockedActions: string[]
  reservedDiceConsumed: Record<string, number>
  sacrificedCardOptionEV: number
  score: number
  reasons: string[]
}
```

它应接入 portfolio transition 和 search leaf，不应只是 baseline 权重。

## 4. H3: 元素附着债务约束

### 假说

造成伤害不总是正收益。错误的元素附着会破坏后续蒸发、融化、冻结、扩散或超载线。AI 需要知道当前动作是：

- 建立目标 aura。
- 消费目标 aura 兑现反应。
- 覆盖/清除关键 aura，破坏后续窗口。
- 给对手留下可利用 aura。

### 当前利用不足

`reaction_value` 和 `reactionChainPrior` 能奖励当前反应，但对“破坏下一步反应”的负价值建模不足。MCTS 轻量模拟也只用简化反应表，难以可靠判断 aura transition。

### 验证实验

构造成对状态：

```text
S1: opp active has Cryo, self Pyro skill can Melt
S2: same HP/dice, but previous action applies Hydro and removes/changes aura
S3: same immediate damage, but preserves Cryo for next Pyro burst
```

预期：

- 触发高价值反应的动作优先。
- 若一个动作破坏下一步 burst reaction，除非它立即斩杀，否则应降分。

### Benchmark counter

- `reaction_cashout_count`
- `reaction_setup_count`
- `reaction_window_broken`
- `aura_overwrite_without_payoff`
- `opponent_reaction_enabled_by_self`

### 架构建议

把 aura transition 放入 `CandidateTransitionEstimate`：

```ts
interface AuraTransitionDelta {
  selfSetupGain: number
  selfCashoutGain: number
  selfWindowLoss: number
  opponentWindowGain: number
  consumedAura: string[]
  appliedAura: string[]
}
```

如果没有 engine continuation，至少用 branch-eval 或 exact reaction templates 校准。

## 5. H4: 支援/召唤位边际价值约束

### 假说

支援格和召唤物格不是简单容量。第 1 个支援、第 3 个支援、第 4 个支援、替换支援的边际价值完全不同。支援满时，打新支援不是“创建实体”，而是“替换现有 option”。

### 当前利用不足

`PortfolioSnapshot` 有 `slotPressure` 和 `deferredCount`，但还没有精确比较：

```text
new_support_EV - replaced_support_retention_EV
```

也没有明确处理“多个 delayed support 竞争相同兑现窗口”的情况。

### 验证实验

构造同一手牌与骰子，改变场上支援：

```text
S1: 0 support
S2: 2 delayed supports
S3: 3 supports, one low EV
S4: 4 supports, all high EV
```

候选动作是打一个支援和使用技能。

预期：

- S1 支援可加分。
- S2/S3 支援加分下降，技能兑现上升。
- S4 只有新支援 EV 明显高于被替换支援时才允许。

### Benchmark counter

- `support_slot_pressure`
- `support_replacement_count`
- `support_replacement_ev_delta`
- `deferred_support_density`
- `support_overplay_before_first_skill`

### 架构建议

`PortfolioSnapshot` 中增加 support slot ownership：

```ts
interface SupportSlotState {
  slotsUsed: number
  optionsBySlot: TemporalOptionInstance[]
  replaceableOptions: Array<{
    option: TemporalOptionInstance
    retentionEV: number
  }>
}
```

`playCard support` transition 必须输出替换 EV delta。

## 6. H5: 角色功能完整性约束

### 假说

同样的 HP、能量和前后台位置，在不同角色功能上价值不同。核心输出、挂元素工具人、保护对象、残余角色的风险权重应不同。

### 当前利用不足

`BaselinePolicy` 已经有 `FunctionalTier` 和 collapse distance，但 `DECK_DEFAULT_ROLE_MAP` 为空，导致大多数角色默认 tactical。实际 deck-specific role 没有进入评分主链。

V25 mirror 结果说明模型对不同卡组的策略兼容性差异巨大，这很可能包含 role 识别失败。

### 验证实验

为 8 套 benchmark deck 手工或静态生成 role map：

```text
core_dps
core_burst
enabler
aura_applier
defensive_anchor
flex
```

做 A/B：

- A: 无 role map。
- B: role-aware collapse/risk/switch/burst protection。

预期：

- 神宵、水债等复杂卡组 mirror WR 向 50% 收敛。
- 核心角色无意义站场死亡下降。
- 保护核心导致的过度切人不能上升太多。

### Benchmark counter

- `core_exposed_under_lethal_risk`
- `core_burst_ready_switched_away`
- `enabler_killed_before_cashout`
- `dead_core_with_unused_burst`
- `switch_to_protected_character`

### 架构建议

role 不应硬编码在 `BaselinePolicy` 内。应生成 deck-level role profile：

```ts
interface DeckRoleProfile {
  deckFingerprint: string
  characters: Record<number, CharacterRole>
  planPhases: DeckPlanPhase[]
  confidence: "manual" | "static_analysis" | "self_play_inferred" | "llm_reviewed"
}
```

优先由 static deck analytics 生成，LLM 只做 review/label seed。

## 7. H6: 对手 cashout readiness 约束

### 假说

我方动作价值取决于对手下一动或下两动是否能兑现：

- 斩杀。
- burst。
- 冻结。
- 召唤物 end phase 伤害。
- 支援/装备引擎 cashout。

如果对手 cashout readiness 高，我方应抢先斩杀、防守、切人或打断，而不是继续铺场。

### 当前利用不足

`OpponentModel` 主要描述风格或 aggression，不是可执行的 opponent option portfolio。`risk-model` 和 `tempo-value` 有局部判断，但没有统一输出“对手下一窗口是什么”。

### 验证实验

对每个 observation 枚举对手公开可行候选的一动 continuation：

```text
opp_one_step_lethal
opp_one_step_burst
opp_end_phase_damage_lethal
opp_freeze_lock_available
```

再抽样做两动 continuation。

预期：

- 对手 one-step lethal 时，防守/斩杀/切人权重提高。
- 对手无有效 cashout 时，我方 setup 可更大胆。

### Benchmark counter

- `opp_one_step_lethal_available`
- `ignored_opp_one_step_lethal`
- `defended_opp_cashout`
- `raced_before_opp_cashout`
- `lost_to_known_end_phase_damage`

### 架构建议

新增 `OpponentPortfolio`，与 self portfolio 对称：

```ts
interface OpponentCashoutRisk {
  nextActionLethal: boolean
  nextActionExpectedDamage: number
  endPhaseExpectedDamage: number
  burstOnlineCharacters: number[]
  freezeOrControlRisk: number
  publicEvidence: string[]
  hiddenHandRisk: number
}
```

它应进入 declareEnd、useSkill、防守、切人的 scoring component。

## 8. H7: 先后手与轮次节奏约束

### 假说

同一动作在先手和后手价值不同。R1 先手攻击的作用不是即时伤害，而是迫使对手响应。后手则可以利用信息优势判断是否抢节奏或防守。

### 当前利用不足

已有 R1 行动下界和 first-move advantage 的理论要求，但 runtime 中先后手更多是散落在 tempo/declareEnd/MCTS prior。缺少统一 round tempo state。

### 验证实验

同一卡组同手牌，交换先后手：

```text
P0 R1: 8 dice, usable E
P1 R1: same state after opponent action
```

预期：

- P0 R1 技能/主动压制频率更高。
- P1 R1 如果对手已暴露低威胁，可以 setup；如果对手高威胁，应防守或抢反应。

### Benchmark counter

- `r1_p0_skill_rate`
- `r1_p1_response_skill_rate`
- `first_mover_declared_end_early`
- `second_mover_info_response`

### 架构建议

新增 `RoundTempoState`：

```ts
interface RoundTempoState {
  actorRoleThisRound: "first_mover" | "second_mover"
  opponentEnded: boolean
  freeWindowAvailable: boolean
  actionsTakenSelf: number
  actionsTakenOpponent: number
  expectedRemainingUsefulActions: number
}
```

它应被 declareEnd、tempo、MCTS prior 和 training feature 共用。

## 9. H8: 手牌 option retention 约束

### 假说

元素调谐和出牌都会消耗手牌，但不同手牌的机会成本不同。牺牲关键 talent、food、artifact、dice fixer、burst enabler 的成本不应一样。

### 当前利用不足

调谐有 unlock potential，但被调谐掉的卡牌当前更多只是 `handDelta = -1`。没有按该卡的 future option value 计损失。

### 验证实验

同一骰子状态，元素调谐候选分别牺牲：

- 低价值重复牌。
- 关键 talent。
- 当前 support prerequisite 的 food/artifact。
- 下一步 lethal 所需事件牌。

预期：

- 牺牲低价值牌可接受。
- 牺牲当前或下轮关键 option 应强烈降分。

### Benchmark counter

- `tuning_sacrificed_card_ev`
- `tuning_broke_synergy`
- `tuning_unlocked_action_ev`
- `net_tuning_ev`

### 架构建议

给 hand cards 建 option retention value：

```ts
interface HandCardOptionValue {
  definitionId: number
  currentPlayableEV: number
  futureOptionEV: number
  synergyProviderEV: number
  duplicateDiscount: number
  retentionEV: number
}
```

元素调谐 score 应使用：

```text
unlocked_action_EV - sacrificed_card_retention_EV
```

## 10. H9: 随机性与可观测信息约束

### 假说

七圣召唤有大量隐含不确定性：手牌、牌库、对手手牌、下轮骰子。当前模型容易把公开状态当成完整状态，导致：

- 低估对手隐藏手牌斩杀。
- 高估自己未抽到的 combo。
- 低估下轮骰子失败概率。

### 当前利用不足

已有 `hidden-info-estimator.ts`，但还没有成为 runtime scoring 的主约束。deck prior 也尚未条件化到对手可能手牌。

### 验证实验

基于 replay/self-play 统计：

- 对手某 archetype 在 R2/R3 持有关键牌概率。
- 我方下一轮获得关键元素骰概率。
- 当前手牌缺 combo piece 时，setup 是否仍值得。

预期：

- 对手高概率持有斩杀牌时，防守/抢杀上升。
- 我方 combo piece 未到手时，过早投入专用 setup 下降。

### Benchmark counter

- `hidden_lethal_risk_estimate`
- `combo_piece_missing_setup`
- `dice_fail_risk_for_plan`
- `draw_dependency_risk`

### 架构建议

把 hidden estimate 当成 uncertainty，不是确定加分：

```ts
interface HiddenInfoRisk {
  opponentThreatDistribution: Distribution<ThreatKind>
  selfDrawDependency: number
  nextRoundDiceFailureRisk: number
  confidence: number
}
```

在 policy 中使用风险区间，而不是单点期望。

## 11. 统一验证矩阵

| 假说 | 最小单元测试 | branch-eval | benchmark counter | 主要模块 |
|---|---|---|---|---|
| H1 行动权 | declareEnd 成对状态 | 是 | declareEnd/free window | ActionRightsEvaluator |
| H2 骰子稀缺 | legal action count delta | 是 | unlock/loss/reserved dice | DiceOpportunityModel |
| H3 元素债务 | aura 成对状态 | 是 | reaction broken/cashout | AuraTransitionDelta |
| H4 支援格 | support slot 状态矩阵 | 是 | replacement/overplay | PortfolioSnapshot |
| H5 角色功能 | role map A/B | 是 | core risk/death | DeckRoleProfile |
| H6 对手 cashout | opponent one-step enum | 是 | ignored lethal | OpponentPortfolio |
| H7 先后手 | P0/P1 R1 pair | 否 | first mover stats | RoundTempoState |
| H8 手牌保留 | tuning sacrifice matrix | 是 | net tuning EV | HandCardOptionValue |
| H9 隐藏信息 | probability calibration | 否 | hidden risk | HiddenInfoRisk |

## 12. 推荐落地步骤

第一阶段：只加 counters，不改策略。

1. 在 benchmark report 中加入 H1/H2/H4/H6 的 counters。
2. 从现有 benchmark 和 self-play replay 输出 baseline 行为分布。
3. 找出最常见的 20 个违反点。

第二阶段：把硬约束抽成共享 evaluator。

1. `ActionRightsEvaluator`
2. `DiceOpportunityModel`
3. `OpponentCashoutRisk`
4. `SupportSlotReplacementEV`

第三阶段：接入 policy，并做 ablation。

1. 每个 evaluator 单独开关。
2. 输出 per-matchup delta。
3. 只 promote 没有严重 matchup regression 的组合。

第四阶段：接入 search 和 training。

1. evaluator 输出进入 MCTS prior/leaf value。
2. evaluator features 进入 RL dataset。
3. 重新训练 ranker/value。

## 13. 成功判定

这些隐藏约束不应只以 WR 提升为成功标准。更稳妥的判定是：

- 违反硬约束的行为显著减少。
- 复杂卡组 mirror WR 向 50% 收敛。
- weak matchup 中失败原因从“明显误判”转向“资源不利/卡组劣势”。
- 决策日志能解释 top-1 为什么选择或拒绝 declareEnd、调谐、铺支援、切人。
- branch-eval 证明被策略提升的动作在 continuation 中确实更好。

如果某个约束提升局部行为但全局 WR 下降，应先看 matchup 拆分和行为 counter，而不是立即回滚。七圣召唤 AI 的目标不是单一均值最优，而是先消除稳定可复现的系统性错误。
