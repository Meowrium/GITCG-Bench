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

import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import type { ElementKind } from "./reaction-chain-templates.js"
import type { GamePhaseKind } from "./game-plan.js"

export type FunctionalTier = "core" | "tactical" | "residual"

export interface CharacterValueAssessment {
  characterDefinitionId: number
  functionalTier: FunctionalTier
  collapseDistance: number
  burstUrgency: number
  strategicTags: string[]
}

const CHARACTER_ELEMENT_MAP = buildCharacterElementMap()

function buildCharacterElementMap(): Map<number, string> {
  const map = new Map<number, string>()
  if (typeof globalThis !== "undefined") {
    try {
      const { CURRENT_VERSION } = require("@gi-tcg/core")
      const getData = require("@gi-tcg/data").default
      const gameData = getData(CURRENT_VERSION)
      for (const [id, character] of gameData.characters) {
        const tags = Array.isArray(character.tags)
          ? character.tags.filter((tag: unknown): tag is string => typeof tag === "string")
          : []
        const element = extractElement(tags)
        if (element) map.set(id, element)
      }
    } catch {
      // Fallback: empty map, will be populated lazily
    }
  }
  return map
}

function extractElement(tags: string[]): string | null {
  const elements = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"]
  for (const el of elements) {
    if (tags.includes(el)) return el
  }
  return null
}

function getElementFromDefinitionId(definitionId: number): string | null {
  return CHARACTER_ELEMENT_MAP.get(definitionId) ?? null
}

/** Element name → DiceType numeric value (1=Cryo,2=Hydro,3=Pyro,4=Electro,5=Anemo,6=Geo,7=Dendro) */
const ELEMENT_DICE_MAP_NUMERIC: Record<string, number> = {
  cryo: 1, hydro: 2, pyro: 3, electro: 4, anemo: 5, geo: 6, dendro: 7,
}

/** Support card definition_ids that collect/absorb unused dice (立本=322008, 桓那兰那=321011) */
const DICE_COLLECTOR_IDS = new Set([322008, 321011])

/** Check if a support on board is a dice collector with room to absorb more dice */
function detectDiceCollectorTuning(observation: ObservationV1): { suggested: boolean; target: number | null } {
  for (const s of observation.self.supports) {
    if (!DICE_COLLECTOR_IDS.has(s.definition_id)) continue
    const collected = s.variable_value ?? 0
    // 立本: 3 max, 桓那兰那: 2 max — check if under capacity
    const maxCapacity = s.definition_id === 322008 ? 3 : s.definition_id === 321011 ? 2 : 0
    if (collected >= maxCapacity) continue
    // Suggest tuning toward active character's element
    const activeIdx = observation.self.active_character_index
    if (activeIdx != null) {
      const c = observation.self.characters[activeIdx]
      if (c?.definition_id) {
        const el = getElementFromDefinitionId(c.definition_id)
        if (el) return { suggested: true, target: ELEMENT_DICE_MAP_NUMERIC[el] ?? null }
      }
    }
    return { suggested: true, target: null }
  }
  return { suggested: false, target: null }
}

export type OpponentArchetype =
  | "pyro_cryo"    // 融化
  | "pyro_hydro"   // 蒸发
  | "electro_pyro" // 超载
  | "electro_hydro" // 感电
  | "electro_cryo" // 超导
  | "electro_dendro" // 激化
  | "dendro_pyro"  // 燃烧
  | "dendro_hydro" // 绽放
  | "anemo_swirl"  // 扩散
  | "geo_crystallize" // 结晶
  | "unknown"

export type DeckArchetype = string

const DECK_ROLE_MAP: Record<string, Record<number, "core_dps" | "core_burst" | "enabler" | "aura_applier" | "flex">> = {
  "dehya_2301_lady": {
    0: "core_burst",
    1: "aura_applier",
    2: "enabler",
  },
  "default": {},
}

function determineFunctionalTier(
  charId: number,
  deckArchetype: DeckArchetype,
  energy: number,
  maxEnergy: number,
  hp: number,
  maxHp: number,
  phase: GamePhaseKind,
): FunctionalTier {
  const roleMap = DECK_ROLE_MAP[deckArchetype] ?? DECK_ROLE_MAP["default"]
  const role = roleMap[charId]
  if (!role) return "tactical"

  const hpRatio = maxHp > 0 ? hp / maxHp : 1
  const energyRatio = maxEnergy > 0 ? energy / maxEnergy : 0

  if (role === "core_dps" || role === "core_burst") {
    if (phase === "closing" && hpRatio > 0.5) return "core"
    if (phase === "setup" && energyRatio < 0.5) return "tactical"
    return "core"
  }
  if (role === "enabler" || role === "aura_applier") {
    if (phase === "execution" || phase === "closing") return "residual"
    return "tactical"
  }
  return "tactical"
}

export function assessCharacterValue(
  character: {
    definition_id: number
    alive: boolean
    health: number
    max_health: number
    energy: number
    max_energy: number
  },
  deckArchetype: DeckArchetype,
  opponentArchetype: OpponentArchetype,
  gamePhase: GamePhaseKind,
  opponentDamageCapacity: number,
  opponentReactionBonus: number,
): CharacterValueAssessment {
  if (!character.alive) {
    return {
      characterDefinitionId: character.definition_id,
      functionalTier: "residual",
      collapseDistance: 0,
      burstUrgency: 0,
      strategicTags: [],
    }
  }

  const tier = determineFunctionalTier(
    character.definition_id,
    deckArchetype,
    character.energy,
    character.max_energy,
    character.health,
    character.max_health,
    gamePhase,
  )

  const collapseDist = computeCollapseDistance(
    character.health,
    character.max_health,
    character.energy,
    character.max_energy,
    tier,
    opponentDamageCapacity,
    opponentReactionBonus,
  )

  const burstUrgency = computeBurstUrgencySimple(
    character.energy,
    character.max_energy,
    opponentDamageCapacity,
    character.health,
    false,
  )

  const element = getElementFromDefinitionId(character.definition_id)
  const tags: string[] = []
  if (element) tags.push(`element:${element}`)
  tags.push(`tier:${tier}`)

  return {
    characterDefinitionId: character.definition_id,
    functionalTier: tier,
    collapseDistance: collapseDist,
    burstUrgency,
    strategicTags: tags,
  }
}

export function computeCollapseDistance(
  hp: number,
  maxHp: number,
  energy: number,
  maxEnergy: number,
  tier: FunctionalTier,
  opponentDamageCapacity: number,
  /**
   * V31 F1: engine-aligned ADDITIVE reaction bonus (flat +2 / +1 / 0).
   * Replaces the old multiplicative amplifier. See core/src/base/skill.ts:963-997.
   */
  opponentReactionBonus: number,
): number {
  const hpRatio = hp / Math.max(1, maxHp)
  const opponentThreat = opponentDamageCapacity + Math.max(0, opponentReactionBonus)

  const collapseHpThreshold = tier === "core" ? 0.40
    : tier === "tactical" ? 0.25
    : 0.15

  const burstUrgencyShift = (energy >= maxEnergy && maxEnergy > 0) ? 0.15 : 0

  const destabilizeProbability = Math.min(1.0, opponentThreat / Math.max(1, hp))
  const effectiveThreshold = collapseHpThreshold + burstUrgencyShift
  const adjustedHpRatio = Math.max(0, hpRatio - effectiveThreshold) / Math.max(0.01, 1 - effectiveThreshold)
  const collapseDistance = adjustedHpRatio * (1 - destabilizeProbability)

  return Math.max(0, Math.min(1, collapseDistance))
}

export function burstWindowUrgency(
  energy: number,
  maxEnergy: number,
  hp: number,
  opponentDamageCapacity: number,
  hasReactionChainSetup: boolean,
): number {
  const energyGap = (maxEnergy || 3) - energy
  const hpRatio = hp / Math.max(1, hp || 10)
  const safeHp = Math.max(1, hp)

  if (energyGap >= 3) return 0.5

  const survivalRisk = Math.min(1, opponentDamageCapacity / safeHp)
  const deferValue = hasReactionChainSetup ? 0.3 : 0.0

  if (energyGap <= 1) {
    if (survivalRisk >= 0.8) {
      return 3.0 - deferValue
    }
    if (survivalRisk >= 0.4) {
      return 1.8
    }
    return 1.2 + deferValue
  }

  if (energyGap === 2) {
    return 1.0
  }

  return 1.0
}

function computeBurstUrgencySimple(
  energy: number,
  maxEnergy: number,
  opponentDamageCapacity: number,
  hp: number,
  hasReactionChainSetup: boolean,
): number {
  return burstWindowUrgency(energy, maxEnergy, hp, opponentDamageCapacity, hasReactionChainSetup)
}

/**
 * V31 F1: engine-aligned ADDITIVE reaction-bonus estimate (flat +2 / +1 / 0).
 *
 * Replaces the legacy multiplicative `estimateReactionAmplifier`. The engine
 * applies reaction damage as a FLAT increment (core/src/base/skill.ts:963-997):
 *   - Melt / Vaporize / Overloaded                 → +2
 *   - Superconduct / ElectroCharged / Frozen /
 *     Crystallize(×4) / Burning / Bloom / Quicken   → +1
 *   - Swirl / others                                → +0
 *
 * Returns the additional flat damage an opponent's single attack can gain by
 * reacting against our active character's current aura.
 */
export function estimateReactionBonusFlat(
  opponent: ObservationV1["opponent"] | null | undefined,
  selfActiveAura: number | null,
): number {
  if (!opponent) return 0

  const elementSet = new Set(
    opponent.characters
      .filter((c) => c.alive)
      .map((c) => getElementFromDefinitionId(c.definition_id))
      .filter((e): e is string => e !== null),
  )

  // No aura on our active → opponent at most applies an element, no immediate reaction.
  const aura = selfActiveAura && selfActiveAura !== 0 ? numberToElement(selfActiveAura) : null
  return reactionBonusForPair(aura, elementSet)
}

/**
 * Pure reaction-pairing → flat bonus (engine-aligned). Extracted for testability
 * (does not depend on the character→element data map). See estimateReactionBonusFlat.
 */
export function reactionBonusForPair(
  aura: string | null,
  oppElements: ReadonlySet<string>,
): number {
  if (!aura) return 0

  // Amplifying reactions (+2): melt / vaporize / overloaded
  const canAmplify =
    (aura === "hydro" && oppElements.has("pyro")) || // vaporize
    (aura === "pyro" && oppElements.has("hydro")) || // vaporize
    (aura === "cryo" && oppElements.has("pyro")) || // melt
    (aura === "pyro" && oppElements.has("cryo")) || // melt
    (aura === "pyro" && oppElements.has("electro")) || // overloaded
    (aura === "electro" && oppElements.has("pyro")) // overloaded
  if (canAmplify) return 2

  // Transformative reactions (+1): superconduct / electro-charged / frozen / crystallize / burning / bloom / quicken
  const canTransform =
    (aura === "cryo" && oppElements.has("electro")) || // superconduct
    (aura === "electro" && oppElements.has("cryo")) || // superconduct
    (aura === "hydro" && oppElements.has("electro")) || // electro-charged
    (aura === "electro" && oppElements.has("hydro")) || // electro-charged
    (aura === "hydro" && oppElements.has("cryo")) || // frozen
    (aura === "cryo" && oppElements.has("hydro")) || // frozen
    oppElements.has("geo") || // crystallize (any element aura + geo)
    (aura === "dendro" &&
      (oppElements.has("pyro") || oppElements.has("hydro") || oppElements.has("electro"))) || // burning / bloom / quicken
    ((aura === "pyro" || aura === "hydro" || aura === "electro") && oppElements.has("dendro"))
  if (canTransform) return 1

  return 0
}

/**
 * @deprecated V31 F1 — multiplicative amplifier is WRONG (engine uses flat
 * additive bonus). Use {@link estimateReactionBonusFlat}. Kept only as a thin
 * shim during migration; do not use in new code.
 */
export function estimateReactionAmplifier(
  opponent: ObservationV1["opponent"] | null | undefined,
): number {
  if (!opponent) return 1.0

  const elements = opponent.characters
    .filter((c) => c.alive)
    .map((c) => getElementFromDefinitionId(c.definition_id))
    .filter((e): e is string => e !== null)
  const elementSet = new Set(elements)

  const oppActive = opponent.characters.find((c) => c.is_active)
  const activeAura = oppActive?.aura != null && oppActive.aura !== 0
    ? numberToElement(oppActive.aura)
    : null

  let amplifier = 1.0

  if (elementSet.has("pyro") && elementSet.has("hydro")) amplifier = Math.max(amplifier, 2.0)
  if (elementSet.has("pyro") && elementSet.has("cryo")) amplifier = Math.max(amplifier, 2.0)
  if (elementSet.has("electro") && elementSet.has("hydro")) amplifier = Math.max(amplifier, 1.5)
  if (elementSet.has("electro") && elementSet.has("cryo")) amplifier = Math.max(amplifier, 1.5)
  if (elementSet.has("electro") && elementSet.has("pyro")) amplifier = Math.max(amplifier, 1.5)
  if (elementSet.has("anemo") && elementSet.size >= 2) amplifier = Math.max(amplifier, 1.5)

  return amplifier
}

function numberToElement(aura: number): string | null {
  const map: Record<number, string> = {
    1: "cryo", 2: "hydro", 3: "pyro", 4: "electro",
    5: "anemo", 6: "geo", 7: "dendro",
  }
  return map[aura] ?? null
}

export function estimateOpponentDamageCapacity(
  observation: ObservationV1 | null | undefined,
): number {
  if (!observation) return 5
  return observation.derived.opp_damage_capacity_now ?? 5
}

export function computeAvgCollapseDistance(
  characters: Array<{
    definition_id: number
    alive: boolean
    health: number
    max_health: number
    energy: number
    max_energy: number
  }>,
  deckArchetype: DeckArchetype,
  opponentArchetype: OpponentArchetype,
  gamePhase: GamePhaseKind,
  opponentDamageCapacity: number,
  opponentReactionBonus: number,
): number {
  const aliveChars = characters.filter((c) => c.alive)
  if (aliveChars.length === 0) return 0

  const assessments = aliveChars.map((c) =>
    assessCharacterValue(c, deckArchetype, opponentArchetype, gamePhase, opponentDamageCapacity, opponentReactionBonus),
  )

  return assessments.reduce((sum, a) => sum + a.collapseDistance, 0) / assessments.length
}

export function detectGamePhaseFromObservation(
  observation: ObservationV1 | null | undefined,
  gamePlanState: { setup_completion: number; current_phase: GamePhaseKind } | null | undefined,
): GamePhaseKind {
  if (gamePlanState) {
    const setupCompletion = gamePlanState.setup_completion
    const currentPhase = gamePlanState.current_phase

    if (!observation) return currentPhase

    const firstKo = observation.opponent.characters.some((c) => !c.alive) ||
      observation.self.characters.some((c) => !c.alive)
    const selfBurstOnline = observation.self.characters.some(
      (c) => c.alive && c.energy >= c.max_energy && c.max_energy > 0,
    )

    if (firstKo && setupCompletion < 0.5) {
      return "execution"
    }

    if (selfBurstOnline && setupCompletion >= 0.3) {
      return "execution"
    }

    return currentPhase
  }

  if (!observation) return "transition"
  const round = observation.point.round_number
  if (round <= 2) return "setup"
  if (round >= 6) return "closing"
  return "transition"
}

export interface TurnPlan {
  plannedActionSequence: string[]
  planKind: string
  diceRequirements: Map<number, number>
  protectedCharacterIds: number[]
  hasBurstWindow: boolean
  hasReactionWindow: boolean
}

export interface DiceReservation {
  reserved: Map<number, number>
  estimatedRemainingActions: number
  reservedForReason: string
  tuningSuggested: boolean
  tuningTarget: number | null
}

export function generateTurnPlan(
  observation: ObservationV1 | null | undefined,
  macroPlan: RuntimeMacroPlan | null | undefined,
  reactionChainMatches: ReactionChainMatchRef[],
): TurnPlan {
  if (!observation) {
    return {
      plannedActionSequence: [],
      planKind: "none",
      diceRequirements: new Map(),
      protectedCharacterIds: [],
      hasBurstWindow: false,
      hasReactionWindow: false,
    }
  }

  const selfChars = observation.self.characters
  const aliveChars = selfChars.filter((c) => c.alive)
  const protectedIds: number[] = []

  const hasBurstWindow = aliveChars.some(
    (c) => c.energy >= c.max_energy && c.max_energy > 0,
  )
  const hasReactionWindow = reactionChainMatches.some(
    (m) => m.executable && m.completed_steps > 0,
  )

  if (hasBurstWindow) {
    const protectedBurstChars = aliveChars.filter((c) => c.energy >= c.max_energy && c.max_energy > 0)
    for (const burstChar of protectedBurstChars) {
      const hpRatio = burstChar.health / Math.max(1, burstChar.max_health)
      if (hpRatio < 0.5) {
        protectedIds.push(burstChar.definition_id)
      }
    }
  }

  const plannedSequence: string[] = []
  const diceRequirements = new Map<number, number>()

  if (macroPlan) {
    plannedSequence.push(...macroPlan.prefer_action_cases.slice(0, 3))
    // Populate diceRequirements for planned skill actions
    const activeIdx = observation.self.active_character_index
    if (activeIdx != null && plannedSequence.includes("useSkill")) {
      const activeChar = observation.self.characters[activeIdx]
      if (activeChar?.definition_id) {
        const el = getElementFromDefinitionId(activeChar.definition_id)
        const diceType = el ? ELEMENT_DICE_MAP_NUMERIC[el] : undefined
        if (diceType !== undefined) {
          const cnt = observation.self.dice.counts_by_type
          const have = Number(cnt?.[diceType] ?? 0) + Number(cnt?.[8] ?? 0) // 8=DiceType.Omni
          if (have < 3) diceRequirements.set(diceType, 3 - have)
        }
      }
    }
  }

  return {
    plannedActionSequence: plannedSequence,
    planKind: macroPlan?.kind ?? "none",
    diceRequirements,
    protectedCharacterIds: protectedIds,
    hasBurstWindow,
    hasReactionWindow,
  }
}

export function computeDiceReservation(
  observation: ObservationV1 | null | undefined,
  turnPlan: TurnPlan | null | undefined,
): DiceReservation {
  if (!observation || !turnPlan) {
    return {
      reserved: new Map(),
      estimatedRemainingActions: 0,
      reservedForReason: "none",
      tuningSuggested: false,
      tuningTarget: null,
    }
  }

  const diceRequirements = turnPlan.diceRequirements
  const reserved = new Map<number, number>()
  for (const [type, count] of diceRequirements) {
    reserved.set(type, count)
  }

  const estimatedRemainingActions = Math.max(1, observation.self.dice.total_count - 1)
  const planTuningSuggested = diceRequirements.size > 0
  let planTuningTarget: number | null = null

  if (diceRequirements.size > 0) {
    let maxNeeded = 0
    let neededType = 0
    for (const [type, count] of diceRequirements) {
      if (count > maxNeeded) {
        maxNeeded = count
        neededType = type
      }
    }
    planTuningTarget = neededType
  }

  // Board-driven tuning: 立本(322008)/桓那兰那(321011) 收集未满 → 建议调和
  const boardTuning = detectDiceCollectorTuning(observation)

  const tuningSuggested = planTuningSuggested || boardTuning.suggested
  const tuningTarget = planTuningTarget ?? boardTuning.target

  return {
    reserved,
    estimatedRemainingActions,
    reservedForReason: turnPlan.planKind,
    tuningSuggested,
    tuningTarget,
  }
}

export type ReactionChainMatchRef = {
  executable: boolean
  completed_steps: number
}

import type { RuntimeMacroPlan } from "./types.js"

export function inferOpponentArchetype(observation: ObservationV1 | null | undefined): OpponentArchetype {
  if (!observation) return "unknown"
  const elements = observation.opponent.characters
    .filter((c) => c.alive)
    .map((c) => getElementFromDefinitionId(c.definition_id))
    .filter((e): e is string => e !== null)

  const has = (el: string) => elements.includes(el)

  if (has("pyro") && has("cryo")) return "pyro_cryo"
  if (has("pyro") && has("hydro")) return "pyro_hydro"
  if (has("electro") && has("pyro")) return "electro_pyro"
  if (has("electro") && has("hydro")) return "electro_hydro"
  if (has("electro") && has("cryo")) return "electro_cryo"
  if (has("electro") && has("dendro")) return "electro_dendro"
  if (has("dendro") && has("pyro")) return "dendro_pyro"
  if (has("dendro") && has("hydro")) return "dendro_hydro"
  if (has("anemo")) return "anemo_swirl"
  if (has("geo")) return "geo_crystallize"

  return "unknown"
}