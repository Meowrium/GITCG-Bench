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
  MlCandidateAction,
  MlDecisionPoint,
  MlPairwisePreference,
  MlRankingDataset,
  MlRankingQueryGroup,
} from "../contracts/index.js"

export interface BranchEvalReportLike {
  matchupId: string
  replayDir: string
  benchmarkPath?: string
  continuationGamesPerBranch?: number
  sampleCount?: number
  featureVersion?: string
  candidateFeatureNames?: string[]
  queryFeatureNames?: string[]
  points: BranchEvalPointLike[]
}

export interface BranchEvalPointLike {
  pointIndex?: number
  replayFile: string
  replayEntryIndex: number
  replayNextStateIndex: number | null
  actor?: 0 | 1
  round?: number
  legalActionCount?: number
  replayActionIndex: number | null
  replayActionType?: string | null
  replayActionDefinitionKind?: "skill" | "card" | "character" | "none" | null
  replayActionDefinitionId?: number | null
  replayActionSkillDefinitionId?: number | null
  replayActionCardDefinitionId?: number | null
  replayActionCharacterDefinitionId?: number | null
  replayActorCharacterDefinitionId?: number | null
  replayActionTags?: string[]
  policySelectedActionIndex: number | null
  policySelectedActionType?: string | null
  selfActiveCharacterDefinitionId?: number | null
  oppActiveCharacterDefinitionId?: number | null
  queryNumericSlots?: Record<string, number>
  branches: BranchEvalBranchLike[]
}

export interface BranchEvalBranchLike {
  actionIndex: number
  actionType: string
  actionDefinitionKind?: "skill" | "card" | "character" | "none" | null
  definitionId: number | null
  skillDefinitionId?: number | null
  cardDefinitionId?: number | null
  characterDefinitionId?: number | null
  actorCharacterDefinitionId?: number | null
  candidateTags?: string[]
  candidateNumericSlots?: Record<string, number>
  isPolicyChoice: boolean
  isReplayChoice: boolean
  continuation: {
    winRate: number
    wins?: number
    losses?: number
    draws?: number
  }
}

export interface BranchEvalDatasetBuildOptions {
  datasetId?: string
  includeTiePreferences?: boolean
}

export function extractDecisionPointsFromBranchEvalReport(
  report: BranchEvalReportLike,
): MlDecisionPoint[] {
  return report.points.map((point, index) => {
    const queryId = buildQueryId(report, point, index)
    return {
      query_id: queryId,
      source: "branch_eval",
      state_ref: buildStateRef(report, point),
      matchup_ref: report.matchupId,
      deck_refs: null,
      candidate_ids: point.branches
        .map((branch) => buildCandidateId(queryId, branch.actionIndex)),
      evidence_refs: [buildQueryEvidenceRef(report, point)],
      context_slots: {
        point_index: point.pointIndex ?? index,
        round: point.round ?? null,
        actor: point.actor ?? null,
        legal_action_count: point.legalActionCount ?? point.branches.length,
        replay_action_index: point.replayActionIndex,
        replay_action_type: point.replayActionType ?? null,
        replay_action_definition_kind: point.replayActionDefinitionKind ?? null,
        replay_action_definition_id: point.replayActionDefinitionId ?? null,
        replay_action_skill_definition_id: point.replayActionSkillDefinitionId ?? null,
        replay_action_card_definition_id: point.replayActionCardDefinitionId ?? null,
        replay_action_character_definition_id: point.replayActionCharacterDefinitionId ?? null,
        replay_actor_character_definition_id: point.replayActorCharacterDefinitionId ?? null,
        replay_action_tags: point.replayActionTags ?? [],
        policy_selected_action_index: point.policySelectedActionIndex,
        policy_selected_action_type: point.policySelectedActionType ?? null,
        replay_next_state_index: point.replayNextStateIndex,
        self_active_character_definition_id: point.selfActiveCharacterDefinitionId ?? null,
        opp_active_character_definition_id: point.oppActiveCharacterDefinitionId ?? null,
        query_numeric_slots: point.queryNumericSlots ?? {},
      },
    }
  })
}

export function buildRankingDatasetFromBranchEvalReport(
  report: BranchEvalReportLike,
  options: BranchEvalDatasetBuildOptions = {},
): MlRankingDataset {
  const decisionPoints = extractDecisionPointsFromBranchEvalReport(report)
  const queryGroups = decisionPoints.map((decisionPoint, index) =>
    buildQueryGroup(report, report.points[index]!, decisionPoint, options))

  return {
    dataset_id:
      options.datasetId ??
      `branch_eval__${toIdSegment(report.matchupId)}__${queryGroups.length}`,
    created_at: new Date().toISOString(),
    metadata: {
      source: "branch_eval",
      matchup_id: report.matchupId,
      replay_dir: report.replayDir,
      benchmark_path: report.benchmarkPath ?? null,
      continuation_games_per_branch: report.continuationGamesPerBranch ?? null,
      sample_count: report.sampleCount ?? report.points.length,
      feature_version: report.featureVersion ?? null,
      candidate_feature_names: report.candidateFeatureNames ?? [],
      query_feature_names: report.queryFeatureNames ?? [],
    },
    query_groups: queryGroups,
  }
}

function buildQueryGroup(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  decisionPoint: MlDecisionPoint,
  options: BranchEvalDatasetBuildOptions,
): MlRankingQueryGroup {
  const candidates = point.branches.map((branch) =>
    buildCandidateAction(report, point, decisionPoint.query_id, branch))

  return {
    query_id: decisionPoint.query_id,
    source: decisionPoint.source,
    state_ref: decisionPoint.state_ref,
    context_slots: decisionPoint.context_slots,
    candidates,
    pairwise_preferences: buildPairwisePreferences(
      report,
      point,
      decisionPoint.query_id,
      point.branches,
      options,
    ),
  }
}

function buildCandidateAction(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  queryId: string,
  branch: BranchEvalBranchLike,
): MlCandidateAction {
  return {
    candidate_id: buildCandidateId(queryId, branch.actionIndex),
    query_id: queryId,
    action_case: branch.actionType,
    action_definition_ref:
      branch.definitionId != null ? String(branch.definitionId) : null,
    raw_feature_ref: null,
    tree_match_ref: null,
    branch_eval_ref: buildBranchEvidenceRef(report, point, branch.actionIndex),
    runtime_slots: {
      branch_action_index: branch.actionIndex,
      action_definition_kind: branch.actionDefinitionKind ?? inferActionDefinitionKind(branch),
      definition_id: branch.definitionId,
      skill_definition_id: branch.skillDefinitionId ?? inferSkillDefinitionId(branch),
      card_definition_id: branch.cardDefinitionId ?? inferCardDefinitionId(branch),
      character_definition_id:
        branch.characterDefinitionId ?? inferCharacterDefinitionId(branch),
      actor_character_definition_id:
        branch.actorCharacterDefinitionId ?? point.selfActiveCharacterDefinitionId ?? null,
      candidate_tags: branch.candidateTags ?? [],
      candidate_numeric_slots: branch.candidateNumericSlots ?? {},
      is_policy_choice: branch.isPolicyChoice,
      is_replay_choice: branch.isReplayChoice,
      continuation: {
        score: computeContinuationScore(branch),
        sample_count: computeContinuationSampleCount(branch),
        win_rate: branch.continuation.winRate,
        wins: branch.continuation.wins ?? null,
        losses: branch.continuation.losses ?? null,
        draws: branch.continuation.draws ?? null,
      },
    },
  }
}

function buildPairwisePreferences(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  queryId: string,
  branches: readonly BranchEvalBranchLike[],
  options: BranchEvalDatasetBuildOptions,
): MlPairwisePreference[] {
  const result: MlPairwisePreference[] = []

  for (let i = 0; i < branches.length; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      const left = branches[i]!
      const right = branches[j]!
      const leftScore = computeContinuationScore(left)
      const rightScore = computeContinuationScore(right)
      const delta = leftScore - rightScore

      if (delta === 0 && !options.includeTiePreferences) {
        continue
      }

      if (delta > 0) {
        result.push({
          query_id: queryId,
          candidate_a_id: buildCandidateId(queryId, left.actionIndex),
          candidate_b_id: buildCandidateId(queryId, right.actionIndex),
          preference_label: 1,
          confidence: Math.abs(delta),
          evidence_ref: buildPairwiseEvidenceRef(
            report,
            point,
            left.actionIndex,
            right.actionIndex,
          ),
          preference_slots: {
            continuation_score_a: leftScore,
            continuation_score_b: rightScore,
            win_rate_a: left.continuation.winRate,
            win_rate_b: right.continuation.winRate,
          },
        })
        continue
      }

      if (delta < 0) {
        result.push({
          query_id: queryId,
          candidate_a_id: buildCandidateId(queryId, right.actionIndex),
          candidate_b_id: buildCandidateId(queryId, left.actionIndex),
          preference_label: 1,
          confidence: Math.abs(delta),
          evidence_ref: buildPairwiseEvidenceRef(
            report,
            point,
            right.actionIndex,
            left.actionIndex,
          ),
          preference_slots: {
            continuation_score_a: rightScore,
            continuation_score_b: leftScore,
            win_rate_a: right.continuation.winRate,
            win_rate_b: left.continuation.winRate,
          },
        })
        continue
      }

      result.push({
        query_id: queryId,
        candidate_a_id: buildCandidateId(queryId, left.actionIndex),
        candidate_b_id: buildCandidateId(queryId, right.actionIndex),
        preference_label: 0,
        confidence: 0,
        evidence_ref: buildPairwiseEvidenceRef(
          report,
          point,
          left.actionIndex,
          right.actionIndex,
        ),
        preference_slots: {
          continuation_score_a: leftScore,
          continuation_score_b: rightScore,
          win_rate_a: left.continuation.winRate,
          win_rate_b: right.continuation.winRate,
          tie: true,
        },
      })
    }
  }

  return result
}

function buildQueryId(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  index: number,
): string {
  return [
    "branch_eval",
    toIdSegment(report.matchupId),
    toIdSegment(replayBaseName(point.replayFile)),
    `entry_${point.replayEntryIndex}`,
    `point_${point.pointIndex ?? index}`,
  ].join(":")
}

function buildCandidateId(queryId: string, actionIndex: number): string {
  return `${queryId}:candidate_${actionIndex}`
}

function buildStateRef(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
): string {
  return [
    "branch_eval_state",
    toIdSegment(report.matchupId),
    toIdSegment(normalizePath(point.replayFile)),
    `entry_${point.replayEntryIndex}`,
  ].join(":")
}

function buildQueryEvidenceRef(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
): string {
  return [
    "branch_eval_point",
    toIdSegment(report.matchupId),
    toIdSegment(normalizePath(point.replayFile)),
    `entry_${point.replayEntryIndex}`,
  ].join(":")
}

function buildBranchEvidenceRef(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  actionIndex: number,
): string {
  return `${buildQueryEvidenceRef(report, point)}:action_${actionIndex}`
}

function buildPairwiseEvidenceRef(
  report: BranchEvalReportLike,
  point: BranchEvalPointLike,
  preferredActionIndex: number,
  otherActionIndex: number,
): string {
  return `${buildQueryEvidenceRef(report, point)}:pref_${preferredActionIndex}_over_${otherActionIndex}`
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/")
}

function replayBaseName(path: string): string {
  const normalized = normalizePath(path)
  const parts = normalized.split("/")
  return parts[parts.length - 1] ?? normalized
}

function toIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function computeContinuationScore(branch: BranchEvalBranchLike): number {
  const wins = branch.continuation.wins ?? 0
  const losses = branch.continuation.losses ?? 0
  const draws = branch.continuation.draws ?? 0
  const total = wins + losses + draws
  if (total > 0) {
    return (wins + draws * 0.5) / total
  }
  return branch.continuation.winRate
}

function computeContinuationSampleCount(branch: BranchEvalBranchLike): number | null {
  const wins = branch.continuation.wins ?? 0
  const losses = branch.continuation.losses ?? 0
  const draws = branch.continuation.draws ?? 0
  const total = wins + losses + draws
  return total > 0 ? total : null
}

function inferActionDefinitionKind(
  branch: BranchEvalBranchLike,
): "skill" | "card" | "character" | "none" | null {
  switch (branch.actionType) {
    case "useSkill":
      return "skill"
    case "playCard":
    case "elementalTuning":
      return "card"
    case "switchActive":
      return "character"
    case "declareEnd":
      return "none"
    default:
      return null
  }
}

function inferSkillDefinitionId(branch: BranchEvalBranchLike): number | null {
  return branch.actionType === "useSkill" ? branch.definitionId : null
}

function inferCardDefinitionId(branch: BranchEvalBranchLike): number | null {
  return branch.actionType === "playCard" || branch.actionType === "elementalTuning"
    ? branch.definitionId
    : null
}

function inferCharacterDefinitionId(branch: BranchEvalBranchLike): number | null {
  return branch.actionType === "switchActive" ? branch.definitionId : null
}
