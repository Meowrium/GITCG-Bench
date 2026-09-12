# 两层决策树（General + Single）portfolio：正式设计

> 日期：2026-09-02。状态：**设计定稿**（Phase 5，G10）。
> 决策基线：`TEMP-two-layer-general-single-gap-analysis.md`（下称 **TEMP 文档**）§0 的 D1-D6
> 已按"建议倾向"列拍板，§5 为实现契约；本文档将其落为正式设计，并补
> §3 架构一页、§4 与 2026-08-30 三种对局角色的口径衔接、§5 已知限制。
> 设施实现状态：Phase 1（执行闭环）/ 2（可观测）/ 3（反思）/ 4（消融+起草）已完成，
> 本文档对应 Phase 5（编排 + 存储固化）。

## 1. 目标回顾

多卡组交叉对战中：

- **General** = 一套应对所有对手的公共决策树（声明 `unknown_deck`，D3）；
- **Single** = 每个对手卡组一棵专属树（声明 `known_deck`，绑定该卡组），仅面向该卡组；
- 执行时按对手路由：命中 single → 组合链（Single 前置 + General），未命中 → General only。

与 2026-08-30 无 oracle 自进化臂（roundS1-S8）的差别：roundS 每代只有一棵树在多对手上
收证据修订；两层 portfolio 把"证据按对手分组"（已有）推进到"按对手产出/维护不同树"。

## 2. D1-D6 决策定稿（引用 TEMP 文档 §5）

| # | 决策 | 定稿 |
|---|---|---|
| D1 | 组合语义 | **A：Single 链整体前置、未命中下探 General**。排序键 =（层序 single < general，层内 priority，同 priority 保原顺序）；执行器循环语义不变（when 全真但 then 零命中 → 记 thenMiss 续走下一条；整链未命中才走 fallback）。**opening 三节不进组合链**——由独立决策点执行，归属同 D2，trace 键形如 `single:<label>:opening:0` |
| D2 | fallback/predictions/opening 归属 | 路由命中 Single → 用 Single 的；否则用 General 的 |
| D3 | General 对手假设 | `plan:author --opponent-set <file>` 注入对手集合牌表详情 + 稳健性写作纪律；计划仍声明 `unknown_deck` |
| D4 | ruleRef 层维度 | matchedRule 增可选 `layer?: "general"\|"single"` 与 `layerLabel?: string`；键拼层前缀（`general:global:5` / `single:<label>:phase:burst:20`）；全部拼键/解析收敛到 `rule-key.ts` 单一 helper（双向兼容旧格式） |
| D5 | 谱系与 manifest | `PlanPortfolioV1` manifest（generalPlan + singles[{opponentDeckCode,label,planRef}] + lineage 可选）；`portfolioId` = 解析后内容 sha256 前 12 位；planId 仍按单树内容寻址 |
| D6 | 反思信号路由 | k=2：证据键出现在 ≥2 个对手组 → 建议修 General；仅 1 组 → 建议修 Single(<label>)；提示词纪律 + 注入标注，不做硬规则 |

校验契约（G8，`loadPortfolioWithValidation`）：①single 计划 `known_deck` 且 deckCode 与
manifest 绑定一致；②general 声明 `unknown_deck`；③层内 priority 唯一（跨层不查——D1 层主序
后无冲突语义）；④label 非空且不含 `:`；⑤planRef 相对 manifest 目录解析，缺失即报错。
lint：general 层规则引用 `opp.hand.*` 对手牌表字段 → warning 不阻断。

## 3. 架构一页

```
                          ┌─────────────────────────────────────────────────────┐
                          │                orchestrator（G9）                    │
                          │  scripts/ops/portfolio-generation.ts（薄编排层）      │
                          │  循环：author(r0) → batch(证据) → reflect → batch(度量) │
                          │  → [ablate]；仅调 CLI，不重实现逻辑                    │
                          └──────────┬──────────────┬───────────────┬───────────┘
                                     ▼              ▼               ▼
                     plan:author ──▶ portfolio.json ◀── plan:reflect（workingPortfolio 闭包）
                          （--opponent-set   │            --portfolio + --round r）
                          起草 General；    │            └─▶ plans/general.r<N>.json
                          singles 逐对手）  ▼                plans/single.<label>.r<N>.json
                          plan:batch ◀── portfolio.json  + 更新 portfolio.json + reflect.* sidecar
                     （config.portfolio 键；run 级路由）
                                     ▼
                          trace（层化 matchedRule + routing/portfolioId meta）
                          summary.perRuleHits/perRuleThenMiss（层前缀键）
                          portfolio.side0.json（manifest + portfolioId + routing 归档）
```

### 3.1 三新件（plan-oneshot 模块内）

| 模块 | 职责 |
|---|---|
| `rule-key.ts` | `formatRuleKey` / `parseRuleKey` / `collectRuleKeys`：ruleRef 层前缀的唯一构造/解析点（D4），旧格式双向兼容，无层时输出与旧格式逐字节一致 |
| `portfolio.ts` | `PlanPortfolioV1` manifest schema、`loadPortfolioWithValidation`（G8）、`computePortfolioId`（D5）、`routeSingle`（run 级路由） |
| `rule-chain.ts` | `combinedChain`：D1=A 层主序组合链的唯一构造点（Single 前置 + General，层内 priority 稳定排序）；执行期与静态回放共用，语义逐字节一致 |

### 3.2 层化 trace 与路由

- `PlanTraceEntry.matchedRule` 增可选 `layer`/`layerLabel`（对旧 trace 纯增量，消费侧按可选处理）；
- 路由粒度：**run 级解析一次**（batch-runner `routeSingle(portfolio, opponentDeckCode)`；
  对手命中 singles → 组合链，否则 General-only）；
- trace 文件级 meta 记 `routing: "single:<label>" | "general-only"` 与 `portfolioId`；
- run 目录根归档 `portfolio.side0.json`（manifest 字段 + 解析后 planId 清单 + 本 run routing），
  `plan.side0.json` 继续写 General 计划（旧工具链可读）。

### 3.3 workingPortfolio 反思闭环（G5）

- `plan:reflect --portfolio <manifest> --round <r> --evidence engine-only --run-dir <证据组> --out <portfolioDir>`：
  - 装载 manifest + 逐组 `portfolio.side0.json` 断言（组间 + 组↔manifest 的 portfolioId 一致，防拿旧代 run 修订新 portfolio）；
  - 工作闭包 `workingPlan` → `workingPortfolio`（general + singles 分层树）；
  - D6 层路由标注：`buildLayerRoutingAdvice`（k=2，纯函数）注入 stats 文本；
  - patch 层协议：`PlanPatchOp.ruleRef` 支持层前缀（`general:…` / `single:<label>:…`），
    `applyPlanPatch` 对 portfolio 定位层合并，verdicts 带层；每次合并回注静态回放核验
    （分层 × 分组矩阵 + 逐 op 断言）；
  - finalGate 零修订判断改比 `computePortfolioId`；
  - 产物：`plans/general.r<N>.json` + `plans/single.<label>.r<N>.json` + 更新 `portfolio.json`
    + sidecar（`reflect.reflection.json` / `reflect.prompt.txt` 落 portfolioDir 根部）。

### 3.4 portfolio 消融矩阵（G7）

- `plan:ablate --portfolio-base <manifest> --portfolio-revised <manifest|目录> --reflection <reflect输出>/reflect.reflection.json --evidence-runs <组目录…> --evidence engine-only --out <dir>`；
- 臂 = 对 portfolio 应用层化 revise/remove/add：**general 臂**全组批跑（影响所有对手）、
  **single(<label>) 臂**仅路由命中组批跑；臂构造与组选择纯函数在 `cli/ablate-portfolio.ts`；
- 判据：引擎侧（thenMiss 归零 / coverage/fallback 闸 / 胜率区间 N≥20），report 带组维度；
- 证据组必须含 `plan.side1.json`（即批跑 opponent 必须 plan 型）。

### 3.5 orchestrator（G9，Phase 5）

`scripts/ops/portfolio-generation.ts <config.json> [--dry-run]`：

- config 形状（定型）：`deck / portfolioDir / runRoot / rounds / games / seedBase / evidence[] /
  metric / heldout[] / skipAuthor / skipAblate / authorExtraArgs`（+ 可选 concurrency /
  gameVersion / continueOnError / ablateExtraArgs）；
- 每代循环（round r = 1..rounds，依赖顺序：证据 → 反思 → 度量/heldout）：
  1. r0 起草（skipAuthor=false 时）：evidence 各对手 single（wrapper `author-portfolio-singles.ts`）
     + opponent-set → General；生成 `portfolio.json`；
  2. 证据批跑：逐对手 `plan:batch`（portfolio 键 + plan 型对手），outDir `r<r-1>-evidence-vs-<label>`；
  3. 反思：`plan:reflect --portfolio --round <r> --evidence engine-only --run-dir <证据组> --out <portfolioDir>`；
  4. 度量/held-out 批跑（**不进**反思 --run-dir）：`metric-r<r>` / `heldout-r<r>-<label>`；
  5. （可选）消融：`plan:ablate` portfolio 模式（base = 反思前 manifest 快照）；
- seed 约定：evidence `seedBase + (r-1)*1000 + i*10`；metric `seedBase + 5000`（每代相同）；
  heldout `seedBase + 6000 + i*10`（每代相同）——度量/held-out 跨代固定 seed 梯，跨代可比；
- `--dry-run` 只打印命令序列不执行；fail-fast（可配置 continueOnError）。

## 4. 与 2026-08-30 §3 三种对局角色的衔接（G10 定稿口径）

roundS1-S8 已验证的三类对局角色（`2026-08-30-oracle-free-selfevolution-arm.md` §3）在两层
portfolio 下的口径：

| 角色 | roundS 口径（单树） | 两层 portfolio 定稿口径 |
|---|---|---|
| **证据对局**（进反思） | 2-3 个卡组对手合并进反思输入，按对手分组统计防稀释 | 同左；每对手一组 `r<N-1>-evidence-vs-<label>`；路由到该对手 single → 组合链（或未覆盖时 General-only）；组↔manifest 的 portfolioId 断言防跨代 |
| **度量对局**（环路外，代际主指标） | 固定 ctrl 对手 + 同 seed 梯 | **General 度量对局 = 固定对手 + 同 seed 梯**（跨代可比，`metric-r<N>` 每代同 seedBase）；**Single 度量对局 = 其绑定对手**——度量对手若被 singles 覆盖，批跑自然路由到组合链，等价于"该 Single + General"的度量 |
| **held-out 泛化批次**（环路外） | 未参与证据的对手各 10 局，跟踪泛化 | 同左；held-out 对手**不在 singles 覆盖集合内** → 批跑路由自然落到 **general-only**——同时检验 ①General 对未见对手的泛化能力，②无 Single 覆盖时 General-only 的表现（**路由退化的直接度量**） |

要点：

- 度量/held-out 批跑沿用同样的 `plan:batch`（portfolio 键 + plan 型对手）——路由由对手牌表
  自然决定，无需额外配置；held-out 的"general-only"形态正是 D1 路由语义的可观测面；
- 证据、度量、held-out 三者的 seed 分配独立（见 §3.5），互不干扰；
- 度量/held-out 产物不进入 reflect 的 `--run-dir`（环路外指标，防泄漏）。

## 5. 已知限制（定稿时承认）

1. **portfolio 消融仅 engine-only**：`plan:ablate` portfolio 模式先只支持 `--evidence engine-only`
   （oracle 判据的规则级归因对组合链无对应基线 eval 产物）；oracle 口径的 portfolio 消融留待
   oracle 模式组合链归因定义后补。
2. **one-shot（`--turns 1`）portfolio 反思只改 general 层**：portfolio 模式下 revisedPlan 单树
   表达不了分层，full-draft 只更新 general；singles 的修订必须走 patch 协议（`--patch`，
   ops 带层前缀）或 harness 多轮（`--turns N>1`）。MVP 默认 one-shot → singles 逐代冻结，
   general 逐代修订；开启 `--patch` 才获得分层修订能力。
3. **oracle 模式组合链规则级归因待定义**：eval 侧 `ruleKeyOf` 已同步层键（summary.perRule 带
   层前缀），但"组合链下 oracle blunder 归因到具体层/规则"的完整语义（含 single 与 general
   的 blame 切分）尚未定义——engine-only 路径（thenMiss/coverage/胜率）不受影响。
4. **General 层 lint 仅 warning**：general 规则引用 `opp.hand.*` 对手牌表字段只收 warning
   （G8 不硬拒）——若实际运行中被单对手牌表求值，泛化语义存疑需人工判断。
5. **held-out 对手需人工维护在 singles 覆盖之外**：路由靠 deckCode 精确匹配，held-out 若误用
   已覆盖对手则退化为组合链度量（不再是一般化检验）；orchestrator 不自动拦截，靠 config 纪律。
6. **orchestrator 不重放/不校验中间产物**：只编排 CLI 调用；反思产物合法性由 plan:reflect
   内部校验，组合校验由批跑的 `loadPortfolioWithValidation` 承担（fail-fast）。

## 6. 实施状态对照（Phase 1-5）

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | D1-D6 拍板 | ✅ TEMP 文档 §0/§5 |
| 1 | G1 manifest+层字段、G3 路由+组合链、G4 ruleKey 收敛、G8 校验 | ✅ `portfolio.ts` / `rule-chain.ts` / `rule-key.ts` / `batch-runner.ts` |
| 2 | eval 侧 ruleKeyOf 同步 + summary 层统计 | ✅ |
| 3 | G5 workingPortfolio 反思 + D6 标注 + patch 层协议、G6 分层回放 | ✅ `reflect-portfolio.ts` / `plan-replay.ts` |
| 4 | G7 portfolio 消融臂、G2 General 起草（--opponent-set + wrapper） | ✅ `ablate-portfolio.ts` / `author-opponent-set.ts` / `author-portfolio-singles.ts` |
| 5 | G9 orchestrator + 存储约定固化、G10 本文档 | ✅ `portfolio-generation.ts` + `examples/plans/roundP1-portfolio/` |
