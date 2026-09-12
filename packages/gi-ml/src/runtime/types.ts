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

import type { SlotValue } from "../contracts/index.js"

/** Lightweight observation contract for the ml runtime.
 *  gi-agent's ObservationV1 structurally satisfies this. */
export interface ModelObservationV1 {
  schema_version?: string
  point: {
    decision_point_id: string
    game_id?: string | null
    episode_id?: string | null
    round_number: number
    phase: string
    pending_method: string
    current_turn: number
    action_count_in_round: number
  }
  self: ModelPlayerSnapshotV1
  opponent: ModelPlayerSnapshotV1
  public_state?: {
    self_declared_end: boolean
    opponent_declared_end: boolean
    self_support_count: number
    opponent_support_count: number
    self_summon_count: number
    opponent_summon_count: number
  }
  derived?: Record<string, number>
  hidden_estimate?: unknown
  source?: unknown
}

export interface ModelPlayerSnapshotV1 {
  active_character_index: number | null
  characters: ModelCharacterSnapshotV1[]
  summons: unknown[]
  supports: unknown[]
  combat_statuses: unknown[]
  dice: { total_count: number; omni_count: number; counts_by_type?: Record<string, number> }
  hand: { card_count: number; visible_cards?: unknown[] }
  pile_count: number
  declared_end: boolean
  effect_family_counts?: Record<string, number>
  meta_prior_slots?: Record<string, number>
}

export interface ModelCharacterSnapshotV1 {
  alive: boolean
  health: number
  max_health: number
  energy: number
  max_energy: number
  is_active: boolean
  aura: unknown
  equipment_ids: number[]
  status_ids: number[]
  entities?: Array<{ definition_id: number; variable_name?: string; variable_value?: number }>
  definition_id?: number
  slot_index?: number
  id?: number
}

export interface RuntimeConceptValue {
  concept_id: string
  value_slot?: SlotValue
  confidence?: number | null
  evidence_refs?: string[]
}

export interface RuntimeConceptState {
  query_id?: string | null
  values: RuntimeConceptValue[]
  summary_slots?: SlotValue
}

export interface RuntimeModelManifest {
  artifact_version: string
  concept_bank_version?: string | null
  concept_model_ref?: string | null
  ranker_model_ref?: string | null
  value_model_ref?: string | null
  compatibility?: SlotValue
}
