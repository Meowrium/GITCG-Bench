// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V31 F6 / V30 §6.4 #5 — ISMCTS benchmark harness.
 *
 * Plays real games (decoded benchmark decks) where one side picks actions via
 * `ismctsSearch` (engine-exact + determinization + encoder leaf V + same-
 * evaluator opponent), and the other side uses `BaselinePolicy` through the
 * production `PolicyPlayerIO`. Reports win rate of the ISMCTS side.
 *
 * This is a standalone driver (not a runtime Policy) because `ismctsSearch` is
 * async and runs the real engine internally, whereas `Policy.choose` is
 * synchronous. Driving the game directly keeps the search engine-exact and the
 * A/B comparison fair (both sides face the same `Game`).
 *
 * Usage:
 *   gnx src/mcts/cli/run-ismcts-benchmark.ts <encoder-weights.json> \
 *       [--games N] [--determinizations K] [--simulations M] \
 *       [--time-budget MS] [--seed S] [--matchups a,b,...]
 */

import { Game, CURRENT_VERSION, type GameState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { ActionValidity, type DiceType } from "@gi-tcg/typings"
import { chooseDice } from "@gi-tcg/utils"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index"
import { BaselinePolicy } from "../../runtime/policy/baseline-policy.js"
import { PolicyPlayerIO } from "../../runtime/io/policy-player-io.js"
import { V30NeuralPredictor } from "../../learning/encoder/neural-predictor.js"
import { ismctsSearch } from "../ismcts.js"
import {
  createNeuralLeafEvaluator,
  createNeuralPrior,
  createSameEvaluatorOpponent,
} from "../neural-leaf.js"
import { legalActions } from "../engine-step.js"
import type { LeafEvaluator, ActionPriorFn } from "../ismcts.js"
import type { DecideActionFn } from "../engine-step.js"

interface Matchup {
  id: string
  deck0: string
  deck1: string
  games: number
}

function parseArgs(argv: string[]) {
  // Default `--time-budget 500` is the V31 F6 production budget. After the
  // F8 sampling-perf patch (`legal-actions-cache.ts` C1/C3, see
  // docs/v31-theory-alignment-fixes.md §11), the same wall-clock budget
  // yields more determinizations × simulations actually executed and thus
  // a stronger ISMCTS player. To strictly reproduce pre-F8 KPI numbers
  // (e.g. the gen1-vs-gen0 73.3% milestone), pass `--time-budget 300`.
  let games = 0
  let determinizations = 16
  let simulations = 128
  let timeBudgetMs = 500
  let seed = 20260620
  let roundActionBudget = 2
  let matchupFilter: string[] | null = null
  let weightsPath = ""
  let leafKind: "encoder" | "hp" = "encoder"
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--games") games = Number(argv[++i])
    else if (a === "--determinizations" || a === "-k") determinizations = Number(argv[++i])
    else if (a === "--simulations" || a === "-n") simulations = Number(argv[++i])
    else if (a === "--time-budget") timeBudgetMs = Number(argv[++i])
    else if (a === "--seed") seed = Number(argv[++i])
    else if (a === "--round-budget") roundActionBudget = Number(argv[++i])
    else if (a === "--leaf") leafKind = (argv[++i] === "hp" ? "hp" : "encoder")
    else if (a === "--matchups") matchupFilter = (argv[++i] ?? "").split(",").filter(Boolean)
    else if (!a.startsWith("--")) positional.push(a)
  }
  weightsPath = positional[0] ?? ""
  return { weightsPath, games, determinizations, simulations, timeBudgetMs, seed, roundActionBudget, matchupFilter, leafKind }
}

function stubResp(method: string, value: Record<string, unknown>) {
  return { response: { $case: method as never, value: value as never } }
}

/** HP-ratio win-prob leaf (no encoder) — for isolating harness vs encoder quality. */
const hpLeaf: LeafEvaluator = (state, who) => {
  const me = state.players[who]
  const opp = state.players[(1 - who) as 0 | 1]
  const aliveOpp = opp.characters.filter((c) => c.variables.alive).length
  if (aliveOpp === 0) return 1
  const aliveMe = me.characters.filter((c) => c.variables.alive).length
  if (aliveMe === 0) return 0
  const sum = (p: typeof me) => p.characters.reduce((s, c) => s + (c.variables.alive ? (c.variables.health ?? 0) : 0), 0)
  const total = sum(me) + sum(opp)
  return total > 0 ? sum(me) / total : 0.5
}

/**
 * IO that drives the ISMCTS side: on each `action` request it runs ismctsSearch
 * over the *live* game state and returns the chosen VALID-action index + dice.
 * Forced sub-decisions use simple deterministic stubs (same as engine-step).
 */
function makeIsmctsIo(
  who: 0 | 1,
  getState: () => GameState,
  leaf: LeafEvaluator,
  prior: ActionPriorFn,
  opponent: DecideActionFn,
  cfg: { determinizations: number; simulations: number; timeBudgetMs: number; roundActionBudget: number; seed: number },
) {
  let decisionSeed = cfg.seed
  return {
    notify: () => {},
    rpc: async (request: { request?: { $case?: string; value?: unknown } }) => {
      const m = request.request?.$case
      switch (m) {
        case "action": {
          const state = getState()
          const acts = await legalActions(state)
          if (acts.length === 0) return stubResp("action", { chosenActionIndex: 0, usedDice: [] })
          const res = await ismctsSearch(state, who, leaf, {
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
          // ismctsSearch's rootActions == legalActions(state) (same VALID slate),
          // and bestActionIndex indexes that slate. Map to the engine's full
          // action[] index by matching VALID order.
          const full = (request.request?.value as { action?: unknown[] })?.action ?? []
          const validEngineIdx: number[] = []
          for (let i = 0; i < full.length; i++) {
            if ((full[i] as { validity?: number })?.validity === ActionValidity.VALID) validEngineIdx.push(i)
          }
          const idx = res.bestActionIndex >= 0 ? res.bestActionIndex : 0
          const engineIdx = validEngineIdx[idx] ?? validEngineIdx[0] ?? 0
          const chosen = acts[idx] ?? acts[0]
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
  ismctsSide: 0 | 1,
  predictor: V30NeuralPredictor,
  cfg: { determinizations: number; simulations: number; timeBudgetMs: number; roundActionBudget: number; seed: number; leafKind: "encoder" | "hp" },
  shuffleSeed: number,
): Promise<0 | 1 | null> {
  const initial = Game.createInitialState({ data, decks: [deck0, deck1], shuffleSeed } as never)
  const game = new Game(initial)
  const getState = () => game.state

  const encoderLeaf = createNeuralLeafEvaluator(predictor)
  const leaf: LeafEvaluator = cfg.leafKind === "hp" ? hpLeaf : encoderLeaf
  const prior = createNeuralPrior(predictor)
  const opponent = createSameEvaluatorOpponent(predictor)

  const baseline = new BaselinePolicy({ endTurnPenalty: 5 })
  const oppSide = (1 - ismctsSide) as 0 | 1
  const baselineIo = new PolicyPlayerIO({ side: oppSide, policy: baseline })
  ;(baselineIo as unknown as { attachGameContext?: (c: unknown) => void }).attachGameContext?.({
    data,
    stateProvider: getState,
  })

  const ismctsIo = makeIsmctsIo(ismctsSide, getState, leaf, prior, opponent, cfg)

  game.players[ismctsSide].io = ismctsIo as never
  game.players[oppSide].io = baselineIo as never

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
  if (!args.weightsPath) {
    console.error("Usage: run-ismcts-benchmark.ts <encoder-weights.json> [--games N] [-k K] [-n M] [--time-budget MS]")
    process.exit(1)
  }
  const data = getData(CURRENT_VERSION)
  const predictor = V30NeuralPredictor.fromFile(resolve(args.weightsPath))

  let matchups = DEFAULT_MATCHUPS
  if (args.matchupFilter) matchups = matchups.filter((m) => args.matchupFilter!.includes(m.id))
  if (args.games > 0) matchups = matchups.map((m) => ({ ...m, games: args.games }))

  const cfg = {
    determinizations: args.determinizations,
    simulations: args.simulations,
    timeBudgetMs: args.timeBudgetMs,
    roundActionBudget: args.roundActionBudget,
    seed: args.seed,
    leafKind: args.leafKind,
  }

  let totalWins = 0
  let totalGames = 0
  const t0 = Date.now()
  for (const mu of matchups) {
    const d0 = DEFAULT_ASSETS_MANAGER.decode(mu.deck0) as DeckConfig
    const d1 = DEFAULT_ASSETS_MANAGER.decode(mu.deck1) as DeckConfig
    let wins = 0
    for (let g = 0; g < mu.games; g++) {
      // Alternate which engine seat ISMCTS occupies to cancel first-move bias.
      const ismctsSide: 0 | 1 = g % 2 === 0 ? 0 : 1
      const shuffleSeed = args.seed + g * 101 + mu.id.length
      const winner = await playGame(data, d0, d1, ismctsSide, predictor, cfg, shuffleSeed)
      if (winner === ismctsSide) wins++
      totalGames++
      if (winner === ismctsSide) totalWins++
    }
    console.log(`${mu.id}: ISMCTS wins ${wins}/${mu.games} (${(100 * wins / mu.games).toFixed(1)}%)`)
  }
  const wr = totalGames > 0 ? totalWins / totalGames : 0
  console.log(JSON.stringify({
    weights: args.weightsPath,
    config: cfg,
    totalGames,
    ismctsWins: totalWins,
    winRate: wr,
    elapsedMs: Date.now() - t0,
  }, null, 2))
}

main()
