# 已知缺口记录：reflect 证据通道 + 锦标赛赛程维度

> 日期：2026-09-07（2026-09-08 追加赛程缺口一节；2026-09-08 再追：候选功能决定稿 +
> 卡面校核数据源更正）。来源：锚点实验（`output/anchor-exp-v40/`）+
> 单树迭代 r1 分析（`output/anchor-exp-v40/iterate/r1-changes.md`）+ 锦标赛组件核对。
> 性质：待修复缺口记录，供后续实现参考。

## 问题

`plan:reflect --evidence engine-only` 的机械证据（thenMiss / kills 死规则 / fallback 计数 /
decision_detail / rule_drilldown / plan_simulate 回放矩阵）**结构性无法暴露**两类错误：

1. **锚点层（anchor sidecar）的斩杀数学错误**：killMath 里的费用/伤害/反应加成算错
   （例：雷神 Q 写成 4 雷实为 3 雷；不存在的「奥兹普攻追击 2 雷」——牌表无噬星魔鸦）。
   这些数值只出现在锚点文本与决策树规则的备注/条件里，不产生任何引擎侧机械信号。
2. **卡面事实性错误**：规则引用的费用、持续时间、目标方向与版本化卡牌数据不符
   （例：储之千日预算按 4 岩实为 3 岩；申鹤箓灵方向写反；诺艾尔 HP10 实为 12）。

**实证（r1 迭代对照）**：锚点审查（`output/anchor-exp-v40/run/anchor-review.md`）编目的
13 条 A 类高置信错误，经一轮 reflect 后仅 4 处（单元级）被修——且全部是「kills 死规则
删除」的副产品，**无一条是 LLM 主动纠正数值**；reflection 的 falsifiableClaim 无一涉及
费用/伤害口径。明确的数值错误（雷神 4 雷、储之千日 4 岩、诺艾尔 HP10）在 r1 原样保留。

## 现状盘点（为什么「有模块也没用」）

`cli/modules.ts` 注册表里 **卡面真值通道已存在**：`card_detail` / `character_detail`
属 SHARED_KINDS，author 与 reflect 模式都可按需索取（还有 field_reference /
character_profile / dice_prior）。但它是**拉取式**的：模型必须自己意识到「这条规则的
费用可能不对」才会去查。机械证据（thenMiss/kills）从不指向数值错误 → 模型的注意力
全部被导流到死规则/兜底/求值顺序上 → 卡面校核从未发生。

即：缺的不是数据源，是**把「这棵树涉及哪些卡面断言、哪些与版本化数据不符」主动推到
反思上下文的机制**。

## 修复方向（按实现成本排序）

1. **静态卡面校核器（推荐，纯机械、零 LLM）**：扫决策树规则文本/条件中的费用断言
   （`dice.<e>+omni>=N`）、伤害数值、回合数、HP 门控，对照版本化数据出差异清单；
   作为 reflect 的自动注入证据（不占模块预算），且作为 `fields-lint` 的扩展 lint 类。
   覆盖 #1/#7/#9/#13 这类纯数值错误。
   **数据源分层（2026-09-08 更正）**：费用/HP 用 versioned AssetsManager 的结构化
   `playCost`/`hp`（V1 钉扎已在 author/reflect/batch 三处落地）；**伤害数值的结构化真值
   在 `@gi-tcg/data` 角色/卡牌定义源文件**（builder DSL 字面量，如
   `packages/data/src/characters/electro/raiden_shogun.ts` 的 `.costElectro(3)` /
   `.damage(DamageType.Electro, 3)` / `.health(10)`）——静态扫描源文件建事实表，按
   `.since` 过滤版本并与 AssetsManager 双源交叉验证；反应加成数值在
   `packages/core/src/builder/reaction.ts` 同样结构化，可校「基础伤害+反应加成=期望
   斩杀线」算术（v1 先做费用/HP/存在性/基础伤害，反应算术留扩展点）。动态/条件伤害
   （`.do()` 闭包、条件 `increaseDamage`）不可静态取值，标 dynamic 只校基础伤害；效果
   语义类错误（如箓灵方向）仍归 LLM 侧（方向 2/3）。另注意 `cli/modules.ts` 的
   `card_detail`/`character_detail` 目前固定取 DEFAULT_ASSETS_MANAGER（latest），不吃
   `--game-version`，需同步版本化，否则 V1 钉扎的 reflect 会被注入 latest 卡面。
2. **锚点断言结构化回注**：author 两阶段的 anchor.json 的 killMath/comboLines 改写成
   可机检的断言列表（卡牌 ID + 费用 + 期望伤害 + 反应前提），author 侧机检（牌表存在性 /
   费用 / 基础伤害）后落 `<out>.anchor-assertions.json` sidecar（2026-09-08 更正：不写
   plan 顶层字段——planId 哈希含额外键且 patch 封闭键集不可写），batch 归档时随
   plan.side0 拷入 run 目录；reflect 时按计划版本机械重算并注入「锚点断言 × 卡面真值」
   对照（「对局实测」腿 v1 降级为扩展点——kills 规则位的 perRuleHits 已隐含击杀计数，
   伤害实测待 state log mutation 归因）。
   覆盖 #18（噬星魔鸦前提缺失）、#2/#3（幻影伤害）这类「前提不成立」错误。
3. **reflect prompt 定向**：falsifiableClaim 的指引里加「数值校核」类别；或在 patch
   命中某卡牌时自动附 `card_detail`（推式补充，预算独立于 request_modules）。
4. **ablate 判据扩展**：现状回放断言只证「改了不后退」（r1 全 493 条 no-target 只覆盖
   胜出规则位）；对数值类修订需要「同种子反事实重放」才能判定改对——可在
   `ablate-criteria.ts` 加按种子重放对照。

以上错误模式纠正时计数，最后作为评估LLM的指标。

## 候选功能（待评定）：r0 多候选起草 + 选择

**想法**：首轮 author 不起草单棵树，而是让模型**按不同类型/路线产出 3 个候选**
（如 控制 / 中速 / 节奏 / 组合技 各一），再择一落地。预期收益有二：

1. **降低单次思考负担**：每个候选只需沿一条路线想透，不必在一次生成里自折自冲
   （qwen3.8-flash ctrl 臂曾单单元 86 个 format 问题、glm 系更是 reasoning 烧穿——
   短而专的候选生成可能比一次成型更稳）；
2. **对冲路线锁定**：锚点审查显示同一卡组的路线分歧真实存在且影响战绩
   （d0 斩杀轴三分、d5 首发二分、d6 控制 vs 组合技二分），而 patch 协议结构性冻结
   opening、r1 零换轴——**路线一旦选错，迭代无法自救**。候选机制把路线决策从
   「一次抽样的运气」变成「显式选择」。

**待评定的设计分歧点**：

| 分歧 | 选项 A | 选项 B |
|---|---|---|
| 候选分化的提示方式 | prompt 指定 archetype 标签（控制/中速/节奏各一） | 自由生成 N 个，再要求自标注 archetype |
| 选择时机 | **即时选择**：同模型加一轮「评审」调用，凭锚点层论证择一 | **首轮对战后选择**：3 候选各自 batch 一轮（镜像/对臂），用 engine-only 证据择一——证据驱动而非口才驱动 |
| 选择粒度 | 整树三选一 | 分层选择（opening 用 A、斩杀轴用 B），组合进一棵树 |
| 落选候选的去留 | 丢弃 | 保留为 reflect 的「替代路线参考」证据（反思时可建议换轴，弥补 patch 协议冻结 opening 的缺口） |

**决定稿（2026-09-08）**：提示方式 = B（自由生成 + 自标注 archetype，N 钉死为 3）；
选择时机 = A（同模型即时评审，凭锚点层论证择一——模型自主选择，对战制否决）；
选择粒度 = A（r0 初选题整树三选一）；落选候选 = B（保留为 reflect 替代路线参考，
落 `<out>.alternates.json` sidecar，不写 plan 顶层字段——避免改 planId 且 patch 封闭
键集不可写）。**换轴协议**：reflect 换轴允许**单元级嫁接**，粒度 = GamePlanV1 结构
单元（`opening` 整体 / `phase:<phaseId>` 整链 / `rules` 整链 / `fallback`），**不按
opening vs 斩杀轴的功能轴二分**；经受限指令 `switch_route`（agent-loop Command 扩展，
非 patch op）执行，嫁接后过 validate + lint（含卡面校核）+ 静态回放核验，
`falsifiableClaim` 必填接 ablate 单变量臂；单次换轴嫁接 ≤2 单元，来源限同谱系
alternates（同卡组同 gameVersion）。

**与现有设施的衔接（即时制）**：author 已有多轮 harness（--turns）与两阶段 --anchor
（3 候选共享单锚点，是评审「凭锚点层论证」的前提）；评审为同模型 +1 次 LLM 调用，
复用 `cli/llm.ts` 的 chatCompletion 原语；评审产物 `<out>.candidate-review.json` 与
落选候选 sidecar 复用 anchor sidecar 落盘模式。plan:batch 与 ablate-criteria.ts 胜率
区间 N≥20 判据的复用点在**评定判据**（候选制 vs 单发起的 A/B 判定），不在候选选择
环节。

**成本预估**：author 调用 ×3 + 评审 ×1（对战制的 +2 套 batch 已随该选项一并否决）。
若只对「路线分歧高风险卡组」（d0/d5/d6 类）启用，成本可控。

**评定判据建议**：挑 d5/d6/d2 三个「r1 已证路线敏感」的卡组做小规模 A/B——
候选制 vs 单发起的臂对臂战绩与 coverage，确认收益后再推广。

## 赛程缺口：现有锦标赛组件 vs「跨代×跨模型×交叉卡组」需求

> 2026-09-08 追加。核对对象：model-tournament / anchor-experiment / plan-iterate /
> tournament-scheduler 组 / tree-bench / plan:batch 断言。结论：**目标赛程（跨代 × 跨模型
> × 交叉卡组全矩阵 + 按臂/按代连通 Glicko-2）在现有组件中没有任何一处完整实现**；
> 正在跑的 `output/anchor-exp-v40/cross/`（臂内跨模型×交叉卡组@r3）也只是其中一个切片。

### 各组件实现事实

- **model-tournament.ts（主赛编排）**：plan:batch 决策树对战（零 LLM）。赛程 =
  每代**同代跨模型全矩阵**（有序模型对 X≠Y × 有序格对 (di,dj) 含镜像与双向交叉，
  `model-tournament.ts:684-697`）+ r≥1 **同模型相邻代链批** X@r vs X@(r-1) 全格对
  （`:699-713`）。plan 侧为 portfolio（general=unknown_deck 兜底 + 按 opponentDeckCode
  路由 known_deck single），对手侧为 single 格树。**无跨模型跨代**（X@r vs Y@s, r≠s）
  ——赛程枚举里不存在 planModel≠oppModel 且 planRound≠oppRound 的组合；**无「臂」概念**。
  读数经 export 子命令映射 tree-bench results 后逐 view 调 analyze（`:1006-1031`）。
- **tournament-scheduler.ts / tournament-config.ts / tournament-state.ts**：调度循环
  （就绪/派发/drain）+ config 校验 + done 位图，**不含任何赛程生成逻辑或跨代配对原语**；
  配对维度写死在 model-tournament 的坐标循环里，无配置开关。
- **anchor-experiment.ts**：每 model × di × 双臂 × 5 seeds，起草全部 `--mirror`（`:265`），
  批任务 plan/对手取自**同一模型同一卡组**（`:332-345`），臂矩阵只在双臂间配对——
  **从不跨模型、从不跨卡组**；读数只有 coverage/fallback/avgRounds + 臂对臂胜负计数，
  不接 tree-bench（`:371-402`）。
- **plan-iterate.ts**：同模型内部 4 臂配对/代（ctrl-ctrl/anchor-anchor/ctrl-anchor/
  anchor-ctrl），无跨模型——这正是 §0.4 计分时 8 名选手只能按模型内连通、热力图大面积
  gamesMatrix=0 填 0.5 的赛程根因。
- **tree-bench**：`p1===p2` 抛错（results.ts:61-63）；period 按数字升序逐期结算、期内
  互不级联、期内无对局者仅 RD 膨胀（analyze.ts:187-217, glicko2.ts:91-96,195-229）；
  **Glicko-2 不校验池连通性**（断连分量各自出分、互不可比），heatmap 无对局格填 0.5，
  spin-top 在稀疏池上自动缩到 `--dense-subset` 稠密子块。
- **assertOpponentAlignment（batch-runner.ts:233-243）**：只断**卡组级**对齐
  （mirror/known_deck 树打非起草卡组 → fail-fast，`--allow-opponent-mismatch` 放行；
  unknown_deck 直接过）。**不阻挡跨模型/跨代**——对手模型身份与代际不参与断言。

### 与需求的差异清单

| # | 需求点 | 现状 | 证据 |
|---|---|---|---|
| G1 | 跨代×跨模型（X@r vs Y@s，r≠s，X≠Y） | **全组件缺失**。唯一跨代形态是同模型相邻代链批 | model-tournament.ts:684-713 |
| G2 | 臂（ctrl/anchor）维度 | 臂只存在于 anchor-exp/iterate 线，且臂内无跨模型；主赛无臂（按实验计划应该是无臂的，只单独做小范围实验说明策略锚点的副作用，这点没问题） | anchor-experiment.ts:332-345 |
| G3 | 交叉卡组配对 | 主赛已有（D² 全格对）；anchor-exp 线没有（恒镜像格） | model-tournament.ts:687-696；anchor-experiment.ts:345 |
| G4 | 跨卡组的对手一致性 | mirror/known_deck 树跨卡组必经 `--allow-opponent-mismatch`；主赛 portfolio 的 general（unknown_deck）天然放行——**anchor-exp 的 r3 树全是 mirror 起草，交叉赛只能走 legacy 放行，威胁/防御规则按同卡组起草、打异卡组时语义错配** | batch-runner.ts:233-243 |
| G5 | 按臂/按代的连通 Glicko-2 | period 机制支持按代结算；但连通性靠赛程保证，工具不校验；稀疏视图会渲染断连分量分 + spin-top 缩稠密子块 | analyze.ts:187-265 |
| G6 | 隔代对局（X@r vs X@(r-2) 等） | 无，链批只吃相邻代 | model-tournament.ts:699-713 |

### 弥合路径（供评定）

1. **赛程枚举扩展**：在 model-tournament 的 `enumerateBatches` 增加跨模型跨代循环
   （或新写枚举器），即可复用现有 plan:batch / export / analyze 全链——配对断言与
   计分工具都不拦这一维度（G1/G5/G6）。
2. **臂维度**：承认「臂」是 anchor-exp 线独有、用独立编排（如现行 `.tmp/cross-tournament.mjs` 模式）
   跑臂内/臂间矩阵再统一进 tree-bench results（改动小，现行路径）。（2026-09-08 确认：
   维持现状——主赛不引入臂维度，臂间矩阵仅用于策略锚点副作用的小范围实验。）
3. **跨卡组语义**：若要认真打跨卡组，起草侧应用 `--opponent-set`（unknown_deck
   general）而非 mirror 树放行——否则威胁/防御包按镜像起草的事实会让「跨卡组战绩」
   系统性偏低，读数须带此口径注记（G4）。注意 `--opponent-set` 与 `--anchor` 互斥
   （run-plan-author.ts:125-127）：锚点副作用实验与跨卡组实验不可兼得于同一棵树，须分立。

## 关联

- 设施侧实现点：`cli/modules.ts`（模块注册表）、`cli/evidence-extract.ts`（机械证据）、
  `fields-lint.ts`（链级 lint）、`cli/ablate-criteria.ts`（消融判据）、
  `docs/oracle-free-harness-metrics.md`（计数口径，改动时需同步）
- 实验数据：`output/anchor-exp-v40/run/anchor-review.md`（错误编目）、
  `output/anchor-exp-v40/iterate/r1-changes.md`（r1 修复对照）
