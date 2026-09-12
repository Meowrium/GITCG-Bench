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

/**
 * Q-value dataset builder.
 *
 * Unlike V(s) which uses only state features, Q(s,a) combines state features
 * with action features extracted from the chosen candidate.  The key advantage
 * is that LightGBM can directly discriminate between candidate actions within
 * the same state — something V(s) cannot do.
 *
 * Feature layout (dot-separated after Python flatten_feature_slots):
 *   State:  round, self.*, opponent.*, self_characters.*, ...  (same as V model)
 *   Action: action.is_use_skill, action.dice_cost, action.tempo_gain_now, ...
 *
 * Training/inference consistency:
 *   Both training (ActionCandidateV1.meta_effect_slots) and inference
 *   (PolicyCandidateAction.meta_effect_slots) set meta_effect_slots via the
 *   same buildCandidateStaticPrior() call, so feature values are identical.
 */

import type {
  ActionCandidateV1,
  ObservationV1,
  RlDatasetV1,
  RlDecisionPointSampleV1,
} from "../contracts/rl-types.js"
import type { MlValueDataset, MlValueSample } from "../contracts/index.js"
import { shouldIncludeDatasetKey, type DatasetHoldoutOptions } from "./holdout.js"
import { buildObservationValueFeatureSlots } from "./rl-value.js"

export interface RlQValueDatasetBuildOptions extends DatasetHoldoutOptions {
  datasetId?: string
}

/**
 * Build a Q-value dataset from an RL dataset.
 * Each sample corresponds to one (state, chosen_action) pair.
 * Features = state_features ∪ action_features (under "action" key).
 * Target  = outcome_label (MC return: 1=win, 0=loss).
 */
export function buildQValueDatasetFromRlDataset(
  dataset: RlDatasetV1,
  options: RlQValueDatasetBuildOptions = {},
): MlValueDataset {
  const samples = dataset.samples
    .filter((sample) =>
      shouldIncludeDatasetKey(sample.decision_point.decision_point_id, options))
    .map((sample) => buildQValueSample(sample))
    .filter((sample): sample is MlValueSample => sample != null)

  return {
    dataset_id: options.datasetId ?? `rl_q_value__${dataset.sample_count}`,
    created_at: new Date().toISOString(),
    metadata: {
      source: "self_play_q",
      dataset_schema_version: dataset.schema_version,
      sample_count: samples.length,
      source_capture_count: dataset.source_capture_count,
      matchup_counts: dataset.by_matchup,
    },
    samples,
  }
}

function buildQValueSample(sample: RlDecisionPointSampleV1): MlValueSample | null {
  if (sample.outcome_label == null) return null
  if (!sample.chosen_candidate_id) return null

  const chosenCandidate = sample.decision_point.candidates.find(
    (c) => c.candidate_id === sample.chosen_candidate_id,
  )
  if (!chosenCandidate) return null
  // Only train on valid, model-selectable action candidates
  if (!chosenCandidate.is_valid || !chosenCandidate.is_model_selectable) return null

  const stateFeatureSlots = buildObservationValueFeatureSlots(sample.observation)
  const actionFeatureSlots = buildQActionFeatureSlots(chosenCandidate, sample.observation)

  // Sample weight: emphasize terminal outcomes (win/loss) over draws
  const weight = sample.reward_breakdown != null
    ? Math.min(2, 0.5 + Math.abs(sample.reward_breakdown.terminal) * 0.5 + Math.abs(sample.reward_breakdown.clipped_shaping_total))
    : 1

  return {
    sample_id: `${sample.decision_point.decision_point_id}:${sample.chosen_candidate_id}`,
    source: "self_play_q",
    state_ref: sample.observation.point.decision_point_id,
    target_value: sample.outcome_label,
    weight,
    context_slots: {
      matchup_id: sample.matchup_id,
      side: sample.side,
      round: sample.observation.point.round_number,
      action_case: String(chosenCandidate.action_case ?? "unknown"),
      reward_total: sample.reward_breakdown?.total ?? 0,
    },
    feature_slots: {
      // State features (identical key structure to V model)
      ...stateFeatureSlots,
      // Action features nested under "action" key
      // Python flatten_feature_slots will produce "action.is_use_skill" etc.
      action: actionFeatureSlots,
    },
  }
}

/**
 * Extract action features from a stored ActionCandidateV1.
 * Uses meta_effect_slots which are computed by buildCandidateStaticPrior()
 * at self-play capture time — same computation path as inference.
 */
export function buildQActionFeatureSlots(
  candidate: ActionCandidateV1,
  _observation: ObservationV1,
): Record<string, number> {
  const meta = (candidate.meta_effect_slots ?? {}) as Record<string, number>
  const totalCost = candidate.required_cost.reduce((sum, e) => sum + e.count, 0)
  const actionCase = String(candidate.action_case ?? "")

  return {
    // Action type (one-hot)
    is_use_skill: actionCase === "useSkill" ? 1 : 0,
    is_play_card: actionCase === "playCard" ? 1 : 0,
    is_switch_active: actionCase === "switchActive" ? 1 : 0,
    is_declare_end: actionCase === "declareEnd" ? 1 : 0,
    is_elemental_tuning: actionCase === "elementalTuning" ? 1 : 0,
    is_fast_action: candidate.is_fast_action ? 1 : 0,
    // Execution cost
    dice_cost: totalCost,
    // Static + preview meta effect slots (key feature bridge between training and inference)
    tempo_gain_now: meta.tempo_gain_now ?? 0,
    reaction_window_enable: meta.reaction_window_enable ?? 0,
    burst_window_enable: meta.burst_window_enable ?? 0,
    action_density_gain: meta.action_density_gain ?? 0,
    stability_gain: meta.stability_gain ?? 0,
    finisher_alignment: meta.finisher_alignment ?? 0,
    setup_dependency: meta.setup_dependency ?? 0,
    resource_conversion_score: meta.resource_conversion_score ?? 0,
    retention_value_proxy: meta.retention_value_proxy ?? 0,
    setup_dependency_loss: meta.setup_dependency_loss ?? 0,
    reaction_window_loss: meta.reaction_window_loss ?? 0,
    finisher_alignment_loss: meta.finisher_alignment_loss ?? 0,
    // Source entity id (enables card-specific Q values via categorical split)
    source_definition_id: candidate.source_ref?.definition_id ?? 0,
  }
}
