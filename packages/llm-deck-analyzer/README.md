# @gi-tcg/llm-deck-analyzer

Deck analysis for Genius Invokation TCG — pure-data prompt generation + optional heuristic baseline + feature extraction.

## 功能

- 解析卡组代码，提取角色和卡牌信息（`deck-context.ts`）
- 生成纯数据 Prompt，供调用方 LLM 从零推理分析（`prompt-builder.ts`）
- 可选的启发式 baseline 分析，作为 LLM 修正的起点（`heuristics.ts`）
- 提供合并校验函数，用于将 LLM 增强结果与 baseline 合并
- 生成对局分析，预测 matchup 胜率并归一化结果
- 将分析结果转换为特征向量，供 evaluator 使用

## 架构说明

本包 **不再内部调用任何外部 LLM API**。所有 LLM 分析由调用方（skill / agent）负责。

### 推荐路径：纯数据 Prompt → LLM 从零推理

```
createDeckContext（纯数据）→ buildDeckAnalysisPrompt（纯数据提示）→ LLM 推理 → Zod 校验
```

- `createDeckContext` 只提取数据（角色技能、卡牌效果、费用、标签、衍生物、DSL 源码），不计算任何启发式中间产物
- Prompt 不包含 trigger chain / combo clock / zone pressure 等可能错误的先验
- LLM 直接从原始事实推理，避免被错误先验锚定

### 兼容路径：启发式 baseline + LLM 修正

```
createRichDeckContext（数据+启发式）→ buildLocalDeckAnalysis（baseline）→ buildDeckAnalysisPrompt(context, baseline) → LLM 修正 → mergeDeckAnalysis
```

- `createRichDeckContext` 在纯数据基础上附加启发式分析层（trigger chains、combo clock、zone pressure 等）
- Prompt 包含 baseline 段，LLM 可修正
- 适合需要 baseline 兜底的场景

## 安装

```bash
pnpm install
```

## 使用方法

### 1. 分析单个卡组（纯数据 prompt，slim 模式）

```bash
pnpm exec gnx src/cli/analyze-deck.ts
# 环境变量：DECK_CODE（必填）、DECK_NAME（可选）、DECK_VERSION（可选）
```

输出两段：
1. **Local Heuristic Analysis** — 启发式 baseline JSON（可选参考）
2. **LLM Analysis Prompt** — 纯数据提示文本（不含 baseline 段，LLM 从零推理）

### 2. 分析单个卡组（结构化纯数据上下文，rich 模式）

```bash
pnpm exec gnx src/cli/analyze-deck-rich.ts
# 环境变量：DECK_CODE（必填）、DECK_NAME（可选）、DECK_VERSION（可选）
```

输出 JSON：`{ deckCode, deckName, baseline, deckContext }`
- `baseline` — 启发式基线（可选参考）
- `deckContext` — 纯数据结构化上下文（characters / cards / entityDescriptions / generatedHandCards / summary）
- **不含 `analysis` 块**（triggerChains / comboClock / skillEfficiency 等启发式中间产物已移除）

### 3. 分析双方对局（纯数据 prompt）

```bash
pnpm exec gnx src/cli/analyze-matchup.ts <deckACode> <deckBCode>
```

输出启发式 matchup baseline + 纯数据 prompt（不含 baseline 段）。

### 4. 分析双方对局（结构化纯数据上下文）

```bash
pnpm exec gnx src/cli/analyze-matchup-rich.ts
# 环境变量：DECK_A、DECK_B（必填）、DECK_VERSION（可选）
```

输出 JSON：`{ deckA, deckB, baseline, deckAContext, deckBContext }`（双方纯数据上下文）。

### 4. 在代码中使用

#### 推荐路径：纯数据 Prompt → LLM 从零推理

```typescript
import {
  createDeckContext,
  buildDeckAnalysisPrompt,
  parseJsonAnalysisResult,
  DeckAnalysisSchema,
} from "@gi-tcg/llm-deck-analyzer"

// ====== 构建纯数据上下文 ======
const context = await createDeckContext(deckCode)

// ====== 生成纯数据 Prompt（不含启发式先验）======
const prompt = buildDeckAnalysisPrompt(context)
// 将 prompt 发送给调用方 LLM，由其从零推理

// ====== 校验 LLM 输出 ======
const enhancedResult = parseJsonAnalysisResult(llmResponseText)
const final = DeckAnalysisSchema.parse(enhancedResult)
```

#### 兼容路径：启发式 baseline + LLM 修正

```typescript
import {
  createRichDeckContext,
  buildLocalDeckAnalysis,
  buildDeckAnalysisPrompt,
  mergeDeckAnalysis,
  parseJsonAnalysisResult,
  DeckAnalyzer,
  extractDeckFeaturesV2,
  extractMatchupFeaturesV2,
} from "@gi-tcg/llm-deck-analyzer"

const analyzer = new DeckAnalyzer()

// ====== 本地启发式分析 ======
const analysis = await analyzer.analyzeDeck(deckCode, "My Deck")

// ====== 生成含 baseline 的 Prompt ======
const context = await createRichDeckContext(deckCode)
const baseline = buildLocalDeckAnalysis(context, "My Deck")
const prompt = buildDeckAnalysisPrompt(context, baseline)

// ====== 合并 LLM 增强结果 ======
const enhancedResult = parseJsonAnalysisResult(llmResponseText)
const merged = mergeDeckAnalysis(baseline, enhancedResult)

// ====== 对局分析 ======
const matchup = await analyzer.analyzeMatchup(deckA, deckB)

// ====== V2 分层特征 ======
const deckFeatures = await extractDeckFeaturesV2(deckCode)
const matchupFeatures = await extractMatchupFeaturesV2(deckA, deckB)
```

## 输出特征

### DeckFeatureVector

```typescript
{
  deckCode: string
  strength: number           // 0-1 卡组强度
  winConditionEncoded: number // 获胜方式编码
  keyCardCount: number       // 关键卡数量
  commonLineCount: number    // 常见展开路线数
  averageCardImportance: number
  earlyGameScore: number     // 前期评分
  midGameScore: number       // 中期评分
  lateGameScore: number      // 后期评分
  strengthScore: number      // 优势评分
  weaknessCount: number      // 劣势数量
}
```

### MatchupFeatureVector

```typescript
{
  deckA: string
  deckB: string
  advantageA: number         // A 的优势 (0-1)
  predictedWinRateA: number  // A 的预测胜率
  keyInteractionCount: number
}
```

## 行为说明

- 推荐路径使用 `createDeckContext` + `buildDeckAnalysisPrompt(context)`，Prompt 为纯数据，LLM 从零推理
- 兼容路径使用 `createRichDeckContext` + `buildDeckAnalysisPrompt(context, baseline)`，Prompt 含 baseline 段供 LLM 修正
- 调用方 LLM 产出的 JSON 可通过 `parseJsonAnalysisResult` 解析后用 `DeckAnalysisSchema.parse()` 校验，或传入 `mergeDeckAnalysis` 与 baseline 合并
- matchup 分析会保证 `predictedWinRates.deckA + predictedWinRates.deckB ≈ 1`
- V2 特征提取内部使用 `createRichDeckContext`，输出结构不变

## V2 Feature Protocol

- `extractDeckFeaturesV2()` 输出 `dense + sparse + actionCards + graph + labels + diagnostics`
- `extractMatchupFeaturesV2()` 输出完整交叉特征、桥接 graph 和 matchup labels
- 词表、类型与 schema 位于 `src/features/`
- 示例脚本：`bun run extract:features:v2`
- 自动生成的样例输出：`examples/features-v2.fixture.json`