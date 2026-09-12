// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / D3 — generation-vs-generation ISMCTS benchmark.
 *
 * Pits two ISMCTS agents that differ *only* in their encoder weights against
 * each other on real games. Both sides use identical search config (K, N,
 * time budget, round budget) so any win-rate gap is attributable to the
 * encoder (leaf V + Q prior + same-evaluator opponent), which is exactly the
 * signal the AlphaZero flywheel must produce: gen N+1 (distilled on gen N's
 * pi_MCTS) should beat gen N.
 *
 * Reports the win rate of the "challenger" (--new) vs the "champion" (--old).
 * Seats alternate every game to cancel first-move bias.
 *
 * Usage:
 *   gnx src/mcts/cli/run-ismcts-gen-vs-gen.ts \
 *       --old <gen0-weights.json> --new <gen1-weights.json> \
 *       [--games N] [-k K] [-n M] [--time-budget MS] [--round-budget R] \
 *       [--seed S] [--matchups id,...]
 */

import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { ActionValidity, type DiceType } from "@gi-tcg/typings"
import { chooseDice } from "@gi-tcg/utils"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index"
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
import { visitsToPolicy } from "./self-play-sampling.js"

interface Matchup {
  id: string
  deck0: string
  deck1: string
  games: number
}

interface SearchCfg {
  determinizations: number
  simulations: number
  timeBudgetMs: number
  roundActionBudget: number
}

interface Agent {
  leaf: LeafEvaluator
  prior: ActionPriorFn
  opponent: DecideActionFn
}

/**
 * Per-decision sample captured during a gen-vs-gen game. Used for offline
 * analysis ("where did the new encoder differ from the old?"): each entry
 * records which agent moved, the search visit distribution and meanQ over the
 * candidate slate, plus the redacted StateObservation so downstream tools can
 * replay the position through any encoder.
 */
export interface GameDecisionSample {
  game_id: string
  ply: number
  side: 0 | 1
  agent_label: "old" | "new"
  round: number
  turn: number
  chosen_index: number
  chosen_action_case: string
  visit_distribution: number[]
  policy_target: number[]
  mean_q: number[]
  best_q: number
  observation: StateObservation
}

function parseArgs(argv: string[]) {
  // `--time-budget 500` matches the V31 F6 gen0→gen1 73.3% baseline. After
  // the F8 sampling-perf patch (`legal-actions-cache.ts` C1/C3, see
  // docs/v31-theory-alignment-fixes.md §11), the same budget produces
  // stronger search on *both* sides, so absolute win-rates may drift
  // upward while monotonic gen-vs-gen improvement still holds. To strictly
  // reproduce the 73.3% baseline number, pass `--time-budget 300`.
  let games = 0
  let determinizations = 8
  let simulations = 64
  let timeBudgetMs = 500
  let roundActionBudget = 2
  let seed = 20260204
  let oldPath = ""
  let newPath = ""
  let captureDir = ""
  let configPath = ""
  let matchupFilter: string[] | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--games") games = Number(argv[++i])
    else if (a === "--determinizations" || a === "-k") determinizations = Number(argv[++i])
    else if (a === "--simulations" || a === "-n") simulations = Number(argv[++i])
    else if (a === "--time-budget") timeBudgetMs = Number(argv[++i])
    else if (a === "--round-budget") roundActionBudget = Number(argv[++i])
    else if (a === "--seed") seed = Number(argv[++i])
    else if (a === "--old") oldPath = argv[++i]
    else if (a === "--new") newPath = argv[++i]
    else if (a === "--capture-dir") captureDir = argv[++i]
    else if (a === "--config") configPath = argv[++i]
    else if (a === "--matchups") matchupFilter = (argv[++i] ?? "").split(",").filter(Boolean)
  }
  return { oldPath, newPath, games, determinizations, simulations, timeBudgetMs, roundActionBudget, seed, captureDir, configPath, matchupFilter }
}

function loadMatchupConfig(path: string): Matchup[] {
  const raw = readFileSync(resolve(path), "utf-8")
  const payload = JSON.parse(raw) as { matchups: Array<Record<string, unknown>> }
  if (!Array.isArray(payload.matchups)) {
    throw new Error(`--config must have a "matchups" array (got ${path})`)
  }
  return payload.matchups.map((m, i) => ({
    id: String(m.id ?? `m${i + 1}`),
    deck0: String(m.deck0 ?? ""),
    deck1: String(m.deck1 ?? ""),
    games: Math.max(1, Number(m.games ?? 0)),
  }))
}

function stubResp(method: string, value: Record<string, unknown>) {
  return { response: { $case: method as never, value: value as never } }
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

function makeAgentIo(
  who: 0 | 1,
  getState: () => GameState,
  agent: Agent,
  cfg: SearchCfg,
  seed0: number,
  capture: { gameId: string; sink: GameDecisionSample[]; agentLabel: "old" | "new" } | null,
  firstPlayerLatch: FirstPlayerLatch,
) {
  let decisionSeed = seed0
  return {
    notify: () => {},
    rpc: async (request: { request?: { $case?: string; value?: unknown } }) => {
      const m = request.request?.$case
      switch (m) {
        case "action": {
          const state = getState()
          const acts = await legalActions(state)
          if (acts.length === 0) return stubResp("action", { chosenActionIndex: 0, usedDice: [] })
          const res: IsmctsResult = await ismctsSearch(state, who, agent.leaf, {
            prior: agent.prior,
            opponentDecide: agent.opponent,
            config: {
              determinizations: cfg.determinizations,
              simulations: cfg.simulations,
              timeBudgetMs: cfg.timeBudgetMs,
              roundActionBudget: cfg.roundActionBudget,
              seed: decisionSeed++,
            },
          })
          const full = (request.request?.value as { action?: unknown[] })?.action ?? []
          const validEngineIdx: number[] = []
          for (let i = 0; i < full.length; i++) {
            if ((full[i] as { validity?: number })?.validity === ActionValidity.VALID) validEngineIdx.push(i)
          }
          const idx = res.bestActionIndex >= 0 ? res.bestActionIndex : 0
          const engineIdx = validEngineIdx[idx] ?? validEngineIdx[0] ?? 0
          const chosen = acts[idx] ?? acts[0]
          const dice = autoDice(state.players[who].dice, chosen)
          // Capture for offline analysis: record the live observation, the
          // search policy, and Q values so we can compare "what gen0 would have
          // played here" vs "what gen1 played" post-hoc.
          if (capture) {
            try {
              const firstPlayer = firstPlayerLatch.set(state)
              const exported = observationFromState(
                state,
                who,
                res.rootActions,
                firstPlayer,
                capture.gameId,
                capture.sink.length,
              )
              if (exported) {
                exported.observation.selected_action_index = idx
                exported.observation.policy_target = visitsToPolicy(res.visitDistribution)
                capture.sink.push({
                  game_id: capture.gameId,
                  ply: capture.sink.length,
                  side: who,
                  agent_label: capture.agentLabel,
                  round: state.roundNumber ?? exported.observation.meta.round,
                  turn: exported.observation.meta.turn,
                  chosen_index: idx,
                  chosen_action_case: exported.observation.candidate_actions[idx]?.action_case ?? "unknown",
                  visit_distribution: [...res.visitDistribution],
                  policy_target: visitsToPolicy(res.visitDistribution),
                  mean_q: [...res.meanQ],
                  best_q: res.meanQ[idx] ?? 0,
                  observation: exported.observation,
                })
              }
            } catch {
              // skip capture on encode failure; game still proceeds
            }
          }
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

function makeAgent(predictor: V30NeuralPredictor): Agent {
  return {
    leaf: createNeuralLeafEvaluator(predictor),
    prior: createNeuralPrior(predictor),
    opponent: createSameEvaluatorOpponent(predictor),
  }
}

const DEFAULT_MATCHUPS: Matchup[] = [
  {
    id: "pyroke-vs-cryohe",
    deck0: "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA",
    deck1: "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA",
    games: 20,
  },
]

async function playGame(
  data: ReturnType<typeof getData>,
  deck0: DeckConfig,
  deck1: DeckConfig,
  newSide: 0 | 1,
  agentNew: Agent,
  agentOld: Agent,
  cfg: SearchCfg,
  shuffleSeed: number,
  captureSink: GameDecisionSample[] | null,
  gameId: string,
): Promise<0 | 1 | null> {
  const initial = Game.createInitialState({ data, decks: [deck0, deck1], shuffleSeed } as never)
  const game = new Game(initial)
  const getState = () => game.state
  const oldSide = (1 - newSide) as 0 | 1
  const newCapture = captureSink ? { gameId, sink: captureSink, agentLabel: "new" as const } : null
  const oldCapture = captureSink ? { gameId, sink: captureSink, agentLabel: "old" as const } : null
  const firstPlayerLatch = new FirstPlayerLatch()
  game.players[newSide].io = makeAgentIo(newSide, getState, agentNew, cfg, shuffleSeed * 2 + 1, newCapture, firstPlayerLatch) as never
  game.players[oldSide].io = makeAgentIo(oldSide, getState, agentOld, cfg, shuffleSeed * 2 + 7, oldCapture, firstPlayerLatch) as never
  let winner: 0 | 1 | null = null
  try {
    winner = (await game.start()) as 0 | 1 | null
  } catch {
    winner = game.state.winner ?? null
  }
  return winner
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.oldPath || !args.newPath) {
    console.error("Usage: run-ismcts-gen-vs-gen.ts --old <weights> --new <weights> [--games N] [-k K] [-n M]")
    process.exit(1)
  }
  const data = getData(CURRENT_VERSION)
  const agentOld = makeAgent(V30NeuralPredictor.fromFile(resolve(args.oldPath)))
  const agentNew = makeAgent(V30NeuralPredictor.fromFile(resolve(args.newPath)))

  let matchups = args.configPath ? loadMatchupConfig(args.configPath) : DEFAULT_MATCHUPS
  if (args.matchupFilter) matchups = matchups.filter((m) => args.matchupFilter!.includes(m.id))
  if (args.games > 0) matchups = matchups.map((m) => ({ ...m, games: args.games }))
  console.error(`[gen-vs-gen] running ${matchups.length} matchup(s) (${matchups.reduce((s, m) => s + m.games, 0)} games total)`)
  if (args.games > 0) matchups = matchups.map((m) => ({ ...m, games: args.games }))

  const cfg: SearchCfg = {
    determinizations: args.determinizations,
    simulations: args.simulations,
    timeBudgetMs: args.timeBudgetMs,
    roundActionBudget: args.roundActionBudget,
  }

  let newWins = 0
  let decisive = 0
  let totalGames = 0
  let draws = 0
  const t0 = Date.now()
  const captureDir = args.captureDir ? resolve(args.captureDir) : null
  if (captureDir) mkdirSync(captureDir, { recursive: true })
  for (const mu of matchups) {
    const d0 = DEFAULT_ASSETS_MANAGER.decode(mu.deck0) as DeckConfig
    const d1 = DEFAULT_ASSETS_MANAGER.decode(mu.deck1) as DeckConfig
    let muNewWins = 0
    for (let g = 0; g < mu.games; g++) {
      const newSide: 0 | 1 = g % 2 === 0 ? 0 : 1
      const shuffleSeed = args.seed + g * 101 + mu.id.length
      const gameId = `${mu.id}-g${String(g + 1).padStart(3, "0")}-s${shuffleSeed}`
      const sink: GameDecisionSample[] | null = captureDir ? [] : null
      const winner = await playGame(data, d0, d1, newSide, agentNew, agentOld, cfg, shuffleSeed, sink, gameId)
      totalGames++
      if (winner == null) { draws++ }
      else {
        decisive++
        if (winner === newSide) { newWins++; muNewWins++ }
      }
      if (captureDir && sink) {
        const path = resolve(
          captureDir,
          `${gameId}_newSide${newSide}_w${winner == null ? "draw" : "p" + winner}.json`,
        )
        writeFileSync(path, JSON.stringify({
          matchup_id: mu.id,
          game_id: gameId,
          shuffle_seed: shuffleSeed,
          new_side: newSide,
          old_side: 1 - newSide,
          winner,
          config: cfg,
          decisions: sink,
        }))
      }
      if ((g + 1) % 5 === 0 || g + 1 === mu.games) {
        console.error(`[gen-vs-gen] ${mu.id} ${g + 1}/${mu.games} — new wins ${muNewWins} (${Math.round((Date.now() - t0) / 1000)}s)`)
      }
    }
    console.log(`${mu.id}: NEW wins ${muNewWins}/${mu.games}`)
  }
  const wrDecisive = decisive > 0 ? newWins / decisive : 0
  console.log(JSON.stringify({
    old: args.oldPath,
    new: args.newPath,
    config: cfg,
    totalGames,
    draws,
    decisive,
    newWins,
    newWinRateDecisive: wrDecisive,
    newWinRateAll: totalGames > 0 ? newWins / totalGames : 0,
    elapsedMs: Date.now() - t0,
  }, null, 2))
}

main()
