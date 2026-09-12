// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D7 — coverage for the schema-v2 → v3 in-flight upgrade path that
 * lets us reuse pre-D7 captures by inferring `is_first_player` from the
 * insertion order of `(gameId, player)` rows.
 */

import { describe, expect, it, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DataLake, type SampleRecord } from "../../db/data-lake.js"
import type { StateObservation } from "./state-observation.js"
import { exportEncoderDataset } from "./export-dataset.js"

function makeV2Observation(side: 0 | 1, gameId: string): StateObservation {
  return {
    meta: {
      schema_version: 2 as unknown as 4,
      game_id: gameId,
      sample_index: 0,
      perspective: side,
      round: 1,
      turn: 1,
      phase: "action",
      opponent_declared_end: false,
    },
    self: {
      side,
      declared_end: false,
      legend_used: false,
      characters: [],
      summons: [],
      supports: [],
      combat_statuses: [],
      hand: [],
      hand_size: 0,
      pile_size: 0,
      dice_counts: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      active_definition_id: 0,
      active_element: 0,
      // is_first_player intentionally absent (legacy v2).
    } as unknown as StateObservation["self"],
    opponent: {
      side: (1 - side) as 0 | 1,
      declared_end: false,
      legend_used: false,
      characters: [],
      summons: [],
      supports: [],
      combat_statuses: [],
      hand: [],
      hand_size: 0,
      pile_size: 0,
      dice_counts: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      active_definition_id: 0,
      active_element: 0,
    } as unknown as StateObservation["opponent"],
    candidate_actions: [],
    selected_action_index: 0,
  }
}

function makeRecord(gameId: string, player: 0 | 1, label: number): SampleRecord {
  return {
    gameId,
    round: 1,
    turn: 1,
    player,
    actionCase: "useSkill",
    features: [],
    stateObservation: makeV2Observation(player, gameId),
    label,
    source: "self_play",
    weight: 1.0,
  }
}

describe("exportEncoderDataset — V31 D7 schema-v2 → v3 upgrade", () => {
  let dir: string
  let dbPath: string

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  function ndjson(p: string) {
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  it("infers first-mover from insertion order and patches is_first_player", () => {
    dir = mkdtempSync(join(tmpdir(), "v31-d7-export-"))
    dbPath = join(dir, "samples.sqlite")
    const lake = new DataLake(dbPath)
    // gameA: side 0 plays first → side 0 is the first-mover.
    lake.insertBatch([
      makeRecord("gameA", 0, 1),
      makeRecord("gameA", 1, 0),
      makeRecord("gameA", 0, 1),
    ])
    // gameB: side 1 plays first → side 1 is the first-mover.
    lake.insertBatch([
      makeRecord("gameB", 1, 1),
      makeRecord("gameB", 0, 0),
    ])
    lake.close()

    const out = exportEncoderDataset({
      dbPath,
      outDir: join(dir, "ds"),
      testFraction: 0,
      upgradeV2ToV3: true,
    })
    expect(out.upgradedV2ToV3).toBe(5)
    const rows = ndjson(out.trainPath) as Array<{ observation: StateObservation }>
    expect(rows).toHaveLength(5)
    // every emitted row is schema v3 and has the flag set
    for (const r of rows) {
      expect(r.observation.meta.schema_version).toBe(3)
      expect(typeof r.observation.self.is_first_player).toBe("boolean")
      expect(typeof r.observation.opponent.is_first_player).toBe("boolean")
      // self and opp flags must be mutually exclusive
      expect(r.observation.self.is_first_player).not.toBe(
        r.observation.opponent.is_first_player,
      )
    }
    // gameA: first row is side 0 → side-0 perspective rows MUST have self.is_first=true
    const a0 = rows.filter(
      (r) => r.observation.meta.game_id === "gameA" && r.observation.meta.perspective === 0,
    )
    expect(a0.length).toBeGreaterThan(0)
    for (const r of a0) expect(r.observation.self.is_first_player).toBe(true)
    const a1 = rows.filter(
      (r) => r.observation.meta.game_id === "gameA" && r.observation.meta.perspective === 1,
    )
    for (const r of a1) expect(r.observation.self.is_first_player).toBe(false)
    // gameB: first row is side 1 → side-1 perspective rows MUST have self.is_first=true
    const b1 = rows.filter(
      (r) => r.observation.meta.game_id === "gameB" && r.observation.meta.perspective === 1,
    )
    expect(b1.length).toBeGreaterThan(0)
    for (const r of b1) expect(r.observation.self.is_first_player).toBe(true)
    const b0 = rows.filter(
      (r) => r.observation.meta.game_id === "gameB" && r.observation.meta.perspective === 0,
    )
    for (const r of b0) expect(r.observation.self.is_first_player).toBe(false)
  })

  it("leaves rows alone (and reports zero upgrades) when --upgrade-v2-to-v3 is off", () => {
    dir = mkdtempSync(join(tmpdir(), "v31-d7-noupgrade-"))
    dbPath = join(dir, "samples.sqlite")
    const lake = new DataLake(dbPath)
    lake.insertBatch([makeRecord("g", 0, 1), makeRecord("g", 1, 0)])
    lake.close()

    const out = exportEncoderDataset({
      dbPath,
      outDir: join(dir, "ds"),
      testFraction: 0,
      upgradeV2ToV3: false,
    })
    expect(out.upgradedV2ToV3).toBe(0)
    const rows = ndjson(out.trainPath) as Array<{ observation: StateObservation }>
    for (const r of rows) {
      expect(r.observation.meta.schema_version).toBe(2)
      expect((r.observation.self as { is_first_player?: boolean }).is_first_player).toBeUndefined()
    }
  })

  // V31 D8b — pre-fix ISMCTS self-play sealed `meta.game_id = "ismcts"` and
  // `meta.sample_index = 0` into every observation, collapsing trajectories.
  // The upgrade path now recovers the real game_id (sqlite gameId column) and
  // a per-(game, perspective) ply count from ROWID order.
  it("patches meta.game_id == 'ismcts' to the real sqlite gameId and rebuilds sample_index", () => {
    dir = mkdtempSync(join(tmpdir(), "v31-d8b-fix-"))
    dbPath = join(dir, "samples.sqlite")
    const lake = new DataLake(dbPath)
    // Two distinct real games, both with broken `observation.meta.game_id = "ismcts"`
    // and `sample_index = 0`. The exporter must rewrite them.
    const brokenObs = (gameId: string, side: 0 | 1): StateObservation => {
      const o = makeV2Observation(side, "ismcts") // wrong meta.game_id like pre-D8b
      o.meta.sample_index = 0 // wrong sample_index too
      return o
    }
    const brokenRec = (gameId: string, player: 0 | 1, label: number): SampleRecord => ({
      gameId,
      round: 1,
      turn: 1,
      player,
      actionCase: "useSkill",
      features: [],
      stateObservation: brokenObs(gameId, player),
      label,
      source: "self_play",
      weight: 1.0,
    })
    // gameA: side 0 (first) two plies, side 1 (second) two plies, interleaved.
    lake.insertBatch([
      brokenRec("gameA", 0, 1),
      brokenRec("gameA", 1, 0),
      brokenRec("gameA", 0, 1),
      brokenRec("gameA", 1, 0),
    ])
    // gameB: side 1 first, side 0 second.
    lake.insertBatch([
      brokenRec("gameB", 1, 1),
      brokenRec("gameB", 0, 0),
    ])
    lake.close()

    const out = exportEncoderDataset({
      dbPath,
      outDir: join(dir, "ds"),
      testFraction: 0,
      upgradeV2ToV3: true,
    })
    expect(out.upgradedV2ToV3).toBe(6)
    const rows = ndjson(out.trainPath) as Array<{ observation: StateObservation }>
    expect(rows).toHaveLength(6)
    // meta.game_id must be the sqlite gameId (no more "ismcts" placeholder)
    for (const r of rows) {
      expect(r.observation.meta.game_id).not.toBe("ismcts")
      expect(["gameA", "gameB"]).toContain(r.observation.meta.game_id)
    }
    // sample_index must increase per (game_id, perspective). Group + verify.
    const groups = new Map<string, number[]>()
    for (const r of rows) {
      const key = `${r.observation.meta.game_id}|${r.observation.meta.perspective}`
      groups.set(key, [...(groups.get(key) ?? []), r.observation.meta.sample_index])
    }
    // gameA side 0: 2 samples → [0, 1]; gameA side 1: 2 → [0, 1]; gameB side 1: 1 → [0]; gameB side 0: 1 → [0].
    expect(groups.get("gameA|0")).toEqual([0, 1])
    expect(groups.get("gameA|1")).toEqual([0, 1])
    expect(groups.get("gameB|1")).toEqual([0])
    expect(groups.get("gameB|0")).toEqual([0])
  })
})
