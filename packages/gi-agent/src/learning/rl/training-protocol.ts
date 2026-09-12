// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type {
  CheckpointPromotionInputV1,
  CheckpointPromotionResultV1,
  DecisionPointLogBuildInputV1,
  DecisionPointLogV1,
  TrainingProtocolV1,
  TrainingUpdateDecisionV1,
  TrainingUpdateProgressV1,
} from "@gi-tcg/ml/contracts"

const DEFAULT_OBS_VERSION = "obs.v1"
const DEFAULT_ACTION_VERSION = "action.v1"
const DEFAULT_REWARD_VERSION = "reward.v3"

export const DEFAULT_TRAINING_PROTOCOL_V1: TrainingProtocolV1 = {
  protocol_version: "training.v1",
  warm_start_sources: ["branch-eval", "combat-window", "replay"],
  online_sources: ["self-play"],
  sample_mix_ratio: {
    new_data: 7,
    old_data: 3,
  },
  invalidation_rules: {
    on_reward_version_change: "drop_or_rebuild",
    on_contract_version_change: "drop_or_rebuild",
    on_card_pool_change: "filter_by_affected_decks",
  },
  opponent_pool: {
    mirror: 0.4,
    checkpoint: 0.4,
    baseline: 0.2,
  },
  update_schedule: {
    games_per_update: 64,
    decision_points_per_update: 4096,
  },
  promotion: {
    min_matchup_gain: 0.02,
    min_overall_win_rate: 0.54,
    max_baseline_drop: 0.02,
    max_regression_drop: 0.02,
  },
}

export function createDefaultTrainingProtocolV1(): TrainingProtocolV1 {
  return {
    protocol_version: DEFAULT_TRAINING_PROTOCOL_V1.protocol_version,
    warm_start_sources: [...DEFAULT_TRAINING_PROTOCOL_V1.warm_start_sources],
    online_sources: [...DEFAULT_TRAINING_PROTOCOL_V1.online_sources],
    sample_mix_ratio: { ...DEFAULT_TRAINING_PROTOCOL_V1.sample_mix_ratio },
    invalidation_rules: { ...DEFAULT_TRAINING_PROTOCOL_V1.invalidation_rules },
    opponent_pool: { ...DEFAULT_TRAINING_PROTOCOL_V1.opponent_pool },
    update_schedule: { ...DEFAULT_TRAINING_PROTOCOL_V1.update_schedule },
    promotion: { ...DEFAULT_TRAINING_PROTOCOL_V1.promotion },
  }
}

export function shouldRunTrainingUpdateV1(
  progress: TrainingUpdateProgressV1,
  protocol: TrainingProtocolV1 = DEFAULT_TRAINING_PROTOCOL_V1,
): TrainingUpdateDecisionV1 {
  const reasons: string[] = []
  if (progress.games_since_update >= protocol.update_schedule.games_per_update) {
    reasons.push("games_threshold")
  }
  if (
    progress.decision_points_since_update >=
    protocol.update_schedule.decision_points_per_update
  ) {
    reasons.push("decision_points_threshold")
  }
  return {
    should_update: reasons.length > 0,
    reasons,
  }
}

export function evaluateCheckpointPromotionV1(
  input: CheckpointPromotionInputV1,
  protocol: TrainingProtocolV1 = DEFAULT_TRAINING_PROTOCOL_V1,
): CheckpointPromotionResultV1 {
  const reasons: string[] = []
  if (input.matchup_gain < protocol.promotion.min_matchup_gain) {
    reasons.push("matchup_gain_below_threshold")
  }
  if (input.overall_win_rate < protocol.promotion.min_overall_win_rate) {
    reasons.push("overall_win_rate_below_threshold")
  }
  if (input.worst_baseline_delta < -protocol.promotion.max_baseline_drop) {
    reasons.push("baseline_regression_too_large")
  }
  if (input.worst_regression_delta < -protocol.promotion.max_regression_drop) {
    reasons.push("regression_suite_drop_too_large")
  }
  return {
    accepted: reasons.length === 0,
    reasons,
  }
}

export function buildDecisionPointLogV1(
  input: DecisionPointLogBuildInputV1,
): DecisionPointLogV1 {
  const candidateIds = input.decisionPoint.candidates.map((candidate) => candidate.candidate_id)
  const candidateScores = normalizeCandidateScores(
    input.candidateScores ?? [],
    candidateIds.length,
  )
  const selectedRoute =
    input.selectedRoute ??
    resolveSelectedRoute(input.decisionPoint, input.selectedCandidateId ?? null)

  return {
    game_id: input.decisionPoint.game_id,
    episode_id: input.decisionPoint.episode_id,
    decision_point_id: input.decisionPoint.decision_point_id,
    observation_ref: input.decisionPoint.observation_ref,
    candidate_ids: candidateIds,
    candidate_scores: candidateScores,
    selected_candidate_id: input.selectedCandidateId ?? null,
    selected_route: selectedRoute,
    reward_breakdown: input.rewardBreakdown ?? null,
    value_prediction: input.valuePrediction ?? null,
    terminal_outcome: input.terminalOutcome ?? null,
    model_version: input.modelVersion,
    reward_version:
      input.rewardBreakdown?.reward_version ??
      input.rewardVersion ??
      DEFAULT_REWARD_VERSION,
    obs_version: input.obsVersion ?? DEFAULT_OBS_VERSION,
    action_version: input.actionVersion ?? DEFAULT_ACTION_VERSION,
  }
}

function normalizeCandidateScores(scores: readonly number[], expectedLength: number): number[] {
  if (scores.length >= expectedLength) {
    return scores.slice(0, expectedLength)
  }
  return [
    ...scores,
    ...Array.from({ length: expectedLength - scores.length }, () => 0),
  ]
}

function resolveSelectedRoute(
  decisionPoint: DecisionPointLogBuildInputV1["decisionPoint"],
  selectedCandidateId: string | null,
): DecisionPointLogV1["selected_route"] {
  if (!selectedCandidateId) {
    return "rule_policy"
  }
  return (
    decisionPoint.candidates.find((candidate) => candidate.candidate_id === selectedCandidateId)?.routing
      .route ?? "rule_policy"
  )
}
