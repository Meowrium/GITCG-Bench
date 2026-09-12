import { expect, test } from "vitest"
import { SelfPlayRlRecorder } from "./self-play-recorder.js"
import {
  createActionRequestFixture,
  createVisibleStateFixture,
} from "./test-fixtures.js"

test("SelfPlayRlRecorder captures pre-state, sorted candidate scores, and shaped transition reward", () => {
  const recorder = new SelfPlayRlRecorder({
    gameId: "game-1",
    episodeId: "episode-1",
    side: 0,
    modelVersion: "model-v1",
  })

  const initialState = createVisibleStateFixture()
  recorder.notify({ mutation: [], state: initialState })
  recorder.recordResolvedRpc(createActionRequestFixture(), {
    selectedActionIndex: 0,
    policyDecision: {
      selectedCandidateId: "0",
      ranked: [
        {
          candidateId: "0",
          actionCase: "playCard",
          heuristicScore: 0.9,
          finalScore: 0.9,
          reasons: ["chosen"],
          candidate: {},
        },
        {
          candidateId: "1",
          actionCase: "declareEnd",
          heuristicScore: 0.1,
          finalScore: 0.1,
          reasons: ["fallback"],
          candidate: {},
        },
      ],
    },
  })

  const nextState = createVisibleStateFixture()
  nextState.player[1].character[0].health = 2
  recorder.notify({ mutation: [], state: nextState })
  recorder.settlePending(undefined, undefined)

  const capture = recorder.exportCapture()

  expect(capture.observations).toHaveLength(1)
  expect(capture.decision_points).toHaveLength(1)
  expect(capture.transition_observations).toHaveLength(1)
  expect(capture.decision_logs).toHaveLength(1)
  expect(capture.decision_logs[0].candidate_scores).toEqual([0.1, 0.9])
  expect(capture.decision_logs[0].selected_candidate_id).toBe(
    capture.decision_points[0].candidates[1].candidate_id,
  )
  expect(capture.decision_logs[0].selected_route).toBe("main_head")
  expect(capture.decision_logs[0].reward_breakdown?.damage).toBeGreaterThan(0)
})
