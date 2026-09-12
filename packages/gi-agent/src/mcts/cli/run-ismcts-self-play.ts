// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D3 — AlphaZero-style ISMCTS self-play collector.
 *
 * Plays real games (decoded benchmark decks) where *both* sides pick actions
 * via `ismctsSearch` driven by the *current-generation* encoder (V(s) leaf +
 * Q prior + same-evaluator opponent). At every decision point it records a
 * `(StateObservation, pi_MCTS, z)` training tuple:
 *
 *   - `StateObservation`  — the redacted public view (no hidden info leak),
 *     built from `exposeState` + the engine's legal action slate. Same layout
 *     the encoder trains on (schema v2).
 *   - `pi_MCTS`           — the search policy = normalised mean visit counts
 *     over the candidate slate, stored in `observation.policy_target`. The
 *     trainer distils the encoder's Q-softmax against this target (V30 §7), so
 *     each generation absorbs the search's improvement (the flywheel engine).
 *   - `z`                — terminal outcome (1 = this perspective won, else 0),
 *     written as the sample `label`.
 *
 * Action selection during self-play samples from pi_MCTS with temperature tau
 * for the first `--explore-moves` plies (diversifies trajectories), then plays
 * greedily — the standard AlphaZero exploration schedule. The *recorded*
 * target is always the full pi_MCTS regardless of which action was sampled.
 *
 * Samples are written to a DataLake (`--db`), ready for
 * `encoder/export-dataset` -> `train_v30_encoder` (gen N+1).
 *
 * Usage:
 *   gnx src/mcts/cli/run-ismcts-self-play.ts <encoder-weights.json> \
 *       --db D:/gitcg-data/v31-f6-d3/samples.sqlite \
 *       [--games N] [-k K] [-n M] [--time-budget MS] [--seed S] \
 *       [--explore-moves P] [--temperature T] [--matchups a,b,...] \
 *       [--concurrency N]
 *
 * Parallelism (D3 P0, see docs/ismcts-selfplay-perf-optimizations.md):
 *   `--concurrency N` (default 1) spawns N worker_threads. Each worker
 *   owns its own predictor + DataLake; SQLite WAL serialises writers.
 *   Per-game seeds are deterministically derived from `(workerId,
 *   gameOrdinal, matchupId)` via `deriveGameSeeds` so the resulting
 *   samples are reproducible regardless of N. `N = 1` reproduces the
 *   historical single-process loop bit-for-bit. The runner auto-downgrades
 *   to sequential when `totalGames / N < 5` (cold-start dominates).
 */

import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { ActionValidity, type DiceType } from "@gi-tcg/typings"
import { chooseDice } from "@gi-tcg/utils"
import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { resolve } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index"
import { DataLake, type SampleRecord } from "../../db/data-lake.js"
import { V30NeuralPredictor } from "../../learning/encoder/neural-predictor.js"
import { ismctsSearch, type IsmctsResult } from "../ismcts.js"
import {
  createNeuralLeafEvaluator,
  createNeuralPrior,
  createSameEvaluatorOpponent,
  FirstPlayerLatch,
  observationFromState,
} from "../neural-leaf.js"
import { legalActions } from "../engine-step.js"
import type { LeafEvaluator, ActionPriorFn } from "../ismcts.js"
import type { DecideActionFn } from "../engine-step.js"
import type { StateObservation } from "../../learning/encoder/state-observation.js"
import {
  sampleFromVisits,
  visitsToPolicy,
  makeSelfPlayRng,
} from "./self-play-sampling.js"

export interface Matchup {
  id: string
  deck0: string
  deck1: string
  games: number
}

export interface SelfPlayConfig {
  determinizations: number
  simulations: number
  timeBudgetMs: number
  roundActionBudget: number
  exploreMoves: number
  temperature: number
  seed: number
}

function parseArgs(argv: string[]) {
  // `--time-budget 500` is the V31 F6 self-play production budget. After
  // the F8 sampling-perf patch (`legal-actions-cache.ts` C1/C3, see
  // docs/v31-theory-alignment-fixes.md §11), the same budget yields a
  // stronger ISMCTS player; the resulting samples are slightly higher
  // quality but schema-compatible with pre-F8 data. To strictly reproduce
  // pre-F8 sampling distributions, pass `--time-budget 300`.
  let games = 0
  let determinizations = 8
  let simulations = 64
  let timeBudgetMs = 500
  let seed = 20260203
  let roundActionBudget = 2
  let exploreMoves = 6
  let temperature = 1.0
  let matchupFilter: string[] | null = null
  let dbPath = ""
  let configPath = ""
  let concurrency = 1
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--games") games = Number(argv[++i])
    else if (a === "--determinizations" || a === "-k") determinizations = Number(argv[++i])
    else if (a === "--simulations" || a === "-n") simulations = Number(argv[++i])
    else if (a === "--time-budget") timeBudgetMs = Number(argv[++i])
    else if (a === "--seed") seed = Number(argv[++i])
    else if (a === "--round-budget") roundActionBudget = Number(argv[++i])
    else if (a === "--explore-moves") exploreMoves = Number(argv[++i])
    else if (a === "--temperature") temperature = Number(argv[++i])
    else if (a === "--db") dbPath = argv[++i]
    else if (a === "--config") configPath = argv[++i]
    else if (a === "--concurrency") concurrency = Math.max(1, Number(argv[++i]))
    else if (a === "--matchups") matchupFilter = (argv[++i] ?? "").split(",").filter(Boolean)
    else if (!a.startsWith("--")) positional.push(a)
  }
  const weightsPath = positional[0] ?? ""
  return {
    weightsPath, dbPath, configPath, games, determinizations, simulations, timeBudgetMs,
    seed, roundActionBudget, exploreMoves, temperature, matchupFilter, concurrency,
  }
}

export function loadMatchupConfig(path: string): Matchup[] {
  const raw = readFileSync(resolve(path), "utf-8")
  const payload = JSON.parse(raw) as { matchups: Array<Record<string, unknown>> }
  if (!Array.isArray(payload.matchups)) {
    throw new Error(`[ismcts-self-play] --config must have a "matchups" array (got ${path})`)
  }
  return payload.matchups.map((m, i) => {
    const id = String(m.id ?? `m${i + 1}`)
    const deck0 = String(m.deck0 ?? "")
    const deck1 = String(m.deck1 ?? "")
    const games = Number(m.games ?? 0)
    if (!deck0 || !deck1) throw new Error(`[ismcts-self-play] matchup ${id} missing deck0/deck1`)
    return { id, deck0, deck1, games: Math.max(1, games) }
  })
}

function stubResp(method: string, value: Record<string, unknown>) {
  return { response: { $case: method as never, value: value as never } }
}

interface PendingSample {
  observation: StateObservation
  round: number
  turn: number
}


/**
 * Recording ISMCTS IO. On each `action` request: run the search, build the
 * observation (with pi_MCTS target), sample the action to play, and stash the
 * sample for terminal labelling.
 */
function makeRecordingIsmctsIo(
  who: 0 | 1,
  getState: () => GameState,
  leaf: LeafEvaluator,
  prior: ActionPriorFn,
  opponent: DecideActionFn,
  cfg: SelfPlayConfig,
  sink: PendingSample[],
  firstPlayerLatch: FirstPlayerLatch,
  decisionSeedBase: number,
  gameId: string,
) {
  let decisionSeed = decisionSeedBase ^ (who === 0 ? 0x1111 : 0x2222)
  const rng = makeSelfPlayRng(decisionSeed)
  let plyCount = 0
  return {
    notify: () => {},
    rpc: async (request: { request?: { $case?: string; value?: unknown } }) => {
      const m = request.request?.$case
      switch (m) {
        case "action": {
          const state = getState()
          const acts = await legalActions(state)
          if (acts.length === 0) return stubResp("action", { chosenActionIndex: 0, usedDice: [] })

          const res: IsmctsResult = await ismctsSearch(state, who, leaf, {
            prior,
            opponentDecide: opponent,
            config: {
              determinizations: cfg.determinizations,
              simulations: cfg.simulations,
              timeBudgetMs: cfg.timeBudgetMs,
              roundActionBudget: cfg.roundActionBudget,
              seed: decisionSeed++,
            },
          })

          // Exploration schedule: sample proportional to visits^(1/tau) during
          // opening plies, greedy afterwards. Recorded target is always full pi.
          const temp = plyCount < cfg.exploreMoves ? cfg.temperature : 0
          plyCount++
          const playIdx = sampleFromVisits(res.visitDistribution, temp, rng)

          // Build the training observation from the *live* state, aligned 1:1
          // with res.rootActions (== legalActions(state) == this slate).
          //
          // V31 D8b fix: pass the real `gameId` (matchup + ordinal + shuffle
          // seed) and the per-perspective `plyCount` as `sampleIndex` so the
          // Python trainer's `(game_id, perspective)` trajectory grouping
          // (online-TD successor index, TD(λ) targets, mirror pair detection)
          // can correctly identify each game. Before D8b these were hardcoded
          // to "ismcts" / 0, making all self-play samples collapse into a
          // single fake "ismcts" trajectory and silently breaking V-head
          // bootstrap. See §F6.D8b.
          try {
            const firstPlayer = firstPlayerLatch.set(state)
            const exported = observationFromState(
              state,
              who,
              res.rootActions,
              firstPlayer,
              gameId,
              plyCount - 1, // already incremented above
            )
            if (exported) {
              exported.observation.selected_action_index = playIdx
              exported.observation.policy_target = visitsToPolicy(res.visitDistribution)
              sink.push({
                observation: exported.observation,
                round: state.roundNumber ?? exported.observation.meta.round,
                turn: exported.observation.meta.turn,
              })
            }
          } catch {
            // skip sample on encode failure; the game still proceeds
          }

          // Map chosen VALID slate index -> engine's full action[] index.
          const full = (request.request?.value as { action?: unknown[] })?.action ?? []
          const validEngineIdx: number[] = []
          for (let i = 0; i < full.length; i++) {
            if ((full[i] as { validity?: number })?.validity === ActionValidity.VALID) {
              validEngineIdx.push(i)
            }
          }
          const engineIdx = validEngineIdx[playIdx] ?? validEngineIdx[0] ?? 0
          const chosen = acts[playIdx] ?? acts[0]
          const dice = autoDice(state.players[who].dice, chosen)
          return stubResp("action", { chosenActionIndex: engineIdx, usedDice: dice })
        }
        case "chooseActive": {
          const c = (request.request?.value as { candidateIds?: number[] })?.candidateIds ?? []
          const st = getState()
          let best = c[0] ?? 0
          let bestHp = -1
          for (const id of c) {
            const ch = st.players[who].characters.find((x) => x.id === id)
            const hp = ch?.variables.health ?? 0
            if (hp > bestHp) { bestHp = hp; best = id }
          }
          return stubResp("chooseActive", { activeCharacterId: best })
        }
        case "rerollDice":
          return stubResp("rerollDice", { diceToReroll: [] })
        case "switchHands":
          return stubResp("switchHands", { removedHandIds: [] })
        case "selectCard": {
          const c = (request.request?.value as { candidateDefinitionIds?: number[] })?.candidateDefinitionIds ?? []
          return stubResp("selectCard", { selectedDefinitionId: c[0] ?? 0 })
        }
        default:
          return stubResp("action", { chosenActionIndex: 0, usedDice: [] })
      }
    },
  }
}

function autoDice(
  available: readonly DiceType[],
  action: { autoSelectedDice?: readonly DiceType[]; cost?: unknown },
): DiceType[] {
  if (action.autoSelectedDice && action.autoSelectedDice.length > 0) return [...action.autoSelectedDice]
  if (!action.cost) return []
  const sel = chooseDice(action.cost as never, available)
  return available.filter((_, i) => sel[i])
}

export const DEFAULT_MATCHUPS: Matchup[] = [
  {
    id: "pyroke-vs-cryohe",
    deck0: "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA",
    deck1: "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA",
    games: 20,
  },
]

export async function playAndRecord(
  data: ReturnType<typeof getData>,
  deck0: DeckConfig,
  deck1: DeckConfig,
  predictor: V30NeuralPredictor,
  cfg: SelfPlayConfig,
  shuffleSeed: number,
  gameId: string,
  lake: DataLake | null,
  decisionSeedBase?: number,
): Promise<{ winner: 0 | 1 | null; inserted: number }> {
  const initial = Game.createInitialState({ data, decks: [deck0, deck1], shuffleSeed } as never)
  const game = new Game(initial)
  const getState = () => game.state

  const leaf = createNeuralLeafEvaluator(predictor)
  const prior = createNeuralPrior(predictor)
  const opponent = createSameEvaluatorOpponent(predictor)

  // Per-game decisionSeedBase ensures every game's ISMCTS search consumes a
  // unique RNG stream even when many games share the same `cfg.seed`. Caller
  // (sequential main / worker shard) is responsible for diversifying it.
  const baseSeed = decisionSeedBase ?? cfg.seed

  const samples0: PendingSample[] = []
  const samples1: PendingSample[] = []
  const firstPlayerLatch = new FirstPlayerLatch()
  game.players[0].io = makeRecordingIsmctsIo(
    0, getState, leaf, prior, opponent, cfg, samples0, firstPlayerLatch, baseSeed, gameId,
  ) as never
  game.players[1].io = makeRecordingIsmctsIo(
    1, getState, leaf, prior, opponent, cfg, samples1, firstPlayerLatch, baseSeed, gameId,
  ) as never

  let winner: 0 | 1 | null = null
  try {
    winner = (await game.start()) as 0 | 1 | null
  } catch {
    winner = game.state.winner ?? null
  }

  if (winner == null || !lake) return { winner, inserted: 0 }

  const records: SampleRecord[] = []
  for (const [side, samples] of [[0, samples0], [1, samples1]] as const) {
    const label = winner === side ? 1 : 0
    for (const s of samples) {
      records.push({
        gameId,
        round: s.round,
        turn: s.turn,
        player: side,
        actionCase:
          s.observation.candidate_actions[s.observation.selected_action_index ?? 0]?.action_case ??
          "unknown",
        features: [],
        stateObservation: s.observation,
        label,
        source: "self_play",
        weight: 1.0,
      })
    }
  }
  if (records.length > 0) lake.insertBatch(records)
  return { winner, inserted: records.length }
}

/**
 * Per-game seed derivation shared by sequential and worker paths so that the
 * `(workerId, gameOrdinal, matchupId)` triple deterministically maps to a
 * unique `(shuffleSeed, decisionSeed)` pair regardless of `--concurrency`.
 *
 * Backward compatibility: when `workerId === 0`, both `shuffleSeed` and
 * `decisionSeedBase` reproduce the historical single-process loop bit-for-bit
 * (shuffleSeed = baseSeed + g*101 + len(id); decisionSeedBase = baseSeed
 * shared across all games — matching the pre-parallel `makeRecordingIsmctsIo`
 * initialisation `cfg.seed ^ 0x1111/0x2222`). So `--concurrency 1` yields
 * the exact same samples as before this change.
 *
 * For `workerId > 0`, a golden-ratio + FNV mix gives each worker a disjoint
 * RNG stream so multi-worker runs are reproducible without seed collisions.
 */
export function deriveGameSeeds(
  baseSeed: number,
  matchupId: string,
  gameOrdinal: number,
  workerId: number,
): { shuffleSeed: number; decisionSeedBase: number; gameId: string } {
  const workerSalt = workerId === 0 ? 0 : workerId * 1_000_003
  const shuffleSeed = baseSeed + workerSalt + gameOrdinal * 101 + matchupId.length
  const decisionSeedBase =
    workerId === 0
      ? baseSeed
      : (baseSeed ^ Math.imul(workerId, 0x9e3779b9) ^ Math.imul(gameOrdinal + 1, 0x01000193)) >>> 0
  const gameId = `${matchupId}-${gameOrdinal + 1}-${shuffleSeed}${workerId > 0 ? `-w${workerId}` : ""}`
  return { shuffleSeed, decisionSeedBase, gameId }
}

/** One self-play game request (workerId is purely for seed isolation). */
export interface SelfPlayTask {
  matchupId: string
  deck0: string
  deck1: string
  gameOrdinal: number
}

/** Build the full sequential task list from a matchup list (worker 0 ordering). */
export function buildSelfPlayTasks(matchups: Matchup[]): SelfPlayTask[] {
  const tasks: SelfPlayTask[] = []
  for (const mu of matchups) {
    for (let g = 0; g < mu.games; g++) {
      tasks.push({ matchupId: mu.id, deck0: mu.deck0, deck1: mu.deck1, gameOrdinal: g })
    }
  }
  return tasks
}

async function runSequential(
  data: ReturnType<typeof getData>,
  matchups: Matchup[],
  predictor: V30NeuralPredictor,
  cfg: SelfPlayConfig,
  lake: DataLake | null,
  workerId: number,
  onMatchupProgress?: (muId: string, g: number, total: number, muInserted: number) => void,
): Promise<{ totalInserted: number; totalGames: number; p0Wins: number }> {
  let totalInserted = 0
  let totalGames = 0
  let p0Wins = 0
  for (const mu of matchups) {
    const d0 = DEFAULT_ASSETS_MANAGER.decode(mu.deck0) as DeckConfig
    const d1 = DEFAULT_ASSETS_MANAGER.decode(mu.deck1) as DeckConfig
    let muInserted = 0
    for (let g = 0; g < mu.games; g++) {
      const { shuffleSeed, decisionSeedBase, gameId } = deriveGameSeeds(
        cfg.seed, mu.id, g, workerId,
      )
      const { winner, inserted } = await playAndRecord(
        data, d0, d1, predictor, cfg, shuffleSeed, gameId, lake, decisionSeedBase,
      )
      muInserted += inserted
      totalInserted += inserted
      totalGames++
      if (winner === 0) p0Wins++
      onMatchupProgress?.(mu.id, g + 1, mu.games, muInserted)
    }
  }
  return { totalInserted, totalGames, p0Wins }
}

/**
 * Public entry for worker shards. Each worker calls this with its own
 * matchups slice (already pre-sharded) + workerId. Worker owns its own
 * predictor / DataLake instances.
 */
export async function runShard(args: {
  data: ReturnType<typeof getData>
  matchups: Matchup[]
  predictor: V30NeuralPredictor
  cfg: SelfPlayConfig
  lake: DataLake | null
  workerId: number
}): Promise<{ totalInserted: number; totalGames: number; p0Wins: number }> {
  return runSequential(args.data, args.matchups, args.predictor, args.cfg, args.lake, args.workerId)
}

/**
 * Shard tasks round-robin so that long matchups don't pile onto a single
 * worker. Returns one matchup-list per worker (preserving deck info).
 */
export function shardTasks(matchups: Matchup[], workerCount: number): Matchup[][] {
  const shards: Matchup[][] = Array.from({ length: workerCount }, () => [])
  // Round-robin individual games (not matchups) so workload is balanced.
  const tasks = buildSelfPlayTasks(matchups)
  // Group back into per-worker matchup lists, preserving (matchupId, gameOrdinal).
  const perWorker: Array<Map<string, { mu: Matchup; ordinals: number[] }>> =
    Array.from({ length: workerCount }, () => new Map())
  for (let i = 0; i < tasks.length; i++) {
    const w = i % workerCount
    const t = tasks[i]
    let entry = perWorker[w].get(t.matchupId)
    if (!entry) {
      entry = {
        mu: { id: t.matchupId, deck0: t.deck0, deck1: t.deck1, games: 0 },
        ordinals: [],
      }
      perWorker[w].set(t.matchupId, entry)
    }
    entry.ordinals.push(t.gameOrdinal)
  }
  // NOTE: We deliberately *do not* preserve the original ordinals — round-robin
  // shard ordinals start at 0 within each worker, but the worker still uses
  // `deriveGameSeeds(workerId=w, gameOrdinal)` so seeds remain unique. To keep
  // exact replay parity with sequential, callers should pass `workerCount=1`.
  for (let w = 0; w < workerCount; w++) {
    for (const { mu, ordinals } of perWorker[w].values()) {
      shards[w].push({ ...mu, games: ordinals.length })
    }
  }
  return shards.filter((s) => s.length > 0)
}

interface ShardSummary {
  totalGames: number
  totalInserted: number
  p0Wins: number
}

async function runParallel(args: {
  weightsPath: string
  dbPath: string
  matchups: Matchup[]
  cfg: SelfPlayConfig
  concurrency: number
}): Promise<ShardSummary> {
  const workerModule = new URL("./run-ismcts-self-play-worker-boot.mjs", import.meta.url)
  const { Worker } = await import("node:worker_threads")
  const shards = shardTasks(args.matchups, args.concurrency)
  const effectiveWorkers = shards.length
  console.error(
    `[ismcts-self-play] spawning ${effectiveWorkers} worker(s) (requested ${args.concurrency})`,
  )
  // Decode decks in the main process: workers do not have a direct
  // resolvable path to `@gi-tcg/assets-manager` (it is in a sibling
  // package and used via a relative source-tree import that depends on
  // the gnx tsx loader). DeckConfig is a pure data object and survives
  // structured clone, so pre-decoding here is the cleanest fix.
  const decodedShards = shards.map((shard) =>
    shard.map((m) => ({
      id: m.id,
      deck0: DEFAULT_ASSETS_MANAGER.decode(m.deck0) as DeckConfig,
      deck1: DEFAULT_ASSETS_MANAGER.decode(m.deck1) as DeckConfig,
      games: m.games,
    })),
  )
  const summaries = await Promise.all(
    decodedShards.map(
      (matchups, idx) =>
        new Promise<ShardSummary>((resolveWorker, rejectWorker) => {
          const worker = new Worker(workerModule, {
            workerData: {
              weightsPath: args.weightsPath,
              dbPath: args.dbPath,
              matchups,
              cfg: args.cfg,
              workerId: idx,
            },
          })
          worker.once("message", (msg: ShardSummary) => resolveWorker(msg))
          worker.once("error", rejectWorker)
          worker.once("exit", (code) => {
            if (code !== 0) rejectWorker(new Error(`self-play worker exited with code ${code}`))
          })
        }),
    ),
  )
  return summaries.reduce(
    (acc, s) => ({
      totalGames: acc.totalGames + s.totalGames,
      totalInserted: acc.totalInserted + s.totalInserted,
      p0Wins: acc.p0Wins + s.p0Wins,
    }),
    { totalGames: 0, totalInserted: 0, p0Wins: 0 },
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.weightsPath) {
    console.error(
      "Usage: run-ismcts-self-play.ts <encoder-weights.json> --db <path> [--games N] [-k K] [-n M] [--time-budget MS] [--explore-moves P] [--temperature T] [--concurrency N]",
    )
    process.exit(1)
  }

  let matchups = args.configPath ? loadMatchupConfig(args.configPath) : DEFAULT_MATCHUPS
  if (args.matchupFilter) matchups = matchups.filter((m) => args.matchupFilter!.includes(m.id))
  if (args.games > 0) matchups = matchups.map((m) => ({ ...m, games: args.games }))
  console.error(`[ismcts-self-play] running ${matchups.length} matchup(s): ${matchups.map(m => m.id + "(" + m.games + ")").join(", ")}`)

  const cfg: SelfPlayConfig = {
    determinizations: args.determinizations,
    simulations: args.simulations,
    timeBudgetMs: args.timeBudgetMs,
    roundActionBudget: args.roundActionBudget,
    exploreMoves: args.exploreMoves,
    temperature: args.temperature,
    seed: args.seed,
  }

  // Determine effective concurrency: cap at available cores and total game
  // count; auto-downgrade to sequential when gamesPerWorker < 5 (cold-start
  // overhead dominates) — see ismcts-selfplay-perf-optimizations.md §方案一.
  const totalGames = matchups.reduce((s, m) => s + m.games, 0)
  let workerCount = Math.max(1, Math.min(args.concurrency, availableParallelism(), totalGames))
  if (workerCount > 1 && totalGames / workerCount < 5) {
    console.warn(
      `[ismcts-self-play] downgrading to sequential: ${totalGames} games / ${workerCount} workers < 5 games/worker (cold start dominates)`,
    )
    workerCount = 1
  }

  const t0 = Date.now()

  if (workerCount > 1) {
    if (!args.dbPath) {
      console.warn("[ismcts-self-play] --concurrency > 1 without --db: samples will be discarded by workers")
    }
    const summary = await runParallel({
      weightsPath: resolve(args.weightsPath),
      dbPath: args.dbPath ? resolve(args.dbPath) : "",
      matchups,
      cfg,
      concurrency: workerCount,
    })
    console.log(JSON.stringify({
      weights: args.weightsPath,
      db: args.dbPath,
      config: cfg,
      concurrency: workerCount,
      totalGames: summary.totalGames,
      totalSamples: summary.totalInserted,
      p0WinRate: summary.totalGames > 0 ? summary.p0Wins / summary.totalGames : 0,
      elapsedMs: Date.now() - t0,
    }, null, 2))
    return
  }

  // Sequential path (workerCount === 1): identical to historical behaviour.
  const data = getData(CURRENT_VERSION)
  const predictor = V30NeuralPredictor.fromFile(resolve(args.weightsPath))
  const lake = args.dbPath ? new DataLake(resolve(args.dbPath)) : null
  if (!lake) console.warn("[ismcts-self-play] no --db given: running dry (no samples persisted)")

  try {
    const summary = await runSequential(
      data, matchups, predictor, cfg, lake, /* workerId */ 0,
      (muId, g, total, muInserted) => {
        if (g % 5 === 0 || g === total) {
          console.error(
            `[ismcts-self-play] ${muId} ${g}/${total} games, ${muInserted} samples (${Math.round((Date.now() - t0) / 1000)}s)`,
          )
        }
      },
    )
    for (const mu of matchups) {
      // Per-matchup totals are no longer tracked separately; emit a single
      // summary line per matchup for parity with the original output format.
      console.log(`${mu.id}: ${mu.games} games`)
    }
    console.log(JSON.stringify({
      weights: args.weightsPath,
      db: args.dbPath,
      config: cfg,
      concurrency: 1,
      totalGames: summary.totalGames,
      totalSamples: summary.totalInserted,
      p0WinRate: summary.totalGames > 0 ? summary.p0Wins / summary.totalGames : 0,
      elapsedMs: Date.now() - t0,
    }, null, 2))
  } finally {
    lake?.close()
  }
}

// Only run the CLI when this file is executed directly (not when imported
// by the worker entry or unit tests). `import.meta.main` is supported by
// both Bun and Node ≥ 20.11; the fallback handles older runtimes by
// comparing argv[1] with the resolved module path.
const isMainModule =
  typeof (import.meta as { main?: boolean }).main === "boolean"
    ? (import.meta as { main: boolean }).main
    : (() => {
        try {
          const argv1 = process.argv[1]
          if (!argv1) return false
          const here = new URL(import.meta.url).pathname
          // Normalise Windows leading slash for drive-letter paths.
          const norm = (p: string) => p.replace(/^\/([A-Za-z]:)/, "$1")
          return norm(here) === norm(argv1.replace(/\\/g, "/"))
        } catch {
          return false
        }
      })()

if (isMainModule) {
  main()
}
