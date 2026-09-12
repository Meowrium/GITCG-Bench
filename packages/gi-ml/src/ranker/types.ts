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

import type { MlCandidateAction, MlDecisionPoint, SlotValue } from "../contracts/index.js"
import type { RuntimeConceptState } from "../runtime/index.js"

export interface RankRequest {
  query: MlDecisionPoint
  candidates: MlCandidateAction[]
  concept_state?: RuntimeConceptState | null
  rank_slots?: SlotValue
}

export interface RankedAction {
  candidate_id: string
  score: number
  explanation_slots?: SlotValue
}

export interface RankResult {
  query_id: string
  ranked_actions: RankedAction[]
  summary_slots?: SlotValue
}

export interface ActionRanker {
  rank(request: RankRequest): Promise<RankResult>
  rankSync?(request: RankRequest): RankResult
}
