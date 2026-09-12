# WP1 锦标赛管线 — 冒烟验收记录（Mock LLM，全管线）

> 日期：2026-09-05。依据：`docs/plans/2026-09-05-impl-spec-1-tournament.md` §4/§6。
> 方式：本地零依赖 Mock LLM server（node:http）替代真实模型；引擎对局为**真实计算**（plan:batch）。
> 结论：**验收项 1–10 全部通过**；过程中发现并修复 3 个管线 bug（见 §3），另记录 2 个未修观察项（§4）。

## 0. 冒烟配置与环境

- 配置：M=4（mock-a/b/c/d）× E=1（v6.3 → `gameVersion v6.3.0`）× D=2（v6.3 usageRate top-2，
  数据源 `packages/benchmark/tree-bench/summoners-decks/6.3.json`：`FqHByvwM…`（芙宁娜/蚀灭的源焰之主/阿佩普的绿洲守望者）
  与 `FhHB5+4P…`（芙宁娜/八重神子/贪食匿叶龙山王））× r0+r1（config `rounds:1`）× gamesPerCell=15。
- 模型：`baseUrl` 均指向本地 mock（`http://127.0.0.1:8931/v1`）；`apiKeyEnv` 各为
  `MOCK_A/B/C/D_API_KEY`（进程 env 赋假值 `sk-mock-a…d`）。Mock 按 `Authorization: Bearer`
  鉴权、按 body.model / prompt 标记返回确定性产物（author → 合法 GamePlanV1；
  reflect harness patch 协议 → `{"action":"patch","ops":[…]}` → `{"action":"final"}`）。
- 本机 pnpm corepack shim 损坏 → 于 `.tmp/smoke-tools/bin/` 放置 `pnpm.cmd`/`pnpm` shim
  （`node <corepack dist>/pnpm.js`）前置 PATH，编排脚本 `spawnPnpm` 的子进程经由它解析（不进仓库）。
- 失败隔离测试（验收 2）使用独立 5 模型 config 与独立 outRoot（`isolation-author/`，仅跑 author），
  主跑（M=4）不受污染。

## 1. 验收结果（spec §6 表 1–10）

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | author 逐模型 env 注入 | ✅ | 每模型 6 次 LLM 调用（4 single + 2 general），全部携带本模型专属 Bearer key（mock 日志逐条核对）；4 模型全部 12 份树的 planId 互不相同；`plan.author` = 模型名（author CLI 的 `--model` 落为 plan.author，字段名 `author`）；verify-author.mjs ALL PASS |
| 2 | 失败隔离 | ✅ | 5 模型 config（mock-e 的 key 有值但 mock 返回 401）：author 完成 mock-a…d 全部 32 个单元（singles+general+manifest），state.json 记 8 条失败（全部 `author\|mock-e\|…`），进程 **exit 1** 并打印失败清单；重跑 author 仅重试 mock-e（6 格 ×3 attempts），mock-a…d **0 次新增 LLM 调用**（mock 日志计数不变）→ 只补缺幂等 |
| 3 | 版本钉扎 | ✅ | 全部 r0 树 `context.gameVersion="v6.3.0"`（verify-author 逐份断言）；把 `plans/mock-b/v6.3/single.0-vs-0.r0.json` 手改为 v5.8.0 后跑 battle → `[fatal] opponent 格树（…single.0-vs-0.r0.json）版本 v5.8.0 与环境版本 v6.3.0 不一致——版本错配 fail-fast`，exit 1，报错含两个版本名；随后还原 |
| 4 | battle 幂等 | ✅ | battle 运行中 kill（等效 Ctrl-C）：kill 前 2 批完成 → state.json 保留 2 个 `battle\|…` key；续跑后这 2 批的 summary.json **mtime 未变**（未被重跑），半成品批自动重跑补齐；最终 112/112 批全部完成、0 失败。逐批断言（112 批全部）：`games=30`、perGame `planSide` 0/1 各 **15/15**、`alternateFirstPlayer=true` |
| 5 | evolve 组装 | ✅ | 8 个 portfolio 证据组各 2 组 / 420 局，全部过 `loadPortfolioWithValidation`（reflect 内部断言 + 组装后 portfolioId/planId 复核）；抽 X=mock-b 为 opponent 侧的 cell（`mock-a@r0__vs__mock-b@r0/v6.3/0-vs-1` → `evidence/mock-b/v6.3/1/r1/vs-0/`）比对 3 局：trace.side 保留（X 实际执舵位）、**首条 chosen 动作逐字节一致**、deckCodes 翻转为位置序（codes[side]=X 牌表）、perGame winner/planSide 与源 `summary.side1.json` 一致、合并 summary wins 与逐局重算一致 → verify-item5.mjs ALL PASS |
| 6 | reflect 生效 | ✅ | r1 产出 `plans/general.r1.json` + `plans/single.0.r1.json`/`single.1.r1.json`（8/8 portfolio）；**single.0 的规则集 ≠ r0**（patch `revise` 给 `single:0:global:<p>` 追加恒真条件），`parentPlanId` 正确指向 r0 planId，版本钉扎 v6.3.0 → verify-item6.mjs ALL PASS |
| 7 | export 映射 | ✅ | `results.by-model.json`/`by-model-deck.json` 各 3360 行；winner 仅 `p1/p2/draw`（1662/1662/36）；period ∈ {0,1} 且 = p1（plan 侧）代数；**p1≠p2 恒成立**（卡组级亦然）；mirror-only 变体 1680 行（di=dj 格）且为 by-model 子集；**平局计 0.5 用真实数据验证**（36 局自然平局、6 个 pair 有 draw，tree-bench heatmap.json 中 `aWinRate=(aWins+0.5×draws)/games` 全部精确成立）。重跑 export 输出逐字节一致 |
| 8 | analyze+plot | ✅ | 4 个视角（by-model / by-model-mirror / by-model-deck / by-model-deck-mirror）各产出 ratings.json / ratings-history.json / heatmap.json / spin-top.json（+ heatmap.svg）；`uv run` 五图全部成功：trajectory.png / improvement.png / heatmap-full.png / heatmap-deck-latest.png / spintop-summary.png；无对局格（跨模型跨代 24 个 pair）在 heatmap.json 中 `winProbMatrix=0.5` 且 `gamesMatrix=0` |
| 9 | 定标 | ✅ | 见 §2（局/秒、单局目录体积） |
| 10 | 干净续跑 | ✅ | `status`：author 32 单元 / evolve 8 / battle 112 批 / analyze 4 视角 / 可跑未跑批 0 / 失败清单：无 / 建议下一步：export → analyze；重复执行 author（1.7s，零子进程零 LLM 调用）、evolve（零调用）、battle（`无待跑批`）、export（输出与首跑逐字节一致）均 no-op，exit 0 |

**附**：gi-agent vitest 全量回归 `492 passed / 2 failed`（与基线一致；2 个失败为 `src/evaluation/benchmark/cli-config.test.ts` 的环境性 ENOENT——缺 `output/generated-rl-004/*.generated.json` 预生成产物，与本管线无关）。

## 2. 定标数据（验收 9）

| 指标 | 数值 |
|---|---|
| 引擎单局耗时（plan:batch 实测 avg，30 局批） | ≈ **1.46 s/局**（单批 wall 47.4s / 30 局 ≈ **0.63 局/秒**，含批进程启动；批内并发 4） |
| 全量冒烟对局 | 112 批 × 30 局 = **3360 局真实引擎对局**，battle 总耗时 ≈ 93 min（≈0.60 局/秒，批间串行） |
| 单局目录体积（含 state log） | ≈ **1.15 MB**（其中 `game_state_log.json` ≈ 187 KB） |
| 单局目录体积（不含 state log） | ≈ **0.87 MB**（2 份 plan_trace.json ≈ 450 KB/份） |
| run-001 总体积 | ≈ 3.9 GB（plans/portfolios/battles/evidence/results/ratings/plots/configs） |
| 抽样率 `stateLogSample:0.1` 下的 state log 保留 | 3360 局中 583 局（17.3%；链批 480 局恒全量 + 跨模型批按批粒度抽样，见 §4 观察项 O-1） |

## 3. 发现并修复的管线 bug（均在 `packages/gi-agent/scripts/ops/model-tournament.ts`）

### B-1（致命）`spawnPnpm` 未把 `opts.env` 传给 `spawnSync`
- 现象：author 子进程报 `需要 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL`——逐模型凭据注入完全到不了子进程，author/evolve 在任何无全局 `OPENAI_*` 的环境必然 100% 失败。
- 修复：`spawnSync("pnpm", args, { cwd, ...(opts.env !== undefined ? { env: opts.env } : {}), shell: true, … })`（一行条件展开 + 注释）。

### B-2（功能缺失）evolve 调 reflect 传了 `--patch` 但没传 `--turns`
- 现象：`plan:reflect` 的 patch 修订协议只在 harness 多轮模式生效（turns=1 的 one-shot 路径整体忽略 `--patch`，且 one-shot portfolio 模式 singles 恒原样保留）——singles 层永远无法被修订，spec §4.2 的分层修订与验收项 6 不可能达成。
- 修复：reflect args 增加 `"--turns", "4"`（patch + final，finalGate 打回一次仍有余量）。

### B-3（致命）battle 的版本钉扎断言对 **portfolio manifest** 而非其 general 计划树
- 现象：`assertTreeVersion(portfolioManifestPath(…))` 读的是 `portfolio.json`（无 `context.gameVersion` 字段）→ 首个批必报 `未声明 context.gameVersion` fail-fast，battle 永远跑不起来。
- 修复：新增 `portfolioGeneralTreePath(manifestPath)`（读 `manifest.generalPlan` 解析出 general 树路径），断言目标改为该树；报错同样含两版本名（验收 3 即按修复后语义验证）。

## 4. 观察项（未修，建议上游跟进）

- **O-1 state log 抽样退化为批粒度**：`sampleStateLogs` 用 `perGame.seed`（= seedBase+i 连续 30 个）做 `(seed%10000)/10000 < rate` 判定 → seedBase 落点决定**整批 30 局全保留或全删除**（单批内不会混合）。聚合比例仍 ≈10%（本跑 17.3%，链批全量另计），但方差大；若要逐局 10% 应改用对 seed 的散列值判定。
- **O-2 失败摘要首行非根因**：`finishWithFailureCheck` 打印 `f.error.split("\n")[0]`，而 `recordFailure` 存的是输出尾部 10 行——首行常是 `plan:author` 的 banner 而非真正的错误行（state.json 的完整 error 字段里含根因，功能不受影响，仅控制台摘要误导）。

## 5. 冒烟产物

- 主跑（M=4 全管线）：`packages/gi-agent/output/tournament-smoke-mock/run-001/`（≈3.9 GB）
  - `tournament.resolved.json` / `state.json`（author 32 + evolve 8 + battle 112 + analyze 4，0 失败）
  - `plans/<model>/v6.3/`（r0 树 24 份 + opponent-set）、`portfolios/<model>/v6.3/<di>/`（r0/r1 manifest+树）
  - `battles/<pair>/v6.3/<di>-vs-<dj>/`（112 批 × 30 局：plan_trace[.side1].json + 抽样 state log）
  - `evidence/<model>/v6.3/<di>/r1/vs-<dj>/`（own-generations 证据组，8 portfolio × 2 组）
  - `results/`（by-model / by-model-deck / 各 mirror；3360 行/视角）、`ratings/<视角>/`、`plots/*.png`（5 图）
- 失败隔离跑：`output/tournament-smoke-mock/isolation-author/`（5 模型 author；state.json 含 8 条 mock-e 失败为验收 2 的留证）
- Mock 与验收脚本（不进仓库）：`.tmp/smoke/`（mock-server.mjs、gen-configs.mjs、config.main.json、config.isolation.json、verify-author.mjs、verify-item4/5/6/7.mjs、measure-batch.mjs、verify-draw-half.mjs、mock-requests.log*）
- Mock LLM 请求日志：author 24 + reflect 16（8 portfolio × patch+final）+ 隔离跑 mock-e 401 若干，全部按 Bearer key 可溯源。

## 6. 复现要点

```bash
cd packages/gi-agent
export PATH="$PWD/.tmp/smoke-tools/bin:$PATH"
export MOCK_A_API_KEY=sk-mock-a MOCK_B_API_KEY=sk-mock-b MOCK_C_API_KEY=sk-mock-c MOCK_D_API_KEY=sk-mock-d
node ../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs .tmp/smoke/mock-server.mjs &
node ../../node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs \
  scripts/ops/model-tournament.ts .tmp/smoke/config.main.json <author|battle|evolve|export|analyze|status>
```
