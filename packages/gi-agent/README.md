# @gi-tcg/agent

`@gi-tcg/agent` 当前已经从“LLM graph 为中心”调整成“policy + benchmark + learning 为中心”的实验包。

如果你想用统一前端来管理卡组和 benchmark 配置，见 [packages/gi-agent-ui](/D:/AI/GTCG/genius-invokation/packages/gi-agent-ui)。

现阶段最推荐的用途有四个：

- 跑本地 benchmark，验证某个 policy/evaluator 是否变强
- 用 `PolicyPlayerIO` 把本地 policy 接到 `@gi-tcg/core` 的 `Game`
- 用 `DataLake + LogisticCalibrator` 训练一个简单 evaluator
- 用 `battle-agent + combat-window pipeline` 把 LLM 对局整理成可验证的局部窗口树库

不推荐把它理解成已经成型的“最终对战 AI 产品”。`battle-graph` 和 `battle-agent` 仍然保留，但现在更适合作为实验入口，而不是主闭环。

## 当前结构

```text
src/
├── runtime/
│   ├── io/                # Policy -> PlayerIO 桥接
│   ├── policy/            # BaselinePolicy / EvaluatorPolicy
│   ├── search/            # BoundedSearcher
│   ├── adapters/          # SimAdapter
│   └── eval-baselines/    # delta / heuristic / feasibility
├── evaluation/benchmark/  # benchmark suite + report + CLI
├── learning/              # data / features / training
├── knowledge/             # character profiles / deck priors
├── graphs/                # battle-graph（实验层）
├── agents/                # battle-agent / scoring-auditor
├── ml/                    # 旧版 feature/logistic 核心
└── sandbox/               # SandboxRunner
```

## 安装

在仓库根目录执行：

```bash
pnpm install
```

然后进入包目录：

```bash
cd packages/gi-agent
```

## 推荐使用路径

如果你要走“基于 agent 的自动学习路线”，建议直接按下面这条闭环用，而不是先从 `battle-agent` 开始：

1. 用 [packages/gi-agent-ui](/D:/AI/GTCG/genius-invokation/packages/gi-agent-ui) 整理卡组和 benchmark 配置
2. 跑 `benchmark` 固定基线，先确认 baseline policy 的稳定报表
3. 跑 `self-play` 补动作样本到 `DataLake`
4. 跑 `iterate` 自动完成“训练 evaluator -> baseline 对比 -> promote/reject 报告”
5. 只把通过 benchmark 的权重接回 `EvaluatorPolicy`
6. 最后才用 `battle-agent` 做 LLM / MCP 实验和失败复盘

一句话说：

- `benchmark / self-play / iterate` 是主闭环
- `battle-agent` 是实验闭环
- LLM 在你现在这套里不是训练和评测的必需品

如果你要做“LLM 对局日志 -> 局部窗口树 -> 离线验证 -> replay/branch-eval 补强 -> library 检索/评估（含 runtime query 与 workload 覆盖）”的一阶段种子树流程，见 [docs/combat-window-pipeline.md](/D:/AI/GTCG/genius-invokation/packages/gi-agent/docs/combat-window-pipeline.md)。

如果你只想先抓重点，可以把 `gi-agent` 的使用路径分成两条：

- `benchmark / self-play / iterate`
  当前主闭环，用来训练和验证本地 policy/evaluator
- `battle / combat-window:* / branch-eval`
  LLM 实验闭环，用来沉淀局部窗口树、离线树库和检索评估

两条路径并不冲突：

- 主闭环负责稳定强度验证
- LLM 实验闭环负责高语义的局部策略提炼

## Combat Window Tree 流水线

如果你的目标是“先让 LLM 对弈，再把日志压成可复用的局部树”，现在已经有一套完整的一阶段 CLI。

最小闭环分成 5 步：

1. 用 `battle` 产出 `runtime-plans`
2. 用 `combat-window:extract` 切出 2 到 4 动作窗口
3. 用 `combat-window:analyze` 让 LLM 赛后生成 `combat_window_plan`
4. 用 `combat-window:validate` 做 schema / replay-line / legality 校验
5. 视需要继续做 replay 对齐、branch-eval 导入、library 检索和 workload 覆盖评估

一个典型的命令序列是：

```powershell
cd packages/gi-agent
pnpm run combat-window:extract --runtime-plans-dir ./runtime-plans --output ./output/combat-windows/windows.json
pnpm run combat-window:analyze --input ./output/combat-windows/windows.json --tree-lake ./output/combat-windows/tree-lake.sqlite
pnpm run combat-window:validate --tree-lake ./output/combat-windows/tree-lake.sqlite --status draft
pnpm run combat-window:export-library --tree-lake ./output/combat-windows/tree-lake.sqlite --status promoted --output ./output/combat-windows/library.json
pnpm run combat-window:evaluate-workload --library ./output/combat-windows/library.json --runtime-plans-dir ./runtime-plans
```

补充说明：

- `combat-window:align-replay`
  用 benchmark/replay 给 tree 补稳定锚点和 `canonical_fingerprint`
- `branch-eval` + `combat-window:import-branch-eval`
  用 continuation 结果给 tree 增加 promotion evidence
- `combat-window:query-library`
  spot check 单个窗口会召回哪些树
- `combat-window:evaluate-library`
  评估 `runtime / window / canonical` 三种 query mode 的召回质量
- `combat-window:evaluate-workload`
  评估一批真实 benchmark/self-play workload 能被树库接住多少

完整参数和示例见 [docs/combat-window-pipeline.md](/D:/AI/GTCG/genius-invokation/packages/gi-agent/docs/combat-window-pipeline.md)。

### 1. 跑 benchmark

这是当前最重要的入口。

```bash
pnpm run benchmark examples/configs/benchmark.example.json
```

如果要输出结果文件：

```bash
pnpm run benchmark examples/configs/benchmark.example.json --output benchmark-result.json --markdown benchmark-report.md
```

示例配置见 [examples/configs/benchmark.example.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/examples/configs/benchmark.example.json)。
更细的配置说明见 [examples/BENCHMARK_GUIDE.md](./examples/BENCHMARK_GUIDE.md)。
模板文件见 [examples/TEMPLATES.md](./examples/TEMPLATES.md)。

当前配置格式：

```json
{
  "version": "v6.3.0",
  "matchups": [
    {
      "id": "sample-baseline-mirror",
      "deck0": "deck code A",
      "deck1": "deck code B",
      "games": 10,
      "sideA": {
        "name": "baseline-a",
        "kind": "baseline",
        "options": {
          "endTurnPenalty": 5
        }
      },
      "sideB": {
        "name": "baseline-b",
        "kind": "baseline",
        "options": {
          "endTurnPenalty": 5
        }
      }
    }
  ]
}
```

`sideA/sideB` 目前支持两种 policy：

- `baseline`
- `evaluator`

`evaluator` 需要提供训练好的权重文件路径：

```json
{
  "name": "lr-policy",
  "kind": "evaluator",
  "weightsPath": "./weights.json"
}
```

benchmark CLI 入口在 [run-benchmark.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/evaluation/benchmark/cli/run-benchmark.ts)。

### 2. 直接在代码里跑本地对局

最小用法是把 policy 包成 `PlayerIO`，然后交给 `SandboxRunner` 或 `Game`。

```ts
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import {
  SandboxRunner,
  BaselinePolicy,
  PolicyPlayerIO,
} from "@gi-tcg/agent"

const runner = new SandboxRunner()
const policyA = new BaselinePolicy()
const policyB = new BaselinePolicy({ endTurnPenalty: 4 })

const batch = await runner.runBatch({
  decks: [deck0, deck1],
  data: getData(CURRENT_VERSION),
  createPlayerIO: [
    () => new PolicyPlayerIO({ side: 0, policy: policyA }),
    () => new PolicyPlayerIO({ side: 1, policy: policyB }),
  ],
  games: 20,
})

console.log(batch.winRateP0)
```

相关文件：

- [policy-player-io.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/io/policy-player-io.ts)
- [baseline-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/baseline-policy.ts)
- [evaluator-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/evaluator-policy.ts)
- [runner.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/sandbox/runner.ts)

### 3. 训练一个 evaluator

当前训练入口是把 `DataLake` 里的样本读出来，训练 Logistic Regression，然后输出权重文件。

库函数入口：

```ts
import { trainEvaluatorFromDataLake } from "@gi-tcg/agent"

const result = trainEvaluatorFromDataLake({
  dbPath: "./output/data.db",
  outputPath: "./output/weights.json",
  options: {
    epochs: 200,
    lr: 0.01,
    lambda: 0.001,
  },
})

console.log(result.sampleCount)
console.log(result.outputPath)
```

相关文件：

- [train-evaluator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/training/train-evaluator.ts)
- [data-lake.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/db/data-lake.ts)
- [feature-extractor.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/scoring/feature-extractor.ts)
- [logistic-reg.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/scoring/logistic-reg.ts)

### 4. 自动跑一轮迭代

如果你想把“训练 -> baseline benchmark -> evaluator benchmark -> 报告”串成一条命令，现在可以直接用：

```bash
pnpm run iterate examples/configs/iteration.example.json
```

或者显式指定输出文件：

```bash
pnpm run iterate examples/configs/iteration.example.json --output output/iteration-report.json --markdown output/iteration-report.md
```

示例配置见 [examples/configs/iteration.example.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/examples/configs/iteration.example.json)。

这个命令会做四件事：

- 从 `training.dbPath` 读取 `DataLake`
- 训练一份新的 evaluator 权重
- 先以 baseline 跑目标侧，再以 evaluator 跑目标侧
- 输出 promote / reject 建议

其中 `targetSide` 用来指定比较视角：

- `A`：把 benchmark 里的 `sideA` 当成候选方
- `B`：把 benchmark 里的 `sideB` 当成候选方

如果你希望它先自动补一轮样本再训练，可以在配置里加 `selfPlay`：

```json
{
  "benchmarkPath": "./benchmark.example.json",
  "selfPlay": {
    "gamesMultiplier": 2
  },
  "training": {
    "dbPath": "./output/data.db",
    "outputPath": "./output/weights.iteration.json"
  }
}
```

这样会先按 benchmark 里的卡组和策略做 self-play，把样本写入 `DataLake`，再继续训练和评测。

补充说明：

- 如果本机 `better-sqlite3` 原生绑定不可用，`DataLake` 会自动回退到 `dbPath + .json`
- 这不会阻塞 `self-play` 和 `iterate`，只是存储格式从 SQLite 变成 JSON

### 5. 单独跑 self-play 采样

如果你只想先补训练样本，可以直接跑：

```bash
pnpm run self-play examples/configs/self-play.example.json
```

示例配置见 [examples/configs/self-play.example.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/examples/configs/self-play.example.json)。

这条命令会：

- 读取 benchmark 配置里的卡组
- 用同一批 matchup 做若干局 self-play
- 把动作样本写进 `DataLake`
- 输出每个 matchup 的插入样本数

## Agent 自动学习路线

如果你要把这套东西当成“自动学习 agent”来用，推荐的最小工作流是：

### 第一步：整理 benchmark

先固定一批 matchup，让每次迭代都比较同一批局面。

```bash
pnpm run benchmark examples/configs/benchmark.example.json
```

### 第二步：补 self-play 样本

用当前策略自己对打，给 `DataLake` 补训练样本。

```bash
pnpm run self-play examples/configs/self-play.example.json
```

### 第三步：自动迭代 evaluator

直接跑：

```bash
pnpm run iterate examples/configs/iteration.example.json
```

这会自动做三件事：

- 如果配置里带了 `selfPlay`，先补样本
- 用 `DataLake` 训练 evaluator 权重
- 跑 baseline vs evaluator 对比并给出 `promote` / `reject`

### 第四步：只提升通过 benchmark 的 evaluator

不要因为训练成功就直接替换 runtime。优先看：

- 总胜率有没有提升
- 有没有关键 matchup 明显退化
- 样本量是否足够

你现在真正应该高频使用的命令，一般就是这三个：

```bash
pnpm run benchmark examples/configs/benchmark.example.json
pnpm run self-play examples/configs/self-play.example.json
pnpm run iterate examples/configs/iteration.example.json
```

如果后面要把这条链再自动化一层，应该是在这三条命令外面再包调度，而不是把 LLM 塞进训练环。

## LLM API 设置

当前仓库里，会真正初始化 `ChatOpenAI` 的入口主要有两个：

- [battle-graph.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/graphs/battle-graph.ts)
- [post-analysis.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/learning/combat-windows/post-analysis.ts)

也就是说：

- `benchmark` 不需要 LLM API
- `self-play` 不需要 LLM API
- `iterate` 不需要 LLM API
- `battle` 需要 LLM API
- `combat-window:analyze` 也需要 LLM API

设置方式是环境变量，不是在配置文件里。

最常用的是：

```powershell
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_MODEL="gpt-4o"
```

如果你走 OpenAI 兼容网关，一般还要再设：

```powershell
$env:OPENAI_BASE_URL="https://your-openai-compatible-endpoint/v1"
```

然后再运行：

```powershell
cd packages/gi-agent
pnpm run battle -- --base-url http://localhost:3901
```

或者：

```powershell
cd packages/gi-agent
pnpm run combat-window:analyze --input ./output/combat-windows/windows.json --tree-lake ./output/combat-windows/tree-lake.sqlite
```

现在代码里和 LLM 相关的环境变量有这些：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TEMPERATURE`
- `OPENAI_BASE_URL`
- `GI_SERVER_URL`

其中：

- `OPENAI_MODEL` 和 `OPENAI_TEMPERATURE` 是 [battle-agent.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/agents/battle-agent.ts) 显式读取的
- `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 是 `ChatOpenAI` 的标准环境变量
- `GI_SERVER_URL` 用来指定本地对局服务地址

## 现有 CLI

在 [package.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/package.json) 里，目前真正可用的命令主要是：

```bash
pnpm run check
pnpm run test
pnpm run benchmark examples/configs/benchmark.example.json
pnpm run branch-eval ./prior-v2/branch-eval.shuining-mirror.json
pnpm run iterate examples/configs/iteration.example.json
pnpm run self-play examples/configs/self-play.example.json
pnpm run self-play:topup ./prior-v2/output/self-play-topup-plan.json
pnpm run scoring:audit
pnpm run battle
pnpm run combat-window:extract --runtime-plans-dir ./runtime-plans
pnpm run combat-window:analyze --input ./output/combat-windows/windows.json
pnpm run combat-window:validate --tree-lake ./output/combat-windows/tree-lake.sqlite
pnpm run combat-window:align-replay --tree-lake ./output/combat-windows/tree-lake.sqlite
pnpm run combat-window:import-branch-eval --tree-lake ./output/combat-windows/tree-lake.sqlite
pnpm run combat-window:export-library --tree-lake ./output/combat-windows/tree-lake.sqlite
pnpm run combat-window:query-library --library ./output/combat-windows/library.json
pnpm run combat-window:evaluate-library --library ./output/combat-windows/library.json
pnpm run combat-window:evaluate-workload --library ./output/combat-windows/library.json
```

说明：

- `check`：TypeScript 检查
- `test`：包内测试
- `benchmark`：本地 benchmark CLI，当前最推荐
- `branch-eval`：对 replay/action point 做 continuation 分支评估
- `iterate`：自动训练 evaluator 并和 baseline 做一次完整对比
- `self-play`：批量采样对局动作并写入 `DataLake`
- `self-play:topup`：按缺口继续补 self-play 样本
- `scoring:audit`：静态评分审计
- `battle`：连接 MCP/LLM 的实验入口
- `combat-window:extract`：从 `runtime-plans` 提取 2 到 4 动作窗口
- `combat-window:analyze`：LLM 赛后结构化分析窗口，生成 `combat_window_plan`
- `combat-window:validate`：本地验证 draft tree
- `combat-window:align-replay`：把 tree 对齐到 benchmark/replay 样本
- `combat-window:import-branch-eval`：导入 `branch-eval` 证据并更新 promotion signal
- `combat-window:export-library`：导出离线检索用 `library.json`
- `combat-window:query-library`：查询单个窗口/tree 会召回哪些 library entry
- `combat-window:evaluate-library`：评估树库在 `runtime / window / canonical` 三种 query mode 下的召回质量
- `combat-window:evaluate-workload`：评估一批 runtime workload 被树库接住的覆盖率

`scoring:calibrate` 这个脚本目前仍指向旧路径，暂时不要用。

### 单边 prior 对照测试

如果你想测试“只给一方 evaluator 加 deck/matchup prior，另一方保持 action-only”：

```bash
cd packages/gi-agent
pnpm run benchmark examples/configs/benchmark.prior.example.json
```

这个示例现在使用 `priorMatrix` 配置，会自动展开成 4 组对局：

- A=`none`, B=`none`
- A=`prior`, B=`none`
- A=`none`, B=`prior`
- A=`prior`, B=`prior`

并且会在 CLI 输出中额外打印一个 2x2 胜率表，使用 `deck0Name` / `deck1Name` 作为行列表头。

配置里可读卡组名字段：

- `deck0Name`
- `deck1Name`

可用的 `priorMode`：

- `none`
- `self-only`
- `both`

当前第一版实现里，`both` 的语义是“为该 policy 启用完整 prior bonus”；如果双方都设成 `both`，就得到镜像对照。

### 多套卡组批量 prior 矩阵

如果你想把“单个 deckA vs deckB 的 2x2 prior 对照”扩展成多套卡组的批量先后手测试：

```bash
cd packages/gi-agent
pnpm run benchmark examples/configs/benchmark.prior.batch.example.json
```

如果要并发跑 benchmark worker：

```bash
cd packages/gi-agent
pnpm run benchmark examples/configs/benchmark.prior.batch.example.json --concurrency 4
```

`--concurrency` 只影响 benchmark CLI，本质上是把展开后的 matchup 分片到多个 worker 线程执行。对大批量矩阵更有效；小样本 smoke 跑法通常不需要开太高。

新配置使用 `priorMatrixBatch`：

- `decks`
  - 一组 `{ id, name?, deckCode }`
- `includeMirrors`
  - 是否包含同卡组 mirror
  - 默认 `false`
- `includeReverse`
  - 是否同时生成 `A vs B` 和 `B vs A`
  - 默认 `true`

展开规则是：

- 每个 deck pair 先展开成有序对局
- 每个有序对局再展开成 4 组 prior 组合：
  - A=`none`, B=`none`
  - A=`prior`, B=`none`
  - A=`none`, B=`prior`
  - A=`prior`, B=`prior`

也就是说，如果你给 8 套卡组，关闭 mirror、开启 reverse：

- 有序对局数 = `8 * 7 = 56`
- 实际 benchmark matchup 数 = `56 * 4 = 224`

CLI 仍然会按每个有序 deck pair 输出一个 2x2 prior 胜率表。

## Battle 模式

`battle-agent` 仍然保留，适合做 MCP / LLM 相关实验：

```bash
pnpm run battle -- --base-url http://localhost:3901 --model gpt-4o
```

常用参数：

- `--base-url`
- `--model`
- `--weights`
- `--max-loops`
- `--temperature`
- `--watch`
- `--poll-ms`
- `--max-turns`
- `--continue-on-error`
- `--session-id`

入口文件：

- [battle-agent.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/agents/battle-agent.ts)
- [battle-graph.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/graphs/battle-graph.ts)

当前需要注意：

- `battle-graph` 已经改成 `policy-first`
- 它还保留了 LLM / fragmented MCP 的兼容层
- 它适合调试和实验，不适合作为你现在主要的强度验证闭环

## Runtime 组件说明

### Policy

- [baseline-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/baseline-policy.ts)
  - 对 `candidate_actions` 做启发式排序
- [evaluator-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/evaluator-policy.ts)
  - 在 baseline 分数上叠加 learned score

### Search

- [bounded-searcher.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/search/bounded-searcher.ts)
  - 用于局部 beam search
- [sim-adapter.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/adapters/sim-adapter.ts)
  - 负责模拟状态推进

### Eval Baselines

这部分已经按组件拆开：

- [delta-extractor.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/eval-baselines/delta-extractor.ts)
- [heuristic-scorer.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/eval-baselines/heuristic-scorer.ts)
- [feasibility-estimator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/eval-baselines/feasibility-estimator.ts)
- [state-evaluator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/eval-baselines/state-evaluator.ts)

`StateEvaluator` 现在更像一个兼容 facade，真正逻辑已经分散到上面三个组件里。

## Knowledge 组件说明

这部分主要是从旧实验里回收的“静态先验”：

- [character-profile-extractor.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/knowledge/character-profiles/character-profile-extractor.ts)
- [source-parser.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/knowledge/character-profiles/source-parser.ts)
- [skill-phase-value-estimator.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/knowledge/character-profiles/skill-phase-value-estimator.ts)
- [card-affinity-analyzer.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/knowledge/deck-priors/card-affinity-analyzer.ts)

目前它们更适合：

- 生成 deck-level features
- 做构筑候选过滤
- 做先验分析

不适合直接拿来当最终胜率裁判。

## 当前建议的开发顺序

如果你接下来继续往前推，建议按这个顺序用：

1. 先整理固定 benchmark 场景集
2. 用 `benchmark` 跑 baseline policy 的稳定报表
3. 逐步把 learned weights 接进 `EvaluatorPolicy`
4. 再考虑把 `BoundedSearcher` 接到 top-N 候选上
5. 最后再去强化 `battle-graph` 这类实验层

一句话说，当前 `gi-agent` 最应该被当成：

“一个能跑本地 policy、能做 benchmark、能训练 evaluator 的实验骨架”

而不是：

“已经做完的多 agent 对战系统”
