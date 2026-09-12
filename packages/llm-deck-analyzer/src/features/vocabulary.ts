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

import type { FeatureVocabulary } from "./types"

export const ACTION_CARD_FUNCTION_TAGS = [
  "card_draw",
  "card_filter",
  "dice_fix",
  "dice_gain",
  "energy_gain",
  "fast_swap",
  "forced_swap",
  "cost_discount",
  "cost_conversion",
  "shield",
  "heal",
  "revive",
  "damage_boost",
  "burst_amplifier",
  "normal_attack_amplifier",
  "skill_reset",
  "talent_enable",
  "equipment_enable",
  "summon_create",
  "summon_scale",
  "support_engine",
  "hand_engine",
  "stall_tool",
  "tempo_push",
  "reaction_enable",
  "reaction_payoff",
  "anti_summon",
  "anti_support",
  "anti_greedy_setup",
  "finisher_setup",
] as const

export const ACTION_CARD_PACKAGES = [
  "universal_resource_package",
  "fast_start_package",
  "support_engine_package",
  "equipment_carry_package",
  "talent_core_package",
  "reaction_enable_package",
  "reaction_payoff_package",
  "summon_pressure_package",
  "control_stall_package",
  "long_game_value_package",
  "burst_finish_package",
  "anti_tempo_package",
] as const

export const FEATURE_VOCABULARY: FeatureVocabulary = {
  version: "v2",
  namespaces: [
    "deck.char",
    "deck.char_pair",
    "deck.char_trio",
    "deck.card",
    "deck.card_count",
    "deck.action.function",
    "deck.action.package",
    "deck.action.dependency",
    "deck.action.threshold",
    "deck.synergy",
    "deck.dependency",
    "deck.combo.signal",
    "deck.combo.trigger",
    "deck.combo.edge_type",
    "deck.curve",
    "matchup.a_char_trio__b_char_trio",
    "matchup.a_card__b_card",
    "matchup.a_package__b_package",
    "matchup.a_route__b_route",
    "matchup.a_engine__b_counter",
    "matchup.a_dependency__b_pressure",
    "matchup.a_phase__b_phase",
  ],
  actionCardFunctionTags: [...ACTION_CARD_FUNCTION_TAGS],
  actionCardPackages: [...ACTION_CARD_PACKAGES],
  deckGraphNodeTypes: [
    "character",
    "action_card",
    "package",
    "reaction_route",
    "engine",
    "dependency",
    "plan_phase",
    "threat",
  ],
  deckGraphEdgeTypes: [
    "includes",
    "enables",
    "requires",
    "amplifies",
    "converts_to",
    "stabilizes",
    "conflicts_with",
    "protects",
    "finishes",
  ],
  matchupGraphNodeTypes: [
    "character",
    "action_card",
    "package",
    "reaction_route",
    "engine",
    "dependency",
    "plan_phase",
    "threat",
    "matchup_axis",
    "cross_feature",
  ],
  matchupGraphEdgeTypes: [
    "includes",
    "enables",
    "requires",
    "amplifies",
    "converts_to",
    "stabilizes",
    "conflicts_with",
    "protects",
    "finishes",
    "pressures",
    "punishes",
    "outraces",
    "denies",
    "mirrors",
    "invalidates",
    "checks",
    "is_soft_to",
  ],
}
