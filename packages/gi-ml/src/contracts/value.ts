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

import type { MlSourceKind, SlotValue } from "./common.js"

export interface MlValueSample {
  sample_id: string
  source: MlSourceKind | string
  state_ref: string | null
  target_value: number
  weight?: number | null
  context_slots?: SlotValue
  feature_slots?: SlotValue
}

export interface MlValueDataset {
  dataset_id: string
  created_at?: string | null
  metadata?: SlotValue
  samples: MlValueSample[]
}
