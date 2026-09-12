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
 * V30 Stage 2.C — Feature extension: Preview + Fingerprint channels.
 *
 * Purpose:
 *   Append two new groups of features to the canonical ScoringFeatureVector
 *   without modifying its interface, so existing consumers (logistic-reg
 *   weights, EvaluatorPolicy, benchmarks) keep working unchanged.
 *
 *   The training pipeline concatenates `FeatureExtractor.toArray(...)` with
 *   `FeatureExtension.toArray(...)` and trains a single coefficient vector
 *   over the union. At inference time, the same concatenation is applied;
 *   if a weights file lacks extension coefficients, the extension dimensions
 *   are silently ignored (graceful backward-compat).
 *
 * Channels:
 *   1. Preview channel — flattened PreviewMutationVector (~36 dims)
 *      Captures damage breakdown by element, reaction families, kill flags,
 *      creates / draws / energy delta, etc., none of which the existing
 *      `damage_estimate` / `reaction_value` aggregates expose individually.
 *
 *   2. Fingerprint channel — features derived from the actor's primary
 *      definition (skill or card being used) via FingerprintLake (~20 dims)
 *      Captures static-deck-agnostic identity of the action target.
 */

import { FingerprintLake } from "../fingerprint/fingerprint-lake.js"
import {
  PREVIEW_VECTOR_SCALAR_DIM,
  flatVectorFeatureNames,
  flattenPreviewVector,
  type PreviewMutationVector,
} from "../fingerprint/preview-vector.js"
import type { EntityFingerprint } from "../fingerprint/types.js"

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint feature extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Number of scalar slots produced by `flattenFingerprint`. */
export const FINGERPRINT_FLAT_DIM =
  // cost
  1 + 1 + 1 + 1 + 1 + // total_dice, aligned, energy, void, is_fast
  // energy delta
  1 + 1 + 1 + // self_active, self_other, self_active_zeroed
  // kind one-hot (subset: skill_normal/elemental/burst/technique/play_card +
  // card_event/card_support/card_equipment/card_talent/card_food)
  10 +
  // element of parent character (if known): 7 elements + 1 unknown
  8 +
  // weapon (if known): 6 + 1 unknown
  7 +
  // misc flags
  1 + 1 + // has_fingerprint, is_passive
  // raw_tags counts: action / talent / food / legend / shield / barrier
  6

const ELEMENT_INDEX: Record<string, number> = {
  cryo: 0, hydro: 1, pyro: 2, electro: 3, anemo: 4, geo: 5, dendro: 6,
}
const WEAPON_INDEX: Record<string, number> = {
  sword: 0, claymore: 1, pole: 2, catalyst: 3, bow: 4, otherWeapon: 5,
}
const KIND_INDEX_LIST = [
  "skill_normal", "skill_elemental", "skill_burst", "skill_technique", "skill_play_card",
  "card_event", "card_support", "card_equipment", "card_talent", "card_food",
] as const

const RAW_TAG_LIST = ["action", "talent", "food", "legend", "shield", "barrier"] as const

export function flattenFingerprint(fp: EntityFingerprint | undefined): number[] {
  const arr = new Array(FINGERPRINT_FLAT_DIM).fill(0)
  if (!fp) return arr
  let i = 0
  arr[i++] = fp.cost.total_dice
  arr[i++] = fp.cost.aligned
  arr[i++] = fp.cost.energy
  arr[i++] = fp.cost.void
  arr[i++] = fp.cost.is_fast ? 1 : 0
  arr[i++] = fp.energy.self_active
  arr[i++] = fp.energy.self_other
  arr[i++] = fp.energy.self_active_zeroed ? 1 : 0
  // kind one-hot
  for (const k of KIND_INDEX_LIST) {
    arr[i++] = fp.kind === k ? 1 : 0
  }
  // element one-hot (parent or self for character)
  const elementBase = i
  for (let e = 0; e < 7; e++) arr[elementBase + e] = 0
  arr[elementBase + 7] = 1 // unknown default
  if (fp.meta.element) {
    const idx = ELEMENT_INDEX[fp.meta.element]
    if (idx !== undefined) {
      arr[elementBase + idx] = 1
      arr[elementBase + 7] = 0
    }
  }
  i += 8
  // weapon one-hot
  const weaponBase = i
  for (let w = 0; w < 6; w++) arr[weaponBase + w] = 0
  arr[weaponBase + 6] = 1
  if (fp.meta.weapon) {
    const idx = WEAPON_INDEX[fp.meta.weapon]
    if (idx !== undefined) {
      arr[weaponBase + idx] = 1
      arr[weaponBase + 6] = 0
    }
  }
  i += 7
  // misc flags
  arr[i++] = 1 // has_fingerprint
  arr[i++] = fp.kind === "skill_passive" ? 1 : 0
  // raw tag presence
  for (const t of RAW_TAG_LIST) {
    arr[i++] = fp.raw_tags.includes(t) ? 1 : 0
  }
  return arr
}

export function flattenFingerprintFeatureNames(): string[] {
  const names: string[] = [
    "fp_cost_total_dice",
    "fp_cost_aligned",
    "fp_cost_energy",
    "fp_cost_void",
    "fp_is_fast",
    "fp_energy_self_active",
    "fp_energy_self_other",
    "fp_energy_self_active_zeroed",
  ]
  for (const k of KIND_INDEX_LIST) names.push(`fp_kind_${k}`)
  for (let e = 0; e < 7; e++) {
    const elementName = Object.keys(ELEMENT_INDEX).find((k) => ELEMENT_INDEX[k] === e) ?? `e${e}`
    names.push(`fp_element_${elementName}`)
  }
  names.push("fp_element_unknown")
  for (let w = 0; w < 6; w++) {
    const weaponName = Object.keys(WEAPON_INDEX).find((k) => WEAPON_INDEX[k] === w) ?? `w${w}`
    names.push(`fp_weapon_${weaponName}`)
  }
  names.push("fp_weapon_unknown")
  names.push("fp_has_fingerprint")
  names.push("fp_is_passive")
  for (const t of RAW_TAG_LIST) names.push(`fp_tag_${t}`)
  return names
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined extension API
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureExtensionInput {
  /** Preview vector for this candidate. May be undefined if previewer disabled. */
  previewVector?: PreviewMutationVector | null
  /** Engine definition_id of the actor's primary action target:
   *   - useSkill → skill definition id
   *   - playCard / elementalTuning → card definition id
   *   - switchActive / declareEnd → undefined */
  primaryDefinitionId?: number | null
  /** FingerprintLake; if missing, fingerprint channel is all zeros. */
  lake?: FingerprintLake | null
}

export interface FeatureExtensionVector {
  preview: number[]
  fingerprint: number[]
}

/** Total length of the concatenated extension vector. */
export const FEATURE_EXTENSION_DIM = PREVIEW_VECTOR_SCALAR_DIM + FINGERPRINT_FLAT_DIM

export class FeatureExtension {
  /** Build a FeatureExtensionVector from a candidate's preview + lake lookup. */
  static extract(input: FeatureExtensionInput): FeatureExtensionVector {
    const previewArr = input.previewVector
      ? flattenPreviewVector(input.previewVector)
      : new Array(PREVIEW_VECTOR_SCALAR_DIM).fill(0)
    const fp = input.primaryDefinitionId != null && input.lake
      ? input.lake.get(input.primaryDefinitionId)
      : undefined
    const fingerprintArr = flattenFingerprint(fp)
    return { preview: previewArr, fingerprint: fingerprintArr }
  }

  /** Concat preview + fingerprint into a single flat array (preview first). */
  static toArray(ext: FeatureExtensionVector): number[] {
    return [...ext.preview, ...ext.fingerprint]
  }

  /** Ordered feature names matching `toArray` output. */
  static featureNames(): string[] {
    return [...flatVectorFeatureNames(), ...flattenFingerprintFeatureNames()]
  }

  /** Zero vector when extension is disabled. */
  static zero(): FeatureExtensionVector {
    return {
      preview: new Array(PREVIEW_VECTOR_SCALAR_DIM).fill(0),
      fingerprint: new Array(FINGERPRINT_FLAT_DIM).fill(0),
    }
  }
}
