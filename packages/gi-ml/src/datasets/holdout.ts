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

export type DatasetSubsetKind = "all" | "train" | "holdout"

export interface DatasetHoldoutOptions {
  subset?: DatasetSubsetKind
  holdoutFraction?: number
  holdoutSeed?: string
}

export const DEFAULT_HOLDOUT_SEED = "rl_formal_holdout_v1"

export function shouldIncludeDatasetKey(
  key: string,
  options: DatasetHoldoutOptions = {},
): boolean {
  const subset = options.subset ?? "all"
  const holdoutFraction = normalizeHoldoutFraction(options.holdoutFraction)
  if (subset === "all") {
    return true
  }
  if (holdoutFraction <= 0) {
    return subset === "train"
  }

  const heldout = stableUnitInterval(`${options.holdoutSeed ?? DEFAULT_HOLDOUT_SEED}::${key}`)
    < holdoutFraction
  return subset === "holdout" ? heldout : !heldout
}

function normalizeHoldoutFraction(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null) {
    return 0
  }
  return Math.min(Math.max(value, 0), 1)
}

function stableUnitInterval(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0x1_0000_0000
}
