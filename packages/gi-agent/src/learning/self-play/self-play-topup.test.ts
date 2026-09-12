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

import { expect, test } from "vitest"
import { buildSelfPlayTopupPlan } from "./self-play-topup.js"

test("buildSelfPlayTopupPlan estimates extra games from skipped-heavy matchup", () => {
  const plan = buildSelfPlayTopupPlan({
    benchmarkConfig: {
      version: "v6.3.0",
      matchups: [
        {
          id: "stable",
          deck0: "A",
          deck1: "B",
          games: 10,
          sideA: { name: "a", kind: "baseline" },
          sideB: { name: "b", kind: "baseline" },
        },
        {
          id: "skipped-heavy",
          deck0: "C",
          deck1: "D",
          games: 10,
          sideA: { name: "a", kind: "baseline" },
          sideB: { name: "b", kind: "baseline" },
        },
      ],
    },
    result: {
      totalGames: 20,
      insertedSamples: 250,
      skippedSamples: 200,
      matchups: [
        {
          matchupId: "stable",
          games: 10,
          insertedSamples: 200,
          skippedSamples: 0,
        },
        {
          matchupId: "skipped-heavy",
          games: 10,
          insertedSamples: 50,
          skippedSamples: 200,
        },
      ],
    },
  })

  expect(plan.strategy.resolvedTargetInsertedPerGame).toBe(20)
  expect(plan.totalExtraGames).toBe(30)
  expect(plan.matchups).toEqual([
    expect.objectContaining({
      matchupId: "skipped-heavy",
      targetInsertedSamples: 200,
      estimatedExtraGames: 30,
    }),
  ])
  expect(plan.benchmarkConfig.matchups).toEqual([
    expect.objectContaining({
      id: "skipped-heavy",
      games: 30,
    }),
  ])
})

test("buildSelfPlayTopupPlan ignores healthy matchup even if inserted is lower", () => {
  const plan = buildSelfPlayTopupPlan({
    benchmarkConfig: {
      matchups: [
        {
          id: "healthy-low",
          deck0: "A",
          deck1: "B",
          games: 10,
          sideA: { name: "a", kind: "baseline" },
          sideB: { name: "b", kind: "baseline" },
        },
      ],
    },
    result: {
      totalGames: 10,
      insertedSamples: 80,
      skippedSamples: 2,
      matchups: [
        {
          matchupId: "healthy-low",
          games: 10,
          insertedSamples: 80,
          skippedSamples: 2,
        },
      ],
    },
    strategy: {
      minSkippedSamples: 10,
    },
  })

  expect(plan.matchups).toEqual([])
  expect(plan.totalExtraGames).toBe(0)
})
