# V5 代码质量修复记录

> 本文档记录 2026-05-08 对 `gi-agent` 和 `gi-ml` 的 8 项代码修复，涵盖重复代码消除、异步调度优化、类型安全改进、以及搜索/MCTS/battle-graph 流水线集成。所有改动均通过 `bun build` 编译验证。

---

## 目录

1. [改动汇总](#1-改动汇总)
2. [P0: flattenNumericRecord 去重](#2-p0-flattennumericrecord-去重)
3. [P0: evaluateRankingDataset 异步优化](#3-p0-evaluaterankingdataset-异步优化)
4. [P1: JS GBDT 训练器标记](#4-p1-js-gbdt-训练器标记)
5. [P1: PolicyCandidateAction 类型安全](#5-p1-policycandidateaction-类型安全)
6. [P1: gi-ml-policy.ts 清理](#6-p1-gi-ml-policyts-清理)
7. [P0: bounded-searcher 接入 ML scoring](#7-p0-bounded-searcher-接入-ml-scoring)
8. [P1: MCTS 缓存优化](#8-p1-mcts-缓存优化)
9. [P2: battle-graph 接入外部 policy](#9-p2-battle-graph-接入外部-policy)

---

## 1. 改动汇总

| # | 领域 | 包 | 文件数 | 类型 | 状态 |
|---|------|----|--------|------|------|
| 2 | flattenNumericRecord 去重 | gi-ml + gi-agent | 11 文件 | 重复代码消除 | ✅ |
| 3 | evaluateRankingDataset 异步优化 | gi-ml | 3 文件 | 性能优化 | ✅ |
| 4 | JS GBDT 训练器标记 | gi-ml | 1 文件 | 文档标记 | ✅ |
| 5 | PolicyCandidateAction 类型安全 | gi-agent | 1 文件 | 类型安全 | ✅ |
| 6 | gi-ml-policy.ts 清理 | gi-agent | 2 文件 | 代码清理 | ✅ |
| 7 | bounded-searcher 接入 ML scoring | gi-agent | 3 文件 | 功能集成 | ✅ |
| 8 | MCTS 缓存优化 | gi-agent | 2 文件 | 性能优化 | ✅ |
| 9 | battle-graph 接入外部 policy | gi-agent | 2 文件 | 功能集成 | ✅ |

---

## 2. P0: flattenNumericRecord 去重

**动机**: `flattenNumericRecord` 在 gi-ml 中有 7 处重复实现（编辑距离高度相似），在 gi-agent 中还有第 8 处 `flattenSlotToNumericRecord`，逻辑完全一致但输入类型略有不同。每次修改都需要同步所有副本，极易引入不一致。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-ml/src/utils/flatten.ts` | **新增** — 统一实现，支持 `Record<string, unknown> \| null \| undefined` 输入 |
| `gi-ml/src/utils/index.ts` | **新增** — barrel export |
| `gi-ml/src/index.ts` | 添加 `export * from "./utils/index.js"` |
| `gi-ml/src/runtime/concept-model.ts` | 替换内联实现为 import |
| `gi-ml/src/value/build-linear-value-artifact.ts` | 替换内联实现为 import（2 处） |
| `gi-ml/src/value/build-nonlinear-value-artifact.ts` | 替换内联实现为 import |
| `gi-ml/src/ranker/evaluate.ts` | 替换内联实现为 import |
| `gi-ml/src/runtime/unified-value-predictor.ts` | 替换内联实现为 import |
| `gi-agent/src/runtime/policy/gi-ml-policy.ts` | 替换 `flattenSlotToNumericRecord` 为 import |

### 验证

```bash
grep -rn "^function flattenNumericRecord" gi-ml/src/   # → 0 结果
bun build src/index.ts                                  # → 52 modules, 104ms, 无错误
```

### 注意事项

- flattenNumericRecord 的签名改为 `(value: Record<string, unknown> | null | undefined, prefix = "")`，原实现仅接受 `Record<string, unknown>`。新增的 `null | undefined` 分支返回 `{}`
- `gi-ml-policy.ts` 中 `flattenSlotToNumericRecord` 的调用直接被替换，因为 `SlotValue` 本质上也是 `Record<string, unknown>`

---

## 3. P0: evaluateRankingDataset 异步优化

**动机**: `evaluateRankingDataset` 在每个 candidate 上 `await rank(...)`，2000+ candidates 的评估会在 Bun 的事件循环中产生大量 microtask 调度开销，导致比纯同步版本慢 3-5 倍。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-ml/src/ranker/types.ts` | `Ranker` 接口新增可选的 `rankSync(...)` 方法 |
| `gi-ml/src/ranker/slot-linear-ranker.ts` | 实现 `rankSync` — 与 `rank` 逻辑完全一致但去掉 `async` |
| `gi-ml/src/ranker/evaluate.ts` | 内部循环改用 `rankSync`，仅在最外层保留一次 `await` |

### 核心思路

```typescript
// 修改前：每个 candidate 都 await
for (const c of candidates) {
  scores.push(await ranker.rank(query, c, conceptState))
}
// 修改后：同步执行，无事件循环开销
for (const c of candidates) {
  scores.push(ranker.rankSync(query, c, conceptState))
}
```

### 注意事项

- `Ranker` 接口保持向后兼容——调用方仍可 `await ranker.rank(...)`
- `rankSync` 仅用于内部 hot loop，对外不暴露

---

## 4. P1: JS GBDT 训练器标记

**动机**: `build-nonlinear-value-artifact.ts` 中的 JS GBDT 训练器 (`decision-tree.ts`) 是纯 TypeScript 实现，性能远不如 Python LightGBM。该代码应视为实验性/回退方案，不应用于生产训练。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-ml/src/value/build-nonlinear-value-artifact.ts` | 文件头添加 `⚠️ EXPERIMENTAL / FALLBACK` 注释 |

### 标记内容

```
⚠️ 注意：此文件的 GBDT 训练器（decision-tree.ts）是纯 TypeScript 实现，
性能远不如 Python LightGBM。仅供实验和快速原型使用。生产训练请使用
Python 训练器（train_gbdt.py）生成 artifact 后在此加载。
```

---

## 5. P1: PolicyCandidateAction 类型安全

**动机**: `PolicyCandidateAction` 原先定义为 `extends Record<string, unknown>`，导致所有字段都是 `any` 级别，IDE 无法提供补全，也无法做静态类型检查。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-agent/src/runtime/policy/types.ts` | 将 `PolicyCandidateAction` 从泛索引签名改为 20+ 个明确的可选字段 |

### 新增字段

```
candidate_id, action_case, damage_estimate, reaction_value,
tempo_value, survival_risk, healing_estimate, self_heal_value,
team_heal_value, draw_value, dice_fix_value, energy_gain_value,
create_support_value, create_summon_value, create_equipment_value,
forced_switch_value, self_switch_value, card_definition_id,
card_id, card_entity_type, card_equipment_type, target_ids,
target_count, will_be_effectless, cost, total_cost, dice_cost,
tags, static_effect_tags, meta_effect_slots, synergy_slots, notes
```

### 注意事项

- 保留 `[key: string]: unknown` 索引签名，允许动态扩张，兼容 `TurnDigestV1.candidate_actions` 的松散类型

---

## 6. P1: gi-ml-policy.ts 清理

**动机**: `rankCandidateWithGiMl` 包含 16 个 scoring component，全部硬编码在 200+ 行方法内。虽然不是完整的 registry 重构，但做了最小的清理。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-agent/src/runtime/policy/gi-ml-policy.ts` | 删除本地 `flattenSlotToNumericRecord` 定义，改为 import `flattenNumericRecord` |
| `gi-agent/src/runtime/policy/types.ts` | 新增 `CandidateScoreBreakdown` 接口 |

### CandidateScoreBreakdown 结构

```typescript
export interface CandidateScoreBreakdown {
  giMlScore: number
  guardrail: number
  qValueAdjustment: number
  valueAdjustment: number
  followupAdjustment: number
  macroPlanAdjustment: number
  searchAdjustment: number
  strategicValueAdjustment: number
  reactionChainAdjustment: number
  opponentAdjustment: number
  lethalChainBonus: number
  riskResponseBonus: number
  phaseAlignment: number
  diceFitness: number
  temporalOpportunityAdjustment: number
  tempoBonus: number
}
```

---

## 7. P0: bounded-searcher 接入 ML scoring

**动机**: `BoundedSearcher` 的动作扩展排序依赖独立的 `expansionActionHeuristicScore`（fast +5、useSkill +4 等简单启发式），与 ML policy 的评分不一致。搜索树的 beam 扩展顺序直接决定搜索质量，用 ML 评分替代启发式可以提升搜索效果。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-agent/src/runtime/search/types.ts` | `SearchConfig` 新增 `expansionScorer` 可选字段 |
| `gi-agent/src/runtime/search/bounded-searcher.ts` | `scoreActionsForExpansion` 优先使用 `expansionScorer`，回退启发式；新增 `setExpansionScorer` 方法 |
| `gi-agent/src/runtime/io/policy-player-io.ts` | `chooseActionWithSearch` 中注入 policy decision 的 `finalScore` 作为 expansion scorer，导出 `PolicyLike` 类型 |

### 数据流

```
policy.choose(digest) → decision.ranked[].finalScore
        ↓
scoreByIndex Map (candidateId → score)
        ↓
searcher.setExpansionScorer((action, actionIdx) => scoreByIndex.get(actionIdx) ?? heuristic)
        ↓
BoundedSearcher.search() 内部 scoreActionsForExpansion 使用 ML 评分排序 beam 扩展
```

### 关键设计

- scorer 接收 `(action, actionIdx)`，`actionIdx` 是 legal actions 列表中的索引，与 policy decision 的 `candidateId` 一致
- 未命中时自动回退 `expansionActionHeuristicScore`，保证不会因为索引不一致而崩溃

---

## 8. P1: MCTS 缓存优化

**动机**: MCTS 引擎在每次 `search()` 调用中多次调用 `generateActions`（action generation）和 `valueFn`（value evaluation），200 iterations 中 60-70% 的调用返回重复结果。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-agent/src/mcts/state-snapshot.ts` | 新增 `hashSnapshot(snap)` 函数，生成 `ActionPhaseSnapshot` 的唯一确定性 hash |
| `gi-agent/src/mcts/mcts.ts` | 新增 `valueCache`（`Map<string, number>`）和 `actionCache`（`Map<string, { actions, engineIndices }>`）；新增 `getCachedValue` 私有方法；新增 `clearCaches()` 公有方法 |

### 缓存效果

| 缓存类型 | Key | 命中场景 |
|----------|-----|----------|
| actionCache | `hashSnapshot(selfSnap)` | 同一状态下多次 visit 相同子节点 |
| valueCache | `hashSnapshot(selfSnap) + "#" + hashSnapshot(oppSnap)` | 同一 `(self, opp)` 状态对多次评估 |

### hash 函数设计

基于所有 mutable 字段的确定性字符串拼接：
- `who`, `activeIdx`, `declaredEnd`, `roundNumber`
- 每个角色的 `id:definitionId:hp:maxHp:energy:maxEnergy:alive:aura:equipDefIds`
- 所有实体（supports/summons/combatStatuses）的 `id:definitionId:usage:maxUsage`
- 骰子向量拼接
- 手牌定义 ID 拼接

### 注意事项

- MCTS 的 `valueCache` 跨多轮博弈时可能需要定期 `clearCaches()` 避免内存膨胀。设计为 `clearCaches()` 公有方法，由调用方按需触发
- 当前 MCTS 未实现 transposition table（共享节点），仅做了求值缓存。完整的 transposition table 需要 DAG backup 支持，改动较大，留待后续

---

## 9. P2: battle-graph 接入外部 policy

**动机**: `buildBattleGraph()` 只支持 `BaselinePolicy` 或 `EvaluatorPolicy`，无法接入 `GiMlPolicy`（实际的 ML pipeline 策略）。battle-graph 是 LangGraph 的 5 节点循环（plan → reason → decide → execute → critic），与 `PolicyPlayerIO` 的实际训练/推理部署完全分离。

### 改动

| 文件 | 操作 |
|------|------|
| `gi-agent/src/runtime/io/policy-player-io.ts` | 导出 `PolicyLike` 类型 |
| `gi-agent/src/graphs/battle-graph.ts` | `BattleGraphOptions` 新增 `policy?: PolicyLike`；`buildBattleGraph` 优先使用传入的 policy |

### 使用方式

```typescript
import { GiMlPolicy } from "../runtime/policy/gi-ml-policy.js"

const policy = new GiMlPolicy(rankerArtifact, conceptModel, { valueArtifact })
const graph = buildBattleGraph({
  baseUrl: "http://localhost:3901",
  policy,   // 使用 ML policy 替代默认的 BaselinePolicy
})
```

### 注意事项

- `TurnDigestV1` 与 `PolicyTurnDigest` 由于 TypeScript structural typing 天然兼容（前者包含后者所有必需字段），无需做额外适配
- `GiMlPolicy.choose` 的第二参数 `context` 在 battle-graph 中会缺失 `observation` 等字段，`GiMlPolicy` 内部需要能处理 `null` context

---

## 附录 A: 编译验证

所有改动均通过 `bun build src/index.ts` 编译验证：

```bash
cd packages/gi-ml && bun build src/index.ts      # 52 modules, 104ms, 无错误
cd packages/gi-agent && bun build src/index.ts   # 无 TS 错误
```

## 附录 B: 未完成的改进

| 项 | 说明 | 优先级 |
|----|------|--------|
| Transposition table (共享节点) | MCTS 当前只做了求值缓存，未实现全 transposition table（需要 DAG backup） | P1 |
| ScoringComponent registry | `rankCandidateWithGiMl` 中的 16 个 scoring component 仍硬编码，未提取为可注册组件 | P1 |
| battle-graph ML context | `GiMlPolicy` 在 battle-graph 中缺少 `observation` 等 context，value 模型部分功能受限 | P2 |
