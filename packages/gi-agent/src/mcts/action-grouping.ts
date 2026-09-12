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
 * V31 F6 / V30 §6.3 Step 3 — Progressive-widening action grouping.
 *
 * Buckets candidate actions into the V26 §5.2 / V30 §6.3 action families using
 * the *runtime preview signal* (Stage 2 `PreviewMutationVector`) plus the
 * action's structural type — **no hand-written per-card rules**. Each family is
 * derived purely from what the engine preview says the action does:
 *
 *   lethal          — preview kills an opponent character (opp_kill_count > 0)
 *   immune_break    — preview triggers an opponent immune-to-defeat
 *   reaction_cash   — preview triggers ≥1 elemental reaction with damage
 *   damage          — preview deals opponent damage (no reaction / kill)
 *   energy_build    — self energy gain, little/no damage (normal attacks, etc.)
 *   support_setup   — creates support / summon / combat status (board build)
 *   dice_tuning     — elemental tuning (dice unlock)
 *   switch_pivot    — switch active
 *   pass            — declare end
 *   other           — anything not matching above (card with no preview signal)
 *
 * Progressive widening (`progressiveWidth`) keeps a representative from each
 * present family first, then widens to ≈ ceil(simulations^α) total candidates,
 * preferring higher-prior actions. This caps the engine-transition budget while
 * guaranteeing every behaviourally-distinct family is explored at least once.
 */

import type { ActionInfoWithModification } from "../runtime/adapters/internal-types.js"
import {
  extractPreviewVector,
  type PreviewMutationVector,
} from "../learning/fingerprint/preview-vector.js"

export type ActionGroupKey =
  | "lethal"
  | "immune_break"
  | "reaction_cash"
  | "damage"
  | "energy_build"
  | "support_setup"
  | "dice_tuning"
  | "switch_pivot"
  | "pass"
  | "other"

/** Priority order for "keep at least one representative per present family". */
const FAMILY_PRIORITY: ActionGroupKey[] = [
  "lethal",
  "immune_break",
  "reaction_cash",
  "damage",
  "energy_build",
  "support_setup",
  "dice_tuning",
  "switch_pivot",
  "pass",
  "other",
]

/** Classify a single action into its preview-derived family. */
export function classifyAction(a: ActionInfoWithModification): ActionGroupKey {
  // Structural families first (these need no preview).
  if (a.type === "declareEnd") return "pass"
  if (a.type === "elementalTuning") return "dice_tuning"
  if (a.type === "switchActive") return "switch_pivot"

  // Preview-derived families for skills / cards.
  const pv = safePreview(a)
  if (pv) {
    if (pv.opp_kill_count > 0 || pv.opp_killed) return "lethal"
    if (pv.opp_immune_triggered > 0) return "immune_break"
    if (pv.reactions_total > 0 && pv.damage_total_opp > 0) return "reaction_cash"
    if (pv.damage_total_opp > 0) return "damage"
    if (
      pv.creates_support_self > 0 ||
      pv.creates_summon_self > 0 ||
      pv.creates_combat_status_self > 0
    ) {
      return "support_setup"
    }
    if (pv.energy_self_active_delta > 0 || pv.energy_gain_events_self > 0) {
      return "energy_build"
    }
  }

  // Fallbacks without a usable preview signal.
  if (a.type === "useSkill") return "energy_build"
  return "other"
}

function safePreview(a: ActionInfoWithModification): PreviewMutationVector | null {
  const preview = (a as { preview?: unknown }).preview
  if (!Array.isArray(preview) || preview.length === 0) return null
  try {
    // Family classification only needs side-agnostic damage/kill/create signals,
    // so an empty id-context is sufficient (opp/self split not required here).
    return extractPreviewVector(preview as never, {
      perspective: 0,
      selfIds: EMPTY_SET,
      opponentIds: EMPTY_SET,
    })
  } catch {
    return null
  }
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>()

/** Group key per action (index-aligned with `actions`). */
export function groupActions(
  actions: ActionInfoWithModification[],
): ActionGroupKey[] {
  return actions.map(classifyAction)
}

/**
 * Progressive widening: select which candidate indices to actually search.
 *
 * 1. Keep the highest-prior representative of every *present* family (so no
 *    behaviour family is ever pruned away entirely).
 * 2. Widen the budget to `ceil(simulations^α)` total, filling remaining slots
 *    with the next-highest-prior candidates not yet kept.
 *
 * Returns the kept indices (subset of `0..actions.length-1`), preserving a
 * deterministic order (family priority, then descending prior).
 */
export function progressiveWidth(
  groups: ActionGroupKey[],
  prior: number[],
  alpha: number,
  simulations: number,
): number[] {
  const n = groups.length
  if (n === 0) return []
  const budget = Math.max(
    countPresentFamilies(groups),
    Math.min(n, Math.ceil(Math.pow(Math.max(1, simulations), Math.max(0.1, Math.min(1, alpha))))),
  )

  const kept: number[] = []
  const used = new Array(n).fill(false)

  // Step 1: best representative per present family (in priority order).
  for (const fam of FAMILY_PRIORITY) {
    let bestIdx = -1
    let bestPrior = -Infinity
    for (let i = 0; i < n; i++) {
      if (used[i] || groups[i] !== fam) continue
      if (prior[i] > bestPrior) {
        bestPrior = prior[i]
        bestIdx = i
      }
    }
    if (bestIdx >= 0) {
      kept.push(bestIdx)
      used[bestIdx] = true
    }
  }

  // Step 2: widen by descending prior until budget reached.
  const remaining = []
  for (let i = 0; i < n; i++) if (!used[i]) remaining.push(i)
  remaining.sort((a, b) => prior[b] - prior[a])
  for (const i of remaining) {
    if (kept.length >= budget) break
    kept.push(i)
    used[i] = true
  }

  return kept
}

function countPresentFamilies(groups: ActionGroupKey[]): number {
  return new Set(groups).size
}
