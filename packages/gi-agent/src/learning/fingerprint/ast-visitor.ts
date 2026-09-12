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
 * V30 Stage 1.A — Static fingerprint extraction from `GameData`.
 *
 * Reads the resolved `GameData` returned by `getData(version)` and emits
 * one `EntityFingerprint` per definition with **static-only** fields
 * populated:
 *   - kind, raw_tags, meta (element/weapon/parent_character_id/...)
 *   - cost (from InitiativeSkillConfig.requiredCost)
 *   - references (definitions referenced by id, e.g. character → skills)
 *
 * Dynamic fields (damage, heal, dice_gen, draws_cards, creates...) are
 * left zeroed; the sentinel-extractor (stage 1.B) fills them by running
 * `ActionPreviewer.modifyAndPreview` on synthetic states.
 */

import type {
  CharacterDefinition,
  EntityDefinition,
  GameData,
} from "@gi-tcg/core"
import type {
  EntityFingerprint,
  FingerprintCost,
  FingerprintKind,
} from "./types.js"
import { FINGERPRINT_SCHEMA_VERSION } from "./types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ZERO_COST: FingerprintCost = {
  total_dice: 0,
  aligned: 0,
  energy: 0,
  void: 0,
  specific: {},
  is_fast: false,
}

/** Convert ReadonlyDiceRequirement (Map<DiceType, number>) → FingerprintCost. */
function buildCost(
  requiredCost: ReadonlyMap<number, number> | null | undefined,
  isFast: boolean,
): FingerprintCost {
  if (!requiredCost) return { ...ZERO_COST, specific: {}, is_fast: isFast }

  // DiceType enum (from @gi-tcg/typings):
  //   0 = void/any, 1-7 = element colours, 8 = omni,
  //   9 = aligned (same colour), 10 = energy, 11 = legend marker
  const result: FingerprintCost = {
    total_dice: 0,
    aligned: 0,
    energy: 0,
    void: 0,
    specific: {},
    is_fast: isFast,
  }
  for (const [type, count] of requiredCost) {
    if (count <= 0) continue
    if (type === 10) {
      result.energy = count
    } else if (type === 9) {
      result.aligned = count
      result.total_dice += count
    } else if (type === 0) {
      result.void = count
      result.total_dice += count
    } else if (type === 8) {
      result.void += count
      result.total_dice += count
    } else if (type === 11) {
      // legend marker — not a real dice cost
    } else {
      result.specific[type] = (result.specific[type] ?? 0) + count
      result.total_dice += count
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

function classifyEntity(def: EntityDefinition): FingerprintKind {
  const tags = def.tags as readonly string[]
  switch (def.type) {
    case "eventCard":
      if (tags.includes("legend")) return "card_legend"
      if (tags.includes("food")) return "card_food"
      if (tags.includes("talent")) return "card_talent"
      return "card_event"
    case "support":
      return "card_support"
    case "equipment":
      return tags.includes("talent") ? "card_talent" : "card_equipment"
    case "summon":
      return "summon"
    case "status":
      return "status"
    case "combatStatus":
      return "combat_status"
    default:
      return "card_other"
  }
}

interface SkillLike {
  readonly id: number
  readonly triggerOn: string
  readonly skillType: string | null
  readonly initiativeSkillConfig: {
    readonly requiredCost: ReadonlyMap<number, number>
    readonly gainEnergy: boolean
    readonly shouldFast: boolean
  } | null
}

function classifySkill(skill: SkillLike): FingerprintKind {
  if (skill.triggerOn !== "initiative" || !skill.initiativeSkillConfig) {
    return "skill_passive"
  }
  switch (skill.skillType) {
    case "normal":
      return "skill_normal"
    case "elemental":
      return "skill_elemental"
    case "burst":
      return "skill_burst"
    case "technique":
      return "skill_technique"
    case "playCard":
      return "skill_play_card"
    default:
      return "skill_passive"
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag inference
// ─────────────────────────────────────────────────────────────────────────────

const ELEMENT_TAGS = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"] as const
const WEAPON_TAGS = ["sword", "claymore", "pole", "catalyst", "bow", "otherWeapon"] as const

function findTag(tags: readonly string[], pool: readonly string[]): string | undefined {
  for (const t of tags) {
    if (pool.includes(t)) return t
  }
  return undefined
}

function readVarInitial(
  varConfigs: Record<string, { initialValue: number }> | undefined,
  name: string,
): number | undefined {
  return varConfigs?.[name]?.initialValue
}

function summarizeVarInitials(
  varConfigs: Record<string, { initialValue: number }> | undefined,
  exclude: ReadonlySet<string>,
  limit = 6,
): Record<string, number> {
  if (!varConfigs) return {}
  const out: Record<string, number> = {}
  let n = 0
  for (const [k, v] of Object.entries(varConfigs)) {
    if (exclude.has(k)) continue
    out[k] = v.initialValue
    if (++n >= limit) break
  }
  return out
}

const CHARACTER_VAR_EXCLUDED = new Set([
  "health", "energy", "maxHealth", "maxEnergy", "aura", "alive",
])

// ─────────────────────────────────────────────────────────────────────────────
// Stable hash
// ─────────────────────────────────────────────────────────────────────────────

function hashSnapshot(parts: unknown[]): string {
  const text = JSON.stringify(parts)
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// ─────────────────────────────────────────────────────────────────────────────
// Static fingerprint constructors
// ─────────────────────────────────────────────────────────────────────────────

function emptyFingerprint(
  defId: number,
  kind: FingerprintKind,
  gameVersion: string,
): EntityFingerprint {
  return {
    schema_version: FINGERPRINT_SCHEMA_VERSION,
    definition_id: defId,
    kind,
    game_version: gameVersion,
    source: "static_definition",
    raw_tags: [],
    meta: {},
    cost: { ...ZERO_COST, specific: {} },
    damage: {
      amount: 0,
      type: null,
      hits_all_opp: false,
      has_piercing: false,
      triggers_reaction: null,
      hit_count: 0,
    },
    heal: { amount: 0, scope: null, hit_count: 0 },
    dice_gen: { by_type: {}, total_count: 0 },
    energy: { self_active: 0, self_other: 0, self_active_zeroed: false },
    creates: { summons: [], supports: [], combat_statuses: [], character_statuses: [] },
    draws_cards: 0,
    opponent_hand_disturb: 0,
    switches_active: false,
    forces_opp_switch: false,
    references: [],
    source_hash: "",
  }
}

function fingerprintCharacter(
  def: CharacterDefinition,
  gameVersion: string,
): EntityFingerprint {
  const fp = emptyFingerprint(def.id, "character", gameVersion)
  fp.raw_tags = [...def.tags]
  fp.meta = {
    element: findTag(def.tags as readonly string[], ELEMENT_TAGS),
    weapon: findTag(def.tags as readonly string[], WEAPON_TAGS),
    max_health: readVarInitial(def.varConfigs as never, "maxHealth"),
    max_energy: readVarInitial(def.varConfigs as never, "maxEnergy"),
    var_initials: summarizeVarInitials(def.varConfigs as never, CHARACTER_VAR_EXCLUDED),
  }
  fp.references = def.skills.map((s) => s.id)
  if (def.associatedNightsoulsBlessing) {
    fp.references.push(def.associatedNightsoulsBlessing.id)
  }
  fp.source_hash = hashSnapshot([def.id, def.tags, fp.meta])
  return fp
}

function fingerprintSkill(
  skill: SkillLike,
  parentCharId: number,
  gameVersion: string,
): EntityFingerprint {
  const kind = classifySkill(skill)
  const fp = emptyFingerprint(skill.id, kind, gameVersion)

  if (skill.initiativeSkillConfig) {
    const cfg = skill.initiativeSkillConfig
    fp.cost = buildCost(cfg.requiredCost, cfg.shouldFast)
    fp.energy.self_active = cfg.gainEnergy ? 1 : 0
    if (skill.skillType === "burst") {
      fp.energy.self_active_zeroed = true
    }
  }
  fp.meta = { parent_character_id: parentCharId }
  fp.source_hash = hashSnapshot([skill.id, kind, fp.cost, fp.energy])
  return fp
}

function fingerprintEntity(
  def: EntityDefinition,
  gameVersion: string,
): EntityFingerprint {
  const kind = classifyEntity(def)
  const fp = emptyFingerprint(def.id, kind, gameVersion)
  fp.raw_tags = [...(def.tags as readonly string[])]
  fp.meta = {
    visible_var: def.visibleVarName ?? null,
    var_initials: summarizeVarInitials(def.varConfigs as never, new Set(["duration"])),
  }
  fp.references = def.skills.map((s) => s.id)
  fp.source_hash = hashSnapshot([def.id, def.tags, fp.meta])
  return fp
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractStaticOptions {
  gameVersion: string
}

/**
 * Walk a resolved `GameData` and emit one fingerprint per characters / skills
 * (per character) / entities. Only static fields are populated.
 */
export function extractStaticFingerprints(
  data: GameData,
  options: ExtractStaticOptions,
): EntityFingerprint[] {
  const out: EntityFingerprint[] = []
  const seen = new Set<number>()

  for (const def of data.characters.values()) {
    if (seen.has(def.id)) continue
    seen.add(def.id)
    out.push(fingerprintCharacter(def, options.gameVersion))
    for (const skill of def.skills) {
      if (seen.has(skill.id)) continue
      seen.add(skill.id)
      out.push(fingerprintSkill(skill as never as SkillLike, def.id, options.gameVersion))
    }
  }

  for (const def of data.entities.values()) {
    if (seen.has(def.id)) continue
    seen.add(def.id)
    out.push(fingerprintEntity(def, options.gameVersion))
    for (const skill of def.skills) {
      if (seen.has(skill.id)) continue
      seen.add(skill.id)
      out.push(fingerprintSkill(skill as never as SkillLike, def.id, options.gameVersion))
    }
  }

  out.sort((a, b) => a.definition_id - b.definition_id)
  return out
}
