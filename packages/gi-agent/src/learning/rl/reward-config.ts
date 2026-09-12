// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type {
  ObservationV1,
  RewardBreakdownV1,
  RewardComputationOptionsV1,
  RewardConfigV1,
} from "@gi-tcg/ml/contracts"

const DEFAULT_ENABLED_EVENTS = [
  "damage",
  "ko",
  "energy",
  "hand",
  "reaction_ready",
  "burst_online",
  "setup_window",
  "reserve_value",
  "setup_realization",
  "element_application",
  "focus_damage",
] as const

export const DEFAULT_REWARD_CONFIG_V1: RewardConfigV1 = {
  reward_version: "reward.v3",
  terminal: {
    win: 2.0,
    loss: -2.0,
    draw: 0.0,
  },
  shaping: {
    damage_coef: 0.025,
    ko_bonus: 0.20,
    energy_coef: 0.02,
    hand_coef: 0.01,
    reaction_ready_bonus: 0.04,
    burst_online_bonus: 0.06,
    setup_window_bonus: 0.0125,
    reserve_value_bonus: 0.008,
    setup_realization_bonus: 0.025,
    element_application_bonus: 0.02,
    focus_damage_bonus: 0.05,
    step_clip: 0.25,
    burst_waste_penalty_coef: 0.04,
    collapse_penalty_coef: 0.03,
    phase_alignment_bonus_coef: 0.02,
    dice_efficiency_bonus_coef: 0.01,
    key_char_protect_bonus_coef: 0.04,
  },
  enabled_events: [...DEFAULT_ENABLED_EVENTS, "burst_waste", "collapse", "phase_alignment", "dice_efficiency", "key_char_protect"],
  disabled_events: [],
}

export function createDefaultRewardConfigV1(): RewardConfigV1 {
  return {
    reward_version: DEFAULT_REWARD_CONFIG_V1.reward_version,
    terminal: { ...DEFAULT_REWARD_CONFIG_V1.terminal },
    shaping: { ...DEFAULT_REWARD_CONFIG_V1.shaping },
    enabled_events: [...DEFAULT_REWARD_CONFIG_V1.enabled_events],
    disabled_events: [...DEFAULT_REWARD_CONFIG_V1.disabled_events],
  }
}

export function computeRewardBreakdownV1(
  previous: ObservationV1,
  next: ObservationV1,
  options: RewardComputationOptionsV1 = {},
): RewardBreakdownV1 {
  const config = options.config ?? DEFAULT_REWARD_CONFIG_V1
  const terminal = computeTerminalReward(config, options.terminalOutcome ?? null)

  const damage =
    isRewardEventEnabled(config, "damage")
      ? config.shaping.damage_coef * computeDamageSwing(previous, next)
      : 0
  const ko =
    isRewardEventEnabled(config, "ko")
      ? config.shaping.ko_bonus * computeKoSwing(previous, next)
      : 0
  const energy =
    isRewardEventEnabled(config, "energy")
      ? config.shaping.energy_coef * computeEnergySwing(previous, next)
      : 0
  const hand =
    isRewardEventEnabled(config, "hand")
      ? config.shaping.hand_coef * computeHandSwing(previous, next)
      : 0
  const reactionReady =
    isRewardEventEnabled(config, "reaction_ready")
      ? config.shaping.reaction_ready_bonus * computeReactionReadySwing(previous, next)
      : 0
  const burstOnline =
    isRewardEventEnabled(config, "burst_online")
      ? config.shaping.burst_online_bonus * computeBurstOnlineSwing(previous, next)
      : 0
  const setupWindow =
    isRewardEventEnabled(config, "setup_window")
      ? config.shaping.setup_window_bonus * computeSetupWindowSwing(previous, next)
      : 0
  const reserveValue =
    isRewardEventEnabled(config, "reserve_value")
      ? config.shaping.reserve_value_bonus * computeReserveValueSwing(previous, next)
      : 0
  const setupRealization =
    isRewardEventEnabled(config, "setup_realization")
      ? config.shaping.setup_realization_bonus * computeSetupRealizationSwing(previous, next)
      : 0

  const elementApplication =
    isRewardEventEnabled(config, "element_application")
      ? (config.shaping.element_application_bonus ?? 0) * computeElementApplicationSwing(previous, next)
      : 0
  const focusDamage =
    isRewardEventEnabled(config, "focus_damage")
      ? (config.shaping.focus_damage_bonus ?? 0) * computeFocusDamageSwing(previous, next)
      : 0

  // New shaping terms (v3)
  const burstWaste =
    isRewardEventEnabled(config, "burst_waste")
      ? -(config.shaping.burst_waste_penalty_coef ?? 0.04) * computeBurstWastePenalty(previous, next)
      : 0
  const collapse =
    isRewardEventEnabled(config, "collapse")
      ? -(config.shaping.collapse_penalty_coef ?? 0.03) * computeCollapsePenaltySwing(previous, next)
      : 0
  const phaseAlignment =
    isRewardEventEnabled(config, "phase_alignment")
      ? (config.shaping.phase_alignment_bonus_coef ?? 0.02) * computePhaseAlignmentBonus(previous, next)
      : 0
  const diceEfficiency =
    isRewardEventEnabled(config, "dice_efficiency")
      ? (config.shaping.dice_efficiency_bonus_coef ?? 0.01) * computeDiceEfficiencyBonus(previous, next)
      : 0
  const keyCharProtect =
    isRewardEventEnabled(config, "key_char_protect")
      ? (config.shaping.key_char_protect_bonus_coef ?? 0.04) * computeKeyCharProtectBonus(previous, next)
      : 0

  const shapingTotal =
    damage +
    ko +
    energy +
    hand +
    reactionReady +
    burstOnline +
    setupWindow +
    reserveValue +
    setupRealization +
    elementApplication +
    focusDamage +
    burstWaste +
    collapse +
    phaseAlignment +
    diceEfficiency +
    keyCharProtect
  const clippedShapingTotal = clamp(
    shapingTotal,
    -config.shaping.step_clip,
    config.shaping.step_clip,
  )

  return {
    reward_version: config.reward_version,
    terminal,
    damage,
    ko,
    energy,
    hand,
    reaction_ready: reactionReady,
    burst_online: burstOnline,
    setup_window: setupWindow,
    reserve_value: reserveValue,
    setup_realization: setupRealization,
    element_application: elementApplication,
    focus_damage: focusDamage,
    burst_waste: burstWaste,
    collapse,
    phase_alignment: phaseAlignment,
    dice_efficiency: diceEfficiency,
    key_char_protect: keyCharProtect,
    shaping_total: shapingTotal,
    clipped_shaping_total: clippedShapingTotal,
    total: terminal + clippedShapingTotal,
  }
}

function computeTerminalReward(
  config: RewardConfigV1,
  outcome: RewardComputationOptionsV1["terminalOutcome"],
): number {
  switch (outcome) {
    case "win":
      return config.terminal.win
    case "loss":
      return config.terminal.loss
    case "draw":
      return config.terminal.draw
    default:
      return 0
  }
}

function isRewardEventEnabled(config: RewardConfigV1, eventName: string): boolean {
  const disabled = config.disabled_events ?? []
  const enabled = config.enabled_events ?? []
  if (disabled.includes(eventName)) {
    return false
  }
  if (enabled.length === 0) {
    return true
  }
  return enabled.includes(eventName)
}

function computeDamageSwing(previous: ObservationV1, next: ObservationV1): number {
  const opponentDamage = Math.max(0, sumAliveHealth(previous.opponent) - sumAliveHealth(next.opponent))
  const selfDamage = Math.max(0, sumAliveHealth(previous.self) - sumAliveHealth(next.self))
  return opponentDamage - selfDamage
}

function computeKoSwing(previous: ObservationV1, next: ObservationV1): number {
  const opponentKos = Math.max(0, countAlive(previous.opponent) - countAlive(next.opponent))
  const selfKos = Math.max(0, countAlive(previous.self) - countAlive(next.self))
  return opponentKos - selfKos
}

function computeEnergySwing(previous: ObservationV1, next: ObservationV1): number {
  const selfGain = Math.max(0, sumEnergy(next.self) - sumEnergy(previous.self))
  const opponentGain = Math.max(0, sumEnergy(next.opponent) - sumEnergy(previous.opponent))
  return selfGain - opponentGain
}

function computeHandSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfDelta = next.self.hand.card_count - previous.self.hand.card_count
  const opponentDelta = next.opponent.hand.card_count - previous.opponent.hand.card_count
  return selfDelta - opponentDelta
}

function computeReactionReadySwing(previous: ObservationV1, next: ObservationV1): number {
  const selfEntered = transitionIntoReady(
    previous.derived.self_reaction_ready_score,
    next.derived.self_reaction_ready_score,
  )
  const opponentEntered = transitionIntoReady(
    previous.derived.opp_reaction_ready_score,
    next.derived.opp_reaction_ready_score,
  )
  return selfEntered - opponentEntered
}

function computeBurstOnlineSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfEntered = Math.max(
    0,
    next.derived.self_burst_online_count - previous.derived.self_burst_online_count,
  )
  const opponentEntered = Math.max(
    0,
    next.derived.opp_burst_online_count - previous.derived.opp_burst_online_count,
  )
  return selfEntered - opponentEntered
}

function computeSetupWindowSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfDelta =
    next.derived.self_setup_window_score - previous.derived.self_setup_window_score
  const opponentDelta =
    next.derived.opp_setup_window_score - previous.derived.opp_setup_window_score
  return selfDelta - opponentDelta
}

function computeReserveValueSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfDelta =
    next.derived.self_reserve_value_score - previous.derived.self_reserve_value_score
  const opponentDelta =
    next.derived.opp_reserve_value_score - previous.derived.opp_reserve_value_score
  return selfDelta - opponentDelta
}

function computeSetupRealizationSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfSetupSpent = Math.max(
    0,
    previous.derived.self_setup_window_score - next.derived.self_setup_window_score,
  )
  const opponentSetupSpent = Math.max(
    0,
    previous.derived.opp_setup_window_score - next.derived.opp_setup_window_score,
  )
  const selfConversionGain =
    Math.max(0, next.derived.self_window_score - previous.derived.self_window_score) +
    Math.max(0, next.derived.self_damage_capacity_now - previous.derived.self_damage_capacity_now) * 0.5
  const opponentConversionGain =
    Math.max(0, next.derived.opp_window_score - previous.derived.opp_window_score) +
    Math.max(0, next.derived.opp_damage_capacity_now - previous.derived.opp_damage_capacity_now) * 0.5
  return Math.min(selfSetupSpent, selfConversionGain) - Math.min(opponentSetupSpent, opponentConversionGain)
}

function transitionIntoReady(previous: number, next: number): number {
  return previous <= 0 && next > 0 ? 1 : 0
}

function sumAliveHealth(observation: ObservationV1["self"]): number {
  return observation.characters.reduce(
    (sum, character) => sum + (character.alive ? character.health : 0),
    0,
  )
}

function sumEnergy(observation: ObservationV1["self"]): number {
  return observation.characters.reduce((sum, character) => sum + character.energy, 0)
}

function countAlive(observation: ObservationV1["self"]): number {
  return observation.characters.filter((character) => character.alive).length
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// HC-07: 元素附着奖励 — 鼓励为后续反应铺路
function computeElementApplicationSwing(previous: ObservationV1, next: ObservationV1): number {
  const selfApplied = auraApplied(previous.opponent, next.opponent) ? 1 : 0
  const oppApplied = auraApplied(previous.self, next.self) ? 1 : 0
  return selfApplied - oppApplied
}

function auraApplied(
  prevPlayer: ObservationV1["self"],
  nextPlayer: ObservationV1["self"],
): boolean {
  const prevActive = prevPlayer.characters.find((c) => c.is_active)
  const nextActive = nextPlayer.characters.find((c) => c.is_active)
  if (!prevActive || !nextActive) return false
  const prevHasAura = prevActive.aura != null && prevActive.aura !== 0
  const nextHasAura = nextActive.aura != null && nextActive.aura !== 0
  return !prevHasAura && nextHasAura
}

// HC-05: 集中伤害奖励 — 鼓励将伤害集中在同一目标上
function computeFocusDamageSwing(previous: ObservationV1, next: ObservationV1): number {
  // 对手角色被击倒 = 最大集中奖
  const oppKos = Math.max(0, countAlive(previous.opponent) - countAlive(next.opponent))
  if (oppKos > 0) return oppKos * 2

  // 伤害集中在出战角色（后台无损）
  const prevActiveHp = getActiveCharHp(previous.opponent)
  const nextActiveHp = getActiveCharHp(next.opponent)
  const activeHpDrop = Math.max(0, prevActiveHp - nextActiveHp)
  const prevBackHp = sumBacklineHealth(previous.opponent)
  const nextBackHp = sumBacklineHealth(next.opponent)
  const backHpDrop = Math.max(0, prevBackHp - nextBackHp)

  if (activeHpDrop > 0 && backHpDrop === 0) return 1
  return 0
}

function getActiveCharHp(player: ObservationV1["self"]): number {
  const active = player.characters.find((c) => c.is_active)
  return active ? active.health : 0
}

function sumBacklineHealth(player: ObservationV1["self"]): number {
  return player.characters
    .filter((c) => !c.is_active && c.alive)
    .reduce((sum, c) => sum + c.health, 0)
}

// ── New shaping term computations (v3) ──

function computeBurstWastePenalty(previous: ObservationV1, next: ObservationV1): number {
  let penalty = 0
  for (const prevChar of previous.self.characters) {
    if (!prevChar.alive) continue
    const nextChar = next.self.characters.find(c => c.definition_id === prevChar.definition_id)
    if (nextChar && nextChar.alive) continue

    // Character went from alive → dead: wasted energy
    const wastedEnergy = prevChar.energy
    // Burst-ready characters waste more
    const multiplier = prevChar.energy >= prevChar.max_energy && prevChar.max_energy > 0 ? 1.5 : 1.0
    penalty += wastedEnergy * multiplier
  }
  return penalty
}

function computeCollapsePenaltySwing(previous: ObservationV1, next: ObservationV1): number {
  // Penalty when collapse distance decreases (characters get closer to functional collapse)
  const prevMinHpRatio = minAliveHpRatio(previous.self)
  const nextMinHpRatio = minAliveHpRatio(next.self)
  const selfDelta = Math.max(0, prevMinHpRatio - nextMinHpRatio)

  const prevOppMinHpRatio = minAliveHpRatio(previous.opponent)
  const nextOppMinHpRatio = minAliveHpRatio(next.opponent)
  const oppDelta = Math.max(0, nextOppMinHpRatio - prevOppMinHpRatio)

  return selfDelta - oppDelta
}

function minAliveHpRatio(player: ObservationV1["self"]): number {
  const alive = player.characters.filter(c => c.alive)
  if (alive.length === 0) return 0
  return Math.min(...alive.map(c => c.health / Math.max(1, c.max_health)))
}

function computePhaseAlignmentBonus(previous: ObservationV1, next: ObservationV1): number {
  // Bonus for actions that align with the current game phase
  const prevSetup = previous.derived.self_setup_window_score
  const nextSetup = next.derived.self_setup_window_score
  const prevDamage = previous.derived.self_damage_capacity_now
  const nextDamage = next.derived.self_damage_capacity_now

  // If transitioning from setup to execution (setup decreasing, damage increasing), that's aligned
  const setupDelta = nextSetup - prevSetup
  const damageDelta = nextDamage - prevDamage

  // Positive alignment: either advancing setup during setup phase or advancing damage during execution
  if (prevSetup > 0.5) {
    // Setup phase: advancing setup is good
    return Math.max(0, setupDelta) > 0 ? 0.5 : 0
  } else {
    // Execution phase: advancing damage is good
    return Math.max(0, damageDelta) > 0 ? 0.5 : 0
  }
}

function computeDiceEfficiencyBonus(previous: ObservationV1, next: ObservationV1): number {
  // Reward for ending the round with fewer unused dice
  const prevDice = previous.self.dice.total_count
  const nextDice = next.self.dice.total_count
  // If dice decreased (used more), that's efficient
  const diceUsed = prevDice - nextDice
  return Math.max(0, diceUsed) / Math.max(1, prevDice)
}

function computeKeyCharProtectBonus(previous: ObservationV1, next: ObservationV1): number {
  // Bonus for core characters surviving to execution phase
  const prevBurstOnline = previous.derived.self_burst_online_count
  const nextBurstOnline = next.derived.self_burst_online_count

  // If a burst-ready character was still alive (they didn't die)
  const prevAliveCount = previous.self.characters.filter(c => c.alive).length
  const nextAliveCount = next.self.characters.filter(c => c.alive).length

  // If core character survived and burst is available, positive bonus
  if (prevBurstOnline > 0 && nextBurstOnline > 0 && nextAliveCount >= prevAliveCount) {
    return 1
  }

  // If we had burst online and still have it → maintain bonus
  if (prevBurstOnline > 0 && nextBurstOnline > 0) {
    return 0.5
  }

  return 0
}
