// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Character Skill Temporal Profiles
 *
 * Parses character DSL source files to determine whether a character's
 * elemental skill creates recurring value (summons, self-buffs) that
 * should be deployed early — used as a tiebreaker for chooseActive
 * when all characters have equal HP/energy (game start).
 *
 * Priority: self-buff > summon > cheap-direct > expensive-direct
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface CharacterSkillProfile {
  /** Dice cost of the elemental skill (computed$diceCostSize) */
  diceCost: number
  /** Skill creates a summon (recurring end-phase value) */
  hasSummon: boolean
  /** Skill creates a character status (self-buff with usage ≥ 2) */
  hasSelfStatus: boolean
  /** Skill creates a combat status (team-wide effect) */
  hasCombatStatus: boolean
  /** Higher = better opener */
  openingPriority: number
}

// Regex patterns for DSL parsing
const RE_ELEMENTAL_SKILL = /\.type\("elemental"\)/
const RE_SUMMON = /\.summon\(/
const RE_CHARACTER_STATUS = /\.characterStatus\(/
const RE_COMBAT_STATUS = /\.combatStatus\(/
const RE_SKILL_ID = /@id (\d+)/
const RE_CHARACTER_ID = /@id (\d+)/

let _profileCache: Map<number, CharacterSkillProfile> | null = null

export function loadCharacterSkillProfiles(): Map<number, CharacterSkillProfile> {
  if (_profileCache) return _profileCache

  const map = new Map<number, CharacterSkillProfile>()

  // Character DSL source directories
  const elements = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"]
  // packages/gi-agent/src/knowledge/ → 3 up to packages/ → data/src/characters
  const dataDir = join(
    import.meta.dirname,
    "..", "..", "..",
    "data", "src", "characters"
  )

  for (const element of elements) {
    const elementDir = join(dataDir, element)
    let files: string[]
    try {
      files = readdirSync(elementDir).filter(f => f.endsWith(".ts"))
    } catch {
      continue
    }

    for (const file of files) {
      const content = readFileSync(join(elementDir, file), "utf-8")

      // Find the character definition ID
      const charIdMatch = content.match(
        /export const \w+ = character\((\d+)\)/
      )
      if (!charIdMatch) continue
      const charId = parseInt(charIdMatch[1])

      // Find all skill definitions and their types
      const skillBlocks = extractSkillBlocks(content)

      let elementalSkill: { id: number; hasSummon: boolean; hasSelfStatus: boolean; hasCombatStatus: boolean } | null = null

      for (const block of skillBlocks) {
        if (RE_ELEMENTAL_SKILL.test(block.text)) {
          const idMatch = block.text.match(/skill\((\d+)\)/)
          elementalSkill = {
            id: idMatch ? parseInt(idMatch[1]) : 0,
            hasSummon: RE_SUMMON.test(block.text),
            hasSelfStatus: RE_CHARACTER_STATUS.test(block.text),
            hasCombatStatus: RE_COMBAT_STATUS.test(block.text),
          }
          break
        }
      }

      const hasSummon = elementalSkill?.hasSummon ?? false
      const hasSelfStatus = elementalSkill?.hasSelfStatus ?? false
      const hasCombatStatus = elementalSkill?.hasCombatStatus ?? false

      // Priority: summon (recurring, needs early deploy) > selfStatus (can use immediately) > combatStatus > nothing
      // Summon value compounds over rounds → deploying early maximizes total payoff.
      // Self-buffs can be used same-turn, so they can wait if a summon is available.
      // Tiebreaker: pure summoner (no self-buff) deploys before self-buffing summoner.
      let openingPriority = 0
      if (hasSummon && !hasSelfStatus) openingPriority = 4       // pure summoner — deploy first
      else if (hasSummon && hasSelfStatus) openingPriority = 3   // summon + self-buff — second
      else if (hasSelfStatus) openingPriority = 2                // self-buff only
      else if (hasCombatStatus) openingPriority = 1

      map.set(charId, {
        diceCost: 0, // filled in later from compiled GameData
        hasSummon,
        hasSelfStatus,
        hasCombatStatus,
        openingPriority,
      })
    }
  }

  _profileCache = map
  return map
}

interface SkillBlock {
  text: string
}

/**
 * Extract skill blocks from a character DSL file.
 * Each skill is defined as `export const Name = skill(ID).type(...)...done()`
 */
function extractSkillBlocks(content: string): SkillBlock[] {
  const blocks: SkillBlock[] = []
  // Match skill definitions with optional type annotation
  // export const Name = skill(ID)...  or  export const Name: SkillHandle = skill(ID)...
  const re = /export const \w+(?:\s*:\s*\w+)?\s*=\s*skill\(\d+\)[\s\S]*?\.done\(\)/g
  let match
  while ((match = re.exec(content)) !== null) {
    blocks.push({ text: match[0] })
  }
  return blocks
}

/**
 * Get the skill profile for a character definition ID.
 * Returns null if not found.
 */
export function getCharacterSkillProfile(charDefId: number): CharacterSkillProfile | null {
  loadCharacterSkillProfiles()
  return _profileCache?.get(charDefId) ?? null
}
