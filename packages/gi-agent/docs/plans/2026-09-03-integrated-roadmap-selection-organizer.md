# 整合路线图：验证器选择回路 × LLM 证据整理评估

> 日期：2026-09-03。状态：**设计整合稿**（合并两案修改建议，重叠件以本文为准）。
> 整合对象：
> [2026-09-03-verifier-selected-selection-loop.md](./2026-09-03-verifier-selected-selection-loop.md)（验证器选择监督与候选选择器回路，**待评审**，下称 A 案）×
> [2026-09-03-llm-evidence-organizer-eval.md](./2026-09-03-llm-evidence-organizer-eval.md)（LLM 证据整理式执行评估 organizer，**设计定稿待实现**，下称 B 案）。
> 两案同源于 [2026-08-30-oracle-free-selfevolution-arm.md](./2026-08-30-oracle-free-selfevolution-arm.md) 的 engine-only 臂，共享 [oracle-free-harness-metrics.md](../oracle-free-harness-metrics.md) 的产物 schema 与计数口径。本文只做合并消重、边界固定与统一排期；两案原文的论证细节不在此重复，以原文为准。

## 1. 两案的互补定位

两案都在 engine-only 臂上扩展，方向正交：

- **A 案 = 闭环内补"选"**：回答"多个候选修订进哪个主干"。论文 RQ2 证明 generate-N → verify-all → 机械选择显著优于 LLM 自选；补的是选择器环节（P0：候选池 + 机械选择器、harvest/holdout 分区；P1：换测量、被拒留档、配对统计 + headroom 预检；P2：出处标注、监督面消融）。
- **B 案 = 闭环外补"看"**：回答"计划提及了什么、实际执行了什么、哪里对不上"。LLM 只做证据整理不打分，人工终审；补的是评估取证环节（写入端补采、证据导出器、三任务报告）。

组合后的整体链路：

```
机械锚点 + 候选判据（环内）
  → 机械选择进主干（环内，只认 judgeEngineOnly + 配对结局统计）
  → organizer 逐代整理报告（环外，带引用）
  → 人工终审（人判断"哪个更好 / 为什么错位"）
```

一句话：**闭环内补"选"，闭环外补"看"；两案共用同一批写入端基建**（mutation 流、HarnessStats、run 目录契约），这是整合的最大收益——一次写入端改动同时喂养选择器与评估器。

## 2. 重叠改动合并（五处）

两案独立认领的改动有五处实质重叠；基线文档 [oracle-free-harness-metrics.md](../oracle-free-harness-metrics.md) §11 的补齐建议原文（"跨代聚合脚本读各代 summary.json + harness.json 出 trend 图；校验期在 harness 反馈路径加结构化 issue 分类计数并并入 HarnessStats"）恰是重叠件 1/2 的共同出处。合并后各实现一次。

### 重叠 1：HarnessStats 统一扩展（agent-loop.ts）——完全合并

- A 案 §4.4：被拒 draft/patch 结构化留档（原因码 + 判据读数）；校验期 issue 类别直方图并入 HarnessStats。
- B 案 §4-4：校验计数持久化——draft 校验 issues / lint findings / dropped / patch 拒绝按类别计数（接管基线 §6 缺口）。
- **合并做法**：HarnessStats **一次 schema 扩展**同时承载——
  - `issueHistogram`：死规则 / 格式 / 封闭集合违规 / lint / patch 拒绝（两案要求的直方图同型）；
  - `rejected`：被拒 draft/patch 逐条记录（A 案需要原因码，B 案 mentions 任务按类别消费；判据读数字段仅在消融/选择场景填充）；
  - lint findings / dropped / attempt 计数随同并入（基线 §7.3 列明的"被拒/未通过无计数器"不对称一并关闭）。
- 消费方：A 案候选证据链；B 案任务 1 的起草行为计数；基线 §6/§7.3/§11 三缺口一次关闭。
- 同步义务：改 schema 须同步 `oracle-free-harness-metrics.md`（其文件头规则）。

### 重叠 2：跨代聚合（基线 §11 缺口）——管道合并，机械层先行、叙事层挂接

- A 案 §4.4：聚合脚本读各代 summary.json（引擎侧五指标）+ harness.json（行为计数）出 trend 图。
- B 案 §5-4 / §7-4：organizer 代际叙事接管同一 §11 缺口；`scripts/ops/portfolio-generation.ts` 每代 reflect 后挂 organizer。
- **合并做法**：**一个聚合脚本**产机械层（趋势图/表落盘）；organizer 代际叙事读同一聚合产物作输入，不另起聚合逻辑。每代节奏固定为 `reflect → 聚合脚本（机械层）→（可选）organizer 三任务（叙事层）`。
- 时序：机械层不依赖 A 案评审结果，可与 B 案 Phase 1 并行；叙事层随 B 案稳定后挂接（B §7-4）。两层共用一个挂接点，互不阻塞。

### 重叠 3：run-plan-reflect.ts 改动打包——同文件两改，一批实现

- A 案 §4.1：`--candidates K` 多出口 + 候选产物落盘约定。
- B 案 §4-3：`PlanReplayResult` / `PatchAssertion[]` JSON 落 `<out>.replay-report.json`（现在只有文本进 transcript）。
- 关联：replay-report 同时是 A 案候选的证据件（该候选是否生效/为何失败）与 B 案任务 3 错位表的证据源（B §3.3 末行明注"需先落盘"）。
- **合并做法**：两个改动同一批实现；候选落盘目录约定把 replay-report 与 harness sidecar 纳入每候选产物组，避免选择器落地时返工。

### 重叠 4：run 目录 / 批跑 config 契约——一次定契约

- A 案 §4.2：harvest/holdout 对手分区字段写进 run 目录或批跑 config 约定；锦标赛 D² 对手矩阵充当 holdout 总体。
- B 案 §6.7 / §7-5：锦标赛阶段 2 引入 organizer 需保留（或按格抽样归档）game-* 目录，否则无执行证据可整理。
- **合并做法**：run 目录契约**一次扩展**——分区字段（harvest/holdout）+ game-* 归档策略，`batch-runner.ts` 与锦标赛 `model-tournament.ts` 实现同一契约。同一份锦标赛归档既当 A 案的 holdout 总体，又当 B 案的执行证据源。
- 收益：避免两次改 config schema 与两套归档约定。

### 重叠 5：plan-patch.ts op 级出处字段——一字段两消费方

- A 案 §4.6：op 证据锚点字段（该 op 源于 thenMiss 锚点 / threat 读数 / LLM 自由叙述），消融可按出处分层；§8 主张强度分类学的最小实现。
- B 案 §3.3 / §5：错位证据表的语义归因需要知道"这条修订为什么被提出"。
- **合并做法**：op 增加证据锚点字段一次落地；A 案用于出处分层消融，B 案 misalign 报告直接引用。

## 3. 边界纪律（整合后固定）

以下为跨案新增纪律；各案原文护栏（A 案 §6"明确不动的部分"、§8 主张边界，B 案 §6 注意事项）不因整合失效。

1. **单向隔离**：organizer 产物不回流 reflect prompt（B §6.6）；选择器判据只消费引擎事实与结局统计（A §4.1/§5）。统一表述：**LLM 生成的叙述类产物（organizer 报告、transcript 叙述）永不进入环内判据；环内选择只认 `judgeEngineOnly` + 同种子配对结局统计。**
2. **两套截断口径并存**：reflect prompt 预算（3/局、8/run、420 行，`evidence-extract.ts:281-283`）是环内 prompt 预算产物；organizer 导出器放宽口径（B §4-5）是环外取证产物，不复用前者。verdict-only 消融（A §4.7）若证明细粒度 digest 不载荷，**只收缩环内 reflect 口径**，不影响 organizer 侧。
3. **"候选"分层消歧**：A 案候选池 = **计划修订级**（K 个修订候选选 1 进主干，K 取 2–4）；B 案落选候选 preview（§3.4-5）= **动作级**（单决策点的替代动作摘要）。代码与文档命名须区分（如 plan 级 `candidates` vs 动作级 `candidatePreview`），防止实现混淆。
4. **NN 双重暂不启用**：A 案 §5 分值型验证器（NN）不进选择环；B 案 §2 禁 NN 评分与 NN 对手进 organizer 证据。整合后维持同一纪律；**任一侧要启用 NN，须同时重审另一侧**。
5. **oracle-free 臂语义**：organizer 不碰 oracle（副产品：MCTS/NN 泄漏问题对 organizer 整体消失），但 oracle-free 臂定义不因 organizer 改动；A 案 §6 清单所列部件继续不动。
6. **口径断层兼容**：跨代聚合与 organizer 导出器读旧 run 时，须处理——基线 §10 的 2026-09 前口径断层（chooseActive fallback 计数、overwritePatches 闸）与 B §6.8 的 `game_state_log.e` 字段有无（旧 run 恒空数组），做兼容分支或明确标注数据起点。
7. **"holdout"双义消歧**（2026-09-05 拍板引入）：09-02 已实现的 `heldout[]`（singles 未覆盖对手打 general-only，**泛化检验**语义）与 A 案 holdout 总体（**防过拟合分区**语义，定稿 = 锦标赛 D² 对手矩阵）是两种不同机制、并存不合并——代码命名、config 字段与文档表述必须区分，不得混用"heldout"一词。

## 4. 统一实施顺序

四期 + 可选实验。B 案定稿件先行（纯写入端、低风险），A 案回路件待评审通过后启动；两案主体互不依赖可并行。
**2026-09-05 执行拍板**：A 案暂不定稿、**不做候选**——Phase 2（P2-1/2/3）全部挂起，当前执行范围见
[2026-09-05-tournament-execution-plan.md](./2026-09-05-tournament-execution-plan.md) §2（含 Phase 0/1、P3-1、锦标赛、锚点实验；
P0-5 分区字段照常落地但本次无消费方；P2-2 两级 strata 设计保留文档、实施随 A 案定稿后排期）。

### Phase 0 — 写入端补采与落盘（B 案定稿件 + 两案共同基建）

纯写入端改动，不影响决策确定性，随下一次 batch 生成即生效（B §7-1/2）。

| # | 件 | 来源 |
|---|---|---|
| P0-1 | mutation 流接线（`game_state_log.e` 真实落盘；终局快照经 2026-09-05 复核已随 onPause 落盘，无需补采） | B §4-1 |
| P0-2 | 重掷前后骰面 / 落选候选 preview 摘要（可选） | B §4-2 |
| P0-3 | plan-replay 报告落盘 `<out>.replay-report.json` | B §4-3（重叠 3 的 B 半边） |
| P0-4 | HarnessStats 统一扩展（被拒留档 + issue 直方图） | 重叠 1 |
| P0-5 | run 目录契约扩展：harvest/holdout 分区字段 + game-* 归档策略 | 重叠 4 |

### Phase 1 — organizer 评估链路（B 案定稿）

| # | 件 | 来源 |
|---|---|---|
| P1-1 | 证据导出器 `plan:organize-export`（放宽口径 fullDigest + 整条 stateSignature + 抽牌序列差分 + perGame 离群标注 + side1 包） | B §4-5 |
| P1-2 | organizer 编排脚本 + 报告 schema（三任务三次 LLM 调用可并行；CallLlm 注入式双 env，先例 `packages/benchmark/battle-benchmark/src/evolve/`） | B §4-6/§4-7 |
| P1-3 | 单模型单 run 试点：organizer 跑三任务，人工校准 prompt 与报告粒度 | B §7-3 |

### Phase 2 — 选择器回路（A 案待评审，评审通过后启动）

| # | 件 | 来源 |
|---|---|---|
| P2-1 | `plan:reflect` 增加 `--candidates K` 多出口（harness 模式各通过校验的 final 均留候选；one-shot 模式重复采样） | A §4.1（重叠 3 的 A 半边） |
| P2-2 | `ablate-criteria.ts` 扩展：同种子配对精确检验（McNemar 式）+ 两级 strata（主门 = 先手/后手均正，阻断 supported；次级 = 按对手分组诊断输出，只报告不阻断）+ `no-headroom` 预检输出 | A §4.5（2026-09-05 拍板：两级都做） |
| P2-3 | 选择器入口 + 选择策略四臂消融（基线 / 仅 schema / LLM 自选 / 机械判据）+ holdout 门（harvest supported 且 holdout 不劣化） | A §4.1/§4.2（holdout 总体读 P0-5 契约字段） |

### Phase 3 — 治理台账与出处（两案合流）

| # | 件 | 来源 |
|---|---|---|
| P3-1 | 跨代聚合脚本（机械层：五指标 + 行为计数 + issue 直方图 trend） | 重叠 2 |
| P3-2 | organizer 接入 `portfolio-generation.ts` 每代节奏（叙事层） | B §7-4（重叠 2 叙事半边） |
| P3-3 | plan-patch op 级证据锚点字段 | 重叠 5 |
| P3-4 | `learning/rl/cli` 导出语料出处标签 | A §4.6 |

### Phase 4 — 可选实验

| # | 件 | 来源 |
|---|---|---|
| P4-1 | verdict-only prompt 臂（检验细粒度 digest 是否载荷，负结果则收缩环内口径） | A §4.7 |
| P4-2 | 锦标赛 game-* 归档与 organizer 合并 | B §7-5（重叠 4 兑现） |

**依赖要点**：Phase 0 是两案共同前置——P0-3/P0-4 同时被 Phase 1/2 消费，P0-5 是 A 案 holdout 门的硬依赖、B 案锦标赛联动的软依赖。Phase 1 与 Phase 2 互不依赖可并行。P3-1 不依赖 A 案评审结果，可提前与 Phase 1 并行。
**2026-09-05 拍板更新**：holdout 总体定稿为锦标赛 D² 对手矩阵（§6-2）——P2-3 的 holdout 门相应依赖 `model-tournament.ts` battle 产物就绪（含 P0-5 分区字段）；"一口气实现"前提下锦标赛与回路同期落地，不构成排期矛盾。跨代树来源定稿为 harness `--patch` 模式（锦标赛稿 R9），evolve 编排与 Phase 0/2 的写入端改动同期实现。

## 5. 统一部件调整清单（文件级）

| # | 部件 | 位置 | 改动 | 来源 | 期 |
|---|---|---|---|---|---|
| 1 | mutation 流接线 | `sandbox/runner.ts`（onPause 回调） | mutations 不再丢弃 → `game_state_log.e` 真实落盘（终局快照无需补采，见 B §3.4-4 复核） | B §4-1 | P0 |
| 2 | 决策点补采 | `plan-player-io.ts` | 重掷前后骰面；落选候选 preview 摘要（可选） | B §4-2 | P0 |
| 3 | 回放报告落盘 | `cli/run-plan-reflect.ts`（patch 合并处） | `PlanReplayResult` / `PatchAssertion[]` → `<out>.replay-report.json` | B §4-3；A 案候选证据共用 | P0 |
| 4 | HarnessStats 扩展 | `cli/agent-loop.ts` | 被拒 draft/patch 结构化留档 + issue 类别直方图 + lint/dropped/attempt 计数 | 重叠 1（A §4.4 + B §4-4） | P0 |
| 5 | run 目录契约 | 批跑 config / `cli/batch-runner.ts` | harvest/holdout 分区字段 + game-* 归档策略 | 重叠 4（A §4.2 + B §6.7） | P0 |
| 6 | 候选出口 | `cli/run-plan-reflect.ts` + `cli/agent-loop.ts` | `--candidates K`；候选产物落盘约定（每候选含 replay-report + harness sidecar） | A §4.1 | P2 |
| 7 | 判据扩展 | `cli/ablate-criteria.ts` | 配对精确检验；两级 strata（先/后手主门阻断 + 对手分组次级诊断）；`no-headroom` 预检输出 | A §4.5 | P2 |
| 8 | 选择消融 | `cli/run-plan-ablate.ts`（或独立选择器 CLI，见 §6-1） | 选择策略四臂；holdout 门 | A §4.1/§4.2 | P2 |
| 9 | 证据导出器 | `cli/`（新）`plan:organize-export` | 放宽口径 fullDigest（含 opening 类决策点）+ 整条 stateSignature + 抽牌序列差分 + perGame 离群标注 + side1 包 | B §4-5 | P1 |
| 10 | organizer 编排 | `scripts/ops/organize-run.ts`（新） | 三任务三次 LLM 调用 + JSON/markdown 双输出 + 统一引用格式 `{file, game, seq/turn, ruleKey}` | B §4-6/§4-7 | P1 |
| 11 | 跨代聚合 | `scripts/`（新） | 读各代 summary.json + harness.json（+ P0-4 后 issue 直方图）出 trend | 重叠 2 | P3 |
| 12 | 逐代挂接 | `scripts/ops/portfolio-generation.ts` | 每代 reflect 后：聚合脚本 →（可选）organizer | B §7-4 | P3 |
| 13 | op 出处 | `plan-patch.ts` | op 级证据锚点字段 | 重叠 5（A §4.6；B misalign 引用） | P3 |
| 14 | 语料出处 | `learning/rl/cli` | 导出数据集带出处标签 | A §4.6 | P3 |
| 15 | verdict-only 臂 | `prompts/reflect-system-engine-only.md` | verdict-only prompt 变体（可选实验） | A §4.7 | P4 |
| 16 | 锦标赛归档 | 锦标赛 `model-tournament.ts`（未建，见锦标赛设计稿） | 按 P0-5 契约保留/按格抽样归档 game-* | 重叠 4（B §7-5） | P4 |

**文档同步义务**：件 1/2/4/5/6 落地后同步 `oracle-free-harness-metrics.md` 的 schema 与计数口径；件 9/10 落地后更新本包 `docs/INDEX.md`。

## 6. 遗留给实施评审的三个待决点

1. **选择器入口形态**：并入 `plan:ablate` 四臂 vs 独立小 CLI（A §4.1 留双选项）。倾向并入 `plan:ablate`——臂设施现成，四臂消融本就是其形态。
2. **harvest/holdout 分区键**——**已拍板（2026-09-05）**：holdout 总体 = 锦标赛 D² 对手矩阵（A §4.2 的"对手集/种子梯显式二分"不采用为主机制）；分区字段语义定稿为 run 目录 / 批跑 config 标注 `harvest`（进 reflect 的证据批跑）/ `holdout`（锦标赛对局，**永不进 reflect 证据**）。与 09-02 `heldout[]`（泛化语义）命名区分（边界纪律 7）。
3. **P0-4 被拒留档粒度**：逐条留（含 issue 明细）vs 只留类别计数 + 首条原因。B 案 mentions 任务倾向逐条；transcript 已有反馈全文（基线 §7.2）兜底，结构化留档按逐条 + 原因码设计，体积可接受。
