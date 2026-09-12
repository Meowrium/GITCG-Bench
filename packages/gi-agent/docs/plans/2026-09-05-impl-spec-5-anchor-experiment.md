# WP5 实现规格：round19 式 `--anchor` 起草复验

> 来源：[impl-spec-0-overview.md](./2026-09-05-impl-spec-0-overview.md)；目标：执行方案阶段 3。
> 状态：**已实现**（编排脚本 `scripts/ops/anchor-experiment.ts`，复用 WP1 tournament-config；spawnPnpm env 注入转发已修复；实验运行待 API 凭据环境）。
> 复用：`--anchor` 两阶段起草已完整实现（`run-plan-author.ts:124-301` + `prompts/anchor-system.md`，
> 含形状闸 archetype/killMath/riskTriggers）——本包**零新逻辑**，纯编排与读数。
> 历史结论：round19-anchor-ablation（DS/M3/GLM-5.2，2026-08-25/26；08-21 文档 §438-466）——
> coverage 一致更低、fallback 一致更高、臂对臂 27:43:10 ctrl 占优、"无稳定收益"双口径复核成立。
> 本实验 = 新模型代（glm-5.3/deepseek-v4 等）+ 新管线下复验是否泛化。

## 1. 交付物

| # | 件 | 位置 |
|---|---|---|
| 1 | 实验编排脚本 | `gi-agent/scripts/ops/anchor-experiment.ts` |
| 2 | 读数汇总 | 实验产物目录 `summary.json` + `summary.md` |

## 2. 配置与编排

`pnpm exec gnx scripts/ops/anchor-experiment.ts --config <anchor-exp.json> --out <dir>`
（可选 `--author-concurrency N`：LLM 起草单元并发，默认 3、钳 1-8；`--battle-concurrency N`：
battle 批进程并发，默认 4、钳 1-8——引擎在单 node 进程内单线程，批间进程级并行才有效，
批内恒 1 局在飞；并行单元的 state 落盘均串行化互斥）：

```jsonc
// anchor-exp.json
{
  "models": ["glm-5.3","glm-5.3-flash","deepseek-v4-pro-0813","deepseek-v4-flash-vision-exp"],  // 2-4（2026-09-06 加 glm-5.3-flash 后 4 模型）
  "environment": { "label": "v6.3", "gameVersion": "v6.3.0", "decks": ["<2-8 deckCode>"] },
  "gamesPerMatch": 20,          // 单对抗批局数（非每格 15——本实验不并赛程矩阵）
  "seeds": [42071001, 42071002],// 跨 seed 报 SE
  "models_api": { /* name→{baseUrl,model,apiKeyEnv}，复用 WP1 tournament-config 解析 */ }
}
```

**双臂**（同模型同 deck 同 seed）：A = `plan:author` 直起草（无 `--anchor`）；
B = `plan:author --anchor`（两阶段）。两臂产物 `plans/<model>/ctrl.r0.json` 与
`plans/<model>/anchor.r0.json`。

**对抗矩阵**：ctrl×ctrl（同臂基线，控模型自身方差）、anchor×anchor（同臂基线）、
ctrl×anchor（臂对臂，**关键战绩**）。对每模型×每 deck 跑 `plan:batch`
（plan vs opponent，opponent.type="plan"），同 seed 梯（先例 round19 同型）。

## 3. 读数

`summary.json` + `summary.md`：

| 读数 | 字段 | 来源 |
|---|---|---|
| coverage | 每 (模型,臂,deck) 的 summary coverage | summary.json |
| fallback 率 | summary fallback/total | 同上 |
| 臂对臂战绩 | ctrl vs anchor 每模型胜负平 + 三模型合计 | perGame winner 计数（映射见 WP1 §4.4） |
| avgRounds | 每臂均值 | summary |
| 次级诊断 | perRuleHits / thenMiss（按层前缀聚合）| summary，可选 |

## 4. 验收标准

1. 双臂产物生成且 `--anchor` 臂确实走了两阶段（产物含 anchor sidecar JSON 或
   transcript 含"策略锚点分析"阶段文本——核验一种即可）；
2. 三对抗批跑全绿、`plan:batch` 现有断言不触发；
3. coverage/fallback/战绩数字与各 summary.json 原值一致（脚本交叉校验）；
4. 输出 `summary.md` 含 round19 对照行（同口径便于比对面）；
5. 失败隔离：单模型超时/失败不阻塞其余。

## 5. 判定与回写

- **复现负面**（anchor coverage ≤ ctrl 且臂对臂 ctrl 占优）→ 主赛 author 一律不开
  `--anchor`；写 `summary.md` 结论；
- **出现稳定收益**（三模型一致 anchor coverage > ctrl 且臂对臂 anchor 占优）→
  回写 [2026-09-05-tournament-execution-plan.md](./2026-09-05-tournament-execution-plan.md)
  §6 阶段 3 与 WP1 §4.1 author 默认参数（加 `--anchor`）。
- 混合/不一致 → 报告现象、不修改主赛，留作下轮决定。

## 6. 明确不做

不做 r0 赛程锚点矩阵（已拍板不做）；不与正赛管线耦合（独立小实验，可并行/后置）；
不做 ISMCTS/NN 双口径复核（round19 已做过，本实验只走 engine-only）。
