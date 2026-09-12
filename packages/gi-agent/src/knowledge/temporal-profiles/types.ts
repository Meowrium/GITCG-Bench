// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * Temporal card profile types.
 *
 * These describe the strategic timing characteristics of a card —
 * when it pays off, what it needs, and what it costs in terms of
 * board slots and action economy.
 */

export type OptionKind =
  | "deferred_bank"       // e.g. Liben: stores dice now, cashes later
  | "recurring_engine"    // e.g. Paimon: generates value each action phase
  | "conditional_engine"  // e.g. Timaeus: requires specific card tags
  | "converter"           // e.g. food/heal: immediate conversion
  | "burst_enabler"       // e.g. energy gain / fast switch
  | "defense"             // e.g. shield / heal / damage reduction
  | "generic_setup"

export type TriggerWindow =
  | "on_play"
  | "action_phase"
  | "end_phase"
  | "round_start"
  | "round_end"
  | "reactive"

export interface TemporalPrerequisite {
  kind: "card_tag" | "variable_at_least" | "dice_cost_at_least" | "skill_type"
  value: string
}

export interface TemporalPayoffVector {
  draw?: number
  generate_dice_omni?: number
  generate_dice_elemental?: number
  generate_dice_random?: number
  damage?: number
  heal?: number
  energy_gain?: number
  cost_reduction?: number
  cost_reduction_all?: boolean
  cost_reduction_tag?: string
  self_dispose?: boolean
}

export interface TemporalFootprint {
  support_slot: boolean
  dice_cost_average: number
  usage_limit: number | null
  usage_per_round: number | null
  max_uses_per_game: number | null
}

export interface TemporalLifecycle {
  /** Round when this option is best deployed */
  ideal_deploy_round: { min: number; max: number }
  /** Estimated number of rounds before payoff */
  payoff_delay: number
  /** Whether payoff recurs (per round) or is one-shot */
  payoff_recurrence: "once" | "per_round" | "per_condition"
}

export type ProfileConfidence =
  | "exact"
  | "source_parsed"
  | "sim_inferred"
  | "heuristic"

export interface TemporalCardProfile {
  definitionId: number
  name: string
  optionKind: OptionKind
  triggerWindows: TriggerWindow[]
  prerequisites: TemporalPrerequisite[]
  payoff: TemporalPayoffVector
  footprint: TemporalFootprint
  lifecycle: TemporalLifecycle
  confidence: ProfileConfidence
  source: string
}
