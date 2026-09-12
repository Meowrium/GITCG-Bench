# WP4 实现规格：organizer 评估链路（证据导出器 + 三任务编排 + 试点）

> 来源：[impl-spec-0-overview.md](./2026-09-05-impl-spec-0-overview.md)；目标：执行方案阶段 4（B 案 Phase 0+1）。
> 设计依据：[2026-09-03-llm-evidence-organizer-eval.md](./2026-09-03-llm-evidence-organizer-eval.md)
> （B 案定稿，全篇为契约来源——实现时冲突以该文为准）；整合稿 P1-1/P1-2/P1-3。
> organizer 模型（已拍板）：deepseek-v4-flash-vision-exp（与受试模型重叠已确认无碍运行）。
> 状态：**已实现**（件 1/2/3 代码落地 2026-09-05；件 4 试点为人工环节，待阶段 2 正赛真实对局数据）。

## 1. 交付物

| # | 件 | 位置 |
|---|---|---|
| 1 | 证据导出器 CLI | `gi-agent/src/runtime/plan-oneshot/cli/run-plan-organize-export.ts`（package.json script `plan:organize-export`） |
| 2 | organizer 编排脚本 | `gi-agent/scripts/ops/organize-run.ts` |
| 3 | 报告 schema + markdown 渲染 | 同上（`organizer-report.schema.json` + 渲染函数） |
| 4 | 试点报告与校准记录 | 试点产物目录 + `PILOT-NOTES.md`（人工环节，见 §5） |

## 2. 证据导出器（件 1）

`pnpm run plan:organize-export -- --run-dir <dir> --out <evidencePack目录> [--games all\|N\|--outliers]`：

- **输入**：一个 plan:batch run 目录（含 game-NNNN/*；WP2 落地后的新 run 有 `e` mutations）。
- **输出**（evidencePack，全为已有产物的选编+放宽口径重组，不新算）：
  1. `fullDigest.txt`：**放宽口径**的逐局决策证据（含 opening 类决策点
     chooseActive/switchHands/rerollDice——reflect digest 目前不覆盖的块；上限**试点
     定标**，初值：单局不设截断、总 2000 行、字符 200k——P1-3 人工校准后改终值）；
  2. `stateSignatures.jsonl`：每决策点整条 `stateSignature`（不抽摘要）；
  3. `draw-sequence.md`：各局 `initialPile`/`pile` 差分重建的抽牌序列（读取端计算）；
  4. `outliers.json`：perGame 离群标注（coverage 低于中位数 -2σ、rounds 超 P95）；
  5. `side1/`：对手侧 trace + summary 包（`plan_trace.side1.json` / `summary.side1.json`）。
- **复用**（B 案 §4 已核实的零改动件）：`modules.ts` serve 函数（`game_summary`/
  `decision_detail` 文本化器；4000 字符截断**按需放宽**——导出器路径传大上限参数，
  不改 reflect 路径现值）；`loadAlignedGameInput`（`eval-game.ts:255-301`）对齐底座。
- **口径纪律**：不复用 reflect 的 3/局、8/run、420 行预算（那是环内 prompt 预算）；
  导出器上限独立参数化。

## 3. organizer 编排（件 2）

`pnpm exec gnx scripts/ops/organize-run.ts --evidence <pack目录> --out <报告目录>
[--tasks mentions,practice,misalign] [--model deepseek-v4-flash-vision-exp]`：

- 三任务各一次 LLM 调用（可并行）：`mentions`（计划提及清单）/ `practice`（实践清单）/
  `misalign`（错位证据表）——任务定义、输入信息源映射、输出条目 schema 全按 B 案
  §3/§5（条目：`{id, 维度, 结论, 引用[{file,game,seq|turn,ruleKey}], 机械锚点?, 置信,
  备注}`；**不打分**；每条结论强制附引用）。
- **LLM 调用**：注入式双 env（先例 `benchmark/battle-benchmark/src/evolve/` 的
  CallLlm 注入形态——**不塞 cli/llm.ts**，它单 env 不换 baseUrl）；organizer 凭据走
  `ORGANIZER_API_KEY/ORGANIZER_BASE_URL/ORGANIZER_MODEL`（默认值 = deepseek 拍板组合）。
- **输出**：`report.json`（过 schema 校验）+ `report.md`（人读渲染，引用可点路径）；
  调用失败逐任务隔离重试 2 次。
- **隔离红线**：organizer 产物目录与 reflect 输入目录物理分开；编排脚本不得写
  reflect 的 --run-dir 指向的任何路径。

## 4. 报告 schema（件 3）

`organizer-report.schema.json`（JSON Schema）：顶层 `{runDir, model, tasks: {mentions?,
practice?, misalign?}, generatedAt}`；每 task = 条目数组（B 案 §5 条目 schema）；
`引用.file` 限于 evidencePack 相对路径白名单。校验不过 = 条目级剔除并记
`invalidEntries`（不整报作废）。

## 5. 试点（件 4，人工环节）

- 输入：阶段 2 正赛的**单模型单 run**（含链批局全量 state log）；
- 流程：导出 → 三任务 → `report.md` 人工审：①引用抽查 5 条能否按图索骥复现；
  ②粒度是否可读（过细/过粗调 prompt）；③上限定标（fullDigest 行/字符、modules
  截断值）回写 §2 初值；
- 产物：`PILOT-NOTES.md` 记录定标终值与 prompt 修订 diff（供后续批量跑）。

## 6. 验收标准

| # | 项 | 判据 |
|---|---|---|
| 1 | 导出完整性 | 对冒烟 run 出五件产物；fullDigest 含 opening 类决策点行；outliers 数字与 perGame 一致（抽验） |
| 2 | 抽牌序列 | 任取一局：draw-sequence 与 game_state_log 的 pile 差分手工比对一致 |
| 3 | side1 包 | plan-vs-plan run 的 side1/ 有内容且与 side0 视角互补（同一局两边 trace 都在） |
| 4 | 三任务产物 | report.json 过 schema；≥1 条 misalign 条目带机械锚点（perRuleHits=0 或 thenMiss）；引用路径全部存在（脚本校验） |
| 5 | 双 env | 不设 OPENAI_* 只设 ORGANIZER_* 时编排可跑（证明未依赖 cli/llm.ts 单 env） |
| 6 | 隔离 | organize-run 全流程无任何对 reflect 输入目录的写操作（ls -lR 前后对比） |
| 7 | 回归 | `pnpm test` 全绿（导出器为新增 CLI，不动现有路径） |

## 7. 明确不做

不做代际汇总任务（B §5-4，待正赛多代产物后）；不接 deck-analysis 专家标注（B 案 §2
禁用表）；不让 organizer 碰 oracle/NN 证据；不做评分（终审是人）。
