# `@gi-tcg/agent` AGENTS.md

`gi-agent` 是七圣召唤模拟器的**对战 AI 实验工作区**：负责运行时决策、搜索、benchmark、self-play 数据采集，以及局部窗口树挖掘。

## 不做什么

- 规则正确性：交给 `@gi-tcg/core`
- 卡牌定义：交给 `@gi-tcg/data`
- 概念发现 / 概念库 / ranker / value artifact 训练：交给 `@gi-tcg/ml`
- 引擎层文档（state / process / io / query DSL）：仓库根 `docs/development/`

## 包结构契约

```
src/
├── agents/              # battle-agent (LLM CLI), scoring-auditor
├── automation/cli/      # iterate
├── analysis/            # deck-analytics 分析器
├── db/                  # data-lake (单一来源)
├── evaluation/
│   ├── benchmark/cli/   # benchmark 运行与对比报告
│   ├── branch-eval/cli/ # 分支评估
│   ├── plan-eval/cli/   # one-shot 计划 oracle 回算（plan:eval）
│   └── requirements-tests/
├── graphs/              # battle-graph (LangGraph 实验)
├── knowledge/           # character-profiles / deck-priors / temporal-profiles
├── learning/
│   ├── al/              # 主动学习采样器（diversity / uncertainty）
│   ├── combat-windows/cli/  # 局部窗口树流水线
│   ├── features/        # action / deck-prior 特征
│   ├── mulligan/        # mulligan 先验
│   ├── rl/cli/          # RL 数据集导出与 self-play smoke
│   ├── scoring/         # logistic regression evaluator (原 src/ml/)
│   ├── self-play/cli/   # self-play 采集
│   └── training/        # train-evaluator (将 data-lake → calibrated weights)
├── mcts/                # MCTS 引擎层（GBRL 树、value features 等）
├── runtime/
│   ├── adapters/        # SimAdapter 等
│   ├── eval-baselines/  # state/heuristic/feasibility/delta 评估
│   ├── io/              # PolicyPlayerIO（policy ↔ core PlayerIO）
│   ├── plan/cli/        # spl:compile (gameplan compiler)
│   ├── plan-oneshot/    # one-shot 决策树（GamePlanV1 / PlanPlayerIO / plan_trace）+ agentic harness（cli/agent-loop 有界循环、cli/modules 模块注册表、prompts/harness-protocol-*）+ patch 修订协议（plan-patch ops 合并 / plan-replay 静态回放与反事实断言 / fields-lint 链级 lint + 第 4 类卡面数值校核：骰子闸 vs 费用、HP 阈值 vs 上限、damage_min vs 基础伤害；技能归属从 when 的 `self.active.defId` 推导（数字 target 是对手侧目标），技能按同类型全变体最宽松匹配（任一变体被闸满足 / 满足 damage_min 即不报，dynamic 变体跳过），费用/HP/伤害真值唯一来源 = card-face-table 的 @gi-tcg/data 源码静态扫描（纯本地、零网络、零资产接口））+ 卡面事实表（card-face-table.ts 静态扫描 @gi-tcg/data builder-DSL：费用/HP/基础伤害/版本变体）+ 锚点断言机检（cli/author-anchor-check.ts：killMath/comboLines 数值断言 × 牌表存在性 × 卡面事实表，issue 回注 author 重试、结果落 `<out>.anchor-assertions.json` 旁档）+ r0 多候选与换轴（plan-graft.ts 的 alternates 旁档 schema + 单元级嫁接 `checkGraftUnits`/`applyRouteGraft`：opening/fallback/rules/phase:<id>，单次与 run 累计各 ≤2）+ 语汇扩充（threat.ts 的 opp.threat.* 对手威胁上界字段 / dice-prior.ts 骰子分布先验 + dice_prior 模块）+ 两层组合（portfolio.ts 的 PlanPortfolioV1 manifest 装载/G8 校验/routeSingle 路由 + rule-key.ts 的层前缀归因键（含 opening:0） + rule-chain.ts 的 D1=A 层主序组合链，D1=A Single 前置、D2 fallback/opening 归属 Single）；prompt 文案（prompts/*.md + 代码注入段/回注 issue）统一英文，console 日志保持中文
│   ├── policy/          # 33 个 runtime policy（baseline/evaluator/mcts/temporal/...）
│   └── search/          # BoundedSearcher
└── sandbox/             # SandboxRunner / replay log 压缩
```

## CLI 入口（package.json scripts）

| script | 说明 |
|---|---|
| `pnpm run benchmark <cfg>` | 跑 benchmark 套件（核心入口） |
| `pnpm run branch-eval <cfg>` | 分支评估 |
| `pnpm run self-play <cfg>` / `self-play:topup` | self-play 采集 |
| `pnpm run iterate <cfg>` | 自动迭代：训练 evaluator → 对比 → 报告 |
| `pnpm run rl:export-dataset` / `rl:smoke` / `rl:sample` | RL 数据集导出与 smoke |
| `pnpm run combat-window:{extract,analyze,validate,align-replay,import-branch-eval,export-library,query-library,evaluate-library,evaluate-workload,export-concepts,export-combo-concepts}` | 局部窗口树流水线 |
| `pnpm run battle <args>` | LLM 对战 CLI（实验闭环） |
| `pnpm run scoring:audit` | 扫描 scoring magic numbers |
| `pnpm run generate:temporal-profiles` | 重生成 temporal profiles |
| `pnpm run spl:compile` | 编译 strategy plan |
| `pnpm run plan:validate <plan.json>` | 校验 GamePlanV1 计划文件 |
| `pnpm run plan:author --deck <code> ... --out <path>` | LLM one-shot 起草决策树（读 .env 的 OPENAI_*；user prompt 注入双方牌表详情：技能（行首 `#<skill defId>`，写 then.skill_def_id 指名同类型多战技角色）/效果/费用，卡牌标签渲染为 core 实体短名（weapon/food/...，与 `hand.countWithTag` 运行时比较值同源；card_detail 模块同口径）；`--anchor` 启用两阶段模式：先产出策略锚点 JSON 落 `<out>.anchor.json`（锚点 killMath/comboLines 数值断言机检 `cli/author-anchor-check.ts`：牌表存在性 / costAssertion vs 技能费用 / damage vs 基础伤害+2 / skillType 取 normal_attack|elemental_skill|burst（兼容旧 normal|elemental）；费用与伤害按**同类型全变体**匹配（如纳西妲两个元素战技 17032 3草 / 17033 5草，任一变体一致即通过），dynamic 伤害、以及超余量但带非空 reactionPrereq 的加成总伤均降级 unchecked 不拦截，问题回注 LLM 重试（机检失败**不做类型转换兜底**，如 killMath.damage 非数值即 issue）；通过后落 `<out>.anchor-assertions.json` 旁档（含首轮合规账 `attempts` = 锚点阶段总尝试次数、首轮即过为 1，`firstAttemptIssues` = 首轮失败 issue 列表 `{path,category,message}`，category 由 path+message 机械归类为 missing-number｜cost-mismatch｜damage-over-allowance｜not-in-deck｜other；两字段为增量可选键，旧旁档无之、聚合侧按 n/a），plan:batch 随主计划归档、reflect 按计划版本重算并注入 `# Anchor assertion checks` 段），再携带锚点起草）；`--candidates N`（2..4，r0 多候选起草，v1 仅 `--turns 1`、与 `--anchor` 兼容即候选共享同一锚点）：同输入在**同一对话**内分 N 轮顺序起草（第 k 轮可见前 k-1 个候选的完整 JSON 并要求显式拉开路线距离；重复候选按可修复失败回注重出，计入 repair 预算；seed 仍按 `seed + k*100 + a`；任一候选失败 → 整轮失败不落产物，评审仍在全部候选完成后进行），每次产出 `{"archetype":自标注路线标签,"plan":GamePlanV1}`（各自 `--repair` 预算，seed 按候选错开）；随后同模型 +1 次即时评审（`prompts/candidates-review.md`）凭锚点层论证择一写 `<out>`，全部候选落 `<out>.alternates.json`（`PlanAlternatesV1`：index/archetype/reviewNote/adoptedUnits/plan，含被选中者）、评审原文落 `<out>.candidate-review.json`（`CandidateReviewV1`），plan:batch 随主计划归档供 reflect 换轴；与 `--turns>1` 互斥（harness 组合为扩展点）；`--opponent-set <file>`（General 起草，G2）：注入全部对手牌表详情 + 稳健性纪律，context.opponent 强制 unknown_deck，与 `--opponent-deck/--mirror/--unknown` 互斥、与 `--anchor` 互斥（解析在 `cli/author-opponent-set.ts`）；`--turns N>1` 启用 agentic harness（有界 agent 循环：request_modules 按需索取模块 / draft 校验 / final 定稿，模块预算 `--module-budget`/`--per-turn-modules`，效率统计落 `<out>.harness.json`（含 `reasoningOnly{total,salvaged,failed}` 质量探针），逐轮原文落 `.transcript.jsonl`；默认 `--turns 1` = one-shot 对照臂）；`--game-version <v>`（V1 版本钉扎）：prompt 卡面文本按该版本（versioned AssetsManager，VERSIONS 封闭校验），agentic harness 的 card_detail/character_detail 模块同源取数，产物写 `context.gameVersion`（进 planId），校验用该版本数据做存在性检查；缺省 latest 且不写（旧产物形态）；`--no-thinking` 关闭推理通道（默认开，thinking 模型常把答案留在思考链，agent-loop 会从思考链抢救 JSON） |
| `pnpm run plan:reflect --run-dir <dir>[,<dir2>...] --side <0|1> --out <path>` | 赛后反思生成修订计划；`--evidence engine-only`（默认 `oracle`）= 无 oracle 自进化臂：启动断言 run 目录无 plan_eval 产物、eval 读取全门控、oracle-free prompt、thenMiss/威胁/零命中告警锚点，prompt 落 `<out>.prompt.txt` 供机检；多 `--run-dir` = 交叉对手证据包（同 planId 断言，按目录 basename 分组统计）；`--turns N>1` 启用 agentic harness（可钻取 decision_detail/rule_drilldown/fallback_detail/game_summary/plan_simulate 原始数据模块，sidecar 同 author）；`--patch` 追加受限补丁协议（LLM 提交 ops 由服务端合并进当前决策树，未触及规则默认 keep；ruleRef 合法集合 = global/phase/opening（`opening:0`）；每次合并回注静态回放核验 diff + 逐 op 断言；裸 final 以累计 patch 为产出；`--max-patch-ops` 调单条 op 上限，默认 8。授权边界：ops 仅作用于本侧当前决策树、语料只读本侧 trace/eval 文件；全量 draft/final 覆盖累计 patch 需在 result 带 `overwritePatches: true` 显式确认）；portfolio 模式（G5，Phase 3b）：`--portfolio <manifest> --round <N>` 装载 PlanPortfolioV1 并以 workingPortfolio 反思——`--out` 解释为目录（产物 `plans/general.r<N>.json` + `plans/single.<label>.r<N>.json` + 更新 `portfolio.json`，sidecar 落目录根部），逐组读 `portfolio.side0.json` 做 portfolioId 组间断言、按 D6 k=2 层路由标注（`cli/reflect-portfolio.ts`），patch 层协议带层前缀）；`--force`（V1 版本钉扎）：证据 run 目录版本断言（summary.gameVersion vs 计划版本，旧产物未标注 → warning）失败时降级 warning，反思/回放数据按计划版本取数；卡面校核（2026-09-08）：首轮 user 消息注入 `# Card-face checks` 段（fields-lint 第 4 类——骰子闸 vs 费用、HP 阈值 vs 上限、damage_min vs 基础伤害，真值全部来自 @gi-tcg/data 源码事实表 card-face-table（纯本地静态扫描、零网络）；useSkill 技能归属取自 when 的 `self.active.defId`，同类型多战技按全变体最宽松匹配，then 带 `skill_def_id` 时改用精确变体并做存在性校核（需 ctx.deck）；纯机械、不占模块预算，one-shot 与 harness 同注入、落 `<out>.prompt.txt`），draft/patch/final lint 同口径；锚点断言校核（同日）：run 目录有 `plan.side<N>.anchor-assertions.json` 时按计划版本重算并注入 `# Anchor assertion checks` 段（逐条 author 时状态 × 重算状态 + 未校核清单；无旁档且 `plan.sampling.anchor === true` → 一行「无锚点断言旁档」，否则不注入；portfolio 模式跳过——锚点树为单树产物）；替代路线参考 + 换轴（2026-09-08）：run 目录有 `plan.side<N>.alternates.json` 时首轮注入 `# Alternative routes` 段（候选 index/archetype/评审短评/adoptedUnits + 形状摘要，不注入整棵树；portfolio 模式跳过）；`--patch` harness 可用受限命令 `switch_route` 做单元级嫁接（opening/fallback/rules/phase:<phaseId>，单次 ≤2、本 run 累计 ≤2、不得选已落地候选 chosenIndex；`plan-graft.ts` 纯函数守卫+嫁接），嫁接后过 validate + lint + 静态回放（基准 = 嫁接前工作树）并合成 ruleVerdicts（ruleRef=链锚点，ablate 开臂为扩展点），审计记录落 `<out>.reflection.json` 的 routeSwitches |
| `pnpm run plan:organize-export --run-dir <dir> --out <evidencePack目录> [--games all\|N\|outliers] [--max-lines 2000] [--max-chars 200000]` | organizer 证据导出器（WP4，核心在 `cli/organize-export.ts`）：读 plan:batch run 目录出 evidencePack 五件——fullDigest.txt（放宽口径逐局决策证据，含 opening 类决策点 chooseActive/switchHands/rerollDice；上限独立参数化、单局不截断、超限整局省略）、stateSignatures.jsonl（每决策点整条签名）、draw-sequence.md（initialPile/pile 差分重建抽牌序列）、outliers.json（perGame 离群 + run 级机械聚合）、side1/（对手侧 trace+summary 包）；另附 plan.side0.json + manifest.json。复用 modules.ts game_summary/decision_detail 文本化器（`opts.maxModuleChars` 放宽 + `sigRedact` 签名脱敏，reflect 路径不变）；`evidence=engine-only` 门控 = 证据不碰 oracle。只读 --run-dir 只写 --out |
| `pnpm run plan:ablate --base <r0> --revised <r1> --reflection <f> --baseline-run <dir> --side <0|1> --opponent-plan <p> --out <dir>` | 消融臂：单变量验证反思的 falsifiableClaim；`--evidence engine-only` 换引擎侧判据（不读 eval 文件：thenMiss 归零 / 同种子反事实判据（数值修订 damage_min/kills/骰子闸/HP 闸，配对命中数提取在 `cli/ablate-numeric.ts`）/ coverage/fallback 闸 `--coverage-tol` / 胜率区间 N≥20，判据纯函数在 `cli/ablate-criteria.ts`）；portfolio 模式（G7）：`--portfolio-base <manifest> --portfolio-revised <manifest|目录> --evidence-runs <run1,run2,...>` 对组合树做层化臂（general 臂全组批跑 / single 臂仅路由命中组，臂构造与组选择纯函数在 `cli/ablate-portfolio.ts`），report 带组维度）；`--force`（V1 版本钉扎）：基线/证据组 run 目录版本断言与 base/revised manifest 共同版本一致性检查失败时降级 warning，臂批跑数据按被修订计划版本 |
| `pnpm run plan:batch <cfg>` | one-shot 计划批量对局（plan_trace + state log 落盘，支持 concurrency）；config 支持 `portfolio` 键（两层组合模式，G3/G9：与 `planFile` 互斥，装载 PlanPortfolioV1 manifest 并按 opponentDeckCode 路由——命中 single → 组合链，否则 General-only；run 目录归档 `portfolio.side0.json` 含 manifest/portfolioId/routing；`planFile` 存在 `<planFile>.anchor-assertions.json` / `<planFile>.alternates.json` 旁档时另原样归档 `plan.side0.anchor-assertions.json` / `plan.side0.alternates.json`）；`opponent: {"type":"nn"}` = 外部 NN 强基线（强制 v6.3.0 数据），`gameVersion` 可钉版本（V0 解析序 config ?? plan.context.gameVersion ?? CURRENT_VERSION，错配 fail-fast、`--force`/config `force:true` 放行降级 warning、nn 锁 v6.3.0；开局 versionBehavior 与 state log gv / trace / summary 三处版本同源） |
| `pnpm run plan:eval <dir>` | one-shot 计划 oracle 回算（默认 ISMCTS 归因；`--oracle nn` 用外部 NN，tau 为 logprob 分差阈值，默认开启胜率差分（valueBefore/After/Delta，`--no-value-diff` 关闭、`--value-tau` 调崩落阈值），产物 `plan_eval.nn.json` 与 ISMCTS 口径并存） |

每个 CLI 源文件位于对应模块的 `cli/` 子目录下，可一一对应。

## 依赖方向

```
@gi-tcg/core  →  @gi-tcg/data  →  @gi-tcg/agent
                                       ↑
@gi-tcg/ml  → → → → → → → → → → → → → →┘
                                       ↑
@gi-tcg/llm-deck-analyzer  → → → → → → ┘
@gi-tcg/mcp                            ↑
```

`@gi-tcg/agent` 是这条链的下游。**不允许**反向依赖。

## 公共 API（src/index.ts）

包导出主要分组：
- Phase 0: Scoring（FeatureExtractor / LogisticCalibrator / ScoringAuditor）
- Phase 1: Battle（buildBattleGraph）
- Phase 2: Data（DataLake / ReplayExtractor）
- Phase 3: Sandbox（SandboxRunner / 各 Benchmark 类型）
- Runtime Search（SimAdapter / BoundedSearcher / PolicyPlayerIO / 各 Policy）
- Knowledge / Priors（character profiles / deck affinities）
- Learning Wrappers（带 `Learning` / `Action` 前缀的 alias）

部分 alias（`ActionFeatureExtractor`、`LearningDataLake`、`LearningLogisticCalibrator`）保留是为兼容旧消费者，本质指向同一实现。

## 例子配置

`examples/configs/` 目录有 11 个示例：`benchmark.{example,quick,mid,prior.example,prior.batch.example}.json`、`self-play.{example,quick,mid,test-smoke}.json`、`iteration.example.json`、`decks.template.json`。详见 [examples/BENCHMARK_GUIDE.md](./examples/BENCHMARK_GUIDE.md) 与 [examples/TEMPLATES.md](./examples/TEMPLATES.md)。

## scripts/

`scripts/` 一次性辅助脚本（generators / analysis / selfplay / ops），见 [scripts/README.md](./scripts/README.md)。**不在 package.json 中**，调用形式为 `pnpm exec gnx scripts/<name>.ts` 或 `python3 scripts/<name>.py`。

## 包内文档

索引见 [docs/INDEX.md](./docs/INDEX.md)。与 plan-oneshot 管线强相关的现行口径文档：[docs/oracle-free-harness-metrics.md](./docs/oracle-free-harness-metrics.md) —— oracle-free harness（engine-only 臂）错误模式检测/兜底/计数的完整口径与产物 schema（trace/summary/harness sidecar/消融判据），改动计数口径或产物字段时须同步更新。

## 测试约定

- colocated `*.test.ts`（与源文件同目录）
- `pnpm test` 或 `pnpm exec vitest run` 运行
- 不再使用 `__tests__/` 子目录

## 历史包袱（已知）

- `src/runtime/policy/` 33 文件、`src/learning/combat-windows/` 32 文件 —— 需按子职责进一步拆分
- `src/mcts/mcts-policy.ts` 与 `src/runtime/policy/mcts-policy.ts` 同名但职责不同（前者 engine adapter，后者 runtime wrapper）
- `card-effect-hints.generated.ts` 是脚本生成的，不要手改
- ~~416 个预存 tsc 类型错误~~（2026-09-04 已清零：根因大头是 core 的 `declare global var console: Console | undefined` 经 dist d.ts 泄漏进本包编译——core 侧改为 `src/console.ts` 的 `optionalConsole` 模块级读取并重建 core/assets-manager/custom-data-loader 的 dist 后消除 312 个；其余为散点类型修复。此后 `pnpm check` 应保持 0 错误，改动文件不得新增）
