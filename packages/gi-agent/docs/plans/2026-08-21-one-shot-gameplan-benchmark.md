# One-Shot GamePlan Benchmark：组件设计文档

> 日期：2026-08-21。状态：**M1–M3 已实现**（2026-08-22；schema/校验器/PlanPlayerIO/trace/plan:batch/plan:validate/plan:eval + 冒烟测试与示例，见 §9）。
> 背景：`data/battle-benchmark/findings-consolidated.md`（MeEvo 双层循环实验发现汇总，下称 findings）。
> 本文档定义"赛前 one-shot 决策树编写 + 零交互执行 + 赛后（元）反思"实验所需的全部新组件。

---

## 0. 背景与目标

findings 已确立的事实（本节只引用，不重复论证）：

- 知识管线对胜率无可检测贡献（§0），但"知识条款 ↔ 决策 DSL 规则"的同构性成立（§5.3），fragment 模式的规则命中机制已闭环（§9.1：命中率 96–98%）。
- 能力证据空缺：L0/L1 赛前静态层无数据、无反记忆对照、无 blunder rate（§10.6）。
- seed + mutation log 落盘已完成（§10.8），反事实回放可行。

**本实验的核心改动**：LLM 在对局**开始前**一次性（one-shot）编写完整对局计划（决策树 = 带优先级的条件规则链），对局全程**不与 LLM 交互**，由本地执行引擎逐决策点对现实状态求值规则；对局结束后 LLM 基于执行日志 + oracle 归因做（元）反思并修订计划。

被测对象从"LLM 作为牌手（反应式决策）"变为"LLM 作为策略作者（模型式规划）"。三层可测信号：

1. **赛前**：预测校准（计划内强制预测字段 vs 实际结果）——补 findings §10.4 "预测退化为常数"的空缺；
2. **赛中**：规则覆盖率、fallback 率、blunder rate / lethal 识别率（vs MCTS oracle）——补 §10.6；
3. **赛后**：反思的逐条规则裁决 vs 反事实消融验证——反思第一次有了 ground truth。

**架构决定：绕过 MCP。** MCP 层的存在理由是"LLM 需要文本化 digest + 工具界面"，而本模式下 LLM 只在赛前/赛后各出现一次。对局直接跑在 `core` 引擎 + `gi-agent` 的 `PlayerIO` 通路上（self-play / benchmark / branch-eval 均如此），获得：引擎速对局（单局从 ~2258s 降到秒级，N 可上一个数量级）、消除 pending RPC 卡死家族（findings §11.4/11.5）、消除 token 成本、固定 seed 的确定性对照。LLM 的产出物（计划 JSON）与输入物（日志 + 归因报告）都是文件， authoring / reflection 用一次性离线 API 调用即可，不需要 MCP server。

---

## 1. 总体架构

```
                        ┌────────────────────────────────────────────┐
                        │              离线 LLM 调用（一次性）         │
                        │                                            │
   牌表 + 规则说明 ────► │  A. author: prompt → GamePlanV1 JSON       │
                        │  E. reflect: 日志+归因 → 修订计划+规则裁决    │
                        └───────┬────────────────────▲───────────────┘
                                │ plan.json          │ reflect 输入包
                                ▼                    │
   A2. validate（封闭集合校验）──► 不合法则一次性修复重试 │
                                │                    │
                                ▼                    │
   B. PlanPlayerIO ◄── GamePlanV1（合法、锁定）        │
        │ 实现 core PlayerIO（notify/rpc 五方法）       │
        ▼                                            │
   F. SandboxRunner 批跑（固定 seed，任意对手 policy）   │
        │                                            │
        ├──► game_state_log.json（已有，seed+state+mutations）
        │                                            │
        └──► C. plan_trace.json（新增，逐决策点执行日志）─┤
                                │                    │
                                ▼                    │
   D. plan-eval CLI（回放 + NN oracle 归因；ISMCTS 为旧口径）┘
```

设计原则：

1. **计划是政策函数，不是脚本**。规则在每个决策点对**现实状态**重新求值（与 `FragmentResolver` 的 priority 升序匹配语义一致），天然处理"回合内多步决策只能逐步展开"的问题。线性步骤序列（OpeningPlanLock 式）是错误抽象，不采用。
2. **只用玩家视角状态**。PlanPlayerIO 只允许读 `notify()` 送达的本玩家视角 state（`exposeState` 已对对手手牌/牌堆脱敏），规则求值绝不触碰上帝视角 `GameState`——否则实验结果无效。
3. **反思必须可证伪**。反思输出逐条规则的 keep/revise/remove 裁决 + 可被消融实验检验的声明，不接受纯叙事。

---

## 2. 组件 A：`GamePlanV1` schema 与校验器

**位置**：`packages/gi-agent/src/runtime/plan-oneshot/game-plan-v1.ts`（类型）+ `validate.ts`（校验）。经 `src/index.ts` 导出。

**归属说明**：反思管线在 `packages/benchmark/battle-benchmark/`（findings 的实验臂所在地），而 `@gi-tcg/benchmark` **不依赖** `@gi-tcg/agent`。因此 benchmark 侧不 import 类型，而是通过 CLI（`pnpm run plan:validate`，见组件 F）做校验——与现有实验管线全靠 CLI/配置文件衔接的风格一致。

### 2.1 Schema

```ts
export interface GamePlanV1 {
  version: "GamePlanV1"
  planId: string                    // 内容 hash（sha256 前 12 位），版本谱系追踪用
  parentPlanId: string | null       // 反思修订链
  createdAt: string
  author: string                    // 模型标识，如 "deepseek-v4-flash"

  context: {
    deckCode: string
    opponent:
      | { kind: "mirror" }                        // 镜像局，对手牌表=己方
      | { kind: "known_deck"; deckCode: string }  // 已知对手牌表
      | { kind: "unknown_deck" }                  // 不确定下规划（更难臂）
  }

  // 赛前预测——校准数据源，全部强制（findings §10.4 的修复）
  predictions: {
    winRateEstimate: number         // 0–1
    expectedRounds: number
    confidence: number              // 0–1
    keyThreats: string[]            // 自由文本，反思时对照
  }

  // 开局政策（对应 rpc 的 chooseActive / switchHands / rerollDice）
  opening: {
    chooseActive: OpeningRuleV1[]   // 例：{ when: [...], characterDefId: 2301, reason }
    mulligan: MulliganRuleV1[]      // keep/toss 按 def_id 或 tag
    reroll: RerollRuleV1[]          // 保留元素/万能阈值规则
  }

  // 阶段（可选）：命中的阶段其 rules 前置到全局 rules 之前
  phases: GamePlanPhaseV1[]         // { phaseId, when: WhenConditionV1[], rules: DecisionRuleV1[] }

  // 全局规则链——主政策
  rules: DecisionRuleV1[]

  // 全部未命中时的兜底（强制字段）
  fallback: { policy: "baseline" | "conservative" | "declare_end" }
}
```

`DecisionRuleV1` / `WhenConditionV1` / `ActionSpecV1` 复用 `packages/mcp/src/scoring/types.ts:143-195` 的结构定义（复制进 gi-agent，去除对 `@gi-tcg/tactic-mcp` 的 import 依赖）：`{ priority, when: [{field, op, value}], then: ActionSpecV1, reason }`。priority 升序匹配，`when` 省略 = 恒真（用于兜底规则）。

### 2.2 `when` 字段命名空间（state 视角，替代 digest 的 14 字段）

规则求值对象是 `notify()` 送达的本玩家视角 state。字段白名单（校验器按此做封闭集合校验）：

| 类别 | 字段示例 |
|---|---|
| 进程 | `round`、`turn`、`actionsTakenThisTurn`（IO 侧计数）、`phase`（当前阶段 id） |
| 己方角色 | `self.active.{hp,energy,maxEnergy,aura,defId,element,alive}`、`self.characters.<defId>.{hp,energy,alive}`、`self.aliveCount` |
| 对手角色 | `opponent.active.{...}`、`opponent.characters.<defId>.{hp,energy,alive}`、`opponent.aliveCount`（**无手牌字段**） |
| 资源 | `dice.total`、`dice.omni`、`dice.<element>`、`hand.count`、`hand.hasCard.<defId>`、`hand.countWithTag.<tag>` |
| 场面 | `self.summons.count`、`opponent.summons.count`、`self.supports.count`、`opponent.supports.count` |

`value` 支持 `"$field_ref"` 动态引用（沿用现有 DSL 语义）。未知字段 → 校验期拒绝（不是运行期 false——one-shot 模式下没有 LLM 在线纠错，必须在校验期挡住）。

### 2.3 `then`（ActionSpecV1）到合法动作的映射

执行侧的合法动作列表来自 rpc `action` 请求（`packages/typings/src/gen/rpc.ts:34-47` 的 `Action`：`action.$case` ∈ `switchActive|playCard|useSkill|elementalTuning|declareEnd`，带 `preview[]`、`requiredCost[]`、`autoSelectedDice[]`、`validity`、`isFast`）。映射规则：

- `action_case` ↔ `Action.action.$case`；
- `skill_type` / `card_def_id` / `card_tag` / `target` ↔ 从 `value`（`UseSkillAction`/`PlayCardAction`/`SwitchActiveAction`）解出的 definition id / 目标 id，配合 GameData 查 tag；
- `damage_min` / `kills` / `prefer_reaction` ↔ 该候选的 `preview[]` 中的伤害/反应数据（与 MCP 侧 `candidateMatchesSpec` 同语义，需重新实现，输入从 digest 候选换成 `Action`）。

### 2.4 校验器（封闭集合 + 语义校验）

1. 结构：`version` 字面值、必填字段、`predictions` 数值域、priority 在同一链内唯一；
2. 封闭集合：when 字段路径 ∈ §2.2 白名单、op ∈ 六枚举、action_case ∈ 五枚举；
3. 语义：`card_def_id` / `characterDefId` ∈ `context.deckCode` 解出的牌表与角色（经 `@gi-tcg/data` 校验）；`phases[].phaseId` 引用闭合；`fallback` 必填；
4. 产出：错误列表按"可自动修复 / 需 LLM 重试"分级，供 author CLI 的一次性修复回路使用。

---

## 3. 组件 B：`PlanPlayerIO`（计划执行引擎）

**位置**：`packages/gi-agent/src/runtime/plan-oneshot/plan-player-io.ts`。**新增目录** `src/runtime/plan-oneshot/`——实现时需同步更新 `packages/gi-agent/AGENTS.md` 的包结构契约。

实现 `core` 的 `PlayerIO`（`packages/core/src/io.ts:84-87`：`notify` + `rpc`），五个 rpc 方法的行为：

| rpc 方法 | 行为 |
|---|---|
| `action` | 过滤 `validity === VALID`（参照 `PolicyPlayerIO.chooseAction`，`policy-player-io.ts:271-273`）→ 当前阶段 rules + 全局 rules 按 priority 升序求值 → 首条 when 全真且 `then` 命中 ≥1 候选的规则胜出 → 多候选时按 preview 伤害降序/最小 index 取一 → `usedDice` 取该候选 `autoSelectedDice`。全部未命中 → `fallback.policy`：`baseline`（委托一个 `BaselinePolicy` 实例）、`conservative`（最低费用动作，倾向 `declareEnd`）、`declare_end` |
| `chooseActive` | `opening.chooseActive` 规则链；默认取 `candidateIds[0]` |
| `switchHands` | `opening.mulligan` 规则链 → `removedHandIds`；默认全留 |
| `rerollDice` | `opening.reroll` 规则链（对 `notify` 状态中的骰面求值）；默认重掷非己方角色元素且非万能 |
| `selectCard` | 默认 `candidateDefinitionIds[0]`（罕见路径，不进规则链） |

关键约束：

- **隐藏信息安全**：只读 `notify` 缓存的本玩家视角 state（参照 `PolicyPlayerIO` 的 `latestNotificationState`，`policy-player-io.ts:161/204`）。禁止经 `attachGameContext.stateProvider` 拿上帝视角——PlanPlayerIO 不实现 `attachGameContext`。
- **绝不向引擎抛错**：规则求值/映射的任何异常都 catch 后落 trace 并走 fallback（与 `Game.config.errorLevel` 语义独立，计划模式的铁律是"对局必须跑完"）。
- **确定性**：同 plan + 同 seed → 同动作序列。tie-break 规则固定，不引入 `Math.random()`。
- 每个 rpc 调用产出一条 trace 记录（组件 C）。

---

## 4. 组件 C：`plan_trace.json` 执行日志

**位置**：序列化逻辑在 `src/runtime/plan-oneshot/trace.ts`；由 SandboxRunner 侧的落盘钩子写入每局目录（与 `game_state_log.json` 并列）。

每局一个文件：

```ts
export interface PlanTraceFile {
  version: "PlanTraceV1"
  planId: string                    // 与 GamePlanV1.planId 一致
  parentPlanId: string | null
  seed: number
  deckCodes: [string, string]
  side: 0 | 1                       // 本计划执舵哪一方
  opponentPolicy: string            // "plan:<planId>" | "baseline" | "mcts:<config>" 等
  entries: PlanTraceEntry[]
  summary: PlanTraceSummary
}

export interface PlanTraceEntry {
  seq: number
  round: number
  turn: number
  method: "action" | "chooseActive" | "switchHands" | "rerollDice" | "selectCard"
  stateLogIndex: number | null      // 执行期恒为 null；对齐由 stateSignature 完成
  /** 决策时刻本侧玩家视角 state 的规范化 JSON 签名（归一化 PlayerStatus） */
  stateSignature?: string
  phaseId: string | null            // 命中阶段
  candidateCount: number
  matchedRule: { scope: "phase" | "global" | "opening"; priority: number; reason: string } | null
  fallbackUsed: boolean
  fallbackPolicy?: string
  chosen: {
    actionCase: string
    skillDefId?: number
    cardDefId?: number
    targetDefId?: number
    previewDamage?: number
  } | null
}

export interface PlanTraceSummary {
  result: "win" | "loss" | "draw"
  rounds: number
  decisionCounts: { total: number; ruleMatched: number; fallback: number }
  coverage: number                  // ruleMatched / total——计划预见了多少实际局面
  perRuleHits: Record<string, number>   // "global:3" → 命中次数；规则热力图
}
```

与 `game_state_log.json` 的关系：state log 负责**反事实重建**（`deserializeGameStateLog` → `new Game(entry.state)`），trace 负责**计划归因**（哪条规则在哪个局面做了什么）。两者经 `stateSignature` 互链（`planStateSignature` 归一化玩家视角 JSON ↔ oracle 侧 `exposeState(side, engineState)` 重算；实测 ~94% 决策点精确匹配，残余为引擎 pause/notify 边界差异，由 eval 以 warning 显式报告）。

---

## 5. 组件 D：oracle 回算 CLI（`plan:eval`）

**位置**：`packages/gi-agent/src/evaluation/plan-eval/cli/run-plan-eval.ts`；`package.json` 加 `"plan:eval": "gnx src/evaluation/plan-eval/cli/run-plan-eval.ts"`。

**功能**：读单局目录（`game_state_log.json` + `plan_trace.json`），对每个 `method === "action"` 的 trace 条目按 `stateSignature` 对齐到 state log 暂停点：

1. 从 state log 恢复 `GameState`（branch-eval 的成熟做法，`src/evaluation/branch-eval/cli/run-branch-eval.ts:189-190, 364`）；
2. 以**执舵方视角**请求 oracle 排序（`--oracle`，核心逻辑 `eval-game.ts` / `eval-game-nn.ts`）：
   - **`nn`（错手判定标准口径，2026-08-28 起）**：外部闭源 clean_genius_AI 冻结 PPO checkpoint，经 aibridge policy_service 接入。oracle 输出为策略网络候选排序（log-prob 分数），不是 visit 分布；隐藏信息由端到端策略隐式处理，输入与计划同为玩家视角 `exposeState`，无 determinization。附带 value 头胜率差分（valueBefore/valueAfter → valueDelta，崩落阈值 valueTau 默认 0.1 ≈ 5pp 胜率）。模型词表钉死 v6.3.0，非 v6.3.0 对局超词表卡牌按 DummyCard 编码并在 warnings 显式报告。
   - `ismcts`（旧口径，仅用于历史轮次复现）：以执舵方视角跑 `ismctsSearch(...)`（`src/mcts/ismcts.ts:138`；dets=8/sims=64/500ms），隐藏信息经 determinization 处理（`src/mcts/determinization.ts`）。两口径 τ 语义不同（logprob 分差 vs visit 分布差距），**不可直接比较**。
3. 比较 oracle 最优动作与 trace 记录的实际选择（按 action_case + skill/card/target defId 语义判等）。

**产出** `plan_eval.json`（NN 口径为 `plan_eval.nn.json`）：

- `blunderRate`：实际动作 ≠ oracle 最优且分差 > 阈值 τ 的比例（NN 口径 τ 为 logprob 分差，默认 1.0 ≈ "top 的可能是所选的 e 倍"）；
- `lethalMissRate`：oracle 判有斩杀而计划未斩杀的比例（lethal 识别率探针，findings §10.6 的 L2 探针落地）；
- **规则级归因表**：每个 blunder 点当时命中的 `matchedRule` → 聚合成"规则 → blunder 次数/命中率"——这是反思的核心输入；
- `predictionCalibration`：计划预测（胜率/回合数）vs 实际。

阈值 τ 与 oracle 预算（simulations/determinizations）走 CLI config，默认值写入 config 示例。

## 6. 组件 E：反思管线（`reflect-plan`）

**位置**：`packages/benchmark/battle-benchmark/src/plan-reflect/`（与 `knowledge/compile-rules.ts` 同级），校验经组件 F 的 CLI 回调 gi-agent。

**输入包**（离线组装，单次 LLM 调用）：

- 当前 `GamePlanV1` 全文；
- N 局聚合统计：胜率/平均回合、coverage、fallback 率、规则热力图（由 trace summary 聚合，**引擎侧算好**——沿用 findings §10.7.2"权威统计注入"原则，LLM 不归因口算）；
- oracle 归因表（组件 D 输出）+ 若干 blunder 点的局面摘要；
- **全量决策点摘要**（2026-08-25 新增，`evidence-extract.ts` 的 `extractFullDigest`）：每个 action 决策点一行（局面 digest + 命中规则 + 计划选择 + oracle 推荐 + visitGap + ✗/~/✓ 标记），替代"只给 top-8 抽样"——top-N 按 visitGap 排序会漏掉"反复失误但单次 gap 不大"的毒规则（实测 `global:11` 43 次触发 41 次失误却进不了 top-8）。行数超上限（默认 420）时均匀抽样省略 ✓ 一致行，✗/~ 行全量保留。实测 round10-mm 雷鹤侧 126 决策点全量进 prompt；原始记录原文单侧 10 局约 1.3M token（trace 含完整状态签名），全量内联不可行，"原文自由读取"留作 agentic 化升级项。
- 预测校准对照（`predictions` vs 实际）。

**输出 schema**（`ReflectPlanResultV1`）：

```ts
{
  version: "ReflectPlanResultV1"
  basePlanId: string
  predictionPostmortem: string          // 预测为何偏差
  ruleVerdicts: Array<{                 // 每条裁决都是可证伪声明
    ruleRef: string                     // "global:3" / "phase:burst:1"
    verdict: "keep" | "revise" | "remove"
    justification: string
    falsifiableClaim: string | null     // 例："移除后 blunderRate 应下降"
  }>
  revisedPlan: GamePlanV1               // 完整产物，非补丁
  revisedPredictions: GamePlanV1["predictions"]
}
```

校验：`ruleRef` 必须存在于 basePlan（封闭集合）；`revisedPlan` 必须过组件 A 校验器；`revisedPredictions` 强制重填。小样本纪律沿用 findings §10.7.3（N < 10 禁止方向性强断言——写进 prompt 并在输出 schema 要求标注 `sampleSize`）。

**消融回路**：`falsifiableClaim` 非空的裁决自动生成消融臂（basePlan 仅改该条规则，同 seed 梯重跑 N 局），裁决的正确性由此被证伪——这是本设计相对 findings §6 元元认知实验的增量：**反思声明有 ground truth**。

## 7. 组件 F：实验臂配置与批跑入口

- **author CLI**：`pnpm run plan:author <config>`（gi-agent，`src/runtime/plan-oneshot/cli/`）。一次性离线调用：输入牌表（双方案例）+ schema 说明 + few-shot → 输出原始 JSON → 校验 → 不合法则带错误列表一次性修复重试（仍失败则该轮标记失败，不进入对局）。模型/API 配置复用现有实验的通道配置惯例。
- **批跑**：复用 `SandboxRunner.runBatch`（`src/sandbox/runner.ts`，`captureReplay` 已写 `game_state_log.json`）。对手插槽接受：`PlanPlayerIO`（镜像/计划对战）、`BaselinePolicy`、`MctsPolicy`——经现有 `PolicyPlayerIO` 接入。需要一个小扩展：runBatch 的落盘钩子同时写 `plan_trace.json`。
- **evolve 臂配置**（battle-benchmark）：新增臂类型 `mode: "plan-oneshot"`，字段：`planFile` / `authorConfig`（首轮 authoring）、`opponent`、`gamesPerRound`（引擎速，建议 ≥50）、`seedBase`、`alternateFirstPlayer`、`reflect: { enabled, minSampleSize }`。轮次循环：author/reflect → 校验 → 批跑 → 聚合 + oracle → reflect。
- **validate CLI**：`pnpm run plan:validate <plan.json>`，供 benchmark 侧与手工检查使用。

---

## 8. 复用清单（不需要新做的）

| 已有物 | 位置 | 复用点 |
|---|---|---|
| 规则链 DSL 类型与语义 | `packages/mcp/src/scoring/types.ts:143-229` | 复制类型定义进 gi-agent（去除 tactic-mcp 依赖） |
| priority 升序匹配 + fallback 语义 | `packages/mcp/src/.../FragmentResolver.ts:764-790` | 语义参照，代码重写（输入从 digest 换成 RpcAction+state view） |
| state log 序列化/恢复 | `packages/core/src/log.ts:116,219` | 反事实重建 |
| 批跑与 replay 落盘 | `packages/gi-agent/src/sandbox/runner.ts` | 组件 F |
| NN oracle（标准口径） | `src/evaluation/plan-eval/eval-game-nn.ts` + aibridge policy_service（`--oracle nn`） | 组件 D |
| ISMCTS oracle API（旧口径） | `packages/gi-agent/src/mcts/ismcts.ts:138` | 组件 D |
| 回放分支点采集 glue | `src/evaluation/branch-eval/cli/run-branch-eval.ts` | 组件 D |
| 兜底 policy | `BaselinePolicy` | fallback `"baseline"` 档 |
| PlayerIO 实现范式 | `PolicyPlayerIO`（validity 过滤、notify 视角缓存、autoSelectedDice） | 组件 B |
| 封闭集合校验思路 | `battle-benchmark/src/knowledge/compile-rules.ts` | 组件 A 校验器 |
| 权威统计注入 / 小样本禁令 | findings §10.7 已修复的 reflect 机制 | 组件 E prompt 纪律 |
| 虚构卡组数据加载 | `@gi-tcg/custom-data-loader` | 反记忆对照臂（内容制作另列任务） |

## 9. 实施顺序

| 里程碑 | 内容 | 验收 | 状态 |
|---|---|---|---|
| M1 | A（schema+校验）+ B（PlanPlayerIO）+ C（trace）最小实现 | 手写一份 GamePlanV1，plan vs baseline 确定性跑完 1 局，trace 与 state log 落盘且互链 | ✅ 2026-08-22：`src/runtime/plan-oneshot/`（8 项测试全绿，含同 seed 动作序列逐点一致、签名对齐不变量 ≥90%） |
| M2 | F（批跑 + 聚合） | plan vs baseline 30 局，coverage/fallback/热力图聚合输出 | ✅ 2026-08-22：`plan:batch` CLI + `plan:validate`；冒烟 3 局（`examples/plans/`），确定性复跑逐字节一致 |
| M3 | D（oracle CLI） | 首个 blunder/lethal 归因报告，规则级归因表非空 | ✅ 2026-08-22：`plan:eval` 按签名对齐 + ISMCTS 归因；lethal 探针待做（见下） |
| M4 | author CLI + E（reflect） | 首个 author→批跑→oracle→反思→修订计划的闭环轮 | ✅ 2026-08-22：`plan:author` / `plan:reflect` + `plan:batch` 并发；round0 实战见下 |
| M5 | 对照臂与消融 | 镜像/已知牌表/未知牌表分臂；虚构卡组反记忆臂；消融自动验证 falsifiableClaim | 🔶 消融已实现（`plan:ablate`，见下）；虚构卡组臂未做 |

**首批消融结果（2026-08-22，round2 DeepSeek 计划的 r1 反思，各侧 top5 高 blunder 裁决）**：

- 红牛侧：3 supported / 0 refuted / 2 inconclusive / 1 skipped。phase:midgame:70 修订后规则 blunder 率 81%→0%，phase:defensive:20 88%→25%，phase:burst:20 移除后整体 blunderRate 43.6%→35.6%。
- 雷鹤侧：3 supported / 0 refuted / 2 inconclusive / 1 skipped。注意 remove 臂的判定是"整体 blunderRate 任何下降"，两个臂只有 56.9%→56.6% 的噪声级移动——后续应加最小效应阈值。
- 合计 10 臂中 6 条反思声明被证真、0 条被证伪：**反思的归因-修订声明有真实信号**（远超"反思是叙事"的基线怀疑）。但所有臂 winRate 均未变化（红牛仍 0%、雷鹤仍 100%）——规则级 blunder 改善不改变对位结构，与 findings §0"知识质量≠胜率"一致；这正是消融臂存在的意义：把"反思是否说对"从胜率噪声中剥离出来。
- 实现注记：消融计划的修订规则直接取自 r1 同位置规则（phaseId+priority 配对），remove 为机械删除；判定全机械（规则 blunder 率/整体 blunderRate 对比基线同 seed 梯）；baseline 键格式统一为 `phase:<phaseId>:<priority>`（trace/eval 两侧同步修复跨阶段碰撞）。

**全量消融（同日扩 K：红牛 26 臂 + 雷鹤 6 臂全测）**：

- 红牛：10 supported / **1 refuted** / 14 inconclusive / 2 skipped；雷鹤：5/0/1/1。合计 32 臂中 15 证真、1 证伪（phase:midgame:60 移除后 blunderRate 43.6%→43.9%，噪声级反向）。
- 效应量分层明显：证真里既有 81%→0%、88%→25%、56.9%→47.0% 的真效应，也有 43.6%→42.9% 的噪声级"supported"——判定规则（严格符号比较）没有效应量阈值，**后续必须加最小效应量（建议 ≥3pp）或配对显著性检验**。
- revise 类 claim 的主要失败模式是"改没了"：条件收紧后规则零命中，分母归零记 inconclusive（红牛 14 条 inconclusive 里多数是这种）——反思把规则改死的倾向值得作为反思质量的一个独立度量。
- 被证伪的 1 条为论文提供了关键证据类型：消融管线确实**能**证伪（不是橡皮图章）。

**round0/round1 实战验证（2026-08-22，MiniMax-M2.5 @ edgefn，红牛×雷鹤）**：

- round0：双方 LLM one-shot 计划（红牛 38 规则、雷鹤 32 规则）→ 10 局 ×4 并发（~1.1s/局）→ 红牛 10:0，avgRounds 6.2，coverage 92.4%/70–80%，fallback 7.7% → oracle 回算 283 决策点 blunderRate 43.5%（dets=4/sims=32/300ms）→ 双方反思产出 r1（红牛 28 裁决、雷鹤 33 裁决，均精确命中高 blunder 规则并给出可证伪声明）→ round1 r1 vs r1 仍 10:0（avgRounds 7.7，coverage 90.1%）。
- 产出的基础设施教训（均已修复并固化进代码）：①该端点推理模型复杂任务会烧穿 maxTokens 空输出——结构化任务需 `enable_thinking: false`；②LLM 把数字 id 写成字符串导致校验误判——入口统一 `normalizePlanNumericFields`；③LLM 凭记忆写角色 id 而非 prompt 列出的 id——校验器新增 when 角色引用语义检查（引用不在牌表中的角色 = 死规则，打回重写）；④反思 prompt 必须携带与 author 相同的字段白名单（`plan-prompts.ts` 共享）。
- 已知限制：author/reflect 当前为关推理模式（该端点限制），与 findings 的 deepseek 推理链结果不可直接比较；plan:eval 只回算 side0 的 plan_trace.json；消融臂自动执行（falsifiableClaim → 自动跑分）未实现。

**round2/round3（2026-08-22，scnet DeepSeek-V4-Flash-0731 开推理，同 seed 梯）**：

- round2：DeepSeek 计划结构明显更优（阶段带真实条件、`$field` 引用、出战角色有战术理由），批跑**雷鹤 10:0 红牛**（与 MiniMax 轮反向），coverage 红牛 70.8% / 雷鹤 86.0%；oracle blunderRate 42.9%（140 决策点）。计划"长得像"与"打得赢"并不等价——MiniMax 红牛（38 条扁平规则、横扫 10:0）vs DeepSeek 红牛（分阶段精细结构、0:10），对位方向完全由模型决定。
- round3（r1 vs r1）：**10 局全部平局**（顶满 15 回合上限）。declareEnd 占比从 r0 的 46%/22% 涨到 r1 的 68%/45%——双方反思一致地"过度矫正为龟缩"，这是 findings §10.3 噪声追逐在计划形态上的表现：输掉的一方学到"更保守"，双方同时保守化就是对局死锁。反思纪律（N<10 措辞）遵守良好（postmortem 引用数字零错误、有"N=10 虽小"限定语），但纪律管不住修订方向。
- 通道对比教训：同一管线在 MiniMax（关推理）与 DeepSeek（开推理）上产出结构差异巨大的计划；跨通道比较计划质量时，推理开关本身是混杂因素。

**局面级诊断 + 提示词外置（2026-08-22 晚些时候）**：

- 提示词本体抽至 `src/runtime/plan-oneshot/prompts/*.md`（`plan-schema-spec.md` 共享规格含 declareEnd 纪律；`author-system.md`；`reflect-system.md`），`cli/plan-prompts.ts` 加载并做 `{{PLAN_SCHEMA_SPEC}}` 占位替换——审查/迭代提示词直接改 md 文件。
- `cli/evidence-extract.ts`：从 run 目录提取局面级证据喂反思——高 blunder 决策点（compact state digest + 计划选择 + oracle 推荐 + visitGap，按 visitGap 取 top 8）与 fallback 局面（top 8）；按侧读文件（side1 为 plan_trace.side1.json / plan_eval.side1.json）。
- 反思 prompt 纪律新增：declareEnd 三许可（唯一合法/战术抢先/最低兜底）+ 禁止"改没了"式修订。实测（hongniu r1ev）：postmortem 引用了阶段级细节；但修订后仍无"恒真非 declareEnd 兜底规则"——该要求未被遵守，后续应考虑校验器级强制（无兜底规则给 warning）。
- scnet 通道新踩坑（已修复）：长推理请求需 20min 超时 + 网络重试；推理模型可能把全部输出留在 reasoning_content 而 content 为空（finish=stop）——`extractJson` 现取最后一个 ```json 块并支持 reasoning 兜底提取。

**round4（2026-08-22，scnet DeepSeek，declareEnd 纪律 + 局面证据反思全量生效）**：

- 起草：scnet 通道对长输出生成间歇性挂起（6 次尝试成功 2 次，>20min 无响应；小探针秒回），校验器为此加固（opening 数组容错 + 单对象同化）。
- **批跑：红牛 7:3 雷鹤（前两轮均为 10:0 横扫/被横扫）——首个有来有回的对局**；avgRounds 6.3；**coverage 96.8%、fallbackRate 3.3%**（round2 为 70.6%/29.2%）；declareEnd 占比 红牛 46.3%→**16.3%**、雷鹤 21.5%→17.5%；**oracle blunderRate 26.8%**（round2 为 42.9%）。
- 反思：side0 证据 blunders=8 **fallbacks=0**（覆盖缺口已闭合，无裸奔局面可报）；side1 blunders=8 fallbacks=8；双侧产出 r1（红牛 29 裁决、雷鹤 41 裁决）。
- 结论：declareEnd 纪律 + 兜底规则要求 + 局面证据反思三者组合，把"计划质量"的三个核心指标（coverage/blunder/对局竞争性）同时推高了一个台阶——提示词纪律对计划形态有可测的真实影响。

**round5/round6（2026-08-24，审计修复后首轮，scnet MiniMax-M2.5；DeepSeek-V4-Flash-0731 模型级 429 不可用）**：

- 修复后管线全链路（author→batch→双侧 eval→双侧 reflect→fresh-seed 复验）无人工干预跑通；A1（side1 统计口径）/A2（alternateFirstPlayer）/A3（dets=8/sims=64/500ms）/B2（反思环节拦下对手角色 defId 死规则 27 处）/B3（perRuleThenMiss 注入）实跑验证通过；过程中另修 4 个缺陷（429 退避重试、author 缺 context 崩溃、thinking 32k 输出预算、`--model` 实装），详见审计文档 §6.1。
- round5（r0 vs r0，train seeds）：红牛 7:3，blunder 红牛 26.3% / 雷鹤 43.0%。
- round6（r1 vs r1，fresh seeds 20270901..10）：红牛 8:2；blunder 红牛 **26.3%→20.7%**、雷鹤 **43.0%→36.0%**——反思在 fresh seeds 上降低了双侧决策失误率，与胜率方向一致。
- 代价与下一步：覆盖率 98.7%→79.4%、fallback 占比 1.3%→20.6%（雷鹤 r1 删了 16 条规则），fallback 决策 blunder 23.9%（16/67）成为新瓶颈——反思 prompt 应要求修订保持覆盖率下限，或单独加强 fallback 档。
- 口径注意：本轮模型为 MiniMax-M2.5，与 round0–4（edgefn MiniMax 关推理 / scnet DeepSeek 开推理）的计划质量不可直接比较；round4 及之前的胜率/blunder 绝对值属审计前旧口径（含 A1/A2/A4 系统偏差）。

**round9（2026-08-24，8 卡组交叉对战，MiniMax-M2.5，--unknown 起草）**：

- 卡组取自废弃基准配置 `benchmark.v30-stage3-5k.json`（64 个 matchup 交叉校验 0 错配）：水八/神宵/水凝/雷鹤/雷狼/莫优/红牛/水债。每卡组一份 --unknown 计划（8 次起草全过：6 直过，莫优/红牛经变 seed 修复循环——固定 seed 会逐字复现同一份坏输出，已改为 `seed+attempt`）。
- 36 组对局（i≤j 含镜像）×10 局，alternateFirstPlayer，批跑 CLI 修复：`opponent.type=plan` 时对手牌表取对方计划的 `context.deckCode`。
- **结果**（完整矩阵见 `output/plan-oneshot/round9/matrix.md`）：红牛 84.3% > 神宵 82.9% > 雷狼 78.6% > 水债 55.7% > 雷鹤 25.7% > 水八 22.9% > 莫优 4.3% > 水凝 0.0%。
- 形态信号：水凝 coverage 94.2% 但 0 胜（大量 15 回合平局，计划偏龟缩无斩杀/压血线能力）——**覆盖率≠竞争力**；神宵/雷狼 高 coverage（95%）+ 低 fallback（5%）对应高胜率，水八/红牛/莫优/水债 70–77% coverage + 23–30% fallback 居中分化。计划形态（规则数、coverage、fallback）与胜负的关系值得作为下一批假设。

**round7-mm/round8-mm（2026-08-24，MiniMax-M2.5 连续迭代 r2/r3，各 10 局 fresh seeds）**：

- round7-mm（r2 vs r2，seeds 20271001..10）：红牛 4:6 雷鹤（雷鹤首次逆转）；blunder 红牛 35.9% / 雷鹤 38.8%；coverage 79.4%、fallback 20.7%。雷鹤 r2 反思 4 试才过校验（反复引用牌表外角色、产出非法 `fallback.policy=aggressive`）。
- round8-mm（r3 vs r3，seeds 20271101..10）：**红牛 10:0**；blunder 红牛 25.4% / 雷鹤 40.1%；coverage 79.6%、fallback 20.6%。
- **趋势结论**：四轮比分 7:3 → 8:2 → 4:6 → 10:0，10 局/轮的胜率方差太大，不能作为迭代效果的度量；blunder 率（每侧每轮 ~180–310 决策点）更稳——红牛 26.3→20.7→35.9→25.4 震荡无单调改善，雷鹤 43.0→36.0→38.8→40.1 停滞在 ~40%。
- 机制观察：① 雷鹤 r2 的毒规则 `global:11`（43 次触发 41 次 blunder）经 r3 反思后仍在（r3 同槽位 21/21）——局面级证据能精确定位，但反思修订未能切除，提示词/校验器需要"高 blunder 规则必须删除或改写"的硬约束；② fallback 档仍是红牛最大失误桶（r3：32/75=43%），r1 起的"修剪换 fallback"代价未见回收。

**round7/round8（2026-08-24，DeepSeek-V4-Flash-0731 开推理对照，与 round5/round6 完全同种子同管线）**：

- round7（r0 vs r0，seeds 20260824..33）：**红牛 0:10 雷鹤**（同种子 MiniMax r0 为红牛 7:3）；blunder 红牛 41.8% / 雷鹤 48.7%；coverage 74.3%、fallback 24.0%。DeepSeek 计划形态：红牛 31 条规则无 phases、雷鹤 40 条规则 3 phases、fallback=conservative。
- round8（r1 vs r1，seeds 20270901..10）：红牛 8:2（同种子 MiniMax r1 亦为 8:2）；blunder 红牛 43.6% / 雷鹤 44.9%——**反思让比分从 0:10 翻到 8:2，但双侧 blunder 几乎不动（41.8→43.6 / 48.7→44.9）**，再次印证 10 局胜率噪声大、blunder 才是稳定的质量指标。
- 跨模型（同管线）：DeepSeek（开推理、31–40 条规则）blunder 系统性高于 MiniMax（关推理、16 条规则）约 5–15 个百分点；且推理链长输出在 scnet 通道间歇性挂起（起草雷鹤 r0 用了 6 试、反思 r1 用了 2 试），工程成本显著更高。
- 口径注意：两模型计划形态差异大（规则数、phases 使用），blunder 对比受 oracle 强度（dets=8/sims=64/500ms）限制，只作通道级参考，不作模型能力定论。

**round9-mm/round10-mm 与 round9-ds/round10-ds（2026-08-24，双模型各续 2 轮迭代，同 fresh seeds 20271201..10 / 20271211..20）**：

- MiniMax r4：红牛 10:0，blunder 33.5%/35.9%（coverage 75.8%、fallback 24.3%）；r5：红牛 9:0:1，blunder 29.1%/33.3%（coverage 76.1%、fallback 24.2%）。六轮 blunder 无单调趋势：红牛 26.3→20.7→35.9→25.4→33.5→29.1，雷鹤 43.0→36.0→38.8→40.1→35.9→33.3。
- DeepSeek r2：红牛 0:10，blunder 29.2%/35.9%；r3：红牛 3:7，blunder **22.4%/27.6%**。DeepSeek 四轮 blunder 近乎单调下降：红牛 41.8→43.6→29.2→22.4、雷鹤 48.7→44.9→35.9→27.6——起点远低于 MiniMax，但反思修订持续见效（其计划维持 35–41 条规则的较大形态，可能给了反思更多修订空间；MiniMax 计划被修剪到 14–16 条后震荡）。
- 交叉观察：① DS r3 红牛 blunder 低于雷鹤（22.4<27.6）却 3:7 输——blunder 低≠赢，比分还受 matchup/先后手/计划形态影响，10 局噪声依旧；② MiniMax 雷鹤毒规则 `global:11` 第五代仍存活（10/10 全 blunder），红牛 r5 的 blunder 64% 来自 fallback 档（50/78）——"修剪换 fallback"代价持续未回收；③ MiniMax 反思后期幻觉牌表外角色 id 频率上升（r5 首轮同 seed 6 试全挂，逐次变 seed 后第 1 试即过），变 seed 重试已作为标准容错。
- oracle 强度上限（"oracle 也是傻子"）：切换 cc_AI（经 `aibridge - 副本` 桥接）已记入 §10.8 待办；切换前全部轮次保持 dets=8/sims=64/500ms 口径。

**round11-x（2026-08-24，跨模型交叉对战：MiniMax r5 vs DeepSeek r3 最新计划，4 组 × 10 局，同 seeds 20271301..10，未做 oracle 回算）**：

- 交叉牌位：**DS雷鹤 10:0 MM红牛**；**DS红牛 10:0 MM雷鹤**。
- 同牌对位：**DS红牛 7:3 MM红牛**；**DS雷鹤 10:0 MM雷鹤**。
- DeepSeek 计划四组全胜（总比分 37:3），与其 blunder 优势（r3：22.4%/27.6% vs MM r5：29.1%/33.3%）方向一致——**blunder 信号在跨模型、大效应量场景下与实际胜负吻合**；此前"blunder 低≠赢"的反例（DS r3 红牛 3:7 输同模型雷鹤）应归为模型内小样本噪声。
- 形态注记：MM雷鹤 vs DS雷鹤 组 avgCoverage 60.8%、fallback 39.1%，显著劣于其他三组（74–81% / 19–26%）——面对高覆盖计划，小规则集计划的覆盖缺口被进一步放大。

**round12-ds（2026-08-25，DeepSeek-V4-Flash-0731 开推理 8 卡组交叉矩阵，与 round9 同种子 20264300、同规格 r0 --unknown 计划）**：

- 8 卡组起草全过（通道间歇挂起，变 seed 重试兜底）；产物 `output/plan-oneshot/round12-ds/{plans,matrix.md}`。
- **结果**：雷狼 75.7% > 雷鹤 74.3% > 水凝 67.1% > 水八 61.4% > 莫优 47.1% > 神宵 32.9% > 红牛 20.0% > 水债 4.3%。
- **与 round9（MiniMax-M2.5）排名几乎完全颠倒**：红牛 84.3%→20.0%、神宵 82.9%→32.9%、水凝 0.0%→67.1%、雷鹤 25.7%→74.3%、水债 55.7%→4.3%、莫优 4.3%→47.1%。同一批卡组在两个模型手里排名倒置——**该矩阵测的是模型的规划能力而非卡组强度**，这正是 benchmark 想要的判别力。与 1v1 迭代链的 r0 比分互洽（MM：红牛>雷鹤；DS：雷鹤 10:0 红牛）。
- 形态对比：DS 计划 28–41 条规则、coverage 73.5–98.4%（MM 为 13–16 条、70–95%）；round9"高 coverage≠赢"的水凝案例出现镜像版——MM 水凝 94.2% 覆盖 0 胜全平（龟缩无斩杀），DS 水凝 83.2% 覆盖 67.1% 胜率，同卡组因计划形态不同而胜负反转。

**round13–15-k2 / round13–15-m3（2026-08-25，Kimi-K2.6 与 MiniMax-M3 各 2 轮迭代；全量决策点摘要版反思提示词首批实战）**：

- **r0 四模型横评**（同 seeds 20260824，比分=红牛：雷鹤，blunder 红牛/雷鹤）：M2.5 7:3（26.3%/43.0%）、DS 0:10（41.8%/48.7%）、**M3 10:0（23.3%/46.5%）**、K2.6 9:1（28.8%/23.9%）。r0 起草质量：M3 ≈ K2.6 > M2.5 > DS。
- M3 红牛 blunder **23.3→9.4→3.3 单调陡降**（三轮比分 10:0 全胜）；但雷鹤侧 46.5→45.0→45.1 完全不动——迭代收益单侧化。
- K2.6 双侧首轮改善后 r2 微回（红牛 28.8→19.0→21.3，雷鹤 23.9→15.8→20.3），雷鹤迭代更快并逐轮逆转比分 9:1→3:7→**0:10**。
- 口径警示：M3/K2.6 的反思输入含全量决策点摘要（2026-08-25 harness 改进），与 M2.5/DS 的 top-8 抽样轮次**不可直接比改善幅度**；r0 横评不受影响（起草环节未变）。
- "逼近 oracle ≠ 真的好"：blunder 度量的是与 ISMCTS oracle 的一致性，M3 红牛 3.3% 可能部分来自拟合 oracle 偏好；oracle 升级（§10.8）后应重算关键轮次验证。

**round16-nn（2026-08-25，24 套计划 vs 外部 NN 基线（clean_genius_AI 冻结 PPO，v6.3.0 数据，seeds 20271501..10，各 10 局）**：

- 口径：矩阵计划（--unknown 起草）由 NN 执**同牌表镜像**（`opponentDeckCode`=计划牌表）；1v1 迭代计划由 NN 执其 known_deck 对手牌表。NN 侧全程 0 错误、模型作答率 100%；部分牌表含 NN 词表外卡牌（DummyCard 降质，对 NN 不利，不影响结论方向）。
- **结果：24 套计划合计 3 胜 236 负 2 平（胜率 1.3%）**。22/24 正好 0:10；唯二非零：DS 雷鹤 r0 2:8、DS 雷狼 r0 1:9（均为高覆盖 DS 矩阵计划，与 round12-ds 矩阵里雷鹤/雷狼前二互洽）。
- 次级信号：coverage 与 avgRounds 正相关（M3 雷鹤 r2 coverage 92.5% 撑 7.9 回合；MM2.5 两客 coverage 63–69% 死得最快）——**覆盖率决定"死得体面程度"，不决定胜负**。
- 结论：one-shot 决策树与"顶分段净胜水平"的冻结 PPO 之间存在数量级差距；NN 基线有效充当区分度天花板，且 0–20% 的细微差异仍有分辨（DS 矩阵计划整体最能扛）。

**round17-nniter（2026-08-25，NN oracle 反思迭代一轮：8 套 1v1 迭代计划（MM2.5 r5 / DS r3 / K2.6 r2 / M3 r2 × 红牛+雷鹤）经 round16-nn 非镜像对局的 NN oracle 回算 + 全量决策点摘要反思出二代 n1，再跑 28 组对战）**：

- 口径：反思证据为 NN oracle 回算（`plan:reflect --eval-suffix nn`，读 `plan_eval_summary.nn.json`），与此前 ISMCTS oracle 轮次**不可比改善幅度**；剔除镜像对局（16 套矩阵计划的 NN 对局未入迭代素材）。8/8 二代计划落盘（`output/plan-oneshot/round17-nniter/plans/`），DS 雷鹤（fullDigest 280 条）经 3 试、K2.6 两套经 2 试成功，auto-repair 清死规则 2–4 条/份。
- **二代 vs NN（8 组 × 10 局，seeds 20271701，非镜像）**：合计 **1 胜 79 负**（一代基线 0/80），唯一胜场 DS 红牛 1:9。对 NN 本体无实质提升——按 NN 偏好逐点修规则，追不上 NN 每步即时价值决策的战术精度；one-shot 规则政策对 NN 的差距是结构性的，oracle 反思无法在一轮内弥合。
- **二代 vs 自身一代（g1，8 组，seeds 20271801）**：DS 红牛 7:3、DS 雷鹤 6:4（提升）；K2 红牛 7:3、K2 雷鹤 3:7（一升一退化）；M3 红牛 5:5、M3 雷鹤 0:0:10；MM2 红牛 4:6、MM2 雷鹤 0:0:10。
- **跨模型对位（x = 二代 12 组同牌对位；g1x = 一代同构对照，同 seeds 20271801）**：二代总战绩 DS 53:7:0 > K2.6 43:16:1 > M3 12:37:11 > MM2.5 1:49:10；**一代总战绩 DS 52:8:0 > K2.6 42:18:0 > M3 16:34:10 > MM2.5 0:50:10**——两代排名一致、逐组比分几乎重合（12 组中 8 组比分完全相同），**一轮 NN 迭代未改变跨模型相对强度**。一代 DS 横扫 MM2（20:0）与 round11-x（DS r3 vs MM r5 总 37:3）互洽。
- 口径修正：此前所谓"二代排名相对一代完全翻转"是相对 **r0 模型内战口径**（各模型红牛 vs 雷鹤的比分，r0 横评 M3 10:0 > K2 9:1 > MM2 7:3 > DS 0:10）而言；r0 内战比分不构成跨模型强度排序——**跨模型真实强度一代起就是 DS > K2 > M3 > MM2**。模型内战比分与跨模型排名脱钩，本身就是"计划克制关系依模型而变"的又一证据（与 round12-ds 矩阵排名倒置同类）。
- **新退化形态"打不死人"**：mm2-leihe n1 与 m3-leihe n1 参与的 3 组对局全部 0:0:10（15 回合上限互无法终结）；mm2-leihe n1 coverage 56.5%/fallback 43.5%（一代 74.4% 档）。NN oracle 判的 blunder 大量是"没抢伤害/抢先"，过度修正使计划保守化、进攻性丧失——继 M3 红牛 blunder 3.3% 拟合 oracle 嫌疑之后，第二类 oracle 偏好副作用。
- 解读：① NN oracle 证据（每步价值判定 + 全量摘要）更利于大规则集计划（DS 28–41 条）的修订空间，小规则集（MM2 14–16 条）修剪后覆盖崩坏；② 一轮 NN 迭代既不能提升对 NN 胜率（1/80），也未改变跨模型强度排序，可测的增益只在"二代 vs 自身一代"（DS 净 +6、K2 净 0、M3/MM2 被全平稀释）——oracle 反思的边际收益在一轮内已明显衰减；③ §10.8（oracle 升级 cc_AI）优先级进一步提高：NN 既是更强对手也是更可靠的 blunder 裁判。

**round18-mirror（2026-08-25，镜像 NN 对局纳入反思：16 套矩阵计划（mm9 = MM2.5 r0 --unknown × 8 卡组；ds12 = DS r0 --unknown × 8 卡组）经 round16-nn 镜像对局的 NN oracle 回算 + 全量摘要反思出二代 n1，再跑 40 组对战）**：

- 口径：镜像 = NN 执同牌表（`opponentDeckCode` = 计划牌表），fullDigest 中 oracle 动作即"同一手牌 NN 的示范"。16/16 二代计划落盘（`output/plan-oneshot/round18-mirror/plans/`），DS12 保持 22–36 条规则规模。对战配置 `examples/plans/round18-x/`（seeds：vs NN 20271901、其余 20272001）。
- **二代 vs NN（镜像，对比 round16-nn 基线）**：mm9 0:80 → 0:80；ds12 3:75:2 → 0:80（雷鹤 2:8、雷狼 1:9、水凝 0:8:2 三个非零项全丢，10 局样本下属噪声范围但绝无提升）。**镜像示范对"赢 NN"零帮助**。
- **二代 vs 自身一代**：mm9 **11:52:17 大幅退化**（coverage 51–81%、fb 19–49%，莫优 0:4:6 / 水凝 0:0:10 "打不死人"复发）；ds12 **35:35:10 持平**（coverage 75–96%、fb 4–25%，红牛 7:3 / 雷鹤 6:4 / 水八 6:4 提升，雷狼 1:9 退化）。
- **跨模型二代同卡组对位（8 组）**：mm9 5:61:14 ds12——DS 二代横扫。
- 结论：**镜像 NN 迭代的成败由规则集规模决定**。大规则集（DS 28–41 条）给反思留了修订余量，改写后 coverage 不降、强度持平；小规则集（MM 13–16 条）被 NN 证据（blunder 率 44–85%，要改的太多）大幅改写后连贯性丢失，覆盖崩坏 + 保守化。LLM 能从镜像示范"学到"的只体现在 verdicts 的说辞层面——NN 动作背后是价值网络的连续评估，离散化成启发式规则后泛化性尽失，胜率上无可测正向迁移。结合 round17-nniter（非镜像）：NN oracle 一轮迭代整体零和至负和（对 NN 合计 1/240，跨模型排序不变，镜像素材额外引入退化风险）。

**round19-anchor-ablation（2026-08-25/26，提示词差距分析落地 + 策略锚点消融；DS / MiniMax-M3 / GLM-5.2 三模型双臂，起草全程开推理）**：

- 动机：对照 `.opencode/agents/gi-tcg-p0.md` 的赛前策略提示词，one-shot 决策树起草缺三块——①游戏规则与数值表（行动费用、反应系数、伤害公式）、②双方牌表逐卡详情、③策略锚点推理环节（archetype 判定 / killMath / comboLines / riskTriggers / 优先级骨架）。本轮①②直接补进提示词，③做成 `--anchor` 两阶段开关做双臂消融。
- 口径：红牛×雷鹤 known_deck；起草 seed 20260829；内战（同臂红牛 vs 同臂雷鹤，side0=红牛）seeds 20272101、交叉（anchor 计划为 side0 vs 对家 ctrl 计划）seeds 20272201；各 10 局 alternateFirstPlayer；oracle 为 ISMCTS dets=8/sims=64/500ms。产物 `output/plan-oneshot/round19/`（DS）、`round19-m3/`、`round19-glm/`，批跑配置 `examples/plans/round19*.json`（12 个）。
- 提示词变更：新增 `prompts/game-rules.md`（回合/资源、行动费用表、快慢速行动、元素反应表、伤害公式、结束阶段），经 `{{GAME_RULES}}` 占位注入 author/reflect system（`cli/plan-prompts.ts`）；authoring 输入经 `createDeckContext`（@gi-tcg/llm-deck-analyzer）注入双方牌表逐卡费用与效果全文。`--anchor` 臂先经 `prompts/anchor-system.md` 出 StrategyAnchor（sidecar 落 `<plan>.anchor.json`，形状闸要求 archetype/killMath/riskTriggers，失败重试一次）再起草，`plan.sampling.anchor` 记臂。
- **①②的直接效果**：元素骰条件与 `kills`/`damage_min` 从近乎 0 变常态（DS 红牛 ctrl 23/36 条规则用元素骰条件；关键修复 COST_LABELS 补 `GCG_COST_DICE_SAME`）；GLM 锚点 killMath 数值与数据一致（一斗爆发 4+结晶 1+钟剑 1+仙跳墙 3=9 斩杀线）。GLM ctrl 红牛内战 coverage **99.5%**（全轮次最高）、fallback 0.5%、avgRounds 5.9（节奏最快）。
- **锚点臂 coverage 三模型一致更低、fallback 一致更高**（内战，ctrl→anchor）：DS 82.2%→75.5%（fb 17.8%→24.2%）、M3 88.3%→83.9%（11.7%→16.4%）、GLM 99.5%→90.5%（0.5%→9.5%）——锚点约束不增加规则与局面的匹配密度，反而引入更多失配。
- **ISMCTS blunder 双侧合并（anchor − ctrl）**：DS **+7.7pp**（47.7%→55.4%）、M3 **−4.2pp**（53.8%→49.6%）、GLM **+4.4pp**（36.4%→40.8%）——方向依模型而变，无稳定收益。GLM 两臂绝对水平均为三模型最优，但仍高于历史最低 r0（round13 M3 的 23.3%，同口径）。
- **交叉对战（anchor 为 side0）**：红牛线 anchor 累计 **17:3:10**（DS 1:1:8 / M3 6:2:2 / GLM 10:0），雷鹤线 anchor 累计 **9:21**（DS 6:4 / M3 0:10 / GLM 3:7）——anchor 红牛对 ctrl 雷鹤占优、anchor 雷鹤对 ctrl 红牛劣势，交叉优势沿卡组线反转而非沿臂一致，与"锚点统一增益"矛盾，更像卡组×模型形态交互（与 round12-ds 矩阵排名倒置同类）。
- 内战比分（side0=红牛视角）：DS ctrl 7:2:1 / anchor 5:4:1；M3 ctrl 10:0 / anchor 9:0:1；GLM 双臂均 10:0。
- 形态注记：DS 雷鹤 anchor 修复环节丢光 6 个阶段（`dice.ice` 应为 cryo，23 处校验错误后重写为 38 条扁平规则）；M3 红牛 ctrl 有 3 个空阶段壳；GLM 雷鹤 anchor 60 条规则超出 15–40 条建议区间。
- 结论：**③两阶段锚点无稳定收益，本轮质量增量来自①②（规则表 + 牌表数据注入）**。后续方向：killMath 类数值可降级为纯数据注入（不经 LLM 推理环节生成）；校验器考虑加 coverage 下限闸。
- 工程修复（本轮副产，均已落盘）：`cli/llm.ts` SSE 流式读取（`readSseStream`）+ 流中途失败（NGHTTP2_INTERNAL_ERROR）独立 5 次重连重试——修网关 HTTP/2 300s 流超时烧穿；`--max-tokens`（默认 32768）、`--stream`；锚点形状闸。plan-oneshot 13 项测试全绿。

**round19-dsv4 + NN 错手口径（2026-08-26，DeepSeek-V4-Pro 第四模型入场；前 3 模型计划全部改用 NN oracle 重统。术语自此：blunder 改称"错手"）**：

- 口径：NN oracle（clean_genius_AI 冻结 PPO，tau=1.0 logprob 分差，单局一服务会话）对 round19 既有内战对局直接回算。对局为最新版数据而非 v6.3.0——**超词表降质存在但对全模型一致**：311305 钟剑、332013 送你一程按 DummyCard 编码，另有 history 观测下界近似 warning；相对排名有效，绝对值不宜与 v6.3.0 原生对局（round16–18）直接比。
- 模型 id 注记：指定的 `DeepSeek-V4-Pro-0813` 在网关模型列表中存在但 403（当前 key 的 Token Plan 不含）；实际使用别名 `DeepSeek-V4-Pro`（实测可用、默认带推理），别名背后快照版本无法从网关侧核验。
- **前 3 模型内战 NN 错手率重统（双侧合并，ctrl→anchor）**：DS 75.8%→77.9%（**+2.1pp**）、M3 49.8%→56.8%（**+7.0pp**）、GLM 63.9%→58.9%（**−5.0pp**）。对照 ISMCTS 口径 Δ（+7.7 / −4.2 / +4.4）：**③锚点"无稳定收益"在 NN 口径下复核成立**；但 M3 的 Δ 符号在两种裁判间翻转——单模型双臂差异仍在裁判偏好量级，不足为据。
- **裁判改变模型间排名**：NN 口径 ctrl 臂合并错手率 M3 49.8% < GLM 63.9% < DS 75.8%，与 ISMCTS 口径（GLM 36.4% 最优）排序不同；NN 绝对错手率整体高 ~25pp（对规则型政策评分点更密、偏好更严）。
- **DSv4 四计划**（均 `--thinking`，seed 20260829）：红牛 ctrl 53 条顶层规则无阶段机（首产为 0 规则空壳——`validateGamePlan` 已加空计划闸并用 `--repair 5` 重起草）、红牛 anchor 35 条（30 带骰条件）、雷鹤 ctrl 44 条（40 带骰条件）、雷鹤 anchor 49 条。内战（seeds 20272301）：ctrl 臂红牛 2:8 负、anchor 臂红牛 9:1 胜（coverage 99.5%）——同一模型双臂内战胜负反向。
- **DSv4 vs GLM 交叉（4 组 × 10 局，seeds 20272401）**：ctrl 线 DSv4 **15:5**（DSv4 红牛 ctrl 10:0 横扫 GLM 雷鹤 ctrl；GLM 红牛 ctrl 5:5 DSv4 雷鹤 ctrl）；anchor 线 GLM **11:9**（GLM 红牛 anchor 10:0 横扫 DSv4 雷鹤 anchor；DSv4 红牛 anchor 9:1）。合计 DSv4 **24:16** GLM。
- **"错手率低 ≠ 赢"在 NN 口径复现**：DSv4 红牛 ctrl 10:0 横扫 GLM 雷鹤 ctrl 时错手率反而更高（69.5% vs 61.1%）；GLM 四计划全对局合并错手率 60.9% 低于 DSv4 的 64.5%，头对头却 16:24 落后。四组交叉中唯一"错手低者胜"的是 GLM 红牛 anchor 10:0（50.0% vs 67.2%）。
- DSv4 内战 NN 错手率：ctrl 63.3%（红牛 71.1% / 雷鹤 57.6%）→ anchor 67.0%（65.1% / 69.1%），**+3.7pp**——四模型中三个 anchor 臂更差，仅 GLM 改善。
- **ctrl×anchor 交叉（同模型 anchor 为 side0 vs 对家 ctrl，seeds 20272201；DSv4 于 2026-08-26 补跑，前 3 模型为 round19 既有对局）**：四模型 anchor 臂合计 **27 胜 43 负 10 平**——臂对臂直接对抗 ctrl 明显占优（DS 7:5:8 / M3 6:12:2 / GLM 13:7 / DSv4 **1:19**），仅 GLM 的 anchor 臂净胜。这是③锚点无收益最直接的战绩证据，比错手率 Δ 更硬。
- DSv4 交叉注记：anchor 红牛 0:10 负于 ctrl 雷鹤时 coverage 高达 97.6%（fb 2.4%）——"高 coverage ≠ 赢"又一例；其内战 anchor 红牛 9:1 大胜 anchor 雷鹤——臂内战比分与臂间对抗脱钩（与 round17 模型内战比分和跨模型排名脱钩同类）。
- DSv4 交叉 NN 错手：x-hongniu anchor 红牛 61.0% vs ctrl 雷鹤 61.6%（0:10 横扫局两侧错手率几乎持平）；x-leihe anchor 雷鹤 67.2% vs ctrl 红牛 61.6%（四模型八组交叉中为数不多的"错手低者胜"）。
- 工程修复（本轮副产）：`plan:eval --oracle nn` 配 `--trace-file` 时产物改带 `.nn` 后缀（`plan_eval.nn.<tag>.json` / `plan_eval_summary.nn.<tag>.json`），修复会覆盖 ISMCTS side1 文件的命名冲突；`validateGamePlan` 空计划闸（0 规则 = 校验失败）。
- 产物：`output/plan-oneshot/round19-dsv4/`（plans + 锚点 sidecar + games-ctrl/games-anchor/games-x-glm-{ctrl,anchor}-{hongniu,leihe}/games-x-{hongniu,leihe} 八组 + NN 回算）；批跑配置 `examples/plans/round19-dsv4-*.json`（8 个）；前 3 模型 NN 产物 `plan_eval_summary.nn[.side1].json` 与 ISMCTS 口径并存于各自 games 目录。

**round20-xmodel（2026-08-26，决策树铺到 8 卡组 × GLM/DSv4 双模型双臂；镜像对位 + 跨模型×跨卡组 8×8 全矩阵对战，共 1280 局）**：

- 动机：round19 的锚点消融只有红牛×雷鹤 2 卡组，臂对臂结论样本薄；本轮把 one-shot 决策树起草铺到全部 8 卡组（红牛/雷鹤/雷狼/莫优/神宵/水八/水凝/水债），GLM-5.2 与 DeepSeek-V4-Pro 各出 ctrl/anchor 双臂 16 份计划。对战分两块：镜像对位（同卡组同臂，GLM 恒 side0，16 组）与跨卡组交叉（X≠Y，GLM 卡组 X side0 vs DSv4 卡组 Y，每臂 56 格），每格 10 局 alternateFirstPlayer。
- 口径：6 个新卡组一律 `--mirror` 起草（对手=同牌表），`--thinking --temperature 0.2 --max-tokens 65536 --repair 5 --stream`，主 seed 20260830（补跑依次 20260831/34/35/36/37/40/41；另试过一次 131072 token 档并行起草，seed 20260842，因 65536 档先行成功而中止）；红牛/雷鹤沿用 round19 的 **known_deck** 口径计划（起草时已知对手牌表），与 6 新卡组的 mirror 口径存在差异，逐格解读需注意。镜像 seeds ctrl 20273301 / anchor 20273401；交叉 seeds ctrl 20273501 / anchor 20273601。**本轮新对局不做 NN 错手回算（用户明确）**。
- 模型与搁置注记：DS-Flash 与 MiniMax-M3 本轮搁置（用户决定，待起草 harness 调整后重试）——DS-Flash 在 `--mirror` 下推理逐卡枚举不收敛，26–40 万字符 reasoning 被 token 上限截断、正文为空，reasoning dump 内无完整 JSON 可挽救（落盘 `output/plan-oneshot/round20-xmodel/ds/plans/moyou.ctrl.r0.json.attempt{0,1}.reasoning.txt`）；M3 同类但较轻。DSv4 仍用别名 `DeepSeek-V4-Pro`（指定快照 `DeepSeek-V4-Pro-0813` 网关 403，Token Plan 不含）。
- 起草难度 → 计划质量的实例：GLM 水债 anchor 是最难产的计划（跨 8 个 seed、多次 reasoning 在 13–20 万字符处被 token 上限截断，最终 seed 20260841 attempt2 才落盘，37 规则 3 阶段），实战中也是 GLM anchor 臂最弱计划（合并 13:66:1、镜像 0:10，尽管 coverage 95.6–97.9% 正常）——**推理预算耗尽与计划质量受损同现**，与 DS-Flash 的彻底失败是同一机制的两端。
- **镜像对位（GLM 视角）**：ctrl 臂 GLM **24:56** 被压制（仅神宵 9:1、水凝 10:0 两线胜，其余六线全负）；anchor 臂 GLM **33:42:5** 小负（红牛 8:2、神宵 9:1 胜，水凝 4:1:5 五平，水债 0:10 被横扫，雷鹤 4:6 / 雷狼 3:7 / 莫优 1:9 / 水八 4:6 小负）。
- **跨卡组矩阵（GLM 视角）**：ctrl 臂 GLM **204:352:4** 全面落后（仅水债 38:32、水八 37:31:2 两行净胜；DSv4 侧红牛列 58:12、雷鹤列 61:9、水八列 56:13、水债列 60:10 横扫）；anchor 臂 GLM **306:249:5** 反转占优（红牛行 62:7:1、莫优行 51:19、水八行 48:22、雷狼行 45:25、水凝行 44:26；DSv4 雷鹤列 3:57、神宵列 9:51 崩盘；GLM 水债行 13:56:1 全臂最弱）。
- **合并（镜像+交叉，GLM 视角，每臂 640 局）**：ctrl **228:408:4（胜率 35.8%）** vs anchor **339:291:10（53.8%）**；总计 GLM 567:699:14（44.8%）。臂方向把头对头从"明显输"翻成"小胜"，与 round19"GLM 是唯一 anchor 臂净胜的模型"的 2 卡组迹象一致，本轮在 8 卡组 1280 局量级坐实**模型×臂强交互**：DSv4 的直写计划更强、GLM 的两阶段锚点计划更强，各自在对方优势臂被拉开。
- coverage/fallback 两臂持平（镜像 ctrl 92.1%/7.7% vs anchor 93.1%/6.7%；交叉 ctrl 92.3%/7.5% vs anchor 91.9%/8.0%）——round19 中 anchor 臂的 coverage 惩罚（①②注入前）在本轮消失，两臂差异已纯粹是计划质量/相性，而非规则匹配密度。
- 神宵注记：双方神宵计划对其余 7 卡组全劣（GLM 行 ctrl 17:53 / anchor 21:46:3；DSv4 列 ctrl 6:73:1 / anchor 10:60），唯独镜像神宵 GLM 双臂 9:1——单格镜像比分不能外推"计划好坏"（卡组强度与计划质量在单格内不可分），行/列合计（对 7 个不同对手取平均）才接近计划质量信号。
- 产物：计划 `output/plan-oneshot/round20-xmodel/{glm,dsv4}/plans/`（各 16 份 ctrl+anchor，含 `.anchor.json` sidecar；`ds/`、`m3/` 目录为搁置半成品）；对战 `output/plan-oneshot/round20-xmodel/games/`（镜像 16 组）与 `xdeck/{ctrl,anchor}/`（交叉各 56 组）；批跑配置 `examples/plans/round20/*.json`（16 个）与 `examples/plans/round21-xdeck/*.json`（112 个）。

**round22-g53f（2026-08-27，第五模型 GLM-5.3-Flash 入场——智谱官方 API 直连而非此前网关；与 GLM-5.2 全矩阵对战 1280 局）**：

- 口径：`OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4`（key 经内联环境变量传入，**不入库**），模型 id `glm-5.3-flash`；默认开推理（响应带 `reasoning_content`，reasoning_tokens 计入 max_tokens），实测接受 `seed`/`temperature`/`max_tokens` 65536 与 131072。起草口径与 GLM-5.2 逐一对齐：红牛/雷鹤 known_deck（互知对方牌表，seed 20260829），6 新卡组 `--mirror`（seed 20260830），全程 `--thinking --max-tokens 65536 --temperature 0.2 --repair 5 --stream`。
- 起草：**16 份计划全部一次通过，零 repair 触发**（对照 GLM-5.2 水债 anchor 跨 8 个 seed 的难产），规则总数 35–44 全在健康区间。事故注记：anchor 臂首轮因批跑 shell 函数漏传 `--anchor` 旗标（arm 只进了文件名），产出 8 份实为直写的"anchor"计划——靠 0 个 `.anchor.json` sidecar 暴露，全部重出（次轮起每份带 sidecar 存在性自检）。
- 对战：镜像 16 组 + 跨卡组交叉 112 组（g53f 恒 side0 vs GLM-5.2 既有计划），每格 10 局 alternateFirstPlayer；seeds 镜像 ctrl 20273701 / anchor 20273801，交叉 ctrl 20273901 / anchor 20274001。
- **总比分：g53f 341:906:33（胜率 27.3%），GLM-5.2 大胜**。分臂：ctrl 187:440:13（29.8%；镜像 28:48:4、交叉 159:392:9）；anchor 154:466:20（24.8%；镜像 15:65、交叉 139:401:20）。
- 逐卡组（g53f 合并战绩）：仅红牛两臂为正（ctrl 73.8% / anchor 62.0%）与雷狼 anchor 65.0%；灾难行集中在 anchor 臂——莫优 **0:79:1**、水八 1:76:3、雷鹤 3:77，ctrl 臂神宵 7.6%、水债 11.4%、水八 13.8%。GLM-5.2 侧最差列仅为 ctrl 莫优 38.5%（g53f 多个计划稳定吃它）。
- **三模型头对头排序坐实**（全矩阵总计胜率）：DSv4 55.2%（699:567 vs GLM-5.2）> GLM-5.2 72.7%（906:341 vs g53f）> g53f——flash 档与旗舰档的 one-shot 计划质量差清晰可见。
- **锚点臂方向第三次依模型而变**：GLM-5.2 是 anchor>ctrl（53.8% vs 35.8% 对 DSv4），DSv4 与 g53f 均 ctrl>anchor（g53f 29.8% vs 24.8%）——"两阶段锚点有增益"目前只是 GLM-5.2 特性，不具备跨模型普遍性。
- coverage 注记：g53f 两臂持平（93.5%/6.4% vs 94.0%/5.9%）；个别计划低覆盖异常——神宵 anchor 镜像 77.2%/fb 22.6%（0:10）、水凝 ctrl 83.8%/fb 16.2%（0:7:3），低覆盖与惨败同现但非普遍（多数惨败计划 coverage 仍 95%+）。
- **NN 胜率差分评估（2026-08-27，`--oracle nn` valueDiff 口径，§7；128 组 2560 局侧全量回算，78547 有效点位，8600 跨界点排除）**：当前预估胜率（决策点 valueBefore→winrate）glm52 两臂 ~64–65% vs g53f ctrl 37.9% / anchor 47.6%——NN 从开局后段（seq≈8 起）即稳定判 glm52 领先，ctrl 臂差距最大（65–70% vs 33–40%），与实际 72.7% 总胜率方向一致；每行动胜率差分四组皆为负均值（glm52 ctrl −1.91pp / anchor −2.91pp、g53f ctrl −1.87pp / anchor −4.15pp），反映 value 头的中盘乐观漂移（向终局回归），可比的只有相对序：anchor 臂 g53f 掉点显著更深（−4.15pp vs glm52 −2.91pp），与 anchor 臂战绩最差互证。崩落率（valueCrashRate，单行动掉 >5pp）：g53f 27.3%/32.5% vs glm52 27.2%/28.0%。**逐局轨线**（`trajectories.csv` 87202 点全量导出；胜率轨线：`trajectories-mirror-grid.png` 镜像 16 组 4×4 网格、`trajectories-by-model-arm.png` 模型×臂 spaghetti；胜率差分轨线：`valuediff-mirror-grid.png`、`valuediff-by-model-arm.png`，差分为散点+按序号均值线、排除跨界点）：镜像网格可见两组极端形态——全崩型（神宵 anchor 0:10：g53f 轨线序 20 起齐沉向 0，glm52 齐升向 100）与缠斗型（水凝 ctrl 0:7:3：大量轨线横在 40–60% 带对应平局）；差分轨线显示两组模型共同的开局段负差分（seq<20 均值 −3..−8pp，与乐观漂移一致），中后盘回到 0 附近，g53f anchor 开局段最深（−8pp）；spaghetti 胜率均值线尾部（seq≳80）有明显**幸存偏差**（撑到长局的恰是优势局，g53f anchor 均值在 seq 90+ 翘到 95% 即此故），解读均值线需配合样本量（差分均值线只画 n≥30 的序号）。**按回合（round）与回合内第 k 次行动决策（actionIdx，由 seq 派生——点位自带 turn 字段只是 side 0/1）两种粒度**（`valuediff-by-round.csv/.png`、`valuediff-by-actionidx.csv/.png`，n≥30 才画）：开局三个回合是所有模型的共同"失血段"（round 1–3 均值 −3.3..−6.5pp、崩落率 32–47% 为全曲线最高，与开局乐观漂移同向）；glm52 预估胜率在 2–7 回合爬到 69–72% 平台，长局（12+ 回合）向 50% 回落（幸存偏差——撑到长局的多是它的劣局），g53f ctrl 则在 4–6 回合跌到 31–33% 谷底后随长局回升。actionIdx 粒度下两臂形态分化最明显：**g53f anchor 在同一回合内行动越靠后掉点越深**（k=1 −1.5pp → k=9 −8.7pp，单调下滑），glm52 两臂全 k 保持浅负（−1..−4pp），g53f ctrl 高 k 反而转正（同为幸存偏差——能在一个回合里行动 8+ 次的本就是它的顺风局）。产物 `output/plan-oneshot/round22-g53f/nn-valuediff/`（`valuediff-by-seq.csv` 行动序号×模型×臂聚合 + 双面板均值图 + 逐局轨线/差分四图 + round/actionIdx 两粒度 CSV 与图 + `plot-*.py`，聚合器 `scripts/aggregate-round22-valuediff.ts`、轨线导出 `scripts/dump-round22-trajectories.ts`；matplotlib 在 `.tmp/plot-venv` 隔离环境）。口径警示沿用 §7：超词表降质（非 v6.3.0 对局）对全模型一致，valueDelta 与 blunder 同源不独立。
- 产物：计划 `output/plan-oneshot/round22-g53f/plans/`（16 份 + 8 sidecar），对战 `output/plan-oneshot/round22-g53f/games/` 与 `xdeck/{ctrl,anchor}/`；批跑配置 `examples/plans/round22-g53f/`（128 个，生成器 `scripts/gen-round22-g53f-configs.ts`）。

M1–M3 是"实验能跑且有判别力"的最小集；M4 接上反思闭环；M5 是论文级对照。

**M3 实现注记**（2026-08-22）：

- 对齐方式从"stateLogIndex 下标"改为**状态签名**：trace 记录决策时刻玩家视角 state 的规范化 JSON（`planStateSignature`，归一化 PlayerStatus），eval 侧对每个 canResume 且 phase=action 的暂停点用 `exposeState(side, state)` 重算签名精确匹配。原因：引擎暂停点与 rpc 决策点不是一一对应（同 round 内双方交替行动、暂停含执行前后态）。
- 已知缺口：极少数决策点（实测 2/36）的 notify 态在任何暂停点都不存在完全一致的 state（对手隐藏骰计数边界差异），以 warning 显式跳过——诚实报告匹配率，不做近似对齐。
- oracle 强度敏感性：弱配置（dets=2/sims=16/150ms）下 blunderRate 噪声极大（41.7% → 强配置 16.7%），报告必须附 oracle 配置；visitGap 阈值 τ 默认 0.1。
- lethal 探针（lethalMissRate）未实现：需要"当前候选中是否存在斩杀"的判定，可由 preview 的 `causeDefeated` 做近似，留给 M4 一并处理。

## 10. 开放问题与风险

1. **oracle 信息对等**：oracle 必须只看执舵方视角 state，严禁上帝视角，否则 blunder 判定系统性偏苛。ISMCTS 旧口径靠 determinize 实现；NN 标准口径输入同为玩家视角 `exposeState`（隐藏信息由端到端策略隐式处理）。实现时写测试钉死（构造已知手牌的局面，断言 oracle 输入 state 不含对手手牌）。
2. **计划表达力上限**：规则链 + 阶段机 ≈ 有限状态政策，跨回合记忆只有 phaseId 一档。不引入自由计数器（保持 schema 声明式、可校验）；若实验证明表达力是瓶颈，再评估加 `counters`。
3. **测的是规划还是"写 DSL"**：schema 保持声明式、校验器即时反馈可修复错误，把格式失败与规划失败分开计分（author 轮记录修复次数作为协变量）。
4. **lethal 判定的近似性**：`damage_min`/`kills` 依赖 preview 数据，复杂斩杀（多段反应链）规则表达不了——这是政策的内在极限，单独以 `lethalMissRate` 度量，不算执行失败。
5. **作者通道纯度**：authoring 用纯 API 一次性调用（非交互式 agent 会话），保证"one-shot"字面成立；few-shot 示例固定且记入 plan 元数据。
6. **对手政策泄漏**：plan vs plan 镜像局双方用同一份计划时，"作者是否预判了自己"成为解释混杂；镜像臂只用于机制验证，能力结论以 vs baseline / vs MCTS / 未知牌表臂为准。
7. **AGENTS.md 同步**：实现 M1 时更新 `packages/gi-agent/AGENTS.md` 包结构契约（新增 `src/runtime/plan-oneshot/`、`src/evaluation/plan-eval/`）与 CLI 入口表（`plan:author` / `plan:validate` / `plan:eval`）。
8. **oracle 升级 / 外部神经网络基线（✅ 2026-08-25 已接入并实测）**：原 oracle 为 ISMCTS + HP 比例叶子估值，强度有限——它本身也会犯错，blunder 绝对值被 oracle 上限压制（相对趋势仍有效）。现外部神经网络 AI（clean_genius_AI 的冻结 PPO checkpoint，经仓库内 `aibridge - 副本/aibridge - 副本/` 桥接）已作为强基线对手接入 `plan:batch`（`opponent: {"type":"nn"}`）与强 oracle 接入 `plan:eval`（`--oracle nn`）。**口径纪律不变**：ISMCTS 轮次保持 dets=8/sims=64/500ms；NN 口径（tau 为 logprob 分差阈值，产物 `plan_eval.nn.json`）与 ISMCTS 口径并存、不直接可比。**2026-08-28 口径更新：错手判定（blunder/oracle 归因）统一采用 NN 口径，ISMCTS 降为旧口径仅作历史轮次复现，不再用于新实验的错手判定。**

   **该 AI 的性质（论文需要提及）**：外部基线为第三方**闭源**模型（clean_genius_AI，作者 cc 等；其 LICENSE 明确"这不是一个开源项目"）。我们只对其公开提供的 checkpoint 做黑盒推理，不参与、不复现其训练。模型为 PPO 自对弈训练的 policy/value 网络（EDS 统一 checkpoint `带支付骰子策略(或许用作插件).pt`：约 38.5M 参数，输入 2847 = 2490 状态 + 357 动作掩码；5 个 checkpoint 的 sha256 与桥接 manifest 逐一核验一致；权重不入仓库、不分发）。决策形态为"冻结 PPO 策略 + 保守 preview 重排"，可选叠加 PUCT/A* 搜索档（本接入目前只用纯策略档）。**实战水平口径（用户确认，论文引用时保留此表述）：约在人类玩家可在顶分段取得净胜的水平**，是本 benchmark 的"强外部基线"。

   **版本约束（用户确认）**：bridge 适配后的模型只支持较旧游戏版本——桥接钉死 game v6.3.0 / core 0.20.7（平台 gameVersion index 28；模型词表 109 角色 / 310 行动卡 / 357 动作）。使用该 oracle/基线的对局必须以 v6.3.0 数据开局（`plan:batch` 在 opponent=nn 时强制；其余对手类型可用 `gameVersion` 字段显式钉版本以兼容 NN 回算），牌表不得超出版本词表（超词表定义只能经桥接的语义替身映射近似，结论外推需谨慎）。

   **接入架构（2026-08-25 实现）**：
   - Python 侧：`aibridge - 副本/aibridge - 副本/src/gi_ai_bridge/policy_service.py`——stdio JSON-lines 常驻服务，包 `ModelBridgePolicy`（纯策略档，不依赖 cppo 本地模拟器；gitcg 绑定仅未来 PUCT 档需要）。会话 = (gameId, observer)，每会话独立 `random.Random(seed)` 保证确定性。
   - TS 侧（gi-agent）：`src/runtime/nn-bridge/nn-service-client.ts`（进程/协议客户端，env 可覆盖路径）、`src/runtime/nn-bridge/nn-player-io.ts`（PlayerIO 实现；铁律同 PlanPlayerIO——任何服务异常回退最小合法响应，绝不向引擎抛错）。plan:eval 侧 `eval-game-nn.ts`：从 state log 暂停点恢复 `new Game(state)` 重放引擎循环截取决策点的真实 Action 候选列表，再交 NN 排序。
   - 冒烟/探针脚本：`scripts/nn-bridge-capture.ts`（真实 notification/rpc 样本）、`scripts/nn-baseline-probe.ts`（NN vs baseline 强度探针）；Python 侧 `scripts/smoke_policy_service.py` 端到端协议冒烟。

   **首批实测（2026-08-25，v6.3.0 数据 + 示例牌表，全 CPU）**：
   - 强度 sanity：NN vs BaselinePolicy 10 局 **10:0**（交替执舵侧，avgRounds 4.4，模型作答 265/265，服务错误 0）——对本仓库启发式 baseline 呈横扫，符合"强基线"定位。
   - oracle 口径对照（同一 run、同 15 个决策点）：ISMCTS（dets=8/sims=64/500ms）blunder 1/15（6.7%），NN oracle blunder 9/15（60%）——弱 oracle 的 visit 分布噪声把大量真实失误压到阈值以下，正是本条存在的动机；NN 口径的分辨率显著更高。示例计划本身极弱（6 条规则、fallback 33%），绝对值不代表一般水平。
   - 已知限制：① 词表边界卡（如示例牌表中的 312302 炽烈的炎之魔女——v3.3 起合法存在，但不在 checkpoint 的 310 行动卡词表内）按 DummyCard 编码，NN 略降质（服务侧 warning 可见）；② `rerollDice` 暂走桥接 baseline 兜底（模型的重掷策略未在纯策略链路暴露）；③ oracle 模式的 history 相关特征为近似（state log 无玩家视角增量，按观测下界 + 初始牌表先验）；④ 单服务进程串行推理，plan:batch 并发高时成为吞吐瓶颈（每决策 ~0.2–0.4s CPU）。
   - **胜率差分评估（2026-08-27 已落地）**：三个对战 checkpoint 均带 value 头（tanh ∈ (-1,1) 局内胜率估计，决策方视角）；权重目录另有独立的 `lineup胜率预测.pt`（赛前 lineup 级，未接入）。`plan:eval --oracle nn` 默认开启 valueDiff：每个决策点记录 valueBefore/After/Delta（行动后取下一 action 暂停点估值，对方视角取负、终局 ±1/0，跨掷骰边界的点排除出聚合），valueDelta < -0.1（≈5pp 胜率）记崩落点，perRule 同步聚合——与 blunder（策略分歧）互补的行动后果指标，可直接喂反思管线。细节与实测见 `docs/nn-bridge-integration.md` §7。

   **2026-08-24 勘察结论**：
   - `D:\AI\GTCG\cc_AI\Windows_AGI`（AGI.exe）是同一 AI 的 UE5 闭源 GUI 对战客户端（自带 C++ 引擎 + DirectML 推理 + HTTPS 平台客户端），只能整局对战、无法作为可查询 policy/oracle 嵌入——不作接入路线。
   - 桥接纯策略链路（`ModelBridgePolicy.decide(CanonicalState, RpcEnvelope)`，aibridge `model_policy.py`）只依赖 torch + checkpoint + `pynet_trans.py`（已就位 `D:\AI\GTCG\clean_genius_AI`）+ 映射配置，**不需要** cppo 本地模拟器；PUCT 搜索档才需要 `gitcg==0.20.7` Python 绑定（PyPI win_amd64 wheel 已确认可得）。
   - `CanonicalState`/`RpcEnvelope` 为观察者安全结构，可由本仓库 `exposeState` 玩家视角 state + rpc `Action` 直接转换（平台与本仓库同源）。
