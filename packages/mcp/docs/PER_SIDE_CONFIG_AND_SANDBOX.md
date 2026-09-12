# Per-Side 独立配置与沙箱卡组分析

> 批量 LLM 无头对战的 v2 配置体系，支持双方独立模型 / 提示词 / API 凭据，
> 以及对局前的隔离沙箱深度卡组分析。

## 目录

1. [概述](#概述)
2. [快速开始](#快速开始)
3. [v2 配置格式](#v2-配置格式)
4. [沙箱卡组分析](#沙箱卡组分析)
5. [运行时行为](#运行时行为)
6. [沙箱目录结构](#沙箱目录结构)
7. [回退机制](#回退机制)
8. [命令行参数](#命令行参数)
9. [代码结构](#代码结构)
10. [常见问题](#常见问题)

---

## 概述

### 问题

原 `run-batch-llm.ts` 通过 CLI 参数 `--model-p0` / `--model-p1` 设置双方模型，
`--system-prompt-p0` / `--system-prompt-p1` 设置提示词。API 凭据（base/key）全局共享。
开局卡组分析由 `llm-agent.ts` 的 `runOpeningPhase()` 自动执行：
调用 `analyze_deck` + `analyze_matchup` MCP 工具（底层 `createDeckContext`，纯数据层），
然后 `injectStrategyAnchor()` 将角色/卡牌/元素分布等基础信息注入 system prompt。

**不足：**

- 无法 per-matchup 独立配置模型、API 凭据、提示词。
- 卡组分析仅返回 `createDeckContext` 的纯数据结构（角色技能、卡牌效果、费用），
  不包含任何启发式推理（trigger chain、combo clock、zone pressure 等虽存在于
  `@gi-tcg/llm-deck-analyzer/heuristics` 但未接入 MCP 工具）。
- LLM 在对局中自行从纯数据推理策略，缺少结构化的深度分析辅助。

### 方案

引入两层增强：

1. **Per-side 配置**：在 `batch-llm-v2.json` 的每个 matchup 内，
   可通过 `p0` / `p1` 字段独立指定 model / apiBase / apiKey / systemPrompt /
   temperature / sandbox 配置。未指定的字段继承 CLI 全局默认值。

2. **沙箱卡组分析**：对局开始前（headless runner 启动之前），
   为 P0 和 P1 各自生成一个隔离沙箱目录。沙箱内：
   - 先用 `createDeckContext`（纯数据层）提取己方和对手的完整卡组数据。
   - 将数据交给 LLM，由 LLM 编写一个 TypeScript 分析脚本 `analysis.ts`。
     脚本可 `import` 来自 `@gi-tcg/llm-deck-analyzer` 的所有启发式函数
     （`createRichDeckContext`、`buildLocalDeckAnalysis`、`detectDeckCombos` 等）
     以及 `@gi-tcg/data` 的卡牌定义源码。
   - 通过 `gnx` 运行脚本，捕获 stdout 作为 `strategy.json`。
   - 对局 Agent 启动时加载 `strategy.json`，注入 system prompt，
     替代原有的 `injectStrategyAnchor` 浅层分析。

   **隔离保证**：P0 沙箱目录仅传入 P0 Agent 的 `--sandbox-dir` 参数，
   P1 同理。双方无法访问对方的沙箱目录或分析结果。

---

## 快速开始

### 最简用法（启用沙箱）

```powershell
# run-match.ps1 已默认启用 v2 配置 + 沙箱
.\run-match.ps1
```

`run-match.ps1` 内部调用：
```powershell
& "$PSScriptRoot\.opencode\run-batch-llm.ps1" `
  -ModelP0 "deepseek-v4-flash" `
  -ModelP1 "deepseek-v4-flash" `
  -SandboxEnabled 1
```

### 双方不同模型 + 沙箱

```powershell
.\.opencode\run-batch-llm.ps1 `
  -ModelP0 "glm-5" `
  -ModelP1 "deepseek-v4-flash" `
  -SandboxEnabled 1 `
  -SandboxModel "glm-5"
```

### 不启用沙箱（仅 per-side 配置）

```powershell
.\.opencode\run-batch-llm.ps1 `
  -Config ".opencode/batch-llm-v2.json" `
  -SandboxEnabled 0
```

此时 matchup 中的 `p0.sandbox.enabled` / `p1.sandbox.enabled` 也会被覆盖为 `false`。

---

## v2 配置格式

配置文件默认路径：`.opencode/batch-llm-v2.json`

### 完整字段示例

```jsonc
{
  "version": "2.0",
  "matchups": [
    {
      "id": "shuiba-mirror",
      "deck0Name": "水八",
      "deck1Name": "水八",
      "deck0": "A0BQ9CEPA1Bw...",
      "deck1": "A0BQ9CEPA1Bw...",
      "deck0Version": "v5.5.0",
      "deck1Version": "v5.5.0",
      "games": 5,
      "p0": {
        "model": "glm-5",
        "apiBase": "https://api-a.example.com/v1",
        "apiKey": "sk-aaa",
        "systemPrompt": ".opencode/prompts/p0-start.md",
        "temperature": 0.2,
        "sandbox": {
          "enabled": true,
          "model": "glm-5",
          "apiBase": "https://api-a.example.com/v1",
          "apiKey": "sk-aaa",
          "promptTemplate": ".opencode/prompts/sandbox-analysis-gen.md",
          "temperature": 0.4,
          "maxTokens": 8192
        }
      },
      "p1": {
        "model": "deepseek-v4-flash",
        "apiBase": "https://api-b.example.com/v1",
        "apiKey": "sk-bbb",
        "systemPrompt": ".opencode/prompts/p1-start.md",
        "temperature": 0.3,
        "sandbox": {
          "enabled": true,
          "model": "deepseek-v4-flash",
          "apiBase": "https://api-b.example.com/v1",
          "apiKey": "sk-bbb",
          "promptTemplate": ".opencode/prompts/sandbox-analysis-gen.md",
          "temperature": 0.5,
          "maxTokens": 8192
        }
      }
    }
  ]
}
```

### 字段说明

| 层级 | 字段 | 类型 | 说明 |
|------|------|------|------|
| matchup | `id` | string | 对局标识 |
| matchup | `deck0` / `deck1` | string | 双方卡组代码（Base64） |
| matchup | `deck0Version` / `deck1Version` | string? | 卡牌数据与 headless 对局规则版本；省略时使用当前版本。历史对局必须同时提供两个字段，且值相同。 |
| matchup | `deck0Name` / `deck1Name` | string? | 卡组名称（用于日志/摘要） |
| matchup | `games` | number | 对局场数 |
| matchup | `p0` / `p1` | object? | per-side 配置，省略则使用 CLI 全局默认 |
| side | `model` | string? | 对局使用的 LLM 模型名 |
| side | `apiBase` | string? | API base URL |
| side | `apiKey` | string? | API key |
| side | `systemPrompt` | string? | system prompt 文件路径 |
| side | `temperature` | number? | 采样温度（默认 0.2） |
| side | `sandbox` | object? | 沙箱配置 |
| sandbox | `enabled` | boolean? | 是否启用（默认继承 CLI `-SandboxEnabled`） |
| sandbox | `model` | string? | 生成分析脚本使用的模型（默认继承对局 model） |
| sandbox | `apiBase` | string? | 沙箱 LLM API base（默认继承对局 apiBase） |
| sandbox | `apiKey` | string? | 沙箱 LLM API key（默认继承对局 apiKey） |
| sandbox | `promptTemplate` | string? | 提示词模板路径 |
| sandbox | `temperature` | number? | 沙箱生成温度（默认 0.4） |
| sandbox | `maxTokens` | number? | 最大 token 数（默认 8192） |

### 配置优先级

```
CLI 参数（全局默认）
  └─ batch-llm-v2.json matchup.p0 / matchup.p1（覆盖全局）
       └─ matchup.p0.sandbox / matchup.p1.sandbox（沙箱专用覆盖）
```

如果 matchup 中省略 `p0` / `p1`，则使用 CLI 参数（`-ModelP0`、`-ApiBase` 等）。
如果 `sandbox` 中省略 `model`，则继承对局 `model`。同理 `apiBase` / `apiKey`。

---

## 沙箱卡组分析

### 流程

```
对局开始前（headless runner 启动前）
  │
  ├── P0 Sandbox                              P1 Sandbox
  │   │                                         │
  │   ├─ createDeckContext(deck0)               ├─ createDeckContext(deck1)
  │   │  -> my_deck_data.json                  │   │  -> my_deck_data.json
  │   │                                         │   │
  │   ├─ createDeckContext(deck1)               ├─ createDeckContext(deck0)
  │   │  -> opp_deck_data.json                 │   │  -> opp_deck_data.json
  │   │                                         │   │
  │   ├─ LLM 读取数据 + 提示词模板               ├─ LLM 读取数据 + 提示词模板
  │   │  -> 生成 analysis.ts                   │   │  -> 生成 analysis.ts
  │   │                                         │   │
  │   ├─ gnx 运行 analysis.ts                   ├─ gnx 运行 analysis.ts
  │   │  -> stdout = strategy.json             │   │  -> stdout = strategy.json
  │   │                                         │   │
  │   └─ 保存 strategy.json                     └─ 保存 strategy.json
  │
  （P0 / P1 并行执行，互不可见）
  │
  对局开始
  ├── Agent P0 --sandbox-dir=sandbox/p0/
  │   └─ tryLoadSandboxStrategy() -> 注入 system prompt
  │       （失败则回退到 analyze_deck + injectStrategyAnchor）
  │
  └── Agent P1 --sandbox-dir=sandbox/p1/
      └─ tryLoadSandboxStrategy() -> 注入 system prompt
          （失败则回退到 analyze_deck + injectStrategyAnchor）
```

### LLM 生成的 analysis.ts

沙箱生成器将己方和对手的完整卡组数据（角色技能、卡牌效果、费用、衍生物、统计摘要）
嵌入提示词模板 `sandbox-analysis-gen.md`，发送给 LLM。

LLM 输出一个 TypeScript ES Module，约定如下：

- 从环境变量 `process.env.MY_DECK_CODE` / `process.env.OPP_DECK_CODE` 获取卡组代码；
  `process.env.MY_DECK_VERSION` / `process.env.OPP_DECK_VERSION` 是对应卡组数据版本（空字符串表示当前版本）。
- 可使用以下导入：

```typescript
// 纯数据层
import { createDeckContext } from "@gi-tcg/llm-deck-analyzer"
// 启发式层（trigger chains, combo clock, zone pressure, effective costs 等）
import {
  createRichDeckContext,
  buildLocalDeckAnalysis,
  buildLocalMatchupAnalysis,
  createMatchupContext,
} from "@gi-tcg/llm-deck-analyzer"
// 增强分析函数
import {
  detectStateDependencies,
  computeAllEffectiveCosts,
  estimateDrawExpectation,
  estimateComboClock,
  detectResourceCycles,
  analyzeZonePressure,
  computeSkillEfficiency,
} from "@gi-tcg/llm-deck-analyzer"
// combo/trigger 检测
import { detectDeckCombos, detectTriggerChainEdges, buildTriggerChains } from "@gi-tcg/llm-deck-analyzer"
// AssetsManager（使用历史版本时：new AssetsManager({ version })）
import { AssetsManager, DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
// Node.js 内置
import { readFileSync, writeFileSync } from "node:fs"
```

- 将分析结果 JSON 输出到 **stdout**（仅 JSON，不含其他文本）。
- 调试信息用 `console.error()` 输出到 stderr。
- 禁止使用 `fetch`、`require`、`child_process` 或任何网络/进程操作。

### strategy.json 输出格式

LLM 生成的脚本应输出以下结构的 JSON（字段全部可选，Agent 端做容错处理）：

```json
{
  "archetype": "快攻 | 站场 | 控制 | 组合技 等",
  "winCondition": "胜利条件描述",
  "keyCards": ["关键卡牌1", "关键卡牌2"],
  "comboChains": [
    {
      "name": "combo名称",
      "steps": ["步骤1", "步骤2"],
      "condition": "触发条件"
    }
  ],
  "resourceCurve": {
    "earlyGame": "前3回合资源策略",
    "midGame": "中期资源策略",
    "lateGame": "后期资源策略"
  },
  "matchupStrategy": {
    "myAdvantage": "我方优势点",
    "opponentThreat": "对手威胁点",
    "gamePlan": "整体对局计划"
  },
  "openingPriorities": {
    "activeCharacter": "推荐首发角色及理由",
    "mulliganKeep": ["优先保留的卡牌"],
    "mulliganDiscard": ["优先替换的卡牌类型"],
    "rerollStrategy": "骰子重投策略"
  },
  "turnByTurnPlan": [
    {
      "turn": 1,
      "goal": "目标",
      "priorityActions": ["优先操作"]
    }
  ],
  "riskManagement": {
    "lethalThresholds": "斩杀线提醒",
    "resourceReserves": "需保留的关键资源",
    "defensivePriorities": "防守优先级"
  },
  "customAnalysis": "任何其他有价值的信息"
}
```

### 提示词模板

模板文件：`.opencode/prompts/sandbox-analysis-gen.md`

模板中使用两个占位符：
- `{myDeckData}` — 己方卡组纯数据 JSON（运行时替换）
- `{oppDeckData}` — 对手卡组纯数据 JSON（运行时替换）

---

## 运行时行为

### 沙箱生成阶段

1. **时机**：在 `runSingleGame()` 中，headless runner 启动**之前**。
   不需要端口，纯本地 + LLM 调用。
2. **并行**：P0 和 P1 沙箱通过 `Promise.allSettled` 并行生成。
3. **重试**：单侧最多重试 3 次。如果脚本编译/运行失败或 stdout
   无法解析为 JSON，会将错误信息反馈给 LLM 要求修复后重新生成。
4. **超时**：脚本运行超时 120 秒后 kill。
5. **日志**：所有 LLM 请求/响应/脚本运行结果记录到
   `sandbox/{side}/generation_log.jsonl`。
6. **失败处理**：沙箱生成失败不影响对局，Agent 自动回退到原有分析逻辑。

### Agent 加载阶段

1. `llm-agent.ts` 的 `runOpeningPhase()` 首先调用 `tryLoadSandboxStrategy()`。
2. 如果 `--sandbox-dir` 已设置且 `strategy.json` 存在：
   - 读取 JSON，将各字段格式化为文本块。
   - 追加到 system prompt 末尾，标记为 `## 卡组策略锚点 (沙箱深度分析)`。
   - 跳过原有的 `analyze_deck` / `analyze_matchup` / `injectStrategyAnchor` 调用。
3. 如果沙箱未启用或 `strategy.json` 不存在：
   - 执行原有逻辑（`analyze_deck` -> `analyze_matchup` -> `injectStrategyAnchor`）。
4. 后续开局流程（switchHands / chooseActive / rerollDice）不受影响。

---

## 沙箱目录结构

每局对局的沙箱目录位于游戏输出目录下：

```
.opencode/tmp/batch-results/run_<timestamp>/<matchup_id>_game<n>/sandbox/
  p0/
    my_deck_data.json       # 己方卡组纯数据（createDeckContext 输出，含 version）
    opp_deck_data.json      # 对手卡组纯数据
    analysis.ts             # LLM 生成的 TypeScript 分析脚本
    strategy.json            # 脚本运行输出的策略 JSON
    generation_log.jsonl     # 沙箱生成阶段的 LLM 对话日志
  p1/
    my_deck_data.json       # 己方卡组纯数据（对 P1 来说是 deck1）
    opp_deck_data.json      # 对手卡组纯数据（对 P1 来说是 deck0）
    analysis.ts
    strategy.json
    generation_log.jsonl
```

**隔离保证：**
- Orchestrator 只将 `sandbox/p0/` 路径传入 P0 Agent 的 `--sandbox-dir` 参数。
- P1 Agent 只收到 `sandbox/p1/` 路径。
- 两个 Agent 进程的 `env` 和 CLI 参数中不包含对方沙箱路径。
- 沙箱目录在运行后保留，供复盘分析使用。

---

## 回退机制

当沙箱生成失败或 Agent 无法加载沙箱策略时，自动回退到原有分析路径：

```
tryLoadSandboxStrategy() 返回 false
  ↓
执行原有 runOpeningPhase 逻辑：
  1. get_player0_deck / get_player1_deck (通过 MCP HTTP)
  2. analyze_deck (己方 + 对手)
  3. analyze_matchup (双方对局分析)
  4. injectStrategyAnchor() (注入角色/卡牌/元素分布等基础信息)
```

回退场景包括：
- `--sandbox-dir` 未设置
- `strategy.json` 文件不存在（沙箱生成失败）
- `strategy.json` JSON 解析失败

---

## 命令行参数

### run-batch-llm.ps1 新增参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `-Config` | string | `.opencode/batch-llm-v2.json` | v2 配置文件路径 |
| `-SandboxEnabled` | int | `0` | 全局沙箱开关（`1`=启用, `0`=禁用） |
| `-SandboxModel` | string | `""` | 沙箱生成使用的模型（空则继承对局模型） |
| `-SandboxPromptTemplate` | string | `.opencode/prompts/sandbox-analysis-gen.md` | 沙箱提示词模板路径 |
| `-SandboxTemperature` | double | `0.4` | 沙箱生成温度 |
| `-SandboxMaxTokens` | int | `8192` | 沙箱生成最大 token 数 |

### 原有参数（不变）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `-ModelP0` / `-ModelP1` | string | `deepseek-v4-flash` | 双方对局模型 |
| `-ApiBase` / `-ApiKey` | string | env | 全局 API 凭据 |
| `-Concurrency` | int | `4` | 并发对局数 |
| `-BasePort` | int | `3901` | 起始端口 |
| `-ToolExposureMode` | `direct-action` \| `fragmented-decision` | `direct-action` | 工具暴露模式 |
| `-StartOffset` / `-GameCount` | int | `0` | 对局切片 |

### 典型用法

```powershell
# 双方同模型 + 沙箱
.\.opencode\run-batch-llm.ps1 -SandboxEnabled 1

# 双方不同模型，沙箱也用各自模型
.\.opencode\run-batch-llm.ps1 `
  -ModelP0 "glm-5" -ModelP1 "deepseek-v4-flash" `
  -SandboxEnabled 1

# 禁用沙箱，仅 per-side 配置
.\.opencode\run-batch-llm.ps1 -SandboxEnabled 0

# 跑特定 matchup 的前 3 局
.\.opencode\run-batch-llm.ps1 -SandboxEnabled 1 -StartOffset 0 -GameCount 3
```

---

## 代码结构

### 新增文件

| 文件 | 说明 |
|------|------|
| `packages/mcp/src/headless/sandbox-generator.ts` | 沙箱生成器核心逻辑 |
| `.opencode/prompts/sandbox-analysis-gen.md` | 沙箱分析脚本生成提示词模板 |
| `.opencode/batch-llm-v2.json` | v2 配置格式示例 |

### 修改文件

| 文件 | 关键变更 |
|------|---------|
| `packages/mcp/src/headless/llm-agent.ts` | 新增 `--sandbox-dir` CLI 参数；`runOpeningPhase()` 优先调用 `tryLoadSandboxStrategy()`，失败回退原有逻辑 |
| `packages/mcp/src/headless/run-batch-llm.ts` | 新增 `ResolvedSideConfig` / `SideMatchupConfig` / `SandboxMatchupConfig` 类型；`resolveSideConfig()` 合并 per-side 配置与全局默认；`expandMatchups()` 为每个 GameTask 解析双方配置；`runSingleGame()` 在 headless runner 前并行生成沙箱；`spawnLlmAgent()` 使用 per-side 配置 + sandbox dir |
| `.opencode/run-batch-llm.ps1` | 默认配置改为 v2；新增沙箱相关参数 |
| `run-match.ps1` | 使用 v2 配置 + `-SandboxEnabled 1` |

### sandbox-generator.ts API

```typescript
// 核心函数：为单方生成沙箱
export async function generateSandbox(
  who: 0 | 1,
  myDeckCode: string,
  myDeckVersion: string | undefined,
  oppDeckCode: string,
  oppDeckVersion: string | undefined,
  config: SandboxLlmConfig,
  sandboxDir: string,
  projectDir: string,
  logCallback?: (msg: string) => void,
): Promise<SandboxResult>

// 并行生成双方沙箱
export async function generateBothSandboxes(
  deck0Code: string,
  deck1Code: string,
  deck0Version: string | undefined,
  deck1Version: string | undefined,
  p0Config: SandboxLlmConfig,
  p1Config: SandboxLlmConfig,
  sandboxBaseDir: string,
  projectDir: string,
  logCallback?: (who: 0 | 1, msg: string) => void,
): Promise<DualSandboxResult>
```

### 类型定义

```typescript
interface SandboxLlmConfig {
  model: string;
  apiBase: string;
  apiKey: string;
  promptTemplate: string;
  temperature: number;
  maxTokens: number;
}

interface SandboxConfig {
  enabled: boolean;
  llm: SandboxLlmConfig;
}

interface SandboxResult {
  sandboxDir: string;
  strategyPath: string;
  scriptPath: string;
  success: boolean;
  error?: string;
}

interface ResolvedSideConfig {
  model: string;
  apiBase: string;
  apiKey: string;
  systemPrompt: string;
  temperature: number;
  sandbox: {
    enabled: boolean;
    llm: SandboxLlmConfig;
  };
}
```

---

## 常见问题

### 沙箱生成失败怎么办？

沙箱生成失败不影响对局。Agent 检测到 `strategy.json` 不存在时，
自动回退到原有 `analyze_deck` + `injectStrategyAnchor` 逻辑。
日志中会输出警告信息：`P0 sandbox failed: <error> (falling back to legacy)`。

### 沙箱生成的 LLM 调用费用如何控制？

每局对局（如果沙箱启用）会额外发起 1-3 次 LLM 调用（生成脚本 + 可能的重试）。
可通过 `-SandboxMaxTokens` 控制单次调用的最大 token 数。
如果 matchup 中某方不需要沙箱，设置 `"sandbox": { "enabled": false }` 即可。

### 沙箱脚本可以访问网络吗？

不可以。脚本通过 `gnx` 在项目目录中运行，但提示词约束中明确禁止
`fetch`、`require`、`child_process` 等操作。脚本只能使用标准库
（`fs`、`path`、`util` 等）和 `@gi-tcg/llm-deck-analyzer` / `@gi-tcg/assets-manager`
等项目内包。

### 沙箱目录会自动清理吗？

不会。沙箱目录与对局日志一起保存在输出目录中，供复盘分析使用。
如需清理，手动删除 `.opencode/tmp/batch-results/` 下对应的 `run_*` 目录即可。

### 如何调试沙箱生成的脚本？

查看沙箱目录中的文件：
- `generation_log.jsonl` — LLM 的完整请求/响应记录
- `analysis.ts` — LLM 生成的脚本源码
- `my_deck_data.json` / `opp_deck_data.json` — 输入数据

手动运行脚本：
```bash
MY_DECK_CODE="<deck_code>" OPP_DECK_CODE="<opp_code>" \
  pnpm exec gnx <sandbox_dir>/analysis.ts
```

### v1 配置（batch-llm.json）还能用吗？

可以。将 `-Config` 指向 `.opencode/batch-llm.json` 即可。
v1 配置中的 matchup 没有 `p0` / `p1` 字段，所有配置使用 CLI 全局默认值。
但建议迁移到 v2 格式以获得 per-side 配置能力。
