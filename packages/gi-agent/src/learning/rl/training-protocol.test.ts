import { expect, test } from "vitest"
import {
  buildDecisionPointLogV1,
  createDefaultTrainingProtocolV1,
  evaluateCheckpointPromotionV1,
  shouldRunTrainingUpdateV1,
} from "./training-protocol.js"
import { createDecisionPointFixture } from "./test-fixtures.js"

test("createDefaultTrainingProtocolV1 exposes v1 default thresholds", () => {
  const protocol = createDefaultTrainingProtocolV1()

  expect(protocol.protocol_version).toBe("training.v1")
  expect(protocol.sample_mix_ratio).toEqual({ new_data: 7, old_data: 3 })
  expect(protocol.opponent_pool).toEqual({ mirror: 0.4, checkpoint: 0.4, baseline: 0.2 })
  expect(protocol.invalidation_rules.on_contract_version_change).toBe("drop_or_rebuild")
})

test("shouldRunTrainingUpdateV1 triggers on either games or decision-point threshold", () => {
  expect(
    shouldRunTrainingUpdateV1({
      games_since_update: 16,
      decision_points_since_update: 512,
    }),
  ).toEqual({
    should_update: false,
    reasons: [],
  })

  expect(
    shouldRunTrainingUpdateV1({
      games_since_update: 64,
      decision_points_since_update: 128,
    }),
  ).toEqual({
    should_update: true,
    reasons: ["games_threshold"],
  })

  expect(
    shouldRunTrainingUpdateV1({
      games_since_update: 8,
      decision_points_since_update: 5000,
    }),
  ).toEqual({
    should_update: true,
    reasons: ["decision_points_threshold"],
  })
})

test("evaluateCheckpointPromotionV1 applies promotion gates", () => {
  expect(
    evaluateCheckpointPromotionV1({
      matchup_gain: 0.03,
      overall_win_rate: 0.56,
      worst_baseline_delta: -0.01,
      worst_regression_delta: -0.01,
    }),
  ).toEqual({
    accepted: true,
    reasons: [],
  })

  expect(
    evaluateCheckpointPromotionV1({
      matchup_gain: 0.01,
      overall_win_rate: 0.5,
      worst_baseline_delta: -0.05,
      worst_regression_delta: -0.03,
    }),
  ).toEqual({
    accepted: false,
    reasons: [
      "matchup_gain_below_threshold",
      "overall_win_rate_below_threshold",
      "baseline_regression_too_large",
      "regression_suite_drop_too_large",
    ],
  })
})

test("buildDecisionPointLogV1 normalizes candidate scores and derives selected route", () => {
  const decisionPoint = createDecisionPointFixture()
  const log = buildDecisionPointLogV1({
    decisionPoint,
    candidateScores: [0.8],
    selectedCandidateId: decisionPoint.candidates[1].candidate_id,
    modelVersion: "model-v1",
  })

  expect(log.candidate_ids).toEqual(decisionPoint.candidates.map((candidate) => candidate.candidate_id))
  expect(log.candidate_scores).toEqual([0.8, 0])
  expect(log.selected_route).toBe("fallback_head")
  expect(log.reward_version).toBe("reward.v3")
  expect(log.obs_version).toBe("obs.v1")
  expect(log.action_version).toBe("action.v1")
})
