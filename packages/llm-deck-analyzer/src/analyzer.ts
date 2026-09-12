// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { DEFAULT_ASSETS_MANAGER, type AssetsManager } from "@gi-tcg/assets-manager"
import type {
  DeckAnalysis,
  MatchupAnalysis,
  DeckFeatureVector,
  MatchupFeatureVector,
} from "./types"
import { DeckAnalysisSchema, MatchupAnalysisSchema } from "./types"
import {
  buildLocalDeckAnalysis,
  buildLocalMatchupAnalysis,
  createRichDeckContext,
  createMatchupContext,
} from "./heuristics"
import type { DeckContext } from "./deck-context"
import { buildDeckPromptContext } from "./prompt-builder"

export interface ParsedDeck {
  characters: string[]
  cards: string[]
  deckCode: string
}

export function decodeDeck(deckCode: string, manager: AssetsManager = DEFAULT_ASSETS_MANAGER): ParsedDeck {
  const decoded = manager.decode(deckCode) as {
    characters: number[]
    cards: number[]
  }

  const characters = decoded.characters.map(
    (id) => manager.getNameSync(id) ?? `Character-${id}`,
  )
  const cards = decoded.cards
    .filter((id) => id !== 0)
    .map((id) => manager.getNameSync(id) ?? `Card-${id}`)

  return {
    characters,
    cards,
    deckCode,
  }
}

export function formatDeckForLLM(deck: ParsedDeck): string {
  const charList = deck.characters.map((character) => `  - ${character}`).join("\n")
  const cards = groupCards(deck.cards)
  const cardList = Object.entries(cards)
    .map(([group, cardNames]) => `  ${group}: ${cardNames.join("、")}`)
    .join("\n")

  return `# 卡组信息

## 角色
${charList}

## 卡牌
${cardList}

## 卡牌统计
- 总卡牌数: ${deck.cards.length}
- 角色数: ${deck.characters.length}`
}

export class DeckAnalyzer {
  private readonly cache = new Map<string, DeckAnalysis>()
  private readonly matchupCache = new Map<string, MatchupAnalysis>()
  private readonly manager: AssetsManager

  constructor(manager: AssetsManager = DEFAULT_ASSETS_MANAGER) {
    this.manager = manager
  }

  async analyzeDeck(deckCode: string, deckName?: string): Promise<DeckAnalysis> {
    if (this.cache.has(deckCode)) {
      const cached = this.cache.get(deckCode)!
      return deckName === undefined ? cached : { ...cached, deckName }
    }

    const context = await createRichDeckContext(deckCode, this.manager)
    const analysis = buildLocalDeckAnalysis(context, deckName)
    this.cache.set(deckCode, analysis)
    return analysis
  }

  async analyzeMatchup(deckACode: string, deckBCode: string): Promise<MatchupAnalysis> {
    const key = `${deckACode}:${deckBCode}`
    if (this.matchupCache.has(key)) {
      return this.matchupCache.get(key)!
    }

    const deckAContext = await createRichDeckContext(deckACode, this.manager)
    const deckBContext = await createRichDeckContext(deckBCode, this.manager)
    const analysis = buildLocalMatchupAnalysis(
      createMatchupContext(deckAContext, deckBContext),
      buildLocalDeckAnalysis(deckAContext, "Deck A"),
      buildLocalDeckAnalysis(deckBContext, "Deck B"),
    )
    this.matchupCache.set(key, analysis)
    return analysis
  }

  toFeatureVector(analysis: DeckAnalysis): DeckFeatureVector {
    return {
      deckCode: analysis.deckCode,
      strength: analysis.strength / 10,
      winConditionEncoded: encodeWinCondition(analysis.winCondition),
      keyCardCount: analysis.keyCards.length,
      commonLineCount: analysis.commonLines.length,
      averageCardImportance:
        analysis.keyCards.reduce((sum, card) => sum + card.importance, 0) /
        Math.max(analysis.keyCards.length, 1) /
        10,
      earlyGameScore: scoreGamePlan(analysis.gamePlan.earlyGame),
      midGameScore: scoreGamePlan(analysis.gamePlan.midGame),
      lateGameScore: scoreGamePlan(analysis.gamePlan.lateGame),
      strengthScore: Math.min(analysis.strengths.length / 5, 1),
      weaknessCount: analysis.weaknesses.length,
    }
  }

  toMatchupFeatureVector(analysis: MatchupAnalysis): MatchupFeatureVector {
    return {
      deckA: analysis.deckA,
      deckB: analysis.deckB,
      advantageA: (analysis.advantage.deckA + 10) / 20,
      predictedWinRateA: analysis.predictedWinRates.deckA,
      keyInteractionCount: analysis.keyInteractions.length,
    }
  }

  clearCache(): void {
    this.cache.clear()
    this.matchupCache.clear()
  }
}

export function buildDeckAnalysisPrompt(context: DeckContext, baseline?: DeckAnalysis): string {
  const baselineSection = baseline
    ? `\n\n基础规则分析（可修正，但不要脱离卡组信息臆造）:\n${JSON.stringify(baseline, null, 2)}`
    : ""

  return `你是一个原神七圣召唤 TCG 专家。请基于给定卡组信息，产出精炼、可信且可执行的结构化分析。

卡组原始信息:
${buildDeckPromptContext(context)}${baselineSection}

请只返回合法 JSON，并严格遵循以下要求:
1. deckCode 必须保持为 "${baseline?.deckCode ?? context.deckCode}"
2. deckName 必须保持为 "${baseline?.deckName ?? ""}"
3. characters 必须保持为 ${JSON.stringify(baseline?.characters ?? context.characterNames)}
4. archetype 必须从以下词汇中选择: aggro / control / combo / midrange / support_engine / tempo
   注意：不要因为卡组有支援牌就盲目选 support_engine——如果卡组的核心制胜手段是爆发/压制而非资源运营，应选对应的 archetype。
5. planProfile 必须给出五个维度 0-1 之间的数值:
   - setupSpeed: 多快能完成初始布局 (0=慢速铺场, 1=首回合即成型)
   - tempoPush: 对节奏压制的依赖度 (0=被动防守, 1=全程压制抢血)
   - longGameValue: 拖到后期的价值 (0=越拖越弱, 1=越拖越强)
   - defensiveStability: 防守韧性 (0=玻璃大炮, 1=铁壁)
   - finisherDensity: 终结手段密度 (0=缺乏斩杀, 1=多套斩杀)
6. strength 取值范围 0-10
7. 不要编造卡牌、角色或不存在的展开
8. strengths / weaknesses / keyCards / commonLines 要具体，避免空数组，除非确实无法判断

【卡牌效果准确性约束——严格遵守】:
9. keyCards 和 commonLines 中对卡牌效果的描述，必须以上方"卡牌效果"区域提供的官方描述为准。不得凭记忆编造或猜测卡牌效果。
10. 如果某张卡牌的效果在"卡牌效果"区域未提供，不得对其效果做任何具体断言——只可描述其在卡组中的角色（如"资源牌""过牌牌"），不可编造效果细节。
11. 特别注意区分容易混淆的卡牌：例如"星天之兆"是使出战角色获得1点充能的事件牌，不是任何角色的天赋牌；"本大爷还没有输！"的触发条件是我方角色被击倒，不是角色血量低。

【数值约束——严格遵守】:
12. commonLines 中的 winRateImpact 不要编造具体数值，设为 0 即可。
13. 不要在 keyCards 的 importance 中使用极端值（0-3 或 9-10），应集中在 5-8 区间。
14. winCondition、gamePlan、strengths、weaknesses、matchupNotes 中的描述应使用定性语言，不要出现任何胜率数字或百分比。

JSON schema:
${deckSchemaExample(baseline)}`
}

export function buildMatchupAnalysisPrompt(
  deckAContext: DeckContext,
  deckBContext: DeckContext,
  deckAAnalysis?: DeckAnalysis,
  deckBAnalysis?: DeckAnalysis,
  baseline?: MatchupAnalysis,
): string {
  const analysisASection = deckAAnalysis
    ? `\n卡组 A 基础分析:\n${JSON.stringify(deckAAnalysis, null, 2)}\n`
    : ""
  const analysisBSection = deckBAnalysis
    ? `\n卡组 B 基础分析:\n${JSON.stringify(deckBAnalysis, null, 2)}\n`
    : ""
  const baselineSection = baseline
    ? `\n基础 matchup 分析（可修正，但不要脱离卡组信息臆造）:\n${JSON.stringify(baseline, null, 2)}`
    : ""

  return `你是一个原神七圣召唤 TCG 对局分析师。请基于两边卡组信息，评估双方对局。

卡组 A:
${buildDeckPromptContext(deckAContext)}

卡组 B:
${buildDeckPromptContext(deckBContext)}
${analysisASection}${analysisBSection}${baselineSection}

请只返回合法 JSON，并满足:
1. deckA 必须保持为 "${baseline?.deckA ?? deckAContext.deckCode}"
2. deckB 必须保持为 "${baseline?.deckB ?? deckBContext.deckCode}"
3. advantage.deckA 与 advantage.deckB 应接近相反数
4. predictedWinRates.deckA + predictedWinRates.deckB 必须约等于 1
5. keyInteractions 必须只引用两边实际出现的角色或卡牌

【卡牌效果准确性约束——严格遵守】:
6. 对卡牌效果的描述，必须以卡组信息中"卡牌效果"区域提供的官方描述为准，不得凭记忆编造或猜测。
7. 如果某张卡牌的效果在卡组信息中未提供，不得对其效果做任何具体断言，只可描述其在卡组中的角色。
8. 特别注意区分容易混淆的卡牌：例如"星天之兆"是使出战角色获得1点充能的事件牌，不是任何角色的天赋牌；"本大爷还没有输！"的触发条件是我方角色被击倒，不是角色血量低。

【数值约束——严格遵守】:
9. predictedWinRates 不要编造精确胜率数字。如果缺乏确凿数据支撑，应倾向将双方胜率设为接近 0.5（如 0.50/0.50 或 0.52/0.48），而非暗示高置信度。
10. strategy 中的描述应使用定性语言（如"偏优势""略劣""均势"），不要出现具体胜率百分比。
11. advantage 分值应反映相对优势方向而非精确量化，缺乏数据时取值应在 -2 到 2 之间。

JSON schema:
${matchupSchemaExample(baseline)}`
}

export function mergeDeckAnalysis(baseline: DeckAnalysis, candidate: DeckAnalysis): DeckAnalysis {
  return DeckAnalysisSchema.parse({
    ...baseline,
    ...candidate,
    deckCode: baseline.deckCode,
    deckName: baseline.deckName,
    characters: baseline.characters,
    archetype: candidate.archetype ?? baseline.archetype,
    planProfile: candidate.planProfile ?? baseline.planProfile,
    keyCards: uniqueByName(candidate.keyCards, baseline.keyCards).slice(0, 8),
    strengths: uniqueStrings(candidate.strengths, baseline.strengths).slice(0, 6),
    weaknesses: uniqueStrings(candidate.weaknesses, baseline.weaknesses).slice(0, 6),
    commonLines: uniqueLines(candidate.commonLines, baseline.commonLines).slice(0, 5),
  })
}

export function mergeMatchupAnalysis(
  baseline: MatchupAnalysis,
  candidate: MatchupAnalysis,
  deckACode: string,
  deckBCode: string,
): MatchupAnalysis {
  const winRateA = clamp01(candidate.predictedWinRates.deckA)
  const winRateB = clamp01(1 - winRateA)
  const advantageA = Math.max(-10, Math.min(10, candidate.advantage.deckA))

  return MatchupAnalysisSchema.parse({
    ...baseline,
    ...candidate,
    deckA: deckACode,
    deckB: deckBCode,
    advantage: {
      ...candidate.advantage,
      deckA: advantageA,
      deckB: -advantageA,
    },
    keyInteractions: uniqueInteractions(candidate.keyInteractions, baseline.keyInteractions).slice(
      0,
      6,
    ),
    predictedWinRates: {
      deckA: winRateA,
      deckB: winRateB,
    },
  })
}

export function parseJsonAnalysisResult(content: string): unknown {
  let text = content.trim()

  // Strip markdown code fences
  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()

  // DeepSeek v4 / reasoning models may prefix with Chinese prose.
  // Extract from first '{' to last '}' for valid JSON.
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1)
  }

  return JSON.parse(text)
}

function encodeWinCondition(condition: string): number {
  const keywords: Record<string, number> = {
    速攻: 0.85,
    爆发: 0.9,
    站场: 0.65,
    召唤: 0.55,
    反应: 0.7,
    控制: 0.45,
    资源: 0.35,
    消耗: 0.4,
  }

  for (const [keyword, value] of Object.entries(keywords)) {
    if (condition.includes(keyword)) {
      return value
    }
  }

  return 0.5
}

function scoreGamePlan(plan: string): number {
  const keywords = ["启动", "铺场", "资源", "压制", "切人", "终结", "爆发", "站场"]
  const matched = keywords.filter((keyword) => plan.includes(keyword)).length
  return Math.min(0.25 + matched * 0.12 + Math.min(plan.length / 120, 0.35), 1)
}

function groupCards(cards: string[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {
    装备: [],
    事件: [],
    支援: [],
  }

  for (const card of cards) {
    if (card.includes("之赐") || card.includes("之冠") || card.includes("耳环")) {
      grouped.装备.push(card)
      continue
    }
    if (card.includes("伙伴") || card.includes("白垩") || card.includes("运筹")) {
      grouped.事件.push(card)
      continue
    }
    grouped.支援.push(card)
  }

  return Object.fromEntries(Object.entries(grouped).filter(([, value]) => value.length > 0))
}

function deckSchemaExample(baseline?: DeckAnalysis): string {
  return JSON.stringify(
    {
      deckCode: baseline?.deckCode ?? "<deckCode>",
      deckName: baseline?.deckName ?? "",
      characters: baseline?.characters ?? ["角色1", "角色2", "角色3"],
      archetype: "midrange",
      planProfile: {
        setupSpeed: 0.5,
        tempoPush: 0.5,
        longGameValue: 0.6,
        defensiveStability: 0.5,
        finisherDensity: 0.5,
      },
      strength: 7.5,
      winCondition: "通过站场输出与元素反应滚动资源后完成终结",
      gamePlan: {
        earlyGame: "前期先完成资源启动与站场角色铺垫",
        midGame: "中期围绕关键角色和功能牌持续压制",
        lateGame: "后期依靠爆发回合或资源差完成终结",
      },
      keyCards: [
        {
          name: baseline?.keyCards[0]?.name || "示例卡牌",
          importance: 8,
          usage: "说明它在启动、资源或终结中的作用",
        },
      ],
      commonLines: [
        {
          sequence: ["动作 1", "动作 2", "动作 3"],
          description: "一条常见展开路线",
          winRateImpact: 0.15,
        },
      ],
      strengths: ["优势 1", "优势 2"],
      weaknesses: ["劣势 1", "劣势 2"],
      matchupNotes: {
        快攻: "如何应对快攻",
      },
    },
    null,
    2,
  )
}

function matchupSchemaExample(baseline?: MatchupAnalysis): string {
  return JSON.stringify(
    {
      deckA: baseline?.deckA ?? "<deckACode>",
      deckB: baseline?.deckB ?? "<deckBCode>",
      advantage: {
        deckA: 2,
        deckB: -2,
        reason: "A 在节奏或资源上略优，但不是绝对压制",
      },
      keyInteractions: [
        {
          cardA: "A 的关键牌",
          cardB: "B 的关键牌",
          impact: "说明这组互动如何影响节奏或终结",
        },
      ],
      strategy: {
        deckAPlaying: "A 的对局思路",
        deckBPlaying: "B 的对局思路",
      },
      predictedWinRates: {
        deckA: 0.56,
        deckB: 0.44,
      },
    },
    null,
    2,
  )
}

function uniqueStrings(primary: string[], fallback: string[]): string[] {
  return [...new Set([...primary, ...fallback].map((item) => item.trim()).filter(Boolean))]
}

function uniqueByName<
  T extends {
    name: string
  },
>(primary: T[], fallback: T[]): T[] {
  const merged = [...primary, ...fallback]
  const seen = new Set<string>()
  const result: T[] = []

  for (const item of merged) {
    if (!item.name || seen.has(item.name)) {
      continue
    }
    seen.add(item.name)
    result.push(item)
  }

  return result
}

function uniqueLines(
  primary: DeckAnalysis["commonLines"],
  fallback: DeckAnalysis["commonLines"],
): DeckAnalysis["commonLines"] {
  const merged = [...primary, ...fallback]
  const seen = new Set<string>()
  const result: DeckAnalysis["commonLines"] = []

  for (const item of merged) {
    const key = item.sequence.join(">")
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(item)
  }

  return result
}

function uniqueInteractions(
  primary: MatchupAnalysis["keyInteractions"],
  fallback: MatchupAnalysis["keyInteractions"],
): MatchupAnalysis["keyInteractions"] {
  const merged = [...primary, ...fallback]
  const seen = new Set<string>()
  const result: MatchupAnalysis["keyInteractions"] = []

  for (const item of merged) {
    const key = `${item.cardA}:${item.cardB}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(item)
  }

  return result
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}