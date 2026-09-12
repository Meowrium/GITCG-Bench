# 交接文档：pipeline「生成即赛」功能 —— 实现要求、现状与待完成验证

> 日期：2026-09-06。读者：接手的实现 agent。**结论先行：功能主体已实现并通过大部分验证，
> 剩余工作 = 完成「失败路径 e2e」的最后两步确认（§4），不要重写已有实现。**

## 1. 功能定义（需求）

`model-tournament.ts`（锦标赛编排脚本）新增 **`pipeline` 子命令**：LLM 生成决策树
（producer）与引擎对局调度器（battle scheduler）**并发运行**，依赖一就绪就对局，
消除「author 阶段引擎空转数小时」的墙钟浪费。

需求要点（对应 impl-spec-1 §4.7，已写入）：

1. **r0**：author producer（起草调用池，LLM 并发默认 3）+ battle 调度器（批进程并发
   默认 4）并发；**manifest 组装内联**——每个 (model, env, di) 的 D+1 个起草调用全部
   结束即组装该 di 的 portfolio manifest（不再集中到 author 尾部），对手树文件一出现
   其所在格即就绪。
2. **r≥1**：前置校验「第 r-1 代全部 battle done」（own-generations 证据依赖上一代
   全量对局），不满足则 fail-fast；producer = evolve 限定该代。**各代之间仍串行**
   （evolve r+1 消费 r 的全部对局），单次 pipeline 只推进一代。
3. **调度循环**：扫描该代赛程 → 就绪批派发（批进程池）→ 等待（事件唤醒 + 10s 轮询
   兜底）→ 重扫；producer 结束后 drain：仍就绪的跑完，**仍 not-ready 的批如实记
   「依赖未就绪」失败**（recordFailure 不写 done 位图，后续 invocation 重试不受阻）。
4. **失败语义**：同一 invocation 内已尝试（含失败）的批不重试；末尾按
   finishWithFailureCheck 语义汇总 author/evolve/battle 失败并 exit 1。
5. **资源预算**：LLM 单元（网络等待型，`llmConcurrencyOf` 默认 3）与 battle 批进程
   （CPU 型，`battleConcurrencyOf` 默认 4）天然互补，无需联动节流。
6. 不自动跑 export/analyze（饱和判定是人肉环节）；与 `archive` 冷归档兼容（归档批
   isDone 跳过，不受影响）。
7. `author` 单独子命令同样获得内联 manifest 组装（最终状态与原实现一致：manifest
   要么 done 要么 recorded failure）。

## 2. 已实现内容（全部在工作树中，未 commit）

| 件 | 位置 | 说明 |
|---|---|---|
| 调度核心 | `packages/gi-agent/scripts/ops/tournament-scheduler.ts`（222 行） | 注入式副作用核心 `runBattleScheduler`：specs/isDone/isReady/runBatch/onNotReady/producerDone/wakeup 全部注入；`partitionBatches` 纯函数（done/attempted→skipped、ready、notReady）；`createStateSignal` 唤醒信号（事件驱动 + pollMs=10s 轮询兜底）；drain 语义与终止性见文件头注 |
| 调度核心单测 | `scripts/ops/tournament-scheduler.test.ts`（255 行） | 分区/drain/唤醒/attempted 语义，23 个测试（与 archive 测试合计全过） |
| 编排接线 | `scripts/ops/model-tournament.ts` | `cmdPipeline`（~L884，自动定代 `decidePipelineRound`、r≥1 前置校验、`Promise.all([producer, scheduler])`、`finishPipeline`）；`battleScheduler` 包装（~L815，`missingDepDesc` 给出缺口是 manifest 还是对手树）；`authorProducer`（~L348）/`evolveProducer`（~L554）从 cmdAuthor/cmdEvolve 抽出（独立子命令 = producer + finishWithFailureCheck 不变）；manifest 内联组装 + `notifyStateChange`（~L139，producer 各完成点调用，未安装时 no-op）；`Ctx.wakeScheduler?`（~L127）；main dispatch `case "pipeline"`（~L1169）；usage 文档 |
| state key | `tournament-scheduler.ts` 的 `battleKey` | 与 model-tournament/tournament-archive 同格式 `battle|r<round>|<env>|<pair>|<di>-vs-<dj>`（archive 侧有防漂移单测） |
| 文档 | `docs/plans/2026-09-05-impl-spec-1-tournament.md` §4.7、`scripts/README.md`、`docs/INDEX.md`（impl-spec-1 行） | 已同步 |

注意：实现的产生过程有一段不在本会话可见范围内（部分子代理汇报丢失/另一会话并行），
**接手者应先通读上述文件确认理解，再动代码；不要凭空重写。**

## 3. 已验证项（本会话亲自执行，全部通过）

| # | 项 | 命令 / 方式 | 结果 |
|---|---|---|---|
| 1 | 类型检查 | `node node_modules/typescript/bin/tsc -p packages/gi-agent --noEmit`（仓库根） | 仅 2 个既有 `../gi-ml` 错误（rl.ts hp、unified-value-predictor gbrl_value.v1），无新增 |
| 2 | 单测 | vitest `run scripts/ops/tournament-scheduler.test.ts scripts/ops/tournament-archive.test.ts` | 23/23 过 |
| 3 | 离线自检 | `tsx scripts/ops/tournament-selfcheck.ts` | 24/24 |
| 4 | 全量回归 | vitest 全量 | **524 通过 / 2 失败**（2 失败 = `evaluation/benchmark/cli-config.test.ts` 环境性 ENOENT，属既有基线，不得新增） |
| 5 | **e2e 成功路径** | fixture A（见 §5）：预置合法计划 → `pipeline`（无 --round） | **exit 0**：12 个计划全部 adopt（0 次 LLM）、2 个 manifest 组装 OK、2 个 battle 批真实引擎跑完、state done = author 6 / battle 2、failures 0 |
| 6 | **重叠生效证据** | fixture（D=2 变体）日志时间线 | mock-b 的 manifest 一就绪，调度器在 producer 仍在推进其余单元时即派发 2 个 battle 批 |
| 7 | r≥1 前置校验 | fixture A 上 `pipeline --round 1` | fail-fast：`第 0 代还有 8 个 battle 批未完成…先跑 pipeline / battle --round 0 补齐` |

## 4. 待完成项（交接口的唯一剩余工作）

> **2026-09-06 后续：§4 全部验证已通过（接手会话执行），未发现实现缺陷，零代码改动。**
> 步骤 1 exit 1、四条断言全过；步骤 2 修复后幂等补缺 exit 0、failures 清空、不重跑已完
> 成单元；顺手项 `author` 独立子命令行为不变。注意实际墙钟约 60 分钟（损坏单元
> plan:author 内部 8 次指数退避 ×3 外层重试），非预估的 3-5 分钟。证据留存于
> `.tmp/pipeline-e2e/B/step1-run*.log`、`step2-run.log` 及 state.json 备份。

**失败路径 e2e（fixture B）已启动但未跑完**（损坏单元的 plan:author 子进程冷启动
~30-60s × 3 次重试 + 5s 退避，总 ~3-5 分钟；上次轮询被中断）。fixture 已就绪：
`.tmp/pipeline-e2e/B`（含 1 个非法 JSON 的 `plans/mock-a/v6.3/single.0-vs-0.r0.json`）。

### 4.1 步骤 1：跑通失败路径，断言四个行为

```bash
cd /d/AI/GTCG/genius-invokation-clean/packages/gi-agent
export PATH="$PWD/.tmp/smoke-tools/bin:$PATH"   # 可用 pnpm shim（系统 pnpm 损坏）
export NOOP_KEY_A=dummy NOOP_KEY_B=dummy        # tournament-config 校验 apiKeyEnv 存在
node ../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
  scripts/ops/model-tournament.ts .tmp/pipeline-e2e/B/config.json pipeline
echo "EXIT=$?"   # 期望 1
```

断言（读 `.tmp/pipeline-e2e/B/state.json` 与 stdout）：
1. `author|mock-a|v6.3|single|0-vs-0` 走 LLM 3 次尝试后 recordFailure（无 LLM 环境
   连接拒绝，快速失败）；
2. manifest `author|mock-a|v6.3|manifest|0` 记「计划缺失」失败（assembleR0Manifest
   抛错路径）；
3. battle 两个结果都要出现：
   - `battle|r0|v6.3|mock-b@r0__vs__mock-a@r0|0-vs-0`：对手树 = 损坏文件，文件存在 →
     batchReady 通过 → `runBattleBatch` 树断言失败（已观察到：`树断言失败：Expected
     property name...`，recordFailure）；
   - `battle|r0|v6.3|mock-a@r0__vs__mock-b@r0|0-vs-0`：plan 侧 manifest 缺失 → drain
     终态记「依赖未就绪（…缺 plan 侧 manifest…）」；
4. exit 1，失败清单完整。

**已知观察（跑之前的状态，供比对）**：上次中断时 failure 已有 1 条（mock-b 侧树断言
失败），mock-a 侧 manifest 失败与 依赖未就绪 尚未落——这正是要补验的部分。

### 4.2 步骤 2：修复后幂等补缺

把 `.tmp/pipeline-e2e/B/plans/mock-a/v6.3/single.0-vs-0.r0.json` 重新生成为合法内容
（重跑 `gen-fixture.mts .tmp/pipeline-e2e/B` 会连 state 一起……注意 gen 脚本不删 state，
只覆盖计划文件——直接重跑 gen 脚本即可，state.json 保留）→ 再跑同一 `pipeline` 命令：

- 断言：先前成功单元/批不重跑（adopt 与 done 位图跳过）；损坏单元本次采纳成功；
  manifest (mock-a,0) 组装成功（markDone 应清除同名 failure——在
  `tournament-state.ts` 核实该语义）；两个 battle 批补跑完成；**exit 0 且
  failures 数组为空**。

### 4.3 顺手项（可选，非阻塞）

- `author` 单独子命令在 fixture A 上跑一遍（全 adopt 秒级），确认独立模式行为不变。
- 若发现实现缺陷：最小修复 + 在 `tournament-scheduler.test.ts` 补回归用例；严禁改动
  默认（非 pipeline）路径的产物语义。

## 5. e2e fixture 说明（复现用）

- 生成器：`packages/gi-agent/.tmp/pipeline-e2e/gen-fixture.mts`（gitignored）。
  `node <tsx> .tmp/pipeline-e2e/gen-fixture.mts <outRoot> [--corrupt]`。
- 设计约束（为什么这样构造）：
  - 采用**预置计划 + adopt 路径**实现零 LLM e2e（adoptExistingPlan 只查 JSON 可解析
    且有 planId）；
  - env decks 只能放 **1 套**（`example-plan.json` 的 deckCode
    `ASBg2xwO…`）：`validateGamePlan` 校验**卡组成员资格**（character/card not in
    deck），examples 中只有该 deck 的真实计划，第二套 deck 无可用计划内容；D=1 是
    tournament-config 合法配置（decks ≥1 唯一）；
  - single 恒用 `known_deck`（含镜像格）——portfolio 校验要求 single 的
    context.opponent = known_deck 且与 manifest 绑定一致，用 `mirror` 会被拒
    （这是本轮踩过的坑，报错形如 `single "0" 的计划必须声明 context.opponent =
    known_deck…`）；
  - 计划声明 `context.gameVersion: "v6.3.0"`（`runBattleBatch` 的版本钉扎断言要求）；
  - 每文件 planId 用 md5 派生唯一 12 hex。
- fixture A = 干净（成功路径已验证）；fixture B = corrupt（失败路径待完成）。

## 6. 环境与禁区（接手必读）

- **工具链**：系统 pnpm corepack shim 损坏、禁 bun。跑 TS：
  `node /d/AI/GTCG/genius-invokation-clean/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs <脚本>`（packages/gi-agent 下）；
  需要 pnpm 的场景（本任务 e2e 需要）前置
  `export PATH="$PWD/.tmp/smoke-tools/bin:$PATH"`（现成 shim）。
- **基线**：vitest 524/2（不得新增失败）；selfcheck 24/24；tsc 仅 2 个既有 gi-ml 错误。
- **禁区（有正在跑的后台实验）**：`output/anchor-exp-v40/`（锚点实验产物，author
  ~30/64 单元，glm-5.3 系有 LLM 输出质量性失败属预期）、`.tmp/smoke-tools/`（实验
  依赖的 pnpm shim）、`.tmp/anchor-exp/`（实验凭据 env）。实验用的是
  `anchor-experiment.ts`，本任务**不修改该文件**。
- 红线：不改 run-plan-reflect / plan:batch / 引擎语义与默认产物形态；不 git commit。
- 本文档与 fixture 均在 gitignored/.tmp 之外的部分（本文档）随工作树走，未提交。
