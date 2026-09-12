# One-Shot GamePlan 实验管线审计与修复记录

> 日期：2026-08-23。范围：`src/runtime/plan-oneshot/`（schema / PlanPlayerIO / trace / batch-runner / CLI）、`src/evaluation/plan-eval/`、相关 prompts 与测试。
> 背景：对 `docs/plans/2026-08-21-one-shot-gameplan-benchmark.md` 定义的 LLM 生成决策树对战实验方案做全链路代码审计。审计发现的问题按严重程度分级为 A（直接污染实验结论）/ B（影响表达力与反思质量）/ C（一致性与健壮性），本文档逐条记录问题机制、修复实现与验证结果。
> 状态：**全部修复已落地并通过单元测试**；集成冒烟见 §5。

---

## 1. A 级问题（会直接污染实验结论）

### A1. reflect 注入了错误一侧的批跑统计

**机制**：`batch-runner` 写出的 `summary.json` 全部是 side0 口径（coverage/perRuleHits 来自主计划 trace，winRate 是 side0 胜率）。`plan:reflect --side 1` 时把这些数据原样注入反思 prompt——LLM 反思雷鹤计划时看到的"规则命中热力图/覆盖率/fallback 率"是红牛计划的，胜率是反的。oracle 汇总按侧读取了，批跑统计没有；消融 CLI 做了 `1 - winRate` 换算，reflect 漏了。

**修复**：
- `batch-runner.ts`：批跑同时聚合**对手计划**的 trace（含镜像局），写 `summary.side1.json`（该计划口径的 winRate/coverage/perRuleHits/perRuleThenMiss/逐局）；`summary.json` 语义明确为主计划口径。
- `run-plan-reflect.ts`：按 `--side` 读取对应 summary 文件，胜率不再需要反转；缺文件时给出明确的"请用修复后 plan:batch 重跑基线"错误而非拿错侧数据。

### A2. 先手永远固定为玩家 0

**机制**：core 的 `stepRound` mutation 只递增 `roundNumber`，`currentTurn` 初始为 0 且只在 `switchTurn` 时翻转——无卡牌干预时先手永远是玩家 0。设计文档 §7 臂配置列了 `alternateFirstPlayer` 字段但从未实现，side0 计划在所有局中永远先手，10:0/0:10 的横扫结果混杂了未控制的先手优势。

**修复**：
- `PlanBatchConfig.alternateFirstPlayer?: boolean`：开启后奇数局交换两侧执舵位（decks 与 IO 同步交换）；
- `perGame[].planSide` 记录每局实际执舵侧；trace 文件内部 `side` 字段始终是真实执舵侧（eval 自动正确）；
- 归档文件命名保留"计划身份"约定（`plan.side0.json` = 主计划），与执舵侧解耦并在注释中说明；
- `summary.alternateFirstPlayer` 落盘，消融臂自动复现相同交替设置（保证同 seed 对照成立）。

### A3. 弱 oracle 噪声直接进入 blunder 判定、反思与消融结论

**机制**：默认 oracle 配置 dets=4/sims=32/300ms 下 visit 分布方差极大（文档自测同一局面 blunderRate 41.7% vs 强配置 16.7%）；叶子估值仅 HP 比例；消融判定用严格符号比较、无效应量阈值（56.9%→56.6% 也记 supported）。

**修复**：
- `DEFAULT_EVAL_CONFIG` 提升至 dets=8/sims=64/budget=500ms（中等强度；配置随产物落盘，跨轮比较可追溯）；
- `run-plan-ablate.ts` 新增 `--min-effect`（默认 0.03）：supported 需改善 ≥3pp，refuted 需恶化 ≥3pp，区间内记 inconclusive；
- 判定 note 附 **McNemar 配对计数**（按 `stateSignature` 把基线与臂的决策点配对：b = 基线错臂对、c = 臂错基线对），比总体率对比统计效力高得多；
- `DecisionPointEval` 增加 `stateSignature` 字段供配对使用。

### A4. "表示对不齐"的点被直接记为 blunder

**机制**：eval 中计划动作在 oracle 根候选找不到时（trace 摘要与引擎动作表示无法互认）直接 `isBlunder = true`，这些点污染 blunderRate 与规则归因表（反思的核心输入）。反向问题：switchActive 只比动作类型——计划切到 A、oracle 推荐切到 B 判为一致，低估 blunder。

**修复**：
- 对齐失败单列为 `alignmentMiss`：不进 blunder 率、不计入 perRule 分母，单独计数并随 warning 报告；`metrics.comparablePoints` 为新分母；
- `chosenEqualsEngine` 的 switchActive 分支改为比对 targetDefId（两侧均为 defId：trace 记 `characterDefinitionId`，引擎记 `to.definition.id`）；任一侧缺失时退化为只比类型。

---

## 2. B 级问题（影响计划表达力与反思质量）

### B1. `turn` 字段语义陷阱；`phase` 字段未进 prompt

`turn` 实际返回 `state.currentTurn`——当前行动方编号（0/1），不是回合数；action 决策时刻恒等于己方编号，零信息量。LLM 按"回合序号"理解写出的条件恒假。且字段白名单里的 `phase` 未出现在 prompt 封闭集合中，LLM 无法写阶段联动规则。

**修复**：
- `plan-schema-spec.md` 明确标注各字段**类型与语义**：`turn` 加"慎用"警告（行动方编号，按回合判断用 `round`）、`alive` 是布尔（`alive == true` 合法、`alive >= 1` 恒假）、新增 `phase` 字段说明；
- `compare()` 增加布尔/数字融合（`actual=true, expected=1` 视为相等），防御性消除此类死规则；
- 补单元测试钉死上述行为。

### B2. 数字 `then.target` 是运行时实体 id，LLM 必然写错

实体 id 对局内才产生，LLM 赛前只知道 defId；带数字 target 的规则永不命中且校验器不拦，计划也无法表达"切换到指定角色"。

**修复**：
- 数字 target 语义改为**角色 definition id**：useSkill/playCard 经 `defIdByEntityId` 映射后匹配（覆盖指向己方的装备类目标）；switchActive 直接与候选的 `characterDefinitionId` 比较；
- 校验器新增归属检查：数字 target 必须 ∈ 己方牌表角色（switchActive）或双方牌表并集（useSkill/playCard），否则按死规则拒绝（repairable）；
- prompt 同步更新（"数字 target 一律是牌表里的角色 defId"）。

### B3. "when 命中但 then 零匹配"的规则不可见

规则生效要求 when 真 **且** then 匹配到候选；`perRuleHits` 只统计生效规则。条件写对但 target/card_def_id 写错的死规则热力图恒 0，反思 LLM 无法诊断。round2 消融中 revise 臂大面积"改没了"正是缺乏这个中间信号。

**修复**：trace 条目新增 `thenMiss[]`（本次决策被扫描到 when 全真但 then 零命中的规则键），summary 新增 `perRuleThenMiss` 聚合并注入反思 prompt（标注"条件对了但动作映射错了"）。热力图 + 死规则探针两路信号互补。

### B4. 反思评估没有 held-out seeds（方法论，待实验执行）

r1 在 seedBase..+9 的证据上修订，若轮间对比仍在同 seed 集，是在"训练集"上评估。本轮未改代码（batch 已支持任意 seedBase），**纪律要求写入实验流程**：反思用 train seeds、轮间结论在 fresh seeds 上复验；消融保持同 seed（目的是归因非泛化）。

### B5. LLM 采样不可复现、temperature 0.7 偏高

**修复**：默认 temperature 0.7 → **0.2**（长 JSON 输出格式失败的主要来源之一）；`chatCompletion` 支持 OpenAI 兼容 `seed` 参数；author/reflect 新增 `--temperature/--seed` 并把 `{temperature, seed}` 写入 `GamePlanV1.sampling` 元数据（schema 已加可选字段）。引擎侧确定性只覆盖执行，生成侧从此也有记录。

---

## 3. C 级问题（一致性与健壮性）

| # | 问题 | 修复 |
|---|------|------|
| C1 | author 有 `autoRepairPlan` 预处理，reflect 没有——幻觉 defId 直接耗尽重试 | reflect 同样先 autoRepair 再校验 |
| C2 | author prompt 强制 fallback=conservative 而 reflect 不限制（修订可"换兜底玩家"作弊） | 统一放开三选一并写明权衡；author 推荐保守档；reflect prompt 要求原则上不改 fallback.policy、确需修改须单独 verdict 说明 |
| C3 | `actionsTakenThisTurn++` 在 requireState 之前，异常路径计数泄漏 | 改为 1-based 局部变量，仅在动作真正消费时提交计数 |
| C4 | mulligan 有规则但全 miss 时既不算 ruleMatched 也不算 fallback | 该分支标 `fallbackUsed: true`（policy "keep_all"），恢复 total = ruleMatched + fallback 自洽 |
| C5 | `planStateSignature` 直接 JSON.stringify，依赖两侧对象键序一致（隐式脆弱点） | 换成递归键排序 + 丢弃 undefined 的稳定序列化；补键序无关性测试 |
| C6 | 4 处相对路径幽灵 import `assets-manager/src/index` 且 package.json 未声明依赖 | 加 `"@gi-tcg/assets-manager": "workspace:*"`，统一包导入并移至文件头 |
| C7 | phaseId 含 `:` 会破坏 ruleRef 解析（ablate 解析失败静默 skip） | 校验器限制 phaseId ∈ `[A-Za-z0-9_-]` |
| C8 | eval 固定 CURRENT_VERSION 回算，忽略 state log 的 gv 版本 | 按 log.gv 取对应版本数据 |
| C9 | 设计文档 §10.1 要求的"oracle 信息对等测试钉死"缺失 | `determinization.test.ts` 新增 info-parity 测试：池足够大时 16 个 determinization 中恰好复原对手真实手牌的比例必须 ≤ 1/2（若退化为只洗牌序则必然 100% 复原，测试即失败） |
| C10 | reflect prompt 说 fallback 局面"兜底执行了 declareEnd"与实现不符 | 文案修正；evidence-extract 的 fallback 行附实际 `fallbackPolicy` |

## 4. 兼容性说明（重要）

以下变更使**旧 run 目录与新代码不完全兼容**，跨版本比较前须知：

1. **summary 语义变化**：`summary.winRate` 从"side0 胜率"变为"主计划胜率"；side1 数据移至 `summary.side1.json`。旧 run 目录跑 `plan:reflect --side 1` 会显式报错（不会拿错数据）。
2. **签名算法变化**：稳定序列化改变了 stateSignature 字符串。旧 trace 文件与新 eval 互相对齐会大量 miss（表现为 warning），旧 run 需要 eval 时配旧代码或重跑。
3. **消融前提**：`--baseline-run` 必须由修复后批跑产出（读得到 `summary[.side1].json` 与 `alternateFirstPlayer`）。
4. **blunder 口径变化**：alignmentMiss 排除出分母，新旧 blunderRate 不可直接比较（新口径更干净且偏低）。
5. round0–4 的实战结论受影响项：所有 side1 反思的输入统计口径（A1）、横扫比分的先手混杂（A2）、blunderRate 绝对值与消融 supported/refuted 名单（A3/A4）。方向性结论（如"反思声明有真实信号"、"知识质量≠胜率"）不受颠覆，但量化数字应视为带系统偏差的旧口径。

## 5. 验证结果

### 单元测试（2026-08-23）

| 套件 | 结果 |
|---|---|
| `plan-player-io.test.ts`（13 用例，含新增 phaseId/target/布尔同化/稳定签名 4 项） | ✅ 13/13 |
| `determinization.test.ts`（6 用例，含新增信息对等钉死测试） | ✅ 6/6 |
| gi-agent 全包 | ✅ 250 通过 / 2 失败（`benchmark/cli-config.test.ts` 因缺本机历史训练产物 rl-trio-004 的 JSON，ENOENT，环境性预存失败，与本改动无关） |
| tsc --noEmit（改动文件过滤预存 TS18048 console 噪音后） | ✅ 无新增错误 |

确定性不变量（M1 验收项）在修复后复验通过：同 plan + 同 seed 动作序列逐点一致、trace↔state log 签名对齐 ≥90%。

### 集成冒烟（2026-08-23）

修复后完整跑通一轮"起草 → 批跑 → 双侧回算 → 双侧反思 → fresh-seed 复验"（round5/round6，详见 §6），全链路无人工干预完成。过程中额外暴露并修复了 4 个审计未覆盖的缺陷，见 §6.1。

## 6. 新一轮测试记录

> 2026-08-24，修复后首轮完整迭代。模型：scnet 通道 **MiniMax-M2.5**（原定的 DeepSeek-V4-Flash-0731 在该 key 上持续模型级 429——tiny 请求也被瞬时拒绝，同 key `/models` 正常、MiniMax 200；故本轮计划质量不与 round4 的 DeepSeek 产物直接对比）。产物目录：`output/plan-oneshot/round5/`、`round6/`。

### 6.1 集成测试中暴露并修复的新缺陷

| # | 问题 | 修复 |
|---|------|------|
| N1 | `llm.ts` 只重试网络错误，HTTP 429/5xx 直接致命（scnet 限流下起草必死） | 429/5xx 指数退避重试 5 次（15s→240s），错误信息落 log |
| N2 | author CLI 在 LLM 输出缺 `context` 时 `TypeError: Cannot set properties of undefined` 崩溃，绕过修复循环（round5 首次起草真实触发） | 解析后先校验"是 plain object"、`context` 先补壳再覆盖系统字段，缺漏交校验器兜底；reflect 同步加非对象防护 |
| N3 | thinking 模式 maxTokens=16000 疑似截断长 JSON（DeepSeek 连续 3 次解析失败的嫌疑，未能确诊因 429 中断） | author/reflect 统一 32k；解析失败时输出 content/reasoning 长度 + tail 300 字符诊断 |
| N4 | `--model` 参数在 author/reflect 的 parseArgs 中不存在，传入被静默忽略（日志 `author=DeepSeek…` 暴露） | 两个 CLI 实装 `--model` 并透传 `chatCompletion`；author 名默认取实际模型 |
| N5 | 修复重试循环用同一 seed：同 seed+同 prompt 逐字复现同一份坏输出，循环空转（红牛起草 5 次解析失败内容长度全同 = 10964 字符） | author/reflect 修复循环改为 `seed+attempt`；解析失败诊断补上 JSON.parse 错误位置（round9 莫优靠此在 attempt 2 通过） |
| N6 | plan:batch 在 `opponent.type=plan` 时仍从主计划 `context.opponent` 推导对手牌表——`--unknown` 起草的计划必崩 `unknown_deck 时必须显式提供 opponentDeckCode`（round9 交叉对战 36 组全灭） | 对手为计划时，牌表默认取对方计划的 `context.deckCode` |

### 6.2 round5（r0 vs r0，train seeds 20260824..33，alternateFirstPlayer）

- **起草**：红牛 r0 `8b90411266d9`（16 规则/3 阶段，auto-repair 拦下 MiniMax 幻觉的 7 条 `3320xx` 卡牌死规则；校验修复循环补上缺失 reason）；雷鹤 r0 `e5999badf3fa`（30 规则/3 阶段）。fallback 均为 conservative。
- **批跑**（10 局 4 并发）：红牛 7W/3L/0D，avgRounds 7.3；coverage 98.7%/90.7%，fallback 1.3%/9.1%。`alternateFirstPlayer` 生效（奇数局 planSide=1），`summary.side1.json` 正确落盘——**A1/A2 修复实跑验证通过**。
- **双侧回算**（新默认 dets=8/sims=64/500ms，**A3 生效**）：红牛 blunder 26.3%（75/285），雷鹤 43.0%（129/300）。雷鹤 `global:10` 规则 26/26 全责，归因信号清晰。

### 6.3 反思（r0 → r1）

- 红牛 r1 `accd5097aae2`：24 裁决（18 keep / 6 revise），6 条可消融 claim。
- 雷鹤 r1 `d670b998caef`：31 裁决（8 keep / 7 revise / 16 remove），23 条可消融 claim；**B2 归属校验在反思环节拦下"把对手角色 defId 写进 when/target"的 27 处死规则**，修复循环自动纠正——该修复点实跑验证通过。

### 6.4 round6（r1 vs r1，fresh seeds 20270901..10，B4 纪律）

- **批跑**：红牛 8W/2L/0D（胜率 70%→80%）；coverage 79.4%/86.1%，fallback 20.6%/13.9%——覆盖率显著下降是反思修剪规则的直接代价（雷鹤删了 16 条）。
- **双侧回算**：红牛 blunder **26.3%→20.7%**（55/266），雷鹤 **43.0%→36.0%**（89/247）。fresh seeds 上双方决策质量均改善，与胜率方向一致。
- 注意口径：round5/round6 是不同 seed 集（by design），blunder 率对比含对局难度噪声；10 局样本的胜率差（70→80）不足以做统计结论。红牛 r1 的 `<fallback>` 决策 blunder 16/67（23.9%），提示 fallback 质量成为新瓶颈（fallback 决策占比已从 1.3% 升至 20.6%）。

### 6.5 结论

修复后管线全链路（author→batch→双侧 eval→双侧 reflect→fresh-seed 复验）无人工干预跑通；A1/A2/A3/B2/B3 修复点均在实跑中确认生效。反思在 fresh seeds 上降低了双侧 oracle blunder 率（-5.6pp / -7.0pp），同时覆盖率下降、fallback 占比上升——下一轮反思的改进重点应是 fallback 决策质量（或要求修订时保持覆盖率下限）。
