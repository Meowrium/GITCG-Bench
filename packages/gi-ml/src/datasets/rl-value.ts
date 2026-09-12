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

import type { ObservationV1, OpponentHiddenEstimateV1, RlDatasetV1, RlDecisionPointSampleV1 } from "../contracts/rl-types.js"
import type { MlValueDataset, MlValueSample } from "../contracts/index.js"
import { shouldIncludeDatasetKey, type DatasetHoldoutOptions } from "./holdout.js"

export interface RlValueDatasetBuildOptions extends DatasetHoldoutOptions {
  datasetId?: string
  includeUnknownOutcome?: boolean
}

export function buildValueDatasetFromRlDataset(
  dataset: RlDatasetV1,
  options: RlValueDatasetBuildOptions = {},
): MlValueDataset {
  const samples = dataset.samples
    .filter((sample) =>
      shouldIncludeDatasetKey(sample.decision_point.decision_point_id, options))
    .map((sample) => buildValueSample(sample, options))
    .filter((sample): sample is MlValueSample => sample != null)

  return {
    dataset_id: options.datasetId ?? `rl_value__${dataset.sample_count}`,
    created_at: new Date().toISOString(),
    metadata: {
      source: "self_play",
      dataset_schema_version: dataset.schema_version,
      sample_count: samples.length,
      source_capture_count: dataset.source_capture_count,
      matchup_counts: dataset.by_matchup,
    },
    samples,
  }
}

function buildValueSample(
  sample: RlDecisionPointSampleV1,
  options: RlValueDatasetBuildOptions,
): MlValueSample | null {
  if (sample.outcome_label == null && !options.includeUnknownOutcome) {
    return null
  }

  const targetValue = sample.outcome_label ?? 0.5

  // Base weight from reward magnitude (existing logic)
  const rewardWeight =
    sample.reward_breakdown == null
      ? 1
      : clamp(0.5 + Math.abs(sample.reward_breakdown.terminal) + Math.abs(sample.reward_breakdown.clipped_shaping_total), 0.25, 2)

  // Strategy-luck adjustment: reduce weight for luck-dominated samples.
  // When a sample's outcome is heavily influenced by dice RNG (rather than
  // strategic decisions), we down-weight it so the model focuses on learning
  // from samples where strategy truly mattered.
  const luckFactor = computeStrategyFactor(sample.observation)
  const weight = clamp(rewardWeight * luckFactor, 0.1, 2.5)

  return {
    sample_id: sample.decision_point.decision_point_id,
    source: "self_play",
    state_ref: sample.observation.point.decision_point_id,
    target_value: targetValue,
    weight,
    context_slots: {
      matchup_id: sample.matchup_id,
      side: sample.side,
      round: sample.observation.point.round_number,
      phase: sample.observation.point.phase,
      pending_method: sample.observation.point.pending_method,
      current_turn: sample.observation.point.current_turn,
      action_count_in_round: sample.observation.point.action_count_in_round,
      reward_total: sample.reward_breakdown?.total ?? 0,
      reward_terminal: sample.reward_breakdown?.terminal ?? 0,
      reward_shaping_total: sample.reward_breakdown?.clipped_shaping_total ?? 0,
    },
    feature_slots: buildObservationValueFeatureSlots(sample.observation),
  }
}

export function buildObservationValueFeatureSlots(observation: ObservationV1) {
  const selfActive =
    observation.self.active_character_index != null
      ? observation.self.characters[observation.self.active_character_index] ?? null
      : null
  const oppActive =
    observation.opponent.active_character_index != null
      ? observation.opponent.characters[observation.opponent.active_character_index] ?? null
      : null

  return {
    round: observation.point.round_number,
    current_turn: observation.point.current_turn,
    action_count_in_round: observation.point.action_count_in_round,
    self: {
      hand_count: observation.self.hand.card_count,
      dice_count: observation.self.dice.total_count,
      omni_count: observation.self.dice.omni_count,
      support_count: observation.self.supports.length,
      summon_count: observation.self.summons.length,
      alive_count: observation.self.characters.filter((character) => character.alive).length,
      total_health: observation.self.characters.reduce((sum, character) => sum + character.health, 0),
      total_energy: observation.self.characters.reduce((sum, character) => sum + character.energy, 0),
      active_health: selfActive?.health ?? 0,
      active_energy: selfActive?.energy ?? 0,
      can_afford_normal: observation.self.dice.total_count >= 2 ? 1 : 0,
      can_afford_skill: observation.self.dice.total_count >= 3 ? 1 : 0,
      can_afford_burst: observation.self.dice.total_count >= 4 ? 1 : 0,
    },
    opponent: {
      hand_count: observation.opponent.hand.card_count,
      dice_count: observation.opponent.dice.total_count,
      omni_count: observation.opponent.dice.omni_count,
      support_count: observation.opponent.supports.length,
      summon_count: observation.opponent.summons.length,
      alive_count: observation.opponent.characters.filter((character) => character.alive).length,
      total_health: observation.opponent.characters.reduce((sum, character) => sum + character.health, 0),
      total_energy: observation.opponent.characters.reduce((sum, character) => sum + character.energy, 0),
      active_health: oppActive?.health ?? 0,
      active_energy: oppActive?.energy ?? 0,
    },
    // Per-character features for finer granularity
    self_characters: buildCharacterFeatures(observation.self.characters),
    opponent_characters: buildCharacterFeatures(observation.opponent.characters),
    opponent_bench: buildOpponentBenchFeatures(observation.opponent),
    // Hand card composition
    hand_composition: buildHandCompositionFeatures(observation.self.hand),
    public_state: {
      self_declared_end: observation.public_state.self_declared_end,
      opponent_declared_end: observation.public_state.opponent_declared_end,
      self_support_count: observation.public_state.self_support_count,
      opponent_support_count: observation.public_state.opponent_support_count,
      self_summon_count: observation.public_state.self_summon_count,
      opponent_summon_count: observation.public_state.opponent_summon_count,
    },
    derived: {
      self_damage_capacity_now: observation.derived.self_damage_capacity_now,
      opp_damage_capacity_now: observation.derived.opp_damage_capacity_now,
      self_ko_pressure_now: observation.derived.self_ko_pressure_now,
      opp_ko_pressure_now: observation.derived.opp_ko_pressure_now,
      self_resource_score: observation.derived.self_resource_score,
      opp_resource_score: observation.derived.opp_resource_score,
      self_reaction_ready_score: observation.derived.self_reaction_ready_score,
      opp_reaction_ready_score: observation.derived.opp_reaction_ready_score,
      self_burst_online_count: observation.derived.self_burst_online_count,
      opp_burst_online_count: observation.derived.opp_burst_online_count,
      self_role_integrity_score: observation.derived.self_role_integrity_score,
      opp_role_integrity_score: observation.derived.opp_role_integrity_score,
      self_window_score: observation.derived.self_window_score,
      opp_window_score: observation.derived.opp_window_score,
      // P2: Extended derived features
      dice_efficiency: observation.derived.dice_efficiency ?? 0,
      summon_pressure: observation.derived.summon_pressure ?? 0,
      action_economy_ratio: observation.derived.action_economy_ratio ?? 1,
      // P2-2: Temporal portfolio features
      self_temporal_setup_saturation: observation.derived.self_temporal_setup_saturation ?? 0,
      self_ready_to_cash_option_count: observation.derived.self_ready_to_cash_option_count ?? 0,
      self_blocked_synergy_option_count: observation.derived.self_blocked_synergy_option_count ?? 0,
      self_available_deferred_option_count: observation.derived.self_available_deferred_option_count ?? 0,
      opp_temporal_setup_saturation: observation.derived.opp_temporal_setup_saturation ?? 0,
      opp_ready_to_cash_option_count: observation.derived.opp_ready_to_cash_option_count ?? 0,
      opp_blocked_synergy_option_count: observation.derived.opp_blocked_synergy_option_count ?? 0,
      opp_available_deferred_option_count: observation.derived.opp_available_deferred_option_count ?? 0,
      // P2-3: Threshold + setup/reserve/game-level features (v20: fix 0% WR caused by missing predictive features)
      self_setup_window_score: observation.derived.self_setup_window_score,
      opp_setup_window_score: observation.derived.opp_setup_window_score,
      self_reserve_value_score: observation.derived.self_reserve_value_score,
      opp_reserve_value_score: observation.derived.opp_reserve_value_score,
      game_setup_completion: observation.derived.game_setup_completion ?? -1,
      game_phase_estimate: observation.derived.game_phase_estimate ?? -1,
      game_primary_path_viable: observation.derived.game_primary_path_viable ?? -1,
      ...observation.derived.threshold,
      ...observation.derived.elemental_application_map,
    },
    static_priors: {
      self_effect_family_counts: observation.self.effect_family_counts ?? {},
      self_meta_prior_slots: observation.self.meta_prior_slots ?? {},
      opponent_public_effect_family_counts: observation.opponent.effect_family_counts ?? {},
      opponent_public_meta_prior_slots: observation.opponent.meta_prior_slots ?? {},
    },
    pending_method: buildPendingMethodFeatures(observation.point.pending_method),
    self_active: buildSelfActiveFeatures(selfActive, observation.self.dice.total_count),
    opponent_active: buildOpponentActiveFeatures(oppActive, observation.opponent),
    opponent_hand_estimate: buildOpponentHandEstimateFeatures(observation.hidden_estimate),
    opp_history: buildOpponentHistoryFeatures(observation),
  }
}

interface CharacterObsLike {
  slot_index: number
  definition_id: number
  alive: boolean
  is_active: boolean
  health: number
  max_health: number
  energy: number
  max_energy: number
  equipment_ids?: number[]
  entities?: readonly { definition_id: number; variable_name?: string | null; variable_value?: number | null }[]
}

function buildCharacterFeatures(
  characters: readonly CharacterObsLike[],
): Record<string, number> {
  const features: Record<string, number> = {}
  for (let i = 0; i < 3; i++) {
    const ch = characters[i]
    const prefix = `c${i}`
    if (!ch) {
      features[`${prefix}_alive`] = 0
      features[`${prefix}_hp`] = 0
      features[`${prefix}_hp_ratio`] = 0
      features[`${prefix}_energy_ratio`] = 0
      features[`${prefix}_equip_count`] = 0
      features[`${prefix}_definition_id`] = 0
      continue
    }
    features[`${prefix}_alive`] = ch.alive ? 1 : 0
    features[`${prefix}_hp`] = ch.health
    features[`${prefix}_hp_ratio`] = ch.max_health > 0 ? ch.health / ch.max_health : 0
    features[`${prefix}_energy_ratio`] = ch.max_energy > 0 ? ch.energy / ch.max_energy : 0
    features[`${prefix}_equip_count`] = ch.equipment_ids?.length ?? 0
    features[`${prefix}_definition_id`] = ch.definition_id ?? 0
  }
  return features
}

interface HandObsLike {
  visible_cards: readonly { definition_id?: number | null; tags?: readonly string[]; static_effect_tags?: readonly string[] }[]
  card_count: number
}

function buildHandCompositionFeatures(hand: HandObsLike): Record<string, number> {
  let eventCount = 0
  let supportCount = 0
  let equipmentCount = 0
  let foodCount = 0
  let otherCount = 0
  for (const card of hand.visible_cards) {
    const allTags = [...(card.tags ?? []), ...(card.static_effect_tags ?? [])].map(String)
    if (allTags.some((t) => t === "tag:food" || t === "food")) {
      foodCount++
    } else if (allTags.some((t) => t === "support_card" || t === "support_create")) {
      supportCount++
    } else if (allTags.some((t) => t === "equipment_card" || t === "weapon" || t === "artifact")) {
      equipmentCount++
    } else if (allTags.some((t) => t === "event")) {
      eventCount++
    } else {
      otherCount++
    }
  }
  // Per-card definition_id (up to 10 slots, zero-padded)
  const cardIds: Record<string, number> = {}
  const maxHandSlots = 10
  for (let i = 0; i < maxHandSlots; i++) {
    const card = hand.visible_cards[i]
    cardIds[`card${i}_definition_id`] = card?.definition_id ?? 0
  }
  return {
    total: hand.card_count,
    event_count: eventCount,
    support_count: supportCount,
    equipment_count: equipmentCount,
    food_count: foodCount,
    other_count: otherCount,
    ...cardIds,
  }
}

function buildPendingMethodFeatures(pendingMethod: string | null): Record<string, number> {
  // One-hot encode pending method so GBDT can learn per-method value functions
  // Available at both training and inference time from ObservationV1.point.pending_method
  const set = new Set<string>()
  if (pendingMethod) {
    set.add(pendingMethod)
  }
  return {
    is_action: set.has("action") ? 1 : 0,
    is_choose_active: set.has("chooseActive") ? 1 : 0,
    is_reroll_dice: set.has("rerollDice") ? 1 : 0,
    is_switch_hands: set.has("switchHands") ? 1 : 0,
    is_select_card: set.has("selectCard") ? 1 : 0,
  }
}

function buildOpponentBenchFeatures(
  opponent: ObservationV1["opponent"],
): { min_hp: number; min_hp_index: number } {
  let minHp = Infinity
  let minHpIndex = -1
  for (let i = 0; i < opponent.characters.length; i++) {
    const ch = opponent.characters[i]
    if (!ch.alive || ch.is_active) continue
    if (ch.health < minHp) {
      minHp = ch.health
      minHpIndex = i
    }
  }
  if (minHpIndex === -1) minHp = 0
  return { min_hp: minHp, min_hp_index: minHpIndex }
}

function buildOpponentActiveFeatures(
  oppActive: CharacterObsLike | null,
  opponent: ObservationV1["opponent"],
): { is_frozen: 0 | 1; is_stunned: 0 | 1; shield: number } {
  let isFrozen = 0 as 0 | 1
  let isStunned = 0 as 0 | 1
  if (oppActive) {
    if (oppActive.entities?.some((e) => e.definition_id === 106)) {
      isFrozen = 1
    }
    if (oppActive.entities?.some((e) => e.definition_id === 116033)) {
      isStunned = 1
    }
  }
  // Shield: from opponent's combat_statuses whose variable_name contains "shield"
  const shieldValue = opponent.combat_statuses?.reduce((sum, cs) => {
    if (cs.variable_name && cs.variable_name.toLowerCase().includes("shield")) {
      return sum + (cs.variable_value ?? 0)
    }
    return sum
  }, 0) ?? 0

  return { is_frozen: isFrozen, is_stunned: isStunned, shield: shieldValue }
}

function buildSelfActiveFeatures(
  selfActive: CharacterObsLike | null,
  totalDice: number,
): { skill_damage_normal: number; skill_damage_skill: number; skill_damage_burst: number; energy_full: 0 | 1 } {
  const defaultDamage = { normal: 2, skill: 3, burst: 4 }
  return {
    skill_damage_normal: defaultDamage.normal,
    skill_damage_skill: defaultDamage.skill,
    skill_damage_burst: defaultDamage.burst,
    energy_full: (selfActive && selfActive.max_energy > 0 && selfActive.energy >= selfActive.max_energy) ? 1 : 0,
  }
}

function buildOpponentHandEstimateFeatures(
  hidden: OpponentHiddenEstimateV1 | null,
): Record<string, number> {
  if (!hidden) {
    return {
      hidden_hand_count: 0,
      deck_remaining: 0,
      expected_event: 0,
      expected_equipment: 0,
      expected_support: 0,
      expected_food: 0,
      expected_resonance: 0,
      response_heal: 0,
      response_dice_fix: 0,
      response_swap: 0,
      response_burst: 0,
      known_revealed_cards: 0,
      deck_draw_ratio: 0,
    }
  }
  const totalDeck = hidden.hidden_hand_count + hidden.remaining_deck_count
  return {
    hidden_hand_count: hidden.hidden_hand_count,
    deck_remaining: hidden.remaining_deck_count,
    expected_event: hidden.expected_type_counts.event,
    expected_equipment: hidden.expected_type_counts.equipment,
    expected_support: hidden.expected_type_counts.support,
    expected_food: hidden.expected_type_counts.food,
    expected_resonance: hidden.expected_type_counts.resonance,
    response_heal: hidden.expected_response_buckets.heal_like,
    response_dice_fix: hidden.expected_response_buckets.dice_fix_like,
    response_swap: hidden.expected_response_buckets.swap_like,
    response_burst: hidden.expected_response_buckets.burst_enable_like,
    known_revealed_cards: hidden.known_revealed_definition_ids.length,
    deck_draw_ratio: totalDeck > 0 ? hidden.remaining_deck_count / totalDeck : 0,
  }
}

function buildOpponentHistoryFeatures(
  observation: ObservationV1,
): Record<string, number> {
  const opp = observation.opponent
  const oppChars = opp.characters
  const oppActive = opp.active_character_index != null
    ? oppChars[opp.active_character_index] ?? null
    : null
  const oppDice = opp.dice

  // Dice state: estimate dice spent this round
  // Max dice per round ≈ 8; spent = 8 - remaining (clamped)
  const oppDiceTotal = oppDice.total_count
  const oppOmni = oppDice.omni_count
  const oppElemental = oppDiceTotal - oppOmni
  const diceSpent = Math.max(0, 8 - oppDiceTotal)

  // Action rhythm
  const oppDeclaredEnd = observation.public_state.opponent_declared_end ? 1 : 0
  const oppActionsInRound = observation.point.action_count_in_round

  // Board state
  const oppAlive = oppChars.filter((c) => c.alive).length
  const oppTotalHp = oppChars.reduce((s, c) => s + (c.alive ? c.health : 0), 0)
  const oppMaxHp = oppChars.reduce((s, c) => s + c.max_health, 0)
  const activeHpRatio = oppActive ? oppActive.health / Math.max(oppActive.max_health, 1) : 0

  // Burst readiness
  let burstReady = 0
  let burstNear = 0
  for (const ch of oppChars) {
    if (!ch.alive) continue
    if (ch.max_energy > 0 && ch.energy >= ch.max_energy) burstReady++
    else if (ch.max_energy > 0 && ch.energy >= ch.max_energy - 1) burstNear++
  }

  // Board development
  const boardDevelopment = opp.supports.length + opp.summons.length

  // Threat
  const oppHpRatio = oppMaxHp > 0 ? oppTotalHp / oppMaxHp : 1
  const koPressure = oppAlive > 0 ? (1 - oppHpRatio) * oppAlive : 0
  const damageCapacity = oppDiceTotal >= 3 ? oppAlive * 2 : oppAlive

  return {
    dice_spent_this_round: diceSpent,
    omni_remaining: oppOmni,
    elemental_remaining: oppElemental,
    omni_ratio: oppDiceTotal > 0 ? oppOmni / oppDiceTotal : 0,
    actions_in_round: oppActionsInRound,
    active_hp_ratio: activeHpRatio,
    burst_ready_count: burstReady,
    burst_near_count: burstNear,
    board_development: boardDevelopment,
    alive_count: oppAlive,
    declared_end: oppDeclaredEnd,
    ko_pressure: koPressure,
    damage_capacity: damageCapacity,
    // Reuse derived features already computed for opponent
    action_economy_ratio: observation.derived.action_economy_ratio ?? 1,
    temporal_setup_sat: observation.derived.opp_temporal_setup_saturation ?? 0,
    ready_to_cash: observation.derived.opp_ready_to_cash_option_count ?? 0,
    blocked_synergy: observation.derived.opp_blocked_synergy_option_count ?? 0,
    available_deferred: observation.derived.opp_available_deferred_option_count ?? 0,
  }
}

// ── Strategy-Luck Weight Adjustment ─────────────────────────────────────
//
// Reduces sample weight when the outcome is heavily influenced by RNG
// (dice luck), encouraging the model to focus on samples where strategy
// decisions made the difference.

/** Expected omni dice count for N fair 8-sided dice. */
const EXPECTED_OMNI_RATIO = 1 / 8

/**
 * Compute a strategy factor ∈ [STRATEGY_FACTOR_MIN, 1.0] that multiplies
 * into the sample weight.
 *
 * Higher = more strategy signal, lower = more luck-dominated.
 *
 * Proxies used (computable from ObservationV1 alone, no engine needed):
 * 1. Dice omni deviation: how far the actual omni count is from expected.
 *    Large deviation → dice RNG had unusual impact → down-weight.
 * 2. Dice total deviation: having unusually many or few dice left.
 *    Very low dice → forced pass → not a real strategy decision.
 * 3. Round: early rounds have higher luck variance (fewer actions taken).
 *    R1 samples get a mild penalty.
 */
const STRATEGY_FACTOR_MIN = 0.25
const STRATEGY_FACTOR_EARLY_ROUND_PENALTY = 0.85

function computeStrategyFactor(observation: ObservationV1): number {
  const diceTotal = observation.self.dice.total_count
  const omniCount = observation.self.dice.omni_count

  // 1. Dice omni deviation
  let omniFactor = 1.0
  if (diceTotal > 0) {
    const expectedOmni = diceTotal * EXPECTED_OMNI_RATIO
    const omniDeviation = Math.abs(omniCount - expectedOmni)
    // Large omni surplus/deficit → more luck influence
    // Normalized: 8 omni dice would be max deviation of ~7
    const omniNorm = omniDeviation / Math.max(diceTotal, 1)
    // Map: norm=0 → 1.0, norm=0.5 → 0.6, norm=1.0 → 0.3
    omniFactor = 1.0 - omniNorm * 0.7
  }

  // 2. Dice count abnormality: very low dice means forced pass decisions
  let diceCountFactor = 1.0
  if (diceTotal <= 1) {
    // Almost no agency — heavily luck-dominated
    diceCountFactor = 0.4
  } else if (diceTotal <= 2) {
    diceCountFactor = 0.65
  }

  // 3. Early round penalty: R1 has fewer total decisions, so individual
  //    luck events have proportionally larger impact on outcome
  const round = observation.point.round_number
  let roundFactor = 1.0
  if (round <= 1) {
    roundFactor = STRATEGY_FACTOR_EARLY_ROUND_PENALTY
  } else if (round <= 2) {
    roundFactor = 0.92
  }

  // Combine: take the minimum (most restrictive) of all factors
  // This is conservative — a sample is only up-weighted if ALL
  // luck proxies show low luck influence
  const rawFactor = Math.min(omniFactor, diceCountFactor, roundFactor)

  return Math.max(STRATEGY_FACTOR_MIN, rawFactor)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
