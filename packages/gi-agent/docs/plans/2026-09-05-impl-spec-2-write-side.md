# WP2 实现规格：写入端补采 + 跨代聚合（P0 写入端 / P3-1）

> 来源：[impl-spec-0-overview.md](./2026-09-05-impl-spec-0-overview.md)；目标：执行方案阶段 0-A/0-F。
> 状态：**已实现**（2026-09-05/06：确定性红线同 seed 前后对比验证通过；gi-agent vitest 492 通过/2 环境性失败）。
> 设计依据：[2026-09-03-llm-evidence-organizer-eval.md](./2026-09-03-llm-evidence-organizer-eval.md)
> §4 件 1/2/3/4（B 案定稿）+ [整合稿](./2026-09-03-integrated-roadmap-selection-organizer.md) 重叠 1/3。
> **已核实**：gameEnd 终局快照已随 onPause 落盘（无需做，2026-09-05 实证：跑局 120 条
> state log 末条 `phase=gameEnd` 且带 winner）；mutations 半边确实丢弃
> （`sandbox/runner.ts:121-123`，`_mutations` 未使用）。

## 1. 交付物

| # | 件 | 位置 | 来源 |
|---|---|---|---|
| 1 | mutation 流接线 | `src/sandbox/runner.ts` + `src/runtime/plan-oneshot/plan-player-io.ts` | B §4-1 |
| 2 | reroll 骰面 / 落选候选 preview（可选，默认关） | `plan-player-io.ts` | B §4-2 |
| 3 | replay-report 落盘 | `cli/run-plan-reflect.ts` | B §4-3 |
| 4 | HarnessStats 扩展（issue 直方图 + 被拒留档） | `cli/agent-loop.ts` | 整合稿重叠 1 |
| 5 | P3-1 跨代聚合脚本 | `scripts/ops/aggregate-generations.ts` | 整合稿 P3-1 |

## 2. 需求细节

### 2.1 mutation 流接线（件 1）

- `SandboxRunner.runOne` 的 `onPause` 回调改为把 `mutations` 一并入
  `stateLog.push({ state, canResume, mutations })`（`GameStateLogEntry.mutations` 字段
  已存在，`serializeGameStateLog` 已序列化 `e`——零 schema 改动，只是不再丢弃）。
- **确定性红线**：接线不得改变决策路径（PlanPlayerIO.notify 仍只读 state；mutations
  仅落盘）。验收含"接线前后同 seed 对局 winner/rounds/trace 逐字节一致"。
- 旧 run 兼容：`e` 恒空数组的旧 state log 读取方不受影响（反序列化 `entry.e.length>0`
  分支已存在，`core/src/log.ts:219-260` 已核实）。

### 2.2 replay-report 落盘（件 3）

- `plan:reflect` patch 合并处现有 `PlanReplayResult` / `PatchAssertion[]` 只进
  transcript 文本；改为同时写 `<out>.replay-report.json`（JSON：patch ops ×
  status `fixed/partial/ineffective/no-target` + 断言明细，schema 以现有类型为准）。
- portfolio 模式同样落（每代一份，文件名带 r<N>）。

### 2.3 HarnessStats 扩展（件 4）

`agent-loop.ts` 的 harness sidecar（`<out>.harness.json`）增：

```jsonc
{
  "issueHistogram": { "deadRule": n, "format": n, "closedSet": n, "lint": n, "patchRejected": n },
  "rejected": [ { "stage": "draft|patch", "round": n, "reasonCode": "…", "detail": "≤200字" } ],
  "counters": { "lintFindings": n, "droppedAttempts": n, "totalAttempts": n }
}
```

- `rejected` **逐条 + 原因码**（整合稿 §6-3 已拍板粒度）；判据读数字段仅消融/选择
  场景填充（本次留空）。
- 同步义务：改 schema 后更新 `docs/oracle-free-harness-metrics.md` 的字段表
  （该文档文件头自定的同步规则）。

### 2.4 P3-1 聚合脚本（件 5）

`pnpm exec gnx scripts/ops/aggregate-generations.ts <各代 run 根目录…> --out <trend.json>`：

- 输入：逐代 run 目录（各含 summary.json + harness.json）；输出
  `trend.json`（每代一行：五指标 thenMiss/coverage/fallback/winRate/avgRounds +
  issueHistogram + counters）+ `trend.md`（表格渲染，先例
  `scripts/ops/render-game-log.ts` 的 markdown 范式）。
- 只读机械层，不做任何 LLM/语义归因。

## 3. 验收标准

| # | 项 | 判据 |
|---|---|---|
| 1 | 确定性不变 | 同 seed 跑 `plan-player-io.test.ts` 的 smoke 对局：接线前后 `replayLogJson` 的 `log`/`r` 与 trace 逐字段一致（`e` 除外） |
| 2 | `e` 落盘 | 新跑对局的 `game_state_log.json` 中至少一条 `e` 非空（含伤害/抽牌类 mutation） |
| 3 | 测试回归 | `pnpm test`（gi-agent）全绿；`plan-player-io.test.ts` 现有断言不动 |
| 4 | replay-report | 一次 reflect（含 patch）后 `<out>.replay-report.json` 存在、JSON 可解析、status 枚举合法 |
| 5 | harness.json | 一次 harness 模式 author 后新字段齐全；直方图计数与 transcript 中可见失败数一致（人工抽验 3 条） |
| 6 | 聚合脚本 | 对冒烟两代 run 出 trend.json/md；指标与各代 summary.json 原值一致（抽验） |
| 7 | 文档同步 | oracle-free-harness-metrics.md 已更新 harness.json 字段表 |

## 4. 明确不做

不做 organizer 导出器（WP4）；不做 verdict-only 消融；不改 reflect 证据读取契约；
reroll/preview 采集（件 2）默认关（加 feature flag，本次不实现可留 TODO 注释）。
