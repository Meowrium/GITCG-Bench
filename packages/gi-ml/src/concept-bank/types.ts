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

import type { MlConceptBank, MlConceptHypothesis } from "../contracts/index.js"

export interface ConceptBankLoadResult {
  bank: MlConceptBank
  source_ref?: string | null
}

export interface ConceptBankRepository {
  load(version: string): Promise<ConceptBankLoadResult | null>
  save(bank: MlConceptBank): Promise<void>
  list_versions(): Promise<string[]>
}

export interface ConceptBankDiffEntry {
  concept_id: string
  before: MlConceptHypothesis | null
  after: MlConceptHypothesis | null
}

export interface ConceptBankDiff {
  from_version: string
  to_version: string
  entries: ConceptBankDiffEntry[]
}
