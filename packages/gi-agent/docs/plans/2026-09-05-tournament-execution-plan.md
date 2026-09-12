# 四模型小型锦标赛 × organizer × 锚点实验：执行方案

> 日期：2026-09-05。状态：**执行方案**（依据当日用户拍板拟定，含基建 → 冒烟 → 小型正赛 → 锚点实验 → organizer 试点）。
> 决策输入：2026-09-03 三案四文档（锦标赛 / organizer / 选择回路 / 整合稿）+ 2026-09-05 用户反馈（§1 逐条登记）。
> 冲突处置：与锦标赛定稿冲突处以**本文为准**（R4 每格局数、R9 证据源、r0 锚点默认、卡组池/M/R 取值）；
> A 案暂不定稿、不做候选 → 整合稿 Phase 2 全部挂起（整合稿 §4 注记），本方案不含 P2 件。

## 1. 2026-09-05 拍板登记

| # | 用户反馈 | 落点 |
|---|---|---|
| 1 | 卡组池 = 5 场历届大赛（影幻杯、枫达杯）各 8 套热门卡组，**对局时 5 场分开、各自固定版本环境**；之后可能缩减 | §3 赛事结构（环境×卡组），数据源 `summoners-decks/` |
| 2 | 先跑 **4 模型小型锦标赛**测试管线；模型清单未定、文档中模型可能改动 | §6 阶段 1 冒烟 + 阶段 2 正赛；§9 开放项 1 |
| 3 | 每格 **15 局**（正反手视作不同格） | §4 R4 修订：每 (di,dj) 30 局 = 正反手各 15 |
| 4 | 此前约 **9 代饱和**；论文迭代轮次以 4 模型小型赛结果为准 | §6 阶段 2：跑到饱和（先验 ~9，上限 12），R = 实测停点 |
| 5 | r0 锚点：**赛程锚点矩阵拍板不做**（决策树进步快，对 r0 对局信息量随代快速衰减）；锚点实验 = round19 式**起草侧策略锚点复验**（`--anchor` 两阶段起草） | §6 阶段 3（复用现成 `--anchor`，零新逻辑） |
| 6 | R9 证据 = **自身历代决策树的对战记录，own-generations 口径（含跨模型局）** | §4 R9 已拍板；论文须声明部分 in-sample |
| 7 | **不做候选**；A 案暂不定稿 | §2 范围；整合稿 Phase 2 挂起 |
| 8 | organizer 与受试模型重叠不影响运行；**暂拟 deepseek-v4-flash-vision-exp** | §6 阶段 4 |

## 2. 范围与非目标

**做**：锦标赛管线全套（author / evolve / battle / export / analyze / plot）、B 案 organizer
Phase 0+1（写入端 + 证据导出 + 三任务 + 单 run 试点）、P3-1 跨代聚合（机械层）、
锚点实验（round19 式 `--anchor` 起草复验，见 §6 阶段 3）。

**不做（本次范围明确排除）**：候选池与选择器（A 案 P2-1/P2-3 全部）、verdict-only 消融臂
（P4-1）、A 案判据升级（P2-2——strata 两级设计保留在文档，实施随 A 案定稿后再排）、
NN 任何启用。P0-5 分区字段照常落地（未来 A 案消费方），但其 holdout 语义在本次无消费方。

## 3. 赛事结构：环境 × 卡组 × 模型

```
锦标赛 = E 个独立子锦标赛（环境），互不配对
  环境 e ∈ {5 个版本环境}，各自钉扎 gameVersion
  每环境 D_e = 8 套热门卡组（usageRate 降序 top-8）
  模型 M = 4（provisional，见 §9-1）
  对局只在同环境内配对：(di, dj) ∈ e × e；跨环境组合不进赛程
  选手 = model@r（跨环境共用身份；同一棵树只在声明环境内可坐）
```

- **数据源**：`packages/benchmark/tree-bench/summoners-decks/{v}.json`
  （召唤之巅赛事数据站爬取，字段 usageRate/winRate/numGames/characters，README 见该目录）。
  卡组选取口径：每环境 `usageRate` 降序前 8，并列取 `numGames` 高者。
  可用版本 5 档：4.0 / 4.8 / 5.3 / 5.8 / 6.3
- **版本钉扎（全链路现成，2026-09-02 已实现）**：author 侧 `--game-version <v>`
  （core `VERSIONS` 封闭校验 + versioned AssetsManager 卡面文本）；battle 侧
  `config.gameVersion`（解析序 config ?? plan 声明 ?? CURRENT_VERSION，错配 fail-fast，
  `batch-runner.ts:127-150`）；reflect 侧 plan/portfolio 声明版本核对。
  **纪律：树的 `context.gameVersion` 必须与环境一致**——错配即 fail-fast，不放行 `--force`。
- **卡组缩减**：deckPool 为 config 数组，缩减 = 改数组重跑（D_e 参数化，8 → 4/2）。

## 4. 参数定稿与对 09-03 锦标赛稿的修订

| 项 | 09-03 定稿 | **2026-09-05 修订** |
|---|---|---|
| R4 每格局数 | 20 局 = 正反手各 10 | **每格 15 局，格 = (di,dj,先手方)**；每 (di,dj) 一批 30 局（`alternateFirstPlayer: true` 自动正反手各 15）。per-cell SE ≈ ±13pp |
| 卡组池 | 3 副（gold-match） | **5 环境 × 8 套（summoners-decks top-8）**，环境内配对、版本各自钉扎 |
| R5/R6 跨代 | 每代独立新选手，同模型链 | 不变；链批 + 跨模型批共同构成 R9 证据（own-generations，见下） |
| R9 证据源 | evolve 自开 harvest 批（对 deck 池对手，**不消费**锦标赛对局） | **已拍板 own-generations**：证据 = 该模型当代树参与的上一轮全部对局（链批 X@(r-1) vs X@(r-2) + 跨模型批 X@(r-1) vs Y@(r-1)，双向侧均含）——反思有真实对抗性失败样本、学得更针对。方法论代价：模型经 reflect"研究过"对手，后续跨模型对局不再独立，**榜为共同演化记录，论文须声明部分 in-sample，不得主张静态 out-of-sample 对比** |
| r0 锚点（赛程） | 可选矩阵（每代加打 X@r vs X@0） | **已拍板不做**：树进步快，对 r0 对局信息量随代快速衰减（用户实证）；绝对改善读数不采，轨迹只作链式相对比较 |
| M | 3-5（API.txt） | **provisional 4**：deepseek-v4-pro-0813 / deepseek-v4-flash-vision-exp（api.deepseek.com）/ glm-5.3 / glm-5.3-flash（open.bigmodel.cn）——API.txt 现有凭据的 4 个；qwen-3.8-*、hy3、hy4 无凭据，入选需补（§9-1） |
| R | 3-5 | **跑到饱和**：先验 ~9 代（此前实测），上限 12 代；**论文 R = 小型赛实测停点** |
| G（跨代对加局） | 40 | 取消特殊加局——证据即链批，统一每 (di,dj) 30 局 |

## 5. tournament.json 契约（新，`packages/gi-agent/scripts/ops/`）

```jsonc
{
  "models": [                              // M 个；apiKeyEnv 名义引用，值在环境注入（不入库）
    { "name": "deepseek-v4-pro-0813", "baseUrl": "https://api.deepseek.com", "model": "deepseek-v4-pro-0813", "apiKeyEnv": "DEEPSEEK_API_KEY" }
    // … glm 同型，各自 apiKeyEnv
  ],
  "environments": [                        // E 个，互不配对
    { "label": "v6.3", "gameVersion": "v6.3.0",
      "decks": [ "<deckCode>×8" ] }        // summoners-decks top-8，缩减即删条目
  ],
  "gamesPerCell": 15,                      // 格=(di,dj,先手方)；实现为每批 games=30 + alternateFirstPlayer
  "rounds": 12,                            // 上限；饱和即提前停
  "evidenceScope": "own-generations",     // R9 证据口径（已拍板，§4；仅此口径需实现）
  "seedBase": 20260905,
  "outRoot": "<out>/tournament/",
  "gameArchive": { "ownChain": "keep", "crossModel": "keep-trace", "stateLog": "sample:0.1" }
  // 跨模型局是 R9 证据（trace/summary 恒留）；state log 抽 10%——reflect 不读 state log，
  // organizer 试点用链批局全量（ownChain=keep）；赛程锚点矩阵已拍板不做，无 anchor 字段
}
```

**编排脚本 `model-tournament.ts` 子命令**（沿用 09-03 §8.1，修订两点）：
`author`（r0：M×E×D² 逐格起草，`--game-version` = 环境版本，逐模型 env 注入，失败隔离）；
`evolve`（r ≥ 1：对每 model × (环境 × 本方卡组) 的 portfolio——共 M×ΣD_e 个——
取**链批证据**调 `plan:reflect --portfolio --patch`；证据目录适配见 §6-0-E）；
`battle`（选手对 × 环境内格矩阵，幂等续跑，seed 按 (pair,di,dj,round,side) 确定性派生；
`config.gameVersion` = 环境版本）；
`export`（summary→results 双视角 + mirror-only + period=round + **winner 映射**
`0|1|null` → `"p1"|"p2"|"draw"`，否则 `results.ts` 归一化 fail-fast）；
`analyze`（tree-bench analyze + matplotlib）；`status`（断点续跑查询）。

## 6. 执行阶段

### 阶段 0 — 基建（一次做完，供后续所有阶段共用）

| # | 件 | 说明 | 来源 |
|---|---|---|---|
| 0-A | P0 写入端 | mutation 流接线（`game_state_log.e` 真实落盘；终局快照已确认随 onPause 落盘，无需做）；reroll 骰面 / 落选 preview（可选后置）；replay-report 落盘；HarnessStats 扩展 | 整合稿 P0-1/2/3/4 |
| 0-B | `model-tournament.ts` + tournament.json 解析 | §5 契约；config 进 `.gitignore`（含 key 值仅 env 引用）；API.txt 中模型表迁入后按 09-03 §9.6 作废 | 09-03 §8.1 |
| 0-C | ratings-history 导出 | tree-bench analyze 逐 period µ/φ/σ 落盘 | 09-03 §8.1 |
| 0-D | matplotlib 五图 | `tree-bench/plots/plot_*.py` + requirements.txt（uv + matplotlib ≥3.8） | 09-03 §7 |
| 0-E | **evolve 证据目录适配器（own-generations）** | 收集 X@(r-1) 上一轮全部对局——链批 + 跨模型批（X 为 plan 侧与 opponent 侧双向）——组装为 reflect `--run-dir` 可读证据组（每组 = 某本方卡组 di 的 8 个格；`plan.side0.json` = X 当代 portfolio 快照、根 `portfolio.side0.json` 断言文件；X 为 opponent 侧的局读 `plan_trace.side1.json` / `summary.side1.json` 转换为 side0 口径或以覆盖声明说明；软链优先、拷贝兜底） | 本文新增（R9 配套） |
| 0-F | P3-1 跨代聚合脚本（机械层） | 读各代 summary.json + harness.json 出五指标 + 行为计数 trend | 整合稿 P3-1 |

### 阶段 1 — 冒烟测试（管线验证，当天可完成）

**配置**：M=4（provisional 模型）× E=1（暂用 6.3）× D=2（该环境 top-2 卡组）× r0+r1 两代
× 每格 15 局（每 (di,dj) 30 局）。

**规模**：author single 4×1×4=16 棵 + general 4×1×2=8 棵（portfolio manifest 需要
general 层）；portfolio 4×1×2=8 个；r0 批 6 对×4 格对×30=720 局 + 链批
4×120=480 局；r1 重复（evolve 8 次 reflect）。总 ~2400 局，分钟级。

**验收清单**（全部通过才进阶段 2）：

1. author：逐模型 env 注入生效（不同模型出不同树）；失败隔离（造 1 个坏 key 模型验证不拖垮全批）；
   树的 `context.gameVersion` = 环境版本；
2. 版本钉扎断言演练：故意给一个批配 `gameVersion=v5.8.0` 跑 6.3 树 → 必须 fail-fast 中断；
3. battle：幂等续跑（中断后重跑只补缺局）；正反手各 15 局核对 perGame `planSide` 分布；
4. evolve：own-generations 证据组组装正确（含跨模型局与 opponent 侧视角处理、
   portfolioId 断言通过）；reflect `--patch` 产出 r1 树且 singles 层被修订（非仅 general）；
5. export：双视角 + mirror-only + winner 映射（造平局样本核对 `draw` 计 0.5）；period=r0/r1；
6. analyze + plot：ratings.json / ratings-history.json / heatmap.json / spin-top.json +
   五张 PNG 产出；无对局格呈现灰底非 0.5；
7. 吞吐定标：记录 局/秒 → 校准阶段 2 总时长（§7 表按实测回填）；
8. 存储定标：单局目录体积（含/不含 state log）→ 校准归档率。

### 阶段 2 — 四模型小型锦标赛（正赛，产出论文 R 与全部主图表）

**配置**：M=4 × E=5（4.0/4.8/5.3/5.8/6.3 全档）× D_e=8 × 每格 15 局 × 上限 12 代。

**每代循环**（r ≥ 1，依赖顺序）：

```
evolve（读上一代 X 的全部对局：链批 + 跨模型，own-generations）→ battle（同代跨模型
全矩阵 + 链批 X@r vs X@(r-1)）→ export（period=r，累积）→ analyze → plot → 饱和判定
```

r0 无 evolve（author 起草后直接 battle）。**饱和判定**：by-model 聚合同模型链胜率
（X@r vs X@(r-1) 全环境汇总）+ trajectory 置信带——连续 3 代区间含 0（无正增益）即停；
硬顶 12 代。**论文 R = 实测停点**（先验 ~9）。

**产物**：trajectory / improvement / heatmap-full / heatmap-deck-latest / spintop-summary
五图 + ratings-history.json + P3-1 跨代 trend + 镜像批纯树力读数（09-03 §4.1）。

### 阶段 3 — 锚点实验（round19 式起草侧策略锚点复验；独立小实验，与阶段 2 可并行）

**概念消歧（2026-09-05 复核）**："锚点"在仓库内有两个无关用法——①起草侧策略锚点
（round19：LLM 先做 archetype / killMath / comboLines / riskTriggers / 优先级骨架分析，
再据此起草，`--anchor` 两阶段开关，**已有负面结论**：三模型 coverage 一致更低、
臂对臂 27:43:10 ctrl 占优，ISMCTS 与 NN 双口径复核成立，见 08-21 文档 §438-466）；
②r0 赛程锚点矩阵（09-03 原设计：每代加打 X@r vs X@0 取绝对改善读数）。
**拍板（2026-09-05）**：②不做（决策树进步快，对 r0 对局信息量随代快速衰减）；
锚点实验只做 ①的复验。

**复验设计**（`--anchor` 与形状闸均为现成代码，零新逻辑）：

- **配置**：2-3 模型 × 1-2 环境 × 2 卡组 × 双臂（ctrl 直起草 vs `--anchor` 两阶段），
  同 seed 同对手批跑口径（round19 同型：内战 + 臂对臂交叉），`--game-version` 按环境；
- **读数**（round19 同口径）：coverage / fallback 聚类 / 臂对臂直接对战战绩
  （anchor 累计胜负平）；可加 avgRounds 与规则密度作次级诊断；
- **判定**：复现负面（round19 结论泛化到当前模型代）→ 主赛 author 一律 ctrl 直起草；
  出现稳定收益（多模型一致正且臂对臂占优）→ 主赛 author 默认开 `--anchor`
  （只改 author 子命令默认参数，管线不变）。

### 阶段 4 — organizer（B 案 Phase 0+1，organizer = deepseek-v4-flash-vision-exp）

1. P0 写入端落地（阶段 0-A）后，随阶段 2 各代批跑自然采集（新 run 起即含 `game_state_log.e`）；
2. P1-1 证据导出器 `plan:organize-export`（放宽口径 + 整条 stateSignature + 抽牌序列差分
   + perGame 离群标注 + side1 包；链批局全量 state log——正是 `gameArchive.ownChain=keep`）；
3. P1-2 编排脚本（CallLlm 注入式双 env，先例 `battle-benchmark/src/evolve/`；
   organizer 用 deepseek 凭据即 provisional 模型之一——与受试模型重叠经确认不影响运行）；
4. P1-3 试点：阶段 2 产出的单模型单 run 跑三任务，人工校准 prompt 与报告粒度
   （放宽口径数值在此定标：digest 行上限 / modules 4000 字符截断放宽值）。

### 交叉依赖

- 阶段 3（--anchor 复验）不依赖阶段 2，可并行；阶段 4 依赖阶段 0-A + 阶段 2 的 run 产物；
  P3-1 聚合随阶段 2 数据自然产出。锚点复验结论回写 author 子命令默认参数
  （是否默认 `--anchor`）；R9 口径已拍板 own-generations（§4）。
- 卡组缩减（用户预告"之后可能缩减"）：只改 `environments[].decks` 重跑，
  不影响基建与锚点实验结论（同管线）。

## 7. 成本与存储（按 09-03 §4.2 公式换算；吞吐/体积以阶段 1 实测回填）

| 项 | 规模（E=5, D_e=8, M=4, 每格 15 局） | 频次 |
|---|---|---|
| 同代跨模型批 | C(4,2)=6 对 × 5×64 格对 × 30 = **57,600 局/代** | 每代 |
| 同模型链批（R9 证据组成之一） | 4 × 5×64 × 30 = **38,400 局/代** | 每代 |
| 每代合计 | **96,000 局**（引擎零 LLM）；~9 代 ≈ **86 万局** | — |
| author（LLM） | r0 一次性：single 逐格 M×E×D² = **1280 次** + general 逐 portfolio M×ΣD_e = **160 次**（`--opponent-set`），合计 **1440 次**（harness 模式内部有界多轮） | 仅 r0 |
| reflect（LLM） | 每代 M×ΣD_e = **160 次**（portfolio 数） | 每代 |
| organizer（LLM） | 三任务 ×3 次调用/run，试点期少量 | 试点 |
| 存储 | 链批局 + 跨模型局 game-\* 目录均保留（R9 证据需要 trace/summary）；state log 抽 10%（reflect 不读 state log；organizer 试点用链批局全量） | 分级归档 |
| 选手池 | 每代 +4；~9 代 36-40 名 → 热图/spin-top 走子锦标赛过滤（09-03 §7.3） | — |

engine 推演为分钟级/千局量级（09-03 已验证口径）；86 万局的真实墙钟时间与磁盘占用
**以阶段 1 定标数据为准**，若超预算先缩减 D_e（8→4）再跑。

> **冒烟定标回填（2026-09-05/06，Mock-LLM 全管线冒烟 3360 局真实引擎对局，详见
> [../smoke/ACCEPTANCE.md](../smoke/ACCEPTANCE.md)）**：
> - 吞吐 ≈ **0.63 局/秒**（30 局批 47.4 s，并发 4）→ 每代 96,000 局 ≈ **42 h** 纯引擎墙钟（9 代 ≈ 16 天连续跑；提并发或缩 D_e 可压缩）；
> - 存储 单局目录 ≈ 0.87 MB（不含 state log）/ 1.15 MB（含，state log ≈187 KB/局）→ state log 抽 10% 下每代 ≈ **86 GB** 量级（推算，9 代 ≈ 0.8 TB）；
> - 已知偏差：state log 抽样实现为批粒度全有/全无（本跑 17.3%，聚合仍≈10%；ACCEPTANCE.md §4 O-1）；
> - `rounds` 字段语义为 r0..rN 闭区间（config `rounds:1` = r0+r1 两代）。

## 8. 读数纪律（沿用 09-03 §9，增量两条）

1. per-cell 15 局只作诊断；排名以 by-model 聚合 + bootstrap 区间为准；
2. R9 = own-generations（已拍板）：跨模型榜为共同演化记录，**论文须声明部分 in-sample，
   不得主张静态 out-of-sample 对比**；
3. 饱和停止后不再加代（roundS 系列冻结停止门纪律）；
4. 锚点结论未出前，正赛 trajectory 不作绝对改善解读（只有相对链式读数）。

## 9. 风险与开放项

| # | 项 | 处置 |
|---|---|---|
| 1 | **模型清单未定**（"文档中涉及的模型可能有改动"） | provisional 4 模型为 API.txt 现有凭据者；qwen-3.8-* / hy3 / hy4-preview 入选需补凭据（baseUrl + key）；换模型 = 改 tournament.json `models[]`，管线不变 |
| 2 | **环境集合与"影幻杯/枫达杯"映射待确认** | 5 档全用（4.0/4.8/5.3/5.8/6.3）；用户确认 5 届大赛与版本的对应后定稿 |
| 3 | API key 明文 | tournament.json 只存 `apiKeyEnv` 名义引用，值走 env；API.txt 按 09-03 §9.6 作废移出 |
| 4 | 吞吐/存储超预算 | 阶段 1 定标 → 缩 D_e 或调 gameArchive 抽样率 |
| 5 | 卡组池缩减 | config 化，随时重跑；历史 results.json 不跨池合并（分数池内相对值） |
| 6 | 9 代先验失准 | 上限 12 + 饱和判定自动停；R 记实测 |
| 7 | organizer 与受试模型重叠 | 已确认不影响运行；报告中的自评偏差由人工终审把关（B 案本就人终审） |
| 8 | 跨模型榜 in-sample（own-generations 已拍板） | 论文表述纪律见 §8-2；若将来要静态对比主张，需改 own-chain 口径重跑（字段保留，代码仅实现已拍板口径） |
