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

/**
 * 纯数据层：从卡组代码解码角色与卡牌，提取描述、技能、费用、标签、
 * 衍生物效果及 DSL 源码。不包含任何启发式分析或先验判断。
 *
 * createDeckContext 是轻量级的——不计算 trigger chain、combo clock、
 * zone pressure 等启发式中间产物，仅提供喂给 LLM 的原始事实数据。
 */

import { DEFAULT_ASSETS_MANAGER, getAllNamesSync, type AssetsManager } from "@gi-tcg/assets-manager"
import type { DeckDataActionCardInfo, DeckDataCharacterInfo } from "@gi-tcg/assets-manager"
import { getDslSourcesByIds, getCharacterSkillSources } from "./dsl-source-extractor"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayCostData {
  type: string
  count: number
}

export interface CharacterSkillData {
  name: string
  type: string
  description: string
  playCost: PlayCostData[]
  hidden: boolean
}

interface CharacterFullInfo {
  id: number
  name: string
  elements: string[]
  weapon: string | null
  nations: string[]
  hp: number
  maxEnergy: number
  skills: CharacterSkillData[]
}

interface CardDescriptionData {
  description: string
  playingDescription?: string
  playCost: PlayCostData[]
  meaningfulTags: string[]
}

export interface DeckCharacterInfo {
  id: number
  name: string
  elements: string[]
  weapon: string | null
  nations: string[]
}

export interface DeckCharacterFullInfo {
  id: number
  name: string
  elements: string[]
  weapon: string | null
  nations: string[]
  hp: number
  maxEnergy: number
  skills: CharacterSkillData[]
}

export interface DeckCardInfo {
  id: number
  name: string
  type: "equipment" | "event" | "support"
  subtype: string
  tags: string[]
  relatedCharacterId: number | null
  relatedCharacterTag: string | null
  description: string
  playingDescription?: string
  playCost: PlayCostData[]
  meaningfulTags: string[]
}

export interface DeckContext {
  deckCode: string
  characters: DeckCharacterInfo[]
  characterFullInfo: DeckCharacterFullInfo[]
  cards: DeckCardInfo[]
  entityDescriptions: Map<string, string>
  generatedHandCardDescriptions: Map<string, string>
  characterNames: string[]
  cardNames: string[]
  summary: DeckSummary
  /** DSL 源码块：角色 id → 该角色的技能源码数组（含角色定义本身在末尾） */
  characterDslSources?: Map<number, string[]>
  /** DSL 源码块：卡牌 id → 该卡的 builder DSL 源码（去 JSDoc 精简） */
  cardDslSources?: Map<number, string>
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

// ---------------------------------------------------------------------------
// Label maps
// ---------------------------------------------------------------------------

const SKILL_TYPE_LABELS: Record<string, string> = {
  GCG_SKILL_TAG_A: "普通攻击",
  GCG_SKILL_TAG_E: "元素战技",
  GCG_SKILL_TAG_Q: "元素爆发",
  GCG_SKILL_TAG_PASSIVE: "被动技能",
  GCG_SKILL_TAG_VEHICLE: "战技",
}

const COST_TYPE_LABELS: Record<string, string> = {
  GCG_COST_DICE_CRYO: "冰",
  GCG_COST_DICE_HYDRO: "水",
  GCG_COST_DICE_PYRO: "火",
  GCG_COST_DICE_ELECTRO: "雷",
  GCG_COST_DICE_ANEMO: "风",
  GCG_COST_DICE_GEO: "岩",
  GCG_COST_DICE_DENDRO: "草",
  GCG_COST_DICE_VOID: "无色",
  GCG_COST_DICE_OMNI: "万能",
  GCG_COST_DICE_ALIGNED: "同色",
  GCG_COST_DICE_SAME: "同色",
  GCG_COST_ENERGY: "充能",
  GCG_COST_LEGEND: "秘传",
}

const MEANINGFUL_TAG_MAP: Record<string, string> = {
  GCG_TAG_TALENT: "天赋",
  GCG_TAG_LEGEND: "秘传",
  GCG_TAG_FOOD: "料理",
  GCG_TAG_SLOWLY: "战斗行动",
  GCG_TAG_QUICKLY: "快速行动",
  GCG_TAG_NON_DISCOVERABLE: "不可发现",
  GCG_TAG_RESONANCE: "元素共鸣",
  GCG_TAG_WEAPON: "武器",
  GCG_TAG_WEAPON_BOW: "弓",
  GCG_TAG_WEAPON_CLAYMORE: "双手剑",
  GCG_TAG_WEAPON_CATALYST: "法器",
  GCG_TAG_WEAPON_POLE: "长柄武器",
  GCG_TAG_WEAPON_SWORD: "单手剑",
  GCG_TAG_ARTIFACT: "圣遗物",
  GCG_TAG_ALLY: "伙伴",
  GCG_TAG_PLACE: "场地",
  GCG_TAG_ITEM: "道具",
  GCG_TAG_VEHICLE: "战技",
  GCG_TAG_ADVENTURE_PLACE: "冒险场地",
}

const MEANINGFUL_ENTITY_TAG_MAP: Record<string, string> = {
  GCG_TAG_IMMUNE_FREEZING: "免疫冻结",
  GCG_TAG_IMMUNE_CONTROL: "免疫控制",
  GCG_TAG_FORBIDDEN_ATTACK: "禁止攻击",
  GCG_TAG_SHEILD: "护盾",
  GCG_TAG_DENDRO_PRODUCE: "草元素产物",
  GCG_TAG_VEHICLE: "战技",
  GCG_TAG_NON_DISCOVERABLE: "不可发现",
  GCG_TAG_SUB_HURT: "减伤",
  GCG_TAG_DISABLE: "禁用",
}

const HINT_TYPE_LABELS: Record<string, string> = {
  GCG_HINT_PYRO: "火",
  GCG_HINT_HYDRO: "水",
  GCG_HINT_CRYO: "冰",
  GCG_HINT_ELECTRO: "雷",
  GCG_HINT_ANEMO: "风",
  GCG_HINT_GEO: "岩",
  GCG_HINT_DENDRO: "草",
  GCG_HINT_PHYSICAL: "物理",
  GCG_HINT_HEAL: "治疗",
  GCG_HINT_NONE: "无",
}

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDataReady(manager: AssetsManager): Promise<void> {
  const preparePromise = manager.prepareForSync()
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("prepareForSync timed out")), 60000),
  )
  await Promise.race([preparePromise, timeoutPromise])
}

function costTypeToLabel(type: string): string {
  return COST_TYPE_LABELS[type] ?? type
}

export function formatPlayCost(costs: PlayCostData[]): string {
  if (costs.length === 0) return ""
  return costs
    .map((c) => `${c.count}${costTypeToLabel(c.type)}`)
    .join("+")
}

function extractMeaningfulTags(tags: string[]): string[] {
  const meaningful: string[] = []
  for (const tag of tags) {
    const label = MEANINGFUL_TAG_MAP[tag]
    if (label) {
      meaningful.push(label)
    }
  }
  return meaningful
}

async function getCardDescriptions(cardIds: number[], manager: AssetsManager): Promise<Map<number, CardDescriptionData>> {
  const result = new Map<number, CardDescriptionData>()
  const uniqueIds = [...new Set(cardIds)]
  try {
    await ensureDataReady(manager)
  } catch {
    return result
  }
  for (const id of uniqueIds) {
    try {
      const data = manager.getDataSync(id) as unknown as Record<string, unknown> | undefined
      if (data && typeof data.description === "string") {
        const rawPlayCost = Array.isArray(data.playCost)
          ? (data.playCost as Array<Record<string, unknown>>).map((c) => ({
              type: typeof c.type === "string" ? c.type : "",
              count: typeof c.count === "number" ? c.count : 0,
            }))
          : []
        const rawTags = Array.isArray(data.tags) ? data.tags as string[] : []
        result.set(id, {
          description: data.description as string,
          playingDescription: typeof data.playingDescription === "string" ? data.playingDescription as string : undefined,
          playCost: rawPlayCost,
          meaningfulTags: extractMeaningfulTags(rawTags),
        })
      }
    } catch {
      // Card data not available; skip description
    }
  }
  return result
}

function getCharacterSkills(characterId: number, manager: AssetsManager): CharacterSkillData[] {
  try {
    const data = manager.getDataSync(characterId) as unknown as Record<string, unknown>
    const skills = data?.skills
    if (!Array.isArray(skills)) return []
    const seen = new Set<string>()
    return skills.map((s: Record<string, unknown>) => ({
      name: typeof s.name === "string" ? s.name : "",
      type: typeof s.type === "string" ? (SKILL_TYPE_LABELS[s.type] ?? s.type) : "",
      description: typeof s.description === "string" ? s.description : typeof s.rawDescription === "string" ? s.rawDescription : "",
      playCost: Array.isArray(s.playCost)
        ? (s.playCost as Array<Record<string, unknown>>).map((c) => ({
            type: typeof c.type === "string" ? c.type : "",
            count: typeof c.count === "number" ? c.count : 0,
          }))
        : [],
      hidden: typeof s.hidden === "boolean" ? s.hidden : false,
    })).filter((s) => {
      if ((!s.name && !s.description) || s.description.includes("D__KEY__")) return false
      if (s.hidden) return false
      const key = `${s.type}「${s.name}」`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

function extractEntityNamesFromDescriptions(descriptions: Map<number, CardDescriptionData>): Set<string> {
  const names = new Set<string>()
  const bracketPattern = /「([^」]+)」/g
  const summonPattern = /(?:召唤|生成)\s*(?:\d+(?:个(?:独立的|额外的)?|点))?\s*「?([^「」，、。\s\d个点]{2,10}?)」?(?:[。，、\s）)）(]|$)/g
  const handCardPattern = /生成手牌([\u4e00-\u9fff]{2,10})(?:[，。、\s（）()）\]]|$)/g
  const listPattern = /从(.+?)中随机生成/g
  for (const desc of descriptions.values()) {
    const fullText = desc.description + (desc.playingDescription ?? "")
    for (const match of fullText.matchAll(bracketPattern)) {
      names.add(match[1].replace(/[「」]/g, ""))
    }
    for (const match of fullText.matchAll(summonPattern)) {
      const name = match[1].trim().replace(/[「」]/g, "").replace(/^手牌\s*/, "")
      for (const part of name.split(/和|与/)) {
        const trimmed = part.trim()
        if (trimmed.length >= 2) {
          names.add(trimmed)
        }
      }
    }
    for (const match of fullText.matchAll(handCardPattern)) {
      const name = match[1].trim().replace(/[「」]/g, "")
      if (name.length >= 2) {
        names.add(name)
      }
    }
    for (const match of fullText.matchAll(listPattern)) {
      const listContent = match[1]
      for (const item of listContent.split(/[、，,]/)) {
        const trimmed = item.replace(/[「」]/g, "").trim()
        if (trimmed.length >= 2) {
          names.add(trimmed)
        }
      }
    }
  }
  return names
}

function extractEntityNamesFromSkills(skills: CharacterSkillData[]): Set<string> {
  const names = new Set<string>()
  const bracketPattern = /「([^」]+)」/g
  const summonPattern = /(?:召唤|生成)\s*(?:\d+(?:个(?:独立的|额外的)?|点))?\s*「?([^「」，、。\s\d个点]{2,10}?)」?(?:[。，、\s）)）(]|$)/g
  const handCardPattern = /生成手牌([\u4e00-\u9fff]{2,10})(?:[，。、\s（）()）\]]|$)/g
  for (const skill of skills) {
    for (const match of skill.description.matchAll(bracketPattern)) {
      names.add(match[1].replace(/[「」]/g, ""))
    }
    for (const match of skill.description.matchAll(summonPattern)) {
      const name = match[1].trim().replace(/[「」]/g, "").replace(/^手牌\s*/, "")
      for (const part of name.split(/和|与/)) {
        const trimmed = part.trim()
        if (trimmed.length >= 2) {
          names.add(trimmed)
        }
      }
    }
    for (const match of skill.description.matchAll(handCardPattern)) {
      const name = match[1].trim().replace(/[「」]/g, "")
      if (name.length >= 2) {
        names.add(name)
      }
    }
  }
  return names
}

async function resolveEntityDescriptions(entityNames: Set<string>, manager: AssetsManager): Promise<{ entityDescriptions: Map<string, string>, generatedHandCardDescriptions: Map<string, string> }> {
  const entityDescriptions = new Map<string, string>()
  const generatedHandCardDescriptions = new Map<string, string>()
  if (entityNames.size === 0) return { entityDescriptions, generatedHandCardDescriptions }
  const normalizedNames = new Set<string>()
  for (const name of entityNames) {
    normalizedNames.add(name)
    normalizedNames.add(name.replace(/[「」]/g, ""))
  }
  const allNames = getAllNamesSync(manager.language)
  const nameToId = new Map<string, number>()
  for (const [idStr, name] of Object.entries(allNames)) {
    const normalized = (name as string).replace(/[「」]/g, "")
    if (normalizedNames.has(normalized)) {
      nameToId.set(normalized, parseInt(idStr, 10))
    }
  }
  for (const [normalizedName, id] of nameToId) {
    try {
      const data = manager.getDataSync(id) as unknown as Record<string, unknown>
      const category = data?.category
      if (category === "entities") {
        const desc = typeof data.description === "string" ? data.description : ""
        const playingDesc = typeof data.playingDescription === "string" ? data.playingDescription : undefined
        if (desc) {
          const typeLabel = data.type === "GCG_CARD_SUMMON" ? "召唤物" : data.type === "GCG_CARD_ONSTAGE" ? "战斗状态" : "状态"
          const entityMetaParts: string[] = []
          if (typeof data.remainAfterDie === "boolean" && data.remainAfterDie) {
            entityMetaParts.push("角色阵亡后保留")
          }
          if (typeof data.hidden === "boolean" && data.hidden) {
            entityMetaParts.push("隐藏")
          }
          if (typeof data.buffType === "string" && data.buffType === "GCG_STATE_BUFF_NEGATIVE") {
            entityMetaParts.push("负面")
          }
          if (typeof data.hintType === "string" && data.hintType) {
            const hintLabel = HINT_TYPE_LABELS[data.hintType as string] ?? ""
            if (hintLabel) {
              entityMetaParts.push(`${hintLabel}伤害`)
            }
          }
          const entityTags = Array.isArray(data.tags) ? (data.tags as string[]).filter((t) => t in MEANINGFUL_ENTITY_TAG_MAP).map((t) => MEANINGFUL_ENTITY_TAG_MAP[t]) : []
          if (entityTags.length > 0) {
            entityMetaParts.push(...entityTags)
          }
          const metaSuffix = entityMetaParts.length > 0 ? ` [${entityMetaParts.join("，")}]` : ""
          let full = `${normalizedName}（${typeLabel}${metaSuffix}）: ${desc}`
          if (playingDesc) {
            full += `\n  ${normalizedName}（持续效果）: ${playingDesc}`
          }
          const existing = entityDescriptions.get(normalizedName)
          if (!existing || full.length > existing.length) {
            entityDescriptions.set(normalizedName, full)
          }
        }
      } else if (category === "action_cards") {
        const tags = Array.isArray(data.tags) ? data.tags as string[] : []
        if (!tags.includes("GCG_TAG_NON_DISCOVERABLE")) continue
        if (generatedHandCardDescriptions.has(normalizedName)) continue
        const desc = typeof data.description === "string" ? data.description : ""
        const playingDesc = typeof data.playingDescription === "string" ? data.playingDescription : undefined
        const playCost = Array.isArray(data.playCost)
          ? (data.playCost as Array<Record<string, unknown>>).map((c) => ({
              type: typeof c.type === "string" ? c.type : "",
              count: typeof c.count === "number" ? c.count : 0,
            }))
          : []
        const labelParts: string[] = []
        if (tags.includes("GCG_TAG_TALENT")) labelParts.push("天赋")
        if (tags.includes("GCG_TAG_SLOWLY")) labelParts.push("战斗行动")
        else if (tags.includes("GCG_TAG_QUICKLY")) labelParts.push("快速行动")
        if (playCost.length > 0) {
          const costStr = playCost.map((c: {type: string; count: number}) => `${c.count}${costTypeToLabel(c.type)}`).join("+")
          labelParts.push(costStr)
        }
        const label = labelParts.length > 0 ? `（${labelParts.join("，")}）` : ""
        if (desc) {
          let full = `${normalizedName}${label}: ${desc}`
          if (playingDesc) {
            full += `\n  ${normalizedName}（持续效果）: ${playingDesc}`
          }
          generatedHandCardDescriptions.set(normalizedName, full)
        }
      }
    } catch {
      // 单个实体数据获取失败，跳过
    }
  }
  return { entityDescriptions, generatedHandCardDescriptions }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapCharacterInfo(id: number, metadata: DeckDataCharacterInfo | undefined, manager: AssetsManager): DeckCharacterInfo {
  const tags = metadata?.tags || []

  return {
    id,
    name: manager.getNameSync(id) || `Character-${id}`,
    elements: tags.filter((tag) => tag in ELEMENT_TAGS).map((tag) => ELEMENT_TAGS[tag]!),
    weapon: tags.find((tag) => tag in WEAPON_TAGS)
      ? WEAPON_TAGS[tags.find((tag) => tag in WEAPON_TAGS)!]!
      : null,
    nations: tags
      .filter((tag) => tag.startsWith(NATION_TAG_PREFIX))
      .map((tag) => tag.slice(NATION_TAG_PREFIX.length).toLowerCase()),
  }
}

function mapCardInfo(id: number, metadata: DeckDataActionCardInfo | undefined, manager: AssetsManager): Omit<DeckCardInfo, "description" | "playingDescription" | "playCost" | "meaningfulTags"> {
  const tags = metadata?.tags || []

  return {
    id,
    name: manager.getNameSync(id) || `Card-${id}`,
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

export function groupCardNames(cards: DeckCardInfo[]): Record<string, string[]> {
  const groups = new Map<string, Map<string, number>>()

  for (const card of cards) {
    const group = `${card.type === "equipment" ? "装备" : card.type === "support" ? "支援" : "事件"}-${card.subtype}`
    if (!groups.has(group)) groups.set(group, new Map())
    const cardCounts = groups.get(group)!
    cardCounts.set(card.name, (cardCounts.get(card.name) ?? 0) + 1)
  }

  const result: Record<string, string[]> = {}
  for (const [group, cardCounts] of groups) {
    result[group] = [...cardCounts.entries()].map(([name, count]) =>
      count > 1 ? `${name}×${count}` : name,
    )
  }

  return result
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] || 0) + 1
    return result
  }, {})
}

export function formatCounts(values: Record<string, number>): string {
  return Object.entries(values)
    .map(([key, count]) => `${key}x${count}`)
    .join("、")
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Context creation
// ---------------------------------------------------------------------------

export async function createDeckContext(deckCode: string, manager: AssetsManager = DEFAULT_ASSETS_MANAGER): Promise<DeckContext> {
  const decoded = manager.decode(deckCode) as {
    characters: number[]
    cards: number[]
  }
  const deckData = await manager.getDeckData()

  await ensureDataReady(manager)

  const characters = decoded.characters.map((id) =>
    mapCharacterInfo(id, deckData.characters.get(id), manager),
  )

  const characterFullInfo = decoded.characters.map((id) => {
    const info = mapCharacterInfo(id, deckData.characters.get(id), manager)
    const skills = getCharacterSkills(id, manager)
    let hp = 10
    let maxEnergy = 3
    try {
      const rawData = manager.getDataSync(id) as unknown as Record<string, unknown>
      if (typeof rawData.hp === "number") hp = rawData.hp
      if (typeof rawData.maxEnergy === "number") maxEnergy = rawData.maxEnergy
    } catch {}
    return { ...info, hp, maxEnergy, skills }
  })

  const allCardData = await getCardDescriptions(decoded.cards.filter((id) => id !== 0), manager)

  const cards = decoded.cards
    .filter((id) => id !== 0)
    .map((id) => {
      const info = mapCardInfo(id, deckData.actionCards.get(id), manager)
      const desc = allCardData.get(id)
      return {
        ...info,
        description: desc?.description ?? "",
        playingDescription: desc?.playingDescription,
        playCost: desc?.playCost ?? [],
        meaningfulTags: desc?.meaningfulTags ?? [],
      }
    })

  const entityNames = extractEntityNamesFromDescriptions(allCardData)
  for (const ch of characterFullInfo) {
    const skillEntityNames = extractEntityNamesFromSkills(ch.skills)
    for (const name of skillEntityNames) {
      entityNames.add(name)
    }
  }
  const { entityDescriptions, generatedHandCardDescriptions } = await resolveEntityDescriptions(entityNames, manager)

  // DSL 源码（角色技能 + 行动牌），用于 prompt 双通道
  const uniqueCardIds = [...new Set(cards.map((c) => c.id))]
  let cardDslSources = new Map<number, string>()
  let characterDslSources = new Map<number, string[]>()
  // vitest 环境下跳过 DSL 全量扫描（1784 文件读取会触发 Node worker OOM）
  const isTestEnv = typeof process !== "undefined" && !!process.env.VITEST
  if (!isTestEnv) {
    try {
      const charSkillEntries = await Promise.all(
        characterFullInfo.map(async (ch) => [ch.id, await getCharacterSkillSources(ch.id)] as const),
      )
      cardDslSources = await getDslSourcesByIds(uniqueCardIds)
      for (const [id, srcs] of charSkillEntries) {
        if (srcs.length > 0) characterDslSources.set(id, srcs)
      }
    } catch {
      // DSL 源码不可用（如 data/src 不可达），静默降级
    }
  }

  return {
    deckCode,
    characters,
    characterFullInfo,
    cards,
    entityDescriptions,
    generatedHandCardDescriptions,
    characterNames: characters.map((character) => character.name),
    cardNames: cards.map((card) => card.name),
    summary: summarizeDeck(characters, cards),
    characterDslSources,
    cardDslSources,
  }
}

export function createMatchupContext(deckA: DeckContext, deckB: DeckContext): MatchupContext {
  return { deckA, deckB }
}
