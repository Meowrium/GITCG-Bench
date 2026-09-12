# Agentic Plan Harness：one-shot 起草/反思 → 有界 agent 循环

> 日期：2026-08-28。状态：**已实现**（agent-loop / modules / 双 CLI 接入 + 16 项新测试全绿）。
> 上游文档：`2026-08-21-one-shot-gameplan-benchmark.md`（one-shot 基线，本文不改动其实验语义）。
> 需求确认：首轮提示词**全量保留**（round19 证实的注入收益不回退）+ 按需追加模块；纯文本 JSON 协议（不用原生 function calling，通道兼容性未验证）；**起草期禁止试跑仿真**（author 侧模块只含静态知识）；author 与 reflect 两侧同构 agentic 化。

---

## 1. 动机与边界

one-shot 模式下 LLM 只有一次响应机会：看不到自己的上一稿（修复循环是整体重发）、无法核实记忆外的卡、reflect 侧只能消费预消化证据（原文自由读取在原设计 §6 就留作 agentic 升级项）。本 harness 把"生成、迭代"扩展为有界多轮：

- LLM 首轮收到与 one-shot **完全相同**的提示词；
- 此后每轮输出一个 JSON 命令：索取模块 / 提交草稿校验 / 定稿；
- 轮次有上限（`--turns N`），全程模块量有预算（`--module-budget`），**模块索取次数与轮次作为效率指标落盘**。

**对照纪律**：`--turns 1`（默认）= 原 one-shot 路径一字不改，继续充当对照臂。harness 产出的计划文件仍是纯 GamePlanV1（schema 零变更），批跑 / oracle 回算 / 消融管线不受影响；识别 harness 产物靠 sidecar 文件（`<plan>.harness.json`）。

## 2. 组件

### 2.1 `cli/agent-loop.ts` — 通用有界循环驱动器

与 author/reflect 解耦的骨架：维护对话历史（模型看得到自己每一稿）、解析命令、执行预算闸、聚合统计。不写文件（sidecar 由 CLI 落盘），`responder` 可注入 mock 供离线测试。

每轮一个 JSON 命令：

| 命令 | 载荷 | harness 行为 |
|---|---|---|
| `{"action":"request_modules","requests":[{"kind","id"?}],"reason"}` | 模块请求 | 单轮限 `--per-turn-modules`（默认 4）、全程限 `--module-budget`（默认 12），截断有显式提示；模块内容作 user 消息回注 |
| `{"action":"draft","plan"/"result":{...}}` | 草稿 | 跑完整校验管线（normalize→auto-repair→validate），回注 issue 列表或"通过+形态统计"；**通过的 draft 记录为回退候选** |
| `{"action":"final",...}` | 定稿 | 同一校验；通过即终止，不通过回注 issue 继续 |

终止：final 通过 → `final`；轮次耗尽但有通过校验的 draft → `turn_cap_draft`（采用最后一稿，`adoptedDraftTurn` 记录轮次）；否则 `failed`。seed 逐轮 `seed+turnIndex`（沿用变 seed 纪律）。协议错误（非 JSON / 未知 action / 缺载荷）计 `protocolErrors` 并回注格式提示，不额外套 repair。

### 2.2 `cli/modules.ts` — 模块注册表（封闭集合）

共享（author+reflect）：

| kind | id | 内容 |
|---|---|---|
| `fewshot_plan` | — | `prompts/examples/fewshot-plan.json`（round13-m3 红牛 r0，26 规则 2 阶段，r0 blunder 23.3% 当轮最佳）；头部标注"别的卡组，严禁照抄 defId" |
| `field_reference` | — | `prompts/field-reference.md`：when 字段逐字段手册（类型/语义/示例/常见死规则） |
| `card_detail` | 卡牌 defId | 全卡库官方效果/费用/标签（核记忆、降幻觉；校验器仍只放行牌表内 id） |
| `character_detail` | 角色 defId | 角色技能全文 |
| `character_profile` | 角色 defId | `knowledge/character-skill-profiles` 的战技收益画像（summon/selfStatus/openingPriority） |

reflect 专属（数据源 = run 目录 trace/eval 产物）：

| kind | id | 内容 |
|---|---|---|
| `decision_detail` | `game-N:seq` | 该决策点 trace 条目原文 + oracle 回算原文 + 相邻决策点 |
| `rule_drilldown` | ruleRef | 该规则全部命中点逐条（局面+选择+oracle 对照 ✗/~/✓），含 thenMiss 死规则记录 |
| `fallback_detail` | — | 全部 fallback 决策点完整列表 |
| `game_summary` | 局目录名 | 该局结果/回合/覆盖 + 逐决策点摘要 |

每个模块内容硬上限 `MAX_MODULE_CHARS=4000`（截断有标注）；未知 kind/id 返回错误文案块（不抛异常，模型可自行修正请求）。

### 2.3 提示词

- `prompts/harness-protocol-author.md` / `harness-protocol-reflect.md`：协议章节，含 `{{MAX_TURNS}}/{{MODULE_BUDGET}}/{{PER_TURN_MODULES}}` 占位。
- `cli/plan-prompts.ts` 新增 `buildAuthorSystemPrompt(agentic, protocol)` / `buildReflectSystemPrompt(...)`：`agentic=false` 时**逐字节同现有常量**（one-shot 对照纯度），`true` 时尾部拼接协议章节。

### 2.4 CLI 接入

- `plan:author` / `plan:reflect` 新增 `--turns N`（默认 1）/ `--module-budget` / `--per-turn-modules`。
- 产物 sidecar：`<out>.harness.json`（效率统计）+ `<out>.transcript.jsonl`（逐轮原文与回注）。
- reflect agentic 附加**劝告性** ruleRef 封闭集合检查（verdict 引用不存在于原计划的 ruleRef 时警告但**不阻断**——验收口径与 one-shot 保持一致，避免双臂语义分裂）。
- `--anchor` 与 harness 正交：锚点阶段仍单次调用，主循环注入锚点。

### 2.5 效率统计（`.harness.json`）

```json
{
  "label": "author", "model": "...", "turns": 5,
  "terminatedBy": "final | turn_cap_draft | failed", "adoptedDraftTurn": 3,
  "moduleRequests": { "total": 7, "perKind": {"card_detail": 3},
    "log": [{"turn": 2, "kind": "card_detail", "id": 311301, "reason": "..."}] },
  "drafts": 2, "finalAttempts": 1, "protocolErrors": 0,
  "tokens": { "prompt": 0, "completion": 0, "reasoning": 0, "available": true },
  "wallMs": 0
}
```

模块请求 log 同时是"LLM 信息需求画像"的行为数据（哪类模块被索取、在第几轮、理由是什么）——这是 harness 相对 one-shot 的增量观测维度。token 统计依赖网关返回 usage（非流式恒有；流式只在网关于末块给 usage 时记录，`available` 标记）。

## 3. 测试与验收

- `cli/agent-loop.test.ts`（7 项，mock responder 全离线）：全流程（模块→draft→final）、轮次耗尽回退、协议错误恢复、单轮/全程预算闸、failed 路径、responder 抛错、reasoning 兜底提取。
- `cli/modules.test.ts`（9 项，临时 fixture run 目录）：模块清单分模式、fewshot/field_reference 离线可读、未知 kind/非法 id、四个 reflect 模块的内容正确性、4000 字符截断。
- 全包 `pnpm test`：266 通过 / 2 失败（审计文档已载的预存环境性失败，与本改动无关）；plan-oneshot 目录 29/29。
- `tsc --noEmit` 无新增错误（预存 TS18048 console 噪音除外）。
- `pnpm run plan:validate examples/plans/example-plan.json` 通过（dist 解析口径；`NODE_ENV=development` 下 core 源码 `mixins` 加载崩溃为预存问题，与本改动无关）。
- 真实通道 agentic 冒烟（`--turns 3` author/reflect 各一）留待实验执行时进行。

## 6. 首轮实战冒烟（2026-08-28，GLM-5.3-Flash @ 智谱直连，红牛 known_deck vs 雷鹤，seed 20260829）

> scnet 网关的 `GLM-5.3-Flash` 对本 key 403（Token Plan 不含，同 round19-dsv4 的 DSv4-0813 情况）；经用户提供的智谱 key 内联环境变量直连（不入库）。

- **harness 行为**：turns=3/6、modules=2/12（fewshot_plan + field_reference，理由针对 target 写法/布尔与 $引用/阶段组织三处语义）、drafts=1、finalAttempts=1、protocolErrors=0；91.8k completion tokens（78k 推理），wall 29.5min。模型按设计路径使用循环：先索资料 → draft → final。产物 `output/plan-oneshot/round23-harness/plans/hongniu.agentic.r0.json`（38 规则/1 阶段/7 opening，34 条带骰子条件、5 条 kills、14 处 $引用，planId `6d45d4a589ba`）。
- **头对头**（vs round22 g53f 红牛 ctrl r0 一次性计划，同模型同 seed 口径，10 局 alternateFirstPlayer，fresh seeds 20274101..10）：agentic **1:9** 负；coverage 98.0% vs 99.6%，fallback 1.8% vs 0.4%。
- **ISMCTS oracle（dets=8/sims=64/500ms，双侧各 ~330 决策点，0 对齐失败）**：agentic blunderRate **33.6%** vs one-shot **37.0%**（−3.4pp）——决策点质量略优但输掉对局，是"blunder 低≠赢"（round9/round19-dsv4 同类）的又一实例；N=10 比分噪声按既有纪律不做结论，blunder 差值在 oracle 噪声量级边缘，需多轮复验。
- 预测校准：预测 winRate 0.4 / rounds 8；实际 0.1 / 8.7（回合数准、胜率偏乐观，known_deck 起草不知对手是同模型一次性计划）。
- **NN oracle 回算（2026-08-28 追加，标准口径，双侧）**：agentic side0 339 点 / blunder **66.4%** / meanValueDelta −0.157（≈−7.8pp 胜率每行动，crash 145/319）；ctrl side1 324 点 / **50.3%** / −0.165（crash 118/267）。NN 口径下两侧排序与 ISMCTS 口径**相反**（后者 agentic 略优）——再次印证两口径不可比与"blunder 差值不做结论"纪律；NN 绝对错手率整体偏高与 round19 一致（对规则型政策评分更严）。已知降质：桥接词表钉死 v6.3.0，本对局 311305/332013 等卡牌报 blank_action_card（DummyCard 编码），这些点上 oracle 质量受限。产物 `plan_eval.nn[.side1].json` 与 ISMCTS 口径并存于 games 目录。
- **agentic reflect r0→r1（2026-08-28，GLM-5.3-Flash @ 智谱直连，`--eval-suffix nn` 证据，--stream --max-tokens 65536，seed 20260828）**：实际 turns=4 / terminatedBy=final，modules=4（3×decision_detail + 1×rule_drilldown，首轮四点式索取理由：最大 blunder game-0010:seq44 gap=13.87、oracle 反复推荐 switchActive→迪希雅的模式证据、global:40 的 35 次 thenMiss）、drafts=1、protocolErrors=1（已恢复）；token 261.5k prompt / 162.3k completion（124.3k 推理），wall 51.4min。修订计划 `plans/hongniu.agentic.r1.json`（planId `c0dc155eba9f`，parent `6d45d4a589ba`，38→54 规则，verdicts 41 = 18 keep / 17 revise / 6 remove）。反思核心（可证伪）：预测校准失败归因四根因——①对手画像错位（押注冰雷爆发，实战岩镜像，防御包 global:10/5/6/7 全 blunder）；②技能规则只查 dice.total 不查元素构成，岩骰不足时整链 thenMiss（global:39/40/41 合计 90 次）落入 declareEnd；③无主动轮转（oracle 反复推荐切迪希雅：火伤绕开护体岩铠）；④缺治疗/装备抢占动作。据此 r1 新增主动轮转迪希雅等 30+ 条规则。
- 工程注记：① 批跑配置相对路径按 cwd（packages/gi-agent）解析，产物目录沿用仓库根 `output/plan-oneshot/` 约定；② `harness.json` 的 model 字段已修正为记录实际生效模型（env 兜底的模型名此前落为 "(env default)"）；③ reflect CLI 补 `--stream`（SSE 防网关 300s 流超时）/ `--max-tokens`（默认 32768，GLM 长推理建议调大）；④ `llm.ts` 单调用超时默认 20min 改为 `LLM_TIMEOUT_MS` 可覆盖——GLM 首轮 381 点证据包 >20min 必超时（实测触发"流式读取失败"8 次重试空转），本轮用 3600000（60min）跑通；⑤ 本机环境坑：pnpm sh shim（corepack 路径拼接损坏）不可用 → 用 `pnpm.cmd`；`cmd set` 设置的环境变量传不到 node 子进程 → 内联凭据一律用 bash env 前缀传递。

## 4. 已识别但未实施的改进方向（按预期收益排序）

1. **fallback 档质量是最大失误桶**（round6 起占比 20%+、blunder 23.9–43%）：值得独立消融（baseline vs conservative vs declare_end 档），或在 reflect 模块中把 fallback_detail 设为默认注入。
2. **校验器 warning 级闸**：无"恒真非 declareEnd 兜底规则"（round4 遗留，目前靠提示词纪律）、规则数 15–40 区间提示（round19 GLM 60 条超界无人拦）、修订前后 coverage 静态下限。
3. **lethal 探针**（原设计 M3 遗留）：`preview.causeDefeated` 近似实现 lethalMissRate。
4. **"改没了"式修订的独立度量**（条件收紧致零命中）：perRuleThenMiss 数据已在，缺聚合脚本。
5. **起草期试跑**：用户已明确禁止；若未来放开，作为独立臂（dry-run 反馈会模糊"赛前纯规划"边界）。
6. DS-Flash 长推理发散（round20 失败机制）在 harness 下天然缓解（每轮输出小）——可在重试 DS-Flash 时对比 `--turns 1` vs `--turns 6` 的起草成功率。

## 5. 口径纪律汇总

- one-shot（`--turns 1`）行为与产物逐字节不变，继续作对照臂。
- 错手判定统一用 NN oracle（`plan:eval --oracle nn`，产物 `plan_eval.nn[.side1].json`；reflect 经 `--eval-suffix nn` 读证据）；ISMCTS 为旧口径仅作历史轮次复现。
- harness 产物计划 = 纯 GamePlanV1；`planId` 内容哈希不含 harness 元数据（统计全在 sidecar），同内容计划跨模式同 id，谱系对照不受污染。
- 跨模式比较计划质量时，harness 开关本身是混杂因素（同 round2 的推理开关教训）——报告必须标注 turns/module 用量（sidecar 已落盘）。

## 7. patch 修订模式 + 静态回放核验（2026-08-30 实装）

> 动机（round25-qw38 迭代动力学分析）：全量重写式反思每轮仅保留 6–22/37–40 条规则（r0→r1 仅 6 条），上轮已验证规则被连带破坏（r4→r5 blunder 38.9%→49.1% 回弹）；且规则链按 priority 全局匹配，"局部修订"实际是全局扰动而模型无法静态推演。本轮把修订表达从"重写整棵树"收窄为"受限 ops + 服务端合并 + 合并后静态核验"。

### 7.1 组件

| 组件 | 位置 | 内容 |
|---|---|---|
| patch 协议 | `src/runtime/plan-oneshot/plan-patch.ts` | op 封闭集合：`revise`（缺省字段沿用原值、priority 不变）/`remove`/`add`（position="start"/"end"/{before}/{after}，半分 priority 插入**不重排**既有规则）/`set_fallback`；`parsePlanPatchCommand` 结构校验（未知键整批拒绝——op 表达不了的意图必须显式失败而非静默丢弃）；`applyPlanPatch` 全或无合并：ruleRef 封闭集（当前树中必须存在）、同命令重复操作拒绝、顺序语义（后面的 op 看到前面 op 的结果）；合成 verdicts（`source:"patch"`，add → `add:<scope>:<priority>` ref）进 reflection.json 审计链 |
| 静态回放器 | `src/runtime/plan-oneshot/plan-replay.ts` | 语料 = 本侧 trace 的历史决策点（stateSignature 反序列化，**授权边界：`sideFileNames` 单一事实源，只读本侧 plan_trace[.side1]/plan_eval*.json，对手侧文件一律不读**）；`replayPlan` 首条命中矩阵（perRule hits + **被遮蔽计数** + fallback 点）；`verifyPatchAssertions` 逐 op 反事实断言（该规则的 blunder 点在 patch 后是否仍由它命中/转入 fallback，status: fixed/partial/ineffective/no-target——revise 只修 then 映射时静态回放无法确认，note 中明示）；`formatPatchVerification` 合并反馈文本 |
| 链级 lint | `src/runtime/plan-oneshot/fields-lint.ts` | 无假阳性保守检查：条件包含（早位规则遮蔽晚位——后者仅 thenMiss 后可达）、同链 when 完全重复、单规则内同字段矛盾（== 互斥/数值空区间）。finding 级 warnings，不阻断校验；draft/patch 反馈均携带 |
| 循环驱动 | `cli/agent-loop.ts` | ①`patch` 命令（`applyPatch` 回调；未启用时报协议错误）；②**协议错误抢救（salvage）**：漏 action 包装但带 result/plan 键、顶层 GamePlanV1/ReflectPlanResultV1、顶层 ops 数组三类形态自动按 draft/patch 受理（round25-r2 实测 34k reasoning 因协议错误整体丢弃的对策），`stats.salvaged` 计数；③`finalGate` 收尾核验（patch 模式：回放 diff + 断言汇总，合并计划与原计划一致时打回；前 2 次 final 未过打回、第 3 次强制放行防死循环），`stats.gatedFinals` 计数 |
| 模块 | `cli/modules.ts` | reflect 专属 `plan_simulate`（无需 id）：当前工作计划的静态回放矩阵 + 与原计划的 diff（fallback 率变化/命中面变化/迁移样例）——修订前先看扰动范围 |
| 提示词 | `prompts/harness-patch-reflect.md` | patch 协议章节（op 表/位置语义/授权边界/最小改动纪律"keep 是默认"），`--patch` 时经 `buildReflectSystemPrompt(agentic, protocol, patch)` 追加；harness-protocol-reflect.md 模块表补 plan_simulate 行 |

### 7.2 授权边界（硬约束清单）

1. ops 是纯数据、不含文件路径；`context`/`author`/`planId`/`parentPlanId`/`createdAt`/`opening` 不在 op 可表达范围内，未知键整批拒绝；合并收尾时 `finalizeMerged` 再强制接管 `context`/谱系字段（纵深防御）。
2. patch 仅作用于**本轮 plan:reflect --plan 指定决策树**（plan.side<N>.json 的后代）；模型永不重发完整树。
3. 回放/断言语料只读本侧文件（side 参数决定文件名后缀）；stateSignature 本身是 exposeState 脱敏后的玩家视角 state，不含对手手牌/骰面。
4. 静态回放只求值 when（then 候选匹配需引擎运行时），命中矩阵为覆盖上界；`actionsTakenThisTurn` 在 trace 无记录、按 0 求值（引用该字段的规则读数偏保守）——两点均写入模块内容与代码注记。

### 7.3 行为要点

- patch 模式经 `--patch` 显式开启（默认关，对照臂纯度）；可与全量 draft 混用（draft 采纳后 patch 基于该稿继续，verdicts 接管）。
- 裸 final（不带 result）= 以累计 patch 为产出；`predictionPostmortem`/`predictions` 缺失会被打回（随任一 patch 或完整稿提供）。
- 轮次耗尽（含 turn_cap 回退到旧 draft 的情形）但已有累计 patch → 以当前合并结果兜底产出。
- 每个 patch 的回注 = 合并形态 + auto-repair 死规则清单 + **静态回放核验**（fallback 率 before→after、命中面变化 top12、迁移样例、逐 op 断言、lint findings）——"局部修订=全局扰动"由此从不可推演变为每次可见。

### 7.4 测试与验收

- `plan-patch.test.ts`（9 项）：解析封闭集（未知 op/未知键含 context 注入/缺 reason）、revise 缺省沿用+原计划不可变、全局与阶段 remove、add 四种位置语义与不重排、set_fallback、封闭集整批拒绝、顺序语义。
- `plan-replay.test.ts`（4 项）：side0/side1 语料互不污染（授权边界）、命中矩阵（hits/shadowed/fallback）、revise 收紧后的 diff+断言（partial）、remove 后转入 fallback 标注；lint（遮蔽/重复/矛盾）。
- `agent-loop.test.ts` 增 5 项：patch 合并/拒绝/裸 final、patch 未启用协议错误、salvage（result 形态 + ops 形态）、finalGate 打回与强制放行。
- plan-oneshot 全套 61/61 通过；全包 298 通过 / 2 失败（`cli-config.test.ts` 预存环境性失败，与本改动无关）；tsc 无新增错误（仅预存 TS18048 console 噪音）。

### 7.5 后续实验（未跑）

patch 双臂对照（全量重写式 vs patch 式，同 seeds 同证据）：检验"修订从重写变为受限增补后 churn 下降是否兑换成迭代曲线单调性与更低平台期"——即 round25 分析提出的 H5（迭代动力学）假设的实证。报告须标注 harness sidecar（patch 模式是新的混杂因素，同 turns/推理开关教训）。

## 8. patch 模式五轮实战（2026-08-30，round26-glmpatch 控制变量链）

**设置**：作者模型 = 反思器模型 = GLM-5.3-Flash（智谱直连，key 内联不入库）。起点 r0 = round23-harness `hongniu.agentic.r0.json`（GLM agentic harness 产物，38 规则，context 保留其历史对手错位——known_deck 雷鹤声明对红牛实际对手，批跑加 `--allow-opponent-mismatch`，产物字节不变）。对手 = round22-g53f `hongniu.ctrl.r0.json`（与 r0 基线同对手），seeds 20274101-10 与 r0 基线同种子。每轮：reflect（`--turns 6 --patch --eval-suffix nn --thinking --stream --max-tokens 98304`，seed 2026086x 变 seed）→ batch 10 局 → 双侧 NN 回算。重写式对照点 = round23 反思产物 r1（54 规则，同一 r0 证据、同对手同种子，本轮补跑对局与回算）。产物 `output/plan-oneshot/round26-glmpatch/`（plans + games + chain.log）；聚合器 `.tmp/aggregate-round26.cjs`。

| 轮 | 比分 | blunder | meanVd | 覆盖/fb | 规则 | 保留率 | patches | wall |
|---|---|---|---|---|---|---|---|---|
| r0（agentic 基线） | 1:9 | 66.4% | −0.157 | 98.0/1.8 | 38 | — | — | — |
| r1（重写式，同证据） | 7:3 | 65.0% | −0.186 | 99.1/0.8 | 54 | 6/38 | — | — |
| p1 | 7:3 | 53.8% | −0.134 | 99.4/0.6 | 41 | 28/40 | 3 | 55 |
| p2 | 7:3 | 47.3% | −0.153 | 99.2/0.8 | 42 | 35/43 | 2 | 75 |
| p3 | 8:2 | 42.8% | −0.175 | 98.6/1.5 | 45 | 36/44 | 4 | 66 |
| p4 | 8:2 | 43.8% | −0.152 | 98.8/1.2 | 49 | 36/47 | 3 | 80 |
| p5 | 9:1 | 43.6% | −0.151 | 99.2/0.8 | 51 | 43/51 | 2 | 92 |

ctrl 侧（同对局）：p1 65.5%/−0.165 → p2 71.6%/−0.212 → p3 70.7%/−0.223 → p4 71.1%/−0.197 → p5 70.9%/−0.202（对手分布随计划强度漂移，只做同对局相对比较）。patch 相对 ctrl 的错手优势 −11.7pp → −24.3 → −27.9 → −27.3 → −27.3，价值优势 +0.031 → +0.059 → +0.048 → +0.045 → +0.051——两项优势同步扩大后企稳。

**发现**：

1. **迭代曲线单调、无回弹**：blunder 66.4 → 53.8 → 47.3 → 42.8 → 43.8 → 43.6（3 轮后进入 42–44% 平台）；比分 1:9 → 7:3 → 7:3 → 8:2 → 8:2 → 9:1 同向兑现。对照 round25-qw38 重写式链的 r4→r5 回弹（38.9→49.1）与本链 p3→p5 的平稳（−1pp/+0.2pp），H5（重写式修订破坏已验证规则）假设获正向证据。
2. **同证据同 seeds 的重写式/patch 式对照（第 1 轮）**：重写式 r1 以 54 规则（仅保留 6/38）达到 7:3 但 blunder 65.0%/meanVd −0.186；patch p1 以 41 规则（保留 28/40）同达 7:3 且 blunder 53.8%/meanVd −0.134——**patch 臂用更小的树与更低的逐点损失拿到同样的比分**，且后续 4 轮继续把 blunder 压到 43% 档。
3. **最小改动纪律被模型遵守**：保留率 70% → 81% → 82% → 77% → 84% 逐轮上行；规则数 38 → 51 缓慢生长（add 半分插入语义支持增量式扩写，未再现 round19 的 60 条超界失控）。
4. **harness 行为统计**：5 轮 14 条 patch 命令全部合并成功、0 protocolErrors、0 salvage 触发（GLM 未漏 action 包装）、0 gatedFinals 打回（每轮 final 一次通过，即无"空修订"轮）、modules 按需索取 0–10 个。裸 final（累计 patch 为产出）5/5 轮使用。
5. **成本**：单轮 reflect 55–92 min（GLM thinking），批跑 <1 min，双侧回算 ~12 min；5 轮合计 ~6.2h。
6. **p3→p4 的 meanVd 波动**（−0.175 → −0.152）：p3 新增规则带来时机类分歧，p4 修订回收——patch 模式下这类自修复在 1 轮内完成，与"局部修订=全局扰动可见化"的设计目标一致。

**口径警示**：单一卡组（红牛镜像）、N=10/轮比分噪声大（读数以 blunder/valueDelta 同向互证为准）、单一模型（GLM-5.3-Flash）——结论外推到其他模型/卡组需复链。platform 期（42–44%）与 round23 GLM 链（35–40%，ISMCTS 口径不可比）同为"偏好类分歧地板"的表现形式。

### 8.1 可视化产物（2026-08-30，`output/plan-oneshot/round26-glmpatch/nn-valuediff/`）

程序：`packages/gi-agent/scripts/analysis/nn-valuediff/export-trajectories-round26.py`（trajectories.csv，4724 行 / 7 组，schema 与 glm-vs-qwen 同）与 `plot-round26-glmpatch.py`（绘图 venv `.tmp/plot-venv`，用法见 scripts/README.md）。

| 图 | 内容与读图结论 |
|---|---|
| `process-metrics-by-round.png` | **迭代动力学主图**。上：plan 侧 blunder 66.4→53.8→47.3→42.8→43.8→43.6 单调下降后企稳（p3 起平台），ctrl 侧同对局漂移至 71% 档（对手分布随计划强度变弱，只做同对局相对读数）；重写式 r1 星标落在 p1 位置（65.0% vs p1 的 53.8%——同证据同 seeds 下 patch 臂首轮即低 11.2pp）。下：比分胜率柱 10%→70%→70%→80%→80%→90% 与规则保留率线 65→81→82→77→84% 同图——最小改动纪律与胜势同步上行。 |
| `trajectories-final-grid.png` | r0 / 重写式 r1 / p5 三组对局 × 双侧逐局 NN 预估胜率轨线。r0（左列）plan 均值线穿越 50% 线崩向 0、ctrl 均值爬向 100；p5（右列）镜像翻转——plan 均值稳在 50–80% 上行、ctrl 被压向 0；重写式 r1（中列）居中。均值线尾部有幸存偏差（撑到长局的恰是优势局，round22 口径警示适用）。 |
| `valuediff-by-seq-generations.png` | 各代 plan 侧 valueDelta 按行动序号（均值，n≥5）。开局段（seq≲10）各代共同的深负差分（−10～−20pp，价值头的乐观漂移 + 开局真实失血段，与 round22 口径一致）；中后段 p 系列整体回到 0 附近而 r0/重写式 r1（虚线）在负区更深——**逐点价值质量随 patch 轮次逼近 oracle 的可视化**。逐序号样本 ≤10，读形状不读单点。 |
| `p5-by-round.png` | 末代 p5 按回合聚合。上：每行动 valueDelta 全回合为负（−2～−20pp，含价值头中盘乐观漂移的系统性偏置，只比相对深浅；round 9/10 的 −17.5/−20pp 对应垃圾时间强攻）。下：p5 均值预估胜率从 66% 逐回合爬至 100%，ctrl 侧被压制到 12%——9:1 的过程形态。 |
| `trajectories.csv` | 逐决策点全量导出（group/game/model/arm/round/actionIdx/seq/winrateBefore/valueDelta/isValueCrash/crossedBoundary），供后续自定义分析。 |

### 8.2 候选视角产物（2026-08-30，同目录追加）

三组对照（agentic-r0 / rewriter1 / glmpatch-p5）先以 `--dump-candidates` 重评估（重评估确定性已验证，指标逐位一致；candidates 字段进入各自 `plan_eval.nn.json`），再经 `plot-candidate-scores-round26.py` 生成 6 张逐局图（每组 2 张：合法操作数阶梯线 `candidate-count-per-game-<tag>.png`、NN 全候选评分散点 + 计划所选连线 `candidate-scores-per-game-<tag>.png`，红圈=blunder 点，▽=词表外未评分）。

**读图结论（三组评分图对比）**：r0 的红圈几乎布满全部决策点且深（大量 −5～−15 logprob 的选劣）；重写式 r1 居中（红圈仍密但深度收敛）；patch p5 红圈稀疏且浅（多数在 −2.5～−5 档）——与 §8 的 blunder 率序列（66.4 → 65.0 → 43.6%）在逐局粒度互证。合法操作数图显示三组的候选数形态接近（playCard 7–12 + 调和 4–7 + 技能 3 + 切人 0.8–2 + declareEnd 1），说明 p5 的提升来自**同候选集合内选得更好**，而非动作空间差异。

## 9. 2026-09 审查修复批增量（移植自 plan-oneshot 审查，兄弟仓库 35f53386 同源）

本节记录 harness 协议与统计在 2026-09 审查后的行为增量（完整计数口径见 [../oracle-free-harness-metrics.md](../oracle-free-harness-metrics.md)）：

- **patch 覆盖确认闸**：`--patch` 模式下，已合并 patch 后再提交全量 draft/final（携带完整 `result` 稿），check 闸打回一次并要求在 `result` 顶层带 `"overwritePatches": true` 显式确认——消除"全量稿静默丢弃已合并 patch 成果"的路径；确认采纳后 `appliedPatchOps` 归零。裸 patch final（无产物、以累计 patch 为产出）不经此闸。协议说明同步 `harness-patch-reflect.md`。
- **HarnessStats 新增 `reasoningOnly{total,salvaged,failed}`**：content 为空（仅思考链，如烧穿 maxTokens）的轮次统计——salvaged = agent-loop 从思考链提取最后一个完整 JSON 当作本轮输出（历史 assistant 消息回注提取结果而非思考全文，不污染上下文）；failed = 无有效 JSON，走协议错误路径。
- **推理通道字段双兼容**：`llm.ts` 流式与非流式均同时收 `reasoning_content`（智谱官方/edgefn）与 `reasoning`（OpenRouter，GLM-5.3 实测口径），`reasoning_content` 优先；避免推理流丢失导致空 content 误判。
- **`--no-thinking` 旗标**（author/reflect）：thinking 由默认开改为显式关闭；usage 行同步。
- 对照纪律不变：`--turns 1` one-shot 路径仍刻意不做 lintPlan/ruleRefWarnings（口径注记见 `run-plan-reflect.ts` 文件头，2026-09 确认为有意）。
