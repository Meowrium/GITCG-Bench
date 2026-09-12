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

import type { CombatWindowLibrary } from "./export-library.js"
import {
  buildLibraryQueryFromWindow,
  selectCombatWindowLibrary,
  type CombatWindowLibrarySelectorOptions,
} from "./library-selector.js"
import type {
  CandidateCombatWindow,
  CombatWindowExtractionResult,
} from "./types.js"

export interface CombatWindowLibraryWorkloadQueryRow {
  window_id: string
  session_id: string
  round: number
  turn: number
  deck_fingerprint_self: string | null
  deck_fingerprint_opp: string | null
  deck_pair_key: string
  action_count: number
  tags: string[]
  candidate_count: number
  returned_count: number
  top_match_tree_id: string | null
  top_match_canonical_key: string | null
  top_match_matchup_id: string | null
  top_match_status: string | null
  top_match_final_score: number | null
  top_match_state_similarity: number | null
  top_match_matched_fields: string[]
  has_match: boolean
  strong_match: boolean
}

export interface CombatWindowLibraryWorkloadDeckPairSummary {
  deck_pair_key: string
  deck_fingerprint_self: string | null
  deck_fingerprint_opp: string | null
  window_count: number
  matched_window_count: number
  strong_match_count: number
  avg_top1_final_score: number | null
  avg_top1_state_similarity: number | null
}

export interface CombatWindowLibraryWorkloadTopMatchupSummary {
  matchup_id: string | null
  top1_count: number
  avg_top1_final_score: number | null
}

export interface CombatWindowLibraryWorkloadSummary {
  generated_at: string
  query_mode: "runtime"
  selection_limit: number
  strong_match_threshold: number
  sessions_scanned: number
  window_count: number
  matched_window_count: number
  strong_match_count: number
  avg_top1_final_score: number | null
  avg_top1_state_similarity: number | null
  deck_pairs: CombatWindowLibraryWorkloadDeckPairSummary[]
  top_match_matchups: CombatWindowLibraryWorkloadTopMatchupSummary[]
  windows: CombatWindowLibraryWorkloadQueryRow[]
}

export interface CombatWindowLibraryWorkloadEvaluationOptions
  extends Pick<
    CombatWindowLibrarySelectorOptions,
    "includeRejected" | "requireSameSelfDeck" | "dedupeByCanonicalKey"
  > {
  minScore?: number
  selectionLimit?: number
  strongMatchThreshold?: number
}

export function evaluateCombatWindowLibraryWorkload(
  extraction: CombatWindowExtractionResult,
  library: CombatWindowLibrary,
  options: CombatWindowLibraryWorkloadEvaluationOptions = {},
): CombatWindowLibraryWorkloadSummary {
  const selectionLimit = Math.max(options.selectionLimit ?? 5, 1)
  const strongMatchThreshold = options.strongMatchThreshold ?? 0.7
  const selectorOptions: CombatWindowLibrarySelectorOptions = {
    limit: selectionLimit,
    minScore: options.minScore ?? 0.45,
    includeRejected: options.includeRejected,
    requireSameSelfDeck: options.requireSameSelfDeck,
    dedupeByCanonicalKey: options.dedupeByCanonicalKey,
  }

  const windows = extraction.windows.map((window) =>
    summarizeWindow(window, library, strongMatchThreshold, selectorOptions),
  )

  return {
    generated_at: new Date().toISOString(),
    query_mode: "runtime",
    selection_limit: selectionLimit,
    strong_match_threshold: strongMatchThreshold,
    sessions_scanned: extraction.sessions_scanned,
    window_count: windows.length,
    matched_window_count: windows.filter((window) => window.has_match).length,
    strong_match_count: windows.filter((window) => window.strong_match).length,
    avg_top1_final_score: average(windows.map((window) => window.top_match_final_score)),
    avg_top1_state_similarity: average(
      windows.map((window) => window.top_match_state_similarity),
    ),
    deck_pairs: summarizeDeckPairs(windows),
    top_match_matchups: summarizeTopMatchups(windows),
    windows,
  }
}

function summarizeWindow(
  window: CandidateCombatWindow,
  library: CombatWindowLibrary,
  strongMatchThreshold: number,
  selectorOptions: CombatWindowLibrarySelectorOptions,
): CombatWindowLibraryWorkloadQueryRow {
  const query = buildLibraryQueryFromWindow(window, {
    deckFingerprintSelf:
      window.deck_fingerprint_self ?? window.state_fingerprint.deck_fingerprint_self,
    deckFingerprintOpp: window.deck_fingerprint_opp ?? null,
    expectedActionCount: window.action_count,
    pendingMethod: window.state_fingerprint.pending_method,
  })
  const selection = selectCombatWindowLibrary(library, {
    ...query,
    source: "runtime_window",
  }, selectorOptions)
  const topMatch = selection.matches[0] ?? null
  const hasMatch = topMatch != null
  const strongMatch =
    hasMatch &&
    (topMatch?.final_score ?? 0) >= strongMatchThreshold

  return {
    window_id: window.window_id,
    session_id: window.session_id,
    round: window.round,
    turn: window.turn,
    deck_fingerprint_self: query.deck_fingerprint_self,
    deck_fingerprint_opp: query.deck_fingerprint_opp,
    deck_pair_key: deckPairKey(
      query.deck_fingerprint_self,
      query.deck_fingerprint_opp,
    ),
    action_count: window.action_count,
    tags: window.tags,
    candidate_count: selection.candidate_count,
    returned_count: selection.returned_count,
    top_match_tree_id: topMatch?.entry.tree_id ?? null,
    top_match_canonical_key: topMatch?.entry.canonical_key ?? null,
    top_match_matchup_id: topMatch?.entry.matchup_id ?? null,
    top_match_status: topMatch?.entry.status ?? null,
    top_match_final_score: topMatch?.final_score ?? null,
    top_match_state_similarity: topMatch?.state_similarity ?? null,
    top_match_matched_fields: topMatch?.matched_fields ?? [],
    has_match: hasMatch,
    strong_match: strongMatch,
  }
}

function summarizeDeckPairs(
  rows: CombatWindowLibraryWorkloadQueryRow[],
): CombatWindowLibraryWorkloadDeckPairSummary[] {
  const grouped = new Map<string, CombatWindowLibraryWorkloadQueryRow[]>()
  for (const row of rows) {
    const bucket = grouped.get(row.deck_pair_key) ?? []
    bucket.push(row)
    grouped.set(row.deck_pair_key, bucket)
  }

  return [...grouped.entries()]
    .map(([key, bucket]) => ({
      deck_pair_key: key,
      deck_fingerprint_self: bucket[0]?.deck_fingerprint_self ?? null,
      deck_fingerprint_opp: bucket[0]?.deck_fingerprint_opp ?? null,
      window_count: bucket.length,
      matched_window_count: bucket.filter((row) => row.has_match).length,
      strong_match_count: bucket.filter((row) => row.strong_match).length,
      avg_top1_final_score: average(bucket.map((row) => row.top_match_final_score)),
      avg_top1_state_similarity: average(
        bucket.map((row) => row.top_match_state_similarity),
      ),
    }))
    .sort((left, right) => right.window_count - left.window_count)
}

function summarizeTopMatchups(
  rows: CombatWindowLibraryWorkloadQueryRow[],
): CombatWindowLibraryWorkloadTopMatchupSummary[] {
  const grouped = new Map<string, CombatWindowLibraryWorkloadQueryRow[]>()
  for (const row of rows) {
    const key = row.top_match_matchup_id ?? "__none__"
    const bucket = grouped.get(key) ?? []
    bucket.push(row)
    grouped.set(key, bucket)
  }

  return [...grouped.entries()]
    .map(([key, bucket]) => ({
      matchup_id: key === "__none__" ? null : key,
      top1_count: bucket.length,
      avg_top1_final_score: average(bucket.map((row) => row.top_match_final_score)),
    }))
    .sort((left, right) => right.top1_count - left.top1_count)
}

function deckPairKey(
  deckFingerprintSelf: string | null,
  deckFingerprintOpp: string | null,
): string {
  return `${deckFingerprintSelf ?? "unknown-self"}__vs__${deckFingerprintOpp ?? "unknown-opp"}`
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null)
  if (filtered.length === 0) {
    return null
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}
