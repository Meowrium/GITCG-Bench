// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { describe, expect, test } from "vitest"
import { deriveGameSeeds, shardTasks, type Matchup } from "./run-ismcts-self-play.js"

describe("deriveGameSeeds", () => {
  test("worker 0 reproduces the historical sequential seeds", () => {
    // Historical formula in run-ismcts-self-play.ts main():
    //   shuffleSeed = args.seed + g * 101 + mu.id.length
    //   decisionSeedBase = args.seed   (shared across all games per worker)
    const baseSeed = 20260203
    const matchupId = "pyroke-vs-cryohe"
    for (let g = 0; g < 10; g++) {
      const { shuffleSeed, decisionSeedBase, gameId } = deriveGameSeeds(
        baseSeed,
        matchupId,
        g,
        0,
      )
      expect(shuffleSeed).toBe(baseSeed + g * 101 + matchupId.length)
      expect(decisionSeedBase).toBe(baseSeed)
      expect(gameId).toBe(`${matchupId}-${g + 1}-${shuffleSeed}`)
    }
  })

  test("different worker ids produce disjoint shuffle seeds", () => {
    const seeds = new Set<number>()
    for (let w = 0; w < 8; w++) {
      for (let g = 0; g < 20; g++) {
        const { shuffleSeed } = deriveGameSeeds(42, "match-x", g, w)
        seeds.add(shuffleSeed)
      }
    }
    // 8 workers × 20 games = 160 unique seeds expected.
    expect(seeds.size).toBe(8 * 20)
  })

  test("different worker ids produce disjoint decision-seed bases", () => {
    const seeds = new Set<number>()
    for (let w = 0; w < 8; w++) {
      for (let g = 0; g < 20; g++) {
        const { decisionSeedBase } = deriveGameSeeds(42, "match-x", g, w)
        seeds.add(decisionSeedBase)
      }
    }
    // worker 0 collapses to baseSeed for all g, hence 7 * 20 + 1 = 141 expected.
    expect(seeds.size).toBe(7 * 20 + 1)
  })

  test("gameId for worker > 0 carries the worker suffix", () => {
    const { gameId } = deriveGameSeeds(1, "m1", 0, 3)
    expect(gameId.endsWith("-w3")).toBe(true)
  })

  test("derivation is deterministic", () => {
    const a = deriveGameSeeds(123, "m", 5, 2)
    const b = deriveGameSeeds(123, "m", 5, 2)
    expect(a).toEqual(b)
  })
})

describe("shardTasks", () => {
  const matchups: Matchup[] = [
    { id: "a", deck0: "deckA0", deck1: "deckA1", games: 3 },
    { id: "b", deck0: "deckB0", deck1: "deckB1", games: 2 },
  ]

  test("preserves total game count across shards", () => {
    const shards = shardTasks(matchups, 2)
    const total = shards.reduce(
      (sum, s) => sum + s.reduce((mu, m) => mu + m.games, 0),
      0,
    )
    expect(total).toBe(3 + 2)
  })

  test("returns at most workerCount shards", () => {
    const shards = shardTasks(matchups, 4)
    expect(shards.length).toBeLessThanOrEqual(4)
  })

  test("filters out empty shards", () => {
    // Only 2 games for matchup b vs 8 workers → some workers get 0 work.
    const shards = shardTasks(
      [{ id: "tiny", deck0: "d0", deck1: "d1", games: 2 }],
      8,
    )
    expect(shards.every((s) => s.length > 0)).toBe(true)
  })

  test("workerCount = 1 returns the original matchup list", () => {
    const shards = shardTasks(matchups, 1)
    expect(shards.length).toBe(1)
    expect(shards[0]).toHaveLength(matchups.length)
    expect(shards[0]!.reduce((s, m) => s + m.games, 0)).toBe(5)
  })
})
