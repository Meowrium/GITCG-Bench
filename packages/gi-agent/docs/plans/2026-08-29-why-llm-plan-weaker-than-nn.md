<!--
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# LLM 决策树为何弱于 NN——round23 分歧归因与改善可行性分析（2026-08-29）

> 问题：GLM-5.3-Flash 经 harness 起草的 GamePlanV1（r0，38 规则）在 NN oracle 口径下 blunder 66.4%，头对头 1:9 负于同模型一次性计划。本文对照 NN 的逐点决策行为，检验四个候选根因——①思考层级/范围有限；②agent 设计失误导致信息不足；③决策树形式表达能力不足；④DSL 表达模式单一——并评估在可控规模与时间/token 成本下的改善路径。
>
> 数据与产物：`output/plan-oneshot/round23-harness/`（plans r0/r1、games 双侧 NN 回算 `plan_eval.nn[.side1].json`、transcript/harness sidecar）；代码：`src/runtime/plan-oneshot/`（schema、prompts、CLI）。分析用一次性 node 脚本聚合逐点 JSON（方法见 §2）。

## 1. 结论速览

**主因排序：agent 设计失误（H2）≫ 思考范围失焦（H1，部分成立）＞ 决策树形式上限（H3，当前未触及）≫ DSL 模式单一（H4，不成立）。**

r0 的 NN 分歧中 **77% 集中在三类可由现有 DSL 表达的失误**（不重叠口径）：切人缺失（44%）、declareEnd 过早（16%，另有 90 次 thenMiss 主要沉淀于此）、错牌选择（17%）。没有发现任何一类 blunder 需要"现有 DSL 无法表达"的动作或条件。改善在 A 级（提示词/工程修复，小时级）+ B 级（harness 反思迭代，每轮 ~1.5–2h / ~550k tokens）内可行，预期可将 blunder 率显著压向 ctrl 侧 50.3% 之下；继续逼近 NN 端到端强度（D 级）则不划算且不必要。

## 2. 方法与证据源

- **逐点分歧聚合**：遍历 10 局 × 双侧 `plan_eval.nn.json`（NN oracle：策略排序 + logprob 分差 τ=1.0 + value 差分），按 `chosen.actionCase → oracleBest 动作族`、`matchedRule`、`chosenRank` 聚合 blunder（225/339 side0；163/324 side1），名称经 `assets-manager getNameSync("CHS")` 解析。
- **起草过程回放**：`plans/*.transcript.jsonl` 的逐轮 usage/reasoning 规模与关键概念频次；`harness.json` 的模块请求 log。
- **规则执行统计**：`summary.json` 的 perRuleHits / perRuleThenMiss（when 命中但 then 动作不可支付）。
- **提示词与 schema 审读**：`prompts/author-system.md`、`plan-schema-spec.md`、`field-reference.md`；`run-plan-author.ts` 的 user prompt 组装。

## 3. 分歧结构：NN 到底在做什么，而计划没做

### 3.1 side0（agentic r0）blunder 主模式（225 个）

| chosen → oracle 意图 | n | 占比 | avg scoreGap | avg valueDelta |
|---|---|---|---|---|
| playCard → **switch** | 34 | 15% | 3.69 | −0.104 |
| **declareEnd → switch** | 28 | 12% | 4.10 | −0.309 |
| useSkill → **switch** | 21 | 9% | 3.97 | −0.370 |
| elementalTuning → **switch** | 16 | 7% | 4.54 | −0.067 |
| declareEnd → 喧哗屋传说（一斗爆发）/披萨/女仆等 | 22 | 10% | 5.9–7.8 | −0.15～−0.70 |
| playCard → 千岩牢固/运筹帷幄（计划打了别的牌） | 19 | 8% | 3.0–3.7 | ≈0～−0.09 |

三类结构性失误合计约 72%：

1. **切人缺失（44%）**：NN 最频繁的纠正动作是 switchActive（对手岩队内战下轮转到迪希雅/一斗），而 r0 仅 3 条切人规则且**全是防御型**（阵亡兜底、濒死保命、对面满能量切诺艾尔承伤）——进攻性轮转零条。
2. **declareEnd 过早（28%）**：64 个 blunder 的 chosen 是 declareEnd（规则 global:99 兜底，n=64、avgVd −0.355，全计划最大价值黑洞），NN 认为还有爆发/治疗（烤蘑菇披萨×7）/资源动作可做。
3. **骰子元素构成误判（declareEnd 桶的主要成因）**：global:39/40/41 合计 **90 次 thenMiss**（when 命中、3 岩骰实际不可支付）→ 整链落空进 declareEnd。DSL 明明有 `dice.<元素>` 字段（r0 只用了 geo×6/omni×2/pyro×1 处），主流攻击规则全部只写了 `dice.total >= 3`。

### 3.2 side1（ctrl）对照

ctrl 同样有 `declareEnd → switch`（20）与 `useSkill → switch`（20）——切人迟钝是两个计划共有的，但 ctrl 的失误里经济牌占比高（NN 想要 派蒙×22/卯师傅/迪娜泽黛/运筹帷幄 而计划打了别的），其规则覆盖更"通用"，在不了解的对手面前退化更平缓。双侧 meanValueDelta 几乎相同（−0.173 / −0.172），说明单位行动的浪费相近；胜负差更多来自 agentic 把骰子花在了错配的防御包上。

### 3.3 度量注记

- `chosenRank` 分布双峰（29 个 rank0/31 个 rank1 vs 大量 rank>7）：NN 排序中存在平分（17 个 blunder avgGap≈0，如 global:19 n=14 avgGap=0.00），这些点 NN 对候选无偏好，blunder 标签高估了实际损害——读数时应以 valueDelta 为准。
- 桥接词表钉死 v6.3.0，311305/332013 等卡被 DummyCard 降质（warnings 已报告），受影响点 oracle 质量受限。

## 4. 四个假设逐一检验

### H2 agent 设计失误导致信息不足 —— **成立，主因（三个具体设计错误）**

1. **起草-执行对手错位**：r0 与 ctrl 的 `context.opponent` 都是 `known_deck` 雷鹤（keyThreats 全部押注 重云/雷神/申鹤 冰雷爆发），但批跑实际执行的是 红牛 agentic vs 红牛 ctrl 岩队镜像。对手牌表详情**有注入**（`describeDeckDetail` 已入 prompt），信息管道没问题——是实验配置让两个计划都在打"没准备过的战争"，防御包整体错配（reflect 根因①：global:10/5/6/7 全 blunder）。管线缺少 `context.opponent == 批跑对手` 的一致性断言。
2. **数值纪律示例自身误导**：author-system.md 的数值纪律示例用 `dice.total >= 3` 判 3 元素费战技——这**在规则上就不充分**（3 岩费需要 3 个岩/万能骰）。模型忠实执行了这个错误范式，产出了 90 次 thenMiss。这是提示词 bug，不是模型不会算。
3. **switch 无策略指引**：schema 枚举里有 `switchActive`，field-reference 也有示例，但唯一示例是"残血换人保命"；declareEnd 有专门纪律节，轮转没有。模型于是只写防御性切人——NN 口径 44% 的 blunder 恰好卡在这里。

### H1 思考层级/范围有限 —— **部分成立：不是"想得不够"，是"想错了方向 + 思考无法被反馈校正"**

- r0 draft 轮 51.4k reasoning tokens（19 分钟），raw 中"切/万能/迪希雅"各出现 5 次——模型**确实**思考了轮转与万能骰语义，且以 51k tokens 的深度为"对冰爆防御"这个错误框架精心作了战。思考深度不是瓶颈，框架错了（思考深度放大了错误假设的投入）。
- harness 的 final 轮 reasoning 仅 1.5k——draft→final 是盖章，无二次审视；且起草期用户明确禁止试跑，思考没有任何对局反馈可校准，只能靠反思轮补救。
- 机制性范围缺口：提示词未要求对"对手回合将做什么/我下回合骰子分布"做显式预测（也无字段承载），计划天然只覆盖本方回合的静态阈值。NN 同样逐点 reactive，但其权衡权重是端到端训练出来的，等价于隐式学会了这些分布——这是 H1 在"范围"维度的真实成分，但归入 H3 的形式上限讨论更准确。

### H3 决策树形式本身表达能力不足 —— **当前未成为约束；质量上限处真实存在**

- **当前 100% 的已观测失误都可用现有 DSL 表达**：切人条件（`self.characters.<defId>.hp/alive`、`opponent.active.*`）、骰子构成（`dice.<元素>`/`dice.omni`）、经济牌时机（`round`/`hand.hasCard`）全部在字段手册内。r1 反思把它扩到 54 规则、切人规则 3→9，也证明形式可扩容。
- **真实的上限差距**（质量逼近 NN 时才会碰到）：①阈值条件无权衡权重（"血≤3 才保命"无法表达"血 5 但威胁 7"的连续权衡）；②静态优先级 = 上下文无关的平局打破；③无对手回合响应/反应牌预判字段；④无骰子分布概率推理。NN 的优势本质是**学到的连续权衡**，不是 lookahead——它也是逐点出牌的策略网络。
- 结论：H3 是"天花板"而非"当前墙壁"。先拆掉 H2 的墙，才轮得到它。

### H4 DSL 提供的表达模式单一 —— **不成立**

字段手册 25+ 字段（进程/角色/资源/场面/动态引用 `$field`）、5 种动作、`skill_type`/`target`/`damage_min`/`kills`/`prefer_reaction`、phases 分段、`actionsTakenThisTurn` 可表达回合内序列。缺口是增量式的（对手手牌推断、反应预判），不是模式贫乏。反证：同一 DSL 下 ctrl（50.3%）显著优于 agentic r0（66.4%）——形式相同，差距全部来自起草质量。

## 5. 改善可行性（按成本分级）

### A 级：提示词/工程修复（一次性，小时级，零 token 研发成本）

| 修复 | 针对根因 | 预期收益 |
|---|---|---|
| 数值纪律改为"元素费必须 `dice.<元素> + dice.omni >= 费用`"并给 thenMiss 反例 | 90 次 thenMiss 链 | 消除最大单一失误链 |
| 新增"轮转纪律"节（对称于 declareEnd 纪律）：何时切、切给谁、每回合检查一次 | 44% 切人缺失 | 直接覆盖最大分歧桶 |
| batch/author 一致性断言：`context.opponent` 必须等于批跑对手，否则拒跑 | 对手错位 | 防止整轮实验作废 |
| field-reference 补"economic ramp"示例（派蒙/卯师傅类牌 round≤2 打出） | ctrl 已证明的通用收益 | 低成本提升下限 |

### B 级：harness 反思迭代（已验证有效，每轮 ~1.5–2h wall / ~550k tokens / flash 免费）

一轮 reflect（NN 证据 + turns=6）已把 38→54 规则、切人 3→9、修复四根因中的三个（对手包重写、骰子构成条件、轮转规则）。**验证协议**（关键）：每轮修订后跑 r(n) vs ctrl 头对头 10 局 + 双侧 NN 回算，同时看 blunder 率与比分——遵守"逼近 oracle ≠ 赢"纪律（round9/round19/round23 三次实例），oracle 一致性只是过程指标。预期 2–3 轮内 blunder 率进入 50% 以下、比分追平；此后边际收益递减，见 C/D。

### C 级：信息/形式增量（每项需工程 + 再验证，收益不确定，按需做）

- `fallback_detail` 设为默认注入模块（最大失误桶一直拿不到细节）；
- 骰子分布先验模块（给出"下回合 ~N 骰、期望岩骰数"），支撑概率化阈值；
- 对手回合预判字段（复用 `preview` 的伤害/击倒探针，承载 H1 的范围缺口）；
- 校验器 warning：元素费规则未引用 `dice.<元素>`/`omni` 时提示（thenMiss 静态拦截）。

### D 级：不推荐

让 LLM 决策树逼近 NN 端到端强度（等价于用语言模型做 self-play 策略学习）：成本不可控且走错分工——决策树的定位是**可解释、可编辑、可审计的政策函数**，强度上限由 NN 补齐（NN 作为对手基线/oracle/兜底已有现成接入），而非同一载体上复刻。

## 6. 遗留度量问题

- gap≈0 的"平分 blunder"（17 个）应与真分歧区分（可在 eval 输出加 `isTie` 标记）；
- value-diff 的 boundarySkipped（side1=57）偏大，掷骰跨界点的胜率归属缺失；
- 单臂 N=10 比分噪声大，改善验证建议每轮 20 局 alternateFirstPlayer（引擎本地，成本可忽略）。

## 7. 复现说明

分析为一次性 node 脚本：读 10 局 `plan_eval.nn[.side1].json` 的 `points[]`，按 `isBlunder` 过滤后以 `chosen.actionCase → parse(oracleBest).actionCase(含 targetDefId/skillDefId/cardDefId 中文名)` 二维聚合；transcript 逐行 `JSON.parse` 取 `usage.completion_tokens_details.reasoning_tokens` 与 `raw` 关键词频次。脚本未入库（避免临时物污染），需要时可按本节描述 20 行内重写。

## 8. A 级修复实施与 B 级验证结果（2026-08-29 追加）

### 8.1 实施的修复（6 项，均入库）

1. **field-reference `dice.total` 误导行修正**（§4-H2② 的直接病灶）：改为"只对无色/同色费用成立"，给出元素费用的两种可执行写法（保守 `dice.<元素> >= n`／充分构成 AND 拆分），并明示 **when 条件不支持加法**。
2. **field-reference 示例集 2 → 8 条**：新增经济铺场（派蒙 round≤2）、装备（`target` 数字=装备对象）、料理治疗（低血喂披萨）、斩杀（kills/damage_min + HP 条件）、进攻性轮转、元素调和时机；死规则来源清单 ④ 扩到 ⑥（算式字段化、tag 中文名）。
3. **plan-schema-spec 新增"轮转纪律"节**（对称 declareEnd 纪律）：切人=让出一动的成本语义、进攻/防御两类轮转、引用 44% 分歧数据。
4. **author-system 覆盖清单**改为"对照牌表逐类检查"（支援铺场/装备/料理/秘传/轮转逐类问一遍"何时打它"）。
5. **起草容错**：max-tokens 98304 + turns=4（见 8.2 截断教训）。
6. **批跑对手一致性断言**：`batch-runner.ts` 新增 `assertOpponentAlignment`，CLI 默认 fail-fast、`--allow-opponent-mismatch` 供 legacy 复现（§4-H2① 的工程化）。

### 8.2 验证中的两次起草迭代（过程发现）

- 第一次起草失败：模型把"加法记法"**字面化为字段名** `dice.geo+dice.omni`（28 个校验问题）——提示词里的语义记法会被字面执行，必须给可执行 JSON 形态；随后第 3 轮重写恰在 65536 token 处截断导致协议错误。据此补修复 1/2/5 的精确表述。
- 第二次起草成功（31 min，104k completion/88.5k reasoning）：drafts=1、finalAttempts=1、protocolErrors=0——**表达类错误清零**；40 规则/3 阶段，21 条 playCard 覆盖牌表全部 17 种卡（2 装备 + 4 支援 + 秘传 + 4 料理），骰子构成条件 23 处、零算式字段。

### 8.3 B 级检验数字（fixA vs ctrl，seeds 20275101-10）

| 指标 | fixA（A 修复后） | r0（修复前，§3 数据） | ctrl（同批对照） |
|---|---|---|---|
| 比分 | **0:10 负** | 1:9 负 | — |
| blunder 率 | 71.2%（281 点） | 66.4%（339 点） | 64.4%（295 点；上一批 50.3%） |
| meanValueDelta | −0.150 | −0.157 | −0.150 |
| coverage | 78.5% | 98.0% | 98.9% |
| fallback 率 | **21.2%** | 1.8% | 1.2% |

### 8.4 结论：A 级"必要而不充分"，强度由 B 级迭代驱动

- A 级修复**达成了直接目标**（表达错误清零、卡类结构补齐）但**没有转化为强度**：比分回退至 0:10、blunder 升至 71.2%。机制在执行数据里可见：
  1. **条件过度收紧**：构成纪律被无差别套用——连通用兜底战技规则都要求 `dice.<元素> >= 3`，而兜底本该宽松；3 条 phase 规则零命中。覆盖率 98.0%→78.5%、fallback 1.8%→21.2%，被动落入 conservative fallback 是失分的直接机制。
  2. **死规则换了形态**：`global:5` 用 `kills:true` 当"能斩则斩"过滤器但 when 不含对手 HP 条件——162 次 thenMiss（§4 的骰子型 thenMiss 消失了，出现了 kills 型）。
  3. 提示词只能教"写对"，不能教"写准"：哪条规则该多宽、阈值定多少，需要对局反馈才能校准。
- **度量学发现**：同一 ctrl 计划的 blunder 率随对局分布漂移（50.3%→64.4%）——**跨批次 blunder 对比必须限于同一对手计划 + 同 seeds**，否则指标不可比。§5 中"压向 50.3% 之下"的预期因此须在同分布内检验。
- 下一步（B 级第 1 轮）：对 fixA 跑 reflect（NN 证据、turns=6）——global:5 死规则、零命中 phase、过紧兜底都是反思可直接修的对象；修订后同 seeds 复测。

### 8.5 单轮验证成本实测

起草 31 min（~135k tokens）→ 批跑 10 局 <1 min → 双侧 NN 回算 ~12 min：**单轮验证 ≈45 min**，与 §5 B 级成本估计一致。

### 8.6 B 级第 1 轮迭代结果（2026-08-29）：论题获验证

对 fixA r0 跑 reflect（NN 证据、turns=6、98304 tokens）：turns=5、terminatedBy=final、**modules=0**（模型本轮未索取模块直接定稿）、verdicts 48（27 revise / 9 remove / 12 keep）、规则 40→50；wall 70 min、376k prompt / 257k completion（194k reasoning）、protocolErrors=4（均自恢复）。反思的四根因与 §8.4 的机制诊断完全对齐并逐一修订：①移除 `global:5` kills 过滤死规则（162 thenMiss）；②兜底规则改用"充分构成拆分"放宽（如 `dice.pyro>=2 + dice.omni>=1` 替代 `dice.pyro>=3`）；③轮转死锁规则重写（oracle ~40 点推荐切迪希雅而全场切人仅 8 次全防御）；④钟剑 13/13 blunder、坚定之岩 target 错映射 22 次 thenMiss、round 门导致后期覆盖空洞。

**同 seeds（20275101-10）、同 ctrl 对手复测**：

| 指标 | r0（§8.3） | **r1（1 轮反思后）** | ctrl（同批） |
|---|---|---|---|
| 比分 | 0:10 | **4:6（40%）** | — |
| blunder 率 | 71.2%（281 点） | **50.5%**（406 点） | 68.9%（254 点） |
| meanValueDelta | −0.150 | **−0.135** | −0.121 |
| coverage | 78.5% | 85.7% | — |
| fallback 率 | 21.2% | 14.2% | — |

- **首次在同对局分布内 blunder 率低于 ctrl**（50.5% vs 68.9%）——§5 B 级"oracle 一致性是过程指标、同分布内检验"的口径成立。
- 决策点 281→406：修订后的计划行动更多（打牌/切人/调和取代带骰 declareEnd），被动性消除。
- 单轮迭代成本：reflect 70 min（~633k tokens）+ 复测 <1 min + 回算 ~12 min ≈ **85 min**。
- 结论：§5 的 B 级预期方向获单轮验证（0:10→4:6、blunder −20.7pp）。剩余差距：r1 的 valueDelta 仍略逊 ctrl（−0.135 vs −0.121），coverage 85.7% 未回到 ctrl 的 98.9%；建议第 2 轮 reflect 以 r1 对局为新证据（模块预算应被利用——本轮 modules=0 说明信息已足够或模型策略保守），并复测同 seeds。

### 8.7 B 级第 2 轮迭代结果（2026-08-29）：趋势单调向好，价值指标反超

reflect（r1 对局为证据）：turns=4、final、modules=0、drafts=1、verdicts 52（**31 keep / 19 revise / 2 remove**——修订力度明显收敛）；规则 50→**60**（超出 15–40 建议区间，印证"区间提示无人拦"待做）；wall 69 min、314k prompt / 237k completion（188k reasoning）。反思质量要点：赛前预测校准自评"方向正确、在 N=10 噪声内"（0.35 vs 0.40）；定位最大黑洞为四条普攻兜底 global:50-53（124 点/74 blunder/valueDeltaSum ≈ −35.2）与千岩牢固被三重门挡到仅 1 命中（oracle 全场最高频推荐 ~40 点）、坚定之岩无骰子预算守卫连打吃光骰子；且**自行甄别 thenMiss 探针中的饱腹/kills 门控级联为预期噪声而非动作映射错误**——模型已学会区分度量噪声与真实缺陷。

**同 seeds 三轮趋势（同 ctrl 对手，seeds 20275101-10）**：

| 指标 | r0 | r1 | **r2** | ctrl（同批） |
|---|---|---|---|---|
| 比分 | 0:10 | 4:6 | **5:5（50%）** | — |
| blunder 率 | 71.2%（281 点） | 50.5%（406 点） | **41.4%**（377 点） | 65.2%（210 点） |
| meanValueDelta | −0.150 | −0.135 | **−0.096** | −0.106 |
| coverage | 78.5% | 85.7% | 86.3% | — |
| fallback 率 | 21.2% | 14.2% | 13.6% | — |

- blunder 两轮累计 −29.8pp 且单调下降（71.2→50.5→41.4），同对局内持续低于 ctrl；**meanValueDelta 首次优于 ctrl**（−0.096 vs −0.106）——单位行动的价值损失已低于对手计划。
- 边际收益符合收敛预期：第 1 轮 blunder −20.7pp/比分 +4 局，第 2 轮 −9.1pp/+1 局。剩余最大目标恰是 r2 自查出的普攻兜底四连（−35.2 价值）与千岩牢固三重门——第 3 轮的天然输入。
- 成本：第 2 轮 69 min（~551k tokens）+ 复测 1 min + 回算 ~12 min。**两轮累计 ~2.6h / ~1.7M tokens 把一个 0:10 的计划修到 5:5 且质量指标全面占优**——§5"可控规模与成本下可改善"的论题就此完成实证闭环。

### 8.8 基本规则审计补遗：饱腹字段缺口（2026-08-29）

r2 反思把料理类 thenMiss（global:9/11/12/13/19）归为"饱腹级联预期噪声"。对照引擎复核后**定性修正：这是 DSL 字段缺口，不是可接受噪声**：

- **引擎语义**（`core/src/builder/card.ts` + `data/src/commons.ts:283`）：饱腹 = 角色状态 `SATIATED_ID = 303300`（`status(303300).oneDuration()`＝仅本回合）；`.food()` 打出即向目标角色附状态、合法性按 `satiedFilter existsNot`（存在无饱腹角色即可打出）。状态在玩家视角 state 的 `character.entity` 里**可见**——信息管道没问题。
- **渠道对照**：`.opencode/agents/gi-tcg-p0.md` / `gi-tcg-p1.md`（MCP 对战代理）第 184-185 行均正确记载"吃食物后获得 Satiated 状态，已饱腹角色本回合不能再吃"——规则知识在 agent 侧齐备，唯独 plan-oneshot 的 when 字段封闭集合没有它，模型**无法把这条基本规则写进条件**，只能被动的等 thenMiss 级联再在反思里当噪声解释掉。
- **修复（已入库）**：`fields.ts` 新增 `self/opponent.active.satied` 与 `self/opponent.characters.<defId>.satied`（布尔，检测 entity 中 defId 303300）；plan-schema-spec / field-reference 同步收录并在料理示例中补 `satied == false`；死规则来源清单新增 ⑦（料理规则漏写饱腹条件）；新增 `fields.test.ts`（3 用例）。测试 32/32 通过、tsc 无新增错误。
- **影响**：此后起草/反思的料理规则可内联饱腹条件，该类 thenMiss 从"噪声"变为可修死规则——是第 3 轮 reflect 的现成修订点。方法论教训：**反思把 thenMiss 归为"预期噪声"前应对照引擎基本规则逐条核验**；thenMiss 探针的语义是"when 写对了但动作映射不了"，而"映射不了的原因本身是条可表达规则"时它就是缺陷信号。

### 8.9 基本规则审计扩展：game-rules.md 缺失规则清单（2026-08-29）

以 `.opencode/agents/gi-tcg-p0.md`/`p1.md` 的"七圣召唤完整游戏规则"章节（11 小节）为清单，逐条对照引擎实现与 plan-oneshot 的 `game-rules.md`，差集 6 条并已全部补入（原 51 行 → 66 行）：

| 规则 | p0/p1 记载 | 引擎核实 | game-rules.md 原状 |
|---|---|---|---|
| **下落攻击**（切人后本回合下次普攻视为下落攻击；`canPlunging` 切人置位/普攻或回合末清除；`normalAsPlunging` 强制） | 有 | `utils.ts:652-669`、`mutator.ts:1246`、`skill_executor.ts:102-104` 实证 | **缺失** → 已补 |
| 伤害修改顺序（类型→反应加成→增加→乘除→减少） | 有 | 引擎为准 | 缺失 → 已补 |
| **治疗规则**（量 = min(回复, 缺口)；死亡角色仅 revive 类可回血） | 有 | `mutator.ts:542-580` heal/revive 分支实证 | **缺失** → 已补 |
| **角色战败细则**（清附着/能量/下落标记；出战战败强制免费补位≠switchActive；全灭判负） | 有 | `defeatedSwitching`（`base/state.ts:166`）、heal revive 分支实证 | **缺失** → 已补 |
| 反应表缺行：冰+草 → 无反应、附着变冰草（cryo_dendro） | 有 | `apply` 的 getReaction 路径 | 缺失 → 已补 |
| 结束阶段两细节（清除 declaredEnd、15 回合上限检查） | 有 | `game.ts:930-950` | 不全 → 已补全 |

核实结论两条：①重击"骰子总数偶数才可用"这一反直觉规则**属实**（`game.ts:685` `canCharged = dice.length % 2 === 0`），game-rules.md 原本已正确记载；②重击/下落变体的费用与伤害由角色技能定义给出，计划 DSL 的 `damage_min`/`kills` 走动作预览，天然准确——无需新增 when 字段（`canPlunging` 若未来需要作条件再议）。`moduleBudget` 侧影响：game-rules.md 为 author/reflect 共用常载提示词，+15 行属可接受体量；下落加成与"战败清能量"直接改善切人价值与保命/牺牲的数值纪律。

### 8.10 第 3 轮（新规则提示词首秀）对照结果：表达能力 > 散文知识（2026-08-29）

本轮是天然对照实验：r0–r2 全程在旧提示词下产生，第 3 轮 reflect 首次携带 ①`satied` 字段（§8.8）与 ②game-rules 新增 6 条（§8.9）运行。

**使用度定性检查**（计划 JSON + reflection + transcript 逐轮 reasoning 关键词）：

- **`satied` 字段：立即被用**。r3 计划 5 处 `satied == false` 条件（莲花酥/土豆饼/披萨规则），reason 逐条写明"补饱腹门(原thenMiss=6/3/5)"——§8.8 的 DSL 修复直接兑现为修订动作；反思 11 次提及饱腹。
- **game-rules 新增 6 条：零使用**。"下落/重击/复活/治疗量/战败清能量"在计划、反思输出与 transcript 推理层**全部零命中**——本轮注意力被真实的费用假设错误吸走（见下）。

**同 seeds 复测**：

| 指标 | r2 | r3 | ctrl（同批） |
|---|---|---|---|
| 比分 | 5:5 | **5:5** | — |
| blunder 率 | 41.4%（377 点） | 46.9%（414 点） | 70.4%（253 点） |
| meanValueDelta | −0.096 | −0.159 | −0.191 |
| 相对 ctrl 的 blunder 差距 | −23.8pp | −23.5pp | — |
| 相对 ctrl 的价值差 | +0.010 | **+0.032** | — |

比分持平；跨轮绝对值漂移大（ctrl 自己的 valueDelta 从 −0.106 漂到 −0.191），**必须以同批相对差距读数**：r3 对 ctrl 的 blunder 优势不变（−23.5pp），价值优势反而扩大（+0.010 → +0.032）。r3 反思另有新产出：发现两类费用假设错误——千岩牢固 `costSame(3)`（任意同色+万能可抵）被收窄成 `dice.geo>=3` 门、坚定之岩 1 费被套 `total>=6` 门；field-reference 已补"同色费用写 `dice.total >= n`、勿收窄成特定元素"。

**回答"详细游戏规则是否需要 LLM 掌握"**：取决于该知识**能否落进 DSL 的表达面**——

- 能变成 when 条件或数值纪律的知识（骰子构成、饱腹）→ **立即进入决策树并产生可观测的修订差异**（satied 当轮兑现 5 处修复）；
- 只影响引擎内部结算、且计划 DSL 依赖动作预览获取的知识（下落/重击伤害、治疗溢出、战败清场）→ **预览机制已隐式覆盖，当前质量水平下不需要 LLM 显式掌握**——零引用且指标无退化。

结论：§8.9 补入的 6 条保留（15 行常载成本 = 廉价保险，未来做下落斩杀线等精细规则时是前提），但它们不是当前瓶颈；真正的杠杆仍是**扩大 DSL 可表达的事实集合**（satied 即证）与**反思驱动的费用/门控校准**。

### 8.11 知识注入全面排查（2026-08-29）

按"值得注入 = 能落进 DSL 表达面或修正已观测失误模式"的判据，四线排查：r0–r3 全部反思失误归因、引擎机制 vs game-rules.md、`io.ts exposeState` 可见事实 vs `fields.ts` 可表达字段、fallback/调和语义。

**本轮注入（已实施，测试 33/33）**：

| 知识 | 证据链 | 落点 |
|---|---|---|
| **能量经济**：能量唯一来源 = 使用普攻/战技（使用者 +1、封顶 maxEnergy、爆发不充能）；**受伤不充能**（引擎特有，易被官方规则记忆污染） | `skill_executor.ts:213-220`（gainEnergy 分支）、`game.ts:790-805`（爆发消耗）；全引擎无受伤充能路径 | game-rules.md |
| **conservative 精确语义**：有 declareEnd 候选就**直接宣告结束**（"最低费用"分支几乎不触发）——fallback 点 ≈ 白送回合 | `plan-player-io.ts:263-270` | author-system.md |
| **对手节奏字段**：`opponent.declaredEnd`（对手已宣告 → 剩余行动权全归我）、`opponent.dice.total`（对手剩余骰数，牌面脱敏但数量可见）、`opponent.hand.count`（数量可见内容隐藏）、`self.declaredEnd` | `io.ts:628-652` exposeState 全量对照 | fields.ts + schema-spec + field-reference + 测试 |

**明确不注入清单（含理由）**：

- `canPlunging`/`canCharged` 作 when 字段——动作预览已把变体费用/伤害计入 kills/damage_min 合法性，无观测失误需要它；
- 角色实体泛化 `hasEntity.<defId>` 字段（武器/圣遗物/任意状态在身）——satied 是具体痛点驱动，泛化等真实失误出现再加；
- `pileCard`/`legendUsed` 字段——低价值（hasCard 已覆盖主要场景）；
- 月反应（lunar reactions）——版本特性，当前对局未出现；
- 卡牌效果细节——`describeDeckDetail` 已注入牌表详情，r0–r3 的失误均在费用"门"的写法而非效果未知。

**遗留（非知识类，模型侧）**：费用门校准（千岩牢固 `costSame(3)` 门、坚定之岩预算门）——field-reference 已补"同色费用勿收窄成特定元素"，属反思循环的校准对象，不需要更多知识注入。

### 8.13 第 4 轮检验：平台期确认 + 万能骰表达力缺口（2026-08-29）

reflect（r3 对局为证据）：turns=5、final、modules=4、verdicts 69（26 keep / 25 revise / **18 remove**）、规则 68→**44**（大幅合并）；wall ~72 min。使用度：**satied 保留**（计划 7 处/反思 7 次）；**"受伤不充能"进反思 2 次**（能量经济知识部分吸收）；对手节奏三字段（declaredEnd/opponent.dice.total/opponent.hand.count）本轮**零使用**——验证手段已就位，是否兑现留待后续轮次观察。

**同 seeds 复测**：5:5（持平）、blunder 42.2%（438 点）vs ctrl 65.2%、valueDelta −0.146 vs −0.150、coverage 84.1%、fallback 16.1%。四轮趋势（相对 ctrl）：blunder 优势稳定在 −23pp 上下，价值差持平偏优——**进入平台期**。

**本轮最重要的产出——反思自查出一个真实的表达力硬限制**：万能骰富余局面（如 geo=0/omni≥3，game-0009 seq23）下，"geo≥2 且 omni≥1"的 AND 充分构成模式**系统性漏掉全万能直付路径**，技能/爆发不可达而落入普攻兜底——这正是连续两轮被点名的最大价值黑洞（普攻兜底族 117 点/63 blunder/≈−35 价值）的成因之一（45 号规则 8 命中 6 blunder"实为爆发本可直付"）。

**已实施修复**：fields.ts 新增一等字段 **`dice.<元素>+omni`**（该元素+万能总数，即万能可抵后的精确支付能力）——元素费用条件从此有标准写法 `dice.geo+omni >= 3`，AND 拆分近似作废；plan-schema-spec/field-reference/author-system 同步（明确"唯一合法加法形态"，其余自造算式仍非法，防止与 §8.2 的字面化教训冲突）；fields.test.ts 加用例（含 geo2/omni5 复现局面）。测试 34/34 通过。

**四轮总账（同 seeds、同 ctrl）**：比分 0:10 → 4:6 → 5:5 → 5:5；blunder 71.2% → 50.5% → 41.4% → 42.2%（相对 ctrl 稳定 −23pp）；迭代成本 ~85 min/轮。平台期的下一个验证点即第 5 轮：`dice.<元素>+omni` 是否像 satied 一样被当轮兑现到普攻兜底族的改写中。

### 8.14 第 5 轮检验：`dice.<元素>+omni` 当轮兑现，平台期突破（2026-08-29）

reflect（r4 对局为证据）：turns=6、final、modules=11、verdicts 45（31 keep / 14 revise）、规则 44→**50**；wall ~65 min。**§8.13 新字段当轮兑现**：`dice.<元素>+omni` 落进 **10 处条件**，且不在预想的普攻兜底族——reflect 判定普攻兜底族（1 元素 + 2 任意费用）原有的元素/万能拆分已经精确，其 blunder 根因在上游覆盖；字段被用到真正用错 `dice.total` 的三族：战技 #14/#15/#16（`dice.total>=3` → `geo+omni>=3` 等）、爆发 #28/#29/#30、轮转 #20/#33/#34（新增双满能换位 + 能量就位进攻轮转）。另新增 #32（领域存续再施放）、#26（披萨迪希雅出战变体）、#1（磐岩盟契 0 骰空洞）。

**同 seeds 复测：10:0**（四轮 5:5 平台期后首次突破；N=10 但 blunder/价值/覆盖率同向改善互证）：blunder **35.2%**（495 点）vs ctrl 74.6%、valueDelta **−0.118** vs −0.160、coverage **87.1%**、fallback **12.9%**。同对内 blunder 优势从 −23pp 扩大到 **−39pp**（ctrl 侧跨轮漂移不可比，仅同对内有效）。

**新字段规则实战表现（side0 blame，格式 blunder/命中）**：直接受益者近零失误——熔铁流狱 `pyro+omni>=3` **0/8**、炎啸爆发 `pyro+omni>=4` **0/8**、最恶鬼王 `geo+omni>=3` **1/15**；开盘轮转 0/6、新增进攻轮转 0/3、0/1。普攻兜底族腰斩：岩普攻 11/52（21.2%，该族 r4 约 54%）。**仍高分歧（下一轮素材）**：一斗战技 14/29（48.3%）、护心铠 7/13、大扫除 6/11——支付门已能命中（修复了 thenMiss），剩余分歧是"同点位 oracle 偏好其他动作"（省骰/时机）而非支付可行性。另有一批低样本高失误新规则需审计：千岩前移 **11/11**（100%！疑似抢在 oracle 优先动作之前）、派蒙 13/17、迪娜泽黛中后期 10/13、披萨迪希雅 4/5。

**五轮总账（同 seeds 20275101-10、同 ctrl）**：比分 0:10 → 4:6 → 5:5 → 5:5 → **10:0**；blunder 71.2% → 50.5% → 41.4% → 42.2% → **35.2%**；valueDelta（r4 起）−0.146 → −0.118。方法论结论强化：**表达力修复与 satied 同模式——当轮即兑现成分数**，前提是修复瞄准了已观测的失误模式（这次是 thenMiss 27 次的支付门），而散文式规则知识（§8.10）无此效应。

### 8.15 剩余失误构成：机制类 vs 偏好类（r0/r4/r5，side0，2026-08-29）

按"chosen 动作 vs oracle 推荐动作"的形状分类全部 blunder（解析注意：`plan_eval.nn.json` 里 `oracleBest` 是 **JSON 字符串**、动作用驼峰 `actionCase`，与计划 schema 的 `action_case` 不同）：

| 构成 | r0（200 条） | r4（185 条） | r5（174 条） | 性质 |
|---|---|---|---|---|
| 动作类型差（打牌 vs 技能/切人/调和等） | 49.0% | 63.2% | **66.7%** | 时机/排序**偏好**（双方动作均合法可付） |
| 同类动作参数差（同打牌不同张/同技能不同目标） | 18.5% | 17.3% | 17.2% | 目标选择**偏好** |
| `<fallback>` 无规则命中 | 31.0% | 17.3% | **9.2%**（32→16 条） | **覆盖洞**（可写规则未写，收敛中） |
| 该结束没结束（oracle 要 declareEnd 而计划打了别的） | 1.5% | 2.2% | 6.9%（绝对值 12 条） | 资源纪律**偏好**（残余，可再教） |
| 宣告过早（计划 declareEnd 而 oracle 想行动） | 0 | 0 | **0** | 已清零——conservative 纪律生效 |

历史机制类失误（饱腹 thenMiss、支付不可行 thenMiss、切人缺失、千岩 `costSame` 误设、坚定之岩 target 错映射、宣告过早）在 r5 的对局记录中**均无再现**——机制可行性层面没有已观测未修复的失误类；剩余差异都在"同样可行时选哪个"的偏好层。保留三点：①6.9% 的"该结束没结束"属偏好但可通过 declareEnd 纪律再压缩；②fallback 覆盖洞会随牌序/胜负分布移动，需按轮补；③§8.12 延迟项（角色实体泛化/pile.legendUsed/月反应）仍是已识别未兑现的表达力缺口，出现失误模式才修。**外推边界**：以上仅对 红牛镜像 + seeds 20275101-10 成立，未在其他卡组验证。

### 8.16 跨模型检验：qwen-flash 零迭代起草 vs GLM r5（2026-08-29）

用户要求用"5 轮修复后的框架"从零跑一套阿里 qwen 决策树与 GLM r5 对战。模型 ID 澄清：**DashScope 无 `qwen-3.8-flash`**（模型列表实查），取最新快档 **`qwen-flash`**。

**框架适配发现（均已入库修复）**：①DashScope `max_tokens` 硬上限 **32768**（GLM 用的 98304 被拒）；②`enable_thinking` 非流式默认关，llm.ts 已改为 thinking=true 时**显式发送** `enable_thinking:true`（对 Zhipu 行为保持：省略=默认开=显式 true）；③DashScope 流式存在**末块重复伪影**（完整 JSON 后多 1 个 `}`），`extractJson` 加"首个括号平衡对象"兜底解析 + 7 项单测——该修复对所有通道的 author/reflect 生效；④流式 usage 不回传（需 `stream_options.include_usage`，未接，harness tokens 显示不可用）。

**起草结果**（turns=4、agentic、protocolErrors=1 自恢复、wall ~2.6 min）：合法计划，但产出**薄**——10 规则 / 0 阶段（GLM r0 同框架 38 规则；ctrl 25 规则+3 阶段）。框架知识确实进入输出：主动索要 field_reference 且理由点名 `dice.geo+omni` 写法、料理规则带 `satied == false`、爆发规则带能量/斩杀门。

**对战（seeds 20275101-10、交替先手）**：

| 对局 | 比分 | qwen 侧 blunder / valueDelta / coverage / fallback |
|---|---|---|
| qwen r0 vs **GLM r5** | **0:10** | 83.9%（115/137）/ −0.239 / 66.7% / 33.0% |
| qwen r0 vs GLM ctrl（零迭代同台） | 3:7 | 71.9%（100/139）/ −0.203 / 69.1% / 30.0% |

对照侧：GLM r5 在本对局的 blunder 36.4%/−0.128（与其打 ctrl 的 35.2%/−0.118 一致——质量不因对手变弱而漂移）；ctrl 本对局 64.0%/−0.120。

**读数**：①qwen 零迭代起草与 GLM 零迭代基线大体同台（3:7、blunder −7.9pp），且好于 GLM 踩 A 级修复过紧坑时的 fixA r0（当年 0:10）——**框架可跨模型迁移**；②但对 5 轮迭代后的 GLM r5 是 0:10——**迭代增益是决定性差距**，与 §8.4"提示词只能教写对、写准要靠对局反馈"结论互证；③qwen 计划的主要失分机制是覆盖薄：fallback 33% 且 `<fallback>` blame 64/67（近半决策点裸奔），直因是 32k token 上限压缩了产出规模（GLM 98k 预算下写了 38 条）；④若给 qwen 补 reflect 迭代（同框架 turns=6 需先把 final 预算适配 32k），预期可复现"起草→迭代逼近"曲线，未做。

### 8.17 跨模型迭代：qwen3.8-flash 五轮反思全记录（2026-08-29）

用户指出模型实为 **`qwen3.8-flash`**（无连字符；1M 上下文/131K 输出，实查确认 `max_tokens:131072` 可用、thinking 双向可控、usage 正常回传）。用 131K 预算重起草 r0 后按 GLM 同款协议跑 5 轮 reflect（turns=6、thinking、stream）+ 同 seeds（20275101-10）vs ctrl 对局 + 双侧 NN 评估；全流程 ~2h（reflect 6.8–13.3 min/轮，约为 GLM 的 1/6）。

**各代表现（side0=qwen 计划，同对内比较才有效）**：

| 代 | 规则 | reflect(verdicts) | 比分 vs ctrl | blunder(qwen/ctrl) | valueDelta | coverage/fallback |
|---|---|---|---|---|---|---|
| r0（turns=1 一次成稿） | 38 | — | **5:5** | 64.7% / 67.7% | −0.120 / −0.128 | 85.3% / 14.6% |
| r1 | 37 | 5轮(10k/23r/5x) | 2:8 | 60.9% / 67.3% | −0.167 / −0.120 | 82.5% / 17.5% |
| r2 | 40 | 3轮(2k/34r/1x) | 4:6 | 53.4% / 72.6% | −0.144 / −0.134 | 81.3% / 18.1% |
| r3 | 40 | 3轮(10k/19r/2x) | 5:5 | **43.5%** / 67.7% | **−0.115** / −0.120 | 84.0% / 16.1% |
| r4 | 39 | 3轮(6k/31r/3x) | 4:6 | **38.9%** / 64.2% | −0.125 / −0.123 | 81.5% / 18.6% |
| r5 | 39 | 5轮(16k/23r) | 5:5 | 49.1% / 69.3% | −0.146 / −0.158 | 82.6% / 17.3% |

**末代对 GLM r5：1:9**（qwen 侧 62.4%/−0.189，GLM r5 侧 47.5%/−0.151——后者因对局分布不同高于其常态 35-36%，仅同对内可比）。

**读数**：①**131K 预算解锁起草规模**：turns=1 一次成稿 38 规则/7 opening（对比 qwen-flash 32K 下的 10 规则），r0 起点即 5:5 平 ctrl、同对内 blunder −3.0pp——**零迭代起点与 GLM ctrl 同水平**，远强于 qwen-flash 薄版与 GLM fixA r0（当年 0:10）；②**过程指标单调改善**：blunder 64.7→60.9→53.4→43.5→38.9（r5 回弹 49.1），同对内对 ctrl 优势 −3pp→−25pp——反思循环对 qwen 同样有效；③**比分不涨**：五代在 4:6–5:5 徘徊，与 GLM 曲线（0:10→4:6→5:5→10:0）不同——qwen 的过程改进未像 GLM 那样兑换成胜势；④**与 GLM r5 终点差距明显**（1:9；GLM r5 同期 blunder 35.2%/−0.118）：GLM 用 6 代 98K 预算迭代到 50 规则+phases 的细粒度条件，qwen 五轮停在 39 规则且无 phases，r2 一度 34/37 规则全改写、收敛振荡（r5 回弹）；⑤反思修订强度偏高（r2-r4 revise 占比 80-92%，GLM 后期收敛到 keep 为主）——qwen 反思对"保留已验证规则"的自制力较弱，可考虑在 reflect 提示词加"最小改动纪律"。

**轨线作图产物**（2026-08-30）：`output/plan-oneshot/glm-vs-qwen/nn-valuediff/`，共四组：①聚合视角 4 图（对局×双侧胜率网格、末代 valueDelta 按行动序号、六代 valueDelta、按回合聚合——均值口径，方差大仅作互补）；②逐局原始轨线（无均值）：三组对局每局双侧胜率面板 + 两模型各 10 局六代 valueDelta 叠加（同种子跨代可直接对比）；③逐局合法操作数轨线 ×3（候选数=引擎 action 请求条目数，构成 playCard 7-12 + elementalTuning 4.4-7.5（逐手牌条目，随手牌数增长）+ useSkill 恒 3 + switchActive 0.8-2.0（唯一随阵亡收缩项）+ declareEnd 恒 1，残局不降是口径真实反映）；④逐局 NN 全候选评分散点 + 计划所选评分连线 ×3（logprob 尺度 0=最优，约 −17.5~0，1/3 候选词表外无评分）。工具与口径详见 `packages/gi-agent/scripts/README.md` 的"决策树轨线/候选评分作图"小节；程序在 `packages/gi-agent/scripts/analysis/nn-valuediff/`（含 round22 参考副本），仓库根 `.tmp/plot-venv` python 运行。

### 8.12 待补充注入清单（暂缓，迟早用上）

以下项经审计判定"当前无观测需求"而暂缓，但均为引擎中**真实存在且 state 可见/规则可表达**的能力，后续出现对应失误模式或扩展需求时按此处要点实现：

| 项 | 内容 | 实现要点 | 触发条件 |
|---|---|---|---|
| **角色实体泛化字段** | `self/opponent.characters.<defId>.hasEntity.<状态defId>`（布尔）：检测角色身上任意实体（武器/圣遗物/天赋/状态），是 `satied`（303300 硬编码）的泛化 | `fields.ts` 的 `characterField` 增 `case`：`c.entity.some(e => e.definitionId === X)`；FIELD_PATTERNS 加 `\d+` 段；注意与 `satied` 的关系（satied 可改为薄语法糖或保留） | 出现"重复装备/不知状态在身"类 thenMiss，或规则需要"某状态在身才行动"（如千岩牢固体系、护体岩铠叠层判断） |
| **牌库与传说牌字段** | `self/opponent.pile.count`（牌库剩余数）、`self.legendUsed` / `opponent.legendUsed`（布尔，传说牌是否已用） | `exposeState` 已暴露 `pileCard`（双侧）与 `legendUsed`（`io.ts:641-651`），fields.ts 加 STATIC_FIELDS + resolve 分支即可 | 需要"牌库厚度"类磨损判断，或秘传（磐岩盟契）用后对手防备的博弈判断 |
| **月反应** | 月感电/月绽放等 lunar reactions（引擎 `getReaction` 带 `enabledLunarReactions` 开关） | game-rules.md 反应表补行 + 反应加成数值；若需条件表达再评估字段 | 对局卡组出现月反应体系角色/卡牌时 |

另有一个候选暂列观察：`canPlunging`/`canCharged` 作 when 字段（当前动作预览已隐式覆盖；若未来写"切人后必打下落斩杀"类规则且预览法不够用再议）。

## 9. 运行与对局过程问题记录（2026-08-29 汇总）

迭代期间实际踩到并解决的过程问题，集中记录以免复踩。§8.2/§8.4 已记的（记法字面化、65536 token 截断、跨批度量漂移）此处只列指针。

### 9.1 工具链与环境（Windows + Git Bash）

- **pnpm `sh` shim 损坏**：corepack 把路径拼成 `D:\Users\LUBY\anaconda3\Library\c\Users\...`，直接 `pnpm` 报错——一律用 `pnpm.cmd`。
- **`cmd //c set` 的环境变量到不了 node 子进程**（探针实测）：设置 `OPENAI_API_KEY` 等必须用 bash 前缀 `VAR=... pnpm.cmd ...`。API key 因此只走内联环境变量，**不入任何仓库文件**（纪律）。
- **`cmd //c` 内层引号会变成字面量**：无空格路径一律去引号；`cd` 必须用 `/d` 形式否则"Missing script"。
- **llm.ts 硬编码 20 分钟超时**（`AbortSignal.timeout(1_200_000)`）：GLM thinking 流式调用常超 20 min，被杀后触发静默 8 连重试循环。已加 `LLM_TIMEOUT_MS` 环境变量覆盖（跑长轮用 3600000）。
- **GLM-5.3-Flash 默认开 thinking**：请求里不要传 `enable_thinking`（false 会烧穿 maxTokens 出空输出）；长输出配 `--stream` + `--max-tokens 98304`（65536 曾在 turn 3 JSON 中途截断，§8.2）。

### 9.2 harness / batch / eval 的调用坑

- **batch 对手一致性断言**（`assertOpponentAlignment`，fixA 期加入）：known_deck/mirror 声明与实际执行牌表不符即失败——round22 的"双方都按雷鹤起草却打红牛镜像"问题由此杜绝；复现旧实验才加 `--allow-opponent-mismatch`。
- **side1 评估的正确姿势**：`--trace-file plan_trace.side1.json --eval-out plan_eval.nn.side1.json`；传 `--side 1` 会被**静默忽略**（CLI 未定义该旗标），实际重跑 side0 覆盖同名汇总。
- **blame 规则 id 是 `global:<priority>`**（按 priority 不是数组下标）：反思文本里的 `global:27`/`global:49-52` 应对照计划 JSON 的 priority 字段解读。
- **eval 数据双口径**：`plan_eval.nn.json` 的 `oracleBest` 是 JSON 字符串、动作字段是驼峰 `actionCase`（计划 schema 是 `action_case`）——写分析脚本必须同时兼容，否则整批误分类。
- batch CLI 取第一个位置参数为配置文件，`--help` 会当路径读而报错。
- **评估器候选导出**（2026-08-30 起）：`plan:eval --oracle nn` 每个决策点恒记录 `candidateCount`（引擎 action 请求的合法动作条目数）；加 `--dump-candidates` 逐候选导出 `candidates[]`（摘要+NN 评分，logprob 尺度 0=最优、约 1/3 词表外为 null），供候选评分散点/合法操作数轨线作图。重评估确定性已验证（同 seeds 指标逐位一致）。
- **DashScope（阿里）通道差异**：无 `qwen-3.8-flash`（用 `qwen-flash`）；`max_tokens` 上限 32768；thinking 需显式 `enable_thinking:true`（llm.ts 已改为显式发送）；流式有**末块重复伪影**（完整 JSON 后多 1 个 `}`）——`extractJson` 已加括号平衡兜底；流式 usage 需 `stream_options.include_usage` 才返回。
- 评估中的对齐警告（`seq=N: 无匹配的 state log 暂停点，跳过`）每批个位数，是正常跳点；NN 侧大量 `blank_action_card`/`unscored_legal_skill` 等是词表外卡牌的平台兜底告警，非故障。

### 9.3 对局与度量的人工误读教训

- **t1 局（planSide=1）digest 列互换**：我方/对手列在摘要里对调，曾导致把对手的火系普攻读成我方失误（game-0008 seq25 型）；解读 turn-1 先手局时先核对 planSide。
- **同名动作大 gap 伪影**：计划动作与 oracle 推荐完全一致却记大 gap（global:19 七点 gap4.9-5.94 而 valueDeltaSum 仅 −0.146）——thenBad 探针要配 valueDeltaSum 交叉验证，不能只看命中数。
- **反思的"噪声"定性需复核**：r2 把饱腹 thenMiss 归为预期噪声，实为字段缺口（§8.8）——thenMiss 探针里"映射不了的原因本身是条可表达规则"时就是缺陷信号。
- **对局数 N=10 的读数纪律**：比分跳变（5:5→10:0）需 blunder/valueDelta/coverage 同向改善互证；跨轮绝对值漂移大（ctrl 侧 blunder 50.3%→74.6% 跨五轮），只做同批相对比较。

## 10. 威胁语汇专项：`opp.threat.*` 字段落地与三轮采用率验证（2026-08-30）

承接 §5 C 级"对手回合预判字段"。本专项把该方向完整落地并用四轮实验回答了"语汇够不够用"之后的问题：**字段可用之后，什么条件才会被采用**。

### 10.1 实施（A/B/C 三级，均已入库）

- **A 骰子分布先验**（`dice-prior.ts`）：精确二项尾概率运行时计算（单元素/元素+万能 ≥k、reroll 条件分布）；harness 新增可索取模块 `dice_prior`（author/reflect 双侧协议文档登记）。
- **B `opp.threat.*` 运行时字段**（`threat.ts`，fields.ts 白名单 +5）：`maxDamage`（对手出战在 `opponent.dice.total` 上限内可支付技能的最大 基础伤害+反应加成）、`lethal`（含我方出战可见护盾）、`burstReady`、`burstP`（骰面隐藏→骰子先验表给支付概率）、`maxDamageAfterSwitch`（切人+技能两动上界）。反应系数**转写**自 core（`base/reaction.ts` REACTION_MAP + `base/skill.ts` `increaseDamageByReaction`；core 未导出 getReaction，改动需同步）；伤害数值静态解析 `@gi-tcg/data` 源码（复用 source-parser，模块级缓存），目录不可读时伤害类字段降级 undefined 不抛错。**版本口径警示**：伤害表按当前版本源码解析，钉 v6.3.0 对局绝对值可能有出入（上界性质不变）。
- **C 证据解锁**：`PlanTraceEntry.threat`（仅 action 条目，求值失败省略、向后兼容）+ fullDigest 决策行注入 `威胁:dmgN/斩杀!/爆发P.xx` 读数 + reflect-system 指引（"威胁读数高而未防的 ✗ 点 = 防御规则缺口，修订用 `opp.threat.*` 而非固定 HP 阈值"）。
- 配套：`scripts/salvage-reflect-transcript.ts`——harness"轮次耗尽无合法 draft"但某轮 raw 含近似完整产物时，修复尾部 brace 失衡并按 `finalizeMerged` 同一管线（谱系接管/auto-repair/planId）打捞落盘。

### 10.2 关键 bug：skillType 形状假设（roundT2 暴露，已修复）

`buildThreatProfile` 初版从 `initiativeSkillConfig.skillType` 读技能类型，而真实 GameData 中 `skillType` 在技能定义**顶层**（`initiativeSkillConfig` 内只有 `requiredCost`）——所有技能被跳过、画像恒空，roundT2 全管线 447 个决策点 maxDamage 全 0。**单测固件镜像了同一错误假设**（测试钉住 bug）；既有的 `loadSkillDamageMap` 集成测试只盖伤害表、没盖 GameData 形状。修复（读顶层 skillType）+ 真实 GameData 集成回归测试已入库（86/86 全绿）。教训：**对"从运行时对象取数"的代码，固件单测必须配一个真实数据集成钉**。

### 10.3 采用率验证四轮（基线：agenticfix.r5 vs g53fctrl，同 seeds 20275101-10：10:0 / blunder 35.2% / valueDelta +0.042）

| 轮 | 证据形态 | 比分 | blunder | 同对内优势 | threat 采用 |
|---|---|---|---|---|---|
| round27 r6 | ctrl 对局（无威胁压力） | 5:5 | 39.2% | −28.8pp | 0；dice_prior 未索取 |
| roundT1 r5nn1 | vs NN 0:10（无读数） | **8:2** | **30.7%** | −35.3pp | 0（reflect 因 brace 失衡+包装混淆失败，salvage 打捞） |
| roundT2 | threat 全零（§10.2 bug） | — | — | — | 作废 |
| roundT4 r5nn4 | vs NN + threat 读数注入 | 7:3 | 40.3% | −27.0pp | 0 规则；reflection 主动提及 1 次 |

roundT4 的威胁信号本身是显著的（447 决策点中 lethal=true **17.2%**、burstReady **31.1%**、maxDamage 均值 3.19），且模型在 `global:8` 的 falsifiableClaim 里主动写下启用条件（"若出现濒死无防御切人的 ✗ 点则重写为 opp.threat.lethal 驱动"）——**它知道字段存在、考虑过、并判定本轮证据不满足条件**。

**这个判定是对的**：lethal×blunder 关联分析显示 103 个 blunder 点中 lethal=true 仅 **6 点（5.8%）**（其中 1 点本来就选了防御动作），另有 8 个 lethal=true 的非 blunder 点（现有规则已防住）。"该防没防"类只占失误的 ~5%——NN 的压力形态是**每个决策点连续的价值压制**（meanVd −0.196），不是斩杀突袭。

### 10.4 结论

三轮递进（无证据 → 有证据无读数 → 有证据有读数）收敛到干净判据：**threat 语汇的采用瓶颈不是可见性而是失误类占比**——字段语义正确、信号显著，但红牛镜像对局的失误结构里没有它的位置；模型拒绝在证据不足时写防御规则正是反思纪律想要的行为。语汇扩充的兑现条件由此补全为三条：①能落进 DSL 表达面（§8.11）；②证据中存在对应失误类（satied/+omni 模式）；③该失误类占比足够显著，盖过修复局部性的惯性。threat 字段作为低频保险丝保留（定位同 global:8 安全网）；是否在爆发密度更高的对局（雷鹤臂）中达到采用阈值，见 roundT3 实验（产物 `output/plan-oneshot/roundT3-threat-leihe/`，含 leihe.ctrl.r0 vs NN 镜像 + NN 证据反思 leihe.nn1 + vs 红牛ctrl 复测与同批基线；口径注记：leihe.ctrl.r0 为 known_deck 起草，NN 镜像批跑用 `--allow-opponent-mismatch`）。

### 10.5 roundT3 雷鹤臂结果（2026-08-30）：threat 字段首次当轮兑现

雷鹤镜像 vs NN 的威胁结构与失误构成与红牛线质的不同：lethal=true 占 25.0%（73/292）、burstReady 25.7%；**lethal∩blunder 达 18.5%（28/151），为红牛线 5.8% 的 3.2 倍**——失误类占比越过采用阈值。

- **采用**：leihe.nn1 新增 2 条 `opp.threat.lethal` 防御轮转规则（global:106/107，斩杀威胁下切健康申鹤/重云承伤），reason 直接引用证据中的"斩杀!"读数与具体点位（game-0003 seq17-19）——satied/+omni 的"当轮兑现"模式在 threat 字段上首次复现，三条件判据（§10.4）获正向案例闭环；
- **强度**（vs 红牛ctrl，同 seeds 20276501，同批基线 leihe.ctrl.r0）：4:6 vs 3:7；blunder **49.8% vs 56.2%**（−6.4pp）；valueDelta −0.0026 vs −0.0081——同向改善。vs NN 仍 0:10（预期内）；
- **新一层问题——"用上"之后要"用对"**：两条 threat 规则实战命中 15 次，oracle 判 blunder 约 8–9 次（vs NN 5/7、vs ctrl 3/6）——上界误报（骰面/手牌隐藏使 lethal 高估）与 NN oracle 的进攻偏好叠加，防御切换被惩罚。后续校准方向：lethal 叠加更低 self HP 门、或与 burstP 阈值组合、或按 oracle 分歧点回收误报率统计。leihe.nn1 的 reflect 运行健康（turns=6、modules=7、drafts=2、salvaged=0）。

### 10.6 roundT5 误报校准迭代（2026-08-31）：概率语汇 0 采用，HP 门局部修补胜出

承接 §10.5 末尾的校准方向。本轮先把概率化语汇入庫再验证：**`opp.threat.lethalP`**（threat.ts：逐技能判致死且可支付，达标技能取 `binomialTail(diceTotal, P_ELEMENT_OR_OMNI, elementDice)` 的 max，3 位小数；trace 快照加 `lethalP` 列）与 **`opp.hand.hasCardP.<defId>`**（fields.ts：`1−∏(U−k−i)/(U−i)` 超几何持牌概率，U=对手手牌数+pileCard 数，k=对手牌表携带张数；`PlanFieldContext.opponentDeckCards` 赛前明牌注入、注释标明非上帝视角；batch-runner 对两副实际牌表双侧接线）；validate 新增 `warnings` 通道（hasCardP 引用不在对手牌表的卡→"恒 undefined 疑似死规则"警告，unknown_deck→"无法校验"警告；不影响 ok），警告在 validate/author/reflect 三处表面化进 LLM 环路。116/116 测试绿，tsc 零新增错误。

**反思与采用**（leihe.nn1 vs-NN 证据 → leihe.nn2，glm-5.3-flash，turns=6，terminatedBy=final，drafts=1，rules 34→40）：lethalP/hasCardP 在 prompt field-reference 各出现 1 次，但 transcript 六轮 **0 提及**、plan **0 采用**。模型改用旧二元 `opp.threat.lethal` 叠加 **`self.active.hp <= 4` 门**重写防御轮转（p58/59/60，reason 直接引用误报点位"g5 seq13(HP7)/g8 seq16(HP5)类高血量贪防失误"），并补全 nn1 缺失的雷将承接（链变为申鹤1107→雷将1407→重云1104），旧 106/107 移除。

**校准效果**（threat 族 blame，同口径命中归因，同批对比 nn1）：

| 战场 | nn1 命中/blunder | nn2 命中/blunder |
|---|---|---|
| vs 红牛ctrl（seeds 20276501） | 3/6 | 3/3（58 零命中） |
| vs NN（seeds 20276401） | 5/7 | 1/1（58/60 零命中） |
| 合计 | 8/13 | 4/4 |

HP 门把触发频次压到 1/3（13→4），nn2 的 4 次触发全为 HP≤4 濒死局——"高血量贪防"误报类确实被门掉；但残余触发仍全部判 blunder，说明 `lethal ∧ HP≤4` 仍不是正确防御条件（濒死斩杀面的更优解可能是莲花酥/回血/主动卖人，或 NN oracle 进攻偏好下一切防御切换都被惩罚——待逐点核查区分）。

**强度**（同批对比，口径：比分 / 自身 blunder / valueDelta / valueCrashRate）：

| 战场 | nn1 | nn2 |
|---|---|---|
| vs 红牛ctrl | 4:6 / 49.8% / −0.0026 / 18.8%（对手侧 65.2% / +0.0227） | **7:3** / 55.3% / −0.0060 / 19.5%（对手侧 75.4% / +0.0109） |
| vs NN | 0:10 / 55.6% / −0.0613 / 24.9% | 0:10 / **43.4%** / −0.0628 / 25.1% |

**读数**：

1. **blunder 率与比分再度背离**：vs ctrl 比分 +3 胜场但自身 blunder +5.5pp（对手侧 blunder 65.2%→75.4% 同步上升、vd 下降，nn2 把对局拖入了双方更易犯错的形态，avgRounds 6.9→7.9）；vs NN blunder −12.2pp 但比分/vd/crashRate 全持平——两个战场各有一个指标大幅改善而另一个不动。决策质量代理指标与胜负在 N=10 尺度上仍弱相关；vd 与 crashRate 双侧持平说明本轮改写是"少犯小错、大错依旧"。
2. **采用判据补第四条：新语汇的竞争对手是旧语汇的局部修补**。lethalP 是更"对"的工具（概率门，直接对治上界误报），但 HP 门是模型从证据（具体点位 HP 读数）可直接归纳的最小 diff；在 6 轮反思预算内局部修补几乎必胜。若要推概率语汇，"可用+失误类显著"不够，候选手段：证据 trace 直接注入 lethalP 读数列（本轮证据是 roundT3 旧 trace，无 lethalP 列，模型只见抽象定义不见具体数值——下一版批跑产物已带该列，可自然检验）；或在 reflect-system 指引点名"lethal 误报率高时优先 lethalP 阈值而非 HP 门"。
3. **环路在现有语汇上仍有产出**：vs ctrl 7:3 的胜利改善来自规则重写本身，无需新语汇——harness 反思环路的语汇瓶颈（§10.4 三条判据）尚未成为强度瓶颈。

产物：`output/plan-oneshot/roundT5-calib/`（plans/leihe.nn2.json + 双侧 eval 齐全的两次批跑）；配置 `examples/plans/roundT5-calib/`。

**勘误（2026-08-31 晚）**：本轮实现漏把 `opp.threat.lethalP` 加进 fields.ts 的 `STATIC_FIELDS` 白名单（求值器/prompt/文档齐全，唯独校验器 `isKnownPlanField` 不认）——prompt 宣传可用、validate 报 `unknown field` 拒收，harness 自相矛盾。oracle-free 臂的模型实测撞上（"想在 when 里用 opp.threat.* 被校验器拒绝"）。roundT5/T6 的"0 采用"读数不受其影响（transcript 显示模型从未起草过 lethalP 规则，不存在被拒记录），但它是悬在采用率实验头上的隐性阻断器：**任何 lethalP 尝试都会以校验失败告终**。已一行修复（fields.ts:133）+ 探针验证通过 + 116/116 测试绿。教训并入 §10.2 同一条：新字段落地 checklist 必须含"白名单/求值器/prompt 文档/校验器"四面齐查，缺一面即假可用。

### 10.7 roundT6（2026-08-31）：具体读数下的采用率检验——0 尝试；lethalP 判别力检验——该失误类上概率门是伪命题

**两轮反思构成 A/B**：同证据（leihe.nn2 vs-NN，seeds 20276401）、同 seed 20260855，仅 prompt 中 digest 的威胁行格式不同——nn3 跑的 15:41 启动时 evidence-extract 尚未带 `斩杀P` 列（oracle-free 对话 15:49 才加入，进程已加载旧码，并发事故见下）；nn3r 于修复后重跑，prompt 264/264 决策行带具体斩杀P 读数（0.004–1.0 分级清晰）。

- **采用读数（干净）**：nn3r 的 transcript 中模型侧 lethalP/hasCardP **0 提及、0 起草尝试**（无校验拒绝记录——§10.6 勘误的白名单 bug 潜伏未触发）。两轮互为对照：抽象定义可见（nn2/nn3）→ 0 尝试；具体读数入证据（nn3r）→ 仍 0 尝试。**采用瓶颈既不是可见性也不是读数具体性，而是模型的规则起草先验**——glm-5.3-flash 只用可从证据直接归纳的确定性门槛。
- **lethalP 判别力检验（本轮最关键读数）**：nn2 避难链 9 个有 oracle 对照的 blunder 触发点上 lethalP = 1.0/1.0/0.944/0.944/0.822/0.763/0.763/0.071/0.004——按建议阈值 ≥0.5 设概率门**只能滤掉 2/9**，其余 7 个"几乎确定被斩"的局面照样触发照样错。全集对照（vs NN）：lethal=true 75 点中 lethalP<0.5 的 11 点 blunder 率仅 9%、≥0.5 的 54 点 37%——低概率确实标志安全，但避难链不在那些点上触发。**症结不是上界误报而是动作选择：真斩杀局里切人承接本身就是错的**（oracle 在这些点推荐快牌/抢攻/莲花酥）。nn3r 模型的结构性诊断（"4/4 失误根因是 0 费快牌缺位，由耳环截流"）被数据事后支持——§10.6 的"局部修补胜出"应修正为：**在此失误类上概率语汇本就是伪命题，模型的不采用是正确判断**。

**A/B 策略分歧与强度**（同批对比；nn3=无读数 prompt 产物，nn3r=有读数 prompt 产物）：

| | nn3 | nn3r |
|---|---|---|
| 避难链处置 | 合并 3→2 条、HP≤4→**≤2**、降为最后手段 | 本体保留（HP≤4），改打"34 位耳环截流 0 费快牌"根因 |
| vs ctrl 比分 | **6:4** | 2:8 |
| vs ctrl vd / blunder | +0.0279 / 53.4% | +0.0289 / 62.3% |
| vs NN vd / blunder / crash | −0.0194 / 54.2% / 23.7% | **−0.0007** / 48.2% / **18.1%** |
| 避难链触发/失误 | 4触 3失误 | 11触 11失误（vs ctrl 6/6、vs NN 5/5） |

读数：nn3r 的每动作质量（vd ≈ 0、crash 18.1% 历代最佳）更好，但 vs ctrl 比分 2:8 大幅劣于 nn3 的 6:4——保留 HP≤4 避难链在 ctrl 战 6 次触发全失误，直接送掉可赢局；nn3 的收紧版触发 1 次。**每动作质量指标与比分的背离达到极值**（vd≈0 仍 0:10；vd 相同 +0.028 却 6:4 vs 2:8），再次钉死"N=10 比分需多指标互证"的纪律反向案例：这里连 vd 都不能解释比分。

**四代威胁族总账**（触发/失误，blame 归因口径；nn2 的 trace 实际命中 9 次但 eval 对齐仅 4 点入榜，跨批对齐率不同，绝对数仅供参考）：

| 代 | 避难链形态 | 触发/失误 |
|---|---|---|
| nn1 | lethal 裸奔 | 13触 8失误 |
| nn2 | +HP≤4 | 4触 4失误 |
| nn3 | +HP≤2、末位 | 4触 3失误 |
| nn3r | 保留 HP≤4 | 11触 11失误 |

**并发事故记录（实验卫生）**：roundT6 首次反思（nn3）启动后 8 分钟，oracle-free 对话修改了 evidence-extract.ts/run-plan-reflect.ts（15:49–15:50），运行中的进程持有旧码——nn3 的 prompt 无斩杀P 列，前提失效但未察觉，直到逐行核 prompt 才发现。教训：**长时 LLM 任务的 prompt 产物必须事后核验关键段落格式**（本管线已有 .prompt.txt 落盘，grep 一行即可），并行开发期尤甚。

产物：`output/plan-oneshot/roundT6-lethalp/`（plans/leihe.nn3.json + leihe.nn3r.json + 四场批跑双侧 eval 齐全）；配置 `examples/plans/roundT6-lethalp/`。

## 11. roundT7 水债线（2026-08-31）：体系认知与 combo 落地检验

中速卡组水债（火债2301/纯水2201/菲谢尔1401，known_deck=红牛），用户指定分析维度：模型对卡组体系的认知清晰度 + 多卡联动 combo 的合理运用。产物 `output/plan-oneshot/roundT7-shuizhai/`，配置 `examples/plans/roundT7-shuizhai/`。

### 11.1 r0 起草的体系认知评估（对照 data 源码地面真值）

- **正确**：潮涌与激流 4+N 缩放数学与"≥1 召唤才值得放"的引擎→终端联动（p16/p34）；仙跳墙斩杀窗口（焚毁之锋 5→8"越 10HP 线"）；送你一程正确识别红牛岩队的阿丑/净焰剑狱为目标（未犯"岩队无召唤物"想当然）；潜行资源管理；新风击倒续动；dice_prior 定量 reroll（P≈75.8%）。
- **错误/缺口**：①奥兹协战描述的是天赋强化版（普攻后协战 2 雷需噬星魔鸦，牌表未携带）——把天赋版当基础版写进规则；②悉数讨回注释"战斗行动=慢速"概念恰好反了（战斗行动=不耗行动权），所幸调度行为正确；③**感电时序完全缺席**——36 条规则无一讨论召唤物结算顺序与感电的配合；④开局选火债压制（潜行换血+2 能快爆发）而非常规洛蒂娅铺场，引擎延迟到 2 回合后——中速读法自洽但非主流。

### 11.2 r0 实测：认知没有翻译成执行——召唤引擎整场零点火

vs NN（seeds 20276401）：0:10，**覆盖率 81.2%/fallback 18.6%（49 次全是 declareEnd）**，blunder 53.3%、vd −0.0530。技能统计：洛蒂娅 E **0 次**、潮涌 Q 0 次、焚毁之锋 Q 14 次（唯一正常终端）、洛蒂娅普攻 22 次（沦为承伤沙包）。双重病因：①p34 铺场规则的 then **误带 `target: opponent.active`（召唤技能无目标）构成死映射**，11 次 when 全真但零执行；②火债进攻规则优先级全面压在铺场之前+遍地"留 3 骰进攻"门槛挤掉水骰窗口。vs ctrl 3:7，vd −0.0494。

### 11.3 nn1 反思（证据含斩杀P 读数 + 白名单已修复）：引擎修复与 thenMiss 治理

模型实质使用 harness 工具链确诊根因（"rule_drilldown 确认""plan_simulate 证实"多处）：p43 修复纯水幻造死映射；p36 新增轮转引擎（"oracle 在 20+ 决策点推荐切洛蒂娅"，引用 game-0006:3 gap10.55 等点位）；成串 thenMiss 治理（交给我吧死映射换最好的伙伴、斩杀线 HP 门槛削减 107/28/30 次空转、兜底规则经 plan_simulate 验证"收紧会使静态 fallback 15.9%→55.6%"而保留）。**lethalP 采用率第三例 0**（最强检验条件：白名单已修、证据 252/252 行带斩杀P、卡组斩杀敏感；transcript 0 提及 0 尝试）——"glm-5.3-flash 的规则起草先验不含概率阈值范畴"结论稳定。

### 11.4 nn1 实测：引擎点火，vs ctrl 9:1（全谱系最佳）

| | r0 | nn1 |
|---|---|---|
| vs ctrl 比分 | 3:7 | **9:1** |
| vs ctrl vd / blunder | −0.0494 / 61.6% | **+0.0362** / 56.4% |
| vs NN vd / blunder | −0.0530 / 53.3% | **−0.0340** / 47.0% |
| 洛蒂娅 E 使用（vs NN / vs ctrl） | **0 / 0** | **18 / 16** |
| 潮涌 Q（同序） | 0 / 0 | 1 / 5 |
| 仙跳墙（vs ctrl） | 未统计 | 12（斩杀窗口被实际使用） |

combo 落地判定：铺场→缩放爆发链路真实运转（vs ctrl 潮涌 Q 5 次且召唤物在场）；菲谢尔 3 能爆发也启用（至夜幻现 Q 5 次）。新头号失误规则是新增的 **global:44（零水骰调和转水）：20 触发 20 blunder**——"调和烧骰换铺场"被 oracle 全面否定，下一轮校准目标明确（调和时机/是否该调和）。global:43 铺场本体健康（29 触发 8 失误，oracle 一致率 72%）。

### 11.5 遗留

覆盖率 81-85% 未改善（fallback 仍 15-18%，全 declareEnd）——规则条件特异性（多重骰门槛）与局面多样性的矛盾是水债线的结构性弱点；体系修复（引擎点火）带来的是上限提升（9:1），覆盖率洞是下限问题。感电时序在两代计划中始终缺席——体系认知的最深层缺口。

## 12. harness 基建治理（2026-09-04）：覆盖率护栏 + validate 解码修复 + tsc 清零

本轮把三项遗留基建缺口一次清掉，harness 侧反思证据链视为**已完善**（静态分析工具、校验、聚合证据、护栏齐备）：

1. **覆盖率护栏（fallback_report）**：新增 reflect 模块 `fallback_report`（`src/runtime/plan-oneshot/cli/modules.ts`）——把 fallback 决策点按（我方出战角色 × 回合）聚类，类内给手牌/骰面/威胁态分布与代表行，头部带判定提示（显著聚类补规则 / 高威胁 fallback 优先补防御）。harness 多轮反思（turns>1）**双臂默认注入**（oracle 臂此前无默认注入，engine-only 臂保留 fallback_detail 全文并追加聚合报告）；两份 `harness-protocol-reflect*.md` 已同步。直接针对 §11.5 的覆盖率洞：此前 fallback 只有 top-N 平铺，LLM 无法判断缺口聚在哪里。
2. **plan:validate 不自动解码 known_deck 修复**（`run-plan-validate.ts`）：此前 CLI 只解 `context.deckCode`，known_deck 计划的 `opp.hand.hasCardP.*` 一律误报"起草时对手牌表未知"。现与 batch-runner 的 `loadPlanWithValidation` 对齐（known_deck 解对手分享码、mirror 用自身牌表），实测：牌表内卡零警告、牌表外卡正确报"疑似死规则"。
3. **tsc 预存错误清零（416→0）**：根因大头（284 个 TS18048 + 28 个 TS2722）是 core `mutator.ts` 的 `declare global var console: Console | undefined` 经 dist d.ts 打包**泄漏进下游编译**（core 的 exports 中 `types` 条件先于 `development`，tsc 恒解析到 dist；rolldown-dts 又把该全局声明内联进 assets-manager/custom-data-loader 的 d.ts）。修复：core 新增 `src/console.ts` 导出 `optionalConsole`（模块级 `(globalThis as {console?: Console}).console` 安全读取），mutator/query/game 等 8 个文件改用之，重建 core/assets-manager/custom-data-loader 的 dist。剩余散点（assets-manager 的 `Promise<unknown>`、policy/mcts 的 EntitySnapshot 形状、plan-patch 收窄等）为类型级修复。

**清理中上报的疑似真实 bug（仅类型绕过，未改逻辑）**——三例经核实均属实，**2026-09-01 已全部专修完毕**：
- `src/learning/rl/candidate-exporter.ts:188`、`src/runtime/policy/candidate-semantics.ts:613`：`initiativeSkillConfig.skillType` 字段不存在（在 `SkillDefinitionBase` 上），运行时恒 undefined → 技能类型识别恒 null。**修复**：直读 `skill.definition.skillType`，去掉强转。注意行为变化：`skill_type:{normal|elemental|burst|technique}` / `burst_enable` 标签由恒缺失转为正常产出（burst 此前仅靠 energy-cost 兜底部分挽回），新旧数据集与 benchmark 分数口径不可直接对比。
- ~~`src/mcts/*-policy.ts`~~（订正：实际在 `src/runtime/policy/mcts-policy.ts` 与 `gi-ml-mcts-policy.ts`；`src/mcts/` 侧的 `takeActionPhaseSnapshot` 形状本就正确）snapshot 的 supports/summons/combatStatuses 缺 `id`/`maxUsage`，与 `EntitySnapshot` 形状不符（`hashSnapshot` 读得 undefined，置换表/叶值缓存键失真，且与引擎续推路径的真实 id 哈希口径不一致）。**最小修复**：6 处字面量补 `id`/`maxUsage`，`EntitySnapshot` 增 `usagePerRound?: number` 可选字段（叶值启发式在读，保留以免改评估行为），去掉全部 `as unknown as` 强转。影响面确认：ISMCTS（`ismcts.ts`）不经快照层、完全不受影响；仅 `kind: "mcts"` / `"mcts-gi-ml"` 两条 benchmark policy 驱动的 `MctsEngine` 搜索受波及。
- `src/runtime/policy/portfolio-snapshot.ts:109-115`：运行时期望 `EntityObservationV1.entities`，类型上不存在（生产者 `mapVisibleEntity` 亦不产出；带 `entities` 的是 `CharacterObservationV1`）。**最小修复**：删除该死循环，保留单个可见变量路径。对照 data 核实：6 张带 `variable_at_least` 前置的 deferred_bank 支援牌（立本/白手套和渔夫/亚瑟先生/桓那兰那/冒险家协会/那夏镇）前置变量均恰为 `visibleVarName`，删除后行为零变化；遗留地雷：流明石触媒（323007）的 `playedCard` 为 hidden 变量，若其 profile 由 recurring_engine 改判 deferred_bank，前置将恒不满足（恒 progressing）。

专修验证（2026-09-01）：gi-agent `pnpm check` = 0 错误；mcts/policy/learning(rl) 128/128；全量 354/356（仍为预存的 2 个 benchmark/cli-config ENOENT 环境性失败）。

验证：gi-agent `pnpm check` = 0 错误；plan-oneshot 117/117；mcts/policy/learning 201/201；全量 354/356（仅 benchmark/cli-config 2 个 ENOENT 环境性失败——缺 `output/combat-windows/library.sample.json` 生成物，与本轮无关）。core 侧余 4 个预存错误（未跟踪的 preview-heal.test.ts ×3 + builder/card.ts ×1，HEAD 即红，不在本轮范围）。
