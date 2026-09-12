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

import type {
  MlDecisionPoint,
  MlPairwisePreference,
  MlRankingDataset,
  MlRankingQueryGroup,
  SlotValue,
} from "../contracts/index.js"
import type { RuntimeConceptState } from "../runtime/index.js"
import type { ActionRanker, RankResult } from "./types.js"

export interface RankingDatasetEvaluationOptions {
  conceptStateByQueryId?: Record<string, RuntimeConceptState | null | undefined>
}

export interface QueryRankingDiagnostics {
  query_id: string
  candidate_count: number
  pairwise_preference_count: number
  top_candidate_id: string | null
  top_candidate_score: number | null
  pairwise_supported_score: number
  pairwise_support_rate: number | null
  top1_not_contradicted: boolean | null
}

export interface RankingDatasetEvaluation {
  dataset_id: string
  artifact_type: string | null
  artifact_version: string | null
  query_count: number
  query_with_preferences_count: number
  pairwise_preference_count: number
  pairwise_supported_score: number
  pairwise_support_rate: number | null
  top1_not_contradicted_count: number
  top1_not_contradicted_rate: number | null
  query_diagnostics: QueryRankingDiagnostics[]
}

export async function evaluateRankingDataset(
  ranker: ActionRanker,
  dataset: MlRankingDataset,
  options: RankingDatasetEvaluationOptions = {},
): Promise<RankingDatasetEvaluation> {
  let artifactType: string | null = null
  let artifactVersion: string | null = null
  let queryWithPreferencesCount = 0
  let pairwisePreferenceCount = 0
  let pairwiseSupportedScore = 0
  let top1NotContradictedCount = 0

  const queryDiagnostics: QueryRankingDiagnostics[] = []
  const totalGroups = dataset.query_groups.length

  // Process in batches to avoid excessive microtask overhead from per-item await
  const BATCH_SIZE = 256
  for (let batchStart = 0; batchStart < totalGroups; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalGroups)
    for (let i = batchStart; i < batchEnd; i++) {
      const group = dataset.query_groups[i]!
      const conceptState = options.conceptStateByQueryId?.[group.query_id] ?? null
      const query = buildDecisionPoint(group)
      const result = ranker.rankSync
        ? ranker.rankSync({ query, candidates: group.candidates, concept_state: conceptState })
        : await ranker.rank({ query, candidates: group.candidates, concept_state: conceptState })

      artifactType ??= readStringSlot(result.summary_slots, "artifact_type")
      artifactVersion ??= readStringSlot(result.summary_slots, "artifact_version")

      const diagnostics = buildQueryDiagnostics(group, result)
      queryDiagnostics.push(diagnostics)

      if (diagnostics.pairwise_preference_count > 0) {
        queryWithPreferencesCount += 1
        pairwisePreferenceCount += diagnostics.pairwise_preference_count
        pairwiseSupportedScore += diagnostics.pairwise_supported_score
        if (diagnostics.top1_not_contradicted) {
          top1NotContradictedCount += 1
        }
      }
    }
    // Yield to event loop once per batch
    if (batchEnd < totalGroups) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return {
    dataset_id: dataset.dataset_id,
    artifact_type: artifactType,
    artifact_version: artifactVersion,
    query_count: dataset.query_groups.length,
    query_with_preferences_count: queryWithPreferencesCount,
    pairwise_preference_count: pairwisePreferenceCount,
    pairwise_supported_score: pairwiseSupportedScore,
    pairwise_support_rate: safeDivide(pairwiseSupportedScore, pairwisePreferenceCount),
    top1_not_contradicted_count: top1NotContradictedCount,
    top1_not_contradicted_rate: safeDivide(
      top1NotContradictedCount,
      queryWithPreferencesCount,
    ),
    query_diagnostics: queryDiagnostics,
  }
}

function buildQueryDiagnostics(
  group: MlRankingQueryGroup,
  result: RankResult,
): QueryRankingDiagnostics {
  const scoreByCandidateId = new Map(
    result.ranked_actions.map((action) => [action.candidate_id, action.score]),
  )
  const preferences = group.pairwise_preferences ?? []
  const pairwiseSupportedScore = preferences.reduce(
    (sum, preference) => sum + supportForPreference(preference, scoreByCandidateId),
    0,
  )
  const topCandidate = result.ranked_actions[0] ?? null

  return {
    query_id: group.query_id,
    candidate_count: group.candidates.length,
    pairwise_preference_count: preferences.length,
    top_candidate_id: topCandidate?.candidate_id ?? null,
    top_candidate_score: topCandidate?.score ?? null,
    pairwise_supported_score: pairwiseSupportedScore,
    pairwise_support_rate: safeDivide(pairwiseSupportedScore, preferences.length),
    top1_not_contradicted: topCandidate
      ? topCandidateNotContradicted(topCandidate.candidate_id, preferences)
      : null,
  }
}

function buildDecisionPoint(group: MlRankingQueryGroup): MlDecisionPoint {
  return {
    query_id: group.query_id,
    source: group.source ?? "unknown",
    state_ref: group.state_ref ?? null,
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: group.candidates.map((candidate) => candidate.candidate_id),
    evidence_refs: [],
    context_slots: group.context_slots ?? null,
  }
}

function supportForPreference(
  preference: MlPairwisePreference,
  scoreByCandidateId: Map<string, number>,
): number {
  const scoreA = scoreByCandidateId.get(preference.candidate_a_id) ?? 0
  const scoreB = scoreByCandidateId.get(preference.candidate_b_id) ?? 0

  if (preference.preference_label > 0) {
    if (scoreA > scoreB) {
      return 1
    }
    if (scoreA === scoreB) {
      return 0.5
    }
    return 0
  }

  if (preference.preference_label < 0) {
    if (scoreB > scoreA) {
      return 1
    }
    if (scoreA === scoreB) {
      return 0.5
    }
    return 0
  }

  return scoreA === scoreB ? 1 : 0
}

function topCandidateNotContradicted(
  candidateId: string,
  preferences: readonly MlPairwisePreference[],
): boolean | null {
  if (preferences.length === 0) {
    return null
  }

  return preferences.every((preference) => {
    if (preference.preference_label > 0) {
      return preference.candidate_b_id !== candidateId
    }
    if (preference.preference_label < 0) {
      return preference.candidate_a_id !== candidateId
    }
    return true
  })
}

function readStringSlot(slot: SlotValue | undefined, key: string): string | null {
  if (!slot) {
    return null
  }
  const value = slot[key]
  return typeof value === "string" ? value : null
}

function safeDivide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}
