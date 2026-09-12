# Oracle-Free Harness 错误指标与产物 Schema

> **状态：现行** · 建立日期：2026-09-03 · 2026-09-04 同步移植审查修复批（兄弟仓库 `35f53386` 同源：patch 覆盖确认闸 / noDecisionSpace 兜底口径 / reasoningOnly 统计 / digest 信息口径修订 / fallback 二选一） · 基于 `src/runtime/plan-oneshot/` 通读（含 2026-08-30 无 oracle 自进化臂、2026-09-03 覆盖率护栏） · **2026-09-05 WP2 写入端补采同步**（P0-1 `game_state_log.e` 真实落盘 / P0-3 `<out>.replay-report.json` / P0-4 HarnessStats 增 issueHistogram/rejected/counters / P3-1 跨代聚合脚本 `scripts/ops/aggregate-generations.ts`） · **2026-09-05 lean 签名指针化同步**（`traceSignatures:"lean"`：条目签名改短哈希指针 + `sig-backfill.ts` 反查回填，默认 full 逐字节不变，见 §3.2） · **2026-09-08 卡面校核同步**（`card-face-table.ts` 静态事实表 + fields-lint 第 4 类 + reflect 首轮推送注入（§5.6）+ HarnessStats `cardFace`/`cardFaceFixed`（§7.1）+ 偏差 §10.9–11） · **2026-09-08 审计修复同步**（fields-lint ② 的 useSkill 持有者改从 `when` 的 `self.active.defId` 推导（数字 target = 对手侧目标）；技能取数统一走源码 `.type(...)` 短名；**第 4 类校核去资产化**（费用/HP/伤害真值唯一来源 = `card-face-table` 本地源码扫描，零网络）；注入段标题与回注 issue 文案英文化，详见 §5.6 与 §10.11）。
> 主题：oracle-free 自进化臂（`--evidence engine-only`）管线中，**哪些错误模式被检测、哪些做了兜底、哪些被计数、计数落在哪个产物文件**。改动计数口径或产物 schema 时同步更新本文。

---

## 1. 范围与阅读路径

管线：`plan:author`（起草）→ `plan:batch`（离线批量对战，PlanPlayerIO 执行决策树）→ `plan:reflect --evidence engine-only`（机械证据提取 + LLM 反思 + patch ops）→ 服务端合并 + 静态回放核验 → `plan:ablate`（引擎侧判据裁决）。

"oracle-free" = ISMCTS/NN 回算产物（`plan_eval*.json`）全程不进反思环路，启动时有泄漏断言（§5.1）。本文只覆盖引擎侧口径；oracle 口径（blunder/visitGap/alignmentMiss）仅在对照处标注。

| 代码 | 职责 |
|---|---|
| `src/runtime/plan-oneshot/plan-player-io.ts` | 执行期决策 + 兜底 + 逐决策点 trace |
| `src/runtime/plan-oneshot/trace.ts` | trace 汇总计数（decisionCounts/perRuleHits/perRuleThenMiss） |
| `src/runtime/plan-oneshot/batch-runner.ts` | 批量对战聚合 → summary.json |
| `src/runtime/plan-oneshot/validate.ts` / `fields-lint.ts` | 校验期检测 + 机械修复 |
| `src/runtime/plan-oneshot/cli/evidence-extract.ts` | 反思证据提取（fallback/threat/fullDigest 计数） |
| `src/runtime/plan-oneshot/cli/run-plan-reflect.ts` | 统计锚点块 + harness 编排 + sidecar 落盘 |
| `src/runtime/plan-oneshot/cli/agent-loop.ts` | HarnessStats 行为计数 |
| `src/runtime/plan-oneshot/plan-patch.ts` / `plan-replay.ts` | patch 合并校验 + 静态回放核验 |
| `src/runtime/plan-oneshot/cli/ablate-criteria.ts` | engine-only 消融判据（纯函数） |

## 2. 产物清单（错误计数相关）

| 层级 | 文件 | 写入方 | 计数内容 |
|---|---|---|---|
| run（batch） | `summary.json` / `summary.side1.json` | batch-runner | 胜率、avgCoverage、fallbackRate、perRuleHits、perRuleThenMiss、perGame |
| game（batch） | `game-NNNN/plan_trace.json`（对手侧 `.side1.json`） | batch-runner | 逐决策点条目 + decisionCounts/perMethod/perRuleHits/perRuleThenMiss |
| game（batch） | `game-NNNN/game_state_log.json` | batch-runner | 引擎状态日志（oracle 对齐用；engine-only 不读）。**2026-09-05 起（P0-1）mutations 序列化进逐条 `e` 字段**（伤害/抽牌等引擎 mutation 全量留档，精确确定性回放用）；旧 run 的 `e` 恒空数组，读取方按 `entry.e.length>0` 分支兼容。**lean trace 模式下为本侧 trace 签名反查的唯一底座（sig-backfill）——lean run 删除/抽样该文件会使对应局的局面摘要降级"(无 state)"** |
| run（batch） | `plan.side0.json` / `plan.side1.json` / `portfolio.side0.json` / `plan.side0.anchor-assertions.json` / `plan.side0.alternates.json` | batch-runner | 计划归档（溯源用，无计数）；锚点断言/多候选旁档存在时随主计划原样拷入（旧产物或未启用对应特性 → 不写） |
| author 产物 | `<out>.json` + `<out>.harness.json` + `<out>.transcript.jsonl` | run-plan-author | 修订计划 + harness 行为计数 + 逐轮原始记录 |
| author（--anchor） | `<out>.anchor.json` + `<out>.anchor-assertions.json` | run-plan-author | 策略锚点 + 锚点数值断言机检（killMath/comboLines 逐条 status/detail + unchecked，`AnchorAssertionsV1`；有 issue 时进 author 重试循环，见 §6）。**2026-09-09 起另含首轮合规账**：`attempts`（锚点阶段总尝试次数，首轮即过 = 1）+ `firstAttemptIssues`（首轮失败 issue `{path,category,message}`，category 由 path+message 机械归类为 missing-number｜cost-mismatch｜damage-over-allowance｜not-in-deck｜other）；两者为增量可选键，旧旁档无之、读取侧按 n/a |
| author（--candidates） | `<out>.alternates.json` + `<out>.candidate-review.json` | run-plan-author | N（2..4）个候选全量树（2026-09-09 起**同一对话内分 N 轮顺序起草**，第 k 轮可见前 k-1 个候选并要求显式拉开路线距离；重复候选回注重出）（`PlanAlternatesV1`：index/archetype/reviewNote/adoptedUnits/plan，含被选中者）+ 评审原文（`CandidateReviewV1`：choice/rationale/notes + 候选 planId 映射）；被选中候选的树写 `<out>` |
| reflect 产物 | `<out>.json` + `<out>.reflection.json` + `<out>.harness.json` + `<out>.transcript.jsonl` + `<out>.prompt.txt` + `<out>.replay-report.json`（--patch 时） | run-plan-reflect | 同上 + verdicts（含换轴合成）+ 换轴审计 `routeSwitches`（--patch 有换轴时）+ prompt（泄漏机检）+ 逐 op 回放断言（P0-3） |
| reflect（portfolio） | `<out>/plans/*.json` + `portfolio.json` + `reflect.*`（sidecar 落目录根部，含 `reflect.replay-report.<tag>.json`，tag 带 r<N>） | run-plan-reflect | 分层树 + 同一套 sidecar |
| ablate 产物 | `<outDir>/ablation-report.json` + 各臂 `<armId>/plan.json` | run-plan-ablate | 判据结果（status/note）+ 臂计划 |
| 跨代聚合 | `trend.json` + `trend.md`（P3-1，2026-09-05 新增） | `scripts/ops/aggregate-generations.ts` | 每代一行：五指标 thenMiss/coverage/fallback/winRate/avgRounds + issueHistogram + counters（2026-09-08 起含 cardFace / cardFaceFixed 列，旧产物缺字段按 0 计） |

**重要口径差异**：`plan_trace.summary` 的 `decisionCounts`/`coverage`/`fallbackRate` 统计**全部方法**（action + chooseActive + switchHands + rerollDice + selectCard）；而反思期 `extractFullDigest` 的 `fallbacks`/`declareEnds`/`thenMissPoints` 只统计 **method=action** 的决策点。两处 fallback 数不可直接相减比较。

## 3. 执行期（PlanPlayerIO）——检测 + 兜底 + 计数齐全

总原则：**任何内部异常 → 兜底 + trace note，绝不向引擎抛错**（`plan-player-io.ts` 头注）。

### 3.1 fallbackPolicy 全集（兜底策略枚举）

| method | fallbackPolicy | 触发条件 | 兜底行为 |
|---|---|---|---|
| action | `no_valid_action` | 引擎候选中无 `validity==VALID` 动作 | 取 `actions[0]` |
| action | `declare_end` / `conservative` / `baseline`（= 计划 `fallback.policy`） | 规则链全未命中 | declare_end：选 declareEnd；conservative：declareEnd 不可用则选最低费用动作；baseline：BaselinePolicy 决策（其内部异常 → 静默降级为首个合法动作） |
| action | `exception_default` | 决策路径任何异常（requireState 失败、字段求值崩溃等） | 走同一兜底；notes 记 `exception: <msg>` |
| chooseActive / selectCard | `first_candidate` | opening 规则未命中 / 异常（**单候选 = 无决策空间，`fallbackUsed=false` 不计兜底**，2026-09 起） | 取候选 0 |
| switchHands | `keep_all` | mulligan 无规则 / 长度不齐 / 异常 / 规则未 engage | 不换牌 |
| rerollDice | `keep_all` | 无 state / 无骰 / 异常 | 不重掷 |
| rerollDice | `default_reroll` | 有 state 但无 reroll 规则命中 | 保留万能 + 存活角色元素骰（与 PolicyPlayerIO 同口径） |

### 3.2 决策点条目（PlanTraceEntry）

关键字段：`seq / round / turn / method / stateSignature`（玩家视角 state JSON 签名，反思回放语料）、`phaseId`、`candidateCount`、`matchedRule{scope, priority, reason, layer?, layerLabel?}`、`fallbackUsed`、`fallbackPolicy`、`chosen`、`threat?`、`notes[]`、`thenMiss?[]`（when 全真但 then 零命中的规则键列表——**死规则探针**）。`stateLogIndex` 执行期恒 null（oracle 对齐侧回填，engine-only 不用）。

**lean 签名模式（2026-09-05，`PlanBatchConfig.traceSignatures="lean"`，显式 opt-in；缺省 "full" = 上述形状逐字节不变）**：lean 下条目**省略 `stateSignature`**，改带 `sigHash`（整份签名的 sha256 前 16 hex，算法常量 `trace.ts SIG_HASH_ALGO="sha256-16hex"`），文件级追加 `traceSignatures:"lean"` + `sigHashAlgo` 标记。单局 trace 从 ~0.7MB 降到 <30KB（签名占 full 模式字节的 ~85%）。消费侧（evidence-extract / modules / plan-replay / eval-game `loadAlignedGameInput` / organize-export）经 `sig-backfill.ts` 从**同局** `game_state_log.json` 反查回填：对暂停点重算 `planStateSignature(exposeState(side, state))` 取同哈希匹配，回填签名与 full 模式内嵌签名逐字节相等。覆盖边界：全部 **action** 决策点可反查（引擎 pause/notify 边界差异 <10%）；opening 类部分条目（rerollDice / 回合中 chooseActive）的决策中间态本就不在 state log 快照里（roll 暂停点先于掷骰 mutation），回填 missed 属预期——与 full 模式 eval 对齐口径（只对齐 action 条目）一致。

规则键格式（`rule-key.ts` formatRuleKey）：`global:<priority>` / `phase:<phaseId>:<priority>`；portfolio 层化模式带层前缀 `general:…` / `single:<label>:…`。trace 键、反思 ruleRef、消融 rankKey 三处同口径。

### 3.3 trace summary 计数（每局每侧）

```text
decisionCounts: { total, ruleMatched, fallback }     # 全方法统计
coverage = ruleMatched / total                        # total=0 时为 0
perMethod[method] = { total, ruleMatched, fallback }  # 分方法细分
perRuleHits[key] = 命中次数                           # 首条命中才算
perRuleThenMiss[key] = when 全真但 then 零命中次数     # 死规则探针
```

### 3.4 threat 读数（opp.threat.*）与降级

`maxDamage / lethal / lethalP / burstReady / burstP / maxDamageAfterSwitch`，仅 method=action 条目携带；上界/概率口径而非精确值。**已知降级**（threat.ts `loadSkillDamageMap`）：打包环境读不到 `data/src/characters/*.ts` 时伤害表为空 → maxDamage/lethal/lethalP/maxDamageAfterSwitch 恒 undefined（条件恒假），burstReady/burstP 仍可用。快照整体异常 → 整个 `threat` 字段省略，不影响决策确定性。

### 3.5 NN 对手附加计数（batch 输出行）

`nnErrors`（服务端错误次数）、`nnModel/actionDecisionCount`（模型决策占比）——仅在 `opponent.type === "nn"` 时出现在每局进度行，不进 summary.json。

## 4. 批量对局聚合（summary.json / summary.side1.json）

| 字段 | 公式 / 说明 |
|---|---|
| `winRate` | wins / games（draws 占分母不计入分子） |
| `avgRounds` / `avgCoverage` | 逐局均值 |
| `fallbackRate` | Σfallback / Σtotal（全方法口径，见 §2 口径差异） |
| `perRuleHits` / `perRuleThenMiss` | 跨局累加（组合模式键带层前缀，同一条 general 规则可跨对手组归并） |
| `perGame[]` | 逐局：gameDir / seed / planSide / winner / rounds / coverage / ruleMatched / fallback / total |

版本钉扎：`resolveBatchGameVersion`（config vs plan 错配 fail-fast，`--force` 降级 warning；NN 恒锁 v6.3.0）；`assertOpponentAlignment` 起草对手 vs 实际对手牌表错位 fail-fast（`--allow-opponent-mismatch` 为 legacy 复现逃生口）。这些是**只检测不计数**的 fail-fast 项。

## 5. 反思期证据（engine-only，进 prompt 不单独落盘）

### 5.1 泄漏断言（fail-fast）

`findOracleArtifacts(runDir)` 扫 run 目录（含 game-* 子目录），存在任何 `plan_eval*.json` → 拒绝启动（不依赖"文件恰好不存在"的隐式卫生）。`--eval-suffix` 与 engine-only 互斥；交叉对手组 planId 断言 / portfolio 组 portfolioId 断言；run 目录版本与计划版本错配 → 中断（`--force` 降级 warning）。prompt 全文落 `<out>.prompt.txt` 供泄漏机检（S-M1 验收：engine-only 全程无 oracle 字样）。

### 5.2 证据三段（evidence-extract.ts）

| 段 | engine-only 口径 | 行数上限 |
|---|---|---|
| blunder 局面 | **恒空**（eval 读取短路） | — |
| fallback 局面 | method=action 且 fallbackUsed 的决策点，附局面 digest + fallbackPolicy | 每局 3 行、全 run 8 行 |
| 斩杀威胁点 | `threat.lethal===true 或 lethalP≥0.5` 的 action 决策点（无 oracle 时防御归因的唯一定量抓手） | 每局 3 行、全 run 8 行 |

### 5.3 全量摘要计数（FullDigestResult）

每个 action 决策点一行：`digest | 命中规则 | 选 <动作> | 威胁 | <fallback:policy> | thenMiss:键`。

| 计数 | 含义 | engine-only 是否产出 |
|---|---|---|
| `totalPoints` | action 决策点总数 | ✓ |
| `fallbacks` | fallbackUsed 行数（**仅 action 口径**） | ✓ |
| `thenMissPoints` | thenMiss 非空行数（engine-only 主信号） | ✓ |
| `declareEnds` | chosen=declareEnd 行数（龟缩化代际监控，round3 护栏） | ✓ |
| `omittedAligned` | 超行数上限被均匀抽样的正常行数（fallback/thenMiss 行**全量保留**，永不省略） | ✓ |
| `blunders` / `divergences` | oracle 判失误 / 分歧数 | ✗（恒 0，不进引擎侧统计块） |

行数上限：单组 420 行；多对手组按 `max(80, 420/组数)` 均分预算。digest 信息口径（2026-09 修订）：骰**色面构成**、非出战角色充能、对手手牌数、召唤/支援/战斗状态实体列表（非空才追加）——仍剪裁双方手牌内容（对手物理不可见）与牌堆。

### 5.4 统计块锚点（每对手组，进 reflect prompt）

- **零命中规则告警**：`perRuleHits=0` 的规则（when 从未为真）→"改没了"检测。legacy 用 `collectRuleRefs`，portfolio 模式用 general 层层化键。
- **declareEnd 占比** = declareEnds / totalPoints，逐代上升 = 龟缩化信号。
- evalSummary（blunderRate/perRule）在 engine-only 整体跳过。
- D6 层路由建议（portfolio）：证据键跨组分布 ≥2 组 → 建议修 General，仅 1 组 → 修该组 Single。

### 5.5 fallback_report 聚类（双臂默认注入）

fallback 缺口按（出战角色 × 回合）聚类；**占比 ≥5 次或 ≥20% = 覆盖缺口集中区**（优先补规则），零散 1–2 次视为长尾；威胁列统计 fallback 发生时对手已构成斩杀/爆发信号的次数（高威胁 fallback 优先补防御）。`rule_drilldown` 对既未命中也未 thenMiss 的 ruleRef 返回 notFound。

### 5.6 卡面校核推送（2026-09-08，纯机械、不占模块预算；注入段标题 `# Card-face checks`）

针对「机械证据结构性看不到数值错误」的缺口（thenMiss/kills/fallback 从不指向费用/HP/伤害记错）：reflect 启动时对当前计划（portfolio 模式逐层，`general ` / `single:<label> ` 前缀）跑 fields-lint 第 4 类（§6），把 finding 渲染成 `# Card-face checks` 段注入**首轮 user 消息**（与 statsText/evidenceText 同通道，不进 request_modules、不占模块预算；one-shot 与 harness 同注入，全文落 `<out>.prompt.txt` / `<out目录>/reflect.prompt.txt`）。无发现时也注入「未发现数值不一致」一行（说明检查已执行）。

- **数据源（唯一，零网络）**：费用 / HP / 基础伤害全部取 `card-face-table.ts` 对 `@gi-tcg/data` builder-DSL 源文件的静态扫描（`.costXxx(N)` 费用、`.health(N)` HP、字面量 `.damage(DamageType.X, N)` / `.endPhaseDamage(...)` / `.heal(N)`，按 `.since`/`.until` 复刻 core `resolveOfficialVersion` 选择版本变体，含 `packages/data/src/old_versions/*.ts` 的旧版覆盖）。不读 AssetsManager、不发网络请求（2026-09-08 去资产化：资产接口只在 prompt 卡面文本/模块取数等非校核路径使用）。
- **检查项**（v1）：① `playCard` + `card_def_id` 的骰子闸（`dice.<e>+omni` / `dice.total`，含 `>` 归一 +1）vs 卡面费用；② `useSkill` + `skill_type` 的骰子闸 vs 该技能费用（含充能费展示）——技能持有者从 `when` 的 `self.active.defId ==` 条件推导，数字 `target` 是技能伤害的**对手侧**目标（action-match.ts 语义），推不出持有者即跳过该项；then 带 `skill_def_id`（core `skillDefinitionId` 同域，牌表详情 `#<id>`）时改用**精确变体**（该技能自己的费用），否则技能取数 = `cardFace.skillsOf(charDefId)` 过滤源码短名（计划 `normal_attack|elemental_skill|burst` → 源码 `normal|elemental|burst`，兼容旧两值）后的**同类型全变体**，按「最宽松变体」判定：闸能支付任一变体（`min ≥ 该变体所需骰`）即不报 over、连最便宜的变体都付不起才报 too-low、连最贵的变体都被闸超出才报 over（如纳西妲两个元素战技 17032 3草 / 17033 5草；空费用/prepared 变体不参与费用腿）；③ `self|opponent.characters.<defId>.hp` 数值阈值 vs 卡面 HP 上限（`>=`/`>`/`==` 超上限 = 恒假）；④ `then.damage_min` vs 源码字面量基础伤害 +2（反应/增益余量，启发式）——`skill_def_id` 精确指名时只看该技能，否则同样按同类型全变体：任一字面量变体满足即不报，存在无字面量真值的变体（dynamic / 无伤害条目）时该腿跳过，全部字面量变体都超出才报（多变体文案列出各变体 base）。开局的 chooseActive/mulligan/reroll 不做数值校核（无费用/HP/伤害断言；存在性归 validate）。
- **dynamic 跳过**：`.do()` 闭包内 `c.damage()/c.heal()`、条件 `.increaseDamage()`、非字面量参数一律标 `dynamic: true`，其数值不校核（偏差见 §10.9）。
- **降级**：数据包 src 目录不可读 → 空事实表（校核静默跳过；偏差见 §10.11）。无资产降级路径——本检查不依赖任何资产接口。
- **硬边界**：校核结果只是 finding（不阻断 validate）；不重复 validate 的存在性检查；反应加成算术/效果语义不在 v1 范围（v2 扩展点）。

## 6. 校验期计数（即时，不持久）

> 现状：校验发现的问题**没有跨代聚合、没有作图、没有独立落盘**——数量随反馈文本回给 LLM，明细只在 stdout / transcript。

| 计数 | 来源 | 持久化 | 说明 |
|---|---|---|---|
| `validation.issues.length`（带 repairable/fatal 标注） | validateGamePlan | ✗（反馈文本/stdout） | 死规则（引用牌表外 defId，"该规则永不命中"）、空计划闸（0 规则 = 100% fallback 直接拒）、priority 重复、phaseId 含 `:`、版本非法/defId 版本不存在、predictions 缺失等 |
| `validation.warnings.length` | validateGamePlan | ✗ | 劝告性警告（hasCardP 引用对手牌表外卡 → 运行时恒 undefined） |
| lint findings 数 | lintPlan（4 类） | ✗ | ①早位规则 when ⊆ 晚位（遮蔽）②同链 when 完全重复 ③单规则同字段矛盾（恒假）④卡面数值校核（费用/HP 上限/基础伤害，需 ctx；2026-09-08 新增，口径见 §5.6） |
| `dropped.length` | autoRepairPlan | ✗ | 机械移除引用非牌表 defId 的死规则/条目，反馈"移除了 N 个" |
| `ruleRefWarnings.length` | ruleRefWarnings | ✗ | verdicts 的 ruleRef 不在原计划（封闭集合外幻觉） |
| patch 拒绝 issue 数 | plan-patch | ✗ | **整批拒绝不部分应用**：ruleRef 不在当前树 / 同命令重复 / 未知 op 或键 / 超 maxOps（默认 8）/ portfolio 层前缀缺失、层不存在、position 层不一致 / 目标被先前 op 删除 |
| attempt 次数 | 各 CLI 重试循环 | ✗（仅 stdout；2026-09-09 起 **author anchor 例外**：总尝试次数落 `<out>.anchor-assertions.json` 的 `attempts`） | author `--repair N`（默认 2，共 ≤3 次）；reflect one-shot ≤2 次；author anchor 2 次 |
| 锚点数值校核 issue 数 | `checkAnchorAssertions`（`cli/author-anchor-check.ts`） | ✗（issue 明细仅 stdout；断言级结果另落 `<out>.anchor-assertions.json` 旁档，非本表计数） | `--anchor` 第一阶段机检：牌表存在性 / costAssertion vs 技能卡面费用 / damage vs 基础伤害 +2（费用与伤害按**同类型全变体**匹配——任一变体一致/满足即通过，dynamic 伤害与「超余量但带非空 reactionPrereq 的加成总伤」降级 unchecked 不拦截）；有 issue 即回注 LLM 重试（默认 ≤2 次尝试，形状闸同路径）；**2026-09-09 起首轮失败 issue 另落旁档 `firstAttemptIssues`（path/category/message，只记首轮）** |
| switch_route 拒绝 issue 数 | `applyRouteSwitch`（`cli/run-plan-reflect.ts`；守卫纯函数 `checkGraftUnits` 在 `plan-graft.ts`） | ✗（回注反馈/stdout；被拒逐条进 harness `rejected[]` stage=patch，见 §7.1） | 换轴守卫：仅 --patch harness + alternates 旁档；candidateIndex 必须有效且非已落地候选（chosenIndex）；units 1..2 个且语法合法、phaseId 在**候选树**中、未重复采纳（候选 adoptedUnits ∪ 本 run 已嫁接）、本 run 累计 ≤2；reason/falsifiableClaim 必填；嫁接后 validate + lint + 静态回放任一不过 → 整条拒绝、当前树不变 |

静默修复（无计数、无反馈）：`normalizePlanNumericFields` 字符串数字 → number、单对象 → 数组、target 字符串 id 归一（`"1605"` → 1605；校验层对漏网的字符串 target 硬报错）。

> **2026-09-05（P0-4）持久化缺口已关闭（harness 路径）**：draft/final 校验 issues 逐条机械分类进 `*.harness.json` 的 `issueHistogram`（deadRule/format/closedSet），patch 拒绝进 `patchRejected`，lint findings 进 `lint`，被拒 draft/patch 逐条留档进 `rejected[]`（schema 见 §7.1）。上表"持久化 ✗"现在仅指 one-shot 路径（`--turns 1`）与 2026-09-05 前的旧产物。
>
> **2026-09-08 起 lint findings 以数组（含 `kind`）回传**：`issueHistogram.lint` 仍为总量，其中 `kind="card-face"` 的条目另计 `issueHistogram.cardFace`（按 kind 分桶，不靠 message 文本）；`counters.cardFaceFixed` 统计「循环内早前 draft/patch lint 出现过、最终采纳稿的 lint 未再出现」的 card-face 键（kind|path|message 去重）。
>
> **2026-09-08 起锚点数值断言进 author 重试环路**：`--anchor` 第一阶段的锚点产物在形状闸后过 `author-anchor-check` 机检（牌表存在性 / 技能费用 / 基础伤害 +2 余量；费用与伤害按同类型全变体任一匹配，dynamic 伤害与带 reactionPrereq 的加成总伤降级 unchecked），issues 回注 LLM 重试（明细仅 stdout，不进 `*.harness.json`——锚点阶段先于 harness 循环）；断言级结果持久化在 `<out>.anchor-assertions.json`（§2），`plan:batch` 随主计划拷入 run 目录，reflect 按计划版本重算并注入 `# Anchor assertion checks` 段（portfolio 模式跳过——锚点树为单树产物）。**v1 边界**：第三条腿「对局实测」为扩展点——kills 规则位的 `perRuleHits` 已隐含击杀计数，伤害实测待 state log mutation 归因。
>
> **2026-09-09 起锚点首轮合规率可跨格/跨模型聚合**：锚点旁档增 `attempts` / `firstAttemptIssues`（增量可选键，旧旁档无之 → 聚合按 n/a，不报错）。机检失败**不做类型转换兜底**（如 `killMath.damage` 非数值即 issue 并归类 `missing-number`），纪律问题改以指标落盘：首轮通过率 = `attempts===1` 的格数 / 有该字段的格数，issue 按 category 计数。A/B 报告（`.tmp/candidates-ab.mjs`；`--report-only` 跳过 smoke/author/battle 只把报告打到 stdout、不写产物，配 `CAB_OUT` 可在 fixture 上复核）在 report.md 增「锚点首轮合规」一节，按 模型×臂 聚合 plans 目录下既有 `*.anchor-assertions.json`。
>
> **2026-09-08 起换轴走 switch_route（单元级嫁接，接多候选旁档）**：run 目录有 `plan.side<N>.alternates.json` 时 reflect 首轮注入 `# Alternative routes` 段（候选 index/archetype/评审短评/adoptedUnits + 形状摘要，不注入整棵树）；`--patch` harness 模式下 LLM 可用受限命令 `switch_route` 从候选树嫁接 GamePlanV1 结构单元（opening / fallback / rules / phase:<phaseId>，单次 ≤2、本 run 累计 ≤2，来源限同谱系 alternates 且不得选已落地候选 chosenIndex）。成功计 `routeSwitches`（§7.1）、被拒按 patch 被拒同口径计 `issueHistogram.patchRejected` + `rejected[stage=patch]`（§7.1）；嫁接合成 ruleVerdicts（`{ruleRef: "global" | "phase:<id>" | "opening" | "fallback", verdict:"revise", source:"patch"}`）进 `<out>.reflection.json`，换轴审计记录（候选/单元/reason/claim/planId/adoptedUnits）落同文件 `routeSwitches`。**ablate 开臂边界（扩展点）**：`ablate-criteria` 的 ruleRef 解析只认 `global:<priority>` / `phase:<id>:<priority>` 规则键（run-plan-ablate.ts 的 `parseRuleRef`），换轴合成的**链锚点**（`global` / `phase:<id>`）与 `opening` / `fallback` 均落入"ruleRef 不可解析"跳过路径（ablation-report 记 note，不阻断）——要让换轴进消融臂，需扩展 ablate 把链锚点展开到具体规则（或改发逐规则 verdict），属后续工作。run 目录为只读证据：逐候选 adoptedUnits 的本 run 记忆只在内存与 reflection 旁档，不就地改写 alternates 旁档（跨 run 从旁档初值重启）。

**已知不对称（确认为有意，2026-09 口径注记见文件头）**：reflect one-shot 路径（`--turns 1`）只做 prepareRevised + validateGamePlan，不跑 lintPlan 与 ruleRefWarnings——对照臂保持最小干预、与 harness 臂辅助强度对等；代价是修订稿可能带遮蔽链/ruleRef 幻觉通过验收。harness 路径两者都有。

## 7. Harness 行为计数（持久：`*.harness.json`）

### 7.1 HarnessStats schema（agent-loop.ts，author 与 reflect 同一套）

| 字段 | 含义 |
|---|---|
| `label` / `model` / `turns` | run 标识与轮次 |
| `terminatedBy` | `final`（final 通过）/ `turn_cap_draft`（轮次耗尽回退最近通过校验的 draft）/ `failed` |
| `adoptedDraftTurn` | 回退时采用的 draft 出自第几轮 |
| `drafts` / `finalAttempts` | draft / final 命令提交次数 |
| `patches` | **被成功合并**的 patch 命令数 |
| `routeSwitches` | **（2026-09-08）被成功嫁接**的 switch_route 命令数（reflect 换轴；仅 --patch harness 且首轮注入 `# Alternative routes` 段时可用）。被拒的 switch_route 计入 `issueHistogram.patchRejected` + `rejected[stage=patch]`（与 patch 被拒同口径），不单列 |
| `gatedFinals` | 被 finalGate 打回的 final 次数（含零修订闸：planId/portfolioId 与初始一致 → 打回，再次 final 可强制通过） |
| `issueHistogram` | **（2026-09-05 P0-4；2026-09-08 增 `cardFace`）**校验期 issue 类别直方图 `{ deadRule, format, closedSet, lint, cardFace, patchRejected }`：draft/final 校验未通过的 issues 逐条按 `classifyIssueText` 机械分类（死规则/引用牌表外 defId/永不命中 → `deadRule`；ruleRef 不在原计划/当前树、未知 field/op/层、层前缀 → `closedSet`；其余 → `format`），协议错误轮计 `format`，patch 被拒的 issues 逐条计 `patchRejected`，lint findings 逐条计 `lint`（`cardFace` = 其中 `kind="card-face"` 的子集，按 kind 分桶） |
| `rejected` | **（2026-09-05 P0-4）**被拒 draft/patch 逐条留档 `{ stage: "draft"\|"patch", round, reasonCode, detail }`——`detail` 为回注 issues 拼接截断（≤200 字）；draft/final 校验未通过的 `reasonCode` = 主导类别（平票按 deadRule > closedSet > format），patch 与 switch_route 被拒恒 `"patchRejected"`（switch_route 归入 stage=patch）。协议错误轮与 finalGate 打回**不进本表**（前者只进 issueHistogram.format，后者已有 gatedFinals） |
| `counters` | **（2026-09-05 P0-4；2026-09-08 增 `cardFaceFixed`）**`{ lintFindings, droppedAttempts, totalAttempts, cardFaceFixed }`——lintFindings = 累计 lint 发现数（每次校验/patch 合并反馈都累计，同一稿多轮重复出现会重复计数）；droppedAttempts = 被丢弃 attempt（draft/final 校验未通过 + patch 被拒 + 协议错误轮）；totalAttempts = draft/final/patch 命令轮 + 协议错误轮（request_modules 轮不算 attempt）；cardFaceFixed = 循环内早前 draft/patch lint 出现过、最终采纳稿的 lint 未再出现的 card-face 键（kind\|path\|message）去重计数——「LLM 主动修正卡面数值错误」的探针；无最终采纳稿（failed）时按全部 seen 计 |
| `reasoningOnly` | `{ total, salvaged, failed }`：content 为空（仅思考链，如烧穿 maxTokens）的轮次统计——salvaged = 从思考链提取出有效 JSON 并当作输出，failed = 无有效 JSON 按协议错误处理；benchmark 质量探针 |
| `protocolErrors` | 协议错误次数（非 JSON / 未知 action） |
| `salvaged` | 被抢救的协议错误数（漏 action 包装但产物完整，按 draft/patch 受理） |
| `moduleRequests` | `{ total, perKind, log[] }` 钻取模块请求计数 |
| `tokens` | `{ prompt, completion, reasoning, available }` 用量累计 |
| `wallMs` / `error` | 墙钟与失败说明 |

### 7.2 transcript（`*.transcript.jsonl`）

逐轮 `HarnessTurnRecord{ turn, raw, command, feedback, usage?, latencyMs }`。**校验反馈全文在这里**：draft/final 校验未通过的问题列表（≤20 条）、patch 拒绝原因、模块内容、静态回放核验报告。

### 7.3 计数不对称（解读 sidecar 时注意）

- ~~patch **被拒绝**、draft **校验未通过**没有专门计数器~~ **（2026-09-05 P0-4 已关闭）**：现在逐条进 `rejected[]`，次数进 `counters.droppedAttempts`/`totalAttempts`；**2026-09-05 前的旧 harness.json** 仍只有成功合并的 `patches`，解读旧产物时注意。
- ~~校验错误类别无直方图~~ **（2026-09-05 P0-4 已关闭）**：draft 路径的 issues 经 `classifyIssueText` 机械分类进 `issueHistogram`（deadRule/closedSet/format）；patch 拒绝统一计 `patchRejected` 不再细分。分类是正则启发式，边界 issue 可能落入 format，机读时以 `rejected[].detail` 原文为准。
- 非 harness 单发路径（`--turns 1`）完全不产 harness.json/transcript，attempt 日志仅 stdout（口径不变）。

## 8. patch 静态回放核验（plan-replay.ts）

对上轮 trace 的历史决策点（stateSignature 语料）静态重放修订后规则链，产出：

- **命中矩阵 diff**：fallback 率 base→next、hits 变动规则（前 12）、命中迁移样例（≤8）；
- **逐 op 反事实断言**：`{ opIndex, op, ruleRef, targetPoints, stillMatched, nowFallback, status, note }`，status 判定——
  - `no-target`：该规则无关联 blunder 点；
  - `ineffective`：patch 后全部目标点仍由该规则首条命中（when 命中面未变）；
  - `fixed`：目标点全部脱离该规则且未转入 fallback；
  - `partial`：其余（含部分点转入 fallback——note 会提示"覆盖洞，建议补接管规则"）。

**已知局限（口径级，审阅断言必读）**：静态回放只求值 when（then 匹配需引擎运行时动作列表），`actionsTakenThisTurn` 无 trace 记录按 0 求值 → 命中矩阵是**覆盖上界**；**thenMiss 类修订（修 then 映射）在断言里恒 ineffective/no-target**，必须靠对局复验或消融臂。

**断言不阻断**：finalGate 只要求 planId/portfolioId 有变化即放行，核验报告仅作为文本进 finalGate report / transcript。

**逐 op 断言落盘（2026-09-05 P0-3）**：patch 合并处的静态回放核验（逐 op 断言 + fallback 率 base→next）除 transcript 文本外同时结构化落盘——legacy 单树 `<out>.replay-report.json`，portfolio 模式 `<out目录>/reflect.replay-report.<tag>.json`（tag 带 r<N>，每代一份，失败路径同样落盘）。schema（`cli/replay-report.ts`）：`{ basePlanId, portfolioId?, patches: [{ patchIndex, opsCount, assertions: PatchAssertion[], fallbackRate: { base, next }, groups? }], totalAppliedOps }`；PlanReplayResult 的 perRule/fallbackPoints 明细不进该产物（需要时从 run 目录 trace 重算）。

**patch 覆盖确认闸（2026-09 修复）**：patch 后再提交全量 draft/final 时，check 闸要求产物顶层带 `"overwritePatches": true` 显式确认（否则打回一次并提示改用 patch 继续修订）；确认采纳后 `appliedPatchOps` 归零（与产出口径一致）。裸 patch final（无产物、以累计 patch 为产出）不经此闸。此前"`patches>0` 不代表产出含 patch 内容"的静默覆盖风险已消除。

## 9. 消融判定（engine-only，`ablation-report.json`）

判据纯函数 `judgeEngineOnly`（ablate-criteria.ts），全部输入来自批跑 summary（不读 eval）：

| 判据 | 条件 | 结果 |
|---|---|---|
| 混淆闸 | 臂 coverage 降幅 **或** fallback 率涨幅 > coverageTol（默认 5pp） | 一律 `inconclusive`（效应无法与覆盖崩坏区分） |
| thenMiss 归零（主判据） | verdict=revise 且基线 thenMiss>0 | 归零 → `supported`；部分下降 → `inconclusive`；未降/反升 → `refuted` |
| 同种子反事实判据（数值修订） | verdict=revise 且 `then.damage_min`/`then.kills` 或 when 骰子闸（`dice.total`、`dice.<e>`、`dice.<e>+omni`）/HP 闸（`self/opponent.active.hp`、`self/opponent.characters.<defId>.hp`）数值变化 | 配对 seeds<20 **或**覆盖劣化 → `inconclusive`；否则每局平均命中数差（arm−base，次/局）超 ±minEffect → `supported`/`refuted`，否则 `inconclusive` |
| 胜率区间 | 其余（remove 恒走；revise 无配对指标） | N≥20 才生效；臂−基线超 ±minEffect（默认 3pp）才下方向性结论，否则 `inconclusive` |
| 死规则迹象 | 臂 thenMiss 比基线**新增** | 不改 verdict，note 附"${ruleRef} 出现死规则迹象" |

同种子反事实判据的配对数据来自逐局 trace（条目 `matchedRule` + `entry.phaseId` 拼键，与 `perRuleHits` 同口径；提取在 `ablate-numeric.ts`）：臂批跑沿用基线 `seedBase`，base/arm 同 seed 的局逐局配对取被修订规则的命中数（`{ seeds, baseHits, armHits }` 落 `ablation-report.json` 的 `arms[].numericPaired`）。thenMiss 归零仍是主判据（基线 thenMiss>0 时先判）；配对指标不可用（旧产物缺 `perGame`、trace 缺逐条目规则身份、配对局两侧零命中）时回落胜率区间，note 注明原因。

## 10. 已知计数偏差（审阅数据时必读）

1. **chooseActive 单候选不再计 fallback**（2026-09 修复）：单候选记 `noDecisionSpace`（`fallbackUsed=false`、无 fallbackPolicy），兜底率不再被无决策空间条目抬高；**修复前的旧 trace 数据仍含这类条目**，跨代对比旧数据时注意口径断层。
2. **全方法 vs action-only 口径**（§2）：batch summary 的 fallbackRate 分母含 opening 类决策点；反思期 fullDigest/declareEnd 占比只算 action。跨文件对比时先对齐口径。
3. **静态回放覆盖上界**（§8）：thenMiss 类断言恒 ineffective/no-target 属预期，非 bug。
4. **threat 打包降级**（§3.4）：生产构建下上界字段可能静默变 undefined，此时"零威胁"不可信，burstReady/burstP 仍可用。
5. **patch/draft 覆盖已由确认闸消除**（2026-09 修复，§8）：全量稿覆盖累计 patch 需 `overwritePatches: true`，采纳后 patch 计数归零；但**修复前的旧 run** 仍可能出现 `patches>0` 而产出不含 patch 内容，解读旧 harness.json 时注意。
6. **author repair 默认值已对齐**（2026-09 修复）：注释与代码均为默认 2（≤3 次尝试）；`--no-thinking` 可关闭思考（默认开）。
7. **空计划闸的语义**：0 规则不是"空树合法"而是硬错误（修复环节曾出现 LLM 连续失败后吐空壳通过校验）。
8. **fallback 推荐口径收窄**（2026-09）：author prompt 与 patch 协议改为二选一（conservative / declare_end，不再推荐 baseline——它遮蔽规则缺口）；但 `validate`/`plan-patch` 仍接受 baseline（旧计划兼容），统计上无法区分"旧计划声明"与"新起草误用"。
9. **卡面校核不查动态伤害**（2026-09-08）：`.do()` 闭包/条件 `increaseDamage`/非字面量参数产生的伤害与治疗一律标 `dynamic` 跳过——这类卡面的 `then.damage_min` 数值错误不会被第 4 类 lint 或 `# Card-face checks` 段暴露（仍需 LLM 侧核对）；反应加成算术与效果语义同样不在 v1 范围。
10. **卡面校核的费用闸是启发式**（2026-09-08）：闸值**低于**卡面费用 = 骰面刚好满足闸值时动作无法执行（thenMiss 风险，强信号但非"死规则"证明——闸值可被更高骰面满足）；闸值**高于**费用即报"可疑"（哪怕只多 1 个：可能记错，也可能是为后续动作预留骰子），解读时以 `message` 的措辞区分，勿把 over 类 finding 当作确定错误。`dice.<e>`（不含 omni）与 `dice.omni` 单元素闸不参与比较（避免把"最低保障"误判为费用断言）。
11. **卡面校核数据源边界**（2026-09-08，同日去资产化）：真值唯一来源 = `card-face-table` 对 `packages/data/src` 的本地静态扫描（零网络）。已知边界：源码无 `.costXxx` 调用的条目（秘传牌只有秘传费、`.reserve()` 预留卡、prepared/特殊技能）与 0 费卡（料理生成牌、元素共鸣）费用腿静默跳过——秘传费不占骰、预留卡无实装，实测与旧资产口径一致（180 个空费用条目中仅 11 个秘传牌在资产侧有费，且均为不占骰的秘传费）；`card_def_id`/角色不在任一侧牌表、技能类型无法解析时同样静默跳过（存在性归 validate，lint 不重复报）；`then.skill_def_id` 另做存在性校核（必须属于己方任一角色的技能，需 ctx.deck，缺失时跳过）。`ctx.assets`/`ctx.data` 字段已删除。
12. **同种子反事实判据的盲区**（2026-09-08）：配对命中数取自逐局 trace 的逐条目规则身份（`matchedRule` + `phaseId` 拼键，与 `perRuleHits` 同口径）——旧格式/脱敏 trace 缺该身份、或配对局两侧该规则全零命中时判据降级为"不可用"并回落胜率区间（note 注明原因），此时数值修订仍可能被胜率区间的噪声吞掉。此外该判据只看得见**被修订规则自身**的命中变化：修订若把动作路由给了别的规则（命中转移、总量不变），配对差值≈0 → `inconclusive`；效应落在规则之外（改的是别的规则的行为、或经反应/装备间接生效）同理不可见，须结合胜率区间与 thenMiss 旁证解读。

## 11. 现状缺口（供后续规划；2026-09-05 WP2 部分关闭）

- ~~**engine-only 机械指标无跨代聚合与作图**~~ **（2026-09-05 P3-1 部分关闭）**：聚合脚本 `scripts/ops/aggregate-generations.ts <各代run根目录…> --out <trend.json>` 已落地（机械层：五指标 thenMiss/coverage/fallback/winRate/avgRounds + issueHistogram + counters → trend.json + trend.md，只读无 LLM）；**作图与 declareEnds/零命中规则数的代际趋势仍未做**；`scripts/analysis/nn-valuediff/` 的代际图仍只覆盖 NN oracle 口径。
- ~~**校验期计数无持久化**~~ **（2026-09-05 P0-4 已关闭，harness 路径）**：见 §6/§7.1；one-shot 路径（`--turns 1`）与旧产物维持不持久化口径。
- **图产物不在仓库**：`output/plan-oneshot/**` 未跟踪，README 表格快照是唯一留档；`plot-selfevo-summary.py` 数值为内联硬编码（代际重跑后需手动同步）。
- **`game_state_log.e` 的消费方未落地**（P0-1 已写入，2026-09-05）：精确回放/证据导出器（WP4 organizer，P1-1）尚未实现，`e` 先落盘备料；旧 run 的 `e` 恒空数组，跨代消费时按整合稿 §3-6 做兼容分支。

补齐剩余缺口的自然做法：聚合脚本（已就绪）之上加 matplotlib 作图层（WP3）；organizer 导出器读 `e` 做抽牌序列差分与执行证据（WP4）；每代聚合挂接 `scripts/ops/portfolio-generation.ts`（P3-2）。
