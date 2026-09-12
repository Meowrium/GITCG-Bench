# 无 Oracle 自进化臂（engine-only evidence）：实施方案

> 日期：2026-08-30。状态：**设计待实施**（在新对话中实施）。
> 背景：`2026-08-21-one-shot-gameplan-benchmark.md`（组件设计 + round0–22）、`2026-08-29-why-llm-plan-weaker-than-nn.md`（round23+ 主实验日志，下称"round23 文档"；§10 威胁语汇专项）。

## 0. 目标与命题

新实验臂：**NN 输出不进入 LLM 迭代环路**。LLM 仅靠完善后的 harness（静态分析工具 + 引擎侧机械指标 + trace 钻取 + 静态回放）进行反思-修改自进化；NN oracle 只用于**环路外**的强度统计（每代 blunder/valueDelta 测量，写报告时才读）。

被测命题：**无 oracle 证据时，harness 的静态工具链能否替代 oracle 成为反思的有效 ground truth**。已知历史基线：oracle 介入前的反思是噪声追逐（findings §10.3、round3 双侧龟缩化死锁）；oracle 归因是消融证真率的主要来源（round2 全量消融 15/32 证真）。本臂检验"静态工具 + 机械指标 + threat 读数"的组合能把反思质量推到离 NN-in-loop 臂多近。

对照参照：NN-in-loop 臂由 roundT3（雷鹤臂，`output/plan-oneshot/roundT3-threat-leihe/`）充当既有参照系。

## 1. 泄漏通道切断（核心工程项）

NN 产物当前有四个入口进反思环路，全部需要显式处理——**不允许依赖"文件恰好不存在"的隐式卫生**（旧 run 目录常有 ISMCTS 残留 `plan_eval.json`/`plan_eval_summary.json`）：

| # | 通道 | 位置 | 处理 |
|---|---|---|---|
| 1 | evalSummary 注入（blunderRate + perRule 归因） | `run-plan-reflect.ts:231-250` | engine-only 模式下跳过 |
| 2 | fullDigest / top-8 证据行的 oracle 列（推荐动作 + gap + ✗/~/✓） | `evidence-extract.ts:285-297`、`:189-198` | 行格式降级为引擎侧列（digest + 命中规则 + 计划选择 + threat 读数 + thenMiss/fallback 标记） |
| 3 | harness 模块读 per-game eval 文件（rule_drilldown / decision_detail 的 oracle 推荐与 `:261` 的 oracle 回算原文 dump） | `cli/modules.ts:185-261`（`evalSuffix` 贯穿 `:55/194/349`） | 模块注册表按臂过滤：engine-only 臂中 drilldown/detail 只保留 trace 部分，eval 读取分支整体门控 |
| 4 | reflect prompt 的 oracle 中心措辞（"✗=oracle 判定失误"、falsifiableClaim 示例"oracle blunder 应减少"） | `prompts/reflect-system.md:15,27-36` | 条件化变体：无 oracle 时 ✗/~/✓ 语义段、falsifiableClaim 示例改为机械指标锚点 |

**统一开关**：`plan:reflect` 与 `plan:ablate` 新增 `--evidence engine-only`（默认 `oracle`，保持既有行为）。engine-only 下：

- 启动时断言 run 目录内 `plan_eval*.json` / `plan_eval_summary*.json` 均不存在（存在即 fail-fast，防止陈旧文件静默泄漏）；
- evidence-extract / modules 的所有 eval 读取路径短路；
- prompt 选用 oracle-free 措辞变体。

**消融回路的口径切换**：`plan:ablate` 现行判定比较 blunderRate（oracle 派生）——本臂必须换成引擎侧可机检判据：thenMiss 归零、coverage/fallback 变化、胜率区间（N≥20，同 seed 梯）。否则消融结果回喂下一轮反思即构成泄漏。

## 2. LLM 剩余的进化燃料（无 oracle 后的有效信号清单）

按历史迭代中实际驱动过修订的力度排序：

1. **thenMiss 探针 + perRuleHits 热力图**（引擎机械指标）——修死规则的最稳信号（satied/+omni 两轮真 bug 均由它驱动）；
2. **`opp.threat.*` 读数**（round23 文档 §10，引擎派生非 NN）——无 oracle 时成为防御归因的**唯一定量抓手**：`lethal=true` 而未防（无切人/无治疗/继续贪输出）的点可直接当证据，价值较 NN-in-loop 臂反而上升；
3. **plan_simulate / plan-replay 静态回放与反事实断言**（patch 协议已有）——最接近 oracle 替代品的静态工具；
4. **fallback 覆盖洞**（fallback 率 + fallback_detail 模块应设为默认注入，round23 §5 C 级遗留项）；
5. 逐局胜负 / avgRounds / declareEnd 占比 / 行为统计（引擎侧权威统计注入原则不变）；
6. predictions 校准（强制字段，赛前预测 vs 实际）；
7. 静态模块：dice_prior / card_detail / character_detail / field_reference。

## 3. 对手分布：交叉对局补偿（本臂的待验证子命题）

固定单一对手自进化会过拟合其形态（round17 跨模型对位脱钩教训）。**用户决定**：用不同卡组的交叉对局作为部分补偿，且该补偿的效果本身需要被观察和验证。

设计要点：

- **证据对局**（喂反思）：每代在 2–3 个不同卡组对手上跑（如 红牛ctrl + 雷鹤ctrl + 水凝ctrl），合并进同一反思输入包——证据分布更宽，修订不易钉死在单一对手形态上；
- **度量对局**（环路外）：必须保持固定——同 ctrl 对手 + 同 seeds 梯做代际主指标（blunder/valueDelta，每代数百决策点）；另设**泛化检验批次**：对未参与证据轮换的 held-out 对手各跑 10 局，跟踪"交叉补偿是否提升泛化"；
- **验证子实验**：同 r0 起点跑两个亚臂——③a 单对手证据 vs ③b 交叉对手证据——比较两者在 held-out 对手上的 NN 度量差异。这是"交叉补偿是否有效"的判定性数据；
- 口径注意：交叉证据合并时按对手标注分组统计（reflect prompt 里分对手给 perRuleHits），避免多数派对手稀释少数派信号；每代 seeds 按对手分别固定（对手内同 seed 梯）。

## 4. 护栏（无 oracle 时的已知退化模式，全部引擎可机检）

| 模式 | 出处 | 机检信号 | 护栏位置 |
|---|---|---|---|
| 噪声追逐（把胜率噪声当信号） | findings §10.3 | N<10 禁止方向性强断言（既有纪律保留） | reflect prompt |
| 龟缩化死锁（declareEnd 占比逐代上升） | round3 | declareEnd 占比、avgRounds 代际监控 | reflect prompt + 聚合报告 |
| 覆盖崩坏（修剪换 fallback） | round5/6、round18 | coverage 下限闸（建议校验器 warning，round19 结论遗留） | validate/reflect |
| "改没了"（条件收紧后零命中） | round2 消融 | perRuleHits=0 告警进反思输入 | evidence 聚合 |
| 反思退化为叙事 | round23 §5 | falsifiableClaim 必须锚定可机检指标（thenMiss/coverage/胜率区间） | prompt + 输出 schema |

## 5. 实验臂配置与产物布局

- **目录**：`output/plan-oneshot/roundS1-selfevo/`（S = self-evolution 系列，与 NN-in-loop 的 roundT* 区分）；批跑配置 `examples/plans/roundS1-*/`；
- **谱系**：planId/parentPlanId 链照常；计划命名带臂标（如 `leihe.eng.r1.json`）；
- **起点**：与 roundT3 同一 `leihe.ctrl.r0`（round22-g53f，glm-5.3-flash 起草）——两臂同起点可比；
- **三臂对照**：
  1. NN-in-loop（roundT3 既有数据充当参照，注意其证据含 threat 读数）；
  2. no-NN + 完善 harness（本臂主线；含交叉对手证据亚臂 ③b）；
  3. 静置对照（r0 不反思，每代同批重测——分离"自进化"与"重测回归/测量噪声"）；
- **环路外 NN 度量**：每代 games 照常跑 `plan:eval --oracle nn`（side0/side1），产物 `.nn.json` 落 run 目录但 reflect 物理不可见（§1 的断言保证）；
- **成功判据（事先写死）**：主线臂 3 代内环路外 blunder 单调下降且 r3 显著低于 r0；与 NN-in-loop 臂的代际斜率对比；交叉亚臂在 held-out 对手上的泛化差。关键代际断言用 20 局（N=10 比分仅辅助）。
- **已执行（2026-08-31，roundS1~S3 三代）**：双血脉演进（③b 主线 3 对手合并证据 r0→r1→r2→r3；③a 亚臂仅镜像证据 r0→r1a→r2a→r3a），各代报告 `output/plan-oneshot/roundS{1,2,3}-selfevo/report-*.md`，代际趋势图与决策树规模统计（规则数=global+phase、条件数=全部 when 子句合计）在 `roundS3-selfevo/figures/`（`gen_figures.py` 可复跑）。终审结论：③a 四代 blunder 单调下降（0.6070→0.5469）达成判据；③b 非单调但 r3（0.5814）显著低于 r0，r3 代两血脉强度汇合（胜率 55-60% vs hongniu.ctrl.r0）。
- **已执行（2026-09-01，roundS4~S8 续跑五代，主线 §12 基建修复后）**：双血脉各自续 5 轮至 r8/r8a（planId 链逐代核实无断链），协议与 S1~S3 完全一致。**饱和结论：胜率饱和于第 3 代（③b 六代锁 60%）；价值指标 r5~r7 见顶（③b vd -0.0016@r6、③a vd +0.0074@r7a 后走平/微退）；r7 起单规则消融全部 inconclusive（效应 < N=20 噪声地板）= 实质饱和，主梯迭代建议止步 9 代**。③a 的 r8a blunder 0.5281 为全系最优但伴随 moyou held-out 三代连退（过拟合镜像证据迹象），不读作未饱和。综合报告 `output/plan-oneshot/roundS8-selfevo/report-r4r8.md`（九代总表/held-out/消融汇总/护栏/树规模/收敛信号 + 8 张代际图，图产脚本见 `scripts/README.md` nn-valuediff 节）。§12 修复对本臂口径的影响判定：NN 回算链路不引用 candidate-semantics，oracle 度量 r0~r8 同口径可比；实际增益在反思证据文本质量（fallback_report 注入 + skill_type 标签正常产出）。

## 6. 实施清单（里程碑）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| S-M1 | `--evidence engine-only`：reflect 开关 + 启动断言 + evidence-extract 降级行格式 + modules 门控 + reflect-system oracle-free 措辞 | 构造含 NN eval 文件的 run 目录，engine-only 反思全程无任何 oracle 字样进入 prompt（transcript 可机检）；既有测试全绿 + 新增门控测试 |
| S-M2 | `plan:ablate` 引擎侧判据开关 | 消融臂判定不读 eval 文件，判据为 thenMiss/coverage/胜率区间 |
| S-M3 | fallback_detail 默认注入 + perRuleHits=0 告警聚合 | 反思输入包含这两项 |
| S-M4 | 交叉对手证据合并（分对手分组统计进 prompt） | 3 对手证据包组装成功，分组统计正确 |
| S-M5 | 首轮三臂跑通 + 环路外 NN 度量报告 | r0/r1 两代数据落盘，报告只引用环路外 NN 数字 |

## 7. 不在本臂范围

- 不改 NN oracle 本身（版本/tau 钉死现状）；不改 threat 字段语义；
- counters/自由计数器仍暂缓（§10.2 架构决定不变）；
- 对手手牌驱动的增伤概率估算（明牌表 + 手牌/牌库计数推断）——已确认为可行方向，单列任务，与本臂正交。

## 8. 给实施者的现场提示（近期踩坑记录）

- Windows + Git Bash：用 `pnpm.cmd`；环境变量用 bash 前缀内联（`OPENAI_API_KEY` 等**不入任何仓库文件**）；GLM 长反思用 `LLM_TIMEOUT_MS=3600000 --stream --max-tokens 98304 --thinking`；
- harness 反思失败打捞：`scripts/salvage-reflect-transcript.ts`（brace 失衡修复 + finalizeMerged 同管线收尾）；harness 的 final/draft 也接受 `result` 键包装（roundT1 教训后已在协议提示中注明）；
- 从运行时对象取数的代码必须配真实数据集成测试（roundT2 的 skillType 形状 bug：固件单测镜像了错误假设，实战全零）；
- 度量纪律：跨批绝对值不可比（ctrl 侧 blunder 跨轮漂移 50.3%→74.6% 有实证），只做同批相对比较；10 局比分跳变需 blunder/valueDelta/coverage 同向互证（round23 文档 §9.3）。

## 9. 新语汇同步注记（2026-08-31，roundT5 之后）

本节替代 §7 中两条已过时表述（"不改 threat 字段语义"、"对手手牌驱动的增伤概率估算……单列任务"——后者已实现入库）。

**代码层面无需任何同步动作**：新语汇实现在共享 harness（`src/runtime/plan-oneshot/`），oracle-free 臂同库同包，下一次 reflect/批跑自动继承。新增内容：

- `opp.threat.lethalP`（threat.ts）：概率化致死——逐技能判致死且可支付（能量+dice.total 上限），达标技能取 `binomialTail(diceTotal, P_ELEMENT_OR_OMNI, elementDice)` 的 max；trace 快照自带 `lethalP` 列（roundT5 起产物均有具体读数，已验证非全零：0.114/0.684/0.9 等）。
- `opp.hand.hasCardP.<defId>`（fields.ts）：超几何持牌概率，`PlanFieldContext.opponentDeckCards` 赛前明牌注入（非上帝视角）；batch-runner 双侧牌表自动接线，批跑/回放无需手工传参。
- validate `warnings` 通道：hasCardP 引用不在对手牌表的卡→"恒 undefined 疑似死规则"警告（不影响 ok），警告会表面化进 reflect 的 prompt——**oracle-free 臂的 transcript 机检若按固定段落匹配 prompt 结构，需把 warnings 段纳入白名单**（其文本不含 oracle 信息，但会改变段落布局）。

模型面向的字段规范以 `src/runtime/plan-oneshot/prompts/field-reference.md` 为唯一事实源；设计理据与校准纪律（"lethal 是上界/安全网，lethalP 是概率/主防御触发，建议阈值 ≥0.5"）见 `docs/plans/2026-08-29-why-llm-plan-weaker-than-nn.md` §10.6。roundT5 关键经验：模型在 6 轮预算内倾向旧语汇局部修补（HP 门）而非新概率语汇——oracle-free 臂若观测到同现象属预期，不是本臂缺陷。

**缺口联动（2026-08-31 晚）**：你臂报告的三缺口中，缺口①（when 里 `opp.threat.lethalP` 被校验器拒）根因是 fields.ts `STATIC_FIELDS` 白名单漏登记（求值器/prompt 齐、白名单缺），已由主线一行修复并探针验证（§10.6 勘误）——重跑作者/反思前拉取该文件即可。缺口②③（add 型 verdict 构造消融臂、消融基线 thenMiss 语料）归你臂 S-M2 范围，主线未动 `ablate` 相关代码，无冲突。

## 10. harness 基建同步注记（2026-09-04，主线 §12 对应）

主线完成三项基建治理，oracle-free 臂同库自动继承，无需任何同步动作：

- **fallback_report 覆盖率护栏**：新 reflect 模块（fallback 按 出战角色×回合 聚类 + 手牌/骰面/威胁分布 + 代表行 + 判定提示），harness 多轮反思 turns>1 **双臂默认注入**——本臂（engine-only）在既有 fallback_detail 全文之外追加该聚合报告。两份 `harness-protocol-reflect*.md` 已同步（若本臂 transcript 机检按固定段落匹配注入文本，需把 fallback_report 段纳入白名单——纯引擎侧机械指标，无泄漏）。
- **plan:validate known_deck 解码修复**：CLI 与 batch-runner 对齐（known_deck 自动解对手牌表），hasCardP 误报"起草时对手牌表未知"消除。
- **tsc 416→0 清零**：根因是 core 的 `var console` 全局声明经 dist d.ts 泄漏（core 新增 `src/console.ts` 的 `optionalConsole`，8 文件改用 + 三包 dist 重建）。**注意：若本臂有基于旧 dist 的长期驻留进程/缓存，重跑前重新 `pnpm install` 或重建 core 即够；源码态（gnx/NODE_ENV=development）无感。** 治理中上报的疑似真实 bug 清单（initiativeSkillConfig.skillType 恒 undefined 等）见主线 §12，均只做了类型绕过未改逻辑。
