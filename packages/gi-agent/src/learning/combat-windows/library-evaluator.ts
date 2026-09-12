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
  buildLibraryQueryFromCanonicalFingerprint,
  buildLibraryQueryFromWindow,
  selectCombatWindowLibrary,
  type CombatWindowLibraryQuery,
  type CombatWindowLibrarySelection,
  type CombatWindowLibrarySelectorOptions,
} from "./library-selector.js"
import type { TreeRecord } from "./types.js"

export type CombatWindowLibraryEvaluationQueryMode =
  | "runtime"
  | "window"
  | "canonical"

export interface CombatWindowLibraryEvaluationQueryRow {
  tree_id: string
  source_window_id: string
  query_mode: CombatWindowLibraryEvaluationQueryMode
  query_matchup_id: string | null
  query_status: TreeRecord["status"]
  canonical_key: string
  same_key_in_library: boolean
  same_key_rank: number | null
  top_match_tree_id: string | null
  top_match_canonical_key: string | null
  top_match_status: TreeRecord["status"] | null
  top_match_final_score: number | null
  top_match_state_similarity: number | null
  top_match_matched_fields: string[]
  candidate_count: number
  returned_count: number
  hit_at_1: boolean
  hit_at_3: boolean
  hit_at_5: boolean
}

export interface CombatWindowLibraryEvaluationMatchupSummary {
  matchup_id: string | null
  query_count: number
  coverable_count: number
  hit_at_1_all: number
  hit_at_3_all: number
  hit_at_5_all: number
  hit_at_1_coverable: number
  hit_at_3_coverable: number
  hit_at_5_coverable: number
}

export interface CombatWindowLibraryEvaluationSummary {
  generated_at: string
  query_mode: CombatWindowLibraryEvaluationQueryMode
  selection_limit: number
  query_count: number
  coverable_count: number
  queries_with_matches: number
  library_entry_count: number
  library_key_count: number
  hit_at_1_all: number
  hit_at_3_all: number
  hit_at_5_all: number
  hit_at_1_coverable: number
  hit_at_3_coverable: number
  hit_at_5_coverable: number
  avg_top1_final_score: number | null
  avg_top1_state_similarity: number | null
  avg_same_key_rank: number | null
  matchups: CombatWindowLibraryEvaluationMatchupSummary[]
  queries: CombatWindowLibraryEvaluationQueryRow[]
}

export interface CombatWindowLibraryEvaluationReport {
  generated_at: string
  summaries: CombatWindowLibraryEvaluationSummary[]
}

export interface CombatWindowLibraryEvaluationOptions
  extends Pick<
    CombatWindowLibrarySelectorOptions,
    "includeRejected" | "requireSameSelfDeck" | "dedupeByCanonicalKey"
  > {
  queryModes?: CombatWindowLibraryEvaluationQueryMode[]
  minScore?: number
  selectionLimit?: number
}

export function evaluateCombatWindowLibrary(
  trees: TreeRecord[],
  library: CombatWindowLibrary,
  options: CombatWindowLibraryEvaluationOptions = {},
): CombatWindowLibraryEvaluationReport {
  const queryModes = options.queryModes ?? ["runtime", "window", "canonical"]
  return {
    generated_at: new Date().toISOString(),
    summaries: queryModes.map((queryMode) =>
      evaluateCombatWindowLibraryMode(trees, library, queryMode, options),
    ),
  }
}

export function evaluateCombatWindowLibraryMode(
  trees: TreeRecord[],
  library: CombatWindowLibrary,
  queryMode: CombatWindowLibraryEvaluationQueryMode,
  options: CombatWindowLibraryEvaluationOptions = {},
): CombatWindowLibraryEvaluationSummary {
  const selectionLimit = Math.max(options.selectionLimit ?? 5, 5)
  const selectorOptions: CombatWindowLibrarySelectorOptions = {
    limit: selectionLimit,
    minScore: options.minScore ?? 0.45,
    includeRejected: options.includeRejected,
    requireSameSelfDeck: options.requireSameSelfDeck,
    dedupeByCanonicalKey: options.dedupeByCanonicalKey,
  }

  const eligibleTrees = trees.filter((tree) => tree.canonical_fingerprint != null)
  const libraryKeys = new Set(library.entries.map((entry) => entry.canonical_key))
  const queries = eligibleTrees.map((tree) => {
    const query = buildQueryForTree(tree, queryMode)
    const selection = selectCombatWindowLibrary(library, query, selectorOptions)
    return summarizeQuery(tree, queryMode, selection, libraryKeys)
  })

  return {
    generated_at: new Date().toISOString(),
    query_mode: queryMode,
    selection_limit: selectionLimit,
    query_count: queries.length,
    coverable_count: queries.filter((query) => query.same_key_in_library).length,
    queries_with_matches: queries.filter((query) => query.returned_count > 0).length,
    library_entry_count: library.entry_count,
    library_key_count: library.grouped_count,
    hit_at_1_all: rate(queries.filter((query) => query.hit_at_1).length, queries.length),
    hit_at_3_all: rate(queries.filter((query) => query.hit_at_3).length, queries.length),
    hit_at_5_all: rate(queries.filter((query) => query.hit_at_5).length, queries.length),
    hit_at_1_coverable: conditionalRate(
      queries,
      (query) => query.same_key_in_library,
      (query) => query.hit_at_1,
    ),
    hit_at_3_coverable: conditionalRate(
      queries,
      (query) => query.same_key_in_library,
      (query) => query.hit_at_3,
    ),
    hit_at_5_coverable: conditionalRate(
      queries,
      (query) => query.same_key_in_library,
      (query) => query.hit_at_5,
    ),
    avg_top1_final_score: average(
      queries.map((query) => query.top_match_final_score),
    ),
    avg_top1_state_similarity: average(
      queries.map((query) => query.top_match_state_similarity),
    ),
    avg_same_key_rank: average(
      queries.map((query) => query.same_key_rank),
    ),
    matchups: summarizeMatchups(queries),
    queries,
  }
}

function buildQueryForTree(
  tree: TreeRecord,
  queryMode: CombatWindowLibraryEvaluationQueryMode,
): CombatWindowLibraryQuery {
  if (queryMode === "canonical") {
    return buildLibraryQueryFromCanonicalFingerprint(tree.canonical_fingerprint!)
  }
  if (queryMode === "runtime") {
    const query = buildLibraryQueryFromWindow(tree.source_window, {
      deckFingerprintSelf:
        tree.source_window.deck_fingerprint_self ??
        tree.source_window.state_fingerprint.deck_fingerprint_self,
      deckFingerprintOpp: tree.source_window.deck_fingerprint_opp,
      expectedActionCount: tree.source_window.action_count,
      pendingMethod: tree.source_window.state_fingerprint.pending_method,
    })
    return {
      ...query,
      source: "runtime_window",
    }
  }
  return buildLibraryQueryFromWindow(tree.source_window, {
    deckFingerprintSelf: tree.canonical_fingerprint?.deck_fingerprint_self ?? tree.source_window.deck_fingerprint_self,
    deckFingerprintOpp: tree.canonical_fingerprint?.deck_fingerprint_opp ?? null,
    matchupId:
      tree.canonical_fingerprint?.matchup_id ??
      tree.analysis.source_context.matchup_id,
    selfActiveCharacterDefinitionId:
      tree.canonical_fingerprint?.self_active_character_definition_id ?? null,
    oppActiveCharacterDefinitionId:
      tree.canonical_fingerprint?.opp_active_character_definition_id ?? null,
    expectedActionCount: tree.source_window.action_count,
    pendingMethod: tree.canonical_fingerprint?.pending_method,
  })
}

function summarizeQuery(
  tree: TreeRecord,
  queryMode: CombatWindowLibraryEvaluationQueryMode,
  selection: CombatWindowLibrarySelection,
  libraryKeys: ReadonlySet<string>,
): CombatWindowLibraryEvaluationQueryRow {
  const canonicalKey = tree.canonical_fingerprint!.canonical_key
  const sameKeyRank = selection.matches.findIndex(
    (match) => match.entry.canonical_key === canonicalKey,
  )
  const topMatch = selection.matches[0] ?? null

  return {
    tree_id: tree.tree_id,
    source_window_id: tree.source_window_id,
    query_mode: queryMode,
    query_matchup_id:
      tree.canonical_fingerprint?.matchup_id ??
      tree.analysis.source_context.matchup_id,
    query_status: tree.status,
    canonical_key: canonicalKey,
    same_key_in_library: libraryKeys.has(canonicalKey),
    same_key_rank: sameKeyRank >= 0 ? sameKeyRank + 1 : null,
    top_match_tree_id: topMatch?.entry.tree_id ?? null,
    top_match_canonical_key: topMatch?.entry.canonical_key ?? null,
    top_match_status: topMatch?.entry.status ?? null,
    top_match_final_score: topMatch?.final_score ?? null,
    top_match_state_similarity: topMatch?.state_similarity ?? null,
    top_match_matched_fields: topMatch?.matched_fields ?? [],
    candidate_count: selection.candidate_count,
    returned_count: selection.returned_count,
    hit_at_1: sameKeyRank === 0,
    hit_at_3: sameKeyRank >= 0 && sameKeyRank < 3,
    hit_at_5: sameKeyRank >= 0 && sameKeyRank < 5,
  }
}

function summarizeMatchups(
  queries: CombatWindowLibraryEvaluationQueryRow[],
): CombatWindowLibraryEvaluationMatchupSummary[] {
  const grouped = new Map<string, CombatWindowLibraryEvaluationQueryRow[]>()
  for (const query of queries) {
    const key = query.query_matchup_id ?? "__unknown__"
    const bucket = grouped.get(key) ?? []
    bucket.push(query)
    grouped.set(key, bucket)
  }

  return [...grouped.entries()]
    .map(([key, bucket]) => ({
      matchup_id: key === "__unknown__" ? null : key,
      query_count: bucket.length,
      coverable_count: bucket.filter((query) => query.same_key_in_library).length,
      hit_at_1_all: rate(bucket.filter((query) => query.hit_at_1).length, bucket.length),
      hit_at_3_all: rate(bucket.filter((query) => query.hit_at_3).length, bucket.length),
      hit_at_5_all: rate(bucket.filter((query) => query.hit_at_5).length, bucket.length),
      hit_at_1_coverable: conditionalRate(
        bucket,
        (query) => query.same_key_in_library,
        (query) => query.hit_at_1,
      ),
      hit_at_3_coverable: conditionalRate(
        bucket,
        (query) => query.same_key_in_library,
        (query) => query.hit_at_3,
      ),
      hit_at_5_coverable: conditionalRate(
        bucket,
        (query) => query.same_key_in_library,
        (query) => query.hit_at_5,
      ),
    }))
    .sort((left, right) => right.query_count - left.query_count)
}

function conditionalRate<T>(
  items: T[],
  include: (item: T) => boolean,
  hit: (item: T) => boolean,
): number {
  const filtered = items.filter(include)
  return rate(filtered.filter(hit).length, filtered.length)
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => value != null)
  if (filtered.length === 0) {
    return null
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function rate(hitCount: number, totalCount: number): number {
  if (totalCount <= 0) {
    return 0
  }
  return hitCount / totalCount
}
