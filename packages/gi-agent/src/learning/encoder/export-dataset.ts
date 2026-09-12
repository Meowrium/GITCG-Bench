// Copyright (C) 2026 Piovium Labs
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

/**
 * V30 Stage 3 — Encoder dataset NDJSON exporter.
 *
 * Reads (state_observation, label, weight, ...) tuples from a DataLake and
 * writes them as `StateObservationRecord` NDJSON to disk for the PyTorch
 * trainer in `gi-ml/python`. Supports a basic 80/20 train/test split keyed
 * on game_id (no leakage).
 */

import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DataLake } from "../../db/data-lake.js"
import type { StateObservationRecord } from "./state-observation.js"

export interface ExportEncoderDatasetOptions {
  dbPath: string
  outDir: string
  /** Holdout fraction in (0, 1). 0 disables holdout split. Default 0.2. */
  testFraction?: number
  /** Hash seed (mod 100) used for splitting; identical seeds reproduce the split. */
  splitSeed?: number
  /** Optional cap on samples emitted (random truncation kept by sample order). */
  maxSamples?: number
  /** Print progress to stderr. */
  verbose?: boolean
  /**
   * V30 Stage 3 — Recompute sample weights at export time using the
   * Genius-Invokation-aware schedule (credit decay + R1 penalty + role
   * factor). Useful when the DataLake was collected with the legacy
   * `earlyBonus` formula and you don't want to re-run self-play.
   *
   * `none`    : keep DataLake row.weight (default)
   * `gi-v30`  : weight = clamp(exp(-(1 - turn/maxTurn)*1.5)
   *                            * (round===1 ? 0.6 : 1.0)
   *                            * (winner ? 1.0 : 0.8), 0.2, 1.5)
   *             where winner is inferred from row.label.
   */
  reweight?: "none" | "gi-v30"
  /**
   * V31 F6 / D7 — upgrade legacy schema-v2 samples to v3 in-flight by
   * inferring `is_first_player` from the order in which samples were inserted
   * into the DataLake. Self-play runs the engine single-threaded and the IO
   * write path appends rows in decision order, so the row with the smallest
   * `id` per `game_id` is by construction the very first action of the game
   * (perspective = `player` column on that row = the coin-flip winner).
   *
   * This lets us rescue D3/D5/D6's ~153k schema-v2 captures (base 59k + cross
   * 94k) for D8 training instead of re-running self-play. Records with v3
   * already set are passed through. Records older than v2 (missing
   * active_element / immune_remaining) are still rejected by the trainer.
   *
   * `false` (default) preserves the legacy behaviour: v2 rows export
   * unmodified and the Python trainer's `validate_schema_version` will reject
   * them — which is what you want when you intentionally collected v3-only
   * data and don't want the upgrade path to mask schema drift.
   */
  upgradeV2ToV3?: boolean
  /**
   * V31 F9 — upgrade legacy schema-v3 samples to v4 in-flight by filling
   * `skill_fingerprint` with zeros on every character. This lets old samples
   * train alongside new v4 data (CSF dims will be zero = neutral prior).
   *
   * When upgrading v2→v3 is also enabled, the pipeline applies v3 upgrade
   * first, then zeroes out CSF (if not already present). This keeps the
   * three-step v2→v3→v4 chain composable.
   */
  upgradeV3ToV4?: boolean
}

export interface ExportEncoderDatasetResult {
  trainCount: number
  testCount: number
  totalSeen: number
  trainPath: string
  testPath?: string
  metaPath: string
  uniqueGames: number
  reweight?: string
  /** V31 D7 — number of rows whose schema_version was patched from v2 → v3. */
  upgradedV2ToV3?: number
  /** V31 F9 — number of rows whose schema_version was patched from v3 → v4. */
  upgradedV3ToV4?: number
}

/** Stable djb2-style hash → [0, 100) bucket. */
function bucket(s: string, seed: number): number {
  let h = 5381 ^ (seed | 0)
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return (h >>> 0) % 100
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function exportEncoderDataset(
  opts: ExportEncoderDatasetOptions,
): ExportEncoderDatasetResult {
  const testFraction = opts.testFraction ?? 0.2
  const splitSeed = opts.splitSeed ?? 17
  const reweight = opts.reweight ?? "none"
  const upgradeV2ToV3 = opts.upgradeV2ToV3 ?? false
  const upgradeV3ToV4 = opts.upgradeV3ToV4 ?? false
  const outDir = resolve(opts.outDir)
  mkdirSync(outDir, { recursive: true })

  const lake = new DataLake(opts.dbPath)
  const all = lake.loadStateObservations()
  lake.close()

  const cap = opts.maxSamples && opts.maxSamples > 0 ? opts.maxSamples : all.length
  const limited = cap < all.length ? all.slice(0, cap) : all

  // V31 D7 — infer the coin-flip first-mover per game from insertion order.
  // `loadStateObservations()` returns rows ORDER BY id, so the first row of
  // each `gameId` is by construction the engine's first decision and its
  // `player` field equals `state.currentTurn` at round 1 — exactly what the
  // live `FirstPlayerLatch` would have latched. This rescues legacy schema-v2
  // captures (no `is_first_player` field) without re-running self-play.
  const firstPlayerByGame = new Map<string, 0 | 1>()
  if (upgradeV2ToV3) {
    for (const row of limited) {
      if (!firstPlayerByGame.has(row.gameId)) {
        firstPlayerByGame.set(row.gameId, row.player)
      }
    }
  }
  // V31 D8b — per-`(gameId, perspective)` ply counter, derived from ROWID order
  // (same `ORDER BY id` guarantee as the first-mover inference). This patches
  // `observation.meta.sample_index` so the Python trainer's per-trajectory
  // grouping (TD(λ) target, online-TD successor index, mirror pair index)
  // works on ISMCTS self-play data, which previously hard-coded
  // `meta.sample_index = 0` and `meta.game_id = "ismcts"` (see §F6.D8b).
  // We also patch `meta.game_id` to the real sqlite-column game id so all
  // three groupings see the correct trajectory boundaries.
  const plyCounters = new Map<string, number>()
  const sampleIndexByRow = new Map<number, number>() // index in `limited` -> ply
  if (upgradeV2ToV3) {
    for (let i = 0; i < limited.length; i++) {
      const row = limited[i]
      const key = `${row.gameId}\u0001${row.player}`
      const next = (plyCounters.get(key) ?? 0)
      plyCounters.set(key, next + 1)
      sampleIndexByRow.set(i, next)
    }
  }

  // Pre-compute per-game maxTurn for credit decay if reweight enabled.
  const maxTurnByGame = new Map<string, number>()
  if (reweight === "gi-v30") {
    for (const row of limited) {
      const cur = maxTurnByGame.get(row.gameId) ?? 0
      if (row.turn > cur) maxTurnByGame.set(row.gameId, row.turn)
    }
  }

  const trainPath = resolve(outDir, "train.ndjson")
  const testPath = testFraction > 0 ? resolve(outDir, "test.ndjson") : undefined
  const metaPath = resolve(outDir, "meta.json")

  mkdirSync(dirname(trainPath), { recursive: true })
  const trainFd = openSync(trainPath, "w")
  const testFd = testPath ? openSync(testPath, "w") : -1

  let trainCount = 0
  let testCount = 0
  let upgradedCount = 0
  let upgradedV3ToV4Count = 0
  const games = new Set<string>()
  const cutoff = Math.round(testFraction * 100)

  for (let idxInLimited = 0; idxInLimited < limited.length; idxInLimited++) {
    const row = limited[idxInLimited]
    games.add(row.gameId)
    let weight = row.weight
    if (reweight === "gi-v30") {
      const maxTurn = maxTurnByGame.get(row.gameId) ?? 1
      const distFromEnd = maxTurn > 0 ? Math.max(0, 1 - row.turn / maxTurn) : 0
      const credit = Math.exp(-distFromEnd * 1.5)
      const r1Penalty = row.round === 1 ? 0.6 : 1.0
      const roleFactor = row.label >= 0.5 ? 1.0 : 0.8
      weight = clamp(credit * r1Penalty * roleFactor, 0.2, 1.5)
    }
    let observation = row.observation
    // V31 D7 — schema upgrade: patch is_first_player into v2 captures using
    // the insertion-order-derived first-mover. The observation object is a
    // fresh `JSON.parse` per row (see `loadStateObservations`), so in-place
    // mutation is safe — no shared structure.
    let currentVersion = observation.meta.schema_version as number
    if (upgradeV2ToV3 && currentVersion === 2) {
      const firstPlayer = firstPlayerByGame.get(row.gameId)
      if (firstPlayer !== undefined) {
        const selfIsFirst = row.player === firstPlayer
        observation.self.is_first_player = selfIsFirst
        observation.opponent.is_first_player = !selfIsFirst
        observation.meta.schema_version = 3 as typeof observation.meta.schema_version
        currentVersion = 3
        upgradedCount++
      }
    }
    // V31 F9 — upgrade v3→v4: zero-fill missing skill_fingerprint on each character.
    if (upgradeV3ToV4 && currentVersion <= 3) {
      for (const side of [observation.self, observation.opponent]) {
        for (const c of side.characters) {
          if (!c.skill_fingerprint) {
            c.skill_fingerprint = []
          }
        }
      }
      if (currentVersion === 3) {
        observation.meta.schema_version = 4 as typeof observation.meta.schema_version
        upgradedV3ToV4Count++
      }
    }
    // V31 D8b — patch corrupted ISMCTS-self-play meta.game_id / sample_index.
    // run-ismcts-self-play.ts before §F6.D8b hard-coded these to "ismcts" / 0,
    // collapsing all self-play samples into a single fake trajectory and
    // silently breaking the trainer's per-trajectory grouping. Recover the
    // real values from the sqlite columns (`row.gameId` is the matchup id +
    // ordinal + shuffle seed, written correctly by the CLI) and the ROWID
    // order (per-`(game, perspective)` index = ply within trajectory).
    if (upgradeV2ToV3 && observation.meta.game_id === "ismcts") {
      observation.meta.game_id = row.gameId
      const ply = sampleIndexByRow.get(idxInLimited) ?? 0
      observation.meta.sample_index = ply
    }
    const record: StateObservationRecord = {
      observation,
      label: row.label,
      weight,
    }
    // V31 F6 / D3: surface the search policy target (pi_MCTS) at the record
    // top level so the trainer can read it without descending into the
    // observation. `observation.policy_target` is already carried through the
    // JSON column; copying it keeps the NDJSON contract self-describing.
    if (Array.isArray(row.observation.policy_target)) {
      record.policy_target = row.observation.policy_target
    }
    const line = `${JSON.stringify(record)}\n`
    if (testFd >= 0 && bucket(row.gameId, splitSeed) < cutoff) {
      writeSync(testFd, line)
      testCount++
    } else {
      writeSync(trainFd, line)
      trainCount++
    }
  }
  closeSync(trainFd)
  if (testFd >= 0) closeSync(testFd)

  const meta = {
    schema_version: 1,
    db_path: resolve(opts.dbPath),
    train_count: trainCount,
    test_count: testCount,
    test_fraction_target: testFraction,
    split_seed: splitSeed,
    unique_games: games.size,
    reweight,
    upgrade_v2_to_v3: upgradeV2ToV3,
    upgraded_rows: upgradedCount,
    upgrade_v3_to_v4: upgradeV3ToV4,
    upgraded_v3_to_v4_rows: upgradedV3ToV4Count,
    timestamp: new Date().toISOString(),
  }
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8")

  if (opts.verbose) {
    const upgradeStr = upgradeV2ToV3 ? ` v2→v3=${upgradedCount}` : ""
    const upgradeV4Str = upgradeV3ToV4 ? ` v3→v4=${upgradedV3ToV4Count}` : ""
    console.error(
      `[encoder-export] train=${trainCount} test=${testCount} games=${games.size} reweight=${reweight}${upgradeStr}${upgradeV4Str} → ${outDir}`,
    )
  }

  return {
    trainCount,
    testCount,
    totalSeen: limited.length,
    trainPath,
    ...(testPath ? { testPath } : {}),
    metaPath,
    uniqueGames: games.size,
    reweight,
    upgradedV2ToV3: upgradedCount,
    upgradedV3ToV4: upgradedV3ToV4Count,
  }
}
