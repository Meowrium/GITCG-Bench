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

export function pickRandomIndices(length: number, count: number): number[] {
  const indices = Array.from({ length }, (_, index) => index)
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j]!, indices[i]!]
  }
  return indices.slice(0, Math.max(0, Math.min(length, count)))
}

export function chooseBranchActionIndices(args: {
  rankedIds: readonly string[]
  maxBranches: number
  actualActionIndex?: number | null
}): number[] {
  const selected = new Set<number>()
  for (const id of args.rankedIds) {
    if (selected.size >= args.maxBranches) {
      break
    }
    const parsed = Number(id)
    if (Number.isInteger(parsed) && parsed >= 0) {
      selected.add(parsed)
    }
  }
  if (
    args.actualActionIndex != null &&
    args.actualActionIndex >= 0 &&
    selected.size < Math.max(1, args.maxBranches)
  ) {
    selected.add(args.actualActionIndex)
  }
  return [...selected]
}

export function summarizeWins(
  winners: Array<0 | 1 | null>,
  perspective: 0 | 1,
) {
  const wins = winners.filter((winner) => winner === perspective).length
  const losses = winners.filter((winner) => winner != null && winner !== perspective).length
  const draws = winners.filter((winner) => winner == null).length
  return {
    wins,
    losses,
    draws,
    winRate: winners.length > 0 ? wins / winners.length : 0,
  }
}
