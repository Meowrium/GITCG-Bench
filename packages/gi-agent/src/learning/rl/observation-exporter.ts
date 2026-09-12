// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { exposeState, type GameState } from "@gi-tcg/core"
import { PbDiceType, type Notification } from "@gi-tcg/typings"
import type {
  CharacterObservationV1,
  DerivedObservationFeaturesV1,
  DicePoolObservationV1,
  EntityObservationV1,
  HandCardObservationV1,
  ObservationExportOptionsV1,
  ObservationV1,
  OpponentHiddenEstimateV1,
  PlayerObservationV1,
  PublicBoardObservationV1,
} from "@gi-tcg/ml/contracts"
import {
  buildHandCardStaticAnnotation,
  buildPlayerHandStaticPriorSummary,
} from "./static-priors.js"
import { computeThresholdFeatures } from "./threshold-features.js"
import { buildTemporalFeatures } from "./temporal-features.js"

type VisibleState = NonNullable<Notification["state"]>
type VisiblePlayerState = VisibleState["player"][number]

const DEFAULT_GAME_VERSION = "unknown"
const DEFAULT_CARD_POOL_VERSION = "unknown"
const DEFAULT_RULESET_VERSION = "unknown"
const DEFAULT_CONTRACT_VERSION = "obs.v1"

export function buildObservationV1FromVisibleState(
  state: VisibleState,
  side: 0 | 1,
  options: ObservationExportOptionsV1,
): ObservationV1 {
  const viewKind = options.viewKind ?? "policy_public"
  const self = buildPlayerObservationFromVisible(state.player[side], true, viewKind, {
    discardCount: options.optionalFlags?.selfDiscardCount ?? null,
    canCharged: options.optionalFlags?.selfCanCharged ?? null,
    canPlunging: options.optionalFlags?.selfCanPlunging ?? null,
    hasDefeated: options.optionalFlags?.selfHasDefeated ?? null,
  })
  const opponent = buildPlayerObservationFromVisible(state.player[flipSide(side)], false, viewKind, {
    discardCount: options.optionalFlags?.opponentDiscardCount ?? null,
    canCharged: options.optionalFlags?.opponentCanCharged ?? null,
    canPlunging: options.optionalFlags?.opponentCanPlunging ?? null,
    hasDefeated: options.optionalFlags?.opponentHasDefeated ?? null,
  })
  const publicState = buildPublicBoardObservation(state, side)
  const hiddenEstimate =
    viewKind === "policy_public"
      ? buildOpponentHiddenEstimate(opponent, options)
      : null

  return {
    schema_version: "obs.v1",
    source: {
      game_version: options.gameVersion ?? DEFAULT_GAME_VERSION,
      card_pool_version: options.cardPoolVersion ?? DEFAULT_CARD_POOL_VERSION,
      ruleset_version: options.rulesetVersion ?? DEFAULT_RULESET_VERSION,
      contract_version: options.contractVersion ?? DEFAULT_CONTRACT_VERSION,
      view_kind: viewKind,
    },
    point: {
      game_id: options.gameId,
      episode_id: options.episodeId,
      decision_point_id: options.decisionPointId,
      round_number: state.roundNumber,
      phase: String(state.phase),
      pending_method: options.pendingMethod ?? null,
      actor_who: options.actorWho,
      current_turn: state.currentTurn as 0 | 1,
      action_count_in_round: options.actionCountInRound ?? 0,
    },
    self,
    opponent,
    public_state: publicState,
    hidden_estimate: hiddenEstimate,
    derived: buildDerivedFeatures(self, opponent),
  }
}

export function buildObservationV1FromGameState(
  state: GameState,
  side: 0 | 1,
  options: ObservationExportOptionsV1,
): ObservationV1 {
  const viewKind = options.viewKind ?? "policy_public"
  const visible = exposeState(side, state) as VisibleState
  const observation = buildObservationV1FromVisibleState(visible, side, options)

  if (viewKind !== "debug_full") {
    return observation
  }

  const opponent = state.players[flipSide(side)]
  observation.opponent.hand = {
    visible_cards: opponent.hands.map(mapRawHandCard),
    card_count: opponent.hands.length,
  }
  observation.opponent.dice = buildDicePoolFromRaw(opponent.dice)
  const opponentStaticPriorSummary = buildPlayerHandStaticPriorSummary(
    observation.opponent.hand.visible_cards,
  )
  observation.opponent.effect_family_counts = opponentStaticPriorSummary.effect_family_counts
  observation.opponent.meta_prior_slots = opponentStaticPriorSummary.meta_prior_slots
  observation.hidden_estimate = null
  observation.derived = buildDerivedFeatures(observation.self, observation.opponent)
  return observation
}

function buildPlayerObservationFromVisible(
  player: VisiblePlayerState,
  isSelf: boolean,
  viewKind: "debug_full" | "policy_public",
  flags: {
    discardCount: number | null
    canCharged: boolean | null
    canPlunging: boolean | null
    hasDefeated: boolean | null
  },
): PlayerObservationV1 {
  const activeCharacterIndex = player.character.findIndex(
    (character) => character.id === player.activeCharacterId,
  )
  const visibleCards =
    isSelf || viewKind === "debug_full"
      ? player.handCard.map(mapVisibleHandCard)
      : []
  const staticPriorSummary = buildPlayerHandStaticPriorSummary(visibleCards)
  return {
    active_character_index:
      activeCharacterIndex >= 0 && activeCharacterIndex <= 2
        ? (activeCharacterIndex as 0 | 1 | 2)
        : null,
    characters: player.character.map((character, index) =>
      mapVisibleCharacter(character, player.activeCharacterId ?? null, index),
    ),
    summons: player.summon.map(mapVisibleEntity),
    supports: player.support.map(mapVisibleEntity),
    combat_statuses: player.combatStatus.map(mapVisibleEntity),
    dice: buildDicePoolFromVisible(player.dice),
    hand: {
      visible_cards: visibleCards,
      card_count: player.handCard.length,
    },
    pile_count: player.pileCard.length,
    discard_count: flags.discardCount,
    declared_end: player.declaredEnd,
    can_charged: flags.canCharged,
    can_plunging: flags.canPlunging,
    has_defeated: flags.hasDefeated,
    legend_used: player.legendUsed,
    effect_family_counts: staticPriorSummary.effect_family_counts,
    meta_prior_slots: staticPriorSummary.meta_prior_slots,
  }
}

function buildPublicBoardObservation(
  state: VisibleState,
  side: 0 | 1,
): PublicBoardObservationV1 {
  const self = state.player[side]
  const opponent = state.player[flipSide(side)]
  return {
    winner:
      typeof state.winner === "number"
        ? (state.winner as 0 | 1)
        : null,
    self_declared_end: self.declaredEnd,
    opponent_declared_end: opponent.declaredEnd,
    self_support_count: self.support.length,
    opponent_support_count: opponent.support.length,
    self_summon_count: self.summon.length,
    opponent_summon_count: opponent.summon.length,
  }
}

function mapVisibleCharacter(
  character: VisiblePlayerState["character"][number],
  activeCharacterId: number | null,
  index: number,
): CharacterObservationV1 {
  const entities = character.entity.map(mapVisibleEntity)
  return {
    slot_index: clampCharacterSlot(index),
    id: character.id,
    definition_id: character.definitionId,
    alive: !character.defeated,
    is_active: character.id === activeCharacterId,
    health: character.health,
    max_health: character.maxHealth,
    energy: character.energy,
    max_energy: character.maxEnergy,
    aura: typeof character.aura === "number" ? character.aura : null,
    tags: typeof character.tags === "number" ? character.tags : null,
    equipment_ids: entities.map((entity) => entity.definition_id),
    status_ids: entities.map((entity) => entity.definition_id),
    usage_counters: Object.fromEntries(
      entities
        .filter(
          (entity) =>
            entity.variable_name != null &&
            typeof entity.variable_value === "number",
        )
        .map((entity) => [entity.variable_name as string, entity.variable_value as number]),
    ),
    entities,
  }
}

function mapVisibleEntity(entity: VisiblePlayerState["support"][number]): EntityObservationV1 {
  return {
    id: entity.id,
    definition_id: entity.definitionId,
    variable_name: entity.variableName ?? null,
    variable_value:
      typeof entity.variableValue === "number" ? entity.variableValue : null,
    description_dictionary: entity.descriptionDictionary ?? {},
  }
}

function mapVisibleHandCard(card: VisiblePlayerState["handCard"][number]): HandCardObservationV1 {
  const annotation = buildHandCardStaticAnnotation(
    typeof card.definitionId === "number" ? card.definitionId : null,
    [],
    (card.definitionCost ?? []).map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
  )
  return {
    entity_id: card.id,
    definition_id: typeof card.definitionId === "number" ? card.definitionId : null,
    tags: annotation.tags,
    cost_summary: (card.definitionCost ?? []).map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
    static_effect_tags: annotation.static_effect_tags,
    meta_effect_slots: annotation.meta_effect_slots,
  }
}

function mapRawHandCard(card: GameState["players"][number]["hands"][number]): HandCardObservationV1 {
  const rawTags = (card.definition as { tags?: readonly unknown[] }).tags
  const annotation = buildHandCardStaticAnnotation(
    card.definition.id,
    Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === "string")
      : [],
    [],
  )
  return {
    entity_id: card.id,
    definition_id: card.definition.id,
    tags: annotation.tags,
    cost_summary: [],
    static_effect_tags: annotation.static_effect_tags,
    meta_effect_slots: annotation.meta_effect_slots,
  }
}

function buildDicePoolFromVisible(dice: readonly number[]): DicePoolObservationV1 {
  const counts = new Map<string, number>()
  let omniCount = 0
  let unspecifiedCount = 0
  for (const die of dice) {
    const key = String(die)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (die === PbDiceType.OMNI) {
      omniCount += 1
    }
    if (die === PbDiceType.UNSPECIFIED) {
      unspecifiedCount += 1
    }
  }
  return {
    counts_by_type: Object.fromEntries(counts.entries()),
    total_count: dice.length,
    omni_count: omniCount,
    unspecified_count: unspecifiedCount,
  }
}

function buildDicePoolFromRaw(dice: readonly number[]): DicePoolObservationV1 {
  return buildDicePoolFromVisible(dice)
}

function buildOpponentHiddenEstimate(
  opponent: PlayerObservationV1,
  options: ObservationExportOptionsV1,
): OpponentHiddenEstimateV1 {
  const knownDeckCount = options.knownOpponentDeckDefinitionIds?.length ?? 0
  const revealed = new Set(options.knownOpponentRevealedDefinitionIds ?? [])
  return {
    hidden_hand_count: opponent.hand.card_count,
    remaining_deck_count: Math.max(
      opponent.pile_count,
      knownDeckCount > 0
        ? knownDeckCount - revealed.size - opponent.hand.card_count
        : opponent.pile_count,
    ),
    known_revealed_definition_ids: [...revealed],
    expected_type_counts: {
      event: 0,
      equipment: 0,
      support: 0,
      food: 0,
      resonance: 0,
    },
    expected_response_buckets: {
      heal_like: 0,
      dice_fix_like: 0,
      swap_like: 0,
      burst_enable_like: 0,
    },
  }
}

export function buildDerivedFeatures(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
): DerivedObservationFeaturesV1 {
  const selfBurstOnline = countBurstOnline(self)
  const opponentBurstOnline = countBurstOnline(opponent)
  const selfReactionReady = scoreReactionReadiness(self, opponent)
  const opponentReactionReady = scoreReactionReadiness(opponent, self)
  const selfResourceScore = scoreResources(self)
  const opponentResourceScore = scoreResources(opponent)
  const selfKoPressure = scoreKoPressure(self, opponent)
  const opponentKoPressure = scoreKoPressure(opponent, self)
  const selfSetupWindow = scoreSetupWindow(self)
  const opponentSetupWindow = scoreSetupWindow(opponent)
  const selfReserveValue = scoreReserveValue(self)
  const opponentReserveValue = scoreReserveValue(opponent)
  const selfTemporal = buildTemporalFeatures(self)
  const oppTemporal = buildTemporalFeatures(opponent)
  return {
    self_damage_capacity_now:
      selfResourceScore * 0.35 + selfBurstOnline * 2 + selfReactionReady,
    opp_damage_capacity_now:
      opponentResourceScore * 0.35 + opponentBurstOnline * 2 + opponentReactionReady,
    self_ko_pressure_now: selfKoPressure,
    opp_ko_pressure_now: opponentKoPressure,
    self_resource_score: selfResourceScore,
    opp_resource_score: opponentResourceScore,
    self_reaction_ready_score: selfReactionReady,
    opp_reaction_ready_score: opponentReactionReady,
    self_burst_online_count: selfBurstOnline,
    opp_burst_online_count: opponentBurstOnline,
    self_setup_window_score: selfSetupWindow,
    opp_setup_window_score: opponentSetupWindow,
    self_reserve_value_score: selfReserveValue,
    opp_reserve_value_score: opponentReserveValue,
    self_role_integrity_score: scoreRoleIntegrity(self),
    opp_role_integrity_score: scoreRoleIntegrity(opponent),
    self_window_score:
      selfResourceScore +
      selfKoPressure * 0.75 +
      selfReactionReady * 0.5 +
      selfSetupWindow * 0.25 +
      selfReserveValue * 0.15,
    opp_window_score:
      opponentResourceScore +
      opponentKoPressure * 0.75 +
      opponentReactionReady * 0.5 +
      opponentSetupWindow * 0.25 +
      opponentReserveValue * 0.15,
    // Game-level features default to -1 (no GamePlan bound);
    // overwritten by GamePlan integration when active.
    game_setup_completion: -1,
    game_phase_estimate: -1,
    game_primary_path_viable: -1,
    // P2: Threshold + functional tier features
    threshold: computeThresholdFeatures(self, opponent),
    // P2-1: Value Model extended features
    dice_efficiency: self.dice.total_count > 0
      ? self.dice.omni_count / self.dice.total_count
      : 0,
    summon_pressure: estimateSummonPressure(self),
    action_economy_ratio: estimateActionEconomyRatio(self, opponent),
    elemental_application_map: buildElementalApplicationMap(self, opponent),
    // P2-2: Temporal portfolio features
    self_temporal_setup_saturation: selfTemporal.temporal_setup_saturation,
    self_ready_to_cash_option_count: selfTemporal.ready_to_cash_option_count,
    self_blocked_synergy_option_count: selfTemporal.blocked_synergy_option_count,
    self_available_deferred_option_count: selfTemporal.available_deferred_option_count,
    opp_temporal_setup_saturation: oppTemporal.temporal_setup_saturation,
    opp_ready_to_cash_option_count: oppTemporal.ready_to_cash_option_count,
    opp_blocked_synergy_option_count: oppTemporal.blocked_synergy_option_count,
    opp_available_deferred_option_count: oppTemporal.available_deferred_option_count,
  }
}

function scoreResources(player: PlayerObservationV1): number {
  const totalEnergy = player.characters.reduce((sum, character) => sum + character.energy, 0)
  return (
    player.dice.total_count +
    player.hand.card_count * 0.75 +
    totalEnergy * 0.5 +
    player.supports.length * 0.25 +
    player.summons.length * 0.35
  )
}

function scoreSetupWindow(player: PlayerObservationV1): number {
  const setupDependency = safeMetaPriorSlot(player, "hand_setup_dependency_total")
  const supportCreate = safeEffectFamilyCount(player, "support_create")
  const summonCreate = safeEffectFamilyCount(player, "summon_create")
  const reactionEnable = safeEffectFamilyCount(player, "reaction_enable")
  return (
    player.supports.length * 0.5 +
    player.summons.length * 0.7 +
    setupDependency * 0.4 +
    supportCreate * 0.45 +
    summonCreate * 0.55 +
    reactionEnable * 0.2
  )
}

function scoreReserveValue(player: PlayerObservationV1): number {
  const handRetention = safeMetaPriorSlot(player, "hand_retention_total")
  const handFinisherAlignment = safeMetaPriorSlot(player, "hand_finisher_alignment_total")
  const totalEnergy = player.characters.reduce((sum, character) => sum + character.energy, 0)
  return (
    handRetention * 0.18 +
    handFinisherAlignment * 0.2 +
    player.dice.omni_count * 0.85 +
    player.hand.card_count * 0.08 +
    totalEnergy * 0.12
  )
}

function countBurstOnline(player: PlayerObservationV1): number {
  return player.characters.filter(
    (character) => character.alive && character.max_energy > 0 && character.energy >= character.max_energy,
  ).length
}

function safeMetaPriorSlot(player: PlayerObservationV1, key: string): number {
  const value = Number(player.meta_prior_slots?.[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function safeEffectFamilyCount(player: PlayerObservationV1, key: string): number {
  const value = Number(player.effect_family_counts?.[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function scoreReactionReadiness(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
): number {
  const exploitableAuras = opponent.characters.filter(
    (character) => character.alive && typeof character.aura === "number" && character.aura > 0,
  ).length
  const selfAuraCount = self.characters.filter(
    (character) => character.alive && typeof character.aura === "number" && character.aura > 0,
  ).length
  return exploitableAuras + selfAuraCount * 0.25
}

function scoreKoPressure(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
): number {
  const baseThreat = Math.max(1, countBurstOnline(self) * 2 + self.summons.length)
  return opponent.characters.reduce((sum, character) => {
    if (!character.alive) {
      return sum
    }
    if (character.health <= baseThreat) {
      return sum + 1
    }
    if (character.health <= baseThreat + 2) {
      return sum + 0.5
    }
    return sum
  }, 0)
}

function scoreRoleIntegrity(player: PlayerObservationV1): number {
  const aliveCharacters = player.characters.filter((character) => character.alive)
  const hpRatio =
    aliveCharacters.reduce(
      (sum, character) => sum + character.health / Math.max(character.max_health, 1),
      0,
    ) / Math.max(aliveCharacters.length, 1)
  return aliveCharacters.length * 1.25 + hpRatio + countBurstOnline(player) * 0.25
}

function clampCharacterSlot(index: number): 0 | 1 | 2 {
  if (index <= 0) return 0
  if (index === 1) return 1
  return 2
}

function flipSide(side: 0 | 1): 0 | 1 {
  return side === 0 ? 1 : 0
}

function estimateSummonPressure(player: PlayerObservationV1): number {
  return player.summons.reduce((sum, s) => {
    const usage = s.variable_value ?? 0
    return sum + Math.max(0, usage) * 1.5
  }, 0)
}

function estimateActionEconomyRatio(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
): number {
  const selfActions = self.combat_statuses.length + self.summons.length
  const oppActions = opponent.combat_statuses.length + opponent.summons.length
  return oppActions > 0 ? selfActions / oppActions : selfActions > 0 ? 2 : 1
}

function buildElementalApplicationMap(
  self: PlayerObservationV1,
  opponent: PlayerObservationV1,
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const ch of self.characters) {
    if (ch.alive && typeof ch.aura === "number" && ch.aura > 0) {
      result[`self_c${ch.slot_index}_aura`] = ch.aura
    }
  }
  for (const ch of opponent.characters) {
    if (ch.alive && typeof ch.aura === "number" && ch.aura > 0) {
      result[`opp_c${ch.slot_index}_aura`] = ch.aura
    }
  }
  return result
}
