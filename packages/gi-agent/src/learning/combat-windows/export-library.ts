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

import type { CanonicalCombatWindowFingerprint, TreeRecord } from "./types.js"

export interface CombatWindowLibraryEntry {
  canonical_key: string
  tree_id: string
  status: TreeRecord["status"]
  matchup_id: string | null
  deck_fingerprint_self: string | null
  deck_fingerprint_opp: string | null
  fingerprint: CanonicalCombatWindowFingerprint
  combat_window_plan: TreeRecord["analysis"]["combat_window_plan"]
  source_window_id: string
  llm_confidence: number
  generalization_confidence: number
  promote_signal: TreeRecord["branch_eval_summary"] extends infer _ ? string | null : null
}

export interface CombatWindowLibrary {
  generated_at: string
  entry_count: number
  grouped_count: number
  entries: CombatWindowLibraryEntry[]
}

export function exportCombatWindowLibrary(
  trees: TreeRecord[],
): CombatWindowLibrary {
  const entries = trees
    .filter((tree) => tree.canonical_fingerprint != null)
    .map((tree) => buildLibraryEntry(tree))
    .sort((a, b) => {
      const rankA = statusRank(a.status)
      const rankB = statusRank(b.status)
      if (rankA !== rankB) {
        return rankB - rankA
      }
      return a.canonical_key.localeCompare(b.canonical_key)
    })

  const seenKeys = new Set(entries.map((entry) => entry.canonical_key))
  return {
    generated_at: new Date().toISOString(),
    entry_count: entries.length,
    grouped_count: seenKeys.size,
    entries,
  }
}

function buildLibraryEntry(tree: TreeRecord): CombatWindowLibraryEntry {
  const fingerprint = tree.canonical_fingerprint!
  return {
    canonical_key: fingerprint.canonical_key,
    tree_id: tree.tree_id,
    status: tree.status,
    matchup_id: fingerprint.matchup_id,
    deck_fingerprint_self: fingerprint.deck_fingerprint_self,
    deck_fingerprint_opp: fingerprint.deck_fingerprint_opp,
    fingerprint,
    combat_window_plan: tree.analysis.combat_window_plan,
    source_window_id: tree.source_window_id,
    llm_confidence: tree.analysis.quality.llm_confidence,
    generalization_confidence: tree.analysis.quality.generalization_confidence,
    promote_signal: tree.branch_eval_summary?.promote_signal ?? null,
  }
}

function statusRank(status: TreeRecord["status"]): number {
  switch (status) {
    case "promoted":
      return 4
    case "validated":
      return 3
    case "draft":
      return 2
    case "rejected":
      return 1
    default:
      return 0
  }
}
