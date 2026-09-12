// Copyright (C) 2024-2025 Guyutongxue
//
// Skill economic efficiency scoring.
// Evaluates character skills by damage-per-die and energy efficiency,
// within the context of the deck\'s available dice generation and energy
// acceleration.

import type { DeckCharacterFullInfo, CharacterSkillData, DeckCardInfo } from "../heuristics"

export interface SkillEfficiency {
  characterName: string
  skills: Array<{
    name: string
    type: string
    /** Damage per die spent */
    dmgPerDie: number
    /** Total dice cost */
    diceCost: number
    /** Energy cost (for bursts) */
    energyCost: number
    /** Base damage from description */
    estimatedDamage: number
    /** Expected reaction bonus (based on deck element coverage) */
    reactionBonus: number
    /** Overall efficiency score (higher = better) */
    efficiencyScore: number
  }>
  /** Best skill for damage output */
  bestDamageSkill: string | null
  /** Best skill for energy gain (if applicable) */
  bestEnergySkill: string | null
}

/** Reaction bonus table */
const REACTION_BONUS: Record<string, Record<string, number>> = {
  "火": { "冰": 2, "水": 2, "雷": 2, "草": 1 },
  "水": { "火": 2, "冰": 1, "雷": 1, "草": 1 },
  "冰": { "火": 2, "雷": 1, "水": 1 },
  "雷": { "火": 2, "冰": 1, "水": 1, "草": 1 },
  "风": { "火": 0, "水": 0, "冰": 0, "雷": 0 },
  "岩": { "火": 1, "水": 1, "冰": 1, "雷": 1 },
  "草": { "火": 1, "水": 1, "雷": 1 },
}

const SKILL_TYPE_ORDER: Record<string, number> = {
  "普通攻击": 0,
  "元素战技": 1,
  "元素爆发": 2,
  "被动技能": 3,
}

function estimateDamageFromDescription(
  description: string,
): number {
  const dmgMatch = description.match(/造成(\d+)点/)
  if (dmgMatch) return parseInt(dmgMatch[1], 10)
  return 2 // default: most NAs are 2 damage
}

function estimateDiceCost(costs: Array<{ type: string; count: number }>): number {
  return costs
    .filter((c) => c.type !== "GCG_COST_ENERGY")
    .reduce((sum, c) => sum + c.count, 0)
}

function estimateEnergyCost(costs: Array<{ type: string; count: number }>): number {
  const energy = costs.find((c) => c.type === "GCG_COST_ENERGY")
  return energy?.count ?? 0
}

function computeReactionBonus(
  skillElement: string,
  deckElements: string[],
  isPhysicalDamage: boolean,
): number {
  if (isPhysicalDamage) return 0

  // Find the best reaction bonus this skill can trigger
  let bestBonus = 0
  for (const deckEl of deckElements) {
    if (deckEl === skillElement) continue
    const bonus = REACTION_BONUS[skillElement]?.[deckEl]
    if (bonus !== undefined && bonus > bestBonus) {
      bestBonus = bonus
    }
  }
  return bestBonus
}

export function computeSkillEfficiency(
  characters: DeckCharacterFullInfo[],
  cards: DeckCardInfo[],
): SkillEfficiency[] {
  const deckElements = characters.flatMap((c) => c.elements)

  // Detect energy acceleration cards in deck
  const hasEnergyAccel = cards.some(
    (c) =>
      /获得.*充能|充能\+\d+/.test(c.description || "") ||
      c.name.includes("本大爷") ||
      c.name.includes("星天之兆"),
  )

  return characters.map((ch) => {
    const chElements = ch.elements
    const mainElement = chElements[0] ?? "物理"

    const skills = ch.skills
      .filter((s) => !s.hidden)
      .sort(
        (a, b) =>
          (SKILL_TYPE_ORDER[a.type] ?? 99) -
          (SKILL_TYPE_ORDER[b.type] ?? 99),
      )
      .map((s) => {
        const baseDamage = estimateDamageFromDescription(s.description || s.name)
        const diceCost = estimateDiceCost(s.playCost)
        const energyCostValue = estimateEnergyCost(s.playCost)

        // Energy cost is amortized: need N rounds of NA to generate it
        // Each NA costs ~3 dice → energyCost * 3 dice effective cost
        const totalEffectiveCost =
          diceCost + (hasEnergyAccel ? energyCostValue * 1.5 : energyCostValue * 3)

        const isPhysical =
          baseDamage > 0 &&
          !s.description?.includes("水元素") &&
          !s.description?.includes("冰元素") &&
          !s.description?.includes("火元素") &&
          mainElement !== "物理"

        const reactionBonus = isPhysical
          ? 0
          : computeReactionBonus(
              mainElement,
              deckElements.filter((e) => e !== mainElement),
              false,
            )

        const totalDamage = baseDamage + reactionBonus
        const dmgPerDie =
          totalEffectiveCost > 0
            ? Math.round((totalDamage / totalEffectiveCost) * 100) / 100
            : totalDamage

        // Efficiency score: dmgPerDie weighted, plus bonus for low energy cost
        const efficiencyScore =
          dmgPerDie * 0.7 +
          (energyCostValue === 0 ? 0.5 : energyCostValue <= 2 ? 0.3 : 0.1)

        return {
          name: s.name,
          type: s.type,
          dmgPerDie,
          diceCost,
          energyCost: energyCostValue,
          estimatedDamage: baseDamage,
          reactionBonus,
          efficiencyScore: Math.round(efficiencyScore * 100) / 100,
        }
      })

    const bestDamage = skills
      .filter((s) => s.estimatedDamage > 0)
      .sort((a, b) => b.efficiencyScore - a.efficiencyScore)[0]

    const bestEnergy = skills
      .filter(
        (s) => s.type === "元素战技",
      )
      .sort((a, b) => a.diceCost - b.diceCost)[0]

    return {
      characterName: ch.name,
      skills,
      bestDamageSkill: bestDamage?.name ?? null,
      bestEnergySkill: bestEnergy?.name ?? null,
    }
  })
}
