import { expect, test } from "vitest"
import { buildObservationV1FromVisibleState } from "./observation-exporter.js"
import { createVisibleStateFixture } from "./test-fixtures.js"

test("buildObservationV1FromVisibleState keeps self hand visible and hides opponent cards in policy_public", () => {
  const observation = buildObservationV1FromVisibleState(createVisibleStateFixture(), 0, {
    gameId: "game-1",
    episodeId: "episode-1",
    decisionPointId: "dp-1",
    actorWho: 0,
    viewKind: "policy_public",
    knownOpponentDeckDefinitionIds: Array.from({ length: 30 }, (_, index) => 8000 + index),
    knownOpponentRevealedDefinitionIds: [333021, 333022],
  })

  expect(observation.source.view_kind).toBe("policy_public")
  expect(observation.self.hand.visible_cards).toHaveLength(1)
  expect(observation.opponent.hand.visible_cards).toHaveLength(0)
  expect(observation.hidden_estimate?.hidden_hand_count).toBe(2)
  expect(observation.hidden_estimate?.remaining_deck_count).toBe(26)
  expect(observation.derived.self_resource_score).toBeGreaterThan(
    observation.derived.opp_resource_score,
  )
})
