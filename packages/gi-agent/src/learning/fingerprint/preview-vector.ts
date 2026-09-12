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
 * V30 Stage 2.A — PreviewMutationVector.
 *
 * Distills `PreviewData[]` (returned by `ActionPreviewer.modifyAndPreview`)
 * into a fixed-length numeric vector preserving information that the
 * existing `summarizePreview` aggregates collapse:
 *
 *   - per-damage-type breakdown (cryo/hydro/pyro/electro/anemo/geo/dendro/physical/piercing)
 *   - per-reaction-type breakdown (melt/vaporize/swirl/...)
 *   - whether any character on either side is killed by the action
 *   - per-target dimension (active vs all-opp vs single)
 *   - opponent hand / pile disturbance distinct from self draw
 *   - support / summon / status / equipment creation counts
 *
 * The vector is *flat numeric* so it can be concatenated to logistic-regression
 * feature vectors directly, and *deterministic* given the same `PreviewData[]`.
 */

import {
  PbDamageType,
  PbEntityArea,
  PbEntityType,
  PbModifyDirection,
  PbMoveEntityReason,
  type PreviewData,
} from "@gi-tcg/typings"

// ─────────────────────────────────────────────────────────────────────────────
// Damage / reaction enumerations (mirror of @gi-tcg/typings DamageType numeric)
// We avoid importing the runtime enum object to keep the vector layout stable
// across protobuf regenerations — only the *values* of PbDamageType matter.
// ─────────────────────────────────────────────────────────────────────────────

/** Damage types we track explicitly. Omits HEAL (separated into heal_*). */
export const DAMAGE_TYPE_SLOTS = [
  "physical",
  "cryo",
  "hydro",
  "pyro",
  "electro",
  "anemo",
  "geo",
  "dendro",
  "piercing",
] as const

export type DamageTypeSlot = (typeof DAMAGE_TYPE_SLOTS)[number]

/**
 * Reaction families. We aggregate the 17 concrete reaction types into 8
 * coarse families to keep dimensionality manageable while keeping the
 * "what kind of reaction" signal:
 *   melt, vaporize, overload/superconduct, ec/frozen, swirl, crystallize,
 *   burning, bloom/quicken
 */
export const REACTION_FAMILY_SLOTS = [
  "melt",
  "vaporize",
  "overload_superconduct",
  "ec_frozen",
  "swirl",
  "crystallize",
  "burning",
  "bloom_quicken",
] as const

export type ReactionFamilySlot = (typeof REACTION_FAMILY_SLOTS)[number]

function reactionFamily(type: number): ReactionFamilySlot | null {
  if (type === 0) return null
  if (type === 101) return "melt"
  if (type === 102) return "vaporize"
  if (type === 103 || type === 104) return "overload_superconduct"
  if (type === 105 || type === 106) return "ec_frozen"
  if (type >= 107 && type <= 110) return "swirl"
  if (type >= 111 && type <= 114) return "crystallize"
  if (type === 115) return "burning"
  if (type === 116 || type === 117) return "bloom_quicken"
  // Lunar reactions: map to closest family
  if (type === 3001) return "ec_frozen"
  if (type === 3002) return "bloom_quicken"
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Vector schema
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewMutationVector {
  /** Whether the previewer produced any data (false → all zeros, may be untrusted). */
  has_preview: boolean
  /** Total damage dealt to opponent characters (sum across all hits). */
  damage_total_opp: number
  /** Total damage dealt to self characters (counter-attack / chain). */
  damage_total_self: number
  /** Largest single damage hit on opponent active. */
  damage_max_opp: number
  /** Per-damage-type breakdown on opponent. */
  damage_by_type: Record<DamageTypeSlot, number>
  /** Number of hit events (multi-hit skills count >1). */
  hit_count: number
  /** Whether any opponent character is killed by this action. */
  opp_killed: boolean
  /** Whether any self character is killed. */
  self_killed: boolean
  /** Number of opponents about to be killed (≥1 means lethal candidate). */
  opp_kill_count: number

  /** Healing dealt to self characters (sum). */
  heal_total_self: number
  /** Healing dealt to teammates (excluding active). */
  heal_total_team: number

  /** Reactions triggered, by family. */
  reactions_by_family: Record<ReactionFamilySlot, number>
  reactions_total: number

  /** Cards drawn into self hand. */
  draws_self: number
  /** Cards moved into opponent hand. */
  draws_opp: number
  /** Cards removed from self hand (other than play / tuning of this action). */
  self_hand_disposed: number
  /** Cards removed from opponent hand (forced discard). */
  opp_hand_disposed: number

  /** Self side support entity creations. */
  creates_support_self: number
  /** Self side summon entity creations. */
  creates_summon_self: number
  /** Self side combat status creations. */
  creates_combat_status_self: number
  /** Self side equipment creations. */
  creates_equipment_self: number
  /** Opponent side combat status creations (e.g. debuff). */
  creates_combat_status_opp: number

  /** Energy delta of self active character. */
  energy_self_active_delta: number
  /** Number of energy gain events on self side (any character). */
  energy_gain_events_self: number

  /** Switch active count on self side caused by this action. */
  switches_self: number
  /** Forced switch on opponent (e.g. swirl-induced or push effect). */
  forced_switches_opp: number

  /** Number of mutations marked as `causeDefeated` (fine-grained kill detection). */
  cause_defeated_count: number
  /**
   * V31 F5: number of opponent characters that triggered "immune to defeat"
   * (HP hit 0 but survived via immunity). Distinct from opp_killed — breaking
   * an immunity is its own structural sub-class (K_immune_break, §0.1.3/§2.2.1).
   */
  opp_immune_triggered: number
  /** V31 F5: number of self characters that triggered immune-to-defeat. */
  self_immune_triggered: number
  /** Total number of mutation events processed (rough complexity proxy). */
  mutation_count: number

  /** True when at least one mutation contained an unrecognised `$case`. */
  has_unknown_mutation: boolean
}

/** Number of scalar slots in PreviewMutationVector when flattened. */
export const PREVIEW_VECTOR_SCALAR_DIM =
  // primitives
  1 + // has_preview
  1 + 1 + 1 + // damage totals/max
  1 + // hit_count
  1 + 1 + 1 + // opp_killed self_killed opp_kill_count
  1 + 1 + // heal_self team
  1 + // reactions_total
  1 + 1 + // draws_self opp
  1 + 1 + // hand_disposed self/opp
  1 + 1 + 1 + 1 + 1 + // creates_*
  1 + 1 + // energy
  1 + 1 + // switches
  1 + 1 + // counts
  1 + 1 + // V31 F5: opp/self immune_triggered
  1 + // unknown
  DAMAGE_TYPE_SLOTS.length + // damage_by_type
  REACTION_FAMILY_SLOTS.length // reactions_by_family

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractPreviewVectorContext {
  /** Side of the actor whose preview is being analysed (0 or 1). */
  perspective: 0 | 1
  /** Set of entity IDs belonging to perspective side (characters + supports + summons + statuses). */
  selfIds: ReadonlySet<number>
  /** Set of entity IDs belonging to opponent side. */
  opponentIds: ReadonlySet<number>
}

function emptyVector(): PreviewMutationVector {
  const dmgByType = {} as Record<DamageTypeSlot, number>
  for (const k of DAMAGE_TYPE_SLOTS) dmgByType[k] = 0
  const reactByFamily = {} as Record<ReactionFamilySlot, number>
  for (const k of REACTION_FAMILY_SLOTS) reactByFamily[k] = 0
  return {
    has_preview: false,
    damage_total_opp: 0,
    damage_total_self: 0,
    damage_max_opp: 0,
    damage_by_type: dmgByType,
    hit_count: 0,
    opp_killed: false,
    self_killed: false,
    opp_kill_count: 0,
    heal_total_self: 0,
    heal_total_team: 0,
    reactions_by_family: reactByFamily,
    reactions_total: 0,
    draws_self: 0,
    draws_opp: 0,
    self_hand_disposed: 0,
    opp_hand_disposed: 0,
    creates_support_self: 0,
    creates_summon_self: 0,
    creates_combat_status_self: 0,
    creates_equipment_self: 0,
    creates_combat_status_opp: 0,
    energy_self_active_delta: 0,
    energy_gain_events_self: 0,
    switches_self: 0,
    forced_switches_opp: 0,
    cause_defeated_count: 0,
    opp_immune_triggered: 0,
    self_immune_triggered: 0,
    mutation_count: 0,
    has_unknown_mutation: false,
  }
}

function damageTypeSlot(dmgType: number): DamageTypeSlot | "heal" {
  // PbDamageType: 0=PHYSICAL, 1=CRYO, 2=HYDRO, 3=PYRO, 4=ELECTRO, 5=ANEMO,
  //               6=GEO, 7=DENDRO, 8=PIERCING, 9=HEAL
  switch (dmgType) {
    case 0: return "physical"
    case 1: return "cryo"
    case 2: return "hydro"
    case 3: return "pyro"
    case 4: return "electro"
    case 5: return "anemo"
    case 6: return "geo"
    case 7: return "dendro"
    case 8: return "piercing"
    case 9: return "heal"
    default: return "physical"
  }
}

/**
 * Build a `PreviewMutationVector` from the engine's `PreviewData[]`.
 *
 * Side ID classification (`selfIds` / `opponentIds`) must already be
 * computed by the caller from the visible `Notification` state — this
 * function does not query the engine.
 */
export function extractPreviewVector(
  previews: ReadonlyArray<PreviewData>,
  ctx: ExtractPreviewVectorContext,
): PreviewMutationVector {
  const v = emptyVector()
  if (previews.length === 0) return v
  v.has_preview = true

  const { perspective, selfIds, opponentIds } = ctx

  for (const p of previews) {
    v.mutation_count++
    const m = p.mutation
    if (!m) continue

    switch (m.$case) {
      case "damage": {
        const d = m.value
        const slot = damageTypeSlot(d.damageType)
        // V31 F5: immune-to-defeat signal. Engine emits healKind=IMMUNE_DEFEATED
        // (2) when an entity hits 0 HP but survives via immunity.
        if (d.healKind === 2 /* HealKind.IMMUNE_DEFEATED */) {
          if (opponentIds.has(d.targetId)) v.opp_immune_triggered++
          else if (selfIds.has(d.targetId)) v.self_immune_triggered++
        }
        if (slot === "heal") {
          if (selfIds.has(d.targetId)) {
            // Active vs team heal disambiguation requires per-character info
            // we don't have here; treat all self heals as `team` and let the
            // caller refine via target id mapping if needed.
            v.heal_total_self += d.value
            v.heal_total_team += d.value
          }
        } else {
          v.hit_count++
          if (opponentIds.has(d.targetId)) {
            v.damage_total_opp += d.value
            v.damage_by_type[slot] += d.value
            if (d.value > v.damage_max_opp) v.damage_max_opp = d.value
            if (d.causeDefeated) {
              v.opp_killed = true
              v.opp_kill_count++
            }
          } else if (selfIds.has(d.targetId)) {
            v.damage_total_self += d.value
            if (d.causeDefeated) {
              v.self_killed = true
            }
          }
          if (d.reactionType !== 0) {
            const fam = reactionFamily(d.reactionType)
            if (fam) {
              v.reactions_by_family[fam]++
              v.reactions_total++
            }
          }
        }
        if (d.causeDefeated) v.cause_defeated_count++
        break
      }
      case "createEntity": {
        const c = m.value
        const isSelf = c.who === perspective
        const where = c.where
        const entType = c.entity?.type
        // PbEntityArea numeric mapping (see typings/src/gen/enums.ts):
        //   SUPPORT=4, SUMMON=5, COMBAT_STATUS=6, HAND=2, CHARACTER=3 (chars)
        if (isSelf) {
          if (where === PbEntityArea.SUPPORT) v.creates_support_self++
          else if (where === PbEntityArea.SUMMON) v.creates_summon_self++
          else if (where === PbEntityArea.COMBAT_STATUS) v.creates_combat_status_self++
          else if (entType === PbEntityType.EQUIPMENT) v.creates_equipment_self++
        } else {
          if (where === PbEntityArea.COMBAT_STATUS) v.creates_combat_status_opp++
        }
        break
      }
      case "moveEntity": {
        const me = m.value
        const isSelfDest = me.toWho === perspective
        if (me.toWhere === PbEntityArea.HAND && me.reason === PbMoveEntityReason.DRAW) {
          if (isSelfDest) v.draws_self++
          else v.draws_opp++
        }
        break
      }
      case "removeEntity": {
        const r = m.value as { who?: number; where?: number }
        if (r.where === PbEntityArea.HAND && typeof r.who === "number") {
          if (r.who === perspective) v.self_hand_disposed++
          else v.opp_hand_disposed++
        }
        break
      }
      case "switchActive": {
        const s = m.value
        if (s.who === perspective) v.switches_self++
        else v.forced_switches_opp++
        break
      }
      case "modifyEntityVar": {
        const e = m.value
        const isSelf = selfIds.has(e.entityId)
        const varName = (e.variableName ?? "").toLowerCase()
        if (varName.includes("energy")) {
          if (isSelf) {
            v.energy_gain_events_self++
            const magnitude = e.variableValue ?? 0
            const delta = e.direction === PbModifyDirection.INCREASE ? magnitude : -magnitude
            v.energy_self_active_delta += delta
          }
        }
        break
      }
      case "applyAura":
      case "transformDefinition":
        // tracked indirectly through damage reactionType / createEntity
        break
      default:
        v.has_unknown_mutation = true
        break
    }
  }

  return v
}

/**
 * Flatten a vector to a fixed-order numeric array. Order is stable and
 * documented; downstream consumers should rely on `flatVectorFeatureNames()`
 * for index → name mapping.
 */
export function flattenPreviewVector(v: PreviewMutationVector): number[] {
  const arr: number[] = [
    v.has_preview ? 1 : 0,
    v.damage_total_opp,
    v.damage_total_self,
    v.damage_max_opp,
    v.hit_count,
    v.opp_killed ? 1 : 0,
    v.self_killed ? 1 : 0,
    v.opp_kill_count,
    v.heal_total_self,
    v.heal_total_team,
    v.reactions_total,
    v.draws_self,
    v.draws_opp,
    v.self_hand_disposed,
    v.opp_hand_disposed,
    v.creates_support_self,
    v.creates_summon_self,
    v.creates_combat_status_self,
    v.creates_equipment_self,
    v.creates_combat_status_opp,
    v.energy_self_active_delta,
    v.energy_gain_events_self,
    v.switches_self,
    v.forced_switches_opp,
    v.cause_defeated_count,
    v.mutation_count,
    v.opp_immune_triggered,
    v.self_immune_triggered,
    v.has_unknown_mutation ? 1 : 0,
  ]
  for (const k of DAMAGE_TYPE_SLOTS) arr.push(v.damage_by_type[k])
  for (const k of REACTION_FAMILY_SLOTS) arr.push(v.reactions_by_family[k])
  return arr
}

export function flatVectorFeatureNames(): string[] {
  const names: string[] = [
    "preview_has",
    "preview_dmg_opp_total",
    "preview_dmg_self_total",
    "preview_dmg_opp_max",
    "preview_hit_count",
    "preview_opp_killed",
    "preview_self_killed",
    "preview_opp_kill_count",
    "preview_heal_self",
    "preview_heal_team",
    "preview_reactions_total",
    "preview_draws_self",
    "preview_draws_opp",
    "preview_self_disposed",
    "preview_opp_disposed",
    "preview_creates_support_self",
    "preview_creates_summon_self",
    "preview_creates_cstatus_self",
    "preview_creates_equip_self",
    "preview_creates_cstatus_opp",
    "preview_energy_self_active_delta",
    "preview_energy_gain_events_self",
    "preview_switches_self",
    "preview_forced_switches_opp",
    "preview_cause_defeated_count",
    "preview_mutation_count",
    "preview_opp_immune_triggered",
    "preview_self_immune_triggered",
    "preview_unknown_mutation",
  ]
  for (const k of DAMAGE_TYPE_SLOTS) names.push(`preview_dmg_${k}`)
  for (const k of REACTION_FAMILY_SLOTS) names.push(`preview_react_${k}`)
  return names
}
