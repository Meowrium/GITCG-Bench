// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Types shared between gi-agent and gi-ml.
// gi-agent imports from @gi-tcg/ml/contracts rather than duplicating.

// ── Shared types not tied to any one package ──

/**
 * Threshold feature flags (0/1 binary features + small integer counts).
 *
 * Concrete schema mirroring §18.3 P2 thresholds. gi-agent's
 * `learning/rl/threshold-features.ts` is the canonical producer; gi-ml
 * value/ranker artifacts consume these features as fixed slots.
 */
export interface ThresholdFeaturesV1 {
  // --- Energy thresholds ---
  /** Any character within 1 of full energy (burst-unlock proximity). */
  self_any_energy_near_full: number  // 0 or 1
  opp_any_energy_near_full: number
  /** Any character with energy >= 2 (Shimenawa damage threshold). */
  self_any_energy_ge_2: number       // 0 or 1
  opp_any_energy_ge_2: number

  // --- HP thresholds ---
  /** Opponent active character HP <= 6 (Wolf's Gravestone +2 dmg threshold). */
  opp_active_hp_le_6: number         // 0 or 1
  /** Self active character HP <= 6. */
  self_active_hp_le_6: number
  /** Opponent any character within estimated kill range. */
  opp_any_in_kill_range: number      // 0 or 1
  /** Self any character within estimated kill range. */
  self_any_in_kill_range: number

  // --- Equipment / status thresholds ---
  /** Self has Wolf's Gravestone equipped. */
  self_has_wolfs_gravestone: number   // 0 or 1
  /** Self has Shimenawa's Reminiscence equipped. */
  self_has_shimenawas: number         // 0 or 1
  /** Self has Shimenawa's + energy >= 2 (damage bonus active). */
  self_shimenawas_active: number      // 0 or 1
  /** Self has Wolf's Gravestone + opp HP <= 6 (extra damage active). */
  self_wolfs_gravestone_active: number // 0 or 1

  // --- Summon thresholds ---
  /** Self summon total usage count (>3 enables Yae Miko extra trigger). */
  self_summon_total_usages: number
  opp_summon_total_usages: number
  /** Self has Yae Miko character. */
  self_has_yae_miko: number           // 0 or 1
  /** Yae Miko extra trigger condition met (summon usages > 3). */
  self_yae_miko_extra_trigger: number // 0 or 1

  // --- Functional tier (§14.3) ---
  /** Self core character alive count (0-3). */
  self_core_alive_count: number
  /** Self tactical character alive count (0-3). */
  self_tactical_alive_count: number
  /** Self residual character alive count (0-3). */
  self_residual_alive_count: number
  /** Opponent core character alive count. */
  opp_core_alive_count: number
  opp_tactical_alive_count: number
  opp_residual_alive_count: number

  // --- Dice quality ---
  /** Self dice alignment ratio with active character element (0~1). */
  self_dice_alignment: number
  opp_dice_alignment: number
}

export type ObservationViewKindV1 = "debug_full" | "policy_public"

export type PendingMethodV1 =
  | "action"
  | "chooseActive"
  | "rerollDice"
  | "switchHands"
  | "selectCard"
  | null

export type ActionCandidateFamilyV1 =
  | "action"
  | "choose_active"
  | "reroll_dice"
  | "switch_hands"
  | "select_card"

export type ActionRouteV1 = "main_head" | "fallback_head" | "rule_policy"

export interface EntityRefV1 {
  side: 0 | 1 | null
  area:
    | "character"
    | "hand"
    | "pile"
    | "support"
    | "summon"
    | "combat_status"
    | "status"
    | "unknown"
  entity_id: number | null
  definition_id: number | null
  slot_index?: number | null
}

export interface CostEntryV1 {
  type: number
  count: number
}

export interface EntityObservationV1 {
  id: number
  definition_id: number
  variable_name?: string | null
  variable_value?: number | null
  description_dictionary?: Record<string, string>
}

export interface CharacterObservationV1 {
  slot_index: 0 | 1 | 2
  id: number
  definition_id: number
  alive: boolean
  is_active: boolean
  health: number
  max_health: number
  energy: number
  max_energy: number
  aura: number | null
  tags?: number | null
  equipment_ids: number[]
  status_ids: number[]
  usage_counters: Record<string, number>
  entities: EntityObservationV1[]
}

export interface DicePoolObservationV1 {
  counts_by_type: Record<string, number>
  total_count: number
  omni_count: number
  unspecified_count: number
}

export interface HandCardObservationV1 {
  entity_id: number
  definition_id: number | null
  tags: string[]
  cost_summary: CostEntryV1[]
  static_effect_tags?: string[]
  meta_effect_slots?: Record<string, number>
}

export interface HandObservationV1 {
  visible_cards: HandCardObservationV1[]
  card_count: number
}

export interface PlayerObservationV1 {
  active_character_index: 0 | 1 | 2 | null
  characters: CharacterObservationV1[]
  summons: EntityObservationV1[]
  supports: EntityObservationV1[]
  combat_statuses: EntityObservationV1[]
  dice: DicePoolObservationV1
  hand: HandObservationV1
  pile_count: number
  discard_count: number | null
  declared_end: boolean
  can_charged: boolean | null
  can_plunging: boolean | null
  has_defeated: boolean | null
  legend_used: boolean
  effect_family_counts?: Record<string, number>
  meta_prior_slots?: Record<string, number>
}

export interface OpponentHiddenEstimateV1 {
  hidden_hand_count: number
  remaining_deck_count: number
  known_revealed_definition_ids: number[]
  expected_type_counts: {
    event: number
    equipment: number
    support: number
    food: number
    resonance: number
  }
  expected_response_buckets: {
    heal_like: number
    dice_fix_like: number
    swap_like: number
    burst_enable_like: number
  }
}

export interface DerivedObservationFeaturesV1 {
  self_damage_capacity_now: number
  opp_damage_capacity_now: number
  self_ko_pressure_now: number
  opp_ko_pressure_now: number
  self_resource_score: number
  opp_resource_score: number
  self_reaction_ready_score: number
  opp_reaction_ready_score: number
  self_burst_online_count: number
  opp_burst_online_count: number
  self_setup_window_score: number
  opp_setup_window_score: number
  self_reserve_value_score: number
  opp_reserve_value_score: number
  self_role_integrity_score: number
  opp_role_integrity_score: number
  self_window_score: number
  opp_window_score: number
  /**
   * V31 F1: engine-aligned ADDITIVE reaction-damage bonus the opponent can gain
   * against our active character's current aura (flat +2/+1/0). Replaces the
   * legacy multiplicative amplifier. Optional for backward compatibility with
   * older captures; absent → treat as 0.
   */
  opp_reaction_bonus_now?: number
  // Game-level features (P0: §18.3)
  /** 展开完成度：关键组件就位百分比 (0~1)，无 GamePlan 时为 -1 */
  game_setup_completion: number
  /**
   * @deprecated-P5 (V31 F2) 离散阶段标签是过早分类，违反 P5。改用下方三个连续进度量
   * (`execution_readiness` / `closing_pressure` + `game_setup_completion`)。
   * 字段保留仅为兼容旧 capture，新代码不应消费。无 GamePlan 时为 -1。
   */
  game_phase_estimate: number
  /**
   * V31 F2: 执行就位度 ∈[0,1]。关键技能可用 + 能量比 + 组件就位的连续度量。
   * 取代 game_phase_estimate 的 "execution" 离散判定。缺省 -1。
   */
  execution_readiness?: number
  /**
   * V31 F2: 收尾压力 ∈[0,1]。max(对方最低血占斩杀线比, round/maxRound) 的连续度量。
   * 取代 game_phase_estimate 的 "closing" 离散判定。缺省 -1。
   */
  closing_pressure?: number
  /** 胜利路径活跃度：当前主路径是否仍可行 (0 or 1)，无 GamePlan 时为 -1 */
  game_primary_path_viable: number
  // P2: Threshold + functional tier features
  /** 阈值特征集合，null 表示未计算 */
  threshold?: ThresholdFeaturesV1 | null
  // P2-1: Value Model extended features
  /** 骰子效率：omni_count / total_dice */
  dice_efficiency: number
  /** 即将触发的召唤物伤害总量 */
  summon_pressure: number
  /** 行动经济比：己方已执行动作数 / 对手已执行动作数 */
  action_economy_ratio: number
  /** 元素附着映射：各角色身上的元素附着状态 */
  elemental_application_map: Record<string, number>
  // P2-2: Temporal portfolio features
  /** 支援格饱和度 (0=empty, 1=full) */
  self_temporal_setup_saturation: number
  /** 已就绪可兑现的延迟选项数量 */
  self_ready_to_cash_option_count: number
  /** 被阻止的协同选项数量（缺前置标签） */
  self_blocked_synergy_option_count: number
  /** 手牌中可用延迟选项总数 */
  self_available_deferred_option_count: number
  /** 对方支援格饱和度 */
  opp_temporal_setup_saturation: number
  /** 对方已就绪可兑现选项 */
  opp_ready_to_cash_option_count: number
  /** 对方被阻止选项 */
  opp_blocked_synergy_option_count: number
  /** 对方可用延迟选项数 */
  opp_available_deferred_option_count: number
}

export interface PublicBoardObservationV1 {
  winner: 0 | 1 | null
  self_declared_end: boolean
  opponent_declared_end: boolean
  self_support_count: number
  opponent_support_count: number
  self_summon_count: number
  opponent_summon_count: number
}

export interface ObservationV1 {
  schema_version: "obs.v1"
  source: {
    game_version: string
    card_pool_version: string
    ruleset_version: string
    contract_version: string
    view_kind: ObservationViewKindV1
  }
  point: {
    game_id: string
    episode_id: string
    decision_point_id: string
    round_number: number
    phase: string
    pending_method: PendingMethodV1
    actor_who: 0 | 1
    current_turn: 0 | 1
    action_count_in_round: number
  }
  self: PlayerObservationV1
  opponent: PlayerObservationV1
  public_state: PublicBoardObservationV1
  hidden_estimate: OpponentHiddenEstimateV1 | null
  derived: DerivedObservationFeaturesV1
}

export interface CandidateRoutingV1 {
  route: ActionRouteV1
  reason:
    | "high_freq_family"
    | "rare_pending_method"
    | "low_confidence"
    | "disabled_in_v1"
}

export interface ActionCandidateV1 {
  candidate_id: string
  candidate_index: number
  engine_index: number | null
  pending_method: Exclude<PendingMethodV1, null>
  family: ActionCandidateFamilyV1
  action_case: string
  source_ref: EntityRefV1 | null
  target_ref: EntityRefV1 | null
  target_refs: EntityRefV1[]
  required_cost: CostEntryV1[]
  auto_selected_dice: number[]
  selectable_dice_types: number[]
  is_fast_action: boolean
  is_valid: boolean
  validity_code: number | null
  is_model_selectable: boolean
  is_fallback_only: boolean
  rule_tags: string[]
  static_effect_tags?: string[]
  meta_effect_slots?: Record<string, number>
  synergy_slots?: Record<string, number>
  routing: CandidateRoutingV1
  // P2-3: Candidate-level temporal semantics
  /** Strategic option kind from DSL profile */
  temporal_option_kind?: string | null
  /** Whether card prereqs (food/weapon/etc) are satisfied by hand+board */
  temporal_prereq_satisfied?: boolean | null
  /** Portfolio stage: setup / ready_to_cash / blocked / immediate / unknown */
  temporal_portfolio_stage?: string | null
  /** Total dice cost of this candidate (sum of required_cost entries) */
  temporal_dice_cost?: number | null
  /** Dice cost / available dice ratio (0-1); enables GBDT to learn budget-aware decisions */
  temporal_dice_budget_ratio?: number | null
}

export interface DecisionPointV1 {
  schema_version: "action.v1"
  game_id: string
  episode_id: string
  decision_point_id: string
  pending_method: Exclude<PendingMethodV1, null>
  actor_who: 0 | 1
  observation_ref: string
  candidate_count: number
  candidates: ActionCandidateV1[]
}

export interface RewardBreakdownV1 {
  reward_version: string
  terminal: number
  damage: number
  ko: number
  energy: number
  hand: number
  reaction_ready: number
  burst_online: number
  setup_window: number
  reserve_value: number
  setup_realization: number
  element_application?: number
  focus_damage?: number
  burst_waste?: number
  collapse?: number
  phase_alignment?: number
  dice_efficiency?: number
  key_char_protect?: number
  shaping_total: number
  clipped_shaping_total: number
  total: number
}

export interface RewardConfigV1 {
  reward_version: string
  terminal: {
    win: number
    loss: number
    draw: number
  }
  shaping: {
    damage_coef: number
    ko_bonus: number
    energy_coef: number
    hand_coef: number
    reaction_ready_bonus: number
    burst_online_bonus: number
    setup_window_bonus: number
    reserve_value_bonus: number
    setup_realization_bonus: number
    element_application_bonus?: number
    focus_damage_bonus?: number
    burst_waste_penalty_coef?: number
    collapse_penalty_coef?: number
    phase_alignment_bonus_coef?: number
    dice_efficiency_bonus_coef?: number
    key_char_protect_bonus_coef?: number
    step_clip: number
  }
  enabled_events: string[]
  disabled_events: string[]
}

export interface TrainingProtocolV1 {
  protocol_version: "training.v1"
  warm_start_sources: Array<"branch-eval" | "combat-window" | "replay">
  online_sources: Array<"self-play">
  sample_mix_ratio: {
    new_data: number
    old_data: number
  }
  invalidation_rules: {
    on_reward_version_change: "drop_or_rebuild"
    on_contract_version_change: "drop_or_rebuild"
    on_card_pool_change: "filter_by_affected_decks"
  }
  opponent_pool: {
    mirror: number
    checkpoint: number
    baseline: number
  }
  update_schedule: {
    games_per_update: number
    decision_points_per_update: number
  }
  promotion: {
    min_matchup_gain: number
    min_overall_win_rate: number
    max_baseline_drop: number
    max_regression_drop: number
  }
}

export interface TrainingUpdateProgressV1 {
  games_since_update: number
  decision_points_since_update: number
}

export interface TrainingUpdateDecisionV1 {
  should_update: boolean
  reasons: string[]
}

export interface DecisionPointLogV1 {
  game_id: string
  episode_id: string
  decision_point_id: string
  observation_ref: string
  candidate_ids: string[]
  candidate_scores: number[]
  selected_candidate_id: string | null
  selected_route: ActionRouteV1
  reward_breakdown: RewardBreakdownV1 | null
  value_prediction: number | null
  terminal_outcome: number | null
  model_version: string
  reward_version: string
  obs_version: string
  action_version: string
}

export interface SelfPlayRlSideCaptureV1 {
  side: 0 | 1
  observations: ObservationV1[]
  decision_points: DecisionPointV1[]
  transition_observations: ObservationV1[]
  decision_logs: DecisionPointLogV1[]
}

export interface SelfPlayRlGameCaptureV1 {
  schema_version: "self_play_rl.v1"
  game_id: string
  episode_id: string
  matchup_id: string
  winner: 0 | 1 | null
  sides: [SelfPlayRlSideCaptureV1, SelfPlayRlSideCaptureV1]
}

export interface RlDecisionPointSampleV1 {
  game_id: string
  episode_id: string
  matchup_id: string
  side: 0 | 1
  observation: ObservationV1
  decision_point: DecisionPointV1
  next_observation: ObservationV1 | null
  decision_log: DecisionPointLogV1
  chosen_candidate_id: string | null
  selected_route: ActionRouteV1
  reward_breakdown: RewardBreakdownV1 | null
  outcome_label: number | null
}

export interface RlDatasetV1 {
  schema_version: "rl_dataset.v1"
  reward_version?: string | null
  generated_at: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
  samples: RlDecisionPointSampleV1[]
}

export interface RlDatasetShardV1 {
  schema_version: "rl_dataset_shard.v1"
  generated_at: string
  shard_id: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
  samples: RlDecisionPointSampleV1[]
}

export interface RlDatasetManifestShardEntryV1 {
  shard_id: string
  relative_path: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
}

export interface RlDatasetManifestV1 {
  schema_version: "rl_dataset_manifest.v1"
  reward_version?: string | null
  generated_at: string
  source_capture_count: number
  sample_count: number
  by_matchup: Record<string, number>
  samples_schema_version: RlDatasetV1["schema_version"]
  shard_schema_version: RlDatasetShardV1["schema_version"]
  shard_count: number
  shards: RlDatasetManifestShardEntryV1[]
}

export interface ObservationExportOptionsV1 {
  gameId: string
  episodeId: string
  decisionPointId: string
  actorWho: 0 | 1
  pendingMethod?: PendingMethodV1
  actionCountInRound?: number
  gameVersion?: string
  cardPoolVersion?: string
  rulesetVersion?: string
  contractVersion?: string
  viewKind?: ObservationViewKindV1
  optionalFlags?: {
    selfDiscardCount?: number | null
    opponentDiscardCount?: number | null
    selfCanCharged?: boolean | null
    opponentCanCharged?: boolean | null
    selfCanPlunging?: boolean | null
    opponentCanPlunging?: boolean | null
    selfHasDefeated?: boolean | null
    opponentHasDefeated?: boolean | null
  }
  knownOpponentDeckDefinitionIds?: number[]
  knownOpponentRevealedDefinitionIds?: number[]
}

export interface DecisionPointExportOptionsV1 {
  gameId: string
  episodeId: string
  decisionPointId: string
  actorWho: 0 | 1
  observationRef: string
  mainSelectableFamilies?: ReadonlySet<ActionCandidateFamilyV1>
  fallbackFamilies?: ReadonlySet<ActionCandidateFamilyV1>
}

export interface RewardComputationOptionsV1 {
  config?: RewardConfigV1
  terminalOutcome?: "win" | "loss" | "draw" | null
}

export interface CheckpointPromotionInputV1 {
  matchup_gain: number
  overall_win_rate: number
  worst_baseline_delta: number
  worst_regression_delta: number
}

export interface CheckpointPromotionResultV1 {
  accepted: boolean
  reasons: string[]
}

export interface DecisionPointLogBuildInputV1 {
  decisionPoint: DecisionPointV1
  candidateScores?: readonly number[]
  selectedCandidateId?: string | null
  selectedRoute?: ActionRouteV1 | null
  rewardBreakdown?: RewardBreakdownV1 | null
  valuePrediction?: number | null
  terminalOutcome?: number | null
  modelVersion: string
  rewardVersion?: string
  obsVersion?: string
  actionVersion?: string
}
