# 候选制 r0 多候选:单对话流程改造与 A/B 复测(2026-09-09)

> 实验记录。前置文档:[2026-09-07-reflect-evidence-gap.md](./2026-09-07-reflect-evidence-gap.md)(候选制设计与旧流程 A/B);
> 机制实现口径见 [../AGENTS.md](../AGENTS.md) `plan:author --candidates` 条目。

## 1. 本次改造(实验对象)

旧流程(`--candidates N` v1):N 个候选在 **3 次互相不可见的独立对话**中起草,再由同模型 +1 次评审择一。
旧流程暴露的问题:候选间多样性无机制保障;评审 6/6 全选 #0(位置偏置无法与质量区分)。

新流程(2026-09-09 落地,`cli/candidate-session.ts`):

- **单对话分轮起草**:N 个候选在同一对话内顺序产出,第 k 轮可见前 k-1 个候选的完整 JSON,prompt 要求沿路线维度显式拉开距离;
- **must-differ 机检**:新候选 planId 与已收录候选相同 → 视为可修复失败回注,计入 `--repair` 预算;任一候选预算耗尽 → 整格失败(全有全无语义不变);
- seed 公式不变(`seedBase + index*100 + attempt`),评审步与产物形态(alternates / candidate-review 旁档)不变;
- 同批落地 **skill_def_id**:技能区分精确到具体技能 defId(纳西妲 17032/17033、纯水 22012/22013 类同类型多战技),渲染按技能名对齐取数,运行时对 proto `skillDefinitionId` 硬过滤,锚点/fields-lint 从「同类型全变体最宽松」切换为精确变体匹配。

## 2. 实验设计

2 模型 × 2 臂(single / cand)× 3 卡组(d2 双冰雷神、d5 水菲草召唤、d6 莫娜凝光),v4.0.0 环境,mirror 对局,
每格 40 局 alternateFirstPlayer。判据:N≥20 且 |Δ胜率| > 3pp。计划侧 = cand 臂。
驱动:`.tmp/candidates-ab.mjs`;产物:`output/candidates-ab-v40/`。

## 3. 结果

### 新流程(本轮,12/12 起草 + 6/6 对局全部完成)

| 模型 | 卡组 | cand 胜率 | Δ(pp) | 判定 | 评审选择 |
|---|---|---|---|---|---|
| qwen3.8-flash | d2 | 50.0% | 0.0 | 平 | #0 |
| qwen3.8-flash | d5 | 32.5% | -35.0 | single 优 | #0 |
| qwen3.8-flash | d6 | 52.5% | +5.0 | **cand 优** | #0 |
| deepseek-v4.1-flash | d2 | 70.0% | +40.0 | **cand 优** | #0 |
| deepseek-v4.1-flash | d5 | 50.0% | 0.0 | 平 | #0 |
| deepseek-v4.1-flash | d6 | 37.5% | -25.0 | single 优 | #2 |

战绩 2 胜 2 负 2 平,聚合胜率 48.75%。

### 新旧流程对比

| 维度 | 旧(3 次独立对话) | 新(单对话分轮) |
|---|---|---|
| 战绩 | 1 胜 5 负 | 2 胜 2 负 2 平 |
| 聚合胜率 | 35.8% | 48.75%(+13pp) |
| 评审选择 | 6/6 选 #0 | 5/6 选 #0,1 格选 #2 |
| 候选多样性 | 无机制保障 | 6/6 格产出 3 个不同 archetype 标签,评审理由显示开局/调度/路线实质分化(如 d6:aggro_tempo / control_attrition / combo_otk_banking) |

## 4. 判读

- **多样性机制生效**:must-differ 机检 + 前序可见使候选路线实质分化;评审首次打破全选 #0。
- **结论软化但不翻转**:cand 臂从「明确不推广」变为「与 single 平价、无稳定优势」,而成本是 3 份起草 + 1 次评审。默认流程仍用 single;候选制保留为实验臂,价值主要在 `alternates.json` 为 reflect 换轴提供现成素材。
- **评审质量是当前瓶颈**:唯一非 #0 选择(deepseek d6 选 #2)恰是 cand 输得最惨的格(覆盖 62.0%/兜底 37.6%,single 侧 84.1%/15.2%)——评审挑中了激进但漏防的树;5/6 选 #0 的位置偏置仍未消除。
- **单格结论稳定性有限**:qwen d2 旧流程 +40pp 大胜、本轮 0.0 平——同臂跨轮方差大(单种子起草 + 40 局),不宜过度解读单格。

## 5. 预留问题(未决)

> **LLM 是否在「候选—挑选」流程中额外获取了判断力?**

cand 臂的评审步是同模型 +1 次「凭锚点论证择一」的调用。这意味着 cand 臂相对 single 臂的
差异其实是两股力量的合流:①候选多样性(路线覆盖);②「生成 N 份 → 批判择一」的双阶段结构
本身(等价于一次自蒸馏/自批判)。当前实验无法分离二者——cand 的收益(或损失)有多少来自
候选池质量,多少来自评审这一额外认知步?

可设想的对照臂(后续实验候选):
- **随机选择臂**:候选照样生成 3 份,但用随机数而非评审择一——剥离评审,只留多样性;
- **乱序评审臂**:评审输入的候选顺序随机打乱——检验位置偏置对选择质量的因果影响;
- **自检 single 臂**:不起草候选,single 计划 +1 次同成本自我批判修订——控制「额外一次 LLM 调用」变量。

## 6. 产物指针

- `output/candidates-ab-v40/report.md`(本报告数据源)、`STATE.md`、`RUNBOOK.md`
- `plans/<model>/cand.<deck>.json.alternates.json`(全部 3 候选 + 评审短评)
- `plans/<model>/cand.<deck>.json.candidate-review.json`(评审原文)
- `plans/<model>/*.anchor.json` / `*.anchor-assertions.json`(锚点与机检账)

## 7. 附属改造:锚点首轮合规指标(同日落地)

killMath.damage 非数值这类锚点机检失败**不做类型转换兜底**(理由:语义会糊、会掩盖模型纪律性信号、
重试本身即质量机制、解析器蠕变),改为度量:旁档新增 `attempts` / `firstAttemptIssues`(五类机械归类:
missing-number / cost-mismatch / damage-over-allowance / not-in-deck / other),`candidates-ab.mjs`
报告聚合「锚点首轮合规」节(模型×臂首轮通过率 + issue 分布;旧旁档 n/a 不计入分母)。
本轮观测样本:deepseek 3 格触发锚点重试,qwen 0 格。
