# 实现规格总览（impl-spec-0）：四模型小型锦标赛工程包

> 日期：2026-09-05。状态：**已实现**（2026-09-05/06：WP1-5 代码全部落地；WP1 已过 Mock-LLM 全管线冒烟
> 十项验收（[../../smoke/ACCEPTANCE.md](../../smoke/ACCEPTANCE.md)），WP4 件 4 试点与 WP5 实验运行待真实凭据/对局数据）。
> 来源：[2026-09-05-tournament-execution-plan.md](./2026-09-05-tournament-execution-plan.md)（执行方案，已全部拍板）。
> 读者：实现各工作包的编码 agent。本文是总入口：共享约定、依赖图、代码锚点索引、
> 跨包协调。**各包详细需求与验收标准见 spec-1..5，以各包为准。**

## 1. 工作包分解与依赖

| 包 | 文档 | 内容 | 依赖 |
|---|---|---|---|
| WP1 锦标赛管线 | [impl-spec-1-tournament.md](./2026-09-05-impl-spec-1-tournament.md) | tournament.json 解析、`model-tournament.ts` 六子命令（author/evolve/battle/export/analyze/status）、own-generations 证据适配器、冒烟验收 | 无（可最先开工） |
| WP2 写入端补采 | [impl-spec-2-write-side.md](./2026-09-05-impl-spec-2-write-side.md) | mutation 流接线（`game_state_log.e`）、replay-report 落盘、HarnessStats 扩展、P3-1 跨代聚合脚本 | 无（独立） |
| WP3 分析与绘图 | [impl-spec-3-analysis-plots.md](./2026-09-05-impl-spec-3-analysis-plots.md) | tree-bench ratings-history 导出、coverage 统计、spin-top 稠密子块过滤、matplotlib 五图 | 无（独立）；被 WP1 的 analyze 子命令消费 |
| WP4 organizer | [impl-spec-4-organizer.md](./2026-09-05-impl-spec-4-organizer.md) | 证据导出器 `plan:organize-export`、organizer 编排脚本与报告 schema | WP2 落地后才能采到新数据；代码可先行 |
| WP5 锚点复验 | [impl-spec-5-anchor-experiment.md](./2026-09-05-impl-spec-5-anchor-experiment.md) | round19 式 `--anchor` 双臂实验编排与读数 | 无（复用现成 `--anchor`） |

**并行性**：WP1/2/3/5 互不依赖可并行；WP4 依赖 WP2 的产物 schema（P0-1/3/4）。
**执行顺序**（人肉调度）：WP1+2+3 → 冒烟（spec-1 §6）→ 正赛 → WP4 试点 + WP5 并行。

## 2. 共享约定（所有包必须遵守）

1. **工具链**：pnpm + `gnx`（禁 bun）；ESM、无分号、strict TS（`verbatimModuleSyntax`/
   `isolatedModules`）；每个新源文件加 AGPLv3 头（从任一现有文件复制）。
2. **运行方式**：repo TS 脚本一律 `pnpm exec gnx scripts/foo.ts`（packages/gi-agent 内）；
   CLI 子命令走 package.json scripts（`plan:author` / `plan:batch` / `plan:reflect` 现成）。
   本机 pnpm corepack shim 有故障时直接用 `node_modules/.bin/tsx` 兜底（已验证可行）。
3. **不得改动**（除非该包规格明说）：oracle 泄漏断言、版本钉扎 fail-fast、
   `judgeEngineOnly` 判据、`plan:reflect` 证据读取契约、tree-bench 算法语义。
4. **状态落盘**：编排脚本的所有中间产物写 `outRoot` 下 JSON；不依赖内存状态跨调用。
5. **失败隔离**：LLM 调用失败不得中断批任务（记录 + 继续 + 末尾汇总）；
   引擎侧一致性错误（版本错配、alignment 断言）必须 fail-fast。
6. **不引入新依赖**（TS 侧）除非规格写明；Python 侧仅 matplotlib（uv 管理）。

## 3. 代码锚点索引（已逐条核实存在）

| 锚点 | 位置 | 用途 |
|---|---|---|
| LLM env 契约 | `gi-agent/src/runtime/plan-oneshot/cli/llm.ts:124-128` | `OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL` 三元组；`--model` 只覆盖模型名不换 baseURL |
| author CLI | `gi-agent/src/runtime/plan-oneshot/cli/run-plan-author.ts` | `--deck/--opponent-deck/--opponent-set/--mirror/--unknown/--anchor/--game-version/--model/--seed/--temperature`；anchor 两阶段 + 形状闸（`:124-301`） |
| batch 执行器 | `gi-agent/src/runtime/plan-oneshot/batch-runner.ts` | `runPlanBatch(config)`；config：plan/opponent{type:"plan",plan}/deck/opponentDeckCode/games/seedBase/outDir/concurrency/gameVersion/force/alternateFirstPlayer；产物 `game-NNNN/plan_trace.json`、`game_state_log.json`、`plan_trace.side1.json`（对手为 plan 型时）、`summary.json`/`summary.side1.json`（`batch-runner.ts:440-470`）；perGame `winner: 0\|1\|null`（`:109`）；gameVersion 解序与 fail-fast（`:127-150`） |
| reflect CLI | `gi-agent/src/runtime/plan-oneshot/cli/run-plan-reflect.ts` | `--run-dir <dir>[,<dir2>]`（逗号分隔多组）+ `--side 0` + `--portfolio` + `--round N` + `--evidence engine-only` + `--patch`；组装载：`plan.side0.json`+`summary.json`+`game-NNNN/plan_trace.json`；portfolio 断言 `portfolio.side0.json`（`:335-407`） |
| portfolio reflect | `gi-agent/src/runtime/plan-oneshot/cli/reflect-portfolio.ts` | `--patch` 层化修订（singles 层可修订）；产物 `plans/general.r<N>.json` + `plans/single.<label>.r<N>.json` |
| portfolio 编排先例 | `gi-agent/scripts/ops/portfolio-generation.ts` | config 形状、每代循环、seed 约定（`:36-128`）；roundtrip 参考 `examples/plans/roundP1-portfolio/` |
| 版本钉扎 | `gi-agent/src/runtime/plan-oneshot/version.ts` | parseGameVersion / checkRunDirVersions / assetsManagerForVersion / applyAuthorGameVersion |
| tree-bench 输入 | `benchmark/tree-bench/src/results.ts` | `parseGameResult`：`{p1,p2,winner:"p1"\|"p2"\|"draw",period?}`；p1===p2 拒收（`:61-63`）；无对局格填 0.5（`:158`） |
| Glicko-2 period | `benchmark/tree-bench/src/glicko2.ts` | 期内期初快照（`:195-229`）；空对局仅 RD 膨胀（`:91-96`）；draw 计 0.5（`:207-211`） |
| tree-bench analyze | `benchmark/tree-bench/src/cli/analyze.ts` | `--input <results.json> --out <dir> --bootstrap N --seed N` |
| 卡组源 | `benchmark/tree-bench/summoners-decks/{4.0,4.8,5.3,5.8,6.3}.json` | `{decks:[{deckCode,usageRate,winRate,numGames,characters,...}]}`（README 在同目录） |
| mutation 丢弃点 | `gi-agent/src/sandbox/runner.ts:121-123` | `onPause` 回调丢弃 `_mutations`（WP2 接线点） |
| 锚点 prompt | `gi-agent/src/runtime/plan-oneshot/prompts/anchor-system.md` | round19 遗留，`--anchor` 直接使用 |

## 4. 跨包协调

- **命名**：模型 id 用 API.txt 原名（`deepseek-v4-pro-0813` 等）；选手 id = `<model>@r<n>`；
  环境标签 = `v<版本去点>`（`v6.3`）；格目录 = `<di索引>-vs-<dj索引>`（索引 = 环境
  decks 数组下标，配置变更不迁移旧产物）。
- **API key**：tournament.json 只写 `apiKeyEnv` 名；值从进程 env 解析后注入子进程
  `OPENAI_API_KEY`（连同 `OPENAI_BASE_URL`/`OPENAI_MODEL`）。**任何文件不得落盘 key 值**。
- **文档同步义务**：WP1/2/4 落地后更新 `docs/INDEX.md` 与（如触及 schema）
  `docs/oracle-free-harness-metrics.md`；本包组文档实现完成后状态改"已实现"。
- **测试**：每包自带可执行验收；不新增全仓 lint（无此设施）。
