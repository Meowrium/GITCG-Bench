import { expect, test } from "vitest"
import {
  buildDecisionPointV1FromRpcRequest,
} from "./candidate-exporter.js"
import {
  createActionRequestFixture,
  createRerollRequestFixture,
  createVisibleStateFixture,
} from "./test-fixtures.js"

test("buildDecisionPointV1FromRpcRequest sorts action candidates stably and keeps engine index", () => {
  const decisionPoint = buildDecisionPointV1FromRpcRequest(
    createActionRequestFixture(),
    createVisibleStateFixture(),
    {
      gameId: "game-1",
      episodeId: "episode-1",
      decisionPointId: "dp-1",
      actorWho: 0,
      observationRef: "obs://game-1/dp-1",
    },
  )

  expect(decisionPoint.pending_method).toBe("action")
  expect(decisionPoint.candidates).toHaveLength(2)
  
  // declareEnd candidate
  const endCandidate = decisionPoint.candidates[0]
  expect(endCandidate.action_case).toBe("declareEnd")
  expect(endCandidate.engine_index).toBe(2)
  expect(endCandidate.temporal_option_kind).toBe(null)
  expect(endCandidate.temporal_prereq_satisfied).toBe(null)
  expect(endCandidate.temporal_portfolio_stage).toBe("unknown")
  
  // playCard candidate
  const playCandidate = decisionPoint.candidates[1]! 
  expect(playCandidate.action_case).toBe("playCard")
  expect(playCandidate.engine_index).toBe(1)
  expect(playCandidate.source_ref?.entity_id).toBe(2001)
  expect(playCandidate.target_ref?.entity_id).toBe(3001)
  expect(playCandidate.routing.route).toBe("main_head")
  // Temporal fields: the fixture uses definitionId=333015 which is an event card
  // with no DSL profile → falls back to static-prior "converter"/"immediate"
  expect(playCandidate.temporal_option_kind).toBe("converter")
  expect(playCandidate.temporal_prereq_satisfied).toBe(null)
  expect(playCandidate.temporal_portfolio_stage).toBe("immediate")
})

test("buildDecisionPointV1FromRpcRequest routes rerollDice through fallback head in v1", () => {
  const decisionPoint = buildDecisionPointV1FromRpcRequest(
    createRerollRequestFixture(),
    createVisibleStateFixture(),
    {
      gameId: "game-1",
      episodeId: "episode-1",
      decisionPointId: "dp-reroll",
      actorWho: 0,
      observationRef: "obs://game-1/dp-reroll",
    },
  )

  expect(decisionPoint.pending_method).toBe("rerollDice")
  expect(decisionPoint.candidates).toHaveLength(1)
  expect(decisionPoint.candidates[0].family).toBe("reroll_dice")
  expect(decisionPoint.candidates[0].routing.route).toBe("fallback_head")
  expect(decisionPoint.candidates[0].routing.reason).toBe("disabled_in_v1")
  expect(decisionPoint.candidates[0].is_model_selectable).toBeFalsy()
  expect(decisionPoint.candidates[0].temporal_option_kind).toBe(null)
  expect(decisionPoint.candidates[0].temporal_portfolio_stage).toBe("unknown")
})
