# 沙箱启发式卡组分析：LLM 对局 Benchmark 设计

本文定义一个用于比较**对局模型能力**、**沙箱分析带来的净增益**，以及
**沙箱分析模型质量**的可复现评测协议。它建立在
[`PER_SIDE_CONFIG_AND_SANDBOX.md`](./PER_SIDE_CONFIG_AND_SANDBOX.md) 描述的
per-side 配置、每局 P0/P1 隔离沙箱和保留的 replay/log 之上。

## 1. 评测问题与边界

必须把下列三个问题分开报告，不能只报一个混合胜率：

| 问题 | 受测变量 | 固定变量 | 主要结论 |
| --- | --- | --- | --- |
| 对局能力 | `battleModel` | 无沙箱、相同 prompt/temperature | 模型在实时决策中的强度 |
| 沙箱净增益 | `sandbox: off/on` | 同一 `battleModel` | 深度卡组分析是否真正提升对局 |
| 分析模型质量 | `sandboxModel` | 同一 `battleModel`、相同对局设置 | 哪个模型生成的策略锚点更有用 |

`sandboxModel` 生成 `analysis.ts`，`battleModel` 在对局中调用工具并决策；两者可能相同，
但在 benchmark manifest 中必须分别记录。禁止将“强分析模型 + 弱对局模型”的结果当成弱模型本身的能力。

不测量的内容：卡组构筑能力、外部检索能力，以及用户未在沙箱中提供的信息。双方只可获得各自
`sandbox/<side>/` 下的文件；策略锚点不可跨侧复用。

## 2. 固定实验条件

每次正式实验创建一个只追加的 `manifest.json`，并冻结以下条件：

- commit SHA、Node/pnpm 版本、`@gi-tcg/data` 版本、卡组代码及其 SHA-256；
- `toolExposureMode`、双方 system prompt 的内容哈希、对局与沙箱 temperature、max tokens；
- API 的模型 ID、endpoint 标识（不得写入 API key）、并发数和超时；
- 卡池（当前 `.opencode/batch-llm-v2.json` 的水八、神宵、水凝、雷鹤、雷狼、莫优、红牛、水债）；
- 评测版本、运行时间和每个实验单元的预注册局数。

当前 headless 流程未暴露随机种子，因此一次对局不是严格可重放的。解决方式是：随机化任务顺序、
每一方向重复多局、P0/P1 互换、并将运行批次作为统计 cluster。不要把同一批次的多局视为完全独立样本。
若以后支持游戏 seed，应把 `(matchup, seat, seed)` 写入 manifest，并让 A/B 两臂使用完全相同的 seed 列表。

## 3. 卡组与对局抽样

卡池采用当前 v2 配置中的 8 套卡组。对局单元写成有向三元组：

```
(myDeck, opponentDeck, seat)
```

其中 `seat` 是受测模型所在的一侧。即使两套卡组相同，也必须执行 P0/P1 两个 seat，借此抵消先手、
起始行动权和 runner 行为的系统性偏置。

### 分层抽样

不要只跑镜像：镜像适合测实时操作稳定性，却无法测试对局分析是否能识别克制关系。

- **镜像层**：8 个 mirror，检验公平性、工具调用稳定性和同构资源规划。
- **优势层**：从已知快攻/站场/控制/组合技等不同风格中，人工冻结 12 个非镜像 matchup；每个风格至少与另外两个风格交叉。这个集合需经版本化的 `matchup_catalog.json` 固定，不能在看到结果后挑选。
- **全覆盖层**：8 × 8 个 deck pairing。每一个 pairing 都执行两个 seat（受测模型分别为 P0 和 P1）。

正式报告总是同时给出每个 matchup 的结果、按 deck 聚合的结果和 macro-average；不能用对局数加权的总胜率掩盖某一套卡组的严重退化。

## 4. 实验矩阵

令 `M` 为候选对局模型，`A` 为固定锚点模型，`S` 为沙箱分析模型。所有未说明的字段都从同一个基线配置继承。

| 实验 ID | P0 | P1 | 沙箱 | 回答的问题 |
| --- | --- | --- | --- | --- |
| `strength/M/p0` | M | A | 两侧关闭 | M 作为 P0 的相对强度 |
| `strength/M/p1` | A | M | 两侧关闭 | M 作为 P1 的相对强度 |
| `ablation/M/off` | M | A | 两侧关闭 | 无分析基线 |
| `ablation/M/on` | M | A | M 仅在 M 一侧开启 | 同模型的沙箱净增益 |
| `generator/M/S` | M | A | M 一侧使用 S | S 为 M 提供策略锚点的价值 |
| `fairness/M` | M | M | 两侧同配置、同状态 | 是否存在未解释的 seat 偏差 |

`ablation` 和 `generator` 中，锚点方的沙箱必须关闭；否则两个策略锚点的变化会相互抵消。`fairness/M` 仅用于诊断，不能用于给 M 排名。

### 推荐三阶段预算

| 阶段 | 样本 | 每有向实验单元局数 | 用途 | 是否可作结论 |
| --- | ---: | ---: | --- | --- |
| Smoke | 8 mirror | 4 | 配置、隔离、解析和崩溃检查 | 否 |
| Gate | 8 mirror + 12 优势 matchup，双 seat | 12 | 淘汰不稳定候选、确认增益方向 | 仅可作候选筛选 |
| Full | 64 pairing，双 seat | 20 | 模型发布或 prompt/沙箱版本验收 | 是 |

例如 `strength/M` 的 Full 为 `64 × 2 × 20 = 2,560` 局。若成本受限，可先跑 Gate，
但不得将 Gate 的结果命名为“全卡池排名”。每个 sandbox-on 单元额外记录脚本生成重试与 token 成本。

## 5. 可执行配置模式

现有 `run-batch-llm.ts` 已能表达单个实验臂：每个 matchup 用 `p0`/`p1` 固定模型，
并只在受测方配置 sandbox。建议为每个实验臂生成独立 v2 配置，而不是把多个臂塞进同一个 run，
这样 `run_config.json` 和输出目录天然可追溯。

下面是 `ablation/M/on` 中某个 matchup 的最小形态（实际 deck code 从冻结的 catalog 复制）：

```json
{
  "version": "2.0",
  "matchups": [{
    "id": "water8-vs-leihe",
    "deck0Name": "水八",
    "deck1Name": "雷鹤",
    "deck0": "<frozen-code>",
    "deck1": "<frozen-code>",
    "games": 12,
    "p0": {
      "model": "<M>",
      "temperature": 0.2,
      "systemPrompt": ".opencode/prompts/p0-start.md",
      "sandbox": {
        "enabled": true,
        "model": "<S>",
        "temperature": 0.4,
        "maxTokens": 8192,
        "promptTemplate": ".opencode/prompts/sandbox-analysis-gen.md"
      }
    },
    "p1": {
      "model": "<A>",
      "temperature": 0.2,
      "systemPrompt": ".opencode/prompts/p1-start.md",
      "sandbox": { "enabled": false }
    }
  }]
}
```

运行时使用 `-SandboxEnabled 1`，以允许配置中的 P0 开启沙箱；`SandboxEnabled 0` 会覆盖该设置。
每个 `.../on` run 后，校验 P0 的 sandbox 成功率，再读取 `summary.json` 和每局的
`game_replay.json`。对 `off` run 使用完全相同的 matchup、局数、prompt、temperature 和模型。

## 6. 指标、统计与判定

### 主指标

对任一有向单元，计分为胜 `1`、负 `0`、平局 `0.5`；异常局不参与胜率分母，单独计入可靠性。

```
score rate = (wins + 0.5 * draws) / completed games
delta = score rate(treatment) - score rate(control)
```

主报告给出：macro score rate、对锚点的 delta、以及分层 bootstrap 的 95% CI。
bootstrap 的重采样单位是 `(batch, matchup, seat)` cluster，而不是每一局；同时报告 completed game
数量。若暂时不实现 bootstrap，至少给每个比例给出 Wilson 95% CI，且不声称微小差异有显著性。

### 次指标与可靠性门槛

| 指标 | 来源 | 发布门槛 |
| --- | --- | --- |
| 完成率 | `summary.json.error`、winner | ≥ 98% |
| 沙箱可用率 | `strategy.json` 存在且可解析 / 请求数 | ≥ 95% |
| 异常率 | agent crash、runner 未启动、60 回合超限 | ≤ 2% |
| 每局耗时 | `elapsedMs` | 同基线增加不超过 25%（同时报告绝对值） |
| 回合数、非法/重试动作、工具调用 | `game_replay.json` 与 agent log | 只作诊断，按 matchup 列表输出 |
| 沙箱成本 | `generation_log.jsonl` | 请求数、重试次数、input/output tokens（若供应商返回） |

当前 summary 只直接保存胜者、错误和耗时；回合数、动作重试和 token 必须由 replay/log 汇总器补齐。
在该汇总器就绪前，不能把“性能”只解释为胜率而忽略大量超时或回退。

### 结论规则

- `M` 优于 `A`：Full 中 macro score-rate delta 的 95% CI 下界大于 `0`，并通过全部可靠性门槛。
- 沙箱对 `M` 有发布价值：`ablation/M/on - off` 的 CI 下界至少 `+2` 个百分点，且任何 deck 的点估计退化不超过 `5` 个百分点、没有新的可靠性失败。
- `S1` 优于 `S2`：在 `generator/M/S1` 与 `generator/M/S2` 中，仅替换 sandbox model，按相同规则比较。它是“对 M 有用的分析器”排名，不是通用 LLM 排名。
- 不满足样本量、冻结条件或可靠性门槛的运行标记为 `inconclusive`，不接受“胜率更高”的结论。

## 7. 结果目录与审计清单

建议将一个发布候选保存为：

```
.opencode/tmp/model-benchmarks/<benchmark-id>/
  manifest.json
  configs/<experiment-id>.json
  runs/<experiment-id>/run_<timestamp>/
  report.json
  report.md
```

`report.json` 的每行至少包含：`benchmarkId`、`experimentId`、`batchId`、`matchupId`、
`myDeck`、`oppDeck`、`seat`、`battleModel`、`sandboxEnabled`、`sandboxModel`、`winner`、
`error`、`elapsedMs`、`sandboxSuccess`、`sandboxFallback`、`replayPath`。API key、完整提示词中的敏感内容和原始请求不得写入聚合报告。

提交结果前逐项确认：

1. `run_config.json` 与 manifest 的模型、prompt hash、temperature、tool mode 一致。
2. on/off 仅改变预注册变量；对方未意外开启 sandbox。
3. 每方只传入自己的 sandbox 目录，且 P0/P1 的 `strategy.json` 不是同一文件或交叉复制。
4. 沙箱失败明确标记为 fallback；不能把 fallback 当成 sandbox-on 成功样本。
5. 同时发布 raw summary、replay 索引、按 matchup 表和失败列表，使结果可以复算。

## 8. 后续最小工程项

该协议可立即用现有 runner 执行胜率实验。为了让它成为一键 benchmark，建议按以下顺序补齐：

1. 加入 `matchup_catalog.json` 与配置生成脚本，生成 mirror/优势/全覆盖以及双 seat 配置；
2. 给 runner 增加 `--benchmark-manifest`，把模型、实际 per-side sandbox 状态和策略文件 hash 写进每局结果；
3. 编写 report CLI，从 `summary.json`、sandbox 目录和 replay 聚合次指标并输出 bootstrap CI；
4. 支持显式 game seed 或记录 runner RNG seed，实施配对的 A/B 重放。

