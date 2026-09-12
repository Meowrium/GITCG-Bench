# gi-agent & gi-ml AI 改进方案

> **⚠️ 状态：部分过时** — 撰写于 V5~V14 时期。P0-1 自适应权重已被 SPL 替代；训练管线（§8）已在 V25 中实现。核心架构描述仍有效。 最后审阅：2026-05-16. 见 [INDEX.md](INDEX.md)

> 本文档整理了对 `@gi-tcg/agent` 和 `@gi-tcg/ml` 的系统性改进建议，供后续开发新对话中使用。
> 训练管线改进（P0）已在 `scripts/run-multi-iteration-training.ps1` v2 中实现。

---

## 目录

1. [架构总览](#1-架构总览)
2. [关键源文件索引](#2-关键源文件索引)
3. [GiMlPolicy 决策流水线](#3-gimlpolicy-决策流水线)
4. [改进项：P0 最高优先级](#4-改进项p0-最高优先级)
5. [改进项：P1 高优先级](#5-改进项p1-高优先级)
6. [改进项：P2 中优先级](#6-改进项p2-中优先级)
7. [改进项：架构与工程](#7-改进项架构与工程)
8. [训练管线改进（已实现）](#8-训练管线改进已实现)
9. [Feature 差距清单](#9-feature-差距清单)
10. [实施路线图建议](#10-实施路线图建议)

---

## 1. 架构总览

```
                    ┌─────────────────────────────────────────┐
                    │           gi-agent (运行时)              │
                    │                                         │
  PolicyTurnDigest──▶  BaselinePolicy (15+ 启发式权重)        │
                    │      ↓                                  │
                    │  GiMlPolicy (多信号加权评分)             │
                    │    = rankerScore                        │
                    │    + baselineHeuristic                  │
                    │    + guardrail                          │
                    │    + qValueAdjustment                   │
                    │    + valueAdjustment                    │
                    │    + followupAdjustment                  │
                    │    + macroPlanAdjustment                │
                    │    + searchAdjustment                   │
                    │    + strategicValueAdjustment           │
                    │    + reactionChainAdjustment            │
                    │    + opponentAdjustment                 │
                    │      ↓                                  │
                    │  BoundedSearcher (beam search + minimax)│
                    │                                         │
                    ├─────────────────────────────────────────┤
                    │  MacroPlan (5种态势)                     │
                    │  OpponentModel (简单 aggression 估计)    │
                    │  CombatWindowLibrary (连招模板匹配)     │
                    └────────────────┬────────────────────────┘
                                     │ import 内部路径
                    ┌────────────────▼────────────────────────┐
                    │           gi-ml (训练管线)               │
                    │                                         │
                    │  Ranker: SlotLinearRanker               │
                    │    = action_case_bias                   │
                    │    + candidate_tag_bias                 │
                    │    + candidate_numeric_slot_weights     │
                    │    + query_numeric_slot_weights         │
                    │    + concept_presence_weights           │
                    │    + concept_numeric_slot_weights       │
                    │                                         │
                    │  ConceptModel: LinearConceptModel       │
                    │    = per-concept linear(sigmoid)        │
                    │    scope: state | state_action | window │
                    │                                         │
                    │  ValueModel: Linear / GBDT / MLP / Q   │
                    │  ConceptBank: 概念定义 + 验证          │
                    └─────────────────────────────────────────┘
```

### 各层职责

| 层级 | 包 | 核心职责 |
|------|----|----------|
| 基线策略 | `gi-agent` `baseline-policy.ts` | 15+ 启发式权重的动作评分 |
| ML 决策 | `gi-agent` `gi-ml-policy.ts` | 多信号加权融合排序 |
| 搜索 | `gi-agent` `bounded-searcher.ts` | Beam search + minimax |
| 战术规划 | `gi-agent` `macro-plan.ts` | 5种态势 (board_setup / reaction_convert / burst_convert / stabilize / tempo_pressure) |
| 对手建模 | `gi-agent` `opponent-model.ts` | 简单 aggression / defensiveness 估计 |
| 价值估计 | `gi-ml` `value/` | Linear / GBDT / MLP / Q-value 预测 |
| 排序器 | `gi-ml` `ranker/` | 基于概念感知的线性评分 |
| 概念建模 | `gi-ml` `runtime/concept-model.ts` | Per-concept 逻辑回归 |
| 概念发现 | `gi-ml` `concept-bank/` | 概念定义、验证、版本管理 |

---

## 2. 关键源文件索引

### gi-agent

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/runtime/policy/baseline-policy.ts` | ~400 | 基线策略：15+ 加权启发式评分 |
| `src/runtime/policy/gi-ml-policy.ts` | ~1120 | ML 策略核心：多信号融合 |
| `src/runtime/policy/macro-plan.ts` | ~370 | 5种宏观态势评分 |
| `src/runtime/policy/strategic-value.ts` | ~130 | 战略价值调整 |
| `src/runtime/policy/opponent-model.ts` | — | 对手风格建模 |
| `src/runtime/policy/plan-search.ts` | — | 搜索引导 |
| `src/runtime/policy/reaction-chain-templates.ts` | — | 反应链匹配 |
| `src/runtime/search/bounded-searcher.ts` | ~290 | Beam search + minimax |
| `src/runtime/eval-baselines/state-evaluator.ts` | ~90 | 状态评估门面 |
| `src/runtime/eval-baselines/heuristic-scorer.ts` | ~120 | 启发式评分器 (15个权重项) |
| `src/runtime/eval-baselines/feasibility-estimator.ts` | — | 骰子可行性估计 |
| `src/runtime/adapters/sim-adapter.ts` | — | 模拟器适配器 |
| `src/learning/rl/` | — | RL 数据采集与导出 |
| `src/learning/combat-windows/` | — | 连招窗口库 |
| `src/evaluation/benchmark/` | — | Benchmark 运行框架 |

### gi-ml

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/ranker/slot-linear-ranker.ts` | ~270 | 概念感知线性排序 |
| `src/ranker/artifact.ts` | — | Ranker artifact 定义 |
| `src/value/unified-value-predictor.ts` | ~100 | 统一价值预测 (Linear/GBDT/MLP/Q) |
| `src/value/evaluate.ts` | — | 线性价值评估 |
| `src/value/nonlinear-artifacts.ts` | — | GBDT/MLP 价值评估 |
| `src/runtime/bridge.ts` | ~290 | 运行时推理桥接 |
| `src/runtime/concept-model.ts` | ~260 | 概念模型推理 |
| `src/runtime/types.ts` | — | 运行时类型定义 |
| `src/concept-bank/` | — | 概念库 (build/merge/repository) |
| `src/contracts/` | — | 数据契约定义 |
| `src/datasets/` | — | 数据集构建管线 |
| `src/cli/` | — | CLI 训练命令 |

---

## 3. GiMlPolicy 决策流水线

```
rankCandidateWithGiMl() 最终评分公式:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
finalScore =
    giMlScore                    // SlotLinearRanker 多槽线性评分
  + guardrail                    // 运行时护栏 (极端惩罚)
  + qValueAdjustment             // Q(s,a) 价值 (权重 1.5, 优先于 V(s))
  + valueAdjustment              // V(s) 近似转移价值 (权重 1.0, 无 Q 时启用)
  + followupAdjustment           // 元素调谐后续收益 (权重 0.35)
  + macroPlanAdjustment          // 宏观态势评分 (权重 0.6)
  + searchAdjustment             // 搜索引导评分 (权重 0.8)
  + strategicValueAdjustment     // 战略价值评分 (权重 0.5)
  + reactionChainAdjustment      // 反应链先验 (权重 0.7)
  + opponentAdjustment           // 对手模型调整 (低幅度)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### BaselinePolicy 启发式权重项

| 权重项 | 默认值 | 作用 |
|--------|--------|------|
| `endTurnPenalty` | 5.0 | 结束回合惩罚 |
| `riskWeight` | 2.0 | 风险评估权重 |
| `healingWeight` | 1.4 | 治疗价值 |
| `summonWeight` | 1.1 | 召唤物价值 |
| `supportWeight` | 1.1 | 支援物价值 |
| `equipmentWeight` | 1.2 | 装备价值 |
| `foodWeight` | 0.8 | 食物价值 |
| `diceFixWeight` | 1.3 | 骰子修正价值 |
| `energyWeight` | 1.6 | 能量充能价值 |
| `burstWeight` | 3.0 | 爆发技能价值 |
| `switchValue` | 1.0 | 切人价值 |
| `reactionBonus` | 2.5 | 反应加成 |
| `killBonus` | 10.0 | 击杀奖励 |
| `poorDiceFactor` | 1.5 | 劣骰惩罚因子 |
| `tunePenaltyFactor` | 0.4 | 元素调谐惩罚 |

### HeuristicScorer 评分权重 (StateEvaluator 内部)

| 权重 | 默认值 | 评分项 |
|------|--------|--------|
| `damageBase` | 2.0 | 造成伤害 |
| `killBonus` | 15.0 | 击杀角色 |
| `killLineBonus` | 10.0 | 击杀线命奖 |
| `reactionBonus` | 3.0 | 元素反应 |
| `diceCostPenalty` | 1.5 | 骰子消耗 |
| `diceGainBonus` | 2.0 | 骰子获取 |
| `energyValue` | 2.5 | 能量变化 |
| `entityCreatedValue` | 2.0 | 创建实体 |
| `entityRemovedValue` | 1.0 | 移除实体 |
| `cardDrawnValue` | 1.5 | 抽牌 |
| `turnCostPenalty` | 3.0 | 回合消耗 |
| `oppWindowPenalty` | 1.0 | 给对手窗口 |
| `healingValue` | 0.8 | 治疗 |
| `selfDamagePenalty` | 1.0 | 自伤 |
| `forcedSwitchBonus` | 4.0 | 强制切换 |

---

## 4. 改进项：P0 最高优先级

### P0-1: 自适应启发式权重 Profile

**问题**: `BaselinePolicy` 所有 15+ 权重硬编码，无法区分快攻/控制、前期/后期。

**位置**: `gi-agent/src/runtime/policy/baseline-policy.ts`

**方案**:

1. 将启发式权重提取为 `HeuristicProfile` 接口
2. 根据 `MacroPlan.kind` / `ObservationV1` derived 字段动态选择权重集
3. 在 `BaselinePolicy` 中增加 `selectProfile(digest, observation)` 方法

```typescript
interface HeuristicProfile {
  endTurnPenalty: number
  riskWeight: number
  healingWeight: number
  summonWeight: number
  equipmentWeight: number
  energyWeight: number
  burstWeight: number
  reactionBonus: number
  killBonus: number
  poorDiceFactor: number
  tunePenaltyFactor: number
  // ... 其余权重
}

const AGGRESSIVE_PROFILE: HeuristicProfile = {
  endTurnPenalty: 7.0,
  riskWeight: 1.2,
  healingWeight: 0.8,
  burstWeight: 4.0,
  reactionBonus: 3.0,
  // ...
}
const DEFENSIVE_PROFILE: HeuristicProfile = {
  endTurnPenalty: 3.0,
  riskWeight: 2.5,
  healingWeight: 1.6,
  burstWeight: 2.5,
  // ...
}
const EARLY_GAME_PROFILE: HeuristicProfile = {
  summonWeight: 1.4,
  supportWeight: 1.3,
  equipmentWeight: 1.0,
  // ...
}

function selectProfile(
  macroPlan: RuntimeMacroPlan | null,
  observation: ObservationV1 | null,
): HeuristicProfile {
  if (!macroPlan || !observation) return DEFAULT_PROFILE
  if (macroPlan.kind === "stabilize") return DEFENSIVE_PROFILE
  if (macroPlan.kind === "burst_convert") return AGGRESSIVE_PROFILE
  const round = observation.point.round_number
  if (round <= 2) return EARLY_GAME_PROFILE
  return DEFAULT_PROFILE
}
```

**验证方式**: benchmark 对比 固定权重 vs 自适应权重

---

### P0-2: Policy-guided 搜索扩展

**问题**: `BoundedSearcher` pruning 只做"同技能/同目标去重 + 按类型排序"，minimax 只搜 1 层、top-5 候选，无法发现多步连招。

**位置**: `gi-agent/src/runtime/search/bounded-searcher.ts`

**方案**:

1. **引入 Policy-guided expansion**: 用 `GiMlPolicy` 或 `BaselinePolicy` 评分排序候选动作，beam 中优先扩展 top-K
2. **增加 fast action chain 深度**: fast action 不切换回合，允许更深搜索（`maxFastActionDepth`）
3. **叶节点 value 评估**: 用 value artifact 做 beam 叶节点评估而非简单累加
4. **中期目标**: 实现 MCTS 或 AlphaBeta 混合搜索

```typescript
interface SearchConfig {
  beamWidth: number
  maxDepth: number
  maxFastActionDepth: number       // fast action chain 深度上限
  expansionPolicy: "uniform" | "policy_guided"  // 扩展策略
  expansionTopK: number             // policy_guided 时每节点扩展 top-K
  valueFunction?: (state: GameState) => number   // 叶节点评估函数
  minimaxDepth: number
  minimaxBranching: number
}
```

**关键改动点**:
- `BoundedSearcher.search()`: 增加 policy 评分排序
- `BoundedSearcher.pruneActions()`: 根据 expansionPolicy 调整
- 新增 `fastActionDepth` 追踪: fast action 不消耗 minimax depth

---

## 5. 改进项：P1 高优先级

### P1-1: Context-gated 信号权重

**问题**: `GiMlPolicy.rankCandidateWithGiMl()` 的 finalScore 是 10 个信号的线性叠加，没有考虑信号间的交互。

**位置**: `gi-agent/src/runtime/policy/gi-ml-policy.ts:248-318`

**方案**:

1. **Plan-gated weighting**: 让部分信号权重随 `MacroPlan.kind` 变化
2. **Short-term**: 为 `GiMlPolicy` 增加 `planGatedWeights` 配置表

```typescript
type MacroPlanKind = "board_setup" | "reaction_convert" | "burst_convert" | "stabilize" | "tempo_pressure"

interface WeightOverrides {
  qValueWeight?: number
  valueWeight?: number
  macroPlanWeight?: number
  strategicValueWeight?: number
  reactionChainWeight?: number
  planSearchWeight?: number
}

const PLAN_GATED_WEIGHTS: Record<MacroPlanKind, WeightOverrides> = {
  burst_convert: {
    qValueWeight: 2.0,         // 爆发窗口下 Q 值更有参考价值
    planSearchWeight: 1.2,
    strategicValueWeight: 0.6,  // 不太需要战略调整
  },
  stabilize: {
    valueWeight: 1.5,           // 防守下价值预测更关键
    qValueWeight: 0.8,
    strategicValueWeight: 1.0,
  },
  board_setup: {
    macroPlanWeight: 0.9,
    strategicValueWeight: 0.8,
  },
  reaction_convert: {
    reactionChainWeight: 1.0,   // 反应链先验更重要
    qValueWeight: 1.3,
  },
  tempo_pressure: {
    qValueWeight: 1.5,
    planSearchWeight: 1.0,
  },
}
```

3. **中期**: 在 `SlotLinearRanker` 中增加 cross-features（`concept_presence × action_case` 交互项）

---

### P1-2: 对手模型训练

**问题**: `predictOpponentStyle()` 只有简单 aggressionLevel / defensivenessLevel / comboLikelihood，未从 self-play 数据学习。

**位置**: `gi-agent/src/runtime/policy/opponent-model.ts`

**方案**:

1. **从 self-play replay 提取对手行为特征**: 每回合进攻/防御/切人频次
2. **训练轻量 opponent style classifier**: 基于前 N 回合行为预测对手风格
3. **将 opponent style 作为 concept 输入 ranker**: 让 ranker 自动学习交互模式
4. **短期**: 在 `ObservationV1` 扩展字段中增加 `opp_aggression_score`、`opp_switch_frequency`、`opp_burst_usage_rate`

---

### P1-3: Concept Bottleneck 增强

**问题**: `concept_model.linear.v1` 每个概念只是稀疏特征的逻辑回归，`scope = "window"` 退化为 `"state"` 处理。

**位置**: `gi-ml/src/runtime/concept-model.ts`

**方案**:

1. **实现 window scope 的实际推理**: 当前 `predictConceptValue` 对 `scope = "window"` 无特殊处理，应实现窗口匹配逻辑
2. **考虑小型 MLP concept bottleneck**: 让 concept model 输出连续特征向量而非二元预测
3. **增加 temporal features**: query 的 `context_slots` 增加 `actions_taken_this_round`、`dice_remaining_by_element`、`turn_phase`
4. **增加 concept 交互**: 允许 concept 之间有依赖关系（如 "burst_window_enable" × "reaction_window_enable" 的组合概念）

---

### P1-4: 骰子管理策略增强

**问题**: `BaselinePolicy` 只有 `diceFixWeight` + `poorDiceFactor`；元素调谐惩罚缺乏"调谐后能解锁哪些动作"的系统建模。

**位置**: `gi-agent/src/runtime/policy/baseline-policy.ts` + `gi-ml/src/ranker/slot-linear-ranker.ts`

**方案**:

1. **增加 dice state embedding**: 在 ranker 的 `query_numeric_slots` 增加 per-element dice count、omni count、dice deficit
2. **增加 "unlock potential" 概念**: 为每个元素调谐候选，计算"调谐成 X 元素后能解锁几个候选动作"
3. **短期**: 在 `PolicyTurnDigest` 增加 `diceQualityScore`（骰子分布与手牌费用需求匹配度）

```typescript
interface DiceQualityMetrics {
  omniCount: number
  totalDice: number
  deficitByElement: Record<number, number>  // element → 缺几颗
  unlockPotential: number  // 调谐后可解锁动作数
  qualityScore: number     // 综合匹配度 0-1
}
```

---

## 6. 改进项：P2 中优先级

### P2-1: Value Model 特征覆盖扩充

**位置**: `gi-agent/learning/rl/` 中的特征构建函数

**缺少的关键特征**:

| 特征 | 说明 |
|------|------|
| `dice_efficiency` | `omni_count / total_dice` |
| `summon_pressure` | 即将触发的召唤物伤害总量 |
| `action_economy_ratio` | 已执行动作数 / 对手已执行动作数 |
| `team_composition_hash` | 角色组合的哈希特征 |
| `opp_hand_estimation` | 基于已观察卡牌的对手手牌估计 |
| `elemental_application_map` | 各角色身上的元素附着状态 |

### P2-2: MacroPlan 动态参数

**问题**: `buildHeuristicMacroPlan()` 中阈值硬编码（如 `activeHpRatio <= 0.45` → stabilize），且 `remaining_actions` 固定为 2。

**位置**: `gi-agent/src/runtime/policy/macro-plan.ts`

**方案**:
1. 从 `ObservationV1` derived 字段动态计算态势切换阈值
2. `remaining_actions` 应根据 plan kind 和 observation 的 window 评分调整

### P2-3: BoundedSearcher 可行性剪枝

**问题**: 当前 beam 只按 `accScore` 排序，不考虑 `feasibility` 的阈值（只乘到了 score 上）。

**方案**: 增加硬性 feasibility 下限（如 `< 0.01` 直接剪掉），而非只做 score 缩放。

---

## 7. 改进项：架构与工程

### ARCH-1: gi-ml runtime 包解耦

**问题**: `GiMlPolicy` 直接 import `../../../../gi-ml/src/...` 深度路径，任何 gi-ml 内部重构都影响 gi-agent。

**位置**: `gi-agent/src/runtime/policy/gi-ml-policy.ts:20-42`

**方案**:
1. 在 gi-ml 中增加 `@gi-tcg/ml-runtime` 子包（只导出运行时类型和加载函数）
2. gi-agent 只依赖 `@gi-tcg/ml-runtime`，不依赖 gi-ml 的 src 内部路径
3. 通过 artifact version 兼容性检查确保 runtime 和 training 的版本一致

### ARCH-2: 训练闭环自动化

**问题**: 训练流程需要手动检查报告决定 promote，无 A/B 测试、无版本管理、无回滚。

**方案**:
1. ~~AutoPromote~~ (已在 v2 脚本中实现)
2. 增加 `training-job.json` 记录每次训练的超参、输入数据 hash、输出 artifact 路径
3. 增加 `rollback` 命令，从 training job 历史中恢复上一个稳定权重

### ARCH-3: 端到端管线回归测试

**问题**: 概念管线（discovery → validation → bank → ranker）中间步骤多，缺少端到端测试。

**方案**:
1. 增加 `pipeline:smoke-test` 命令，从 sample data 到 ranker inference 跑一遍全流程
2. 在 CI 中增加 artifact compatibility check
3. 为 GiMlPolicy 的每个信号源增加单元测试，确保无数据时 graceful degradation

---

## 8. 训练管线改进（已实现）

以下改进已在 `scripts/run-multi-iteration-training.ps1` v2 中实现：

### ✅ P0: Benchmark 对局验证 (Step 4.8)

- 每轮训练后自动运行 `trained-vs-baseline` benchmark
- 参数: `-ValidateGames 50` (每 matchup 50 局)
- 解析 `validate-result.json` 提取 `winsP0 / totalGames` 计算胜率
- 胜率 < `-MinWinRateVsBaseline 0.52` 则 **阻塞推广**

### ✅ P0: A/B 不对称 self-play

- SideA 温度 1.5（适度探索），SideB 温度 `-SideBTemperature 2.0`（高探索）
- 增加对手行为多样性，防止策略坍缩

### ✅ P1: Promotion 逻辑升级

- Pairwise 阈值 0.55 → **0.62**
- MAE 改善要求 0.002 → **0.004**
- 新增 win rate gate：验证胜率 < 0.52 时拒绝 promotion
- 详细输出每个 criteria 的 PASS/FAIL
- 连续 N 轮未 promote 时发出 STAGNATION WARNING
- Pipeline state 记录 `consecutiveNonPromotions` + `currentBestQValuePath`

### ✅ P1: 数据质量检查

- self-play 后检查样本数（`Read-DatasetSampleCount`）
- 样本数 < `-MinSamples 500` 时跳过本轮
- 低样本量 (< 1000) 发出警告

### ✅ P1: Matchup 轮换

- 新增 `-BenchmarkRotationPaths` 参数（逗号分隔多个配置文件）
- 每轮取 `($iter - $StartIteration) % count` 选择配置

### ✅ 其他

- Q-value 训练增加 2 次重试逻辑
- 最终汇总表新增 WinRate 列
- Pipeline state 新增 QValue artifact 路径

---

## 9. Feature 差距清单

### 当前已实现 vs 行业标准对比

| 能力 | 当前状态 | 行业标准 | 差距 |
|------|---------|---------|------|
| 动作排序 | 线性加权和 | 深度策略网络 | 中 |
| 价值估计 | Linear/GBDT/MLP | Transformer/PPO | 小-中 |
| 搜索 | Beam + 1层 minimax | MCTS / AlphaZero | 大 |
| 对手建模 | 简单 aggression | 对手条件策略 | 大 |
| 骰子管理 | 基础惩罚 | 规划式骰子分配 | 中 |
| 概念瓶颈 | 线性/二元 | 连续/交互 | 中 |
| 训练闭环 | 自对弈 + 离线指标 | 实战验证 + A/B | 小 (v2 已改善) |

### 七圣召唤特有的决策维度

七圣召唤不同于一般 TCG 的关键差异：
1. **骰子资源系统**: 每回合随机投骰，需要骰子管理 + 元素调谐策略
2. **Fast action chain**: 使用技能后如果是 fast action，可以继续行动不切换回合
3. **元素反应系统**: 需要理解元素附着和反应触发时机
4. **角色切换**: 主动/被动切换都是核心决策
5. **爆发技能**: 需要充能管理，burst 时机是关键

这些特有差异意味着通用的 TCG AI 方法需要针对性调整。

---

## 10. 实施路线图建议

### Phase 1 (1-2 周): 快速收益

- [ ] P0-1: 自适应启发式 Profile（改动小、收益明确）
- [ ] P1-4: 骰子管理策略增强（核心决策维度）
- [ ] P1-1: Context-gated 信号权重（简单配置表即可）

### Phase 2 (2-4 周): 搜索能力提升

- [ ] P0-2: Policy-guided 搜索扩展
- [ ] P2-3: 可行性硬剪枝
- [ ] P1-3: Concept window scope 实现

### Phase 3 (4-8 周): 对手建模 + 高级概念

- [ ] P1-2: 对手模型训练（从 self-play）
- [ ] P1-3: MLP concept bottleneck
- [ ] P2-1: Value model 特征覆盖扩充
- [ ] P2-2: MacroPlan 动态参数

### Phase 4 (持续): 架构改善

- [ ] ARCH-1: Runtime 包解耦
- [ ] ARCH-2: 训练 job 版本管理 + 回滚
- [ ] ARCH-3: 端到端管线回归测试

---

> 最后更新: 2026-04-10
> 训练管线 v2 改进已合入 `scripts/run-multi-iteration-training.ps1`
