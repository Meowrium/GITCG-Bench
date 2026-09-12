import { expect, test } from "vitest"
import { DiceType } from "@gi-tcg/typings"
import type { ObservationV1 } from "@gi-tcg/ml/contracts"
import { getStaticPriorForDefinitionId } from "../../learning/rl/static-priors.js"
import { GiMlPolicy } from "./gi-ml-policy.js"

const ZERO_ARTIFACT = {
  artifact_type: "slot_linear_ranker.v1" as const,
  artifact_version: "test",
  created_at: "2026-04-03T00:00:00.000Z",
  config: {},
}

test("GiMlPolicy guards against opening elemental tuning collapse when other lines exist", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
  })

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 5,
      dice_count: 8,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: [
      {
        candidate_id: "tune",
        action_case: "elementalTuning",
        tags: ["fast", "tune_sacrifice"],
        meta_effect_slots: {
          retention_value_proxy: 2.5,
          reaction_window_loss: 1.5,
          finisher_alignment_loss: 0.5,
          setup_dependency_loss: 1,
        },
        synergy_slots: {
          sacrifice_is_high_value: 1,
          sacrifice_is_reaction_piece: 1,
        },
      },
      {
        candidate_id: "skill",
        action_case: "useSkill",
        tags: ["use_skill"],
      },
    ],
  })

  expect(decision.selectedCandidateId).toBe("skill")
  const rankedTune = decision.ranked.find((item) => item.candidateId === "tune")
  expect(rankedTune?.reasons.some((reason) => reason.startsWith("guardrail="))).toBe(true)
  expect(rankedTune?.finalScore).toBeLessThan(0)
})

test("GiMlPolicy does not block elemental tuning when it is the only line", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
  })

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 2,
      dice_count: 2,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: [
      {
        candidate_id: "tune_only",
        action_case: "elementalTuning",
        tags: ["fast", "tune_sacrifice"],
      },
    ],
  })

  expect(decision.selectedCandidateId).toBe("tune_only")
})

test("GiMlPolicy uses value artifact deltas during online ranking", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    valueArtifact: {
      artifact_type: "linear_value_baseline.v1",
      artifact_version: "value_test",
      created_at: "2026-04-03T00:00:00.000Z",
      bias: 0.1,
      feature_weights: {
        "self.support_count": 0.2,
      },
      metadata: {
        dataset_id: "value_test",
        sample_count: 2,
      },
    },
  })

  const observation: ObservationV1 = {
    schema_version: "obs.v1",
    source: {
      game_version: "v6.3.0",
      card_pool_version: "v6.3.0",
      ruleset_version: "default",
      contract_version: "obs.v1",
      view_kind: "policy_public",
    },
    point: {
      game_id: "g1",
      episode_id: "e1",
      decision_point_id: "dp1",
      round_number: 1,
      phase: "action",
      pending_method: "action",
      actor_who: 0,
      current_turn: 0,
      action_count_in_round: 0,
    },
    self: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 1, definition_id: 1205, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 5 },
      pile_count: 25,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
    },
    opponent: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 2, definition_id: 1101, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 5 },
      pile_count: 25,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
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
      self_reaction_ready_score: 0,
      opp_reaction_ready_score: 0,
      self_burst_online_count: 0,
      opp_burst_online_count: 0,
      self_setup_window_score: 0,
      opp_setup_window_score: 0,
      self_reserve_value_score: 0,
      opp_reserve_value_score: 0,
      self_role_integrity_score: 1,
      opp_role_integrity_score: 1,
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

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, definition_id: 1205, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, definition_id: 1101, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 5,
      dice_count: 8,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
      dice_values: [DiceType.Hydro, DiceType.Hydro, DiceType.Void],
    },
    candidate_actions: [
      {
        candidate_id: "support",
        action_case: "playCard",
        create_support_value: 1,
      },
      {
        candidate_id: "end",
        action_case: "declareEnd",
      },
    ],
  }, { observation })

  expect(decision.selectedCandidateId).toBe("support")
  const rankedSupport = decision.ranked.find((item) => item.candidateId === "support")
  expect(rankedSupport?.reasons.some((reason) => reason.startsWith("value="))).toBe(true)
  expect((rankedSupport?.finalScore ?? 0)).toBeGreaterThan(0)
})

test("GiMlPolicy rewards elemental tuning that unlocks a strong follow-up action", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    tuneFollowupWeight: 1,
  })

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, definition_id: 1205, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, definition_id: 1101, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 5,
      dice_count: 3,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
      dice_values: [DiceType.Cryo, DiceType.Void, DiceType.Void],
    },
    candidate_actions: [
      {
        candidate_id: "tune",
        action_case: "elementalTuning",
        is_valid: true,
      },
      {
        candidate_id: "followup_support",
        action_case: "playCard",
        is_valid: false,
        create_support_value: 3,
        required_cost: [{ type: DiceType.Hydro, count: 1 }],
      },
      {
        candidate_id: "end",
        action_case: "declareEnd",
        is_valid: true,
      },
    ],
  })

  expect(decision.selectedCandidateId).toBe("tune")
  const rankedTune = decision.ranked.find((item) => item.candidateId === "tune")
  expect(rankedTune?.reasons.some((reason) => reason.startsWith("tune_followup="))).toBe(true)
  expect((rankedTune?.finalScore ?? 0)).toBeGreaterThan(0)
})

test("GiMlPolicy elevates stabilization lines when the active character is under pressure", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    macroPlanWeight: 1,
    strategicValueWeight: 1,
  })

  const decision = policy.choose({
    round: 3,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, definition_id: 1205, hp: 2, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, definition_id: 1101, hp: 7, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 3,
      dice_count: 5,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: [
      {
        candidate_id: "damage",
        action_case: "useSkill",
        damage_estimate: 1,
      },
      {
        candidate_id: "heal",
        action_case: "playCard",
        healing_estimate: 2,
        self_heal_value: 2,
        tags: ["healing"],
      },
    ],
  }, {
    observation: {
      schema_version: "obs.v1",
      source: {
        game_version: "v6.3.0",
        card_pool_version: "v6.3.0",
        ruleset_version: "default",
        contract_version: "obs.v1",
        view_kind: "policy_public",
      },
      point: {
        game_id: "g1",
        episode_id: "e1",
        decision_point_id: "dp2",
        round_number: 3,
        phase: "action",
        pending_method: "action",
        actor_who: 0,
        current_turn: 0,
        action_count_in_round: 0,
      },
      self: {
        active_character_index: 0,
        characters: [{ slot_index: 0, id: 1, definition_id: 1205, alive: true, is_active: true, health: 2, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
        summons: [],
        supports: [],
        combat_statuses: [],
        dice: { counts_by_type: {}, total_count: 5, omni_count: 0, unspecified_count: 0 },
        hand: { visible_cards: [], card_count: 3 },
        pile_count: 25,
        discard_count: null,
        declared_end: false,
        can_charged: null,
        can_plunging: null,
        has_defeated: null,
        legend_used: false,
      },
      opponent: {
        active_character_index: 0,
        characters: [{ slot_index: 0, id: 2, definition_id: 1101, alive: true, is_active: true, health: 7, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
        summons: [],
        supports: [],
        combat_statuses: [],
        dice: { counts_by_type: {}, total_count: 4, omni_count: 0, unspecified_count: 0 },
        hand: { visible_cards: [], card_count: 3 },
        pile_count: 25,
        discard_count: null,
        declared_end: false,
        can_charged: null,
        can_plunging: null,
        has_defeated: null,
        legend_used: false,
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
        self_reaction_ready_score: 0,
        opp_reaction_ready_score: 0,
        self_burst_online_count: 0,
        opp_burst_online_count: 0,
        self_setup_window_score: 0,
        opp_setup_window_score: 0,
        self_reserve_value_score: 0.5,
        opp_reserve_value_score: 0.5,
        self_role_integrity_score: 0.2,
        opp_role_integrity_score: 1,
        self_window_score: 0.2,
        opp_window_score: 1.2,
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
    },
  })

  expect(decision.selectedCandidateId).toBe("heal")
  const rankedHeal = decision.ranked.find((item) => item.candidateId === "heal")
  expect(rankedHeal?.reasons.some((reason) => reason.startsWith("macro_plan="))).toBe(true)
})

test("GiMlPolicy uses combat-window retrieval guidance to prefer the planned opening line", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    macroPlanWeight: 1,
    planSearchWeight: 1,
    strategicValueWeight: 0,
    combatWindowLibrary: {
      generated_at: "2026-04-04T00:00:00.000Z",
      entry_count: 1,
      grouped_count: 1,
      entries: [{
        canonical_key: "k1",
        tree_id: "tree-1",
        status: "promoted",
        matchup_id: null,
        deck_fingerprint_self: null,
        deck_fingerprint_opp: null,
        fingerprint: {
          canonical_key: "k1",
          matchup_id: null,
          deck_fingerprint_self: null,
          deck_fingerprint_opp: null,
          pending_method: "action",
          round_bucket: "r1",
          turn_player: 0,
          self_active_character_definition_id: null,
          opp_active_character_definition_id: null,
          self_active_hp_bucket: "8+",
          opp_active_hp_bucket: "8+",
          self_active_energy_bucket: "0",
          opp_active_energy_bucket: "0",
          dice_bucket: "6+",
          omni_bucket: "0",
          support_bucket: "0",
          summon_bucket: "0",
          cards_in_hand_bucket: "4+",
          action_count_bucket: null,
          first_action_case: "playCard",
          first_action_definition_id: null,
          first_action_tags: ["support_create"],
        },
        combat_window_plan: {
          window_id: "w1",
          plan_horizon: { min_actions: 2, max_actions: 3 },
          entry_conditions: [],
          interrupt_conditions: [],
          success_conditions: [],
          fail_conditions: [],
          entry_node_id: "n1",
          nodes: [
            {
              id: "n1",
              kind: "setup",
              intent: "build_support_line",
              expected_action_case: ["playCard"],
              when: [],
              must_do: [],
              avoid: [],
              prefer_tags: ["support_create"],
              resource_policy: "balanced",
              fallback_rule: "pick_highest_valid_candidate",
              next: [{ condition: "always", to: "n2", priority: 1 }],
            },
            {
              id: "n2",
              kind: "convert",
              intent: "cash_in_damage",
              expected_action_case: ["useSkill"],
              when: [],
              must_do: [],
              avoid: [],
              prefer_tags: ["direct_damage"],
              resource_policy: "aggressive",
              fallback_rule: "pick_highest_valid_candidate",
              next: [],
            },
          ],
        },
        source_window_id: "source-1",
        llm_confidence: 0.9,
        generalization_confidence: 0.8,
        promote_signal: "promote",
      }],
    } as any,
  })

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, definition_id: 1205, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, definition_id: 1101, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 4,
      dice_count: 8,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: [
      {
        candidate_id: "a_damage",
        action_case: "useSkill",
      },
      {
        candidate_id: "z_setup",
        action_case: "playCard",
        tags: ["support_create"],
        create_support_value: 1,
      },
    ],
  })

  expect(decision.selectedCandidateId).toBe("z_setup")
  expect(decision.guidanceNotes?.some((note) => note.startsWith("combat_window="))).toBe(true)
})

test("GiMlPolicy uses temporal opportunity to prefer Liben over unsupported Chef Mao", () => {
  const policy = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    macroPlanWeight: 0,
    strategicValueWeight: 0,
    planSearchWeight: 0,
    reactionChainWeight: 0,
    tempoValueWeight: 0,
    temporalOpportunityWeight: 1,
  })

  const decision = policy.choose({
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1,
      characters: [{ id: 1, definition_id: 1205, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
      hand_cards: [{}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2,
      characters: [{ id: 2, definition_id: 1101, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 4,
      dice_count: 8,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: [
      playSupportCandidate("chef", 322005),
      playSupportCandidate("liben", 322008),
    ],
  }, {
    observation: temporalObservation(),
  })

  expect(decision.selectedCandidateId).toBe("liben")
  const chef = decision.ranked.find((item) => item.candidateId === "chef")
  const liben = decision.ranked.find((item) => item.candidateId === "liben")
  expect(chef?.reasons.some((r: string) =>
    r.startsWith("portfolio_synergy_blocked:ChefMao")
  )).toBe(true)
  expect(liben?.reasons.some((reason) => reason.startsWith("temporal_liben_bank="))).toBe(true)
})

function playSupportCandidate(candidateId: string, definitionId: number) {
  const prior = getStaticPriorForDefinitionId(definitionId)
  return {
    candidate_id: candidateId,
    action_case: "playCard",
    card_definition_id: definitionId,
    create_support_value: 1,
    tags: prior.static_effect_tags,
    static_effect_tags: prior.static_effect_tags,
    meta_effect_slots: prior.meta_effect_slots,
  }
}

function temporalObservation(): ObservationV1 {
  return {
    schema_version: "obs.v1",
    source: {
      game_version: "v6.3.0",
      card_pool_version: "v6.3.0",
      ruleset_version: "default",
      contract_version: "obs.v1",
      view_kind: "policy_public",
    },
    point: {
      game_id: "g1",
      episode_id: "e1",
      decision_point_id: "dp-temporal",
      round_number: 1,
      phase: "action",
      pending_method: "action",
      actor_who: 0,
      current_turn: 0,
      action_count_in_round: 0,
    },
    self: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 1, definition_id: 1205, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 4 },
      pile_count: 25,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
    },
    opponent: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 2, definition_id: 1101, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 0 },
      pile_count: 25,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
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
      self_reaction_ready_score: 0,
      opp_reaction_ready_score: 0,
      self_burst_online_count: 0,
      opp_burst_online_count: 0,
      self_setup_window_score: 0,
      opp_setup_window_score: 0,
      self_reserve_value_score: 0,
      opp_reserve_value_score: 0,
      self_role_integrity_score: 1,
      opp_role_integrity_score: 1,
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
