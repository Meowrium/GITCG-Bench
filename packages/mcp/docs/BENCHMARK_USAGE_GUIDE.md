# 赛前卡组分析 Benchmark 使用指南

> 本文档是 [`PRE_GAME_DECK_ANALYSIS_BENCHMARK.md`](./PRE_GAME_DECK_ANALYSIS_BENCHMARK.md) 的操作手册。
> 设计规范见该文档，本文只讲"怎么用"。

## 目录

1. [前置准备](#1-前置准备)
2. [工作流总览](#2-工作流总览)
3. [准备卡组列表](#3-准备卡组列表)
4. [初始化标注工作区（`annotate-gold init`）](#4-初始化标注工作区annotate-gold-init)
5. [人工标注 gold.json](#5-人工标注-goldjson)
6. [验证标注（`annotate-gold validate`）](#6-验证标注annotate-gold-validate)
7. [查看进度（`annotate-gold status`）](#7-查看进度annotate-gold-status)
8. [导出数据集（`annotate-gold export`）](#8-导出数据集annotate-gold-export)
9. [运行 Benchmark（`run-benchmark`）](#9-运行-benchmarkrun-benchmark)
10. [评分体系](#10-评分体系)
11. [统计与模型比较](#11-统计与模型比较)
12. [两个赛道](#12-两个赛道)
13. [文件清单](#13-文件清单)

---

## 1. 前置准备

```powershell
# 环境变量（任选一种）
$env:OPENAI_API_BASE = "https://api.example.com/v1"
$env:OPENAI_API_KEY  = "sk-xxx"

# 或在调用时传参 --api-base / --api-key
```

所有命令通过 `pnpm exec gnx` 在项目根目录运行，不需要额外构建。

---

## 2. 工作流总览

```
卡组列表 deck-list.json
  │
  ├─ annotate-gold init ──→ 工作区生成（含变体）
  │                          ├─ my_deck_data.json  （标注者只读）
  │                          ├─ opp_deck_data.json  （matchup 样本）
  │                          └─ gold.json           （标注者填写）
  │
  ├─ 人工标注 gold.json
  │
  ├─ annotate-gold validate ──→ schema + evidence 检查
  │
  ├─ annotate-gold status   ──→ 进度概览
  │
  ├─ annotate-gold export   ──→ gold-dataset.json
  │
  └─ run-benchmark --gold gold-dataset.json
       ├─ 调用 LLM 生成 analysisV2
       ├─ schema + evidence 验证
       ├─ 对照 gold 评分（100 分制）
       └─ grouped-bootstrap CI 报告
```

---

## 3. 准备卡组列表

创建一个 JSON 文件，参考 `packages/mcp/src/benchmark/deck-list.example.json`：

```jsonc
{
  "version": "v5.5.0",          // 可选，省略 = 当前版本
  "decks": [                     // 单卡组样本
    { "code": "A0BQ9...", "name": "水八" },
    { "code": "APBw4...", "name": "雷鹤" }
  ],
  "matchups": [                  // 双卡组对局样本（可选）
    {
      "deck0": "A0BQ9...", "deck1": "APBw4...",
      "deck0Name": "水八", "deck1Name": "雷鹤"
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `version` | 数据版本。省略或留空 = 当前版本；填 `"v5.5.0"` 等历史版本时，自动使用对应 `AssetsManager({ version })` 解析 |
| `decks[]` | 单卡组样本——评价事实恢复、卡组画像、关键件、线路 |
| `matchups[]` | 双卡组对局样本——额外评价 matchup 判断（威胁、对局计划） |

想加更多卡组只需在数组里追加条目，无需改代码。`name` 省略时自动生成 `deck_0`、`deck_1` 等。

---

## 4. 初始化标注工作区（`annotate-gold init`）

```powershell
# 基本用法
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts init my-deck-list.json

# 自动生成最小改动变体
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts init my-deck-list.json --variants 1

# 指定工作区目录（默认 .opencode/tmp/gold-workspace）
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts init my-deck-list.json `
  --workspace ./gold-workspace
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `<deck-list.json>` | （必填） | 卡组列表文件路径 |
| `--workspace <dir>` | `.opencode/tmp/gold-workspace` | 工作区输出目录 |
| `--variants 1` | `0` | 是否自动生成最小改动变体 |

### 变体类型（`--variants 1`）

| 变体 | 说明 |
|------|------|
| `remove_payoff` | 移除唯一的 payoff 卡（天赋/秘传），用非关键牌替换 |
| `remove_enabler` | 移除关键 enabler（共鸣/料理/装备），用非关键牌替换 |
| `replace_draw` | 将 payoff 换成另一张泛用牌 |
| `replace_defense` | 将 enabler 换成防守牌 |

变体和原卡组共享同一个 `lineage`，在评分时按 lineage 分组做 macro-average，防止近重复变体主导总分。变体上的幻觉引用（仍然引用已删除的牌）会被自动扣分。

### 生成的目录结构

```
gold-workspace/
  manifest.json                          # 所有样本元数据
  samples/
    水八-base/
      my_deck_data.json                  # 卡组纯数据（标注者只读）
      gold.json                          # 标注模板（标注者填写）
    水八-remove_payoff/                   # 变体（--variants 1 时生成）
      my_deck_data.json
      gold.json
    水八-vs-雷鹤/                          # matchup 样本
      my_deck_data.json                  # 己方卡组
      opp_deck_data.json                 # 对手卡组
      gold.json
```

`manifest.json` 记录每个样本的 ID、lineage、卡组代码、版本、contextHash 等元数据。

---

## 5. 人工标注 gold.json

打开 `samples/<样本ID>/gold.json`，它是一个带注释的 JSON 模板：

```jsonc
{
  "// 标注说明": "evidence 中的 ID 必须来自 my_deck_data.json",
  "// archetype 可选值": "tempo, midrange, control, combo, ramp, aggro, ...",
  "// winCondition.kind 可选值": "burst, board_lock, attrition, engine, other",
  "// keyPiece.role 可选值": "enabler, payoff, engine, tutor, protection, finisher",
  "// keyPiece.necessity 可选值": "required, replaceable, optional",
  "// line.kind 可选值": "combo, pressure, stabilize, value",
  "// threat.severity 可选值": "low, medium, high",
  "// targetPace 可选值": "race, stabilize, deny_setup, outvalue",

  "analysisV2": {
    "deckProfile": {
      "archetypeWeights": { "tempo": 0.65, "combo": 0.70, "midrange": 0.20 },
      "primaryArchetypes": ["tempo", "combo"],
      "pace": {
        "setupRounds": { "min": 1, "max": 2 },
        "pressurePeakRounds": [2, 3],
        "lateGameReliance": 0.25
      },
      "winConditions": [
        {
          "id": "wc-1",
          "kind": "burst",
          "description": "通过元素反应在第2回合打出斩杀",
          "requiredPieces": ["15001"],
          "evidence": ["15001"],
          "confidence": 0.82
        }
      ],
      "keyPieces": [
        {
          "id": "15001",
          "role": "payoff",
          "necessity": "required",
          "evidence": ["15001"],
          "confidence": 0.90
        }
      ],
      "lines": [
        {
          "id": "line-1",
          "kind": "combo",
          "steps": [
            { "actor": "15001", "effect": "挂冰", "evidence": ["15001"] }
          ],
          "preconditions": ["场上已有冰元素附着"],
          "payoff": "冻结+爆发伤害",
          "fragility": ["可被驱散打断"],
          "confidence": 0.74
        }
      ],
      "resourcePlan": {
        "priority": ["dice", "energy", "tempo", "cards", "board_slots"],
        "bottlenecks": [
          { "resource": "dice", "reason": "需要3个同色骰子", "evidence": ["15001"] }
        ]
      }
    },
    "matchup": {
      "opponentThreats": [
        {
          "id": "threat-1",
          "source": "12005",
          "window": { "minRound": 2, "maxRound": 3 },
          "severity": "high",
          "counterplay": ["提前切人规避爆发"],
          "evidence": ["12005"],
          "confidence": 0.68
        }
      ],
      "relativePlan": {
        "advantageAxes": ["tempo", "burst"],
        "targetPace": "race",
        "confidence": 0.61
      }
    },
    "abstentions": []
  }
}
```

### 标注规则

1. **evidence 中的 ID** 必须来自 `my_deck_data.json`（单卡组）或 `opp_deck_data.json`（matchup）。标注者从输入数据中复制角色 `id`（数字字符串）或 `name`（中文名称）。
2. **`primaryArchetypes`** 是 `archetypeWeights` 中权重 >= 0.35 的标签集合。
3. **权重与 confidence** 必须在 `[0, 1]`。
4. **每个关键结论**（winCondition、keyPiece、threat）至少提供一条 evidence。
5. **没有可靠依据时**使用 `abstentions`，不要编造确定结论。
6. **单卡组样本**（无对手）不应填写 `matchup.opponentThreats`，应将该字段加入 `abstentions`。
7. **`archetypeWeights` 各值之和**不超过 1.0。
8. **`matchup.opponentThreats[].source`** 必须来自对手卡组数据。
9. 模板中以 `"//"` 开头的键在解析时会被自动剥离，不影响 JSON 合法性。

---

## 6. 验证标注（`annotate-gold validate`）

```powershell
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts validate --workspace ./gold-workspace
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--workspace <dir>` | `.opencode/tmp/gold-workspace` | 工作区目录 |

检查内容：

| 检查项 | 说明 |
|--------|------|
| JSON 解析 | gold.json 是否为合法 JSON（注释自动剥离） |
| Zod schema | 枚举值、权重范围 `[0,1]`、必填字段、权重之和 <= 1.0 |
| Evidence ID 存在性 | 所有 evidence/requiredPieces/source 中的 ID 是否存在于输入数据中 |
| 跨侧引用检测 | 己方字段不能引用对手卡牌；对手 threat 的 source 不能引用己方卡牌 |
| primaryArchetypes 一致性 | 每个 primaryArchetype 权重 >= 0.35；每个 >= 0.35 的标签都在列表中 |

输出示例：

```
=== Gold Annotation Validation ===
  [OK]      水八-base
  [OK]      水八-vs-雷鹤
  [ERROR]   雷鹤-base - evidence: 1 issues
             deckProfile.keyPieces[15002].evidence: ID "99999" not found

=== Summary ===
  Valid:    14
  Errors:   1
  Pending:  3
  Total:    18
```

有 error 时退出码为 1，可在 CI 中使用。

---

## 7. 查看进度（`annotate-gold status`）

```powershell
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts status --workspace ./gold-workspace
```

输出示例：

```
=== Gold Annotation Status ===
  Workspace: ./gold-workspace
  Version:    v5.5.0
  Created:    2026-07-11T12:00:00.000Z

By lineage:
  水八_x1a2b3:
    DONE       水八-base
    TEMPLATE   水八-remove_payoff [variant: remove_payoff]
  雷鹤_c4d5e6:
    DONE       雷鹤-base
    PENDING    雷鹤-remove_enabler [variant: remove_enabler]

Progress: 2/4 done, 2 pending
  50.0% complete
```

状态值：`DONE`（已填写）、`TEMPLATE`（未填）、`PENDING`（无文件）、`PARSE_ERR`（JSON 错误）。

---

## 8. 导出数据集（`annotate-gold export`）

```powershell
pnpm exec gnx packages/mcp/src/benchmark/annotate-gold.ts export gold-dataset.json --workspace ./gold-workspace
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `<output.json>` | （必填） | 输出文件路径 |
| `--workspace <dir>` | `.opencode/tmp/gold-workspace` | 工作区目录 |

将所有已完成（`DONE`）的 gold 收集到一个 JSON 文件中。未完成的样本 `gold` 字段为 `null`。

输出文件结构：

```json
{
  "schemaVersion": "2.0",
  "exportedAt": "2026-07-11T12:30:00.000Z",
  "version": "v5.5.0",
  "samples": [
    {
      "id": "水八-base",
      "type": "single",
      "lineage": "水八_x1a2b3",
      "deckCode": "A0BQ9...",
      "deckName": "水八",
      "version": "v5.5.0",
      "contextHash": "sha256:abc123",
      "isVariant": false,
      "variantKind": null,
      "gold": { "analysisV2": { ... } }
    }
  ]
}
```

---

## 9. 运行 Benchmark（`run-benchmark`）

### 单卡组 smoke

```powershell
pnpm exec gnx packages/mcp/src/benchmark/run-benchmark.ts `
  --deck "A0BQ9..." `
  --model "deepseek-v4-flash" `
  --track "reasoning-pure" `
  --output ".opencode/tmp/benchmark-results"
```

### 带对手卡组

```powershell
pnpm exec gnx packages/mcp/src/benchmark/run-benchmark.ts `
  --deck "A0BQ9..." `
  --opp-deck "APBw4..." `
  --model "deepseek-v4-flash"
```

### 生成变体并批量评测

```powershell
pnpm exec gnx packages/mcp/src/benchmark/run-benchmark.ts `
  --deck "A0BQ9..." `
  --model "deepseek-v4-flash" `
  --variants 1 `
  --bootstrap-iterations 1000
```

### 对照 gold 评分

```powershell
pnpm exec gnx packages/mcp/src/benchmark/run-benchmark.ts `
  --deck "A0BQ9..." `
  --model "deepseek-v4-flash" `
  --gold "gold-dataset.json"
```

### 完整参数表

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--deck <code>` | （必填） | 卡组代码 |
| `--opp-deck <code>` | 空 | 对手卡组代码（提供后启用 matchup 评分） |
| `--version <ver>` | 空（当前版本） | 卡牌数据版本 |
| `--model <name>` | `GLM-5` | LLM 模型名 |
| `--api-base <url>` | env | API base URL |
| `--api-key <key>` | env | API key |
| `--prompt <path>` | `.opencode/prompts/pre-game-analysis-pure.md` | 提示词模板路径 |
| `--output <dir>` | `.opencode/tmp/benchmark-results` | 输出目录 |
| `--track <name>` | `reasoning-pure` | 赛道：`reasoning-pure` 或 `heuristic-assisted` |
| `--gold <path>` | 空 | gold 数据集文件路径 |
| `--variants 1` | `0` | 自动生成变体并一起评测 |
| `--temperature <n>` | `0.3` | LLM 采样温度 |
| `--max-tokens <n>` | `8192` | LLM 最大 token |
| `--bootstrap-iterations <n>` | `1000` | Bootstrap 迭代次数 |

### 输出文件

```
.opencode/tmp/benchmark-results/
  benchmark_results.json    # 每个样本的完整结果（schema 验证、evidence 验证、分数）
  bootstrap_report.json     # grouped-bootstrap CI（mean/lower/upper/stdDev）
```

控制台输出示例：

```
=== Benchmark: base ===
  Building deck contexts...
  Calling LLM (deepseek-v4-flash)...
  Schema valid. Validating evidence...
  Evidence: OK (hallucinated=0, crossSide=0)
  Score (no gold): 72.5/100

=== Summary ===
  base                          OK               score=72.5/100
```

---

## 10. 评分体系

总分 100 分，6 个分项。单卡组任务（无对手）移除 matchup 的 10 分，按比例重分配到其他分项。

| 分项 | 分数（matchup） | 分数（单卡组） | 方法 |
|------|-------:|-------:|------|
| 输入忠实性 | 20 | 22 | schema 合规、ID 存在性、无跨侧引用、evidence 可蕴含、无虚构牌 |
| 卡组画像 | 20 | 23 | `archetypeWeights` 的 Brier score、`primaryArchetypes` 的 macro-F1、`pace` 区间的 IoU |
| 获胜条件与关键件 | 25 | 25 | `kind`/`role`/`necessity` 的加权集合 F1 + evidence 重叠度 |
| 线路与资源推理 | 20 | 25 | 步骤依赖、前置条件、payoff、fragility 的 rubric；不可能线路为 0 |
| matchup 判断 | 10 | 0 | `threat`/`source`/`window`/`counterplay` 的加权 F1（仅 matchup） |
| 校准与克制 | 5 | 5 | confidence 方差检查 + 正确 abstention 加分；错误高 confidence 扣分 |

### 变体幻觉检测

如果被评测的卡组是变体（移除了某张关键牌），评分器会额外检查模型输出中是否仍然引用了被删除的牌。每发现一次幻觉引用，从输入忠实性分中扣除 4 分。

### 评分统计

- 评分时按 lineage 做 macro-average（变体 lineage 权重合计为 1）。
- 报告 grouped-bootstrap（默认 1000 次，按 lineage 重采样）的 95% CI。
- 比较模型时报告分项 delta 与 CI。

---

## 11. 统计与模型比较

`run-benchmark` 在有 >= 2 个样本时自动运行 bootstrap 并输出 CI：

```
=== Bootstrap CI (4 groups, 8 samples) ===
  Total: 71.25 [65.30, 76.80]
  Input Fidelity: 17.50 [15.00, 19.00]
  Deck Profile: 14.20 [11.50, 17.00]
  ...
```

通过编程接口比较两个模型：

```typescript
import { compareModels, formatComparison } from "./benchmark"

const report = compareModels(resultsA, resultsB, "glm-5", "deepseek-v4-flash")
console.log(formatComparison(report))
```

输出：

```
Comparison: glm-5 vs deepseek-v4-flash
  Total delta: 3.50 [-1.20, 8.10]
  A significantly better: NO

  By category:
    Input Fidelity                  delta=1.00 [-0.50, 2.50]
    Deck Profile                    delta=2.50 [0.10, 4.80]
    ...
```

结论规则（`A 优于 B`）：
- Total delta 的 95% CI 下界 > 0
- `输入忠实性 >= 18/20`
- `获胜条件与关键件` 和 `线路与资源推理` 均不低于对照 3 分以上
- 最小改动变体上的总分不低于原卡组集合
- "引用已删除关键件"率 < 2%

---

## 12. 两个赛道

| 赛道 | 模型输入 | 用途 |
|------|---------|------|
| `reasoning-pure` | `createDeckContext` 纯数据 | 测量模型自身的规则阅读与推理能力 |
| `heuristic-assisted` | 纯数据 + 启发式输出 | 测量整套沙箱产品的效果 |

跑 benchmark 时用 `--track` 指定。两个赛道的成绩**必须分开报告**，不可合并。

在 `heuristic-assisted` 赛道中，模型输入包含 `createRichDeckContext` 的 trigger chain、combo clock、zone pressure 等启发式中间产物。如果这些启发式输出同时出现在 gold 中，则该字段不能作为同一字段的 gold label——需在 gold 中标注其来源。

---

## 13. 文件清单

| 文件 | 说明 |
|------|------|
| `packages/mcp/src/benchmark/analysis-v2-schema.ts` | Zod schema 定义 |
| `packages/mcp/src/benchmark/evidence-validator.ts` | ID/evidence 验证器 |
| `packages/mcp/src/benchmark/variant-generator.ts` | 最小改动变体生成器 |
| `packages/mcp/src/benchmark/scorer.ts` | 100 分评分器 |
| `packages/mcp/src/benchmark/bootstrap.ts` | grouped-bootstrap CI 报告器 |
| `packages/mcp/src/benchmark/annotate-gold.ts` | 批量标注工具（init/validate/status/export） |
| `packages/mcp/src/benchmark/run-benchmark.ts` | Benchmark runner CLI |
| `packages/mcp/src/benchmark/index.ts` | 统一导出 |
| `packages/mcp/src/benchmark/smoke-gold.json` | 16+8 样本 smoke gold 模板 |
| `packages/mcp/src/benchmark/deck-list.example.json` | 卡组列表示例 |
| `.opencode/prompts/pre-game-analysis-pure.md` | `reasoning-pure` 赛道提示词模板 |
| `packages/mcp/docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md` | 设计规范文档 |
