# Benchmark 配置指南

这份文档只讲一件事：

如何给 [run-benchmark.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/evaluation/benchmark/cli/run-benchmark.ts) 写配置，并正确理解输出结果。

如果你只是想先跑起来，先看 [examples/configs/benchmark.example.json](/D:/AI/GTCG/genius-invokation/packages/gi-agent/examples/configs/benchmark.example.json)。

## 最小命令

在 [packages/gi-agent](/D:/AI/GTCG/genius-invokation/packages/gi-agent) 下执行：

```bash
pnpm run benchmark examples/configs/benchmark.example.json
```

如果要保留结果文件：

```bash
pnpm run benchmark examples/configs/benchmark.example.json --output benchmark-result.json --markdown benchmark-report.md
```

## 配置文件结构

完整结构如下：

```json
{
  "version": "v6.3.0",
  "matchups": [
    {
      "id": "sample-baseline-mirror",
      "deck0": "deck code A",
      "deck1": "deck code B",
      "games": 50,
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

字段说明：

- `version`
  - 可选
  - 对应 `@gi-tcg/data` 使用的版本
  - 不写时默认走当前 `CURRENT_VERSION`
- `matchups`
  - 必填
  - 一个数组，每一项是一组固定对局

每个 matchup 包含：

- `id`
  - 必填
  - 这组对局的稳定标识
  - 建议不要改来改去，便于后续比较不同版本结果
- `deck0`
  - 必填
  - 玩家 0 使用的 deck code
- `deck1`
  - 必填
  - 玩家 1 使用的 deck code
- `games`
  - 必填
  - 这组对局要跑多少局
- `sideA`
  - 必填
  - 玩家 0 使用的 policy
- `sideB`
  - 必填
  - 玩家 1 使用的 policy

## `sideA` / `sideB` 怎么理解

这里有两个容易混淆的点：

第一，`sideA` / `sideB` 指的是 policy，不是 deck。

- `sideA` 永远控制 `deck0`
- `sideB` 永远控制 `deck1`

第二，输出里的 `winRateA` 指的是玩家 0，也就是 `deck0 + sideA` 这一侧的胜率。

所以如果你看到：

```text
sample: policy-new vs policy-old -> 62.00%
```

它的真实含义是：

- `deck0` 这边用 `policy-new`
- `deck1` 这边用 `policy-old`
- 在这组 matchup 里，`deck0` 胜率是 62%

## 当前支持的 policy 类型

现在只支持两类：

### 1. `baseline`

最简单，直接用启发式 policy。

```json
{
  "name": "baseline-a",
  "kind": "baseline",
  "options": {
    "endTurnPenalty": 5,
    "riskWeight": 2,
    "reactionWeight": 1.2,
    "tempoWeight": 0.8,
    "costWeight": 0.6
  }
}
```

`options` 对应 [baseline-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/baseline-policy.ts) 里的参数。

当前可配的主要项：

- `endTurnPenalty`
- `riskWeight`
- `reactionWeight`
- `tempoWeight`
- `costWeight`

### 2. `evaluator`

在 baseline 分数上叠加学习得到的 score。

```json
{
  "name": "lr-policy",
  "kind": "evaluator",
  "weightsPath": "./output/weights.json",
  "options": {
    "learnedScoreScale": 10
  }
}
```

额外字段：

- `weightsPath`
  - 必填
  - 指向训练得到的权重 JSON
  - 相对路径是相对于配置文件所在目录，不是命令执行目录

`options` 里除了 baseline 参数外，还能配：

- `learnedScoreScale`

对应实现见 [evaluator-policy.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/runtime/policy/evaluator-policy.ts)。

## deck code 从哪里来

当前 benchmark CLI 直接用仓库里的 `assets-manager` 解码 deck code。

也就是说你需要提供的不是“角色名 + 卡名列表”，而是已经编码好的 deck code 字符串，例如：

```json
{
  "deck0": "FZDByRUNGRCB0WoNFlGgWpEPE0AB9TAPFGCB9kgWGIERCoEQDLFADcQQDPFgacYWDJAA"
}
```

如果你后面要系统整理常见卡组，最实用的方式通常是先做一张表：

- `deck_id`
- `deck_name`
- `deck_code`
- `notes`

然后 benchmark 配置只引用你确认过的 code。

## 推荐怎么组织 matchup

刚开始不要一次塞太多。建议从这三类开始：

### 1. mirror

同一套卡组打自己：

- 能看 policy 纯强度差异
- 比较容易控制变量

### 2. 固定克制链

比如你确定有代表性的：

- 快攻 vs 中速
- 召唤物展开 vs 爆发斩杀
- 控场切人 vs 站场养成

这类 matchup 更适合看 policy 风格偏差。

### 3. 特定难点 matchup

比如你已经知道：

- 某个构筑下经常不会切人
- 经常过早 declare end
- 经常不会保关键角色

就可以专门拉一组对局来盯这个问题。

## 推荐的配置拆分方式

不要把所有东西都塞进一个巨型 JSON。

更实用的做法是拆成几份：

- `benchmark-smoke.json`
  - 少量对局，开发中快速验证能不能跑
- `benchmark-core.json`
  - 核心常见 matchup
- `benchmark-regression.json`
  - 专门盯历史上容易回退的问题

这样你平时先跑 smoke，再跑 core，最后需要时跑 regression。

## 输出怎么看

### 控制台输出

命令执行后会打印类似：

```text
Benchmark version: v6.3.0
Matchups: 1
Games: 10
Mean win rate A: 40.00%
Mean rounds: 7.60
Mean elapsed ms: 4358.70

sample-baseline-mirror: baseline-a vs baseline-b -> 40.00% (4-6-0)
```

解释：

- `Matchups`
  - 一共跑了几组 matchup
- `Games`
  - 所有 matchup 的总局数
- `Mean win rate A`
  - 所有 matchup 的 `deck0 / sideA` 平均胜率
- `Mean rounds`
  - 平均回合数
- `Mean elapsed ms`
  - 单局平均耗时
- `(4-6-0)`
  - `winsP0-winsP1-draws`

### JSON 输出

`--output` 会写出完整结果，适合后续脚本处理。

里面最重要的是每个 matchup 的：

- `winsP0`
- `winsP1`
- `draws`
- `winRateP0`
- `avgRounds`
- `avgElapsedMs`

### Markdown 输出

`--markdown` 当前会写一份简版汇总。

需要特别注意：

- 这份 markdown 现在不是严格意义上的 A/B comparison
- 它只是把当前这次 suite 的结果套进了 comparison 的表格格式
- 也就是说 `Baseline` 那一列现在默认是 0，不要把它误读成“已经和旧版本自动对比了”

如果你要做真正的版本对比，当前正确做法是：

1. 先跑旧版本配置，保存一份 JSON
2. 再跑新版本配置，再保存一份 JSON
3. 用库里的 `compareBenchmarks()` 自己做比较

对应函数在 [benchmark-report.ts](/D:/AI/GTCG/genius-invokation/packages/gi-agent/src/evaluation/benchmark/benchmark-report.ts)。

## 什么时候结果才“可信”

这个没有绝对值，但有一些很实用的经验：

- `games: 10`
  - 只适合 smoke test
- `games: 30`
  - 可以初步看趋势
- `games: 50`
  - 勉强可以做开发期比较
- `games: 100+`
  - 更适合做版本判断

如果某组 matchup 波动很大，10 局和 20 局的结果经常会非常不稳定。

## 常见误区

### 1. 只看总平均胜率

平均值会掩盖结构问题。

更重要的是看：

- 哪些 matchup 提升了
- 哪些 matchup 退化了
- 平均回合数是不是异常上升

### 2. 把 `sideA` 胜率当成“policy 绝对强度”

不是。

它始终和 deck 绑定在一起。你换了 `deck0 / deck1`，同一个 policy 的数字也会变。

### 3. 一次改很多参数再跑

这样你最后看不出是：

- `riskWeight` 起作用
- 还是 `learnedScoreScale` 起作用
- 还是 sample 偶然波动

更稳的做法是一次只改一件事。

## 一个更实用的起步模板

当你开始整理“常见卡组”时，我建议先做一份这种配置：

```json
{
  "version": "v6.3.0",
  "matchups": [
    {
      "id": "mirror-deck-001",
      "deck0": "deck_code_001",
      "deck1": "deck_code_001",
      "games": 30,
      "sideA": {
        "name": "baseline-default",
        "kind": "baseline"
      },
      "sideB": {
        "name": "baseline-default",
        "kind": "baseline"
      }
    },
    {
      "id": "deck-001-vs-deck-002",
      "deck0": "deck_code_001",
      "deck1": "deck_code_002",
      "games": 30,
      "sideA": {
        "name": "baseline-default",
        "kind": "baseline"
      },
      "sideB": {
        "name": "baseline-default",
        "kind": "baseline"
      }
    }
  ]
}
```

先把 deck 集和场景集稳定下来，再开始替换 policy。

## 你接下来最值得做的事

等你开始整理常见卡组后，建议下一步不是继续改代码，而是先产出两份文件：

1. `decks.json`
   - 存你确认过的常见 deck code
2. `benchmark-core.json`
   - 存你认可的核心 matchup 集

这样后面所有 policy / evaluator 修改，都会有一套固定回归集可以复用。
