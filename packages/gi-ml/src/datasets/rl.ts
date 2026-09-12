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

import type {
  MlCandidateAction,
  MlPairwisePreference,
  MlRankingDataset,
  MlRankingQueryGroup,
} from "../contracts/index.js"
import type {
  ActionCandidateV1,
  ObservationV1,
  RewardBreakdownV1,
  RlDatasetV1,
  RlDecisionPointSampleV1,
} from "../contracts/rl-types.js"
import { shouldIncludeDatasetKey, type DatasetHoldoutOptions } from "./holdout.js"

export interface RlRankingDatasetBuildOptions extends DatasetHoldoutOptions {
  datasetId?: string
  includeUnchosenQueries?: boolean
}

export function buildRankingDatasetFromRlDataset(
  dataset: RlDatasetV1,
  options: RlRankingDatasetBuildOptions = {},
): MlRankingDataset {
  const queryGroups = dataset.samples
    .filter((sample) =>
      shouldIncludeDatasetKey(sample.decision_point.decision_point_id, options))
    .map((sample) => buildQueryGroup(sample, options))
    .filter((group): group is MlRankingQueryGroup => group != null)

  return {
    dataset_id: options.datasetId ?? `rl_self_play__${dataset.sample_count}`,
    created_at: new Date().toISOString(),
    metadata: {
      source: "self_play",
      dataset_schema_version: dataset.schema_version,
      sample_count: dataset.sample_count,
      source_capture_count: dataset.source_capture_count,
      matchup_counts: dataset.by_matchup,
    },
    query_groups: queryGroups,
  }
}

function buildQueryGroup(
  sample: RlDecisionPointSampleV1,
  options: RlRankingDatasetBuildOptions,
): MlRankingQueryGroup | null {
  if (!sample.chosen_candidate_id && !options.includeUnchosenQueries) {
    return null
  }

  const candidates = sample.decision_point.candidates.map((candidate) =>
    buildCandidateAction(sample, candidate))
  const pairwisePreferences = buildPairwisePreferences(sample)

  if (pairwisePreferences.length === 0 && !options.includeUnchosenQueries) {
    return null
  }

  return {
    query_id: sample.decision_point.decision_point_id,
    source: "self_play",
    state_ref: sample.observation.point.decision_point_id,
    context_slots: buildContextSlots(sample),
    candidates,
    pairwise_preferences: pairwisePreferences,
  }
}

function buildCandidateAction(
  sample: RlDecisionPointSampleV1,
  candidate: ActionCandidateV1,
): MlCandidateAction {
  return {
    candidate_id: candidate.candidate_id,
    query_id: sample.decision_point.decision_point_id,
    action_case: candidate.action_case,
    action_definition_ref:
      candidate.source_ref?.definition_id != null
        ? String(candidate.source_ref.definition_id)
        : candidate.target_ref?.definition_id != null
          ? String(candidate.target_ref.definition_id)
          : null,
    raw_feature_ref: sample.observation.point.decision_point_id,
    tree_match_ref: null,
    branch_eval_ref: null,
    runtime_slots: {
      candidate_index: candidate.candidate_index,
      engine_index: candidate.engine_index,
      family: candidate.family,
      pending_method: candidate.pending_method,
      routing: candidate.routing.route,
      routing_reason: candidate.routing.reason,
      action_case: candidate.action_case,
      candidate_tags: buildCandidateTags(candidate),
      candidate_numeric_slots: buildCandidateNumericSlots(candidate, sample.observation),
    },
  }
}

function buildPairwisePreferences(sample: RlDecisionPointSampleV1): MlPairwisePreference[] {
  const chosenCandidateId = sample.chosen_candidate_id
  if (!chosenCandidateId) {
    return []
  }

  const confidence = computePreferenceConfidence(sample.reward_breakdown, sample.outcome_label)

  return sample.decision_point.candidates
    .filter((candidate) => candidate.candidate_id !== chosenCandidateId)
    .map((candidate) => ({
      query_id: sample.decision_point.decision_point_id,
      candidate_a_id: chosenCandidateId,
      candidate_b_id: candidate.candidate_id,
      preference_label: 1,
      confidence,
      evidence_ref: buildEvidenceRef(sample, candidate.candidate_id),
      preference_slots: {
        selected_route: sample.selected_route,
        reward_total: sample.reward_breakdown?.total ?? 0,
        shaping_total: sample.reward_breakdown?.clipped_shaping_total ?? 0,
        terminal: sample.reward_breakdown?.terminal ?? 0,
        outcome_label: sample.outcome_label,
      },
    }))
}

function buildContextSlots(sample: RlDecisionPointSampleV1) {
  const observation = sample.observation
  return {
    matchup_id: sample.matchup_id,
    side: sample.side,
    actor: observation.point.current_turn,
    legal_action_count: sample.decision_point.candidate_count,
    round: observation.point.round_number,
    phase: observation.point.phase,
    pending_method: observation.point.pending_method,
    current_turn: observation.point.current_turn,
    action_count_in_round: observation.point.action_count_in_round,
    self_hand_count: observation.self.hand.card_count,
    opp_hand_count: observation.opponent.hand.card_count,
    self_dice_count: observation.self.dice.total_count,
    opp_dice_count: observation.opponent.dice.total_count,
    self_active_definition_id:
      observation.self.active_character_index != null
        ? observation.self.characters[observation.self.active_character_index]?.definition_id ?? null
        : null,
    opp_active_definition_id:
      observation.opponent.active_character_index != null
        ? observation.opponent.characters[observation.opponent.active_character_index]?.definition_id ?? null
        : null,
    derived: buildDerivedSummary(observation),
    query_numeric_slots: buildQueryNumericSlots(observation, sample),
  }
}

function buildDerivedSummary(observation: ObservationV1) {
  return {
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
  }
}

function buildCandidateTags(candidate: ActionCandidateV1): string[] {
  const tags = new Set<string>([
    ...candidate.rule_tags,
    ...(candidate.static_effect_tags ?? []),
  ])
  tags.add(`family:${candidate.family}`)
  tags.add(`pending:${candidate.pending_method}`)
  tags.add(`route:${candidate.routing.route}`)
  tags.add(`action:${candidate.action_case}`)
  if (candidate.is_fast_action) tags.add("fast_action")
  if (candidate.is_fallback_only) tags.add("fallback_only")
  if (candidate.is_model_selectable) tags.add("model_selectable")
  // P2-3: Candidate temporal tags
  if (candidate.temporal_option_kind) tags.add(`temporal_opt:${candidate.temporal_option_kind}`)
  if (candidate.temporal_portfolio_stage) tags.add(`temporal_stage:${candidate.temporal_portfolio_stage}`)
  return [...tags]
}

function buildCandidateNumericSlots(
  candidate: ActionCandidateV1,
  observation: ObservationV1,
) {
  // P0: Derive skill sub-type from cost pattern
  const isUseSkill = candidate.action_case === "useSkill" ? 1 : 0;
  let isNormalAttack = 0;
  let isElementalSkill = 0;
  let isBurst = 0;
  let isPureUtility = 0;
  if (isUseSkill) {
    const specificCost = candidate.required_cost
      .filter((c) => c.type !== 0 && c.type !== 9)
      .reduce((s, c) => s + c.count, 0);
    const voidCost = candidate.required_cost
      .filter((c) => c.type === 0)
      .reduce((s, c) => s + c.count, 0);
    const energyCost = candidate.required_cost
      .filter((c) => c.type === 9)
      .reduce((s, c) => s + c.count, 0);

    if (energyCost > 0) {
      isBurst = 1;
    } else if (specificCost >= 3 && voidCost === 0) {
      isElementalSkill = 1;
    } else {
      isNormalAttack = 1;
    }

    const meta = candidate.meta_effect_slots ?? {};
    isPureUtility = (meta.damage_estimate ?? 0) === 0
      && (meta.healing_estimate ?? 0) === 0
      && Object.keys(meta).length === 0 ? 1 : 0;
  }

  // P1: Tag-derived skill effect flags
  const staticTags = new Set(candidate.static_effect_tags ?? []);
  const hasTag = (t: string) => staticTags.has(t) ? 1 : 0;
  const hasDirectDamage = hasTag("direct_damage");
  const createsSummon = hasTag("summon_create");
  const hasHeal = hasTag("heal_now");
  const hasEnergyGain = hasTag("energy_gain");
  const hasForceSwitchActive = hasTag("force_switch");

  // ━━ P3: Engine-aware features (observation-dependent) ━━
  const selfChars = observation.self.characters;
  const oppChars = observation.opponent.characters;
  const selfActiveIdx = observation.self.active_character_index;
  const oppActiveIdx = observation.opponent.active_character_index;
  const selfActive = selfActiveIdx != null ? selfChars[selfActiveIdx] : undefined;
  const oppActive = oppActiveIdx != null ? oppChars[oppActiveIdx] : undefined;

  // Skill element: from source character's definition_id
  const sourceDefId = candidate.source_ref?.definition_id;
  const skillElement = isUseSkill ? CHAR_ELEMENT_MAP[sourceDefId ?? 0] ?? null : null;

  // Target aura: if skill targets opponent active
  const targetAura = oppActive?.aura ?? null;

  // Element reaction prediction
  let willTriggerReaction = 0;
  let reactionDamageBonus = 0;
  let reactionTypeId = 0;
  if (isUseSkill && skillElement != null && targetAura != null && typeof targetAura === "number") {
    const key = `${skillElement},${targetAura}`;
    reactionTypeId = TRAIN_ALL_REACTIONS[key] ?? 0;
    willTriggerReaction = reactionTypeId > 0 ? 1 : 0;
    reactionDamageBonus = TRAIN_AMPLIFYING[key] ? 2 : 0;
  }

  // Energy breakpoints
  let energyAfterAction = 0;
  let willEnableBurst = 0;
  let energyDeficit = 0;
  let burstEnergyRatio = 0;  // P3: energy-scaled burst
  if (selfActive && isUseSkill) {
    const curEnergy = selfActive.energy;
    const maxEnergy = selfActive.max_energy;
    const energyGain = hasEnergyGain ? 1 : 0;
    energyAfterAction = Math.min(curEnergy + energyGain, maxEnergy);
    willEnableBurst = (energyAfterAction >= maxEnergy && curEnergy < maxEnergy) ? 1 : 0;
    energyDeficit = maxEnergy - curEnergy;
    burstEnergyRatio = isBurst ? (curEnergy / Math.max(1, maxEnergy)) : 0;
  }

  // ── Lethal bonus + Reaction priority ──
  let lethalBonus = 0;
  let reactionIsAmplifying = 0;
  if (isUseSkill && oppActive) {
    const oppHP = oppActive.hp ?? oppActive.health ?? 10;
    const dmgEstimate = candidate.meta_effect_slots?.damage_estimate ?? 0;
    const totalDmg = dmgEstimate + reactionDamageBonus;
    lethalBonus = (totalDmg > 0 && totalDmg >= oppHP) ? 1 : 0;
    reactionIsAmplifying = (reactionDamageBonus >= 2) ? 1 : 0;
  }

  // Dice color matching
  let diceMatchingCount = 0;
  let diceSpecificCostTotal = 0;
  let diceMatchRatio = 1;
  let omniShortfall = 0;
  let omniAvailable = 0;
  if (isUseSkill) {
    const diceByType = observation.self.dice.counts_by_type;
    omniAvailable = observation.self.dice.omni_count;
    for (const cost of candidate.required_cost) {
      if (cost.type === 0 || cost.type === 9) continue; // void or energy
      diceSpecificCostTotal += cost.count;
      const available = Number(diceByType[String(cost.type)] ?? 0);
      diceMatchingCount += Math.min(cost.count, available);
    }
    diceMatchRatio = diceSpecificCostTotal > 0 ? diceMatchingCount / diceSpecificCostTotal : 1;
    omniShortfall = Math.max(0, diceSpecificCostTotal - diceMatchingCount);
  }

  // Shield on target
  let targetHasShield = 0;
  let targetShieldValue = 0;
  if (oppActive) {
    for (const [name, value] of Object.entries(oppActive.usage_counters ?? {})) {
      if (name.toLowerCase().includes("shield")) {
        targetHasShield = 1;
        targetShieldValue += value;
      }
    }
  }

  // Equipment synergy
  let hasTalentEquipped = 0;
  let hasWeaponEquipped = 0;
  let equipmentCount = 0;
  if (selfActive) {
    const equipIds = selfActive.equipment_ids ?? [];
    equipmentCount = equipIds.length;
    hasWeaponEquipped = equipmentCount > 0 ? 1 : 0;
    const charDefId = selfActive.definition_id;
    hasTalentEquipped = equipIds.some(id =>
      id >= charDefId && id <= charDefId + 100
    ) ? 1 : 0;
  }

  // Combat status effects
  const selfCombatDefIds = new Set((observation.self.combat_statuses ?? []).map(e => e.definition_id));
  const oppCombatDefIds = new Set((observation.opponent.combat_statuses ?? []).map(e => e.definition_id));
  const selfHasCrystallize = selfCombatDefIds.has(111) ? 1 : 0;
  const oppHasFrozen = oppCombatDefIds.has(106) ? 1 : 0;
  const oppHasBurning = oppCombatDefIds.has(115) ? 1 : 0;
  const quickenFieldActive = (selfCombatDefIds.has(117) || oppCombatDefIds.has(117)) ? 1 : 0;
  const dendroCoreActive = (selfCombatDefIds.has(116) || oppCombatDefIds.has(116)) ? 1 : 0;

  // Summon pressure
  const selfSummonDmg = (observation.self.summons ?? []).reduce((sum, s) => {
    const usage = (s as any).variable_value ?? 1;
    return sum + (KNOWN_SUMMON_DMG[s.definition_id] ?? 1) * Math.max(1, Number(usage));
  }, 0);
  const oppSummonDmg = (observation.opponent.summons ?? []).reduce((sum, s) => {
    const usage = (s as any).variable_value ?? 1;
    return sum + (KNOWN_SUMMON_DMG[s.definition_id] ?? 1) * Math.max(1, Number(usage));
  }, 0);
  const oppSummonCount = (observation.opponent.summons ?? []).length;

  // Damage type
  const damageIsPiercing = hasTag("piercing_damage");

  // Special resources
  const canChargedAttack = observation.self.can_charged ? 1 : 0;
  const canPlungingAttack = observation.self.can_plunging ? 1 : 0;
  const legendAvailable = observation.self.legend_used ? 0 : 1;

  return {
    candidate_index: candidate.candidate_index,
    engine_index: candidate.engine_index ?? -1,
    target_count: candidate.target_refs.length,
    required_cost_count: candidate.required_cost.reduce((sum, cost) => sum + cost.count, 0),
    auto_selected_dice_count: candidate.auto_selected_dice.length,
    selectable_dice_type_count: candidate.selectable_dice_types.length,
    is_fast_action: candidate.is_fast_action ? 1 : 0,
    is_valid: candidate.is_valid ? 1 : 0,
    is_model_selectable: candidate.is_model_selectable ? 1 : 0,
    is_fallback_only: candidate.is_fallback_only ? 1 : 0,
    validity_code: candidate.validity_code ?? 0,
    // P0: Skill sub-type features
    is_normal_attack: isNormalAttack,
    is_elemental_skill: isElementalSkill,
    is_burst: isBurst,
    is_pure_utility: isPureUtility,
    // P1: Skill effect flag features
    has_direct_damage: hasDirectDamage,
    creates_summon: createsSummon,
    has_heal: hasHeal,
    has_energy_gain: hasEnergyGain,
    has_force_switch_active: hasForceSwitchActive,
    // P3: Engine-aware features
    will_trigger_reaction: willTriggerReaction,
    reaction_damage_bonus: reactionDamageBonus,
    reaction_type_id: reactionTypeId,
    energy_after_action: energyAfterAction,
    will_enable_burst: willEnableBurst,
    energy_deficit: energyDeficit,
    burst_energy_ratio: burstEnergyRatio,
    lethal_bonus: lethalBonus,
    reaction_is_amplifying: reactionIsAmplifying,
    dice_matching_count: diceMatchingCount,
    dice_specific_cost_total: diceSpecificCostTotal,
    dice_match_ratio: diceMatchRatio,
    omni_shortfall: omniShortfall,
    omni_available: omniAvailable,
    target_has_shield: targetHasShield,
    target_shield_value: targetShieldValue,
    has_talent_equipped: hasTalentEquipped,
    has_weapon_equipped: hasWeaponEquipped,
    equipment_count: equipmentCount,
    self_has_crystallize_shield: selfHasCrystallize,
    opp_has_frozen: oppHasFrozen,
    opp_has_burning: oppHasBurning,
    quicken_field_active: quickenFieldActive,
    dendro_core_active: dendroCoreActive,
    self_summon_damage_potential: selfSummonDmg,
    opp_summon_damage_potential: oppSummonDmg,
    opp_summon_count: oppSummonCount,
    damage_is_piercing: damageIsPiercing,
    can_charged_attack: canChargedAttack,
    can_plunging_attack: canPlungingAttack,
    legend_available: legendAvailable,
    meta_effect_slots: candidate.meta_effect_slots ?? {},
    synergy_slots: candidate.synergy_slots ?? {},
    // P2-3: Candidate temporal numeric features
    temporal_prereq_satisfied: candidate.temporal_prereq_satisfied == null ? -1 : (candidate.temporal_prereq_satisfied ? 1 : 0),
    temporal_dice_cost: candidate.temporal_dice_cost ?? 0,
    temporal_dice_budget_ratio: candidate.temporal_dice_budget_ratio ?? 0,
  }
}

// ━━ P3: Training-side shared data ━━

const CHAR_ELEMENT_MAP: Record<number, number> = {
  1101:2, 1102:2, 1103:2, 1104:2, 1105:2, 1107:2, 1109:2, 1110:2, 1112:2,
  1201:6, 1202:6, 1203:6, 1204:6, 1205:6, 1206:6, 1207:6, 1211:6, 1214:6, 1215:6,
  1301:7, 1302:7, 1303:7, 1304:7, 1305:7, 1306:7, 1307:7, 1308:7, 1310:7, 1311:7, 1312:7, 1314:7, 1316:7, 1321:7,
  1401:3, 1402:3, 1403:3, 1404:3, 1405:3, 1406:3, 1407:3, 1408:3, 1411:3, 1412:3, 1421:3, 1425:3,
  1504:1, 1505:1, 1508:1, 1510:1, 1531:1, 1553:1, 1557:1,
  1601:5, 1602:5, 1603:5, 1604:5, 1605:5, 1607:5, 1611:5,
  1701:4, 1702:4, 1703:4, 1705:4,
};

const TRAIN_AMPLIFYING: Record<string, number> = {
  "7,6": 1, "6,7": 1, "7,2": 1, "2,7": 1,
};

const TRAIN_ALL_REACTIONS: Record<string, number> = {
  "7,6":1, "6,7":1, "7,2":2, "2,7":2,
  "7,3":3, "3,7":3, "2,3":4, "3,2":4,
  "6,3":5, "3,6":5, "6,2":6, "2,6":6,
  "1,2":7, "1,3":7, "1,6":7, "1,7":7,
  "5,2":8, "5,3":8, "5,6":8, "5,7":8,
  "7,4":9, "4,7":9, "6,4":10, "4,6":10,
  "3,4":11, "4,3":11,
};

const KNOWN_SUMMON_DMG: Record<number, number> = {
  115: 1, 205: 1,
};

function buildQueryNumericSlots(
  observation: ObservationV1,
  sample: RlDecisionPointSampleV1,
) {
  return {
    round: observation.point.round_number,
    current_turn: observation.point.current_turn,
    action_count_in_round: observation.point.action_count_in_round,
    legal_action_count: sample.decision_point.candidate_count,
    self_hand_count: observation.self.hand.card_count,
    opp_hand_count: observation.opponent.hand.card_count,
    self_dice_count: observation.self.dice.total_count,
    opp_dice_count: observation.opponent.dice.total_count,
    derived: buildDerivedSummary(observation),
    self_effect_family_counts: observation.self.effect_family_counts ?? {},
    self_meta_prior_slots: observation.self.meta_prior_slots ?? {},
    opponent_public_effect_family_counts: observation.opponent.effect_family_counts ?? {},
    opponent_public_meta_prior_slots: observation.opponent.meta_prior_slots ?? {},
  }
}

function computePreferenceConfidence(
  rewardBreakdown: RewardBreakdownV1 | null,
  outcomeLabel: number | null,
): number {
  const rewardSignal = Math.min(1, Math.abs(rewardBreakdown?.total ?? 0))
  const outcomeSignal =
    outcomeLabel == null ? 0.15 : outcomeLabel === 1 ? 0.35 : outcomeLabel === 0.5 ? 0.2 : 0.1
  return clamp(0.2 + rewardSignal * 0.4 + outcomeSignal, 0.05, 1)
}

function buildEvidenceRef(sample: RlDecisionPointSampleV1, comparedCandidateId: string): string {
  return [
    "self_play",
    sample.matchup_id,
    sample.decision_point.decision_point_id,
    sample.chosen_candidate_id ?? "none",
    comparedCandidateId,
  ].join("::")
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
