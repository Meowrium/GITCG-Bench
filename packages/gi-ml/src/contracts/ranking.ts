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

import type { MlDeckRefs, MlSourceKind, SlotValue } from "./common.js"

export interface MlDecisionPoint {
  query_id: string
  source: MlSourceKind | string
  state_ref: string | null
  matchup_ref?: string | null
  deck_refs?: MlDeckRefs | null
  candidate_ids: string[]
  evidence_refs: string[]
  context_slots?: SlotValue
}

export interface MlCandidateAction {
  candidate_id: string
  query_id: string
  action_case: string
  action_definition_ref?: string | null
  raw_feature_ref?: string | null
  tree_match_ref?: string | null
  branch_eval_ref?: string | null
  runtime_slots?: SlotValue
}

export interface MlPairwisePreference {
  query_id: string
  candidate_a_id: string
  candidate_b_id: string
  preference_label: number
  confidence?: number | null
  evidence_ref?: string | null
  preference_slots?: SlotValue
}

export interface MlRankingQueryGroup {
  query_id: string
  source?: MlSourceKind | string | null
  state_ref?: string | null
  context_slots?: SlotValue
  candidates: MlCandidateAction[]
  pairwise_preferences?: MlPairwisePreference[]
}

export interface MlRankingDataset {
  dataset_id: string
  created_at?: string | null
  metadata?: SlotValue
  query_groups: MlRankingQueryGroup[]
}
