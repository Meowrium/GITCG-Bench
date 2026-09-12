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

import type { MlCompatibilityInfo, MlSourceKind, SlotValue } from "./common.js"

export type MlConceptScope = "state" | "state_action" | "window" | "aggregate_candidate"

export type MlConceptStatus = "draft" | "validated" | "deprecated"

export interface MlConceptHypothesis {
  concept_id: string
  name: string
  scope: MlConceptScope
  description: string
  evidence_refs: string[]
  tags?: string[]
  estimator_slot?: SlotValue
  validation_slot?: SlotValue
  ranking_slot?: SlotValue
  status: MlConceptStatus
  source?: MlSourceKind | string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface MlConceptAnnotation {
  annotation_id: string
  concept_id: string
  target_ref: string
  label_slot?: SlotValue
  confidence?: number | null
  source?: MlSourceKind | string | null
  annotation_slots?: SlotValue
  created_at?: string | null
}

export interface MlConceptValidationRun {
  validation_run_id: string
  concept_id: string
  input_refs: string[]
  result: "validated" | "rejected" | "hold"
  summary_slots?: SlotValue
  created_at: string
}

export interface MlConceptDeprecationRule {
  concept_id: string
  rule: string
  note?: string | null
}

export interface MlConceptBank {
  bank_version: string
  created_at?: string | null
  compatibility?: MlCompatibilityInfo | null
  concepts: MlConceptHypothesis[]
  validation_summary?: SlotValue
  deprecation_rules?: MlConceptDeprecationRule[]
  metadata?: SlotValue
}
