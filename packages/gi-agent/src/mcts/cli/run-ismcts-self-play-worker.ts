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
 * V31 F6 / D3 P0 — ISMCTS self-play worker entrypoint.
 *
 * Spawned by `run-ismcts-self-play.ts` when `--concurrency > 1`. Each worker
 * owns its own `@gi-tcg/data`, `V30NeuralPredictor`, and `DataLake` instances
 * (SQLite WAL mode serialises concurrent writers).
 *
 * Determinism: every (workerId, matchupId, gameOrdinal) triple maps to a
 * unique (shuffleSeed, decisionSeedBase) pair via `deriveGameSeeds`, so the
 * generated samples are reproducible given the same `cfg.seed`.
 *
 * See `docs/ismcts-selfplay-perf-optimizations.md` §方案一.
 */

import { parentPort, workerData } from "node:worker_threads"
import { resolve } from "node:path"
import { CURRENT_VERSION, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DataLake } from "../../db/data-lake.js"
import { V30NeuralPredictor } from "../../learning/encoder/neural-predictor.js"
import {
  deriveGameSeeds,
  playAndRecord,
  type SelfPlayConfig,
} from "./run-ismcts-self-play.js"

/**
 * A matchup pre-decoded by the main process. Deck codes are decoded in the
 * main process (which has `@gi-tcg/assets-manager` reachable through the
 * `gnx` tsx loader); workers receive plain `DeckConfig` JSON via structured
 * clone — these are pure data objects (`{characters: number[], cards:
 * number[]}`) and cross the worker boundary safely.
 *
 * Doing the decode in the worker would require `@gi-tcg/assets-manager`
 * which lives in a sibling package without an explicit workspace dep, and
 * Node's ESM resolver (which spawned worker threads use directly without
 * the tsx loader propagating in all cases) cannot resolve its relative
 * extensionless import.
 */
interface DecodedMatchup {
  id: string
  deck0: DeckConfig
  deck1: DeckConfig
  games: number
}

interface WorkerInput {
  weightsPath: string
  dbPath: string
  matchups: DecodedMatchup[]
  cfg: SelfPlayConfig
  workerId: number
}

interface WorkerResult {
  totalGames: number
  totalInserted: number
  p0Wins: number
}

async function main(): Promise<WorkerResult> {
  const input = workerData as WorkerInput
  const data = getData(CURRENT_VERSION)
  const predictor = V30NeuralPredictor.fromFile(resolve(input.weightsPath))
  const lake = input.dbPath ? new DataLake(resolve(input.dbPath)) : null

  let totalGames = 0
  let totalInserted = 0
  let p0Wins = 0
  try {
    for (const mu of input.matchups) {
      for (let g = 0; g < mu.games; g++) {
        const { shuffleSeed, decisionSeedBase, gameId } = deriveGameSeeds(
          input.cfg.seed,
          mu.id,
          g,
          input.workerId,
        )
        const { winner, inserted } = await playAndRecord(
          data,
          mu.deck0,
          mu.deck1,
          predictor,
          input.cfg,
          shuffleSeed,
          gameId,
          lake,
          decisionSeedBase,
        )
        totalGames++
        totalInserted += inserted
        if (winner === 0) p0Wins++
      }
    }
  } finally {
    lake?.close()
  }
  return { totalGames, totalInserted, p0Wins }
}

main()
  .then((result) => parentPort?.postMessage(result))
  .catch((err) => {
    // Surface the error to the parent and exit non-zero so `runParallel`
    // rejects the corresponding Promise.
    console.error("[ismcts-self-play-worker] fatal:", err)
    process.exit(1)
  })
