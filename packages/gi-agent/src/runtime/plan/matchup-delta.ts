// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { DeckMeta, ThreatRule } from "./types.js"

/**
 * Per-phase extra threat rules generated from comparing self vs opponent DeckMeta.
 * These are generic rules — no per-deck hardcoding — that inject opponent-awareness
 * into the existing StrategicPlanStateMachine via additional ThreatRules.
 */
export interface MatchupDelta {
  /** Extra threat rules to append into each phase */
  extraThreatRules: Record<string, ThreatRule[]>
}

/**
 * Compute opponent-aware threat rules by comparing our deck meta against the
 * opponent's deck meta.  The rules use the same ThreatRule/Condition primitives
 * already consumed by StrategicPlanStateMachine, so no new runtime code paths
 * are needed.
 *
 * All rules are purely data-derived and work for any deck pair.
 */
export function computeMatchupDelta(
  self: DeckMeta,
  opp: DeckMeta,
): MatchupDelta {
  const extraThreatRules: Record<string, ThreatRule[]> = {
    early_setup: [],
    mid_execution: [],
    late_burst: [],
    emergency_recovery: [],
  }

  // ── Opponent is fast (aggro/tempo) — we need to survive early ──
  if (opp.speed === "fast" && self.speed !== "fast") {
    extraThreatRules.early_setup.push({
      threatId: "matchup_opp_fast_early",
      threat: { type: "any_opponent_full_energy" },
      priorityActions: [
        { type: "play_card_class", cardClass: "food" },
        { type: "switch_to", characterId: -1 },
      ],
      bonusMultiplier: 80,
      description: "Opponent is a fast deck — prioritize defense when opponent has full energy",
    })
    extraThreatRules.mid_execution.push({
      threatId: "matchup_opp_fast_core_hp",
      threat: { type: "character_hp_below", characterId: 0, maxHp: 4 },
      priorityActions: [
        { type: "play_card_class", cardClass: "food" },
      ],
      bonusMultiplier: 80,
      description: "Opponent is fast — protect core character at higher HP threshold",
    })
  }

  // ── Opponent is slow (control/combo) — we can pressure early ──
  if (opp.speed === "slow" && self.speed === "fast") {
    extraThreatRules.early_setup.push({
      threatId: "matchup_opp_slow_pressure",
      threat: { type: "round_gte", round: 1 },
      priorityActions: [
        { type: "elemental_skill", characterId: 0 },
      ],
      bonusMultiplier: 50,
      description: "Opponent is slow — establish board early",
    })
    extraThreatRules.late_burst.push({
      threatId: "matchup_opp_slow_finish",
      threat: { type: "any_self_full_energy" },
      priorityActions: [
        { type: "elemental_burst", characterId: 0 },
      ],
      bonusMultiplier: 100,
      description: "Finish before slow opponent stabilizes",
    })
  }

  // ── Opponent is significantly stronger ──
  if (opp.strength - self.strength > 2) {
    extraThreatRules.early_setup.push({
      threatId: "matchup_opp_stronger_early",
      threat: { type: "round_gte", round: 1 },
      priorityActions: [
        { type: "play_card_class", cardClass: "food" },
      ],
      bonusMultiplier: 50,
      description: "Opponent deck is stronger — play conservatively from start",
    })
    extraThreatRules.mid_execution.push({
      threatId: "matchup_opp_stronger_survive",
      threat: { type: "character_hp_below", characterId: 0, maxHp: 6 },
      priorityActions: [
        { type: "play_card_class", cardClass: "food" },
        { type: "switch_to", characterId: -1 },
      ],
      bonusMultiplier: 100,
      description: "Opponent deck is stronger — prioritize survival",
    })
  }

  // ── We are significantly stronger — push advantage ──
  if (self.strength - opp.strength > 2) {
    extraThreatRules.late_burst.push({
      threatId: "matchup_self_stronger_finish",
      threat: { type: "any_self_full_energy" },
      priorityActions: [
        { type: "elemental_burst", characterId: 0 },
      ],
      bonusMultiplier: 100,
      description: "Our deck is stronger — finish decisively",
    })
  }

  // ── Opponent is aggro, we are control — survive the rush ──
  if (opp.archetype === "aggro" && self.archetype === "control") {
    extraThreatRules.mid_execution.push({
      threatId: "matchup_ctrl_vs_aggro",
      threat: { type: "character_hp_below", characterId: 0, maxHp: 5 },
      priorityActions: [
        { type: "play_card_class", cardClass: "food" },
        { type: "switch_to", characterId: -1 },
      ],
      bonusMultiplier: 120,
      description: "Control vs aggro — survive the rush at all costs",
    })
  }

  // ── Opponent is combo, we are aggro — disrupt before they go off ──
  if (opp.archetype === "combo" && self.archetype === "aggro") {
    extraThreatRules.early_setup.push({
      threatId: "matchup_aggro_vs_combo_disrupt",
      threat: { type: "any_opponent_full_energy" },
      priorityActions: [
        { type: "switch_to", characterId: -1 },
      ],
      bonusMultiplier: 80,
      description: "Aggro vs combo — disrupt opponent energy buildup",
    })
  }

  // ── We are combo — protect the carry until burst turn ──
  if (self.archetype === "combo") {
    extraThreatRules.late_burst.push({
      threatId: "matchup_combo_protect_burst",
      threat: { type: "any_self_full_energy" },
      priorityActions: [
        { type: "elemental_burst", characterId: 0 },
      ],
      bonusMultiplier: 100,
      description: "Combo deck — prioritize burst when energy is full",
    })
  }

  return { extraThreatRules }
}
