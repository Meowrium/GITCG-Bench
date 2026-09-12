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

export type MlSourceKind =
  | "branch_eval"
  | "combat_window"
  | "self_play"
  | "replay"
  | "runtime"
  | "static_effect_seed"
  | "human_critic"
  | "unknown"

export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export type SlotValue = Record<string, JsonValue> | null

export interface MlCompatibilityInfo {
  gi_agent_min_version?: string | null
  runtime_digest_version?: string | null
  feature_version?: string | null
  ruleset_version?: string | null
}

export interface MlDeckRefs {
  self_deck_ref: string | null
  opponent_deck_ref: string | null
}
