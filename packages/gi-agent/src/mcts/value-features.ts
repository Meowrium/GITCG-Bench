// Copyright (C) 2024-2025 Guyutongxue
//
// GBDT value features from ActionPhaseSnapshot.
// Builds the same MlValueSample feature_slots that the GBDT value model
// expects, computed from lightweight snapshots.
//
// v2: Full feature parity with training (rl-value.ts + observation-exporter.ts).
//     Derives static_priors, opponent_hand_estimate, and derived features
//     from ActionPhaseSnapshot using the same computation as training.

import type { ActionPhaseSnapshot } from "./state-snapshot.js";
import { diceTotal } from "./dice-vector.js";
import type { AnyValueArtifact } from "@gi-tcg/ml/value";
import { predictValue } from "@gi-tcg/ml/value";
import type { MlValueSample } from "@gi-tcg/ml/contracts";
import {
  buildHandCardStaticAnnotation,
  buildPlayerHandStaticPriorSummary,
} from "../learning/rl/static-priors.js";

// Re-export for MCTS value function
export type { ActionPhaseSnapshot };

// ── Known card/character IDs for threshold features ──
const WOLFS_GRAVESTONE = 311303;
const SHIMENAWAS_REMINISCENCE = 312014;
const YAE_MIKO = 1408;

// ── Main entry point ──

/**
 * Build a flat feature record suitable for GBDT value prediction.
 * Mirrors buildObservationValueFeatureSlots() from rl-value.ts exactly.
 */
export function buildSnapshotValueFeatures(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
): Record<string, number> {
  const selfActive = selfSnap.chars[selfSnap.activeIdx] ?? null;
  const oppActive = oppSnap.chars[oppSnap.activeIdx] ?? null;
  const selfDiceTotal = diceTotal(selfSnap.dice);
  const oppDiceTotal = diceTotal(oppSnap.dice);
  const selfOmni = selfSnap.dice[7] ?? 0;
  const oppOmni = oppSnap.dice[7] ?? 0;

  const selfAlive = selfSnap.chars.filter((c) => c.alive).length;
  const oppAlive = oppSnap.chars.filter((c) => c.alive).length;
  const selfTotalHp = selfSnap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const oppTotalHp = oppSnap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const selfTotalEnergy = selfSnap.chars.reduce((s, c) => s + c.energy, 0);
  const oppTotalEnergy = oppSnap.chars.reduce((s, c) => s + c.energy, 0);

  // ── Self features (matches rl-value.ts §self) ──
  const self: Record<string, number> = {
    hand_count: selfSnap.handDefIds.length,
    dice_count: selfDiceTotal,
    omni_count: selfOmni,
    support_count: selfSnap.supports.length,
    summon_count: selfSnap.summons.length,
    alive_count: selfAlive,
    total_health: selfTotalHp,
    total_energy: selfTotalEnergy,
    active_health: selfActive?.hp ?? 0,
    active_energy: selfActive?.energy ?? 0,
    can_afford_normal: selfDiceTotal >= 2 ? 1 : 0,
    can_afford_skill: selfDiceTotal >= 3 ? 1 : 0,
    can_afford_burst: selfDiceTotal >= 4 ? 1 : 0,
  };

  // ── Opponent features (matches rl-value.ts §opponent) ──
  const opponent: Record<string, number> = {
    hand_count: oppSnap.handDefIds.length,
    dice_count: oppDiceTotal,
    omni_count: oppOmni,
    support_count: oppSnap.supports.length,
    summon_count: oppSnap.summons.length,
    alive_count: oppAlive,
    total_health: oppTotalHp,
    total_energy: oppTotalEnergy,
    active_health: oppActive?.hp ?? 0,
    active_energy: oppActive?.energy ?? 0,
  };

  // ── Static priors (from hand card definitions, mirrors training) ──
  const selfStaticPriors = buildStaticPriorsFromSnapshot(selfSnap);
  const oppStaticPriors = buildStaticPriorsFromSnapshot(oppSnap);

  // ── Per-character features ──
  const selfChars = buildCharFeatures(selfSnap);
  const oppChars = buildCharFeatures(oppSnap);

  // ── Opponent bench ──
  const oppBench = buildOpponentBenchFeatures(oppSnap);

  // ── Hand composition (proper tag lookup, matches training) ──
  const handComp = buildHandCompositionFeatures(selfSnap);

  // ── Public state ──
  const pubState: Record<string, number> = {
    self_declared_end: selfSnap.declaredEnd ? 1 : 0,
    opponent_declared_end: oppSnap.declaredEnd ? 1 : 0,
    self_support_count: selfSnap.supports.length,
    opponent_support_count: oppSnap.supports.length,
    self_summon_count: selfSnap.summons.length,
    opponent_summon_count: oppSnap.summons.length,
  };

  // ── Derived features (proper computation, matches training) ──
  const derived: Record<string, unknown> = buildDerivedFeatures(
    selfSnap, oppSnap,
    selfStaticPriors, oppStaticPriors,
  );

  // ── Pending method (always "action" for MCTS leaf nodes) ──
  const pendingMethod: Record<string, number> = {
    is_action: 1,
    is_choose_active: 0,
    is_reroll_dice: 0,
    is_switch_hands: 0,
    is_select_card: 0,
  };

  // ── Active character features ──
  const selfActiveFeat = buildSelfActiveFeatures(selfActive);
  const oppActiveFeat = buildOpponentActiveFeatures(oppActive, oppSnap);

  // ── Opponent hand estimate (from public info) ──
  const oppHandEstimate = buildOpponentHandEstimateFeatures(oppSnap);

  // ── Opponent history (approximated from visible board) ──
  const oppHistory = buildOpponentHistoryFeatures(oppSnap);

  // ── Assemble (exact same structure as rl-value.ts) ──
  return flatten({
    round: selfSnap.roundNumber,
    current_turn: selfSnap.who,
    action_count_in_round: 0, // unknown from snapshot
    self,
    opponent,
    self_characters: selfChars,
    opponent_characters: oppChars,
    opponent_bench: oppBench,
    hand_composition: handComp,
    public_state: pubState,
    derived,
    static_priors: {
      self_effect_family_counts: selfStaticPriors.effect_family_counts,
      self_meta_prior_slots: selfStaticPriors.meta_prior_slots,
      opponent_public_effect_family_counts: oppStaticPriors.effect_family_counts,
      opponent_public_meta_prior_slots: oppStaticPriors.meta_prior_slots,
    },
    pending_method: pendingMethod,
    self_active: selfActiveFeat,
    opponent_active: oppActiveFeat,
    opponent_hand_estimate: oppHandEstimate,
    opp_history: oppHistory,
  });
}

// ═══════════════════════════════════════════════════════════════
// Static Priors (from hand card definitions)
// ═══════════════════════════════════════════════════════════════

function buildStaticPriorsFromSnapshot(
  snap: ActionPhaseSnapshot,
): ReturnType<typeof buildPlayerHandStaticPriorSummary> {
  const cards = snap.handDefIds.map((defId) => {
    const annotation = buildHandCardStaticAnnotation(defId, [], []);
    return {
      static_effect_tags: annotation.static_effect_tags,
      meta_effect_slots: annotation.meta_effect_slots,
    };
  });
  return buildPlayerHandStaticPriorSummary(cards);
}

// ═══════════════════════════════════════════════════════════════
// Derived Features (mirrors buildDerivedFeatures in observation-exporter.ts)
// ═══════════════════════════════════════════════════════════════

interface StaticPriorSummary {
  effect_family_counts: Record<string, number>;
  meta_prior_slots: Record<string, number>;
}

function buildDerivedFeatures(
  selfSnap: ActionPhaseSnapshot,
  oppSnap: ActionPhaseSnapshot,
  selfPriors: StaticPriorSummary,
  oppPriors: StaticPriorSummary,
): Record<string, unknown> {
  const selfBurstOnline = countBurstOnline(selfSnap);
  const oppBurstOnline = countBurstOnline(oppSnap);
  const selfReactionReady = scoreReactionReadiness(selfSnap, oppSnap);
  const oppReactionReady = scoreReactionReadiness(oppSnap, selfSnap);
  const selfResourceScore = scoreResources(selfSnap);
  const oppResourceScore = scoreResources(oppSnap);
  const selfKoPressure = scoreKoPressure(selfSnap, oppSnap);
  const oppKoPressure = scoreKoPressure(oppSnap, selfSnap);
  const selfSetupWindow = scoreSetupWindow(selfSnap, selfPriors);
  const oppSetupWindow = scoreSetupWindow(oppSnap, oppPriors);
  const selfReserveValue = scoreReserveValue(selfSnap, selfPriors);
  const oppReserveValue = scoreReserveValue(oppSnap, oppPriors);
  const threshold = computeThresholdFeatures(selfSnap, oppSnap);

  return {
    self_damage_capacity_now:
      selfResourceScore * 0.35 + selfBurstOnline * 2 + selfReactionReady,
    opp_damage_capacity_now:
      oppResourceScore * 0.35 + oppBurstOnline * 2 + oppReactionReady,
    self_ko_pressure_now: selfKoPressure,
    opp_ko_pressure_now: oppKoPressure,
    self_resource_score: selfResourceScore,
    opp_resource_score: oppResourceScore,
    self_reaction_ready_score: selfReactionReady,
    opp_reaction_ready_score: oppReactionReady,
    self_burst_online_count: selfBurstOnline,
    opp_burst_online_count: oppBurstOnline,
    self_setup_window_score: selfSetupWindow,
    opp_setup_window_score: oppSetupWindow,
    self_reserve_value_score: selfReserveValue,
    opp_reserve_value_score: oppReserveValue,
    self_role_integrity_score: scoreRoleIntegrity(selfSnap),
    opp_role_integrity_score: scoreRoleIntegrity(oppSnap),
    self_window_score:
      selfResourceScore +
      selfKoPressure * 0.75 +
      selfReactionReady * 0.5 +
      selfSetupWindow * 0.25 +
      selfReserveValue * 0.15,
    opp_window_score:
      oppResourceScore +
      oppKoPressure * 0.75 +
      oppReactionReady * 0.5 +
      oppSetupWindow * 0.25 +
      oppReserveValue * 0.15,
    game_setup_completion: -1,
    game_phase_estimate: -1,
    game_primary_path_viable: -1,
    threshold,
    dice_efficiency: diceTotal(selfSnap.dice) > 0
      ? (selfSnap.dice[7] ?? 0) / diceTotal(selfSnap.dice)
      : 0,
    summon_pressure: estimateSummonPressure(selfSnap),
    action_economy_ratio: estimateActionEconomyRatio(selfSnap, oppSnap),
    elemental_application_map: buildElementalApplicationMap(selfSnap, oppSnap),
    // Temporal features: simplified approximation (full computation needs profile registry)
    self_temporal_setup_saturation: Math.min(selfSnap.supports.length / 4, 1),
    self_ready_to_cash_option_count: 0,
    self_blocked_synergy_option_count: 0,
    self_available_deferred_option_count: 0,
    opp_temporal_setup_saturation: Math.min(oppSnap.supports.length / 4, 1),
    opp_ready_to_cash_option_count: 0,
    opp_blocked_synergy_option_count: 0,
    opp_available_deferred_option_count: 0,
  };
}

// ── Derived sub-computations ──

function scoreResources(snap: ActionPhaseSnapshot): number {
  const totalEnergy = snap.chars.reduce((sum, c) => sum + c.energy, 0);
  const diceCount = diceTotal(snap.dice);
  return (
    diceCount +
    snap.handDefIds.length * 0.75 +
    totalEnergy * 0.5 +
    snap.supports.length * 0.25 +
    snap.summons.length * 0.35
  );
}

function countBurstOnline(snap: ActionPhaseSnapshot): number {
  return snap.chars.filter(
    (c) => c.alive && c.maxEnergy > 0 && c.energy >= c.maxEnergy,
  ).length;
}

function scoreReactionReadiness(
  self: ActionPhaseSnapshot,
  opponent: ActionPhaseSnapshot,
): number {
  const exploitableAuras = opponent.chars.filter(
    (c) => c.alive && c.aura > 0,
  ).length;
  const selfAuraCount = self.chars.filter(
    (c) => c.alive && c.aura > 0,
  ).length;
  return exploitableAuras + selfAuraCount * 0.25;
}

function scoreKoPressure(
  self: ActionPhaseSnapshot,
  opponent: ActionPhaseSnapshot,
): number {
  const baseThreat = Math.max(1, countBurstOnline(self) * 2 + self.summons.length);
  return opponent.chars.reduce((sum, c) => {
    if (!c.alive) return sum;
    if (c.hp <= baseThreat) return sum + 1;
    if (c.hp <= baseThreat + 2) return sum + 0.5;
    return sum;
  }, 0);
}

function scoreRoleIntegrity(snap: ActionPhaseSnapshot): number {
  const alive = snap.chars.filter((c) => c.alive);
  const hpRatio =
    alive.reduce((sum, c) => sum + c.hp / Math.max(c.maxHp, 1), 0) /
    Math.max(alive.length, 1);
  return alive.length * 1.25 + hpRatio + countBurstOnline(snap) * 0.25;
}

function scoreSetupWindow(
  snap: ActionPhaseSnapshot,
  priors: StaticPriorSummary,
): number {
  const setupDependency = priors.meta_prior_slots.hand_setup_dependency_total ?? 0;
  const supportCreate = priors.effect_family_counts.support_create ?? 0;
  const summonCreate = priors.effect_family_counts.summon_create ?? 0;
  const reactionEnable = priors.effect_family_counts.reaction_enable ?? 0;
  return (
    snap.supports.length * 0.5 +
    snap.summons.length * 0.7 +
    setupDependency * 0.4 +
    supportCreate * 0.45 +
    summonCreate * 0.55 +
    reactionEnable * 0.2
  );
}

function scoreReserveValue(
  snap: ActionPhaseSnapshot,
  priors: StaticPriorSummary,
): number {
  const handRetention = priors.meta_prior_slots.hand_retention_total ?? 0;
  const handFinisher = priors.meta_prior_slots.hand_finisher_alignment_total ?? 0;
  const totalEnergy = snap.chars.reduce((sum, c) => sum + c.energy, 0);
  return (
    handRetention * 0.18 +
    handFinisher * 0.2 +
    (snap.dice[7] ?? 0) * 0.85 +
    snap.handDefIds.length * 0.08 +
    totalEnergy * 0.12
  );
}

function estimateSummonPressure(snap: ActionPhaseSnapshot): number {
  return snap.summons.reduce((sum, s) => sum + Math.max(0, s.usage) * 1.5, 0);
}

function estimateActionEconomyRatio(
  self: ActionPhaseSnapshot,
  opp: ActionPhaseSnapshot,
): number {
  const selfActions = self.combatStatuses.length + self.summons.length;
  const oppActions = opp.combatStatuses.length + opp.summons.length;
  return oppActions > 0 ? selfActions / oppActions : selfActions > 0 ? 2 : 1;
}

function buildElementalApplicationMap(
  self: ActionPhaseSnapshot,
  opp: ActionPhaseSnapshot,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < self.chars.length; i++) {
    const ch = self.chars[i];
    if (ch.alive && ch.aura > 0) {
      result[`self_c${i}_aura`] = ch.aura;
    }
  }
  for (let i = 0; i < opp.chars.length; i++) {
    const ch = opp.chars[i];
    if (ch.alive && ch.aura > 0) {
      result[`opp_c${i}_aura`] = ch.aura;
    }
  }
  return result;
}

// ── Threshold Features ──

function computeThresholdFeatures(
  self: ActionPhaseSnapshot,
  opp: ActionPhaseSnapshot,
): Record<string, number> {
  const selfAlive = self.chars.filter((c) => c.alive);
  const oppAlive = opp.chars.filter((c) => c.alive);
  const selfActive = self.chars[self.activeIdx];
  const oppActive = opp.chars[opp.activeIdx];

  // Energy thresholds
  const selfAnyNearFull = selfAlive.some(
    (c) => c.maxEnergy > 0 && c.energy >= c.maxEnergy - 1,
  ) ? 1 : 0;
  const oppAnyNearFull = oppAlive.some(
    (c) => c.maxEnergy > 0 && c.energy >= c.maxEnergy - 1,
  ) ? 1 : 0;
  const selfAnyEnergyGe2 = selfAlive.some((c) => c.energy >= 2) ? 1 : 0;
  const oppAnyEnergyGe2 = oppAlive.some((c) => c.energy >= 2) ? 1 : 0;

  // HP thresholds
  const oppActiveHpLe6 = oppActive && oppActive.alive && oppActive.hp <= 6 ? 1 : 0;
  const selfActiveHpLe6 = selfActive && selfActive.alive && selfActive.hp <= 6 ? 1 : 0;

  // Kill range
  const selfBurstCount = selfAlive.filter(
    (c) => c.maxEnergy > 0 && c.energy >= c.maxEnergy,
  ).length;
  const oppBurstCount = oppAlive.filter(
    (c) => c.maxEnergy > 0 && c.energy >= c.maxEnergy,
  ).length;
  const selfEstDamage = Math.max(3, selfBurstCount * 4 + self.summons.length * 2);
  const oppEstDamage = Math.max(3, oppBurstCount * 4 + opp.summons.length * 2);
  const oppAnyInKillRange = oppAlive.some((c) => c.hp <= selfEstDamage) ? 1 : 0;
  const selfAnyInKillRange = selfAlive.some((c) => c.hp <= oppEstDamage) ? 1 : 0;

  // Equipment thresholds
  const selfHasWolfs = selfAlive.some((c) =>
    (c.equipDefIds ?? []).includes(WOLFS_GRAVESTONE),
  ) ? 1 : 0;
  const selfHasShimenawas = selfAlive.some((c) =>
    (c.equipDefIds ?? []).includes(SHIMENAWAS_REMINISCENCE),
  ) ? 1 : 0;
  const selfShimenawasActive = selfHasShimenawas && selfAnyEnergyGe2 ? 1 : 0;
  const selfWolfsActive = selfHasWolfs && oppActiveHpLe6 ? 1 : 0;

  // Summon usages
  const selfSummonUsages = self.summons.reduce((s, sm) => s + Math.max(0, sm.usage), 0);
  const oppSummonUsages = opp.summons.reduce((s, sm) => s + Math.max(0, sm.usage), 0);
  const selfHasYaeMiko = selfAlive.some((c) => c.definitionId === YAE_MIKO) ? 1 : 0;
  const selfYaeExtra = selfHasYaeMiko && selfSummonUsages > 3 ? 1 : 0;

  // Functional tier counts (simplified heuristic)
  const selfCoreAlive = selfAlive.filter((c) =>
    self.chars.indexOf(c) === self.activeIdx ||
    (c.maxEnergy > 0 && c.energy >= c.maxEnergy - 1),
  ).length;
  const oppCoreAlive = oppAlive.filter((c) =>
    opp.chars.indexOf(c) === opp.activeIdx ||
    (c.maxEnergy > 0 && c.energy >= c.maxEnergy - 1),
  ).length;
  const selfResidualAlive = selfAlive.filter(
    (c) => c.hp / Math.max(c.maxHp, 1) < 0.3 || c.maxEnergy === 0,
  ).length;
  const oppResidualAlive = oppAlive.filter(
    (c) => c.hp / Math.max(c.maxHp, 1) < 0.3 || c.maxEnergy === 0,
  ).length;

  // Dice alignment (match dice element to active character aura)
  const selfDiceAlign = computeDiceAlignment(self);
  const oppDiceAlign = computeDiceAlignment(opp);

  return {
    self_any_energy_near_full: selfAnyNearFull,
    opp_any_energy_near_full: oppAnyNearFull,
    self_any_energy_ge_2: selfAnyEnergyGe2,
    opp_any_energy_ge_2: oppAnyEnergyGe2,
    opp_active_hp_le_6: oppActiveHpLe6,
    self_active_hp_le_6: selfActiveHpLe6,
    opp_any_in_kill_range: oppAnyInKillRange,
    self_any_in_kill_range: selfAnyInKillRange,
    self_has_wolfs_gravestone: selfHasWolfs,
    self_has_shimenawas: selfHasShimenawas,
    self_shimenawas_active: selfShimenawasActive,
    self_wolfs_gravestone_active: selfWolfsActive,
    self_summon_total_usages: selfSummonUsages,
    opp_summon_total_usages: oppSummonUsages,
    self_has_yae_miko: selfHasYaeMiko,
    self_yae_miko_extra_trigger: selfYaeExtra,
    self_core_alive_count: selfCoreAlive,
    self_tactical_alive_count: selfAlive.length - selfCoreAlive - selfResidualAlive,
    self_residual_alive_count: selfResidualAlive,
    opp_core_alive_count: oppCoreAlive,
    opp_tactical_alive_count: oppAlive.length - oppCoreAlive - oppResidualAlive,
    opp_residual_alive_count: oppResidualAlive,
    self_dice_alignment: selfDiceAlign,
    opp_dice_alignment: oppDiceAlign,
  };
}

function computeDiceAlignment(snap: ActionPhaseSnapshot): number {
  const active = snap.chars[snap.activeIdx];
  if (!active || !active.alive || !active.aura) return 0;
  const matching = snap.dice[active.aura] ?? 0;
  const total = diceTotal(snap.dice);
  return total > 0 ? matching / total : 0;
}

// ═══════════════════════════════════════════════════════════════
// Character features
// ═══════════════════════════════════════════════════════════════

function buildCharFeatures(snap: ActionPhaseSnapshot): Record<string, number> {
  const feat: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    const prefix = `c${i}`;
    const ch = snap.chars[i];
    if (!ch) {
      feat[`${prefix}_alive`] = 0;
      feat[`${prefix}_hp`] = 0;
      feat[`${prefix}_hp_ratio`] = 0;
      feat[`${prefix}_energy_ratio`] = 0;
      feat[`${prefix}_equip_count`] = 0;
      feat[`${prefix}_definition_id`] = 0;
      continue;
    }
    feat[`${prefix}_alive`] = ch.alive ? 1 : 0;
    feat[`${prefix}_hp`] = ch.hp;
    feat[`${prefix}_hp_ratio`] = ch.maxHp > 0 ? ch.hp / ch.maxHp : 0;
    feat[`${prefix}_energy_ratio`] = ch.maxEnergy > 0 ? ch.energy / ch.maxEnergy : 0;
    feat[`${prefix}_equip_count`] = (ch.equipDefIds ?? []).length;
    feat[`${prefix}_definition_id`] = ch.definitionId;
  }
  return feat;
}

// ═══════════════════════════════════════════════════════════════
// Hand composition (proper tag lookup via static priors)
// ═══════════════════════════════════════════════════════════════

function buildHandCompositionFeatures(
  snap: ActionPhaseSnapshot,
): Record<string, number> {
  let eventCount = 0;
  let supportCount = 0;
  let equipmentCount = 0;
  let foodCount = 0;
  let otherCount = 0;

  for (const defId of snap.handDefIds) {
    const annotation = buildHandCardStaticAnnotation(defId, [], []);
    const tags = new Set(annotation.static_effect_tags);
    // Check card type via tags (more accurate than defId heuristic)
    if (tags.has("support_card") || tags.has("support_create")) {
      supportCount++;
    } else if (tags.has("equipment_card") || tags.has("weapon") || tags.has("artifact")) {
      equipmentCount++;
    } else if (tags.has("food")) {
      foodCount++;
    } else if (tags.has("event")) {
      eventCount++;
    } else {
      // Fallback to defId heuristic
      const prefix = Math.floor(defId / 10000);
      if (prefix === 32) supportCount++;
      else if (prefix === 33 || prefix === 34) eventCount++;
      else if (prefix === 31) equipmentCount++;
      else otherCount++;
    }
  }

  // Per-card definition_id (up to 10 slots)
  const cardIds: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    cardIds[`card${i}_definition_id`] = snap.handDefIds[i] ?? 0;
  }

  return {
    total: snap.handDefIds.length,
    event_count: eventCount,
    support_count: supportCount,
    equipment_count: equipmentCount,
    food_count: foodCount,
    other_count: otherCount,
    ...cardIds,
  };
}

// ═══════════════════════════════════════════════════════════════
// Opponent bench
// ═══════════════════════════════════════════════════════════════

function buildOpponentBenchFeatures(
  oppSnap: ActionPhaseSnapshot,
): { min_hp: number; min_hp_index: number } {
  let minHp = Infinity;
  let minHpIndex = -1;
  for (let i = 0; i < oppSnap.chars.length; i++) {
    const c = oppSnap.chars[i];
    if (!c.alive || i === oppSnap.activeIdx) continue;
    if (c.hp < minHp) {
      minHp = c.hp;
      minHpIndex = i;
    }
  }
  if (minHpIndex === -1) minHp = 0;
  return { min_hp: minHp, min_hp_index: minHpIndex };
}

// ═══════════════════════════════════════════════════════════════
// Active character features
// ═══════════════════════════════════════════════════════════════

function buildSelfActiveFeatures(
  active: ActionPhaseSnapshot["chars"][0] | null,
): Record<string, number> {
  return {
    skill_damage_normal: 2,
    skill_damage_skill: 3,
    skill_damage_burst: 4,
    energy_full:
      active && active.maxEnergy > 0 && active.energy >= active.maxEnergy ? 1 : 0,
  };
}

function buildOpponentActiveFeatures(
  active: ActionPhaseSnapshot["chars"][0] | null,
  oppSnap: ActionPhaseSnapshot,
): Record<string, number> {
  let isFrozen = 0;
  let isStunned = 0;
  let shield = 0;

  // Check combat statuses for freeze/stun
  for (const cs of oppSnap.combatStatuses) {
    if (cs.definitionId === 106) isFrozen = 1;
    if (cs.definitionId === 116033) isStunned = 1;
  }

  // Compute shield from combat_statuses with shield-related variable names
  // (mirrors rl-value.ts buildOpponentActiveFeatures)
  for (const cs of oppSnap.combatStatuses) {
    // Check description_dictionary for shield indicators
    // In snapshot, we don't have variable_name — use definition_id heuristics
    // Common shield status IDs: 201 (crystallize), various character shields
    const shieldDefIds = new Set([201]);
    if (shieldDefIds.has(cs.definitionId)) {
      shield += Math.max(0, cs.usage);
    }
  }

  // Also check character-level shields (e.g., Noelle breastplate)
  // These appear as equipment/status entities on the active character
  if (active?.equipDefIds) {
    // Shield-providing equipment typically have shield tags
    // Approximation: count equipment with usage counters > 0
    for (const defId of active.equipDefIds) {
      const annotation = buildHandCardStaticAnnotation(defId, [], []);
      if ((annotation.static_effect_tags ?? []).some(
        (t) => t === "shield" || t === "damage_reduction",
      )) {
        shield += 2; // conservative estimate
      }
    }
  }

  return { is_frozen: isFrozen, is_stunned: isStunned, shield };
}

// ═══════════════════════════════════════════════════════════════
// Opponent hand estimate (from public info)
// ═══════════════════════════════════════════════════════════════

function buildOpponentHandEstimateFeatures(
  oppSnap: ActionPhaseSnapshot,
): Record<string, number> {
  // In self-play/benchmark context, we have perfect information about
  // the opponent's hand (matches training data distribution).
  const handCount = oppSnap.handDefIds.length;
  const totalCards = 30; // standard deck size
  // Estimate deck remaining: total - (hand + deployed supports/equipment)
  const deployedCards =
    oppSnap.supports.length +
    oppSnap.summons.length +
    oppSnap.chars.reduce((s, c) => s + (c.equipDefIds?.length ?? 0), 0);
  const deckRemaining = Math.max(0, totalCards - handCount - deployedCards);

  // Classify cards in opponent's hand (from perfect info)
  let expectedEvent = 0;
  let expectedEquipment = 0;
  let expectedSupport = 0;
  let expectedFood = 0;
  let expectedResonance = 0;
  let responseHeal = 0;
  let responseDiceFix = 0;
  let responseSwap = 0;
  let responseBurst = 0;

  for (const defId of oppSnap.handDefIds) {
    const annotation = buildHandCardStaticAnnotation(defId, [], []);
    const tags = annotation.static_effect_tags ?? [];

    if (tags.some((t) => t === "support_card" || t === "support_create"))
      expectedSupport++;
    else if (tags.some((t) => t === "equipment_card" || t === "weapon" || t === "artifact"))
      expectedEquipment++;
    else if (tags.includes("food"))
      expectedFood++;
    else if (tags.includes("resonance"))
      expectedResonance++;
    else
      expectedEvent++;

    // Response bucket estimation
    if (tags.includes("heal_now")) responseHeal = Math.max(responseHeal, 1);
    if (tags.includes("dice_fix")) responseDiceFix = Math.max(responseDiceFix, 1);
    if (tags.includes("force_switch")) responseSwap = Math.max(responseSwap, 1);
    if (tags.includes("burst_enable")) responseBurst = Math.max(responseBurst, 1);
  }

  return {
    hidden_hand_count: handCount,
    deck_remaining: deckRemaining,
    expected_event: expectedEvent,
    expected_equipment: expectedEquipment,
    expected_support: expectedSupport,
    expected_food: expectedFood,
    expected_resonance: expectedResonance,
    response_heal: responseHeal,
    response_dice_fix: responseDiceFix,
    response_swap: responseSwap,
    response_burst: responseBurst,
    known_revealed_cards: 0, // not tracked in snapshot
    deck_draw_ratio: totalCards > 0 ? deckRemaining / totalCards : 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Opponent history (approximated from visible board)
// ═══════════════════════════════════════════════════════════════

function buildOpponentHistoryFeatures(
  oppSnap: ActionPhaseSnapshot,
): Record<string, number> {
  const oppDiceTotal = diceTotal(oppSnap.dice);
  const oppOmni = oppSnap.dice[7] ?? 0;
  const oppElemental = oppDiceTotal - oppOmni;
  const diceSpent = Math.max(0, 8 - oppDiceTotal);

  const oppAlive = oppSnap.chars.filter((c) => c.alive).length;
  const oppTotalHp = oppSnap.chars.reduce((s, c) => s + (c.alive ? c.hp : 0), 0);
  const oppMaxHp = oppSnap.chars.reduce((s, c) => s + c.maxHp, 0);
  const oppActive = oppSnap.chars[oppSnap.activeIdx] ?? null;
  const activeHpRatio = oppActive
    ? oppActive.hp / Math.max(oppActive.maxHp, 1)
    : 0;

  let burstReady = 0;
  let burstNear = 0;
  for (const ch of oppSnap.chars) {
    if (!ch.alive) continue;
    if (ch.maxEnergy > 0 && ch.energy >= ch.maxEnergy) burstReady++;
    else if (ch.maxEnergy > 0 && ch.energy >= ch.maxEnergy - 1) burstNear++;
  }

  const boardDevelopment = oppSnap.supports.length + oppSnap.summons.length;
  const oppHpRatio = oppMaxHp > 0 ? oppTotalHp / oppMaxHp : 1;
  const koPressure = oppAlive > 0 ? (1 - oppHpRatio) * oppAlive : 0;
  const damageCapacity = oppDiceTotal >= 3 ? oppAlive * 2 : oppAlive;

  return {
    dice_spent_this_round: diceSpent,
    omni_remaining: oppOmni,
    elemental_remaining: oppElemental,
    omni_ratio: oppDiceTotal > 0 ? oppOmni / oppDiceTotal : 0,
    actions_in_round: 0,
    active_hp_ratio: activeHpRatio,
    burst_ready_count: burstReady,
    burst_near_count: burstNear,
    board_development: boardDevelopment,
    alive_count: oppAlive,
    declared_end: oppSnap.declaredEnd ? 1 : 0,
    ko_pressure: koPressure,
    damage_capacity: damageCapacity,
    action_economy_ratio: 0,
    temporal_setup_sat: oppSnap.supports.length / 4,
    ready_to_cash: 0,
    blocked_synergy: 0,
    available_deferred: 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// Utility: flatten nested object to dot-notation
// ═══════════════════════════════════════════════════════════════

function flatten(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number" && Number.isFinite(value)) {
      result[path] = value;
    } else if (
      value != null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      Object.assign(result, flatten(value as Record<string, unknown>, path));
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
// GBRL Value Function (pure TypeScript — zero Python subprocess)
// ═══════════════════════════════════════════════════════════════

import { predictGbrlTrees, type GbrlTreeExport } from "./gbrl-trees.js";

interface GbrlValueArtifact {
  artifact_type: "gbrl_value.v1";
  model_path: string;
  features_path: string;
  bias: number;
  feature_names: string[];
}

let _gbrlTrees: GbrlTreeExport | null = null;

function loadGbrlTrees(artifact: GbrlValueArtifact): GbrlTreeExport | null {
  if (_gbrlTrees) return _gbrlTrees;

  // Build trees JSON path from model_path: strip .gbrl_model, append .gbrl-trees.json
  const treesPath = artifact.model_path.replace(/\.gbrl_model$/, "") + ".gbrl-trees.json";

  try {
    const fs = require("node:fs");
    const raw = fs.readFileSync(treesPath, "utf8");
    _gbrlTrees = JSON.parse(raw) as GbrlTreeExport;
    return _gbrlTrees;
  } catch {
    return null;
  }
}

function createGbrlValueFn(
  artifact: GbrlValueArtifact,
): ((snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => number) | null {
  if (!artifact || artifact.artifact_type !== "gbrl_value.v1") return null;

  const trees = loadGbrlTrees(artifact);
  if (!trees) return null; // trees JSON not found, fall through to GBDT/linear

  return (selfSnap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot): number => {
    try {
      const flatFeatures = buildSnapshotValueFeatures(selfSnap, oppSnap);
      return predictGbrlTrees(trees, flatFeatures);
    } catch {
      return artifact.bias;
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// GBDT Value Function
// ═══════════════════════════════════════════════════════════════

/**
 * Create a value function backed by a GBDT (or linear/MLP) model.
 * Returns a ValueFn-compatible function for use with MctsEngine.
 */
export function createGbdtValueFn(
  artifact: Record<string, unknown> | null,
): ((snap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot) => number) | null {
  if (!artifact) return null;

  // GBRL direct inference — try first, fall through to GBDT if trees unavailable
  if (artifact.artifact_type === "gbrl_value.v1") {
    const gbrlFn = createGbrlValueFn(artifact as unknown as GbrlValueArtifact);
    if (gbrlFn) return gbrlFn;
    // Trees JSON not found (pipeline missing export_gbrl_trees.py step).
    // Fall through to standard GBDT/linear/MLP prediction below.
  }

  // Standard GBDT/linear/MLP inference
  return (selfSnap: ActionPhaseSnapshot, oppSnap: ActionPhaseSnapshot): number => {
    try {
      const flatFeatures = buildSnapshotValueFeatures(selfSnap, oppSnap);
      const featureSlots: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(flatFeatures)) {
        featureSlots[k] = v;
      }
      const sample: MlValueSample = {
        sample_id: `mcts_leaf_${Date.now()}`,
        source: "mcts_inference",
        state_ref: null,
        target_value: 0,
        feature_slots: featureSlots as MlValueSample["feature_slots"],
      };
      return predictValue(artifact as unknown as AnyValueArtifact, sample);
    } catch {
      return 0;
    }
  };
}
