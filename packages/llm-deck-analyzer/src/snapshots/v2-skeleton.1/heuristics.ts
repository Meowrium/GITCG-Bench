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

import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { DeckDataActionCardInfo, DeckDataCharacterInfo } from "@gi-tcg/assets-manager"
import type { DeckAnalysis, MatchupAnalysis } from "./types"

const ELEMENT_TAGS: Record<string, string> = {
  GCG_TAG_ELEMENT_CRYO: "冰",
  GCG_TAG_ELEMENT_HYDRO: "水",
  GCG_TAG_ELEMENT_PYRO: "火",
  GCG_TAG_ELEMENT_ELECTRO: "雷",
  GCG_TAG_ELEMENT_ANEMO: "风",
  GCG_TAG_ELEMENT_GEO: "岩",
  GCG_TAG_ELEMENT_DENDRO: "草",
}

const WEAPON_TAGS: Record<string, string> = {
  GCG_TAG_WEAPON_BOW: "弓",
  GCG_TAG_WEAPON_CLAYMORE: "双手剑",
  GCG_TAG_WEAPON_CATALYST: "法器",
  GCG_TAG_WEAPON_POLE: "长柄武器",
  GCG_TAG_WEAPON_SWORD: "单手剑",
}

const NATION_TAG_PREFIX = "GCG_TAG_NATION_"

export interface DeckCharacterInfo {
  id: number
  name: string
  elements: string[]
  weapon: string | null
  nations: string[]
}

export interface DeckCardInfo {
  id: number
  name: string
  type: "equipment" | "event" | "support"
  subtype: string
  tags: string[]
  relatedCharacterId: number | null
  relatedCharacterTag: string | null
}

export interface DeckContext {
  deckCode: string
  characters: DeckCharacterInfo[]
  cards: DeckCardInfo[]
  characterNames: string[]
  cardNames: string[]
  summary: DeckSummary
}

export interface MatchupContext {
  deckA: DeckContext
  deckB: DeckContext
}

interface DeckSummary {
  elementCounts: Record<string, number>
  nations: string[]
  equipmentCount: number
  eventCount: number
  supportCount: number
  talentCount: number
  weaponCount: number
  artifactCount: number
  resonanceCount: number
  supportSubtypes: Record<string, number>
  cardFrequencies: Array<{
    name: string
    count: number
  }>
}

export async function createDeckContext(deckCode: string): Promise<DeckContext> {
  const decoded = DEFAULT_ASSETS_MANAGER.decode(deckCode) as {
    characters: number[]
    cards: number[]
  }
  const deckData = await DEFAULT_ASSETS_MANAGER.getDeckData()

  const characters = decoded.characters.map((id) =>
    mapCharacterInfo(id, deckData.characters.get(id)),
  )
  const cards = decoded.cards
    .filter((id) => id !== 0)
    .map((id) => mapCardInfo(id, deckData.actionCards.get(id)))

  return {
    deckCode,
    characters,
    cards,
    characterNames: characters.map((character) => character.name),
    cardNames: cards.map((card) => card.name),
    summary: summarizeDeck(characters, cards),
  }
}

export function createMatchupContext(deckA: DeckContext, deckB: DeckContext): MatchupContext {
  return { deckA, deckB }
}

export function buildDeckPromptContext(context: DeckContext): string {
  const characters = context.characters
    .map((character) => {
      const traits = [
        character.elements.join("/"),
        character.weapon,
        character.nations.join("/"),
      ].filter(Boolean)
      return `- ${character.name}（${traits.join("，")}）`
    })
    .join("\n")

  const groupedCards = groupCardNames(context.cards)
  const cards = Object.entries(groupedCards)
    .map(([group, items]) => `- ${group}: ${items.join("、")}`)
    .join("\n")

  return `牌组代码: ${context.deckCode}
角色:
${characters}
卡牌:
${cards}
摘要:
- 元素分布: ${formatCounts(context.summary.elementCounts)}
- 装备/事件/支援: ${context.summary.equipmentCount}/${context.summary.eventCount}/${context.summary.supportCount}
- 天赋牌数量: ${context.summary.talentCount}
- 共鸣牌数量: ${context.summary.resonanceCount}
- 重复关键牌: ${context.summary.cardFrequencies
    .filter((item) => item.count > 1)
    .slice(0, 6)
    .map((item) => `${item.name}x${item.count}`)
    .join("、") || "无"}`
}

export function buildLocalDeckAnalysis(context: DeckContext, deckName?: string): DeckAnalysis {
  const archetype = inferArchetype(context)
  const strength = scoreDeckStrength(context, archetype)
  const keyCards = inferKeyCards(context)
  const commonLines = inferCommonLines(context, archetype)
  const strengths = inferStrengths(context, archetype)
  const weaknesses = inferWeaknesses(context, archetype)

  return {
    deckCode: context.deckCode,
    deckName,
    characters: context.characterNames,
    strength,
    winCondition: archetype.winCondition,
    gamePlan: {
      earlyGame: archetype.earlyGame,
      midGame: archetype.midGame,
      lateGame: archetype.lateGame,
    },
    keyCards,
    commonLines,
    strengths,
    weaknesses,
    matchupNotes: {
      快攻: archetype.tempoNote,
      资源局: archetype.resourceNote,
    },
  }
}

export function buildLocalMatchupAnalysis(
  context: MatchupContext,
  deckAAnalysis: DeckAnalysis,
  deckBAnalysis: DeckAnalysis,
): MatchupAnalysis {
  const pressureA = matchupPressure(context.deckA)
  const pressureB = matchupPressure(context.deckB)
  const resourceA = matchupResource(context.deckA)
  const resourceB = matchupResource(context.deckB)
  const score = Math.max(
    -10,
    Math.min(
      10,
      Math.round(
        (deckAAnalysis.strength - deckBAnalysis.strength) * 0.8 +
          (pressureA - pressureB) * 3 +
          (resourceA - resourceB) * 2,
      ),
    ),
  )
  const winRateA = clamp(0.5 + score * 0.035, 0.2, 0.8)

  return {
    deckA: context.deckA.deckCode,
    deckB: context.deckB.deckCode,
    advantage: {
      deckA: score,
      deckB: -score,
      reason: buildAdvantageReason(context, score),
    },
    keyInteractions: inferKeyInteractions(context).slice(0, 4),
    strategy: {
      deckAPlaying: buildMatchupPlan(context.deckA, context.deckB, "A"),
      deckBPlaying: buildMatchupPlan(context.deckB, context.deckA, "B"),
    },
    predictedWinRates: {
      deckA: winRateA,
      deckB: 1 - winRateA,
    },
  }
}

function mapCharacterInfo(id: number, metadata?: DeckDataCharacterInfo): DeckCharacterInfo {
  const tags = metadata?.tags || []

  return {
    id,
    name: metadata?.name || DEFAULT_ASSETS_MANAGER.getNameSync(id) || `Character-${id}`,
    elements: tags.filter((tag) => tag in ELEMENT_TAGS).map((tag) => ELEMENT_TAGS[tag]!),
    weapon: tags.find((tag) => tag in WEAPON_TAGS)
      ? WEAPON_TAGS[tags.find((tag) => tag in WEAPON_TAGS)!]!
      : null,
    nations: tags
      .filter((tag) => tag.startsWith(NATION_TAG_PREFIX))
      .map((tag) => tag.slice(NATION_TAG_PREFIX.length).toLowerCase()),
  }
}

function mapCardInfo(id: number, metadata?: DeckDataActionCardInfo): DeckCardInfo {
  const tags = metadata?.tags || []

  return {
    id,
    name: metadata?.name || DEFAULT_ASSETS_MANAGER.getNameSync(id) || `Card-${id}`,
    type: mapCardType(metadata?.type),
    subtype: mapCardSubtype(metadata?.type, tags),
    tags,
    relatedCharacterId: metadata?.relatedCharacterId ?? null,
    relatedCharacterTag: metadata?.relatedCharacterTag ?? null,
  }
}

function mapCardType(type?: string): DeckCardInfo["type"] {
  switch (type) {
    case "GCG_CARD_MODIFY":
      return "equipment"
    case "GCG_CARD_ASSIST":
      return "support"
    default:
      return "event"
  }
}

function mapCardSubtype(type: string | undefined, tags: string[]): string {
  if (type === "GCG_CARD_MODIFY") {
    if (tags.includes("GCG_TAG_TALENT")) return "天赋"
    if (tags.includes("GCG_TAG_WEAPON")) return "武器"
    if (tags.includes("GCG_TAG_ARTIFACT")) return "圣遗物"
    return "装备"
  }

  if (type === "GCG_CARD_ASSIST") {
    if (tags.includes("GCG_TAG_ALLY")) return "伙伴"
    if (tags.includes("GCG_TAG_PLACE")) return "场地"
    if (tags.includes("GCG_TAG_ITEM")) return "道具"
    return "支援"
  }

  if (tags.includes("GCG_TAG_RESONANCE")) return "元素共鸣"
  if (tags.includes("GCG_TAG_FOOD")) return "料理"
  if (tags.includes("GCG_TAG_LEGEND")) return "秘传"
  return "事件"
}

function summarizeDeck(characters: DeckCharacterInfo[], cards: DeckCardInfo[]): DeckSummary {
  const elementCounts = countValues(characters.flatMap((character) => character.elements))
  const nations = [...new Set(characters.flatMap((character) => character.nations))]
  const supportSubtypes = countValues(
    cards.filter((card) => card.type === "support").map((card) => card.subtype),
  )
  const cardFrequencies = Object.entries(countValues(cards.map((card) => card.name)))
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))

  return {
    elementCounts,
    nations,
    equipmentCount: cards.filter((card) => card.type === "equipment").length,
    eventCount: cards.filter((card) => card.type === "event").length,
    supportCount: cards.filter((card) => card.type === "support").length,
    talentCount: cards.filter((card) => card.subtype === "天赋").length,
    weaponCount: cards.filter((card) => card.subtype === "武器").length,
    artifactCount: cards.filter((card) => card.subtype === "圣遗物").length,
    resonanceCount: cards.filter((card) => card.subtype === "元素共鸣").length,
    supportSubtypes,
    cardFrequencies,
  }
}

function inferArchetype(context: DeckContext) {
  const { summary } = context
  const dominantElements = Object.entries(summary.elementCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([element]) => element)

  const dualElement = dominantElements.slice(0, 2).join("/")
  const hasTalentPackage = summary.talentCount >= 2
  const hasSupportEngine = summary.supportCount >= 8
  const hasReactionPackage = Object.keys(summary.elementCounts).length >= 2 && summary.resonanceCount > 0
  const hasEquipmentPackage = summary.weaponCount + summary.artifactCount >= 4

  let winCondition = `${dualElement || "多元素"}角色站场压制`
  let earlyGame = "前期优先完成骰子与站场准备，尽量让核心角色安全启动。"
  let midGame = "中期围绕核心角色连续行动，利用事件与支援牌维持节奏优势。"
  let lateGame = "后期保留关键爆发回合，靠资源差或伤害阈值完成收割。"
  let tempoNote = "面对快攻时要优先保证站场角色血量与切人节奏。"
  let resourceNote = "进入资源局时，这套牌更依赖持续收益和关键牌轮转。"

  if (hasReactionPackage) {
    winCondition = `${dualElement}元素反应滚雪球后完成终结`
    midGame = "中期围绕元素附着与切人衔接打出高质量反应回合。"
  }

  if (hasSupportEngine) {
    earlyGame = "前期先铺设支援体系与过牌/资源点，避免无收益换血。"
    lateGame = "后期依靠累计的手牌与骰子优势压缩对手操作空间。"
    resourceNote = "拖到资源局时通常会因为支援体系更完整而更从容。"
  }

  if (hasTalentPackage || hasEquipmentPackage) {
    winCondition = `${dualElement || "核心"}角色借助装备与天赋形成持续站场输出`
    midGame = "中期集中资源给主 C 角色，利用装备与天赋提高单回合质量。"
    tempoNote = "面对快攻时要尽快把资源集中到主力角色，避免被拆散节奏。"
  }

  return {
    winCondition,
    earlyGame,
    midGame,
    lateGame,
    tempoNote,
    resourceNote,
  }
}

function inferKeyCards(context: DeckContext): DeckAnalysis["keyCards"] {
  const characterIds = new Set(context.characters.map((character) => character.id))

  return prioritizeCards(context.cards, characterIds).slice(0, 6).map((card, index) => ({
    name: card.name,
    importance: clamp(9 - index, 6, 9),
    usage: describeCardUsage(card),
  }))
}

function inferCommonLines(
  context: DeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): DeckAnalysis["commonLines"] {
  const supportCard = context.cards.find((card) => card.type === "support")
  const talentCard = context.cards.find((card) => card.subtype === "天赋")
  const eventCard = context.cards.find((card) => card.type === "event")
  const carry = context.characters[0]?.name || "核心角色"

  const lines: DeckAnalysis["commonLines"] = [
    {
      sequence: [
        supportCard?.name || "前期支援牌",
        `切到${carry}`,
        talentCard?.name || "关键装备/天赋",
      ],
      description: "先完成资源启动，再把资源集中到主力角色。",
      winRateImpact: 0.12,
    },
    {
      sequence: [
        `${carry}使用技能`,
        eventCard?.name || "功能事件",
        "继续压制或安全切人",
      ],
      description: archetype.midGame,
      winRateImpact: 0.18,
    },
  ]

  if (context.summary.supportCount >= 8) {
    lines.push({
      sequence: ["连续铺支援", "过牌/补骰", `${carry}完成爆发回合`],
      description: "资源体系成型后再进入高收益输出回合。",
      winRateImpact: 0.15,
    })
  }

  return lines
}

function inferStrengths(
  context: DeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): string[] {
  const strengths = [
    "角色元素组合明确，主计划较容易围绕核心角色展开。",
  ]

  if (context.summary.supportCount >= 8) {
    strengths.push("支援牌密度较高，长局中的资源与过牌稳定性更好。")
  }
  if (context.summary.talentCount >= 2) {
    strengths.push("天赋投入较足，核心角色在成型后的上限更高。")
  }
  if (context.summary.resonanceCount > 0) {
    strengths.push("具备元素共鸣组件，能强化队伍整体节奏或伤害效率。")
  }
  if (archetype.winCondition.includes("反应")) {
    strengths.push("中期反应回合威胁较高，容易通过连动形成滚雪球。")
  }

  return strengths.slice(0, 5)
}

function inferWeaknesses(
  context: DeckContext,
  archetype: ReturnType<typeof inferArchetype>,
): string[] {
  const weaknesses = [
    "如果前期抽不到关键资源牌，启动节奏会明显放缓。",
  ]

  if (context.summary.supportCount < 6) {
    weaknesses.push("支援密度偏低，拖入长局后续航能力一般。")
  }
  if (context.summary.talentCount >= 3) {
    weaknesses.push("对核心角色依赖较重，主力被限制时回合质量容易下滑。")
  }
  if (!archetype.winCondition.includes("反应")) {
    weaknesses.push("主要依靠站场与单点质量，面对高频切人或控制时容错有限。")
  }
  if (Object.keys(context.summary.elementCounts).length === 3) {
    weaknesses.push("三元素配置对骰子和切人管理要求更高，失误成本偏高。")
  }

  return weaknesses.slice(0, 5)
}

function scoreDeckStrength(context: DeckContext, archetype: ReturnType<typeof inferArchetype>): number {
  let score = 5.6
  score += Math.min(context.summary.supportCount, 10) * 0.12
  score += Math.min(context.summary.talentCount, 3) * 0.28
  score += Math.min(context.summary.resonanceCount, 2) * 0.25
  score += Math.min(context.summary.weaponCount + context.summary.artifactCount, 4) * 0.1

  if (archetype.winCondition.includes("反应")) score += 0.35
  if (archetype.winCondition.includes("资源")) score += 0.2

  return clamp(Number(score.toFixed(1)), 4.5, 8.8)
}

function matchupPressure(context: DeckContext): number {
  return clamp(
    context.summary.talentCount * 0.2 +
      context.summary.weaponCount * 0.15 +
      context.summary.resonanceCount * 0.25,
    0,
    2,
  )
}

function matchupResource(context: DeckContext): number {
  return clamp(
    context.summary.supportCount * 0.12 +
      (context.summary.supportSubtypes.伙伴 || 0) * 0.1 +
      (context.summary.supportSubtypes.场地 || 0) * 0.1,
    0,
    2,
  )
}

function inferKeyInteractions(context: MatchupContext): MatchupAnalysis["keyInteractions"] {
  const aKey = context.deckA.cards.slice(0, 2)
  const bKey = context.deckB.cards.slice(0, 2)
  const interactions: MatchupAnalysis["keyInteractions"] = []

  for (let index = 0; index < Math.min(aKey.length, bKey.length); index++) {
    const cardA = aKey[index]
    const cardB = bKey[index]
    if (!cardA || !cardB) {
      continue
    }
    interactions.push({
      cardA: cardA.name,
      cardB: cardB.name,
      impact: `${cardA.subtype}组件与${cardB.subtype}组件的节奏对抗会直接影响中期回合质量。`,
    })
  }

  if (interactions.length === 0) {
    interactions.push({
      cardA: context.deckA.characters[0]?.name || "卡组 A 核心角色",
      cardB: context.deckB.characters[0]?.name || "卡组 B 核心角色",
      impact: "双方核心角色的站场时机与资源保护，会决定谁先进入优势回合。",
    })
  }

  return interactions
}

function buildAdvantageReason(context: MatchupContext, score: number): string {
  if (score >= 3) {
    return `${context.deckA.characters[0]?.name || "卡组 A"} 的资源成型更快，中期更容易先打出优势回合。`
  }
  if (score <= -3) {
    return `${context.deckB.characters[0]?.name || "卡组 B"} 对节奏和资源的掌控更稳定，A 需要更顺的启动。`
  }
  return "双方都有可执行的主计划，胜负更多取决于前中期启动顺序与关键牌命中。"
}

function buildMatchupPlan(self: DeckContext, opponent: DeckContext, label: string): string {
  const selfCarry = self.characters[0]?.name || `卡组 ${label}`
  const opponentCarry = opponent.characters[0]?.name || "对手核心"
  if (self.summary.supportCount >= opponent.summary.supportCount) {
    return `优先稳住前期资源，等支援体系成型后再围绕${selfCarry}打高质量回合，尽量压缩${opponentCarry}的爆发窗口。`
  }
  return `尽量缩短铺垫时间，利用切人与功能牌牵制${opponentCarry}，不要让对手顺利进入资源滚雪球阶段。`
}

function prioritizeCards(cards: DeckCardInfo[], characterIds: Set<number>): DeckCardInfo[] {
  return [...cards].sort((left, right) => scoreCard(right, characterIds) - scoreCard(left, characterIds))
}

function scoreCard(card: DeckCardInfo, characterIds: Set<number>): number {
  let score = 0
  if (card.subtype === "天赋") score += 5
  if (card.subtype === "元素共鸣") score += 4
  if (card.type === "support") score += 3
  if (card.subtype === "武器" || card.subtype === "圣遗物") score += 2
  if (card.relatedCharacterId && characterIds.has(card.relatedCharacterId)) score += 4
  if (card.relatedCharacterTag) score += 1
  return score
}

function describeCardUsage(card: DeckCardInfo): string {
  switch (card.subtype) {
    case "天赋":
      return "强化对应角色的核心回合，是主计划成型的重要组件。"
    case "元素共鸣":
      return "提升队伍整体节奏或伤害效率，帮助卡组更稳定地执行主计划。"
    case "武器":
    case "圣遗物":
      return "提高主力角色站场质量，增强持续输出或交换效率。"
    case "伙伴":
    case "场地":
    case "道具":
      return "提供持续资源或功能收益，支撑中后期的运营回合。"
    default:
      return "承担补资源、修节奏或衔接连动的功能作用。"
  }
}

function groupCardNames(cards: DeckCardInfo[]): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}

  for (const card of cards) {
    const group = `${card.type === "equipment" ? "装备" : card.type === "support" ? "支援" : "事件"}-${card.subtype}`
    grouped[group] ??= []
    grouped[group].push(card.name)
  }

  return grouped
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1
    return result
  }, {})
}

function formatCounts(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([key, count]) => `${key}x${count}`)
    .join("、")
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
