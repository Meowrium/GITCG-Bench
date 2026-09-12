# LLM 证据整理式执行评估（organizer）：设计定稿

> 日期：2026-09-03。状态：**设计定稿**（待实现）。
> 决策过程：全链路产物审计（author / batch / reflect / ablate 各产物的 schema 与读取方普查）→
> 评估维度定义（展开路线发现 / 执行情况 / 错位脱节）→ 基准取舍拍板 →
> LLM 角色定稿为**证据整理者**（非评分者），2026-09-03 会话定稿。
> 关联：`oracle-free-harness-metrics.md`（产物 schema 与计数口径基线，本文的信息审计在其上标注读取方缺口）；
> `plans/2026-08-21-one-shot-gameplan-benchmark.md`（已知错位模式清单）；
> `plans/2026-08-30-oracle-free-selfevolution-arm.md`（engine-only 口径来源）；
> `plans/2026-09-03-cross-model-rating-tournament.md`（锦标赛联动，§6.7）。
> 整合稿：本方案与 `plans/2026-09-03-verifier-selected-selection-loop.md`（验证器选择回路，闭环改进侧）的修改建议已于
> [2026-09-03-integrated-roadmap-selection-organizer.md](./2026-09-03-integrated-roadmap-selection-organizer.md) 合并消重
> （重叠件 1–5：HarnessStats 扩展、跨代聚合、reflect 改动打包、run 目录契约、op 出处），
> 统一实施顺序以整合稿为准——本文定稿件构成其 Phase 0/1 主体。

## 1. 目标与定位

对受试模型（起草决策树的 LLM）做执行评估，三个维度：

1. **展开路线发现**：自主发现了卡组的哪些展开路线；
2. **执行情况**：这些路线的具体实践质量与过程；
3. **错位脱节**：计划声明与实际执行在哪些环节断裂。

前提：**无专家标注数据**。方法论拍板（2026-09-03）：

- 不引入任何人工标注参照（质量无法保证、覆盖不全测试卡组）；
- MCTS（ISMCTS oracle）不作为可信基准；NN（value 头 / nn-bridge）暂不使用；
- 另调一个 LLM 作为 **organizer（证据整理者）**：只做证据的组织、对齐与归因，
  **不打分**；输出全部带引用，**人工对整理结果做终审**。

即评估链路为：`机械锚点（已有产物计数） → organizer 整理成报告 → 人工终审`。
organizer 的职责边界：说清"提及了什么、实践了什么、哪里对不上"；"哪个更好"由人判断。

## 2. 基准取舍（定稿）

| 类别 | 内容 | 处置 | 理由 |
|---|---|---|---|
| 禁用 | `benchmark/deck-analysis` 专家标注（openingSequences / keyCards / matchups） | 不接入 | 无质量保证、不覆盖全部测试卡组；其 DESIGN.md 的 judge 协议与终审 checklist 思路仍作本文格式参考 |
| 禁用 | `plan_eval.json`（ISMCTS 口径）的 `isBlunder / visitGap / oracleBest / chosenRank / isDivergence` | 不进 organizer 证据 | MCTS 噪声不可作对错基准（弱配置 blunderRate 方差 ±25pp，`eval-game.ts:51-54` 自注） |
| 禁用 | `plan_eval.nn.json` 全部 value 字段、`candidates` 的 NN 评分、nn-bridge、NN 对手 | 暂不使用 | 用户约束 |
| 降级 | `branch-eval` 分支续战胜率 | 不用 | 分支排序依赖 policy（MCTS/NN），同源不可信 |
| 降级 | `knowledge/temporal-profiles` / `character-profiles` | 仅作语境 | 机器抽取自官方卡牌源码（非人工标注），但属启发式先验：允许 organizer 组织叙述时引用（confidence 过滤），不得作为结论依据 |
| 保留 | 胜负 / 胜率 / perGame / avgRounds | **仅作结果描述** | 是事实统计不是对错基准；作为各路线的结局背景供人工终审参考 |
| 保留 | 合法候选枚举（`candidateCount`，或对齐 state 的引擎枚举） | 仅作事实罗列 | "当时有哪些可选"是引擎事实；"哪个替代更优"需要被禁基准才能答，不做 |
| 保留 | `opp.threat.*` 威胁读数 | 带口径标注使用 | 机器抽取的伤害上界启发式（threat.ts）；**上界口径**，且打包环境 `loadSkillDamageMap` 降级时 lethal 系字段恒 undefined——此时"零威胁"不可下结论，`burstReady/burstP` 仍可用 |
| 保留 | seed 确定性重放 | 取证手段 | perGame 带 seed，任意局可纯引擎重放/展开证据，与被禁基准无关 |

副产品：评估端同样不碰 oracle，MCTS/NN 泄漏问题对 organizer 整体消失；
但 organizer 产物**不得回流 reflect prompt**（保持 oracle-free 臂语义不变）。

## 3. 信息启用清单（按三任务）

### 3.1 任务 1：整理"计划提及了哪些策略"

| 信息源 | 位置 | 说明 |
|---|---|---|
| 计划文本本体 | `plan.side0.json`（规则 when/then/reason、phaseId、fallback.policy、predictions） | "提及"第一手来源；`predictions` 是模型赛前对自己路线的明文断言，天然待检验对象 |
| 起草过程原话 | `<out>.transcript.jsonl` 的 `raw`（harness 模式，`agent-loop.ts:122-131`） | 计划 JSON 之外的口头提及：draft/final 理由、修复轮自辩、moduleRequests 钻取意图（模型主动查哪张卡 = 它认为自己缺什么知识） |
| 起草行为计数 | `<out>.harness.json`（`agent-loop.ts:133-164`）：`reasoningOnly / salvaged / protocolErrors / gatedFinals / adoptedDraftTurn / moduleRequests.perKind` | 现成质量探针，从未被评估，直接进报告 |
| 赛后归因文本 | `<out>.reflection.json` 的 `justification` / `predictionPostmortem`、patch op 的 `reason` / `falsifiableClaim` | 模型自我陈述也是"提及"；`keep` 类裁决目前完全无消费方（`run-plan-ablate.ts:531-535` 只取 revise/remove），归入此任务供人工核对其与证据是否相符 |

**已知证据缺口（报告中必须标注）**：author 侧不写 prompt.txt，harness 首轮 user 消息
不落 transcript——"模型当时看到了什么输入"在 author 侧不完整。

### 3.2 任务 2：整理"实际执行采用了哪些策略"

| 信息源 | 位置 | 说明 |
|---|---|---|
| 决策点时间线 | `game-NNNN/plan_trace.json` **逐条目**（`trace.ts:25-79`）：`matchedRule{scope,priority,layer}` / `chosen` / `fallbackUsed`+`fallbackPolicy` / `thenMiss` / `notes` / `candidateCount` / `threat?` | 全部与被禁基准无关。每局把 action 决策串成线，逐步标注"规则命中 / 兜底（何种 policy）"，即实际展开路线的最小重构 |
| 决策时局面 | `stateSignature`（`plan-player-io.ts:167-170`，构造 `fields.ts:36-60`） | 玩家视角：自己手牌明文+骰色、双方能量/HP/aura、召唤/支援/战斗状态实体及变量值；对手仅骰数与手牌数。现有消费方只抽约 8 类摘要字段——**改为整条直接喂** |
| 全局执行过程 | `game-NNNN/game_state_log.json`（`batch-runner.ts:459-460`） | 上帝视角全程快照：双方手牌/骰色/牌堆（含顺序）、实体变量、`roundSkillLog`、伤害/反应日志；`initialPile`/`pile` 差分可重建抽牌序列（读取端实现）。engine-only 流程目前**一次都不读**——实践层最大的未启用信息 |
| 结果层事实 | `summary.json` perGame（`batch-runner.ts:85-111`：seed/planSide/winner/rounds/coverage/ruleMatched/fallback/total） | 背景：离群局标注（coverage 塌落、rounds 异常），供逐局取证 |
| 对手侧实践 | `plan_trace.side1.json` / `summary.side1.json`（`batch-runner.ts:463,501`，默认流程写出后无人读） | plan-vs-plan 交互叙事："我方策略 X 在第 N 回合被对方规则 Y 反制" |

### 3.3 任务 3：整理"提及 ≠ 实践"的错位证据表

机械锚点全部现成（engine-only 口径已验证），organizer 只做语义归因：

| 锚点 | 位置 | 语义 |
|---|---|---|
| `perRuleHits = 0` 的规则 | `summary.json` | 写了从未打过（提及了但从未实践，"改没了"检测） |
| `perRuleThenMiss` | `summary.json` / trace 条目 `thenMiss[]` | when 全真但 then 零命中（死规则探针） |
| fallback 聚类 + 威胁列 | `fallback_report` 模块逻辑（`modules.ts:497-592`） | 出战角色×回合聚类；高威胁 fallback 优先归因 |
| `declareEnd` 占比 | fullDigest 统计 | 龟缩化代际信号 |
| perMethod 细分 | `summary.json` | opening 类决策（chooseActive/switchHands/rerollDice）目前反思证据**完全不覆盖**、只有计数——organizer 需补齐这一块的证据行 |
| `plan.predictions` vs 实战统计 | `run-plan-reflect.ts:498`（预测已拼进 statsText 但从未被独立检验） | 提及 vs 实践最直接的对齐点 |
| plan-replay 静态回放断言 | `plan-replay.ts:314-326`（status `fixed/partial/ineffective/no-target`） | 修订为何没生效/留了覆盖洞；**目前只以文本存在于 transcript，需先落盘（§4-3）** |

### 3.4 引擎可得但写入端丢弃、需补采的信息

1. **结构化 mutation 流**：`sandbox/runner.ts:122-124` 把 `onPause` 的 mutations 丢弃、
   `PlanPlayerIO.notify`（`plan-player-io.ts:150-165`）只取 state——`game_state_log.e`
   **恒为空数组**（与 `battle-benchmark/SELF-EVOLUTION-IMPL.md` 宣称不符）。
   接上后伤害/治疗/抽牌/充能/重掷原因/实体增删全部结构化可读，是"实践清单"里
   决策点之间的过程证据。
2. **DetailLog 文本事件流**（`core/src/log.ts:274-326`）：最接近"人类解说"的素材，
   SandboxRunner 未接线、全仓无读取方。
3. **重掷前后骰面**：trace 只记 `chosen:{actionCase:"rerollDice"}`（`plan-player-io.ts:556-581`）。
4. ~~终局快照：gameEnd 不触发 onPause，每局日志缺最后一段~~（**2026-09-05 复核修正：
   已过时**——core `gotWinner` 现无条件 `notifyAndPause()`（`core/src/game.ts` `gotWinner`
   实现，行内注释自述即为此修复：inline 事件处理器直接切 gameEnd 不暂停时，MCP 快照
   不同步）；实证跑局确认 state log 末条 `phase=gameEnd` 且带 `winner`。终局快照
   无需补采，本项从改动清单移除）。
5. **落选候选 preview**：引擎 `exposeAction.preview` 全量可得，trace 只记选中动作的 `previewDamage`。

## 4. 落地改动清单

| # | 件 | 位置 | 内容 |
|---|---|---|---|
| 1 | 补采 mutation 流 | `sandbox/runner.ts`（onPause 回调） | mutations 不再丢弃 → `game_state_log.e` 真实落盘。纯写入端，不影响决策确定性（终局快照半边于 2026-09-05 复核删除：gameEnd 已随 onPause 落盘，见 §3.4-4） |
| 2 | 补采重掷骰面 / 候选 preview（可选） | `plan-player-io.ts` | reroll 记录前后骰面；action 决策点可选记录落选候选 preview 摘要 |
| 3 | plan-replay 报告落盘 | `run-plan-reflect.ts`（patch 合并处） | `PlanReplayResult` / `PatchAssertion[]` JSON 落 `<out>.replay-report.json`（现在只有文本进 transcript） |
| 4 | 校验计数持久化 | `agent-loop.ts` HarnessStats 扩展 | draft 校验 issues / lint findings / dropped / patch 拒绝按类别计数（接管 `oracle-free-harness-metrics.md` §6 缺口） |
| 5 | **证据导出器**（新 CLI，建议 `plan:organize-export`） | `src/runtime/plan-oneshot/cli/` | 读 runDir 输出 organizer 证据包：**放宽上限**的 fullDigest（含 opening 类决策点）+ 整条 `stateSignature` + 抽牌序列差分 + perGame 离群标注 + side1 包。不复用 reflect 的截断口径（3/局、8/run、420 行是 prompt 预算，`evidence-extract.ts:281-283`） |
| 6 | organizer 编排脚本 | `scripts/ops/organize-run.ts` | 三任务三次 LLM 调用（可并行）；CallLlm **注入式**双 env（先例：`benchmark/battle-benchmark/src/evolve/` 的 modelTested/modelOpponent；不塞进 `cli/llm.ts`——它只认单一 `OPENAI_*` env、`--model` 不换 baseURL，`llm.ts:124-128`） |
| 7 | 报告 schema 与渲染 | 同上 | JSON + markdown 双输出；引用格式统一 `{file, game, seq/turn, ruleKey}`，人工可按图索骥 |

复用（零改动）：`loadAlignedGameInput`（`eval-game.ts:255-301`，trace↔state log 签名
对齐与 oracle 无关，作取证底座）；`modules.ts` 的 serve 函数（`game_summary` /
`decision_detail` 等即现成文本化器，仅 4000 字符截断 `modules.ts:55` 需按需放宽）；
`scripts/ops/render-game-log.ts` 的 markdown 范式；`analysis/deck-analytics` 作
骰子/能量/伤害净账的"计算器"（防 organizer 口算出错；该模块目前零调用方）。

## 5. organizer 输出协议（人工终审版）

**不打分**（终审是人）；三个报告产物 + 可选代际汇总：

1. `mentions`（提及清单）：策略条目 × 首次出现位置（计划文本 / transcript 轮次）× 是否被 `perRuleHits` 证实进入执行；
2. `practice`（实践清单）：逐局展开线重构（决策点序列 + 每步规则命中/兜底标注 + 决策时局面摘要 + 结局背景）；
3. `misalign`（错位证据表）：条目 = 机械锚点定位 + organizer 语义归因 + 证据链；
4. （可选）代际汇总：逐代趋势叙事——恰好接管 `oracle-free-harness-metrics.md` §11 自认的"engine-only 指标无跨代聚合"缺口。

条目 schema：`{ id, 维度(路线|执行|错位), 结论, 引用[{file, game, seq|turn, ruleKey}], 机械锚点?, 置信(high|medium|low), 备注 }`。
置信定义：high = 有直接机械锚点支撑；medium = 证据链完整但需解读；low = 跨局推断/样本少。
**每条结论强制附引用**——这是人工终审能高效进行的先决条件。

人工终审 checklist 借鉴 `benchmark/deck-analysis/DESIGN.md` §九的反思质量清单思路
（区分分析错误 vs 随机性、要求具体事件论据、检查修正差异点、过度修正应扣分）——
只借鉴维度设计，其标注数据本身不启用。

## 6. 注意事项与已知风险

1. **视角纪律**：判"决策时合理性"用玩家视角（`stateSignature` / exposeState），
   判"路线与结果"才用上帝视角（game_state_log）；同一报告内两种视角分开标注，
   防止"没看到对手手牌"式误判。
2. **不让 organizer 口算**：骰子支付、伤害结算、能量账交 deck-analytics / 引擎重放；
   organizer 只引用计算结果。
3. **替代选项口径**：只罗列事实（当时合法候选 + 实际选择），不判优劣——优劣判断留给人工终审。
4. **threat 上界口径**：打包环境 lethal 系字段可能静默 undefined，报告遇"零威胁"必须核对伤害表可用性。
5. **旧 trace 口径断层**（`oracle-free-harness-metrics.md` §10）：2026-09 修复前
   chooseActive 单候选计 fallback、patch 覆盖无确认闸——跨代整理旧数据时先对齐口径。
6. **隔离**：organizer 产物不回流 reflect prompt（保持 oracle-free 臂自进化语义）。
7. **锦标赛联动**：cross-model tournament（2026-09-03 设计稿）阶段 2 目前只消费
   summary perGame（winner/planSide/seed）；若要引入本方案，需保留（或按格抽样归档）
   game-* 目录的 trace / state log，否则无执行证据可整理。
8. **对局产物一致性**：`game_state_log.e` 从恒空变为真实落盘后，旧 run 与新 run 的
   state log 结构不同——导出器与消费方需按 `e` 字段有无做兼容分支。

## 7. 实施顺序建议

1. 补采两处（§4-1/2，写入端改动，随下一次 batch 生成即生效；终局快照无需补采，见 §3.4-4 复核）；
2. 落盘两件（§4-3/4）；
3. 证据导出器（§4-5）+ 单模型单 run 试点：organizer 跑三任务，人工校准 prompt 与报告粒度；
4. 接入 harness 编排（`scripts/ops/portfolio-generation.ts` 每代 reflect 之后挂 organizer），产出逐代报告；
5. 稳定后再考虑与 cross-model tournament 的 game-* 归档策略合并。
