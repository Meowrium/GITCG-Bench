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

import type { PolicyCandidateAction, PolicyTurnDigest } from "./types.js"
import type { ObservationV1 } from "@gi-tcg/ml/contracts"

// ---------------------------------------------------------------------------
// Reaction Chain Templates (P1: §18.3)
// ---------------------------------------------------------------------------

/**
 * 元素类型简称。
 */
export type ElementKind =
  | "pyro" | "hydro" | "electro" | "cryo"
  | "anemo" | "geo" | "dendro"

/**
 * 反应类型。
 */
export type ReactionKind =
  | "vaporize"         // 蒸发 (pyro + hydro)
  | "melt"             // 融化 (pyro + cryo)
  | "overloaded"       // 超载 (pyro + electro)
  | "electrocharged"   // 感电 (hydro + electro)
  | "frozen"           // 冻结 (hydro + cryo)
  | "superconduct"     // 超导 (cryo + electro)
  | "swirl"            // 扩散 (anemo + any)
  | "crystallize"      // 结晶 (geo + any)
  | "bloom"            // 绽放 (hydro + dendro)
  | "quicken"          // 激化 (electro + dendro)
  | "burning"          // 燃烧 (pyro + dendro)

/**
 * 反应链模板：描述一个有意识设计的反应组合序列。
 */
export interface ReactionChainTemplate {
  /** 模板标识 */
  id: string
  /** 描述 */
  description: string
  /** 需要的反应序列 */
  reactions: ReactionKind[]
  /** 挂元素步骤：每步需要的元素类型 */
  element_steps: ElementKind[]
  /** 预期伤害倍率加成 */
  expected_damage_multiplier: number
  /** 模板优先级 */
  priority: number
  /** 适用条件：对手出战角色是否已挂指定元素 */
  requires_aura?: ElementKind
}

/**
 * 内置反应链模板库。
 * 基于 §18.2 A4："反应链是有意识设计的，AI 搜索很难找到"。
 */
export const BUILTIN_REACTION_CHAIN_TEMPLATES: ReactionChainTemplate[] = [
  // 扩散 + 双超导
  {
    id: "swirl_double_superconduct",
    description: "扩散扩展元素后触发双超导",
    reactions: ["swirl", "superconduct", "superconduct"],
    element_steps: ["anemo", "cryo", "electro"],
    expected_damage_multiplier: 2.2,
    priority: 8,
    requires_aura: "cryo",
  },
  // 挂水→蒸发
  {
    id: "apply_hydro_vaporize",
    description: "先挂水再触发蒸发",
    reactions: ["vaporize"],
    element_steps: ["hydro", "pyro"],
    expected_damage_multiplier: 2.0,
    priority: 9,
  },
  // 挂火→融化
  {
    id: "apply_pyro_melt",
    description: "先挂火再触发融化",
    reactions: ["melt"],
    element_steps: ["pyro", "cryo"],
    expected_damage_multiplier: 2.0,
    priority: 9,
  },
  // 挂水→冻结→碎冰
  {
    id: "freeze_shatter",
    description: "挂水冻结后物理碎冰",
    reactions: ["frozen"],
    element_steps: ["hydro", "cryo"],
    expected_damage_multiplier: 1.8,
    priority: 7,
  },
  // 扩散蒸发链
  {
    id: "swirl_vaporize_chain",
    description: "扩散扩展水元素后触发蒸发",
    reactions: ["swirl", "vaporize"],
    element_steps: ["anemo", "pyro"],
    expected_damage_multiplier: 2.5,
    priority: 10,
    requires_aura: "hydro",
  },
  // 感电持续
  {
    id: "electrocharged_sustained",
    description: "感电持续伤害",
    reactions: ["electrocharged"],
    element_steps: ["hydro", "electro"],
    expected_damage_multiplier: 1.5,
    priority: 6,
  },
  // 超载强制切人
  {
    id: "overloaded_forced_switch",
    description: "超载强制切换对手出战角色",
    reactions: ["overloaded"],
    element_steps: ["pyro", "electro"],
    expected_damage_multiplier: 1.3,
    priority: 7,
  },
  // 绽放链 (dendro + hydro)
  {
    id: "bloom_chain",
    description: "草水绽放反应",
    reactions: ["bloom"],
    element_steps: ["dendro", "hydro"],
    expected_damage_multiplier: 1.6,
    priority: 7,
  },
  // 激化链 (dendro + electro)
  {
    id: "quicken_chain",
    description: "草雷激化反应",
    reactions: ["quicken"],
    element_steps: ["dendro", "electro"],
    expected_damage_multiplier: 1.7,
    priority: 7,
  },
  // 燃烧持续 (dendro + pyro)
  {
    id: "burning_sustained",
    description: "草火持续燃烧",
    reactions: ["burning"],
    element_steps: ["dendro", "pyro"],
    expected_damage_multiplier: 1.4,
    priority: 5,
  },
]

// ---------------------------------------------------------------------------
// 反应链匹配评估
// ---------------------------------------------------------------------------

/**
 * Aura 编号 → 元素映射（基于 PbDiceType / aura 编码）。
 * 注意：这里用简化映射，实际可能需要对照 @gi-tcg/typings 的枚举。
 */
const AURA_TO_ELEMENT: Record<number, ElementKind> = {
  1: "cryo",
  2: "hydro",
  3: "pyro",
  4: "electro",
  5: "anemo",
  6: "geo",
  7: "dendro",
}

export interface ReactionChainMatch {
  template: ReactionChainTemplate
  /** 匹配分数 (0~1) */
  match_score: number
  /** 当前已完成的步骤数 */
  completed_steps: number
  /** 下一步需要的元素 */
  next_element_needed: ElementKind | null
  /** 当前手牌/骰子能否执行下一步 */
  executable: boolean
  /** 是否需要切角色才能执行 */
  requires_switch: boolean
  /** 需要切到哪个角色 (definition_id) */
  switch_target_id: number | null
}

/**
 * 评估当前场面状态下哪些反应链模板可以被匹配。
 */
export function matchReactionChainTemplates(
  observation: ObservationV1,
  templates?: ReactionChainTemplate[],
): ReactionChainMatch[] {
  const library = templates ?? BUILTIN_REACTION_CHAIN_TEMPLATES
  const oppActive = observation.opponent.characters.find((ch) => ch.is_active && ch.alive)
  if (!oppActive) return []

  const oppAura = oppActive.aura != null ? AURA_TO_ELEMENT[oppActive.aura] ?? null : null
  const matches: ReactionChainMatch[] = []

  for (const template of library) {
    // 如果模板要求特定 aura，检查对手是否已挂
    if (template.requires_aura) {
      if (oppAura === template.requires_aura) {
        // Aura 已存在，跳过第一步
        matches.push({
          template,
          match_score: 0.8,
          completed_steps: 1,
          next_element_needed: template.element_steps[1] ?? null,
          executable: false,
          requires_switch: false,
          switch_target_id: null,
        })
      }
      continue
    }

    // 检查无先决条件的模板：只要不冲突就可以开始
    if (oppAura == null) {
      matches.push({
        template,
        match_score: 0.5,
        completed_steps: 0,
        next_element_needed: template.element_steps[0] ?? null,
        executable: false,
        requires_switch: false,
        switch_target_id: null,
      })
    } else {
      // 如果对手已有 aura，检查是否与第一步兼容
      if (template.element_steps[0] === oppAura) {
        matches.push({
          template,
          match_score: 0.7,
          completed_steps: 1,
          next_element_needed: template.element_steps[1] ?? null,
          executable: false,
          requires_switch: false,
          switch_target_id: null,
        })
      }
    }
  }

  // 对匹配结果进行可执行性检查
  const enrichedMatches = matches.map((match) =>
    checkChainExecutability(match, observation.self.characters, observation),
  )

  return enrichedMatches
    .sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score
      return b.template.priority - a.template.priority
    })
    .slice(0, 5)
}

// ---------------------------------------------------------------------------
// Candidate 评分调整：反应链模板先验
// ---------------------------------------------------------------------------

/**
 * 元素关键字到候选操作标签的映射。
 */
const ELEMENT_TO_TAGS: Record<ElementKind, string[]> = {
  pyro: ["pyro_damage", "pyro_apply", "element:pyro"],
  hydro: ["hydro_damage", "hydro_apply", "element:hydro"],
  electro: ["electro_damage", "electro_apply", "element:electro"],
  cryo: ["cryo_damage", "cryo_apply", "element:cryo"],
  anemo: ["anemo_damage", "anemo_apply", "element:anemo"],
  geo: ["geo_damage", "geo_apply", "element:geo"],
  dendro: ["dendro_damage", "dendro_apply", "element:dendro"],
}

/**
 * 根据匹配的反应链模板，为候选操作计算先验加分。
 * 优先展开匹配模板的操作序列。
 */
export function scoreReactionChainPrior(
  candidate: PolicyCandidateAction,
  chainMatches: ReactionChainMatch[],
): { score: number; reasons: string[] } {
  if (chainMatches.length === 0) return { score: 0, reasons: [] }

  const candidateTags = normalizeCandidateTags(candidate)
  let bestScore = 0
  const reasons: string[] = []

  for (const match of chainMatches) {
    if (!match.next_element_needed) continue

    const neededTags = ELEMENT_TO_TAGS[match.next_element_needed] ?? []
    const hasElementMatch = neededTags.some((tag) => candidateTags.has(tag))
    const hasReactionTag = candidateTags.has("reaction_enable") || candidateTags.has("direct_damage")

    if (hasElementMatch) {
      const baseBonus = match.match_score * match.template.priority * 0.15
      const executableBonus = match.executable ? baseBonus * 1.5 : baseBonus
      const completedBonus = match.completed_steps > 0 ? executableBonus * 1.3 : executableBonus
      if (completedBonus > bestScore) {
        bestScore = completedBonus
        reasons.length = 0
        reasons.push(`reaction_chain=${match.template.id}:+${completedBonus.toFixed(2)}`)
      }
    } else if (hasReactionTag && match.completed_steps > 0) {
      const bonus = match.match_score * 0.3
      if (bonus > bestScore) {
        bestScore = bonus
        reasons.length = 0
        reasons.push(`reaction_chain_partial=${match.template.id}:+${bonus.toFixed(2)}`)
      }
    }
  }

  return { score: bestScore, reasons }
}

function normalizeCandidateTags(candidate: PolicyCandidateAction): Set<string> {
  const tags = candidate.tags
  if (Array.isArray(tags)) return new Set(tags.map(String))
  if (tags && typeof tags === "object") return new Set(Object.keys(tags))
  return new Set()
}

// ---------------------------------------------------------------------------
// 反应链可执行性检查 (P1: §2.2)
// ---------------------------------------------------------------------------

const ELEMENT_TO_DICE: Record<ElementKind, number> = {
  pyro: 3,
  hydro: 2,
  electro: 4,
  cryo: 1,
  anemo: 5,
  geo: 6,
  dendro: 7,
}

function canApplyElement(
  character: { definition_id: number; alive: boolean },
  neededElement: ElementKind,
  characterElementMap: Map<number, string>,
): boolean {
  if (!character.alive) return false
  const charElement = characterElementMap.get(character.definition_id)
  return charElement === neededElement
}

export function checkChainExecutability(
  match: ReactionChainMatch,
  selfCharacters: ReadonlyArray<{ definition_id: number; alive: boolean; is_active: boolean }>,
  observation: ObservationV1,
): ReactionChainMatch {
  const neededElement = match.next_element_needed
  if (!neededElement) {
    return { ...match, executable: false, requires_switch: false, switch_target_id: null }
  }

  const elementMap = buildSelfCharacterElementMap(observation)
  const charactersWithElement = selfCharacters
    .filter((c) => c.alive)
    .filter((c) => canApplyElement(c, neededElement, elementMap))

  if (charactersWithElement.length === 0) {
    return { ...match, executable: false, requires_switch: false, switch_target_id: null }
  }

  const activeChar = selfCharacters.find((c) => c.is_active)
  const canPayWithActive = charactersWithElement.some((c) => c === activeChar)

  if (canPayWithActive) {
    return { ...match, executable: true, requires_switch: false, switch_target_id: null }
  }

  const switchTarget = charactersWithElement.find((c) => c.definition_id != null)
  if (switchTarget) {
    return {
      ...match,
      executable: true,
      requires_switch: true,
      switch_target_id: switchTarget.definition_id,
      match_score: match.match_score * 0.85,
    }
  }

  return { ...match, executable: false, requires_switch: false, switch_target_id: null }
}

function buildSelfCharacterElementMap(observation: ObservationV1): Map<number, string> {
  const map = new Map<number, string>()
  for (const ch of observation.self.characters) {
    const el = numberToElement(ch.aura)
    if (el) {
      map.set(ch.definition_id, el)
    } else {
      const fromTags = inferElementFromDefinitionId(ch.definition_id)
      if (fromTags) map.set(ch.definition_id, fromTags)
    }
  }
  return map
}

function numberToElement(aura: number | null): string | null {
  if (aura == null || aura === 0) return null
  const map: Record<number, string> = {
    1: "cryo", 2: "hydro", 3: "pyro", 4: "electro",
    5: "anemo", 6: "geo", 7: "dendro",
  }
  return map[aura] ?? null
}

function inferElementFromDefinitionId(definitionId: number): string | null {
  return CHARACTER_ELEMENT_DEFINITION_MAP.get(definitionId) ?? null
}

// Lazy-initialized map from definition_id to element string
const CHARACTER_ELEMENT_DEFINITION_MAP = buildCharacterElementDefinitionMap()

function buildCharacterElementDefinitionMap(): Map<number, string> {
  const map = new Map<number, string>()
  try {
    const { CURRENT_VERSION } = require("@gi-tcg/core")
    const getData = require("@gi-tcg/data").default
    const gameData = getData(CURRENT_VERSION)
    for (const [id, character] of gameData.characters) {
      const tags = Array.isArray(character.tags)
        ? character.tags.filter((tag: unknown): tag is string => typeof tag === "string")
        : []
      for (const el of ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"]) {
        if (tags.includes(el)) {
          map.set(id, el)
          break
        }
      }
    }
  } catch {
    // Fallback: empty map
  }
  return map
}
