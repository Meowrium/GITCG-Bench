# gi-agent 文档索引

> 当前阶段：V28+ · 最近重构：2026-06 仓库结构整理

---

## 🟢 活跃文档（保持 / 在用）

| 文档 | 主题 |
|------|------|
| [README.md](./README.md) | 包概览（极短） |
| [combat-window-pipeline.md](./combat-window-pipeline.md) | LLM 对局日志 → 局部窗口树 → 离线验证 → branch-eval 一阶段种子树流水线 |
| [standalone-mcp-windows-startup.md](./standalone-mcp-windows-startup.md) | Standalone MCP Windows 启动指南 |
| [v26-ai-architecture-recommendations.md](./v26-ai-architecture-recommendations.md) | V26 AI 架构建议（transition-based 决策链路） |
| [v26-hidden-constraints-validation-plan.md](./v26-hidden-constraints-validation-plan.md) | V26 9 个隐藏约束假说 + 验证方案 |
| [v27-transition-constraints-formalization.md](./v27-transition-constraints-formalization.md) | V27 形式化方案：Transition State/T/V_T + H1-H9 完整伪代码 |
| [v27-prompt-for-gpt.md](./v27-prompt-for-gpt.md) | V27 投喂 GPT 的问题描述 |
| [v28-answers-to-prompt.md](./v28-answers-to-prompt.md) | V28 答 prompt |
| [v28-gi-agent-ml-review-and-improvement-plan.md](./v28-gi-agent-ml-review-and-improvement-plan.md) | V28 gi-agent + gi-ml 审查与 12 项实施任务清单 |
| [v28-prompt-for-qwen.md](./v28-prompt-for-qwen.md) | V28 投喂 Qwen 的修复指令 |
| [v29-transition-scoring-deep-dive.md](./v29-transition-scoring-deep-dive.md) | V29 transition scoring 深入 |
| [nn-bridge-integration.md](./nn-bridge-integration.md) | 外部闭源 NN 基线（clean_genius_AI PPO checkpoint）接入交接：资产/架构/用法/实测/限制 |
| [oracle-free-harness-metrics.md](./oracle-free-harness-metrics.md) | oracle-free harness（plan-oneshot engine-only 臂）错误模式检测/兜底/计数口径与产物 schema：trace 汇总、batch summary、反思证据锚点、harness 行为计数、patch 静态回放断言、消融判据、已知计数偏差 |

## 📋 计划与规格（plans/）

| 文档 | 主题 |
|------|------|
| [plans/cloud-server-spec.md](./plans/cloud-server-spec.md) | 云端训练服务器规格 |
| [plans/2026-03-16-llm-deck-analyzer-v2-feature-spec.md](./plans/2026-03-16-llm-deck-analyzer-v2-feature-spec.md) | LLM deck analyzer v2 功能规格 |
| [plans/2026-04-08-hidden-constraints-analysis.md](./plans/2026-04-08-hidden-constraints-analysis.md) | 隐藏约束分析 |
| [plans/2026-04-24-skill-to-execution-gap.md](./plans/2026-04-24-skill-to-execution-gap.md) | 技能-执行 gap 分析 |
| [plans/2026-08-21-one-shot-gameplan-benchmark.md](./plans/2026-08-21-one-shot-gameplan-benchmark.md) | One-shot 决策树长程规划 benchmark：GamePlanV1 / PlanPlayerIO / plan_trace / oracle 回算 / 反思管线组件设计 |
| [plans/2026-08-23-plan-oneshot-audit-fixes.md](./plans/2026-08-23-plan-oneshot-audit-fixes.md) | plan-oneshot 审计修复 |
| [plans/2026-08-28-agentic-plan-harness.md](./plans/2026-08-28-agentic-plan-harness.md) | agentic 起草/反思循环 harness：协议、模块预算、harness 行为统计 |
| [plans/2026-08-29-why-llm-plan-weaker-than-nn.md](./plans/2026-08-29-why-llm-plan-weaker-than-nn.md) | LLM 决策树 vs NN 主实验日志：根因分析、A-D 分级改进、GLM/qwen 迭代全记录、失误构成、运行坑（§9）、轨线作图工具指针、威胁语汇专项（§10：opp.threat.* 字段落地 + 采用率验证四轮 + roundT3/T5/T6 雷鹤臂兑现、误报校准与 lethalP 判别力检验）、水债线体系认知与 combo 落地检验（§11：roundT7 召唤引擎死映射确诊与点火、9:1）、harness 基建治理（§12：fallback_report 覆盖率护栏双臂默认注入、plan:validate known_deck 解码修复、tsc 416→0 清零与 console 全局泄漏根因） |
| [plans/2026-08-30-oracle-free-selfevolution-arm.md](./plans/2026-08-30-oracle-free-selfevolution-arm.md) | 无 oracle 自进化臂（engine-only evidence）实施方案：泄漏通道切断、剩余信号清单、交叉卡组对手补偿（含验证子实验）、护栏与三臂对照设计（待实施） |
| [plans/2026-09-03-verifier-selected-selection-loop.md](./plans/2026-09-03-verifier-selected-selection-loop.md) | 验证器选择监督与候选选择器回路（arXiv 2608.18324 迁移设计）：治理记录同构映射、候选池 + 机械选择器缺口、harvest/holdout 分区、配对统计与 headroom 预检、出处标注（待评审） |
| [plans/2026-09-03-cross-model-rating-tournament.md](./plans/2026-09-03-cross-model-rating-tournament.md) | 跨模型卡组锦标赛与排位分体系：Glicko-2 排位榜、跨代轨迹、克制热图与 spinning-top 诊断（设计定稿，待实现） |
| [plans/2026-09-03-llm-evidence-organizer-eval.md](./plans/2026-09-03-llm-evidence-organizer-eval.md) | LLM 证据整理式执行评估（organizer）：提及/实践/错位三任务的信息启用清单、基准取舍（禁人工标注 / 禁 MCTS / 禁 NN）、补采与落盘改动清单、organizer 输出协议（设计定稿，待实现） |
| [plans/2026-09-03-integrated-roadmap-selection-organizer.md](./plans/2026-09-03-integrated-roadmap-selection-organizer.md) | 整合路线图：验证器选择回路（闭环内补"选"，待评审）× organizer 执行评估（闭环外补"看"，定稿）——五处重叠改动合并、跨案边界纪律、统一四期实施顺序（设计整合稿；2026-09-05 起 Phase 2 挂起） |
| [plans/2026-09-05-tournament-execution-plan.md](./plans/2026-09-05-tournament-execution-plan.md) | 四模型小型锦标赛执行方案：5 版本环境×各 8 热门卡组（summoners-decks 源、版本钉扎）、每格 15 局、R9 own-generations 证据（含跨模型）、跑到饱和定论文 R、赛程锚点不做、round19 式 --anchor 起草复验、organizer 试点（deepseek-v4-flash-vision-exp）、A 案挂起——基建→冒烟→正赛→锚点→organizer 五阶段执行计划（2026-09-05 拍板，实现规格见 impl-spec-0..5） |
| [plans/2026-09-05-impl-spec-0-overview.md](./plans/2026-09-05-impl-spec-0-overview.md) | 实现规格总览：五工作包（WP1 锦标赛管线 / WP2 写入端 / WP3 分析绘图 / WP4 organizer / WP5 锚点复验）依赖图、共享约定（pnpm+gnx、env 注入、fail-fast 纪律）、已核实代码锚点索引 |
| [plans/2026-09-05-impl-spec-1-tournament.md](./plans/2026-09-05-impl-spec-1-tournament.md) | WP1 锦标赛管线：tournament.json 契约与校验（含 `traceSignatures` 签名模式）、model-tournament.ts 八子命令（author/evolve/battle/pipeline/export/analyze/status + archive 冷代次压缩归档：pair 级 tarball、链批默认保留、上游 evolve 闸、tarball 校验后才删、恢复 = tar -xzf；**2026-09-05 追加 pipeline「生成即赛」§4.7**：LLM producer 与 battle 调度器并发（`tournament-scheduler.ts` 注入式核心 + 单测），manifest 组装内联到每 di 调用全齐即触发，drain 后仍 not-ready 的批记「依赖未就绪」失败、r≥1 前置校验上一代 battle 全 done）、own-generations 证据适配器（视角翻转规则、三级 link fallback）、目录布局与幂等续跑、冒烟十项验收（**已实现**：Mock-LLM 全管线冒烟十项全过，验收记录 [../smoke/ACCEPTANCE.md](../smoke/ACCEPTANCE.md)；**2026-09-05 追加：lean trace 签名指针化 + evidence 硬链接兜底已实现**） |
| [plans/2026-09-05-impl-spec-2-write-side.md](./plans/2026-09-05-impl-spec-2-write-side.md) | WP2 写入端补采：mutation 流接线（确定性红线：同 seed trace 逐字段一致）、replay-report 落盘、HarnessStats issue 直方图+被拒留档、P3-1 跨代聚合脚本（**已实现**：scripts/ops/aggregate-generations.ts） |
| [plans/2026-09-05-impl-spec-3-analysis-plots.md](./plans/2026-09-05-impl-spec-3-analysis-plots.md) | WP3 分析绘图：ratings-history 逐 period 导出、coverage 统计与无对局格元数据、spin-top 稠密子块过滤、matplotlib 五图（trajectory/improvement/heatmap×2/spintop，uv + matplotlib≥3.8）（**已实现**） |
| [plans/2026-09-05-impl-spec-4-organizer.md](./plans/2026-09-05-impl-spec-4-organizer.md) | WP4 organizer：证据导出器 plan:organize-export（放宽口径五件产物）、三任务编排（注入式双 env ORGANIZER_*）、报告 schema 与条目级校验、单 run 试点人工校准（件 1-3 代码已落地 2026-09-05：plan:organize-export + scripts/ops/organize-run.ts + scripts/ops/organizer-report.schema.json；件 4 试点待真实对局数据） |
| [plans/2026-09-05-impl-spec-5-anchor-experiment.md](./plans/2026-09-05-impl-spec-5-anchor-experiment.md) | WP5 锚点复验：round19 同型双臂（ctrl 直起草 vs --anchor 两阶段）+ 三对抗矩阵（ctrl/anchor 基线 + 臂对臂）、coverage/fallback/战绩读数、结论回写规则（**已实现**：scripts/ops/anchor-experiment.ts；实验运行待 API 凭据） |
| [plans/2026-09-09-candidates-single-session-ab.md](./plans/2026-09-09-candidates-single-session-ab.md) | 候选制单对话流程改造与 A/B 复测：单对话分轮起草 + must-differ 机检 + skill_def_id 精确技能区分；聚合 35.8%→48.75%（2 胜 2 负 2 平），结论软化不翻转；预留问题「候选-挑选流程是否额外获取判断力」；锚点首轮合规指标（attempts/firstAttemptIssues）落地 |
| [plans/2026-09-09-tournament-per-provider-llm-concurrency.md](./plans/2026-09-09-tournament-per-provider-llm-concurrency.md) | 锦标赛 LLM 并发按供应商分桶（**已实现，2026-09-09**）：全局池队头阻塞与限速不可表达两缺陷、`TournamentModel.concurrency` 可选字段 + 分桶池方案、Mock-LLM 冒烟不回归验收 |
| [plans/2026-09-09-tournament-remaining-tests.md](./plans/2026-09-09-tournament-remaining-tests.md) | 锦标赛剩余测试项交接（新对话执行，范围 = deepseek/qwen，hy3 弃测、赛程变体不测）：archive 真跑+恢复演练 / organizer 真实数据试点 / full trace 注入验证；附机制级待修发现四条（digest 自锁、回放断言空转、revise 错靶、reason 漂移）与环境须知 |

## 🔴 已归档（archive/）

26 篇 V5–V25 时期文档，已被后续版本部分或完全取代。仍可参考分析思路，不反映当前代码状态。

主要归档原因：
- V5–V15 期 ai-improvement-plan / ai-decision-framework / iterative-training-guide：训练流程已演化到 V25–V28
- temporal-opportunity / temporal-reasoning：tempo 概念已被 V26+ transition state 取代
- expert-system-feasibility：方案 C 已被 V26 transition-based 替代
- v25-* / v19-* / 早期 v5/v14 报告：被新版本完全取代

详见 [archive/README.md](./archive/README.md)（如存在）。

## 🛠 引擎开发文档

引擎层文档（state、process、io、log、query DSL、card data definitions）在仓库根目录 [docs/development/](../../../docs/development/) 中维护，本包不再保留副本。

## 推荐阅读路径

| 目的 | 顺序 |
|------|------|
| 项目当前状态 | README → v28-gi-agent-ml-review |
| 架构演进脉络 | v26-ai-architecture → v27-transition-constraints → v28-answers → v29-transition-scoring |
| 局部窗口树流水线 | combat-window-pipeline |
| 训练入口 | README → v28-prompt-for-qwen |
| plan-oneshot / oracle-free 管线口径 | plans/2026-08-30-oracle-free-selfevolution-arm → oracle-free-harness-metrics |
| 引擎开发 | 仓库根 docs/development/ |

## 目录结构

```
docs/
├── INDEX.md            ← 你在这里
├── README.md
├── combat-window-pipeline.md
├── standalone-mcp-windows-startup.md
├── v26-*.md  v27-*.md  v28-*.md  v29-*.md
├── nn-bridge-integration.md  oracle-free-harness-metrics.md
├── archive/            ← 26 篇老版本与已被取代文档
├── plans/              ← 计划与规格
└── images/
```
