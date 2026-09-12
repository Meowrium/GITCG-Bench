# Battle Benchmark 自进化实现方案（v0.2）

> **状态：草案，待评审。** 2026-08-01。
> **修订**：v0.2（2026-08-02）——开放决策全部拍板（§六）：分节集合定为四节（"出牌节奏"扩充为**出牌/技能节奏**）；2:1 节奏确认；**Meta Insight 计入 knowledge 总长度上限**；阶段 2 算子顺序**先 E2 后 E1**；新增**元认知贡献实验**（§四 阶段 2）。联动修订 §二 M2/M4、§四、§五。
> 上游设计：`DESIGN.md` v0.7（§十三 机制选型、§七 数据契约、§八 工程清单、§十一 路线图）。
> 理论依据：`packages/gitcg-theory/paper-scout/papers/heuristic-learning/selected/`（MeEvo 2606.14202 / A-CEoH 2601.19622 / CoupleEvo 2605.06341 / RAISE 2606.31801）。
> **范围**：本文档只覆盖"被测机制"（自进化回路）的实现；测量侧（三层审计器、交叉验证器、统计报告）按 DESIGN §四/§八 另行排期，此处只定义接口。

---

## 〇、事实基座（代码现状核查，2026-08-01）

### 可复用（已验证存在）

- **执行链完整**：`packages/mcp/src/headless/`——`HeadlessGameRunner.ts`（起游戏、HTTP bridge、AIClientPlayerIO）、`run-headless.ts`（单局入口）、`llm-agent.ts`（1194 行，LLM 对战进程）、`run-batch-llm.ts`（877 行，批量编排）。批量配置 `.opencode/batch-llm-v2.json`，启动脚本 `.opencode/run-batch-llm.ps1`（并发 4、每局独立端口、agent 超时 30 分钟）。
- **日志齐全**：llm-agent 的 `LlmLogger`（`llm-agent.ts:166-178`）写 `p{0,1}_llm.jsonl`，含 `llm_request / llm_response（usage、elapsed_ms）/ llm_raw_response / tool_result / final_result` 等类型；batch 输出 `run_<ISO>/<matchup>_game<N>/{headless.log, agent_p{0,1}.log, game_replay.json}` + `run_config.json` + `summary.json`。
- **知识注入点现成**：`llm-agent.ts` 的 `tryLoadSandboxStrategy`（:461-535，把 `<sandboxDir>/strategy.json` 渲染进 system prompt）与 `injectStrategyAnchor`（:542-607）——knowledge 注入复用同一机制（新增 `--knowledge-file` 参数，见 M2）。
- **先后手交替先例**：引擎侧 `packages/gi-agent/src/mcts/cli/run-ismcts-gen-vs-gen.ts:19`（"Seats alternate every game"），照抄即可。
- **引擎受害者**：`packages/gi-agent/src/sandbox/runner.ts` 的 `SandboxRunner`（直接 `Game.createInitialState` 对打，秒级/局）。
- **卡组编解码与卡池**：`packages/assets-manager/src/sharing.ts`（`staticDecode`/`staticEncode`）；全卡定义 `@gi-tcg/data`（`packages/data/src/end.ts` registry）；真实环境卡组池 `packages/benchmark/gold-match/deck-list.json`（RAISE 的名义分布 S0）。

### 缺口（本方案要建的）

1. **知识闭环为零**：`LLMDeckKnowledge` schema 只存在于 deck-analysis DESIGN.md（:727-845），`data/llm-knowledge/` 无生产者；`strategy_store`（写 `runtime-plans/<sessionId>_strategy.json`，`StandaloneMcpToolHandler.ts:522-615`）与 sandbox-generator（写 `<sandboxDir>/strategy.json`）是**局内锚点**，无跨局记忆语义。
2. **无赛后反思环节**：llm-agent 打完即终，`iterationLog` / `refinedKnowledge` 无生产者。
3. **先后手交替未实现**：`run-batch-llm.ts` 的 `BatchMatchup`（:68-81）无 `alternateFirstPlayer`（DESIGN §八 P0）。
4. **两套注入链路并存**：opencode 原生 agent 模式（`.opencode/agents/gi-tcg-p0.md`，Task 委托 + strategy_store）与 harness 模式（llm-agent 进程内注入）。**决议：实验一律走 harness 链路**——批量自动化与"被测侧冻结"验收（DESIGN §八 P1）只在 harness 链路可控；opencode 原生模式不参与实验。

---

## 一、总体架构

```
                ┌──────────────── evolve-runner（编排器，M5，新） ─────────────────┐
                │ 轮次结构（K 轮 × matchup）、对照臂开关、每轮全新进程、先后手交替      │
                └──────────┬──────────────────────────────┬───────────────────────┘
             每局（NE 层）  │                              │ 每 N=2 轮（ME 层）
                           ▼                              ▼
        ┌───────────────────────────┐     ┌──────────────────────────────┐
        │ ① 对战（现成）              │     │ ④ meta-reflection（M4，新）    │
        │ run-batch-llm + llm-agent   │     │ 读不可变历史 → Meta Insight     │
        │ + --knowledge-file 注入     │     │（收敛诊断/局限分析/路径建议）    │
        └─────────────┬─────────────┘     └──────────────┬───────────────┘
                      ▼                                  │ 写入下轮反思策略
        ┌───────────────────────────┐                    │
        │ ② BattleRecord 组装（M1，新）│                    │
        └─────────────┬─────────────┘                    │
                      ▼                                  ▼
        ┌─────────────────────────────────────────────────────┐
        │ ③ reflection-worker（NE 层反思，M3，新）               │
        │ EoH 算子（默认 M1）更新 knowledge 的**一个**分节        │
        └────────────────────────┬────────────────────────────┘
                                 ▼
              LLMDeckKnowledge（分节，version 递增，唯一跨局载体）

  训练侧课程（每若干 matchup 触发，RAISE，独立于上述回路）：
  ⑤ adversary-search（M6，新）：卡组基因 EA（引擎 AI 受害者粗筛，零 LLM）
      → top 对抗 matchup → 被测 LLM 小样本验证 → 加入训练 matchup 池
```

组件-论文映射：

| 模块 | 论文来源 | 作用 |
|------|---------|------|
| ③④ 双层反思循环 | MeEvo | 主框架（NE:ME = 2:1 起步） |
| ③④ 的 prompt 上下文 | A-CEoH | 注入可执行上下文（digest schema/工具 API/规则代码） |
| knowledge 分节 + 轮转 | CoupleEvo | iterative 协调，禁止整体重写 |
| ⑤ 对抗 matchup 搜索 | RAISE | LLM-free 内层 EA + ε-ball 分布锚定 |
| iterationLog 埋点 | DGS | 只记录 （算子， 父代， lineage)，不建代理模型 |

---

## 二、模块设计

### M0 先后手交替（DESIGN §八 P0）

- 改动：`run-batch-llm.ts` `BatchMatchup`（:68-81）加 `alternateFirstPlayer?: boolean`；game 序号的奇偶对调传给 `run-headless` 的 deck0/deck1 槽位（引擎 `currentTurn` 硬编码 0，无需改引擎，DESIGN v0.4 已核实）。先例：`run-ismcts-gen-vs-gen.ts:19`。
- BattleRecord.firstPlayer 记录**相对被测侧**的先后手。
- 验收：镜像 matchup 下被测侧先后手比例 1:1。

### M1 BattleRecord 组装器（DESIGN §八 P1）

新模块 `packages/benchmark/battle-benchmark/src/record/assemble.ts`（本目录目前只有 DESIGN.md，阶段 0 一并建 package 脚手架）。

输入 `run_<ISO>/<matchup>_game<N>/` 目录，输出 DESIGN §7.1 的 BattleRecord。字段来源：

| BattleRecord 字段 | 来源 |
|---|---|
| `decisions[].rawRequest` | `p{who}_llm.jsonl` 的 `llm_response.tool_calls`（sanitize 前原始调用，天然满足 v0.4 要求） |
| `decisions[].chosenAction` | 对应的 `tool_result`（`choose_action` 执行结果） |
| `decisions[].digestSnapshot` | `get_turn_digest_v1` 的 `tool_result` |
| `decisions[].latencyMs / tokenUsage` | `llm_response.elapsed_ms / usage` |
| `decisions[].decisionKind` | 工具名映射（`choose_action / switch_hands / choose_active / reroll_dice / elemental_tuning / select_card`，与 v0.4 对齐） |
| `result.winner` | `final_result`（fallback：`run-batch-llm.ts:577-615` 的 tryGetWinner 逻辑） |
| `firstPlayer / knowledgeRef / opponentPolicy` | run_config 扩展字段（M2/M5 写入） |
| `mutationLogRef` | `game_state_log.json`（2026-08-20 起：seed + 每暂停点 state + 逐段 mutation；旧局兜底 `game_replay.json`） |

### M2 知识通道（DESIGN §八 P1，核心新件）

新模块 `packages/benchmark/battle-benchmark/src/knowledge/`：

- `schema.ts`：继承 deck-analysis DESIGN.md:727-845 的 `LLMDeckKnowledge`（`deckCode / createdAt / version / preGameAnalysis / iterationLog / refinedKnowledge`），做两处扩展（CoupleEvo 分节 + DGS 埋点）：

```ts
// refinedKnowledge 改为分节结构（分节集合固定，写入 config）
interface SectionedRefinedKnowledge {
  sections: {
    diceManagement: string       // 骰子管理
    cardTempo: string            // 出牌/技能节奏（v0.2 扩充：含技能使用时机与爆发规划）
    characterSwitching: string   // 切人时机
    matchupNotes: string         // matchup 专项
  }
  sectionVersions: Record<SectionId, number>
}

// iterationLog 条目扩展（DGS 埋点 + 分节追溯）
interface IterationEntry {
  /* …deck-analysis 原字段（predictedMatchup / gameResult / postGameReflection 等）… */
  operator: "M1" | "M2" | "E1" | "E2"   // 本轮使用的 EoH 算子
  targetSection: SectionId               // 本轮进化的分节
  parentSectionVersions: Partial<Record<SectionId, number>>  // 父代版本
  lineageId: string
}
```

- **存储**：`data/battle-benchmark/{runId}/knowledge/round{i}.json`（DESIGN §7.3 已定）；`knowledgeRef = deckCode + version`。
- **注入**：llm-agent 加 `--knowledge-file` 参数，开局把 knowledge 渲染进 system prompt（复用 `tryLoadSandboxStrategy` 的渲染机制，`llm-agent.ts:526-527`）。实验模式下**禁用 `strategy_store` 与 sandbox**（`StandaloneToolRegistry.ts:33-40` 已有按模式隐藏工具的先例，加 `knowledge` 模式）——LLM 局内不读写记忆工具，记忆通道唯一化自然成立，记忆擦除对照 = 不注入。工具面裁剪也可用 llm-agent `--hidden-tools` 实现（LLM 侧不可见 + guard 层拒绝执行，见 DESIGN §八「实验性工具隐藏」）。
- **长度上限**：单节 ≤800 字符、总量 ≤3000 字符（**含 Meta Insight**，v0.2 已决；初值写入 config；超出由反思器压缩——压缩本身是机制的一部分，可被消融）。
- Meta Insight 存 `knowledge/meta/round{i}.json`，与 knowledge 本体分离存储——**仅为记忆擦除时一并清除的便利**；其长度**计入**上述总量上限（v0.2 已决），反思器压缩时须为 Meta Insight 留预算。

### M3 reflection-worker（NE 层）

新进程 `packages/benchmark/battle-benchmark/src/evolve/reflect.ts`，每局后由 evolve-runner 调用（llm-agent 保持"打完即终"，反思在独立进程——便于对照臂开关与冻结验收）。

- **输入**：BattleRecord + 当前 knowledge + （可选） Meta Insight（M4 产物）+ **算法上下文**（A-CEoH）：TurnDigestV1 类型定义源码、工具 API 描述、相关规则代码片段——而非人工撰写的问题描述。
- **算子**（EoH 到 knowledge 的翻译）：`M1` 精炼当前分节（默认）；`M2` 只调分节内数值阈值；`E1` 换角度重写分节；`E2` 提取最近 K 条反思的共同骨干合成（§二 S4 迁移的生成机制）。
- **默认行为**（CoupleEvo iterative）：每轮只进化**一个**分节，分节按 round-robin 轮转；算子默认 M1。**禁止一个 prompt 整体重写 knowledge**。
- **输出**：knowledge version+1 + iterationLog 追加（含战前 `predictedMatchup`——评测 B 的输入，由同一 worker 在战前生成）。
- **模型**：与被测模型相同（DESIGN §13.5）。

### M4 meta-reflection（ME 层）

新进程 `packages/benchmark/battle-benchmark/src/evolve/meta-reflect.ts`，每 N=2 轮 NE 后触发一次。

- **输入（只读历史）**：最近若干轮的 BattleRecord 摘要 + iterationLog 全量 + 违规率曲线（审计器有则给，无则缺省）+ 校准误差。历史不可变、永不改写（MeEvo 的表观遗传原则，与 §7.1 append-only 一致）。
- **输出 Meta Insight（三段式）**：① 收敛诊断（过早收敛 / 稳步 / 振荡 / 停滞）；② 局限分析（反复无效的策略）；③ 路径建议（下轮用哪个算子、动哪个分节、重点反思什么）。
- **消费方式**：作为下一轮 M3 的输入（指导反思策略），不直接改写 knowledge。
- **对照**：无元反思臂 = 跳过本模块、NE 照常（DESIGN §13.4）；v0.2 起该臂同时是**元认知贡献实验**的对照臂（§四 阶段 2）。

### M5 evolve-runner（编排器）

新模块 `packages/benchmark/battle-benchmark/src/evolve/run.ts`，在 run_config.json 上加 `evolution` 块：

```json
{
  "evolution": {
    "rhythm": { "ne": 2, "me": 1 },
    "sections": ["diceManagement", "cardTempo", "characterSwitching", "matchupNotes"],
    "sectionRotation": "round-robin",
    "operators": ["M1"],
    "controlArm": "full | no-memory | no-reflection | no-meta | shuffled-history | warm-start",
    "rounds": 5,
    "gamesPerRound": 20,
    "knowledgeLimit": { "perSection": 800, "total": 3000 }
  }
}
```

- 每轮流程：全新 llm-agent 进程（现成）+ 注入指定 knowledge version → M1 组装 BattleRecord → M3 反思 → version+1；到节奏点调 M4。
- 对照臂全部表达为 config（无记忆 = 不注入且 version 恒 0；warm-start = 固定注入 version=0 且禁反思，对应 DESIGN §6.2 建议）。
- 先后手交替依赖 M0；matchup 顺序随机化（DESIGN §6.4）在本层实现。

### M6 adversary-search（RAISE，训练侧课程）

新模块 `packages/benchmark/battle-benchmark/src/adversary/`：

- `genes.ts`：卡组基因 = 连续松弛向量（角色池权重 + 卡池计数权重）；候选卡池 = gold-match `deck-list.json` 真实环境卡组并集（名义分布 S0）。
- `decode.ts`：基因 → 合法卡组（top-k 采样 + 合法性修复：30 卡、每张 ≤2、3 角色、武器/元素装备约束——约束从 `@gi-tcg/data` 定义提取）。
- `distance.ts`：归一化 L1（角色集合距离 + 卡计数向量距离，权重写入 config）；ρ 初值 = S0 内 pairwise 距离中位数。
- `search.ts`：内层 EA（照 RAISE Algorithm 2：均匀交叉 pcross=0.5 + 高斯变异 + ε-ball 边界投影；Pin=8、Gin=4、每 τ 个 matchup 刷新一次）。
- **受害者评估**：`SandboxRunner`（引擎 AI，秒级/局）每候选 n=20 局，对抗分数 = −WR（带 CI；噪声预算写入 config）。**零 LLM**。
- **分层验证**：top-3 对抗 matchup → 被测 LLM 各打 20 局（harness 链路），WR 显著低于单元格基线才确认失败模式、加入训练 matchup 池。所有结论标注受害者身份（引擎偏科只用于粗筛排序，DESIGN §三 参考 AI 限制）。
- **边界**：只驱动训练轮 matchup 选择；测量侧 holdout / 对手冻结不动。
- **降级路径（先跑通）**：手工 5–10 个扰动卡组走"引擎粗筛 → LLM 验证"全流程，验证 eval 管线与噪声水平后再上基因化搜索。

### M7 审计器接口（不展开）

三层决策审计器按 DESIGN §四/§八 P2 排期；本方案只约定：M3/M4 消费其 Tier 1 违规率作为反思输入（有则给，无则缺省），`auditFlags` 由组装器在 BattleRecord 中留位。

---

## 三、数据契约扩展

- run_config.json：加 `evolution` 块（M5）+ `opponentPolicy.checkpoint`（DESIGN §7.1）+ 每局 firstPlayer 记录。
- BattleRecord：沿用 DESIGN §7.1，字段来源见 M1 映射表。
- iterationLog：扩展 `operator / targetSection / parentSectionVersions / lineageId`（M2）。
- 产物目录（DESIGN §7.3 扩展）：

```
data/battle-benchmark/{runId}/
  config.json                  # + evolution 块
  rounds/round{i}/game{j}.json # BattleRecord
  knowledge/round{i}.json      # 分节 LLMDeckKnowledge 快照
  knowledge/meta/round{i}.json # Meta Insight（与本体分离）
  adversary/round{i}.json      # 对抗搜索结果（阶段 3）
  audits/round{i}.json         # 违规率向量（测量侧排期）
  report.json                  # 学习曲线族
```

---

## 四、分阶段计划（对齐 DESIGN §十一）

| 阶段 | 模块 | 验收标准 | 工作量估计 |
|------|------|---------|-----------|
| 0 | package 脚手架 + M0 + M1 + M2 | 同一 matchup 两臂（注入/不注入 knowledge）各 20 局跑通；BattleRecord 齐字段；先后手 1:1 | 2–3 天 |
| 1 | M3（仅 M1 算子）+ M5 | **最小自我改进实验**：单 matchup × K=5 轮 × 记忆开/关，每臂 100 局（DESIGN v0.6 已决）；产出第一个"是否可归因的自我改进"答案 | ~1 周（含跑局） |
| 2 | M4 + 分节 + **E2 算子**（先 E2 后 E1，v0.2 已决） | matchup 矩阵 + holdout（评测 E）；审计 Tier 1/3 接入；**元认知贡献实验**：full vs no-meta 两臂、同 matchup × K 轮，单元格内聚合 WR 主对比（预注册假设"ME 层提升单元格内 WR"；每臂 100 局、检测口径 ~14pp，按 DESIGN §4.4；次要指标为校准误差与 Tier 1 违规率）——ME 层独立贡献定位 | 1–2 周 |
| 3 | M6（先手工降级路径，后基因化搜索） | 对抗课程闭环；完整评测 A–F 报告 | 1–2 周 |

---

## 五、成本估算

- **LLM 对战**：~0.15 元/局（DESIGN v0.4）× 阶段 1 的 200 局 ≈ 30 元；wall clock ~15–30 分钟/局、并发 4 → 阶段 1 约 2–3 天机器时间。
- **反思 / meta-reflection**：每局 1–2 次普通 LLM 调用，成本可忽略。
- **元认知贡献实验**（阶段 2，v0.2）：full / no-meta 两臂各 100 局 ≈ 30 元 + 2–3 天机器时间。
- **对抗搜索**：引擎局秒级，每次刷新 8 候选 × 4 代 × 20 局 = 640 局 ≈ 分钟级；LLM 验证 3 × 20 = 60 局 ≈ 10 元。
- 预算纪律：一切 fitness 只来自 O1–O5（单元格内 WR、违规率、校准误差），禁止 LLM-as-judge 作为选择信号（DESIGN §九）。

---

## 六、风险与开放决策

| 风险 | 缓解 |
|------|------|
| 受害者代表性（引擎粗筛到的对抗 matchup 不一定克被测 LLM） | 分层验证（引擎粗筛 → LLM 确认）；结论标注受害者身份；引擎偏科只用于排序 |
| 评估噪声进内层 EA | 每候选 n=20 局 + 小种群；只要求排序稳定，不追求精确对抗分数 |
| 知识长度膨胀冒充改进 | 分节上限 + 总量上限 + 消融开关（DESIGN §十二 已有，此处落实到 config） |
| 反思模型漂移 | 与被测模型同模型、同温度，写入 config 冻结 |

开放决策（v0.2 全部已决）：

1. 分节集合 → **定为四节**，"出牌节奏"扩充为**出牌/技能节奏**（含技能使用时机与爆发规划）。
2. N:M = 2:1 → **确认为默认节奏**，写入 config 可调；若阶段 2 元认知贡献实验显示 ME 层无显著贡献，再调节奏或降频。
3. Meta Insight 是否计入总长度上限 → **是**。与 knowledge 本体分离存储仅为记忆擦除时一并清除；反思器压缩时须为 Meta Insight 留预算。元认知对对战表现/胜率的影响由**元认知贡献实验**专门测量（§四 阶段 2）。
4. E1/E2 启用顺序 → **先 E2**（骨干合成，对应 DESIGN §二 S4 迁移的生成机制），E1 在 E2 稳定后启用。
