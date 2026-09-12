# gi-agent/scripts

一次性辅助脚本索引。生产 CLI 入口请使用 `package.json` 的 `pnpm run <script>`，本目录仅放：

- 代码/数据生成器
- 一次性数据分析
- self-play 配置生成
- 运维/部署脚本（在 `ops/`）

## 代码与数据生成（Generators）

| 脚本 | 用途 |
|------|------|
| `generate-card-hints.ts` | 由 `@gi-tcg/data` 卡牌定义生成 `src/runtime/policy/card-effect-hints.generated.ts` |
| `generate-skill-damage-table.ts` | 生成技能伤害表 |
| `generate_gameplan.ts` | 由 deck code 生成 gameplan JSON（被 `ops/regenerate_plans.py` 与 `ops/gen_all_plans.sh` 调用） |
| `validate_gameplan.ts` | 校验 gameplan JSON |
| `extract_deck_profile.ts` | 由 deck code 抽取 profile |
| `decode-decks3.ts` | 解码 deck code 调试工具 |

## 一次性分析（Analysis）

| 脚本 | 用途 |
|------|------|
| `analyze_mcts_rho.py` | MCTS 收敛 ρ 分析 |
| `cgt_reversibility.py` | 组合博弈论可逆性分析 |
| `count-behaviors.py` | 行为计数器（B1/B4/B7） |
| `parse_replay.py` | replay 解析 |
| `per-deck-diagnostics.py` | 单卡组诊断 |
| `merge-v7-shards.py` | v7 数据 shard 合并 |
| `v8-analysis.py` | v8 数据分析 |
| `salvage-reflect-transcript.ts` | harness 反思"轮次耗尽无合法 draft"时从 transcript 打捞修订计划：修复尾部 brace 失衡 → 按 finalizeMerged 同管线收尾（谱系接管/auto-repair/planId）→ 校验落盘（用法见文件头） |

## Self-play 配置生成

| 脚本 | 用途 |
|------|------|
| `gen_diverse_selfplay.py` | 多卡组 self-play 矩阵生成（被仓库根 `scripts/local-train.sh` 调用） |
| `gen_selfplay_wrapper.py` | self-play wrapper 配置生成（同上） |
| `mirror_selfplay_config.py` | 镜像 self-play 配置生成 |

## 外部 NN 基线（nn-bridge）

| 脚本 | 用途 |
|------|------|
| `nn-bridge-capture.ts` | 抓取引擎首个 action 决策点的玩家视角 notification + rpc 样本（供 aibridge policy_service 冒烟） |
| `nn-baseline-probe.ts` | NN vs BaselinePolicy 强度探针（v6.3.0，交替执舵侧；`pnpm exec gnx scripts/nn-baseline-probe.ts [games] [seedBase]`） |

两者依赖仓库根 `aibridge - 副本/aibridge - 副本/` 的 `.venv` 与 `weights/`（闭源 clean_genius_AI checkpoint，不在仓库内分发；环境变量 `NN_BRIDGE_ROOT`/`NN_POLICY_PYTHON` 可覆盖路径）。

## 决策树轨线/候选评分作图（analysis/nn-valuediff/）

GLM-5.3-Flash 与 qwen3.8-flash 决策树对局轨线的导出与作图工具组（2026-08-30 起）。**运行方式**：仓库根目录 + 绘图专用 venv：

```bash
.tmp/plot-venv/Scripts/python.exe packages/gi-agent/scripts/analysis/nn-valuediff/<script>.py
```

| 脚本 | 用途 |
|------|------|
| `analysis/nn-valuediff/export-trajectories.py` | 扫描各代对局目录的 `plan_eval.nn[.side1].json`，导出逐决策点 `trajectories.csv`（schema：group, game, model, arm, deck, round, actionIdx, seq, winrateBefore, valueDelta, isValueCrash, crossedBoundary；winrate=(value+1)/2） |
| `analysis/nn-valuediff/plot-glm-vs-qwen.py` | 聚合视角 4 图：三组对局×双侧逐局胜率网格、末代 valueDelta 按行动序号、两模型各六代 valueDelta、末代按回合聚合 |
| `analysis/nn-valuediff/plot-per-game-trajectories.py` | 逐局原始轨线（无均值）：三组对局每局双侧 winrate 面板；两模型各 10 局的六代 valueDelta 叠加面板（同种子跨代对比） |
| `analysis/nn-valuediff/plot-candidate-scores.py` | 逐局候选视角 ×6：每局"行动序号→合法操作数"阶梯线；每局"行动序号→NN 全候选评分"散点 + 计划所选动作评分连线（需评估时带 `--dump-candidates`） |
| `analysis/nn-valuediff/plot-trajectories.py` / `plot-valuediff.py` / `plot-by-round-actionidx.py` | round22 基准批次的历史参考脚本副本（面向 1280 局，样本门槛 MIN_N=30 不适用于 10 局场景） |
| `analysis/nn-valuediff/export-trajectories-round26.py` | round26-glmpatch（GLM patch 链 5 轮 + agentic-r0 基线 + 重写式 r1 对照）的 trajectories.csv 导出，同 schema，7 组 |
| `analysis/nn-valuediff/plot-round26-glmpatch.py` | round26 聚合 4 图：各代 plan 侧 valueDelta 按行动序号（r0/重写式对照/p1–p5）、r0/重写式r1/p5 三组对局×双侧逐局胜率网格、迭代动力学（blunder 双侧+比分胜率/规则保留率按轮）、末代 p5 按回合聚合 |
| `analysis/nn-valuediff/plot-candidate-scores-round26.py` | round26 逐局候选视角 ×3 组（agentic-r0 / rewriter1 / glmpatch-p5）：每组合法操作数阶梯线 + NN 全候选评分散点/实际选择彩色连线各 1 张（所选动作已由彩色圆点+连线高亮，无红圈；需对三组先以 `--dump-candidates` 重评估） |
| `analysis/nn-valuediff/export-trajectories-selfevo.py` | roundS1~S8 oracle-free 自进化系列的 trajectories.csv 导出：扫 roundS1-8 全部度量/heldout 目录的 `game-*/plan_eval.nn.json`（仅 side0 计划侧），同 schema 外加两列 `gen`（0-8）与 `opponent`（hongniu/moyou/shenxiao），arm ∈ b/a/static |
| `analysis/nn-valuediff/plot-selfevo-generations.py` | roundS 系轨线 3 图：双血脉（③b/③a）各代 valueDelta 按行动序号（滚动均值 w=5，共享 r0 基线两面板同画）、逐局 winrateBefore 轨线网格（每血脉 9 代×前 6 局）；需先跑 export-trajectories-selfevo.py |
| `analysis/nn-valuediff/plot-selfevo-summary.py` | roundS 系代际汇总 5 图：主梯 NN 环路外指标（blunder/valueDelta，含 r0 静置对照线）、胜率（主梯+held-out 双面板）、held-out blunderRate（双面板）、决策树规模（规则数/条件数）、每代反思 verdict 数（收敛信号）；数值为内联快照（T 系 NN-in-loop 仅 4 代跨批点，已在 9 代轴上去掉，参照说明见各代报告），代际重跑后需同步更新 |

产物输出到 `output/plan-oneshot/glm-vs-qwen/nn-valuediff/`（CSV + PNG 同目录）；round26 的产物在 `output/plan-oneshot/round26-glmpatch/nn-valuediff/`；roundS1~S8 自进化系列的产物在 `output/plan-oneshot/roundS8-selfevo/nn-valuediff/`（roundS3 目录下的同名产物为前 4 代的历史快照）。

**前置数据**：对局目录需有双侧 NN 评估产物 `plan_eval.nn.json` / `plan_eval.nn.side1.json`（`plan:eval` 生成）；候选评分散点图还需以 `--dump-candidates` 重评估（评估器每个决策点恒记录 `candidateCount`，该旗标额外导出 `candidates[]`：全部候选摘要 + NN 评分）。

**合法操作数口径**：`candidateCount` 与散点图**只统计引擎 `validity == VALID` 的可执行操作**——引擎 rpc 请求中的非法候选（`DISABLED` / `NO_TARGET` / `CONDITION_NOT_MET` / `NO_DICE` / `NO_ENERGY`）不计入计数、不画散点（2026-08-30 起评估器按此口径落盘，`candidates[]` 保持引擎全量并用 `validity` 字段标注，旧数据无该字段时绘图脚本按全合法向后兼容）。

**已知口径/坑**：①NN 候选评分是 logprob 尺度，0=最优，实测约 [−17.5, 0]，约 1/3 候选词表外无评分（图中 ▽ 行）；②每个 (模型, 行动序号) 格子的样本量 ≤ 局数（10 局），逐序号聚合门槛不能沿用 round22 的 30；③GLM 各代目录命名 r0 无后缀（`hongniu.agenticfix-vs-g53fctrl`）、qwen 各代一律带 `.rN`——`export-trajectories.py` 已按此适配，新增对局目录时注意；④图内中文依赖 Microsoft YaHei（脚本已设 fallback）。

### 决策树长度计数

代际实验中比较各代决策树规模时，统一用两个计数（来源为各代计划文件本身，脚本内联快照见 `plot-selfevo-summary.py`）：

- **规则数** = global 规则数 + 全部 phase 规则数合计；
- **条件数** = 全部规则的 `when` 子句条数合计（每条 when 数组元素计 1）。

roundS1~S8（oracle-free 自进化，共 9 代）实测规模，配图为 `output/plan-oneshot/roundS8-selfevo/nn-valuediff/gen-tree-size.png`：

| 血脉 | r0 | gen1 | gen2 | gen3 | gen4 | gen5 | gen6 | gen7 | gen8 |
|---|---|---|---|---|---|---|---|---|---|
| ③b 主线：规则 / 条件 | 43 / 138 | 46 / 163 | 49 / 206 | 49 / 206 | 47 / 199 | 47 / 199 | 48 / 204 | 43 / 175 | 41 / 159 |
| ③a 亚臂：规则 / 条件 | 43 / 138 | 45 / 160 | 43 / 151 | 42 / 148 | 41 / 149 | 38 / 132 | 39 / 139 | 40 / 141 | 39 / 135 |
| T 系参照（NN-in-loop，仅 4 代）：规则 / 条件 | 43 / 138 | 39 / 131 | 45 / 162 | 41 / 146 | — | — | — | — | — |

读法：③b（合并证据）前 4 代膨胀（条件数峰值 206）、r7/r8 反转为修剪（48→41 规则、204→159 条件，verdict 以 remove 为主），规模向 ③a 的参数效率区间收敛且 blunder 同创最优——**后期收益来自修剪而非新增**；③a（仅镜像证据）全程收敛在 38~42 规则。九代下来强度（环路外 blunder/胜率）与规模始终无线性关系，膨胀主要体现在条件数（规则变"胖"）而非规则数。

> engine-only 臂自有指标（fallbackRate / coverage / perRuleThenMiss / declareEnds / 零命中）目前**无跨代聚合脚本与作图**，口径与产物 schema 见 [../docs/oracle-free-harness-metrics.md](../docs/oracle-free-harness-metrics.md)（§11 缺口清单）。

## 运维（ops/）

| 脚本 | 用途 |
|------|------|
| `ops/anal.ps1` | LLM 环境变量 + spl:compile 触发器（PowerShell） |
| `ops/train.ps1` | 一键训练入口（PowerShell，调用 `scripts/run-multi-iteration-training.ps1`） |
| `ops/cloud.sh` | 云部署辅助 |
| `ops/gen_all_plans.sh` | 批量调用 `generate_gameplan.ts` |
| `ops/author-portfolio-singles.ts` | 两层 portfolio 的 Single 层批量起草 wrapper（G2：逐对手调 `plan:author --opponent-deck` 串行生成 `plans/single.<label>.r<N>.json`，可再调一次 `--opponent-set` 生成 General；JSON config 传路径，不硬编码） |
| `ops/portfolio-generation.ts` | 两层 portfolio 代际循环 orchestrator（G9，Phase 5）：`pnpm exec gnx scripts/ops/portfolio-generation.ts <config.json> [--dry-run]`——只编排 CLI（author → batch 证据 → reflect → batch 度量/held-out → [ablate]），每代产出 `plans/general.r<N>.json` + `plans/single.<label>.r<N>.json` 并更新 `portfolio.json`；config 形状与 seed 约定见文件头，示例 `examples/plans/roundP1-portfolio/portfolio-generation.example.json` |
| `ops/regenerate_plans.py` | 与 `gen_all_plans.sh` 等价的 Python 版 |
| `ops/render-game-log.ts` | 把 self-play sqlite 渲染为人类可读 Markdown 对局日志（V31 D8b，详见 §F6.D8c） |
| `ops/organize-run.ts` | organizer 三任务编排（WP4 件 2）：`pnpm exec gnx scripts/ops/organize-run.ts --evidence <evidencePack目录> --out <报告目录> [--tasks mentions,practice,misalign] [--model deepseek-v4-flash-vision-exp]`——对 `plan:organize-export` 产出的证据包跑 mentions/practice/misalign 三次 LLM 调用（可并行），凭据走注入式双 env `ORGANIZER_API_KEY/ORGANIZER_BASE_URL/ORGANIZER_MODEL`（不读 OPENAI_*）；每任务失败重试 2 次后隔离；坏条目条目级剔除进 invalidEntries；产出 report.json（过 `ops/organizer-report.schema.json`）+ report.md（引用可点路径）。隔离红线：只写 --out，不写 --evidence |
| `ops/organizer-report.schema.json` | organizer 报告 JSON Schema（WP4 件 3，条目 schema 按 B案 §5：id/dimension/conclusion/citations/mechanicalAnchor/confidence/notes；`x-evidenceFileWhitelist` = 引用文件白名单单一事实来源） |
| `ops/organize-report.ts` | organize-run 的纯函数层（条目校验/白名单通配/report.md 渲染），colocated 单测 `organize-report.test.ts` |
| `ops/model-tournament.ts` / `ops/tournament-config.ts` / `ops/tournament-schedule.ts` / `ops/tournament-scheduler.ts` / `ops/tournament-evidence.ts` / `ops/tournament-archive.ts` / `ops/results-connectivity.ts` | 锦标赛编排（WP1，impl-spec-1，八子命令）：tournament.json 契约（可选 `traceSignatures: "full"\|"lean"`，缺省 lean——battle 批注入 `plan:batch` traceSignatures，单局产物 ~1.87MB→≤0.45MB；lean trace 的局面摘要以同局 `game_state_log.json` 为反查底座，state log 抽样删除的局在 reflect/organizer 中降级"(无 state)"；可选 `schedule: { crossGeneration?: "none"\|"vs-previous", chainGap?: number≥1 }`——缺省 = 现行赛程〔同代跨模型全矩阵 + 同模型相邻代链批〕，`vs-previous` 追加跨模型跨代 X@r vs Y@s（X≠Y，s<r）全格对批，`chainGap=k>1` 追加同模型隔代链 X@r vs X@(r-k)（k=2..k）全格对批；赛程枚举纯逻辑在 `tournament-schedule.ts`，colocated 单测）；`pipeline [--round <N>]`「生成即赛」（2026-09-05 追加，§4.7）：LLM producer（r0=author / r≥1=evolve）与 battle 调度器并发，manifest 组装内联到每 (model, env, di) 的 D+1 个调用全结束即触发，调度器（`tournament-scheduler.ts`，纯逻辑 + 注入式核心，colocated 单测）持续把依赖已就绪的批跑掉、producer 结束后 drain 并对仍 not-ready 的批记「依赖未就绪」失败（不写 done 位图，重跑补缺不受阻）；r≥1 前置校验上一代 battle 全 done；LLM 逐模型分桶（`models[].concurrency` 可选，正整数钳 1-8，缺省回退全局 `llmConcurrency` 默认 3——每模型独立有界池、各桶并行 drain，慢供应商不队头阻塞其余模型；网络型）与 battle 进程（CPU 型，默认 4）互补无需联动节流；evidence 组装原样复制走 symlink→hardlink→copyFile 三级 fallback（视角翻转拷贝恒真拷贝）；analyze 逐 results 先跑连通性预检（`results-connectivity.ts` 纯函数，colocated 单测）：打印连通分量数，>1 时 WARNING 列出断连分量（全代累积池 + 逐 rating period 当期图），只告警不阻断；`archive --through <N> [--include-chain] [--dry-run]` 冷代次压缩归档：r≤N 的 pair 级 game-\* 明细打包 `archive/round-<r>/<pair>.tar.gz` 并删原目录（批级 JSON 恒保留、state 位图不变；链批默认保留；上游 evolve 未 done 的代跳过；tar -tzf 条目校验一致后才删，校验不过 fail-fast；恢复 = `tar -xzf <tarball> -C battles/<pair>`；evidence 为 symlink 时指向候选 pair 的整 pair 跳过） |
| `ops/anchor-experiment.ts` | WP5 锚点复验编排（impl-spec-5）：双臂起草 + 三对抗矩阵批跑（batchConfig 注入 `traceSignatures: "lean"`）+ 读数交叉校验 |

## 与 src/ 的差别

`src/<module>/cli/run-*.ts` 是**主流水线 CLI**，由 `package.json` scripts 暴露。本目录的脚本不在 `package.json` 中，调用形式为 `pnpm exec gnx scripts/<name>.ts` 或 `python3 scripts/<name>.py`。
