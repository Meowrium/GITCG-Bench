// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import {
  ActionValidity,
  PbDiceRequirementType,
  PbDiceType,
  PbEntityType,
  PbEquipmentType,
  createRpcRequest,
  type Notification,
  type RpcRequest,
} from "@gi-tcg/typings"
import type { DecisionPointV1, ObservationV1 } from "@gi-tcg/ml/contracts"

export function createVisibleStateFixture(): NonNullable<Notification["state"]> {
  return {
    phase: 3,
    roundNumber: 2,
    currentTurn: 0,
    winner: undefined,
    player: [
      {
        activeCharacterId: 1001,
        character: [
          {
            id: 1001,
            definitionId: 1101,
            defeated: false,
            entity: [],
            health: 8,
            energy: 1,
            maxHealth: 10,
            maxEnergy: 2,
            aura: 1,
            tags: 0,
            specialEnergyName: undefined,
          },
        ],
        combatStatus: [],
        summon: [],
        support: [],
        dice: [PbDiceType.OMNI, PbDiceType.CRYO, PbDiceType.CRYO],
        pileCard: [
          {
            id: 9001,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333999,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [],
            tags: 0,
            attachment: [],
          },
        ],
        handCard: [
          {
            id: 2001,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333015,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [{ type: PbDiceRequirementType.CRYO, count: 2 }],
            tags: 0,
            attachment: [],
          },
        ],
        status: 4,
        declaredEnd: false,
        legendUsed: false,
        initiativeSkill: [],
      },
      {
        activeCharacterId: 3001,
        character: [
          {
            id: 3001,
            definitionId: 1201,
            defeated: false,
            entity: [],
            health: 6,
            energy: 0,
            maxHealth: 10,
            maxEnergy: 2,
            aura: 2,
            tags: 0,
            specialEnergyName: undefined,
          },
        ],
        combatStatus: [],
        summon: [],
        support: [],
        dice: [PbDiceType.HYDRO],
        pileCard: [
          {
            id: 9002,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333101,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [],
            tags: 0,
            attachment: [],
          },
        ],
        handCard: [
          {
            id: 4001,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333021,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [],
            tags: 0,
            attachment: [],
          },
          {
            id: 4002,
            type: PbEntityType.EVENT_CARD,
            definitionId: 333022,
            variableValue: undefined,
            variableName: undefined,
            hasUsagePerRound: false,
            hintIcon: undefined,
            hintText: undefined,
            equipment: PbEquipmentType.OTHER,
            descriptionDictionary: {},
            definitionCost: [],
            tags: 0,
            attachment: [],
          },
        ],
        status: 4,
        declaredEnd: false,
        legendUsed: false,
        initiativeSkill: [],
      },
    ],
  }
}

export function createActionRequestFixture(): RpcRequest {
  return createRpcRequest("action", {
    action: [
      {
        action: {
          $case: "playCard",
          value: {
            cardId: 2001,
            cardDefinitionId: 333015,
            targetIds: [3001],
            willBeEffectless: false,
          },
        },
        requiredCost: [{ type: PbDiceRequirementType.CRYO, count: 2 }],
        autoSelectedDice: [PbDiceType.CRYO, PbDiceType.OMNI],
        validity: ActionValidity.VALID,
        preview: [],
        isFast: true,
      },
      {
        action: {
          $case: "declareEnd",
          value: {},
        },
        requiredCost: [],
        autoSelectedDice: [],
        validity: ActionValidity.VALID,
        preview: [],
        isFast: false,
      },
    ],
  })
}

export function createRerollRequestFixture(): RpcRequest {
  return createRpcRequest("rerollDice", {})
}

export function createDecisionPointFixture(): DecisionPointV1 {
  return {
    schema_version: "action.v1",
    game_id: "game-1",
    episode_id: "episode-1",
    decision_point_id: "dp-1",
    pending_method: "action",
    actor_who: 0,
    observation_ref: "obs://game-1/dp-1",
    candidate_count: 2,
    candidates: [
      {
        candidate_id: "dp-1:action:0",
        candidate_index: 0,
        engine_index: 2,
        pending_method: "action",
        family: "action",
        action_case: "declareEnd",
        source_ref: null,
        target_ref: null,
        target_refs: [],
        required_cost: [],
        auto_selected_dice: [],
        selectable_dice_types: [],
        is_fast_action: false,
        is_valid: true,
        validity_code: ActionValidity.VALID,
        is_model_selectable: true,
        is_fallback_only: false,
        rule_tags: ["end_round"],
        static_effect_tags: [],
        meta_effect_slots: {},
        synergy_slots: {},
        routing: {
          route: "main_head",
          reason: "high_freq_family",
        },
        temporal_option_kind: null,
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "unknown",
      },
      {
        candidate_id: "dp-1:action:1",
        candidate_index: 1,
        engine_index: 1,
        pending_method: "action",
        family: "reroll_dice",
        action_case: "rerollDice",
        source_ref: null,
        target_ref: null,
        target_refs: [],
        required_cost: [],
        auto_selected_dice: [],
        selectable_dice_types: [],
        is_fast_action: false,
        is_valid: true,
        validity_code: ActionValidity.VALID,
        is_model_selectable: false,
        is_fallback_only: true,
        rule_tags: ["fallback_only"],
        static_effect_tags: [],
        meta_effect_slots: {},
        synergy_slots: {},
        routing: {
          route: "fallback_head",
          reason: "disabled_in_v1",
        },
        temporal_option_kind: null,
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "unknown",
      },
    ],
  }
}

export function createObservationFixture(args: {
  selfHealths?: number[]
  opponentHealths?: number[]
  selfAlive?: boolean[]
  opponentAlive?: boolean[]
  selfEnergies?: number[]
  opponentEnergies?: number[]
  selfHandCount?: number
  opponentHandCount?: number
  selfReactionReadyScore?: number
  opponentReactionReadyScore?: number
  selfBurstOnlineCount?: number
  opponentBurstOnlineCount?: number
  selfSetupWindowScore?: number
  opponentSetupWindowScore?: number
  selfReserveValueScore?: number
  opponentReserveValueScore?: number
} = {}): ObservationV1 {
  const selfHealths = args.selfHealths ?? [10]
  const opponentHealths = args.opponentHealths ?? [10]
  const selfAlive = args.selfAlive ?? selfHealths.map((health) => health > 0)
  const opponentAlive = args.opponentAlive ?? opponentHealths.map((health) => health > 0)
  const selfEnergies = args.selfEnergies ?? selfHealths.map(() => 0)
  const opponentEnergies = args.opponentEnergies ?? opponentHealths.map(() => 0)

  return {
    schema_version: "obs.v1",
    source: {
      game_version: "test",
      card_pool_version: "test",
      ruleset_version: "test",
      contract_version: "obs.v1",
      view_kind: "policy_public",
    },
    point: {
      game_id: "game-1",
      episode_id: "episode-1",
      decision_point_id: "dp-1",
      round_number: 1,
      phase: "action",
      pending_method: "action",
      actor_who: 0,
      current_turn: 0,
      action_count_in_round: 0,
    },
    self: {
      active_character_index: 0,
      characters: selfHealths.map((health, index) => ({
        slot_index: clampCharacterSlot(index),
        id: 1000 + index,
        definition_id: 1100 + index,
        alive: selfAlive[index] ?? true,
        is_active: index === 0,
        health,
        max_health: 10,
        energy: selfEnergies[index] ?? 0,
        max_energy: 2,
        aura: null,
        tags: 0,
        equipment_ids: [],
        status_ids: [],
        usage_counters: {},
        entities: [],
      })),
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: {
        counts_by_type: {},
        total_count: 0,
        omni_count: 0,
        unspecified_count: 0,
      },
      hand: {
        visible_cards: [],
        card_count: args.selfHandCount ?? 0,
      },
      pile_count: 0,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
      effect_family_counts: {},
      meta_prior_slots: {},
    },
    opponent: {
      active_character_index: 0,
      characters: opponentHealths.map((health, index) => ({
        slot_index: clampCharacterSlot(index),
        id: 3000 + index,
        definition_id: 3100 + index,
        alive: opponentAlive[index] ?? true,
        is_active: index === 0,
        health,
        max_health: 10,
        energy: opponentEnergies[index] ?? 0,
        max_energy: 2,
        aura: null,
        tags: 0,
        equipment_ids: [],
        status_ids: [],
        usage_counters: {},
        entities: [],
      })),
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: {
        counts_by_type: {},
        total_count: 0,
        omni_count: 0,
        unspecified_count: 0,
      },
      hand: {
        visible_cards: [],
        card_count: args.opponentHandCount ?? 0,
      },
      pile_count: 0,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
      effect_family_counts: {},
      meta_prior_slots: {},
    },
    public_state: {
      winner: null,
      self_declared_end: false,
      opponent_declared_end: false,
      self_support_count: 0,
      opponent_support_count: 0,
      self_summon_count: 0,
      opponent_summon_count: 0,
    },
    hidden_estimate: null,
    derived: {
      self_damage_capacity_now: 0,
      opp_damage_capacity_now: 0,
      self_ko_pressure_now: 0,
      opp_ko_pressure_now: 0,
      self_resource_score: 0,
      opp_resource_score: 0,
      self_reaction_ready_score: args.selfReactionReadyScore ?? 0,
      opp_reaction_ready_score: args.opponentReactionReadyScore ?? 0,
      self_burst_online_count: args.selfBurstOnlineCount ?? 0,
      opp_burst_online_count: args.opponentBurstOnlineCount ?? 0,
      self_setup_window_score: args.selfSetupWindowScore ?? 0,
      opp_setup_window_score: args.opponentSetupWindowScore ?? 0,
      self_reserve_value_score: args.selfReserveValueScore ?? 0,
      opp_reserve_value_score: args.opponentReserveValueScore ?? 0,
      self_role_integrity_score: 0,
      opp_role_integrity_score: 0,
      self_window_score: 0,
      opp_window_score: 0,
      game_setup_completion: -1,
      game_phase_estimate: -1,
      game_primary_path_viable: -1,
      dice_efficiency: 0,
      summon_pressure: 0,
      action_economy_ratio: 1,
      elemental_application_map: {},
      self_temporal_setup_saturation: 0,
      self_ready_to_cash_option_count: 0,
      self_blocked_synergy_option_count: 0,
      self_available_deferred_option_count: 0,
      opp_temporal_setup_saturation: 0,
      opp_ready_to_cash_option_count: 0,
      opp_blocked_synergy_option_count: 0,
      opp_available_deferred_option_count: 0,
    },
  }
}

function clampCharacterSlot(index: number): 0 | 1 | 2 {
  if (index <= 0) return 0
  if (index === 1) return 1
  return 2
}
