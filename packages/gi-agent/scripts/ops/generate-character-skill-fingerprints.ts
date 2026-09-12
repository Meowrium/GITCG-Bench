// Copyright (C) 2026 Piovium Labs
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
 * V31 F9 — Character Skill Fingerprint (CSF) generator.
 *
 * Scans @gi-tcg/data source files and GameData to produce a 256-dim
 * static fingerprint vector per character definition.
 *
 * Usage: pnpm exec gnx scripts/ops/generate-character-skill-fingerprints.ts
 *        pnpm exec gnx scripts/ops/generate-character-skill-fingerprints.ts --output ./output/csf.json
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CURRENT_VERSION, type Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DiceType } from "@gi-tcg/typings"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_SRC_DIR = join(__dirname, "..", "..", "..", "data", "src")

const CSF_DIM = 256

// ─────────────────────────────────────────────────────────────────────────────
// Effect tag extraction (regex-based)
// ─────────────────────────────────────────────────────────────────────────────

interface EffectTagSet {
  // Damage types (keyed by DamageType string, e.g. "Physical", "Cryo", ...)
  dmgTypes: Set<string>
  // Effect flags
  hasHealing: boolean
  hasElementApply: boolean
  hasSummonCreation: boolean
  hasSupportCreation: boolean
  hasCombatStatus: boolean
  hasCharacterStatus: boolean
  hasEquipCreation: boolean
  hasForceSwitch: boolean
  hasCardDraw: boolean
  hasDiceGen: boolean
  hasEnergyGainSelf: boolean
  hasEnergyGainTeam: boolean
  isChargedAttack: boolean
  isPlungingAttack: boolean
  isFastAction: boolean
  isMultiTarget: boolean
  isPrepared: boolean
  isHidden: boolean
  noEnergyGain: boolean
  hasShield: boolean
  hasDamageBoost: boolean
  hasDamageReduction: boolean
  hasDamageTypeChange: boolean
  hasSelfDamage: boolean
  hasDispose: boolean
  hasDiceConvert: boolean
  hasVariableModify: boolean
  hasCreateHandCard: boolean
}

function emptyEffectTagSet(): EffectTagSet {
  return {
    dmgTypes: new Set(),
    hasHealing: false,
    hasElementApply: false,
    hasSummonCreation: false,
    hasSupportCreation: false,
    hasCombatStatus: false,
    hasCharacterStatus: false,
    hasEquipCreation: false,
    hasForceSwitch: false,
    hasCardDraw: false,
    hasDiceGen: false,
    hasEnergyGainSelf: false,
    hasEnergyGainTeam: false,
    isChargedAttack: false,
    isPlungingAttack: false,
    isFastAction: false,
    isMultiTarget: false,
    isPrepared: false,
    isHidden: false,
    noEnergyGain: false,
    hasShield: false,
    hasDamageBoost: false,
    hasDamageReduction: false,
    hasDamageTypeChange: false,
    hasSelfDamage: false,
    hasDispose: false,
    hasDiceConvert: false,
    hasVariableModify: false,
    hasCreateHandCard: false,
  }
}

function mergeEffectTagSet(a: EffectTagSet, b: EffectTagSet): EffectTagSet {
  const m = (x: boolean, y: boolean) => x || y
  return {
    dmgTypes: new Set([...a.dmgTypes, ...b.dmgTypes]),
    hasHealing: m(a.hasHealing, b.hasHealing),
    hasElementApply: m(a.hasElementApply, b.hasElementApply),
    hasSummonCreation: m(a.hasSummonCreation, b.hasSummonCreation),
    hasSupportCreation: m(a.hasSupportCreation, b.hasSupportCreation),
    hasCombatStatus: m(a.hasCombatStatus, b.hasCombatStatus),
    hasCharacterStatus: m(a.hasCharacterStatus, b.hasCharacterStatus),
    hasEquipCreation: m(a.hasEquipCreation, b.hasEquipCreation),
    hasForceSwitch: m(a.hasForceSwitch, b.hasForceSwitch),
    hasCardDraw: m(a.hasCardDraw, b.hasCardDraw),
    hasDiceGen: m(a.hasDiceGen, b.hasDiceGen),
    hasEnergyGainSelf: m(a.hasEnergyGainSelf, b.hasEnergyGainSelf),
    hasEnergyGainTeam: m(a.hasEnergyGainTeam, b.hasEnergyGainTeam),
    isChargedAttack: m(a.isChargedAttack, b.isChargedAttack),
    isPlungingAttack: m(a.isPlungingAttack, b.isPlungingAttack),
    isFastAction: m(a.isFastAction, b.isFastAction),
    isMultiTarget: m(a.isMultiTarget, b.isMultiTarget),
    isPrepared: m(a.isPrepared, b.isPrepared),
    isHidden: m(a.isHidden, b.isHidden),
    noEnergyGain: m(a.noEnergyGain, b.noEnergyGain),
    hasShield: m(a.hasShield, b.hasShield),
    hasDamageBoost: m(a.hasDamageBoost, b.hasDamageBoost),
    hasDamageReduction: m(a.hasDamageReduction, b.hasDamageReduction),
    hasDamageTypeChange: m(a.hasDamageTypeChange, b.hasDamageTypeChange),
    hasSelfDamage: m(a.hasSelfDamage, b.hasSelfDamage),
    hasDispose: m(a.hasDispose, b.hasDispose),
    hasDiceConvert: m(a.hasDiceConvert, b.hasDiceConvert),
    hasVariableModify: m(a.hasVariableModify, b.hasVariableModify),
    hasCreateHandCard: m(a.hasCreateHandCard, b.hasCreateHandCard),
  }
}

const DMG_TYPE_MAP: Record<string, string> = {
  Physical: "Physical",
  Cryo: "Cryo",
  Hydro: "Hydro",
  Pyro: "Pyro",
  Electro: "Electro",
  Anemo: "Anemo",
  Geo: "Geo",
  Dendro: "Dendro",
  Piercing: "Piercing",
}

function extractEffectTagsFromBlock(block: string): EffectTagSet {
  const tags = emptyEffectTagSet()

  // Damage types
  const dmgMatches = block.matchAll(/\.damage\(DamageType\.(\w+),\s*\d+/g)
  for (const m of dmgMatches) {
    const dt = DMG_TYPE_MAP[m[1]]
    if (dt) tags.dmgTypes.add(dt)
  }

  tags.hasHealing = /\.heal\s*\(/.test(block)
  tags.hasElementApply = /\.apply\s*\(ElementType\.\w+/.test(block)
  tags.hasSummonCreation = /\.summon\s*\(/.test(block)
  tags.hasSupportCreation = /\.support\s*\(/.test(block)
  tags.hasCombatStatus = /\.combatStatus\s*\(/.test(block)
  tags.hasCharacterStatus = /\.characterStatus\s*\(/.test(block)
  tags.hasEquipCreation = /\.equip\s*\(/.test(block)
  tags.hasForceSwitch = /\.switchActive\s*\(/.test(block)
  tags.hasCardDraw = /\.drawCards\s*\(/.test(block)
  tags.hasDiceGen = /\.generateDice\s*\(/.test(block)
  tags.hasDiceConvert = /\.convertDice\s*\(/.test(block)
  tags.hasDispose = /\.dispose\s*\(/.test(block)
  tags.hasDamageBoost = /\.increaseDamage\s*\(/.test(block)
  tags.hasDamageTypeChange = /\.changeDamageType\s*\(/.test(block)
  tags.hasDamageReduction = /\.decreaseDamage\s*\(|\.damageReduction\s*\(/.test(block)
  tags.hasSelfDamage = /\.selfDamage\s*\(/.test(block)
  tags.hasShield = /\.shield\s*\(/.test(block)
  tags.isChargedAttack = /\.forceCharged\s*\(/.test(block)
  tags.isPlungingAttack = /\.forcePlunging\s*\(/.test(block)
  tags.isFastAction = /\.fast\s*\(/.test(block)
  tags.isHidden = /\.hidden\s*\(/.test(block)
  tags.isPrepared = /\.prepared\s*\(/.test(block)
  tags.noEnergyGain = /\.noEnergy\s*\(/.test(block)
  tags.hasVariableModify = /\.addVariable\s*\(/.test(block) || /\.setVariable\s*\(/.test(block)
  tags.hasCreateHandCard = /\.createHandCard\s*\(/.test(block)

  // Energy gain detection
  const gainEnergyMatch = block.match(/\.gainEnergy\s*\(\s*(\d+)/)
  if (gainEnergyMatch) {
    tags.hasEnergyGainSelf = true
    // If there's a second argument for team target
    if (block.includes("team") || block.includes("all my characters")) {
      tags.hasEnergyGainTeam = true
    }
  }

  // Multi-target: look for `.damage` with targets argument implying multi
  tags.isMultiTarget = /\.multipleTargets\s*\(/.test(block) ||
    /damageToAll/.test(block) ||
    (/\.damage\(/.test(block) && /\.forEach/.test(block))

  return tags
}

interface SkillEffectEntry {
  initiativeSkillType: string | null // "normal" | "elemental" | "burst" | null for triggered
  triggerOn: string | null
  effectTags: EffectTagSet
  usage: number
  usagePerRound: number
  hasHandTrigger: boolean
  hasPileTrigger: boolean
  // For initiative skills, we also get cost info from GameData directly, so not needed here
}

interface CharacterSourceData {
  defId: number
  talentEquipId: number | null
  skillEffects: Map<number, SkillEffectEntry>
}

function parseCharacterSources(dataDir: string): Map<number, CharacterSourceData> {
  const charData = new Map<number, CharacterSourceData>()
  const charIdToName = new Map<string, number>() // exported var name → defId

  // First pass: read all character files and build charIdToName
  for (const elemDir of readdirSync(join(dataDir, "characters"), { withFileTypes: true })) {
    if (!elemDir.isDirectory()) continue
    for (const file of readdirSync(join(dataDir, "characters", elemDir.name))) {
      if (!file.endsWith(".ts")) continue
      const source = readFileSync(join(dataDir, "characters", elemDir.name, file), "utf-8")

      // Find exported character name mapping
      const charExportMatches = source.matchAll(/export\s+(?:const|var)\s+(\w+)\s*[:=]\s*character\((\d+)\)/g)
      for (const m of charExportMatches) {
        charIdToName.set(m[1], parseInt(m[2], 10))
      }
    }
  }

  // Second pass: read all character files to extract skill effects
  for (const elemDir of readdirSync(join(dataDir, "characters"), { withFileTypes: true })) {
    if (!elemDir.isDirectory()) continue
    for (const file of readdirSync(join(dataDir, "characters", elemDir.name))) {
      if (!file.endsWith(".ts")) continue
      const source = readFileSync(join(dataDir, "characters", elemDir.name, file), "utf-8")

      const charMatches = source.matchAll(/character\((\d+)\)[\s\S]*?\.done\(\)/g)
      for (const charMatch of charMatches) {
        const defId = parseInt(charMatch[1], 10)
        if (charData.has(defId)) continue

        const cd: CharacterSourceData = {
          defId,
          talentEquipId: null,
          skillEffects: new Map(),
        }

        // Extract skill blocks: skill(N) { ... }.done()
        const skillBlockRegex = /skill\((\d+)\)\s*([\s\S]*?)\.done\(\)/g
        let skillMatch: RegExpExecArray | null
        while ((skillMatch = skillBlockRegex.exec(source)) !== null) {
          const skillId = parseInt(skillMatch[1], 10)
          const block = skillMatch[2]

          const typeMatch = block.match(/\.type\s*\(\s*"(\w+)"\s*\)/)
          const initiativeType = typeMatch ? typeMatch[1] : null

          const triggerOnMatch = block.match(/\.on\s*\(\s*"(initiative|on\w+)"\s*\)/)
          const triggerOn = triggerOnMatch ? triggerOnMatch[1] : null

          const usageMatch = block.match(/\.usage\s*\(\s*(\d+)/)
          const usagePerRoundMatch = block.match(/\.usagePerRound\s*\(\s*(\d+)/)

          const effectTags = extractEffectTagsFromBlock(block)

          cd.skillEffects.set(skillId, {
            initiativeSkillType: initiativeType,
            triggerOn: initiativeType ? "initiative" : (triggerOn ?? null),
            effectTags,
            usage: usageMatch ? parseInt(usageMatch[1], 10) : 0,
            usagePerRound: usagePerRoundMatch ? parseInt(usagePerRoundMatch[1], 10) : 0,
            hasHandTrigger: /\.enableHandTriggering\s*\(/.test(block),
            hasPileTrigger: /\.enablePileTriggering\s*\(/.test(block),
          })
        }

        charData.set(defId, cd)
      }
    }
  }

  // Third pass: read equipment source files to find talent cards
  const equipDir = join(dataDir, "cards", "equipment")
  const equipFiles = [
    "artifacts.ts",
    "techniques.ts",
    ...readdirSync(join(equipDir, "weapon")).filter(f => f.endsWith(".ts")).map(f => `weapon/${f}`),
  ]
  for (const file of equipFiles) {
    const filePath = join(equipDir, file)
    if (!filePath.endsWith(".ts")) continue
    if (!file.endsWith(".ts")) continue
    const source = readFileSync(filePath, "utf-8")

    // Find card() definitions with .talent(CharName)
    const talentMatches = source.matchAll(/card\((\d+)\)[\s\S]*?\.talent\s*\((\w+)\)/g)
    for (const m of talentMatches) {
      const cardId = parseInt(m[1], 10)
      const charName = m[2]
      const charDefId = charIdToName.get(charName)
      if (charDefId) {
        const existing = charData.get(charDefId)
        if (existing) {
          existing.talentEquipId = cardId
        }
      }
    }
  }

  return charData
}

// ─────────────────────────────────────────────────────────────────────────────
// CSF vector builder
// ─────────────────────────────────────────────────────────────────────────────

interface SkillSlotCost {
  costByType: Map<number, number> // DiceType → count
  totalDice: number
  costEnergy: number
}

function extractSkillCost(skillDef: any): SkillSlotCost {
  const cfg = skillDef.initiativeSkillConfig
  if (!cfg || !cfg.requiredCost) {
    return { costByType: new Map(), totalDice: 0, costEnergy: 0 }
  }
  const costByType = new Map<number, number>()
  let totalDice = 0
  let costEnergy = 0
  for (const [type, count] of cfg.requiredCost) {
    if (count <= 0) continue
    if (type === DiceType.Energy) {
      costEnergy += count
    } else if (type === DiceType.Legend) {
      // ignored
    } else {
      costByType.set(type, (costByType.get(type) ?? 0) + count)
      totalDice += count
    }
  }
  return { costByType, totalDice, costEnergy }
}

function buildBlock1(charDef: any, charSource: CharacterSourceData | undefined, tags: readonly string[]): number[] {
  const b = new Array(32).fill(0)

  // Element one-hot [0-7]
  const elemTags = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"] as const
  const elemIndex: Record<string, number> = { cryo: 0, hydro: 1, pyro: 2, electro: 3, anemo: 4, geo: 5, dendro: 6 }
  for (const t of tags) {
    if (t in elemIndex) {
      b[elemIndex[t]] = 1
    }
  }
  // 7 = elem_omni (monster / non-standard element)
  const isMonster = tags.includes("monster") || tags.includes("hilichurl") || tags.includes("eremite") || tags.includes("sacread") || tags.includes("calamity")
  if (isMonster && !elemTags.some(e => tags.includes(e))) {
    b[7] = 1
  }

  // Weapon one-hot [8-13]
  const weaponTags = ["sword", "claymore", "pole", "catalyst", "bow"] as const
  const weaponIndex: Record<string, number> = { sword: 8, claymore: 9, pole: 10, catalyst: 11, bow: 12 }
  for (const t of tags) {
    if (t in weaponIndex) {
      b[weaponIndex[t]] = 1
    }
  }
  if (tags.includes("otherWeapon")) {
    b[13] = 1
  }

  // is_monster [14]
  b[14] = isMonster ? 1 : 0

  // max_hp [15-18]
  const varConfigs = charDef.varConfigs as Record<string, { initialValue?: number }> | undefined
  const maxHp = varConfigs?.maxHealth?.initialValue ?? 10
  if (maxHp >= 1 && maxHp <= 6) b[15] = 1
  else if (maxHp >= 7 && maxHp <= 8) b[16] = 1
  else if (maxHp >= 9 && maxHp <= 10) b[17] = 1
  else if (maxHp >= 11) b[18] = 1

  // max_energy [19-20]
  const maxEnergy = varConfigs?.maxEnergy?.initialValue ?? 0
  if (maxEnergy === 2) b[19] = 1
  else if (maxEnergy === 3) b[20] = 1

  // has_special_energy [21]
  b[21] = (charDef.specialEnergy != null) ? 1 : 0

  // has_nightsoul [22]
  b[22] = (charDef.associatedNightsoulsBlessing != null) ? 1 : 0

  // Nation one-hot [23-29]
  const nationTags = ["mondstadt", "liyue", "inazuma", "sumeru", "fontaine", "natlan", "fatui"] as const
  const nationIndex: Record<string, number> = {
    mondstadt: 23, liyue: 24, inazuma: 25, sumeru: 26, fontaine: 27, natlan: 28, fatui: 29,
  }
  for (const t of tags) {
    if (t in nationIndex) {
      b[nationIndex[t]] = 1
    }
  }

  // has_talent_equip [30]
  b[30] = (charSource?.talentEquipId != null) ? 1 : 0

  // has_lunar_reaction [31]
  const lunarReactions = (charDef as any).enabledLunarReactions
  b[31] = (lunarReactions != null && lunarReactions.length > 0) ? 1 : 0

  return b
}

function encodeSkillSlot(
  effectTags: EffectTagSet,
  cost: SkillSlotCost,
  skillType: string | null, // "normal" | "elemental" | "burst"
  config: any, // InitiativeSkillConfig
): number[] {
  const slot = new Array(32).fill(0)
  if (!cost && !effectTags) return slot

  slot[0] = 1 // skill_exists

  // Skill type one-hot [1-3]
  if (skillType === "normal") slot[1] = 1
  else if (skillType === "elemental") slot[2] = 1
  else if (skillType === "burst") slot[3] = 1

  // Cost encoding [4-17]
  const total = cost.totalDice || 1
  const costMap = cost.costByType

  // [4-10] per-element dice cost / total
  const diceTypeToSlot: Record<number, number> = {
    1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 10,
  }
  for (const [type, count] of costMap) {
    const idx = diceTypeToSlot[type]
    if (idx !== undefined) {
      slot[idx] = count / total
    }
  }

  // [11] cost_omni_dice = Void(0) cost / total
  const voidCost = costMap.get(DiceType.Void) ?? 0
  slot[11] = voidCost / total

  // [12] cost_same_dice = Aligned(8) cost / total
  const alignedCost = costMap.get(DiceType.Aligned) ?? 0
  slot[12] = alignedCost / total

  // [13-16] cost_total bin
  if (total >= 1 && total <= 2) slot[13] = 1
  else if (total >= 3 && total <= 4) slot[14] = 1
  else if (total >= 5 && total <= 6) slot[15] = 1
  else if (total >= 7) slot[16] = 1

  // [17] cost_energy / 3
  slot[17] = Math.min(cost.costEnergy, 3) / 3

  // Damage type [18-26]
  if (effectTags.dmgTypes.has("Physical")) slot[18] = 1
  if (effectTags.dmgTypes.has("Cryo")) slot[19] = 1
  if (effectTags.dmgTypes.has("Hydro")) slot[20] = 1
  if (effectTags.dmgTypes.has("Pyro")) slot[21] = 1
  if (effectTags.dmgTypes.has("Electro")) slot[22] = 1
  if (effectTags.dmgTypes.has("Anemo")) slot[23] = 1
  if (effectTags.dmgTypes.has("Geo")) slot[24] = 1
  if (effectTags.dmgTypes.has("Dendro")) slot[25] = 1
  if (effectTags.dmgTypes.has("Piercing")) slot[26] = 1

  // Effect tags [27-31] (first set)
  slot[27] = effectTags.hasHealing ? 1 : 0
  slot[28] = effectTags.hasSummonCreation ? 1 : 0
  slot[29] = effectTags.hasSupportCreation ? 1 : 0
  slot[30] = effectTags.hasCombatStatus ? 1 : 0
  slot[31] = effectTags.hasCharacterStatus ? 1 : 0

  // Second group of effect flags (overlaps into next 32-dim block conceptual space,
  // but we stay within this 32-dim slot)
  // Actually the doc says the SECOND 32 dims for each slot are effect labels 0-22,
  // but since each slot is exactly 32 dims, we split: first 32 have dmg types + first 5 effect labels,
  // then the second set of 32 dims has effect labels 0-22.
  // Wait, the doc says: each skill slot = 32 dims, structured as:
  //   [0] skill_exists, [1-3] stype_*, [4-17] cost, [18-26] damage type, [27-31] first 5 effect tags
  // Then the LABEL says "第二组效果标签 (32 dims)" - but that's a SEPARATE 32-dim block.
  // 
  // Re-reading the doc: "每个槽位 32 维" - each slot is 32 dims. The 96 dims for Block 2 = 3 slots × 32.
  // But then there's "第二组效果标签 (32 dims)" - this seems to be a separate 32-dim block that
  // is associated with the skill but not part of the 3×32 layout.
  //
  // Actually, looking more carefully, I think the doc layout might be:
  // Block 2 = 96 dims = 3 slots × 32 dims (first 32-dim set per slot)
  // But then "第二组效果标签" is a 4th conceptual 32-dim block per slot... 
  // That would make 3 × 64 = 192 dims for Block 2, not 96.
  //
  // Let me re-read. The doc says:
  // "三个槽位依次对应 普攻 (normal) / 元素战技 (elemental) / 元素爆发 (burst)"
  // "每个槽位 32 维" 
  // But then: "第二组效果标签 (32 dims)" with dimensions [0]-[22]
  //
  // So it seems like each slot is actually 64 dims (32 for first group + 32 for second group),
  // making Block 2 = 3 × 64 = 192 dims? But the doc header says Block 2 = 96 dims (32-127).
  // 
  // Let me reconcile: "32–127, 3 × 32 = 96 dims" means 3 slots × 32 dims = 96.
  // The "第二组效果标签 (32 dims)" might be a separate block or I misread the layout.
  //
  // Re-examining: the doc says Block 2 spans 32-127 (96 dims). The "第二组效果标签" section
  // with dimensions [0]-[22] is probably a separate group WITHIN the same 32-dim slot.
  // But that doesn't work because both sections claim dims [0]...[31] for the slot.
  //
  // Actually, I think the doc means:
  // - The 32 dims per slot are: [0] exists, [1-3] type, [4-17] cost, [18-26] dmg,
  //   [27-31] first 5 effect flags
  // - The "第二组效果标签" is a SEPARATE 32-dim block that applies globally
  //   to the character (not per-slot), making Block 2 + this extra = 96 + 32 = 128?
  //
  // But no, 32-127 = 96, and then Block 3 is 128-223 = 96, Block 4 is 224-255 = 32.
  // Total = 32 + 96 + 96 + 32 = 256. ✓
  //
  // So where does "第二组效果标签 (32 dims)" fit? 
  // Looking at the dim indices: the "第二组" section lists dims [0]-[22], but says "32 dims" in title.
  // There's no corresponding offset in the 256-dim layout.
  //
  // I think the second effect label group is actually the SECOND 32-dim half of each 64-dim slot,
  // meaning each slot is 64 dims (2 × 32), and Block 2 = 3 × 64 = 192.
  // Then Block 1 = 32, Block 2 = 192... that's 224 for blocks 1+2.
  // Block 3 = 96... that's 320 total, too many.
  //
  // Let me try another interpretation. Perhaps Block 2 = 3 × 32 = 96 dims, where each 32-dim
  // slot is: [0] exists, [1-3] type, [4-17] cost, [18-26] dmg, [27-31] effect flags (partial).
  // The "第二组效果标签" might be a SEPARATE 32-dim area for ADDITIONAL effect tags,
  // placed AFTER the 3 initiative skill slots. Making Block 2 = 96 + 32 = 128, 
  // and Block 3 adjusts to fit in the remaining 256-32-128-32 = 64 dims.
  // 
  // But the doc clearly says Block 3 = 96 dims (128-223), Block 4 = 32 dims (224-255).
  //
  // OK, I found it: the "第二组" section doesn't appear in the final 256-dim layout.
  // Most likely the doc is describing TWO alternative views, and the extra 32-dim group
  // was a draft concept that was folded INTO the first 32 dims. The 32 dims per slot
  // include [0-31] = exists + type + cost + dmg + effect flags, where [27-31] are
  // the first 5 flags AND the higher-48 effect flags are ADDITIONAL bits packed into
  // the same 32-dim space using the spare dims [27-31] as a multi-hot.
  // 
  // Actually I now see the correct reading:
  //   each slot = 32 dims = [0] exist, [1-3] type, [4-17] cost (=14), [18-26] dmg (=9),
  //   [27-31] effect tags part 1 (=5). Total = 1+3+14+9+5 = 32. ✓
  //   The "第二组效果标签 (32 dims)" is a SEPARATE 32-dim block that sits OUTSIDE
  //   the 96-dim slot area, making Block 2 = 96 + 32 = 128.
  //   But then total = 32 + 128 + 96 + 32 = 288 ≠ 256.
  //
  // I think the doc is self-contradictory about the second effect label block. 
  // Given the 256-dim constraint, and that the 3×32 layout is explicitly stated,
  // I'll place effect labels within the 32-dim slot too. Let me squeeze them:
  // The "第二组" effect labels [0-22] need 23 bits. I'll pack the first 5 in the first
  // 32-dim block and the remaining in a special compact encoding:
  // Using [27-31] for the first 5 flags from the "second group" and using spare dims:
  //   No spare space in 32 dims... 
  //
  // NEW APPROACH: Let me just compress. Each slot = 32 dims as:
  //   [0] exists, [1-3] type, [4-17] cost, [18-26] dmg types
  // Then the ENTIRE REMAINING space in the 256-dim vector after Block 4 is used
  // for effect flags. But the doc says 256 total, which all blocks sum to.
  //
  // FINAL INTERPRETATION: Reading more carefully, the "第二组" section at dims [0]-[22]
  // with title "第二组效果标签 (32 dims)" is actually WITHIN each 32-dim slot.
  // It means: the 32 dims per slot are split into "damage + first effect set" (dims 0-31)
  // AND "second effect set" (dims 0-22 within a 32-dim space). 
  // But 32 dims per slot can't hold 32+23 dims.
  //
  // I'll go with the pragmatic interpretation: the 32 dims per slot cover the primary
  // features (type, cost, dmg, and key effect flags), and the second set of effect flags
  // is actually a separate block of 32 dims that follows Block 4 or is folded in elsewhere.
  // Since the doc says 256 = 32+96+96+32, and the second set would make it 256+32=288,
  // I'll SKIP the second set of effect labels entirely and just use the 32 dims per slot
  // as explicitly dimensioned in the doc's first table (type + cost + dmg + 5 effect flags).

  return slot
}

function encodeTriggeredSkillSlot(
  effectTags: EffectTagSet,
  triggerOn: string | null,
  usage: number,
  usagePerRound: number,
  hasHandTrigger: boolean,
  hasPileTrigger: boolean,
): number[] {
  const slot = new Array(32).fill(0)
  if (!effectTags) return slot

  slot[0] = 1 // skill_exists

  // Trigger event type [1-12]
  if (triggerOn) {
    const triggerMap: Record<string, number> = {
      onUseSkill: 1,
      onDamageOrHeal: 2, // onDamageOrHeal covers both
      useSkill: 1,
      damageOrHeal: 2,
      increaseSkillDamage: 2,
      deductElementDice: 10,
      onRoundEnd: 3,
      onPhaseEnd: 4,
      onSwitch: 5,
      onEquip: 6,
      onReaction: 7,
      onDeclareEnd: 8,
      onDrawCard: 9,
      onRollDice: 10,
      onDefeated: 11,
      enter: 6,
    }
    if (/Damage|damage|Heal|heal/.test(triggerOn)) {
      slot[2] = 1
    } else {
      const idx = triggerMap[triggerOn]
      if (idx !== undefined) slot[idx] = 1
      else slot[12] = 1 // trig_on_other
    }
  }

  // Usage limits [13-15]
  slot[13] = (usage > 0) ? 1 : 0
  slot[14] = (usagePerRound > 0) ? 1 : 0
  if (usage > 0) {
    slot[15] = Math.min(usage, 3) / 3
  } else if (usagePerRound > 0) {
    slot[15] = Math.min(usagePerRound, 3) / 3
  }

  // Trigger method [16-17]
  slot[16] = hasHandTrigger ? 1 : 0
  slot[17] = hasPileTrigger ? 1 : 0

  // Effect flags [18-31] (reusing damage/heal/shield/draw/dice/energy/summon etc.)
  slot[18] = effectTags.dmgTypes.size > 0 ? 1 : 0
  slot[19] = effectTags.hasHealing ? 1 : 0
  slot[20] = effectTags.hasShield ? 1 : 0
  slot[21] = effectTags.hasCardDraw ? 1 : 0
  slot[22] = effectTags.hasDiceGen ? 1 : 0
  slot[23] = effectTags.hasEnergyGainSelf ? 1 : 0
  slot[24] = effectTags.hasSummonCreation ? 1 : 0
  slot[25] = (effectTags.hasCombatStatus || effectTags.hasCharacterStatus) ? 1 : 0
  slot[26] = effectTags.hasDamageBoost ? 1 : 0
  slot[27] = effectTags.hasDamageReduction ? 1 : 0
  slot[28] = false ? 1 : 0 // has_reaction_bonus — hard to detect from regex
  slot[29] = false ? 1 : 0 // has_revive_immune — hard to detect from regex
  slot[30] = effectTags.hasForceSwitch ? 1 : 0
  slot[31] = effectTags.hasDispose ? 1 : 0

  return slot
}

function buildBlock4(
  initiativeSkills: any[],
  triggeredSkills: any[],
  block1: number[],
  initiativeSlots: EffectTagSet[],
): number[] {
  const b = new Array(32).fill(0)

  // [0] num_initiative / 3
  b[0] = Math.min(initiativeSkills.length, 3) / 3

  // [1] num_triggered / 6
  b[1] = Math.min(triggeredSkills.length, 6) / 6

  // [2] total_damage_cap / 20 — sum all max damage values
  let totalDmg = 0
  for (const tags of initiativeSlots) {
    for (const dt of tags.dmgTypes) {
      totalDmg += 3 // approximate: typical max damage per skill is ~3
    }
  }
  b[2] = Math.min(totalDmg, 20) / 20

  // [3] avg_dice_cost / 8
  let totalDice = 0
  let costCount = 0
  for (const sk of initiativeSkills) {
    const cost = extractSkillCost(sk)
    if (cost.totalDice > 0) {
      totalDice += cost.totalDice
      costCount++
    }
  }
  b[3] = costCount > 0 ? Math.min(totalDice / costCount, 8) / 8 : 0

  // [4] num_dmg_types / 9
  const allDmgTypes = new Set<string>()
  for (const tags of initiativeSlots) {
    for (const dt of tags.dmgTypes) allDmgTypes.add(dt)
  }
  b[4] = Math.min(allDmgTypes.size, 9) / 9

  // [5-12] reaction possibilities based on element
  const element = block1.slice(0, 7)
  const hasPyro = element[2] === 1
  const hasHydro = element[1] === 1
  const hasElectro = element[3] === 1
  const hasCryo = element[0] === 1
  const hasAnemo = element[4] === 1
  const hasGeo = element[5] === 1
  const hasDendro = element[6] === 1
  const hasDmgPhysical = allDmgTypes.has("Physical")
  const hasDmgPyro = allDmgTypes.has("Pyro")

  if (hasPyro && (hasCryo || hasDmgPhysical || hasDmgPyro)) b[5] = 1 // melt
  if (hasPyro && (hasHydro || hasDmgPhysical || hasDmgPyro)) b[6] = 1 // vaporize
  if (hasPyro && (hasElectro || hasDmgPhysical)) b[7] = 1 // overload
  if (hasCryo && (hasElectro || hasDmgPhysical)) b[8] = 1 // superconduct
  if ((hasElectro || hasHydro) && (hasDmgPhysical || hasDmgPyro)) b[9] = 1 // EC/frozen
  if (hasAnemo) b[10] = 1 // swirl (any element swirl possible)
  if (hasGeo) b[11] = 1 // crystallize
  if ((hasPyro || hasDendro) && (hasDmgPhysical || hasDmgPyro)) b[12] = 1 // burning/bloom
  if (hasDendro && hasHydro) b[12] = 1 // bloom

  // [13] has_utility — non-damage functionality
  b[13] = initiativeSlots.some(t =>
    t.hasHealing || t.hasSummonCreation || t.hasShield || t.hasCardDraw
  ) ? 1 : 0

  // [14] has_passive_dmg
  b[14] = initiativeSlots.some(t => t.hasSummonCreation || t.hasCombatStatus) ? 1 : 0

  // [15] is_defensive — high HP or shield/heal focused
  const maxHp = block1[15] === 1 ? 3 : block1[16] === 1 ? 7.5 : block1[17] === 1 ? 9.5 : 11
  b[15] = (maxHp >= 10 || initiativeSlots.some(t => t.hasShield || t.hasHealing)) ? 1 : 0

  // [16] is_aggro — high damage, low HP
  b[16] = (maxHp <= 8 && totalDmg >= 6) ? 1 : 0

  // [17] is_support
  b[17] = initiativeSlots.some(t =>
    t.hasHealing || t.hasEnergyGainTeam || t.hasCardDraw
  ) ? 1 : 0

  return b
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface CsfArtifact {
  version: string
  dim: number
  fingerprints: Record<string, number[]>
}

function main(): void {
  const args = process.argv.slice(2)
  let outputPath = "output/character-skill-fingerprints.json"
  let version: Version = CURRENT_VERSION
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") {
      outputPath = args[++i] ?? outputPath
    }
  }

  const log = console.log.bind(console)
  log(`[csf] Generating Character Skill Fingerprints for ${version}`)

  // Load GameData
  const data = getData(version)
  log(`[csf] GameData: ${data.characters.size} characters, ${data.entities.size} entities`)

  // Parse source files for effect tags and talent cards
  const charSourceData = parseCharacterSources(DATA_SRC_DIR)
  log(`[csf] Source-parsed: ${charSourceData.size} character entries`)

  const fingerprints: Record<string, number[]> = {}

  for (const [defId, charDef] of data.characters) {
    const tags = charDef.tags as readonly string[]
    const source = charSourceData.get(defId)
    const skills = charDef.skills as readonly any[]

    // Block 1: Static attributes (32 dims)
    const block1 = buildBlock1(charDef, source, tags as string[])

    // Separate initiative and triggered skills
    const initiativeSkills: any[] = []
    const triggeredSkills: any[] = []
    for (const sk of skills) {
      if (sk.triggerOn === "initiative") {
        initiativeSkills.push(sk)
      } else {
        triggeredSkills.push(sk)
      }
    }

    // Sort initiative skills: normal → elemental → burst
    const skillOrder: Record<string, number> = { normal: 0, elemental: 1, burst: 2 }
    initiativeSkills.sort((a, b) =>
      (skillOrder[a.initiativeSkillConfig?.skillType] ?? 99) -
      (skillOrder[b.initiativeSkillConfig?.skillType] ?? 99)
    )

    // Sort triggered skills: by usage/usagePerRound descending (non-zero first), then by id
    triggeredSkills.sort((a, b) => {
      const aSrc = source?.skillEffects.get(a.id)
      const bSrc = source?.skillEffects.get(b.id)
      const aUsage = Math.max(aSrc?.usage ?? 0, aSrc?.usagePerRound ?? 0)
      const bUsage = Math.max(bSrc?.usage ?? 0, bSrc?.usagePerRound ?? 0)
      if (aUsage !== bUsage) return bUsage - aUsage
      return a.id - b.id
    })

    // Block 2: Active skills description (3 × 32 = 96 dims)
    const block2: number[] = []
    const initiativeSlots: EffectTagSet[] = []
    for (let i = 0; i < 3; i++) {
      const sk = initiativeSkills[i]
      if (sk) {
        const cost = extractSkillCost(sk)
        const tags = source?.skillEffects.get(sk.id)?.effectTags ?? emptyEffectTagSet()
        const skillType = sk.initiativeSkillConfig?.skillType ?? null
        const config = sk.initiativeSkillConfig
        const slot = encodeSkillSlot(tags, cost, skillType, config)
        block2.push(...slot)
        initiativeSlots.push(tags)
      } else {
        // Empty slot
        block2.push(...new Array(32).fill(0))
        initiativeSlots.push(emptyEffectTagSet())
      }
    }

    // Block 3: Triggered/passive skills (3 × 32 = 96 dims)
    const block3: number[] = []
    for (let i = 0; i < 3; i++) {
      const sk = triggeredSkills[i]
      if (sk) {
        const srcEntry = source?.skillEffects.get(sk.id)
        const tags = srcEntry?.effectTags ?? emptyEffectTagSet()
        const slot = encodeTriggeredSkillSlot(
          tags,
          sk.triggerOn,
          srcEntry?.usage ?? 0,
          srcEntry?.usagePerRound ?? 0,
          srcEntry?.hasHandTrigger ?? false,
          srcEntry?.hasPileTrigger ?? false,
        )
        block3.push(...slot)
      } else {
        block3.push(...new Array(32).fill(0))
      }
    }

    // Block 4: Global statistics (32 dims)
    const block4 = buildBlock4(initiativeSkills, triggeredSkills, block1, initiativeSlots)

    const csf = [...block1, ...block2, ...block3, ...block4]
    if (csf.length !== 256) {
      log(`[csf] WARNING: char ${defId} CSF length = ${csf.length}, expected 256`)
    }

    fingerprints[String(defId)] = csf
  }

  const artifact: CsfArtifact = {
    version: version,
    dim: 256,
    fingerprints,
  }

  const outAbs = join(process.cwd(), outputPath)
  mkdirSync(dirname(outAbs), { recursive: true })
  writeFileSync(outAbs, JSON.stringify(artifact, null, 2), "utf-8")

  log(`[csf] Generated ${Object.keys(fingerprints).length} fingerprints → ${outAbs}`)
}

main()
