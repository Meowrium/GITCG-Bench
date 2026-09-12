# V28 gi-agent & gi-ml 深度审查与改进建议

> 日期: 2026-05-22  
> 范围: `packages/gi-agent`, `packages/gi-ml`  
> 状态: 实施计划（供 agent 参考执行）  
> 关联文档: `v26-ai-architecture-recommendations.md`, `v15-agent-ml-code-review-and-improvement-plan.md`, `ai-improvement-plan.md`

---

## 目录

1. [文档体系 (`gi-agent/docs/`)](#1-文档体系)
2. [gi-agent 代码架构](#2-gi-agent-代码架构)
3. [gi-ml 代码架构](#3-gi-ml-代码架构)
4. [跨包架构问题](#4-跨包架构问题)
5. [优先级排序](#5-优先级排序)
6. [实施任务清单](#6-实施任务清单)

---

## 1. 文档体系

### 1.1 现状评估

文档组织**相当好**——`INDEX.md` 维护了清晰的三级分类（🟢活跃 / 🟡部分过时 / 🔴归档），每篇文档都标注了"⚠️ 状态"和最后审阅日期。在快速迭代的项目中很少见。

### 1.2 🔴 缺失文档

| 缺失项 | 影响 |
|--------|------|
| **SPL (Strategic Plan Language) 正式文档** | SPL 已是核心决策层（替代了旧的自适应权重），但只有散落在 `src/runtime/plan/` 代码中的注释，没有独立文档 |
| **RL Dataset Schema V3 迁移指南** | `reward.v3` 已经是当前版本，但没有文档说明 v1→v2→v3 的变更历史和迁移注意事项 |
| **gi-ml ↔ gi-agent 接口契约文档** | V26 建议将 RL contracts 挪到 `@gi-tcg/ml/contracts`，但目前缺少一份明确的接口边界文档 |
| **Feature 字典** | GBDT/LightGBM 用了 80+ 个特征（含 FORCE_INCLUDE_FEATURES），但没有完整的特征说明文档 |

### 1.3 🟡 过时但标记的文档

以下文档虽已标记"部分过时"，但仍占据大量认知空间，建议做进一步处理：

- **`ai-decision-framework-v2.md`** (494 行) — 三层递进架构概念被 SPL 继承后，建议提取仍然有效的核心洞察（阶段转换触发器、Mulligan 策略逻辑）到 SPL 文档中，然后归档此文件
- **`temporal-reasoning-solution.md`** (311 行) — PhaseStateMachine/DeckStrategy 已被 self-play+GBDT 替代，建议归档
- **`opponent-modeling-gaps.md`** (253 行) — 10 个缺口清单的表格**大部分是空的**（未填写概率和信心等级），实际参考价值低。要么补全，要么归档

### 1.4 文档操作清单

```
1. 新建 docs/spl-spec.md — SPL 形式化规格（state machine, compiler, plan schema）
2. 新建 docs/feature-dictionary.md — 所有 observation/ranker 特征的完整说明
3. 归档 opponent-modeling-gaps.md（内容不完整）
4. 归档 temporal-reasoning-solution.md（已被替代）
5. 更新 INDEX.md 版本号到 V28+
```

---

## 2. gi-agent 代码架构

### 2.1 🔴 EvaluatorPolicy 绕过父类 (Critical Bug)

**文件**: `src/runtime/policy/evaluator-policy.ts` (99 行)

`EvaluatorPolicy.choose()` 完全绕过了 `BaselinePolicy.choose()`，导致以下功能丢失：
- Ban list 过滤
- Turn plan 生成
- 骰子预留 (dice reservation)
- Phase weight overrides
- SPL 上下文
- UCB/Thompson 探索策略

**修复方向**: 重写为组合模式而非继承。将 BaselinePolicy 的过滤/规划逻辑抽取为独立函数，在 EvaluatorPolicy 中显式调用：

```typescript
// 伪代码
class EvaluatorPolicy {
  choose(ctx) {
    const filtered = applyBanListAndFilters(ctx)  // 复用 BaselinePolicy 的过滤
    const plan = generateTurnPlan(ctx)              // 复用 turn plan
    const ranked = this.rankWithEvaluator(filtered) // 自己的排序
    return applyExploration(ranked, ctx)            // 复用探索策略
  }
}
```

### 2.2 🟡 巨型文件需要分解

| 文件 | 行数 | 问题 |
|------|------|------|
| `gi-ml-policy.ts` | 1723 | 20+ 评分组件全部堆在一个文件里 |
| `baseline-policy.ts` | 1091 | 5 种 profile + 所有启发式权重 |
| `policy-player-io.ts` | 993 | Game ↔ Policy 桥梁 + SPL + 对手模型 + 斩杀链 |
| `battle-graph.ts` | 790 | 已不主要使用但仍然存在 |

**分解方向**:
- `gi-ml-policy.ts` → 按信号类型拆分为 `scorers/` 目录：`ranker-scorer.ts`, `value-scorer.ts`, `reaction-chain-scorer.ts`, `macro-plan-scorer.ts`, `search-scorer.ts`, `opponent-scorer.ts`
- `baseline-policy.ts` → 抽取 `profiles/` 目录：`aggressive-profile.ts`, `defensive-profile.ts` 等
- `battle-graph.ts` → 既然 README 声明"不再是主要路径"，应该移到 `legacy/` 目录或直接删除

### 2.3 🟡 脚本不一致

- `gen_all_plans.sh` 和 `regenerate_plans.py` 的 **deck codes 互相对不上**（雷鹤、水债等名字映射到了不同的 code）
- `package.json` 中 `scoring:calibrate` 指向不存在的 `src/ml/calibrate.ts`
- `anal.ps1` 包含硬编码的 API key（安全风险）—— 应立即移除

### 2.4 🟢 做得好的部分（无需修改）

- **MCTS 引擎** (`src/mcts/mcts.ts`, 405 行) — PUCT 实现干净，配置化程度高
- **Combat Window Pipeline** — 24 个文件，从提取器到验证器到树库，管线完整
- **RL 类型系统** (`src/learning/rl/types.ts`, 534 行) — V1 版本化的 observation/decision/reward 类型设计合理
- **SPL 模块** (`src/runtime/plan/`) — 9 个文件的编译器/状态机/Dice budget 设计精巧

---

## 3. gi-ml 代码架构

### 3.1 整体评估

gi-ml 的架构设计**非常成熟**，文档覆盖率高（README + 4 篇 docs/ 文档），模块划分清晰：

```
contracts/     → 数据契约
concept-bank/  → 概念库（build/merge/validate）
concept-discovery/ → 多路概念发现
datasets/      → RL/ranking/value 数据集构建
ranker/        → SlotLinearRanker
value/         → Linear/GBDT/MLP/MoE 价值模型
runtime/       → 在线推理 bridge
python/        → Python 训练器
```

### 3.2 🔴 Python Venv 提交到了仓库

`python/.lgbm-venv/` 包含完整的 Python 虚拟环境（lightgbm、numpy、setuptools 的编译后文件），**不应该提交到版本控制**。

**修复**:
```bash
# 添加到 .gitignore
packages/gi-ml/python/.lgbm-venv/
packages/gi-ml/python/.venv/
**/__pycache__/

# 从 git 追踪中移除（不删除本地文件）
git rm -r --cached packages/gi-ml/python/.lgbm-venv/
```

### 3.3 🟡 缺少统一实验追踪

当前训练产物的评估结果散落在 `output/*.json` 中（约 30+ 文件），没有统一的实验对比工具。

**建议**: 新建一个 `compare-artifacts.ts` CLI，接受多个 eval JSON 路径，输出对比表格：

```bash
pnpm run compare-artifacts output/ranker-eval.*.json
# 输出: MAE, accuracy@1, accuracy@3, holdout split, sample count 等
```

### 3.4 🟡 `unified-value-predictor.ts` 的 import 顺序 bug

文件第 1 行是 `import { flattenNumericRecord }`，然后第 2 行是 AGPL license 注释。License header 应在文件最顶部。

**修复**: 将 license header 移到第 1 行，import 移到第 17 行之后。

### 3.5 🟡 MoE 训练器代码重复

`train_lgbm_value.py` (425 行) 和 `train_moe_value.py` (562 行) 共享大量代码：
- `flatten_feature_slots()` — 完全相同
- `is_categorical_feature()` — 完全相同
- `FORCE_INCLUDE_FEATURES` — 完全相同
- argparse 设置 — 90% 相同

**修复方向**: 抽取共享代码到 `gitcg_ml/_common.py` 或 `gitcg_ml/training_utils.py`

### 3.6 🟢 做得好的部分（无需修改）

- **`SlotLinearRanker`** (`src/ranker/slot-linear-ranker.ts`, 268 行) — 干净的线性模型实现，支持 action_case_bias、tag_bias、numeric_slot_weights、concept_weights 四层评分
- **`bridge.ts`** (`src/runtime/bridge.ts`, 296 行) — runtime inference 的完整封装，支持 ranker + concept model + value artifact 的组合推理
- **`data-contracts.md`** — 契约定义详尽（query_id, candidate_id, concept_id, bank_version 等 ID 策略）
- **概念验证管线** — `draft → validated → deprecated` 生命周期管理，6 个验证插槽（predictability, stability, transferability, ranking_gain, retrieval_gain, failure_mode）
- **`unified-value-predictor.ts`** — 统一了 Linear/GBDT/MLP/MoE 四种价值模型的推理接口，支持透明切换

---

## 4. 跨包架构问题

### 4.1 🔴 包边界不安全（V15 已识别但两年未修复）

`gi-agent` 和 `gi-ml` 之间存在不安全的依赖方向：
- `gi-agent` 的 RL 类型定义（`src/learning/rl/types.ts`）被 `gi-ml` 消费
- 但 `gi-ml` 的 `contracts/rl-types.ts` 也有自己的 RL 类型
- 这意味着修改一侧可能导致另一侧编译失败

**V26 建议的修复方案**：
```
将共享 contracts 统一到 gi-ml/contracts/
  - gi-ml/contracts/rl-types.ts  → 唯一的 RL 类型定义
  - gi-agent 从 @gi-tcg/ml/contracts 导入
  - 移除 gi-agent/src/learning/rl/types.ts 中的重复定义
```

**实施步骤**:
1. 确认 `gi-ml/contracts/rl-types.ts` 包含 `gi-agent` 需要的所有类型
2. 在 `gi-agent` 中将所有 `import ... from "../rl/types"` 改为 `import ... from "@gi-tcg/ml/contracts"`
3. 删除 `gi-agent/src/learning/rl/types.ts`
4. 运行 `pnpm run check` 确认编译通过
5. 运行 `pnpm test` 确认测试通过

### 4.2 🔴 `finalScore` 线性叠加的根本限制

V26 文档准确指出了问题：**不要继续在 `finalScore = signal1 + signal2 + ...` 上投入**。当前 `gi-ml-policy.ts` 有 20+ 个线性叠加信号，这不能解决：
- 动作价值对后续窗口的高度依赖
- 同一动作在不同卡组中语义不同
- `declareEnd`、元素调谐、切人等约束性动作的特殊性

**建议的架构演进路径**（分 3 阶段）：

**Phase 1 (短期, 1-2 周)**: 在 GiMlPolicy 中引入 transition-based scoring
```typescript
// 当前: score = rankerScore + valueScore + macroScore + ...
// 改为:
const beforeState = capturePortfolioSnapshot(ctx)
const afterState = simulateAction(ctx, candidate)
const transitionValue = evaluateTransition(beforeState, afterState)
score = transitionValue + guardrailAdjustments
```

**Phase 2 (中期, 2-4 周)**: MCTS adapter 使用真实 engine continuation
- 当前 MCTS 用轻量快照模拟，无法处理卡牌费用、元素附着等
- 应直接调用 `@gi-tcg/core` 的 `Game` 做状态推进

**Phase 3 (长期, 1-2 月)**: Deck/matchup 条件化
- 用 action-conditional prior 替代当前的 deck-prior scoring
- 每个 (deck, matchup) 对生成独立的 artifact router

### 4.3 🟡 Benchmark 报告 Baseline 永远为 0%

`--markdown` 输出中 Baseline 列始终显示 0%，这是已知的实现问题但未修复。这导致 benchmark 报告**看起来毫无意义**——无法直观判断新模型是否真的更好。

**修复方向**: 
- 修改 `run-benchmark.ts` 中的 markdown 生成逻辑，使其真正对比 baseline 和 candidate 的胜率
- 或者至少在报告中标注 "Baseline 列为参考值，非 A/B 对比"
- 更好的方案：运行两次 benchmark（一次用 baseline 策略，一次用 candidate），计算胜率差

### 4.4 🟡 过时的 benchmark JSON 文件

`gi-agent/output/` 下有约 40 个 `benchmark-*.json` 文件，大部分来自历史迭代。建议：
- 保留最近 3-5 个有意义的 benchmark
- 其余归档到 `output/archive/` 或删除
- 在 `.gitignore` 中排除 `output/benchmark-*.json`（只保留有意义的命名）

---

## 5. 优先级排序

| 优先级 | 项目 | 工作量 | 影响 |
|--------|------|--------|------|
| **P0** | 修复 EvaluatorPolicy 绕过父类的 bug | 1-2h | 直接影响 evaluator 策略质量 |
| **P0** | 修复包边界（contracts 统一到 gi-ml） | 4-8h | 消除编译脆弱性 |
| **P0** | `.lgbm-venv` 从 git 移除 + gitignore | 10min | 仓库卫生 |
| **P0** | 移除 `anal.ps1` 中硬编码的 API key | 5min | 安全 |
| **P1** | SPL 形式化文档 | 4h | 降低后续开发认知成本 |
| **P1** | gi-ml-policy.ts 拆分 | 4-6h | 代码可维护性 |
| **P1** | Transition-based scoring 原型 | 8-16h | 突破线性叠加瓶颈 |
| **P1** | Python 训练器代码去重 | 2h | 维护成本 |
| **P1** | `unified-value-predictor.ts` license header 修复 | 2min | 代码规范 |
| **P2** | Feature 字典文档 | 4h | 特征可解释性 |
| **P2** | Benchmark baseline 对比修复 | 2h | 评估可信度 |
| **P2** | 清理过时的 benchmark JSON (~40个) | 30min | 目录整洁 |
| **P2** | 归档过时文档 + 更新 INDEX.md | 1h | 减少认知噪音 |
| **P2** | 新建 compare-artifacts CLI | 4h | 实验追踪效率 |
| **P2** | 修复脚本 deck code 不一致 | 1h | 脚本可靠性 |

---

## 6. 实施任务清单

> 以下任务可以直接分配给 agent 执行。每个任务标注了涉及的文件和验证方式。

### Task 1: 修复 EvaluatorPolicy 继承绕过 [P0]

**涉及文件**:
- `packages/gi-agent/src/runtime/policy/evaluator-policy.ts`
- `packages/gi-agent/src/runtime/policy/baseline-policy.ts`

**步骤**:
1. 阅读 `evaluator-policy.ts` 的 `choose()` 方法
2. 阅读 `baseline-policy.ts` 的 `choose()` 方法，标记被跳过的逻辑（ban list, turn plan, dice reservation, SPL, exploration）
3. 将被跳过的逻辑抽取为独立函数（`applyBanListAndFilters`, `generateTurnPlan`, `applyExploration`）
4. 在 `EvaluatorPolicy.choose()` 中显式调用这些函数
5. 验证：`cd packages/gi-agent && pnpm test src/runtime/policy/`

### Task 2: 修复包边界 [P0]

**涉及文件**:
- `packages/gi-ml/src/contracts/rl-types.ts`
- `packages/gi-agent/src/learning/rl/types.ts`
- `packages/gi-agent/package.json`
- `packages/gi-ml/package.json`

**步骤**:
1. 对比两个 `rl-types.ts`，确认 `gi-ml` 版本是超集
2. 如有缺失类型，合并到 `gi-ml/src/contracts/rl-types.ts`
3. 在 `gi-agent` 中搜索所有对 `../rl/types` 或 `../../rl/types` 的导入
4. 替换为 `@gi-tcg/ml/contracts`
5. 删除 `gi-agent/src/learning/rl/types.ts`
6. 验证：`cd packages/gi-agent && pnpm run check && pnpm test`

### Task 3: 清理 Python Venv 和 Pycache [P0]

**涉及文件**:
- `.gitignore`（项目根目录）
- `packages/gi-ml/python/.lgbm-venv/`

**步骤**:
1. 在 `.gitignore` 中添加：
   ```
   packages/gi-ml/python/.lgbm-venv/
   packages/gi-ml/python/.venv/
   **/__pycache__/
   *.pyc
   ```
2. 运行 `git rm -r --cached packages/gi-ml/python/.lgbm-venv/`
3. 运行 `find packages/ -name "__pycache__" -exec git rm -r --cached {} +`
4. 验证：`git status` 确认变更正确

### Task 4: 移除硬编码 API Key [P0]

**涉及文件**:
- `packages/gi-agent/anal.ps1`

**步骤**:
1. 搜索文件中的 `api-key` 或 `API_KEY` 或 `sk-` 等模式
2. 替换为环境变量引用 `$env:OPENAI_API_KEY`
3. 如果 key 已提交到 git 历史，考虑轮换 key

### Task 5: 拆分 gi-ml-policy.ts [P1]

**涉及文件**:
- `packages/gi-agent/src/runtime/policy/gi-ml-policy.ts` (1723 行)

**步骤**:
1. 分析文件结构，标记每个评分组件的起止行
2. 创建 `packages/gi-agent/src/runtime/policy/scorers/` 目录
3. 将每个评分组件抽取到独立文件：
   - `ranker-scorer.ts` — rankerScore 计算
   - `value-scorer.ts` — valueAdjustment + strategicValueAdjustment
   - `reaction-chain-scorer.ts` — reactionChainAdjustment
   - `macro-plan-scorer.ts` — macroPlanAdjustment
   - `search-scorer.ts` — searchAdjustment
   - `opponent-scorer.ts` — opponentAdjustment
   - `followup-scorer.ts` — followupAdjustment
   - `temporal-scorer.ts` — temporal/profile 相关评分
4. 在 `gi-ml-policy.ts` 中 import 这些模块，保留 `choose()` 主循环
5. 验证：`cd packages/gi-agent && pnpm run check && pnpm test src/runtime/policy/`

### Task 6: Python 训练器代码去重 [P1]

**涉及文件**:
- `packages/gi-ml/python/gitcg_ml/train_lgbm_value.py` (425 行)
- `packages/gi-ml/python/gitcg_ml/train_moe_value.py` (562 行)

**步骤**:
1. 创建 `packages/gi-ml/python/gitcg_ml/_training_common.py`
2. 将共享代码移入：
   - `flatten_feature_slots()`
   - `is_categorical_feature()`
   - `FORCE_INCLUDE_FEATURES`
   - 通用 argparse 配置函数
   - 通用训练循环辅助函数（如有）
3. 两个训练器改为 `from ._training_common import ...`
4. 验证：`cd packages/gi-ml && pnpm run py:test`

### Task 7: 统一 value predictor license header [P1]

**涉及文件**:
- `packages/gi-ml/src/value/unified-value-predictor.ts`

**步骤**:
1. 将 AGPL license 注释块移到文件第 1 行
2. 验证：`cd packages/gi-ml && pnpm run check`

### Task 8: SPL 形式化文档 [P1]

**涉及文件**:
- `packages/gi-agent/src/runtime/plan/` 目录下 9 个文件
- 新建 `packages/gi-agent/docs/spl-spec.md`

**步骤**:
1. 阅读 `src/runtime/plan/` 所有文件，理解：
   - SPL 语法和 schema
   - 编译器流程
   - Dice budget 分配逻辑
   - 状态机转换
2. 撰写 `spl-spec.md`，包含：
   - SPL 概述和目标
   - 语法定义（BNF 或示例）
   - 编译器 pipeline 图
   - Dice budget 算法
   - 状态机转换表
   - 与 GiMlPolicy 的集成方式
3. 在 `INDEX.md` 中注册新文档

### Task 9: Feature 字典文档 [P2]

**涉及文件**:
- `packages/gi-ml/python/gitcg_ml/train_lgbm_value.py` 中的 FORCE_INCLUDE_FEATURES
- `packages/gi-agent/src/learning/rl/` 中 observation 构建相关代码
- 新建 `packages/gi-agent/docs/feature-dictionary.md`

**步骤**:
1. 从代码中提取所有特征名（搜索 `FORCE_INCLUDE_FEATURES`、observation builder 等）
2. 按类别分组（pending_method, self_active, opponent_active, self, opponent, temporal 等）
3. 为每个特征写一行说明：名称、类型、含义、取值范围
4. 在 `INDEX.md` 中注册

### Task 10: 归档过时文档 [P2]

**步骤**:
1. 将以下文件移到 `packages/gi-agent/docs/archive/`：
   - `opponent-modeling-gaps.md`
   - `temporal-reasoning-solution.md`
2. 从 `ai-decision-framework-v2.md` 中提取仍有效的核心洞察（阶段转换触发器表格、Mulligan 策略逻辑）追加到 SPL 文档
3. 更新 `INDEX.md`：移动对应条目到 🔴 归档区

### Task 11: Benchmark Baseline 对比修复 [P2]

**涉及文件**:
- `packages/gi-agent/src/evaluation/benchmark/cli/run-benchmark.ts`

**步骤**:
1. 找到 markdown 输出中 Baseline 列的生成逻辑
2. 修复为真正的 A/B 对比（或添加注释说明）
3. 验证：运行一次 smoke benchmark，确认输出格式正确

### Task 12: 清理过时 benchmark JSON [P2]

**步骤**:
1. 列出 `packages/gi-agent/output/benchmark-*.json`
2. 保留最近 3-5 个有意义的
3. 其余移到 `output/archive/` 或删除
4. 可选：在 `.gitignore` 中排除 `output/benchmark-*.json`

---

## 附录：当前架构亮点（无需修改）

以下部分设计优秀，修改时应保留和参考：

- **MCTS 引擎** (`src/mcts/mcts.ts`) — PUCT 实现干净，配置化程度高
- **Combat Window Pipeline** — 24 个文件，管线完整
- **RL 类型系统** (`src/learning/rl/types.ts`) — V1 版本化设计合理
- **SPL 模块** (`src/runtime/plan/`) — 编译器/状态机/Dice budget 设计精巧
- **SlotLinearRanker** — 四层评分清晰可解释
- **Runtime Bridge** (`gi-ml/src/runtime/bridge.ts`) — 推理封装完整
- **数据契约** (`gi-ml/docs/data-contracts.md`) — ID 策略和对象边界清晰
- **概念验证管线** — draft→validated→deprecated 生命周期管理成熟
