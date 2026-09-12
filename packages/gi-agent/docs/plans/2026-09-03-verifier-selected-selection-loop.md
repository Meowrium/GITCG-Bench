# 验证器选择监督与候选选择器回路：论文 2608.18324 迁移设计

> 日期：2026-09-03。状态：**设计提案（待评审）**。
> 来源论文：Salas 2026《Governance Records as Supervision: Verifier-Selected Self-Training for Structured Workflow Repair》（arXiv:2608.18324，paper-scout 归档于兄弟仓库 `paper-scout/papers/llm-self-improvement/`）。
> 关联文档：[2026-08-30-oracle-free-selfevolution-arm.md](./2026-08-30-oracle-free-selfevolution-arm.md)（engine-only 臂，本提案是其**选择器环节**的延伸）、[oracle-free-harness-metrics.md](../oracle-free-harness-metrics.md)（产物与计数口径）、[2026-09-03-cross-model-rating-tournament.md](./2026-09-03-cross-model-rating-tournament.md)（holdout 对手矩阵的复用方）。
> 整合稿：本提案与 [2026-09-03-llm-evidence-organizer-eval.md](./2026-09-03-llm-evidence-organizer-eval.md) 的修改建议已于 [2026-09-03-integrated-roadmap-selection-organizer.md](./2026-09-03-integrated-roadmap-selection-organizer.md) 合并消重（重叠件 1–5：HarnessStats 扩展、跨代聚合、reflect 改动打包、run 目录契约、op 出处），实施排期与跨案边界纪律以整合稿为准。

## 0. 一句话结论

engine-only 臂已实现论文"治理记录"范式的**产物级**版本（契约/尝试/裁决/接纳产物/谱系/门控六元组齐全），当前唯一大的结构缺口是论文 RQ2 证明的因果载荷环节：**候选选择器**。反思是"generate-1 → verify-1"的 LLM 自选；论文证明 generate-N → verify-all → 机械选择显著优于自选，且所需验证信号（机械接纳门 + 规模化配对结局）本仓库已全部具备。

## 1. 论文要点（只记与本管线相关的）

- **治理记录即监督**：机器可验证工作流的运行记录 (契约 C, 模型尝试 y, 验证器裁决 V(C,y), 被接纳产物 o, 来源谱系, 门控结果 g) 可以从审计资产升格为训练/改进监督——无 oracle 标注、无更强教师。
- **主结果**：thinking 模式在 32 个收割用例上（每例 ≤8 次尝试）产出 24 个被独立编写验证器（VAL）接纳的计划，训练同一检查点的廉价执行模式。80 个未开卷用例：基线 1/80 → 57/80（thinking 本身 30/80），56 配对增益、零回退，两个难度层均为正。
- **选择器消融（RQ2，最有迁移价值）**：冻结候选池（52 候选）、目标数、模型、配方、种子，只换选择器——schema-only 选 15/24 有效目标 → 55/160；模型自选 20/24 → 69/160；验证器 24/24 → 102/160。验证器超自选 +33 配对净差（p≈2×10⁻⁶）。**模型自选已近乎完美（20/24），剩余 4 个杂质目标仍造成巨大下游损失**——自选不是可接受的近似，是结构性短板。
- **负结果（interface-cure 门）**：源模式接口合格率已近天花板（77/80），修复门无 headroom，预注册门失败（p=0.25）。教训：**门前先量 headroom，无余量的门改用别的测量，不要产出 inconclusive 当结论**。
- **饱和解读**（§5.5）：测量饱和是"换测量"的信号，不是"计划穷尽"的证据。
- **被拒候选保留**："Rejected predecessors are preserved rather than discarded"——拒绝记录与接受记录同为一等资产。
- **范围边界**：只主张有界、可机检能力上的自进化；verifier-confirmed ≠ 客观正确——**不完整的契约可以完美接纳错误行为**；验证器独立 authored 的程度决定结论强度。

## 2. 同构映射：仓库已实现的"治理记录"产物级版本

| 论文概念 | 仓库对应物 | 状态 |
|---|---|---|
| 任务契约 C | GamePlanV1 schema + 版本钉扎 + 牌表封闭校验 | ✅ 已建成 |
| 模型尝试 y | author/reflect 产物 + patch ops | ✅ |
| 验证器裁决 V（transport 层） | validate / fields-lint / plan-replay 静态回放 | ✅ |
| 验证器裁决 V（semantic 层） | 批跑引擎指标 + `judgeEngineOnly`（ablate-criteria.ts 纯函数） | ✅ |
| 失败检查集 F（局部残差） | thenMiss 死规则探针、fallback 聚类、零命中告警、coverage 洞 | ✅ |
| 来源谱系 o | reflection sidecar verdicts、rule-key 归因、planId/portfolioId 断言 | ✅（op 级出处待补，见 §4.6） |
| 预注册门 g | falsifiableClaim + 引擎侧判据纯函数 | ✅ |
| 验证器保持最终裁决权 | 机械门 + 结局统计在环内；分值型验证器（NN）**暂不启用** | ✅ 纪律明确 |
| **候选选择器** | **缺**（反思单候选自选） | ❌ 本提案核心 |
| 收割/评估分区 | 证据与消融基线同源，无 holdout 门 | ⚠️ 部分缺失 |
| 被拒候选留档 | 仅 transcript 文本，无结构化落盘 | ⚠️ |
| 跨代治理台账 | §11 已列缺口（无聚合脚本、校验计数不持久） | ⚠️ |

## 3. 核心缺口：候选池 + 引擎选择器（P0）

现状：`plan:reflect` 产出一版修订（或一组合并 patch），`plan:ablate` 事后裁决单变量臂——即 generate-1 → verify-1，选择权完全在 LLM 自身。

论文 RQ2 的迁移结论：把 LLM 的"选哪条修订进主干"从自选改为机械选择。所需设施均已存在：

- **候选生成**：harness 本就是有界循环；author/reflect 均可多出口（不同轮次/温度各产一版候选，或 K 次 one-shot）。K 取 2–4 即可起步。
- **候选验证**：批跑纯引擎、分钟级几千局（锦标赛文档已验证的成本量级）；每个候选同 seed 梯对同基线对手集跑 N 局。
- **选择判据**：`judgeEngineOnly` 纯函数直接复用为选择器——thenMiss 归零（主判据）→ coverage/fallback 混淆闸（5pp）→ 同种子配对胜率区间。**全部是引擎事实与结局统计，不依赖任何分值模型**。
- **留档**：被拒候选连同样本判据读数落盘（见 §4.4）。

对 `plan:ablate` 的升格：现有"单变量验证 LLM 主张"的臂机制之上，增加**选择策略消融**四臂对照（论文模板）：基线 / 仅 schema 接纳 / LLM 自选 / 机械判据选择。这同时是饱和后"换测量"的具体形态（§4.3）。

## 4. 改进方向清单（按优先级）

### 4.1 候选池 + 机械选择器回路（P0）

见 §3。入口建议：`plan:reflect` 增加 `--candidates K`（harness 模式下各通过校验的 final 均保留为候选；one-shot 模式下重复采样）；新选择入口可并入 `plan:ablate` 臂机制或独立小 CLI；选择判据只复用 `judgeEngineOnly`，不新造口径。

### 4.2 收割/评估分区卫生（P0）

论文对 harvest 与 eval 分区做结构重叠指纹排除；当前反思证据与消融基线来自同一批 run 目录，存在向证据对手过拟合的风险（roundS8 的 ③a moyou held-out 三代连退已是此模式的实证迹象）。设计：

- 对手集（或种子梯）显式分 **harvest / holdout** 两层，写进 run 目录或批跑 config 约定
  （**2026-09-05 拍板**：显式二分不采用为主机制——holdout 总体定稿为下条锦标赛 D² 矩阵，
  分区字段契约保留，见整合稿 §6-2 与边界纪律 7；09-02 `heldout[]` 是泛化语义另一机制，命名区分）；
- `plan:reflect` 只接受 harvest 目录作证据（现有交叉对手合并逻辑原样复用，只是输入域收窄）；
- `plan:ablate` 判据增加 holdout 门：harvest 上 supported 且 holdout 上不劣化（方向性检验）才算 supported，否则降级 inconclusive；
- 跨模型锦标赛的 D² 对手矩阵可直接充当 holdout 总体。

### 4.3 饱和后的"换测量"（P1）

roundS1–S8 的实践（胜率 r3 饱和、r7 起单规则消融全部 inconclusive、主梯止步 9 代）符合论文的冻结停止门纪律，**保留**。论文补充的是饱和后的正确动作：换测量而非换任务或宣告穷尽。具体选项按成本排序：加大配对局数 N（最便宜、统计干净）→ 换选择器（§4.1）→ 换难度层/对手分层 → 分值型验证器（**NN 暂不启用**，见 §5）。

### 4.4 被拒候选保留 + 校验计数落盘（P1）

论文 §3.7 把被拒前驱与被接纳目标同等保留。对齐 `oracle-free-harness-metrics.md` §6/§7.3/§11 已自认的缺口：

- harness sidecar 增加被拒 draft/patch 的结构化记录（原因码 + 判据读数），不再只活在校验反馈文本；
- 校验期 issue 增加类别直方图（死规则 / 格式 / 封闭集合违规）并并入 HarnessStats；
- 跨代聚合脚本读各代 summary.json（引擎侧五指标）+ harness.json（行为计数）出 trend 图，补 §11 缺口。

### 4.5 配对统计升级 + headroom 预检（P1）

- `judgeEngineOnly` 补**同种子配对精确检验**：臂与基线同 seed 梯，胜/负转移配对计数（McNemar 式）不需要任何分值模型；oracle 模式已有先例，engine-only 口径补齐。
- 门条件加"两个分层均为正"（**2026-09-05 拍板：两级都做**——主门分层键 = 先手/后手，
  阻断 supported；按对手分组为次级诊断输出，只报告不阻断），对应论文的 5/6-block strata 门。
- **headroom 预检**：反思轮之前先算可用信号余量（thenMiss 计数、fallback 集中度、基线胜率差），某门无余量则明示 `no-headroom` 跳过并换门，不产出 inconclusive 当结论（论文 interface-cure 负结果的教训）。

### 4.6 出处（provenance）标注（P2）

- patch op 增加证据锚点字段（该 op 源于 thenMiss 锚点 / threat 读数 / LLM 自由叙述），使消融可按出处分层——论文的来源分类学（程序 oracle / 验证器选择 / 自蒸馏 / 强教师）决定主张强度，op 级出处是它的最小实现；
- `learning/rl/cli` 导出的数据集带出处标签：plan/trace/outcome 三元组若将来用于训练，出处干净与否直接决定结论强度。

### 4.7 三个监督面消融（P2，可选实验）

论文区分 verdict-only / 局部治理轨迹 / 完整目标三种反馈面。engine-only 反思现注入全量 digest（单组 420 行）。加一个 verdict-only prompt 臂（只给聚合摘要级别证据），检验细粒度 digest 是否载荷；若不载荷，反思上下文成本可大幅下降。臂设施现成，只差 prompt 变体。

## 5. 非人工标注改进信号的提取通道（终版）

模拟器基础设施提供四条免标注信号通道，本回路的信任边界严格画在引擎的确定性事实上：

| # | 通道 | 提供什么 | 状态 |
|---|---|---|---|
| 1 | 机械失败探针（thenMiss / fallback 聚类 / 零命中 / coverage 洞） | "哪里坏了"的定位 = 论文的失败检查集 F | ✅ 已建成 |
| 2 | 规模化结局信号（同种子配对胜率，批跑零 LLM） | "改了是否更好"的直接测量 | ✅ 已建成，统计检验待补（§4.5） |
| 3 | 候选选择器（机械判据 + 结局统计） | "多个候选进哪个主干" | ❌ §4.1 待建 |
| 4 | 治理台账（被拒候选留档 + 跨代聚合） | 可复用资产、跨代趋势 | ⚠️ §4.4 待补 |

分值型验证器（对局面/行动打分的模型）在通道 3 的排序环节**暂不启用**：通道 1+2 的组合已覆盖"接纳 + 排序"需求，且统计上更干净（直测结局 vs 间接估计价值）。NN（外部闭源 checkpoint，v6.3.0 词表）**暂不启用**，维持环外纪律。

## 6. 明确不动的部分

论文对照审查后确认已达论文水准或更严、不因本提案改动的部件：

- 泄漏断言（`findOracleArtifacts` fail-fast）、`--evidence engine-only` 统一开关、prompt 全文落盘机检；
- 版本钉扎（author/reflect/ablate/batch 四处）与 `assertOpponentAlignment`；
- patch 服务端合并 + plan-replay 静态回放核验 + 覆盖确认闸；
- falsifiableClaim 协议与"判据为纯函数"的约束；
- threat 字段语义、fallback 推荐二选一口径；
- 停止门纪律（roundS 系列的止步结论不翻案）。

## 7. 部件调整清单（文件级）

| 部件 | 改动 | 关联 |
|---|---|---|
| `runtime/plan-oneshot/cli/run-plan-reflect.ts` + `agent-loop.ts` | `--candidates K` 候选出口；候选产物落盘约定 | §4.1 |
| `runtime/plan-oneshot/cli/ablate-criteria.ts` | 补同种子配对精确检验；双层 strata 门；`no-headroom` 预检输出 | §4.5 |
| `runtime/plan-oneshot/cli/run-plan-ablate.ts` | 选择策略消融四臂（或独立选择器 CLI）；holdout 门 | §4.1 / §4.2 |
| 批跑 config / run 目录约定 | harvest/holdout 对手分区字段 | §4.2 |
| harness sidecar schema（`agent-loop.ts`） | 被拒 draft/patch 结构化留档 + issue 类别直方图 | §4.4 |
| `scripts/`（新增） | 跨代聚合脚本（引擎侧五指标 + 行为计数 trend 图），补 §11 缺口 | §4.4 |
| `plan-patch.ts` | op 级证据锚点字段 | §4.6 |
| `learning/rl/cli` | 导出语料出处标签 | §4.6 |
| `prompts/reflect-system-engine-only.md` | verdict-only 变体（可选实验臂） | §4.7 |

## 8. 范围护栏（主张边界，从论文借来）

1. 只主张**可机检能力**上的自进化：thenMiss 归零、coverage 保持、同对手集配对胜率——主张严格停留在这些指标能检查的范围内。
2. verifier-confirmed ≠ 客观正确：机械门只覆盖其检查面（契约完整性有限），"合法但更差"由胜率门兜底，两层都不能替代对局强度结论。
3. 验证器独立性自评：引擎与本仓库 LLM 无共享成分（强独立）；判据阈值与门设计是自 authored（弱独立），靠预注册冻结 + holdout 分区补偿——结论表述时区分这两层。
4. 描述性对比不升格：特化产物（修订计划）优于其来源（原计划 + 反思）的对比是操作面结论，不主张一般性超越。
