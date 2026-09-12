# `@gi-tcg/ml`

`gi-ml` 是七圣召唤学习子系统的独立工作区，用来把 `gi-agent` 产出的 `branch-eval`、`combat-window`、`replay`、`self-play` 等证据整理成可训练数据，并进一步产出：

- 可版本化的 `concept bank`
- 可解释的 concept model / ranker / value artifact
- 供在线 runtime 消费的轻量 bridge artifact
- 面向 RL warm start 与后续 formal training 的统一数据接口

它不重写模拟器，也不接管规则正确性。规则执行仍由 `@gi-tcg/core` 与 `@gi-tcg/agent` 保证，`gi-ml` 只负责学习层。

## 定位

- 上游：`packages/gi-agent`
  - 负责运行时决策、搜索、数据采集、`branch-eval`、`combat-window`、benchmark / replay 产物
- 本包：`packages/gi-ml`
  - 负责数据契约、概念发现、概念验证、概念库构建、排序 / 价值基线、训练工件导出
- 下游：`packages/gi-agent` runtime
  - 消费 `concept bank`、`concept model`、`ranker artifact`、`value artifact` 与解释元数据

长期方向是：

- TypeScript 继续承担 simulator / runtime / bridge
- Python 工作区承担训练与实验

这与 `packages/gitcg-theory` 和本包 `docs/` 中的设计口径保持一致。

## 与理论文档的对齐

`gi-ml` 当前实现遵循 `packages/gitcg-theory` 中已经明确的几条主线：

- 决策单位以 `decision point / query-group` 为核心，而不是平面的 `(state, action, label)`
- 动作空间采用“合法候选列表 + 组内排序”而不是全局大离散动作空间
- reward / value / ranking 分层处理，终局信号仍然是主锚点
- 概念学习走 `draft -> validated -> deprecated` 生命周期
- 静态卡牌 / 技能效果可以被整理成 `effect family / meta slots / concept seeds`
- 第一阶段先做离线 warm start 和可解释 baseline，再逐步向 formal RL 训练推进

换句话说，`gi-ml` 不是“另起一套黑盒模型训练”，而是把理论包里的决策框架落成稳定接口和可运行流水线。

## 当前已落地的能力

当前仓库里的 `gi-ml` 已经不只是文档骨架，已经覆盖了几条可运行主线：

- `branch-eval -> ranking dataset` 导出
- `branch-eval / combat-window / combo-window / static-effect-seed` 概念发现
- `concept validation` 与多路概念合并建库
- TS 侧 `slot_linear_ranker.v1` 构建、诊断与 runtime bridge
- TS 侧 `linear value artifact` 评估与 bridge
- Python 侧 concept targets / concept model / slot-linear ranker / linear value trainer
- RL ranking dataset / RL value dataset 导出
- RL warm start bundle / pipeline / formal training pipeline 骨架
- trio benchmark / branch-eval / concept training 一键脚本

当前更准确的状态是：

- 数据契约、概念管线、基线 ranker / value、bridge artifact 已经可跑
- 更强的 concept bottleneck、formal RL、online self-play 闭环仍处于持续推进中

## 文档导航

### `packages/gi-ml/docs`

- [`docs/architecture.md`](./docs/architecture.md)
  - `gi-ml` 的系统边界、模块划分、runtime export bridge
- [`docs/data-contracts.md`](./docs/data-contracts.md)
  - `query_id`、`candidate_id`、`concept_id`、`bank_version` 等核心对象契约
- [`docs/roadmap.md`](./docs/roadmap.md)
  - 从文档与契约、到概念验证、到 concept bottleneck 集成的分阶段路线
- [`docs/static-effect-meta-priors.md`](./docs/static-effect-meta-priors.md)
  - 将静态卡牌 / 技能效果编译为跨牌共享 meta priors 与 concept seeds 的方案

### `packages/gitcg-theory`

- [`../gitcg-theory/framework.md`](../gitcg-theory/framework.md)
  - 七圣召唤决策问题的总框架：状态、操作、价值、窗口、风险、展开线
- [`../gitcg-theory/rl-implementation-spec.md`](../gitcg-theory/rl-implementation-spec.md)
  - `observation schema v1`、`candidate action schema v1`、`reward config v1`、`training protocol v1`
- [`../gitcg-theory/static-effect-meta-priors-for-rl.md`](../gitcg-theory/static-effect-meta-priors-for-rl.md)
  - 如何把静态效果族、meta slots、concept seeds 接入 RL / warm start / concept pipeline

推荐阅读顺序：

1. 先读 `framework.md`
2. 再读 `rl-implementation-spec.md`
3. 再回到本包的 `docs/architecture.md` 和 `docs/data-contracts.md`
4. 需要做静态语义增强时，再看两份 `static-effect-meta-priors*` 文档

## 目录概览

```text
packages/gi-ml/
  README.md
  docs/
  schemas/
  scripts/
  python/
  src/
    cli/
    concept-bank/
    concept-discovery/
    concept-validation/
    contracts/
    datasets/
    ranker/
    runtime/
    value/
```

核心模块职责：

- `src/contracts`
  - TS 侧共享契约
- `src/datasets`
  - `branch-eval`、RL ranking / RL value 数据集构建
- `src/concept-discovery`
  - `combat-window`、`combo-window`、`branch-eval`、`static-effect-seed` 概念发现
- `src/concept-validation`
  - 概念验证摘要与升级判定
- `src/concept-bank`
  - 建库、合并、JSON repository
- `src/ranker`
  - `slot_linear_ranker.v1` 基线
- `src/value`
  - 线性 value artifact 基线
- `src/runtime`
  - 运行时 bridge 与轻量预测接口
- `python/`
  - Python 训练工作区

## 常用命令

### 基础检查

```powershell
cd packages/gi-ml
pnpm run check
pnpm run test
pnpm run py:test
```

### 1. 导出 `branch-eval` 排序数据

```powershell
cd packages/gi-ml
pnpm run export:branch-eval-dataset -- `
  --input ../gi-agent/prior-v2/output/branch-eval-shuining-mirror.json `
  --output ./output/branch-eval-dataset.json
```

### 2. 发现概念候选

`branch-eval`:

```powershell
cd packages/gi-ml
pnpm run export:branch-eval-concepts -- `
  --input ./output/branch-eval-dataset.json `
  --output ./output/branch-eval-concepts.json
```

`branch-eval combo`:

```powershell
cd packages/gi-ml
pnpm run export:branch-eval-combo-concepts -- `
  --input ./output/branch-eval-dataset.json `
  --output ./output/branch-eval-combo-concepts.json
```

`combat-window`:

```powershell
cd packages/gi-ml
pnpm run export:combat-window-concepts -- `
  --tree-lake ../gi-agent/output/combat-windows/tree-lake.sqlite `
  --status all `
  --output ./output/combat-window-concepts.json
```

`combo-window`:

```powershell
cd packages/gi-ml
pnpm run export:combo-window-concepts -- `
  --tree-lake ../gi-agent/output/combat-windows/tree-lake.sqlite `
  --status all `
  --output ./output/combo-window-concepts.json
```

`static-effect-seed`:

```powershell
cd packages/gi-ml
pnpm run export:static-effect-seed-concepts -- `
  --input ./output/branch-eval-dataset.json `
  --output ./output/static-effect-seed-concepts.json
```

### 3. 构建 concept bank

单路输入：

```powershell
cd packages/gi-ml
pnpm run build:concept-bank -- `
  --input ./output/combat-window-concepts.json `
  --bank-version bank_local_v1 `
  --output ./output/concept-bank.json
```

多路合并：

```powershell
cd packages/gi-ml
pnpm run build:discovered-concept-bank -- `
  --inputs ./output/combat-window-concepts.json,./output/branch-eval-concepts.json,./output/static-effect-seed-concepts.json `
  --bank-version bank_discovered_v1 `
  --output ./output/concept-bank.discovered.json
```

### 4. 构建并评估排序 / 价值基线

排序基线：

```powershell
cd packages/gi-ml
pnpm run build:slot-linear-ranker -- `
  --input ./output/branch-eval-dataset.json `
  --output ./output/ranker-artifact.json

pnpm run evaluate:slot-linear-ranker -- `
  --dataset ./output/branch-eval-dataset.json `
  --artifact ./output/ranker-artifact.json `
  --output ./output/ranker-eval.json
```

离线查看单个 query 排序结果：

```powershell
cd packages/gi-ml
pnpm run rank:dataset-query -- `
  --dataset ./output/branch-eval-dataset.json `
  --artifact ./output/ranker-artifact.json `
  --index 0 `
  --output ./output/rank-result.json
```

价值基线评估：

```powershell
cd packages/gi-ml
pnpm run evaluate:rl-value-artifact -- `
  --dataset ./output/rl-value-dataset.json `
  --artifact ./output/value-artifact.json `
  --output ./output/value-eval.json
```

### 5. Python 训练工作区

推荐在 `packages/gi-ml/python` 下使用独立环境，尤其是需要更完整训练依赖时优先走 `WSL Ubuntu`。

训练 concept targets / concept model / ranker / value：

```powershell
cd packages/gi-ml/python
python -m gitcg_ml.cli.build_concept_targets `
  --dataset ../output/branch-eval-dataset.json `
  --concept-bank ../output/concept-bank.json `
  --output ../output/concept-targets.python.json

python -m gitcg_ml.cli.train_concept_model `
  --dataset ../output/branch-eval-dataset.json `
  --concept-bank ../output/concept-bank.json `
  --concept-targets ../output/concept-targets.python.json `
  --output ../output/concept-model.python.json

python -m gitcg_ml.cli.train_slot_linear_ranker `
  --input ../output/branch-eval-dataset.json `
  --output ../output/ranker-artifact.python.json

python -m gitcg_ml.cli.train_linear_value_model `
  --input ../output/rl-value-dataset.json `
  --output ../output/value-artifact.python.json
```

## 当前推荐流程

### A. `branch-eval` 排序基线

适合：

- 验证数据契约
- 快速做 ranker baseline
- 检查 `query-group` 和 candidate slots 是否稳定

推荐入口：

```powershell
cd packages/gi-ml
pnpm run pipeline:branch-eval-baseline -- `
  --input ../gi-agent/prior-v2/output/branch-eval-shuining-mirror.json `
  --dataset-output ./output/branch-eval-dataset.json `
  --artifact-output ./output/ranker-artifact.json `
  --evaluation-output ./output/ranker-eval.json
```

### B. concept training pipeline

适合：

- 从 `branch-eval` / `tree-lake` 构建 concept bank
- 训练 concept model 与 Python ranker
- 验证 static-effect-seed / combo concepts 是否真正带来增益

推荐入口：

```powershell
pwsh -File .\packages\gi-ml\scripts\run-concept-training-pipeline.ps1 -TrainPreset laptop
```

或在 WSL 下：

```bash
bash packages/gi-ml/scripts/run-concept-training-pipeline.sh
```

### C. trio 一键基线与训练

适合：

- 基于 `packages/gi-agent/trio_deck.txt` 批量生成 matchup
- 一次跑 benchmark、branch-eval、baseline pipeline
- 在 trio 数据上继续做 concept training

推荐入口：

```bash
bash packages/gi-ml/scripts/run-trio-branch-eval-baseline.sh
```

```powershell
pwsh -File .\packages\gi-ml\scripts\run-trio-concept-training.ps1 -TrainPreset laptop
```

### D. RL warm start / formal pipeline

适合：

- 为 `packages/gitcg-theory/rl-implementation-spec.md` 里的 `observation / action / reward / training protocol` 做实现落点
- 构建 RL ranking / value 数据集
- 逐步接通 formal RL 训练闭环

当前入口：

```powershell
cd packages/gi-ml
pnpm run export:rl-ranking-dataset -- `
  --input ./output/rl-input.json `
  --output ./output/rl-ranking-dataset.json

pnpm run export:rl-value-dataset -- `
  --input ./output/rl-input.json `
  --output ./output/rl-value-dataset.json

pnpm run pipeline:rl-warm-start -- `
  --input ./output/rl-input.json `
  --dataset-output ./output/rl-ranking-dataset.json `
  --artifact-output ./output/rl-slot-linear-ranker.json `
  --evaluation-output ./output/rl-slot-linear-ranker-eval.json

pnpm run pipeline:rl-warm-start-bundle -- `
  --input ./output/rl-input.json `
  --output-dir ./output/rl-warm-start-bundle

pnpm run pipeline:rl-formal-train -- `
  --input ./output/rl-input.json `
  --output-dir ./output/rl-formal-train
```

## 设计原则

本包当前默认遵守以下原则：

- 规则正确性不下放给模型
- 概念、排序、价值、runtime bridge 都要版本化
- 所有监督信号尽量保留到 `evidence_ref`
- 先固定 contract，再放开训练目标与模型复杂度
- 先做可解释、可回放、可诊断的 baseline，再追求更强模型
- `static effect meta priors` 是增强项，不应与 reward shaping 重复记账

## 当前阶段

如果只看路线图，`gi-ml` 目前已经跨过了“纯文档占位”的阶段，进入了：

- 文档与契约已基本成型
- 数据导出与概念管线已能运行
- ranker / value / runtime bridge 已有基线实现
- RL formal contract 正在向训练闭环靠拢

因此，当前最适合把它理解成：

> 一个围绕 `decision point`、`concept bank`、`ranking/value artifact` 和 `RL warm start` 组织起来的学习工作区，而不是单一训练脚本集合。
