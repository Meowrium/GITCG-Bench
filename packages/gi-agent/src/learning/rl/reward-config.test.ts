import { expect, test } from "vitest"
import {
  DEFAULT_REWARD_CONFIG_V1,
  computeRewardBreakdownV1,
} from "./reward-config.js"
import { createObservationFixture } from "./test-fixtures.js"

test("computeRewardBreakdownV1 applies default dense shaping without double counting", () => {
  const previous = createObservationFixture({
    selfHealths: [10],
    opponentHealths: [10],
    selfEnergies: [0],
    opponentEnergies: [0],
    selfHandCount: 5,
    opponentHandCount: 5,
    selfReactionReadyScore: 0,
    opponentReactionReadyScore: 0,
    selfBurstOnlineCount: 0,
    opponentBurstOnlineCount: 0,
  })
  const next = createObservationFixture({
    selfHealths: [10],
    opponentHealths: [6],
    selfEnergies: [1],
    opponentEnergies: [0],
    selfHandCount: 4,
    opponentHandCount: 5,
    selfReactionReadyScore: 1,
    opponentReactionReadyScore: 0,
    selfBurstOnlineCount: 1,
    opponentBurstOnlineCount: 0,
  })

  const breakdown = computeRewardBreakdownV1(previous, next)

  expect(breakdown.reward_version).toBe(DEFAULT_REWARD_CONFIG_V1.reward_version)
  expect(breakdown.damage).toBeCloseTo(0.10, 6)
  expect(breakdown.ko).toBe(0)
  expect(breakdown.energy).toBeCloseTo(0.02, 6)
  expect(breakdown.hand).toBeCloseTo(-0.01, 6)
  expect(breakdown.reaction_ready).toBeCloseTo(0.04, 6)
  expect(breakdown.burst_online).toBeCloseTo(0.06, 6)
  expect(breakdown.setup_window).toBe(0)
  expect(breakdown.reserve_value).toBe(0)
  expect(breakdown.setup_realization).toBe(0)
  expect(breakdown.element_application).toBe(0)
  expect(breakdown.focus_damage).toBeCloseTo(0.05, 6)
  expect(breakdown.clipped_shaping_total).toBeCloseTo(0.25, 6)
  expect(breakdown.total).toBeCloseTo(0.25, 6)
})

test("computeRewardBreakdownV1 clips oversized shaping while preserving terminal reward", () => {
  const previous = createObservationFixture({
    selfHealths: [10, 10, 10],
    opponentHealths: [10, 10, 10],
    selfAlive: [true, true, true],
    opponentAlive: [true, true, true],
    selfHandCount: 1,
    opponentHandCount: 1,
  })
  const next = createObservationFixture({
    selfHealths: [10, 10, 10],
    opponentHealths: [0, 0, 0],
    selfAlive: [true, true, true],
    opponentAlive: [false, false, false],
    selfHandCount: 1,
    opponentHandCount: 1,
    selfReactionReadyScore: 1,
    selfBurstOnlineCount: 2,
  })

  const breakdown = computeRewardBreakdownV1(previous, next, {
    terminalOutcome: "win",
  })

  expect(breakdown.shaping_total).toBeGreaterThan(DEFAULT_REWARD_CONFIG_V1.shaping.step_clip)
  expect(breakdown.clipped_shaping_total).toBe(DEFAULT_REWARD_CONFIG_V1.shaping.step_clip)
  expect(breakdown.terminal).toBe(2)
  expect(breakdown.total).toBe(2 + DEFAULT_REWARD_CONFIG_V1.shaping.step_clip)
})

test("computeRewardBreakdownV1 rewards setup creation and setup realization separately", () => {
  const build = (
    setupWindow: number,
    reserveValue: number,
    windowScore: number,
    damageCapacity: number,
  ) =>
    createObservationFixture({
      selfSetupWindowScore: setupWindow,
      selfReserveValueScore: reserveValue,
      selfHandCount: 5,
      selfReactionReadyScore: 0,
      selfBurstOnlineCount: 0,
      selfHealths: [10],
      opponentHealths: [10],
      selfEnergies: [0],
      opponentEnergies: [0],
      opponentSetupWindowScore: 0,
      opponentReserveValueScore: 0,
    })

  const previous = build(0, 1, 0, 0)
  previous.derived.self_window_score = 0
  previous.derived.self_damage_capacity_now = 0
  const setupNext = build(2, 1.5, 0.2, 0.1)
  setupNext.derived.self_window_score = 0.2
  setupNext.derived.self_damage_capacity_now = 0.1
  const realizeNext = build(0.5, 1.25, 2, 2.5)
  realizeNext.derived.self_window_score = 2
  realizeNext.derived.self_damage_capacity_now = 2.5

  const setupBreakdown = computeRewardBreakdownV1(previous, setupNext)
  const realizationBreakdown = computeRewardBreakdownV1(setupNext, realizeNext)

  expect(setupBreakdown.setup_window).toBeGreaterThan(0)
  expect(realizationBreakdown.setup_realization).toBeGreaterThan(0)
})
