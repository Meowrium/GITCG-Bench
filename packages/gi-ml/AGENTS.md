# `@gi-tcg/ml` AGENTS.md

`gi-ml` 是七圣召唤**学习子系统工作区**：把 `gi-agent` 产出的 branch-eval / combat-window / replay / self-play 证据整理为可训练数据，并产出可版本化的 concept bank、ranker artifact、value artifact、runtime bridge。

## 不做什么

- 不重写模拟器（规则 → `@gi-tcg/core`）
- 不接管运行时决策（→ `@gi-tcg/agent`）
- 不直接修改卡牌定义（→ `@gi-tcg/data`）
- TypeScript 仅做契约 + 离线数据管线 + 轻量预测；模型训练主力在 `python/`

## 包结构契约

```
src/
├── cli/
│   ├── build/      # 构建 concept bank、ranker、value artifact
│   ├── evaluate/   # 评估 ranker / value artifact
│   ├── export/     # 数据集与概念候选导出
│   ├── pipeline/   # 多步流水线（warm-start、formal-train、iterative）
│   └── query/      # rank-dataset-query、merge-ranking、nonlinear-comparison
├── concept-bank/        # bank 构建 + JSON repository + merge
├── concept-discovery/   # branch-eval / combat-window / combo / static-effect-seed 概念发现
├── concept-validation/  # 概念升级判定
├── contracts/           # TS 共享契约（rl-types、value、ranking、concepts、common）
├── datasets/            # branch-eval / rl / rl-value / rl-q-value / holdout / merge
├── io/                  # cli-path、json
├── ranker/              # slot_linear_ranker.v1 基线
├── runtime/             # bridge artifact（供 gi-agent runtime 消费）
├── utils/               # flatten 等工具
└── value/               # 线性 / 非线性 value artifact

python/
└── gitcg_ml/            # Python 训练子项目（concept_targets / concept_model / slot_linear / value_linear / GBDT / GBRL / LGBM / MoE）
```

## CLI 入口（package.json scripts）

| script | 说明 | 源 |
|---|---|---|
| `export:branch-eval-dataset` | branch-eval → ranking dataset | `cli/export/` |
| `export:rl-{ranking,value}-dataset` | RL 数据集导出 | `cli/export/` |
| `export:branch-eval-{combo-,}concepts` | branch-eval 概念候选 | `cli/export/` |
| `export:static-effect-seed-concepts` | 静态效果种子概念 | `cli/export/` |
| `merge:ranking-datasets` | 合并多份 ranking 数据集 | `cli/query/` |
| `build:concept-bank` / `build:discovered-concept-bank` | 单路 / 多路概念库 | `cli/build/` |
| `build:slot-linear-ranker` / `build:gbdt-value` | 基线 artifact | `cli/build/` |
| `evaluate:slot-linear-ranker` / `evaluate:rl-value-artifact` | 离线评估 | `cli/evaluate/` |
| `rank:dataset-query` | 单 query 离线排序结果 | `cli/query/` |
| `compare:nonlinear` | 非线性对比 | `cli/query/` |
| `pipeline:rl-warm-start{,-bundle}` / `pipeline:rl-value-warm-start` / `pipeline:rl-formal-train` / `pipeline:branch-eval-baseline` / `pipeline:iterative` | 多步流水线 | `cli/pipeline/` |

Python 训练入口：

| script | 说明 |
|---|---|
| `pnpm run py:test` | unittest 全套 |
| `pnpm run build:concept-targets:py` | concept targets |
| `pnpm run train:concept-model:py` | concept 模型 |
| `pnpm run train:slot-linear-ranker:py` | slot linear ranker |
| `pnpm run train:linear-value-model:py` | linear value 模型 |

辅助 shell：`scripts/run-{trio-,}concept-training-pipeline.{ps1,sh}`、`scripts/run-trio-{branch-eval-baseline,benchmark-pipeline,concept-policy-benchmark}.{ps1,sh}`。

## 与 `@gi-tcg/agent` 的边界

- **gi-agent 生产证据**：self-play 日志、benchmark 报告、branch-eval 结果、tree-lake、runtime digest
- **gi-ml 消费证据**：通过 `cli/export/run-export-*` 把上述证据展平为 ranking / value 数据集；通过 `concept-discovery` 抽取概念候选
- **gi-ml 产出 artifact**：concept bank JSON、slot-linear-ranker JSON、value artifact JSON、runtime bridge JSON
- **gi-agent 运行时消费 artifact**：通过 `gi-ml/runtime/bridge` 在 policy 层注入

理想形式：gi-agent 不再自定义 `learning/rl/types.ts` / `reward-config.ts`，统一从 `@gi-tcg/ml/contracts` 导入。Sprint 3 边界重划任务。

## 公共 exports（package.json）

```
@gi-tcg/ml
@gi-tcg/ml/contracts
@gi-tcg/ml/runtime
@gi-tcg/ml/ranker
@gi-tcg/ml/value
@gi-tcg/ml/utils
```

## 测试约定

- colocated `*.test.ts`
- `pnpm run test`（vitest，扫 src/）
- `pnpm run py:test`（Python unittest）
- 不再使用 `__tests__/` 子目录

## 文档导航

- [docs/architecture.md](./docs/architecture.md) — 系统边界与运行时桥接
- [docs/data-contracts.md](./docs/data-contracts.md) — query_id / candidate_id / concept_id / bank_version 契约
- [docs/roadmap.md](./docs/roadmap.md) — 从契约到 concept bottleneck 集成的分阶段路线
- [docs/static-effect-meta-priors.md](./docs/static-effect-meta-priors.md) — 静态效果 → meta priors / concept seeds 方案
- 上层框架：[../gitcg-theory/framework.md](../gitcg-theory/framework.md)、[../gitcg-theory/rl-implementation-spec.md](../gitcg-theory/rl-implementation-spec.md)
