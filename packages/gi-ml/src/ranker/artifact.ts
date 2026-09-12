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

import type { MlCompatibilityInfo, SlotValue } from "../contracts/index.js"

export type RankerArtifactType = "slot_linear_ranker.v1"

export interface SlotLinearWeightMap {
  [key: string]: number
}

export interface ConceptNumericWeight {
  concept_id: string
  path: string
  weight: number
}

export interface SlotLinearRankerConfig {
  action_case_bias?: SlotLinearWeightMap
  candidate_tag_bias?: SlotLinearWeightMap
  candidate_numeric_slot_weights?: SlotLinearWeightMap
  query_numeric_slot_weights?: SlotLinearWeightMap
  concept_presence_weights?: SlotLinearWeightMap
  concept_numeric_slot_weights?: ConceptNumericWeight[]
  metadata?: SlotValue
}

export interface SlotLinearRankerArtifact {
  artifact_type: RankerArtifactType
  artifact_version: string
  created_at: string
  compatibility?: MlCompatibilityInfo | null
  config: SlotLinearRankerConfig
}
