import { expect, test } from "vitest"
import {
  exportRlDatasetShardsV1,
  exportRlDatasetSamplesFromCapture,
  exportRlDatasetV1,
} from "./export-dataset.js"
import {
  createDecisionPointFixture,
  createObservationFixture,
} from "./test-fixtures.js"
import type { SelfPlayRlGameCaptureV1 } from "@gi-tcg/ml/contracts"

function createCaptureFixture(): SelfPlayRlGameCaptureV1 {
  const observation = createObservationFixture()
  const nextObservation = createObservationFixture({
    opponentHealths: [7],
  })
  const decisionPoint = createDecisionPointFixture()
  return {
    schema_version: "self_play_rl.v1",
    game_id: "game-1",
    episode_id: "episode-1",
    matchup_id: "matchup-a",
    winner: 0,
    sides: [
      {
        side: 0,
        observations: [observation],
        decision_points: [decisionPoint],
        transition_observations: [
          {
            ...nextObservation,
            point: {
              ...nextObservation.point,
              decision_point_id: `${decisionPoint.decision_point_id}:next`,
            },
          },
        ],
        decision_logs: [
          {
            game_id: "game-1",
            episode_id: "episode-1",
            decision_point_id: decisionPoint.decision_point_id,
            observation_ref: decisionPoint.observation_ref,
            candidate_ids: decisionPoint.candidates.map((candidate) => candidate.candidate_id),
            candidate_scores: [0.8, 0.2],
            selected_candidate_id: decisionPoint.candidates[0].candidate_id,
            selected_route: "main_head",
            reward_breakdown: {
              reward_version: "reward.v2",
              terminal: 1,
              damage: 0.06,
              ko: 0,
              energy: 0,
              hand: 0,
              reaction_ready: 0,
              burst_online: 0,
              setup_window: 0,
              reserve_value: 0,
              setup_realization: 0,
              shaping_total: 0.06,
              clipped_shaping_total: 0.06,
              total: 1.06,
            },
            value_prediction: 0.4,
            terminal_outcome: 1,
            model_version: "model-v1",
            reward_version: "reward.v2",
            obs_version: "obs.v1",
            action_version: "action.v1",
          },
        ],
      },
      {
        side: 1,
        observations: [],
        decision_points: [],
        transition_observations: [],
        decision_logs: [],
      },
    ],
  }
}

test("exportRlDatasetV1 flattens self-play captures into decision-point samples", () => {
  const dataset = exportRlDatasetV1([createCaptureFixture()])

  expect(dataset.schema_version).toBe("rl_dataset.v1")
  expect(dataset.source_capture_count).toBe(1)
  expect(dataset.sample_count).toBe(1)
  expect(dataset.by_matchup).toEqual({ "matchup-a": 1 })
  expect(dataset.samples[0].side).toBe(0)
  expect(dataset.samples[0].chosen_candidate_id).toBe("dp-1:action:0")
  expect(dataset.samples[0].next_observation?.opponent.characters[0].health).toBe(7)
  expect(dataset.samples[0].outcome_label).toBe(1)
})

test("exportRlDatasetV1 can filter sides and require explicit selections", () => {
  const capture = createCaptureFixture()
  capture.sides[0].decision_logs[0].selected_candidate_id = null

  const dataset = exportRlDatasetV1([capture], {
    includeSides: [0],
    requireChosenCandidate: true,
  })

  expect(dataset.sample_count).toBe(0)
  expect(dataset.by_matchup).toEqual({ "matchup-a": 0 })
})

test("exportRlDatasetV1 falls back to capture winner when terminal outcome is absent", () => {
  const capture = createCaptureFixture()
  capture.sides[0].decision_logs[0].terminal_outcome = null
  capture.sides[0].decision_logs[0].reward_breakdown = {
    ...capture.sides[0].decision_logs[0].reward_breakdown!,
    terminal: 0,
    total: 0.06,
  }

  const dataset = exportRlDatasetV1([capture])

  expect(dataset.sample_count).toBe(1)
  expect(dataset.samples[0]?.outcome_label).toBe(1)
})

test("exportRlDatasetV1 can exclude draw captures for specific matchups", () => {
  const capture = createCaptureFixture()
  capture.winner = null
  capture.sides[0].decision_logs[0].terminal_outcome = null
  capture.sides[0].decision_logs[0].reward_breakdown = {
    ...capture.sides[0].decision_logs[0].reward_breakdown!,
    terminal: 0,
    total: 0.06,
  }

  const dataset = exportRlDatasetV1([capture], {
    excludeDrawMatchups: ["matchup-a"],
  })

  expect(dataset.sample_count).toBe(0)
  expect(dataset.by_matchup).toEqual({ "matchup-a": 0 })
})

test("exportRlDatasetSamplesFromCapture filters sides without building a full dataset", () => {
  const samples = exportRlDatasetSamplesFromCapture(createCaptureFixture(), {
    includeSides: [0],
    requireChosenCandidate: false,
  })

  expect(samples).toHaveLength(1)
  expect(samples[0]?.matchup_id).toBe("matchup-a")
  expect(samples[0]?.side).toBe(0)
})

test("exportRlDatasetShardsV1 emits manifest and bounded shard files", () => {
  const first = createCaptureFixture()
  const second = createCaptureFixture()
  second.game_id = "game-2"
  second.episode_id = "episode-2"
  second.matchup_id = "matchup-b"
  second.sides[0].decision_logs[0].game_id = "game-2"
  second.sides[0].decision_logs[0].episode_id = "episode-2"

  const exported = exportRlDatasetShardsV1([first, second], {
    maxSamplesPerShard: 1,
  })

  expect(exported.manifest.schema_version).toBe("rl_dataset_manifest.v1")
  expect(exported.manifest.sample_count).toBe(2)
  expect(exported.manifest.shard_count).toBe(2)
  expect(exported.manifest.by_matchup).toEqual({
    "matchup-a": 1,
    "matchup-b": 1,
  })
  expect(exported.shards).toHaveLength(2)
  expect(exported.shards[0]?.schema_version).toBe("rl_dataset_shard.v1")
  expect(exported.shards[0]?.sample_count).toBe(1)
  expect(exported.shards[1]?.sample_count).toBe(1)
})
