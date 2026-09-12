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

import { readdir, readFile, writeFile } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  CURRENT_VERSION,
  Game,
  deserializeGameStateLog,
  serializeGameStateLog,
  type GameState,
} from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import type { BaselinePolicy } from "../../../runtime/policy/baseline-policy.js"
import type { EvaluatorPolicy } from "../../../runtime/policy/evaluator-policy.js"
import type { GiMlPolicy } from "../../../runtime/policy/gi-ml-policy.js"
import { PolicyPlayerIO } from "../../../runtime/io/policy-player-io.js"
import { SimAdapter } from "../../../runtime/adapters/sim-adapter.js"
import type { ActionInfoWithModification } from "../../../runtime/adapters/internal-types.js"
import {
  buildBenchmarkExecutionPlans,
  createPolicyFromConfig,
  loadBenchmarkCliConfig,
  readJsonFile,
  type BenchmarkPolicyConfig,
} from "../../benchmark/cli-config.js"
import { buildPolicyTurnDigestFromGameState } from "../../../runtime/policy/candidate-semantics.js"
import { chooseBranchActionIndices, pickRandomIndices, summarizeWins } from "../branch-eval-utils.js"
import {
  BRANCH_EVAL_CANDIDATE_FEATURE_NAMES,
  BRANCH_EVAL_FEATURE_VERSION,
  BRANCH_EVAL_QUERY_FEATURE_NAMES,
  buildBranchEvalCandidateNumericSlots,
  buildBranchEvalQueryNumericSlots,
} from "../report-slots.js"

type PolicyLike = BaselinePolicy | EvaluatorPolicy | GiMlPolicy

interface BranchEvalConfig {
  benchmarkPath: string
  matchupId: string
  replayDir: string
  sampleCount?: number
  minLegalActions?: number
  maxBranchesPerPoint?: number
  continuationGamesPerBranch?: number
  branchSearchDepth?: number
  sideA?: BenchmarkPolicyConfig
  sideB?: BenchmarkPolicyConfig
  outputPath?: string
  /** Max concurrent branch point evaluations (default: 2) */
  pointConcurrency?: number
}

interface BranchPoint {
  replayFile: string
  entryIndex: number
  nextStateIndex: number | null
  state: GameState
  actor: 0 | 1
  legalActions: ActionInfoWithModification[]
  actualActionIndex: number | null
}

/**
 * Limited-concurrency Promise.all replacement.
 * Prevents resource exhaustion from unbounded parallel execution.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const p = fn(items[i], i).then((r) => {
      results[i] = r;
    });
    executing.add(p);
    p.then(() => executing.delete(p));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

async function main() {
  const configPath = resolve(process.cwd(), process.argv[2] ?? "")
  if (!process.argv[2]) {
    throw new Error("Usage: pnpm exec gnx src/evaluation/branch-eval/cli/run-branch-eval.ts <config.json>")
  }
  const configDir = dirname(configPath)
  const config = (await readJsonFile(configPath)) as BranchEvalConfig
  const loaded = await loadBenchmarkCliConfig(resolve(configDir, config.benchmarkPath))
  const plan = buildBenchmarkExecutionPlans(loaded.config).find((candidate) => candidate.id === config.matchupId)
  if (!plan) {
    throw new Error(`Matchup not found in benchmark config: ${config.matchupId}`)
  }

  const data = getData(loaded.version ?? CURRENT_VERSION)
  const sim = new SimAdapter(data)
  const sideAConfig = config.sideA ?? plan.sideA
  const sideBConfig = config.sideB ?? plan.sideB
  const policyA = await createPolicyFromConfig(sideAConfig, loaded.configDir, {
    selfDeckCode: plan.deck0,
    opponentDeckCode: plan.deck1,
    priorProvider: new (await import("../../../learning/features/deck-prior-provider.js")).DeckPriorProvider(),
  })
  const policyB = await createPolicyFromConfig(sideBConfig, loaded.configDir, {
    selfDeckCode: plan.deck1,
    opponentDeckCode: plan.deck0,
    priorProvider: new (await import("../../../learning/features/deck-prior-provider.js")).DeckPriorProvider(),
  })

  const points = await collectBranchPoints({
    replayDir: resolve(configDir, config.replayDir),
    sim,
    data,
    sampleCount: config.sampleCount ?? 10,
    minLegalActions: config.minLegalActions ?? 3,
  })

  const report = {
    benchmarkPath: config.benchmarkPath,
    matchupId: config.matchupId,
    replayDir: config.replayDir,
    sampleCount: points.length,
    continuationGamesPerBranch: config.continuationGamesPerBranch ?? 5,
    featureVersion: BRANCH_EVAL_FEATURE_VERSION,
    candidateFeatureNames: BRANCH_EVAL_CANDIDATE_FEATURE_NAMES,
    queryFeatureNames: BRANCH_EVAL_QUERY_FEATURE_NAMES,
    points: await runWithConcurrency(
      points,
      2,
      (point, index) =>
        evaluateBranchPoint({
          point,
          sim,
          pointIndex: index,
          policyA,
          policyB,
          maxBranchesPerPoint: config.maxBranchesPerPoint ?? 4,
          continuationGamesPerBranch: config.continuationGamesPerBranch ?? 5,
        }),
    ),
  }

  const outputPath = config.outputPath
    ? resolve(configDir, config.outputPath)
    : undefined
  console.log(formatSummary(report))
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  }
}

async function collectBranchPoints(args: {
  replayDir: string
  sim: SimAdapter
  data: ReturnType<typeof getData>
  sampleCount: number
  minLegalActions: number
}): Promise<BranchPoint[]> {
  const replayFiles = (await readdir(args.replayDir))
    .filter((file) => file.endsWith(".json"))
    .map((file) => resolve(args.replayDir, file))

  const allPoints: BranchPoint[] = []
  for (const replayFile of replayFiles) {
    const replayJson = JSON.parse(await readFile(replayFile, "utf8")) as Parameters<typeof deserializeGameStateLog>[1]
    const entries = deserializeGameStateLog(args.data, replayJson)
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry?.canResume || entry.state.phase !== "action") {
        continue
      }
      const legalActions = await args.sim.legalActions(entry.state)
      if (legalActions.length < args.minLegalActions) {
        continue
      }
      const nextStateIndex = findNextDistinctResumeIndex(entries, i)
      const actualActionIndex =
        nextStateIndex != null
          ? await inferActualActionIndex(args.sim, entry.state, legalActions, entries[nextStateIndex]!.state)
          : null
      allPoints.push({
        replayFile,
        entryIndex: i,
        nextStateIndex,
        state: entry.state,
        actor: entry.state.currentTurn as 0 | 1,
        legalActions,
        actualActionIndex,
      })
    }
  }

  const pickedIndices = pickRandomIndices(allPoints.length, args.sampleCount)
  return pickedIndices.map((index) => allPoints[index]!).filter(Boolean)
}

function findNextDistinctResumeIndex(
  entries: ReturnType<typeof deserializeGameStateLog>,
  fromIndex: number,
): number | null {
  const currentSignature = stableStateSignature(entries[fromIndex]!.state)
  for (let i = fromIndex + 1; i < entries.length; i++) {
    const candidate = entries[i]
    if (!candidate?.canResume) {
      continue
    }
    if (stableStateSignature(candidate.state) !== currentSignature) {
      return i
    }
  }
  return null
}

async function inferActualActionIndex(
  sim: SimAdapter,
  state: GameState,
  actions: ActionInfoWithModification[],
  expectedNextState: GameState,
): Promise<number | null> {
  const expected = stableStateSignature(expectedNextState)
  for (let i = 0; i < actions.length; i++) {
    const stepped = await sim.step(state, i, actions)
    if (stableStateSignature(stepped.newState) === expected) {
      return i
    }
  }
  return null
}

async function evaluateBranchPoint(args: {
  point: BranchPoint
  sim: SimAdapter
  pointIndex: number
  policyA: PolicyLike
  policyB: PolicyLike
  maxBranchesPerPoint: number
  continuationGamesPerBranch: number
}) {
  const digest = buildPolicyTurnDigestFromGameState(
    args.point.state,
    args.point.actor,
    args.point.legalActions,
  )
  const queryNumericSlots = buildBranchEvalQueryNumericSlots(digest)
  const actingPolicy = args.point.actor === 0 ? args.policyA : args.policyB
  const decision = actingPolicy.choose(digest)
  const branchIndices = chooseBranchActionIndices({
    rankedIds: decision.ranked.map((candidate) => candidate.candidateId),
    maxBranches: args.maxBranchesPerPoint,
    actualActionIndex: args.point.actualActionIndex,
  })

  const branches = []
  for (const actionIndex of branchIndices) {
    const candidateDigest = digest.candidate_actions[actionIndex]
    const stepResult = await args.sim.step(args.point.state, actionIndex, args.point.legalActions)
    const winners: Array<0 | 1 | null> = []
    for (let i = 0; i < args.continuationGamesPerBranch; i++) {
      winners.push(await runContinuation(stepResult.newState, args.policyA, args.policyB))
    }
    const summary = summarizeWins(winners, args.point.actor)
    branches.push({
      actionIndex,
      actionType: args.point.legalActions[actionIndex]?.type ?? "unknown",
      definitionId: actionDefinitionId(args.point.legalActions[actionIndex]),
      actionDefinitionKind: actionDefinitionKind(args.point.legalActions[actionIndex]),
      skillDefinitionId: skillDefinitionId(args.point.legalActions[actionIndex]),
      cardDefinitionId: cardDefinitionId(args.point.legalActions[actionIndex]),
      characterDefinitionId: characterDefinitionId(args.point.legalActions[actionIndex]),
      actorCharacterDefinitionId: actorCharacterDefinitionId(args.point.state, args.point.actor),
      candidateTags: normalizeTags(candidateDigest?.tags),
      candidateNumericSlots: buildBranchEvalCandidateNumericSlots(digest, candidateDigest),
      isPolicyChoice: decision.selectedCandidateId === String(actionIndex),
      isReplayChoice: args.point.actualActionIndex === actionIndex,
      continuation: {
        wins: summary.wins,
        losses: summary.losses,
        draws: summary.draws,
        winRate: summary.winRate,
      },
    })
  }

  return {
    pointIndex: args.pointIndex,
    replayFile: args.point.replayFile,
    replayEntryIndex: args.point.entryIndex,
    replayNextStateIndex: args.point.nextStateIndex,
    actor: args.point.actor,
    round: args.point.state.roundNumber,
    legalActionCount: args.point.legalActions.length,
    selfActiveCharacterDefinitionId: activeCharacterDefinitionId(args.point.state, args.point.actor),
    oppActiveCharacterDefinitionId: activeCharacterDefinitionId(args.point.state, flipSide(args.point.actor)),
    queryNumericSlots,
    replayActionIndex: args.point.actualActionIndex,
    replayActionType:
      args.point.actualActionIndex != null
        ? args.point.legalActions[args.point.actualActionIndex]?.type ?? null
        : null,
    replayActionDefinitionKind:
      args.point.actualActionIndex != null
        ? actionDefinitionKind(args.point.legalActions[args.point.actualActionIndex])
        : null,
    replayActionDefinitionId:
      args.point.actualActionIndex != null
        ? actionDefinitionId(args.point.legalActions[args.point.actualActionIndex])
        : null,
    replayActionSkillDefinitionId:
      args.point.actualActionIndex != null
        ? skillDefinitionId(args.point.legalActions[args.point.actualActionIndex])
        : null,
    replayActionCardDefinitionId:
      args.point.actualActionIndex != null
        ? cardDefinitionId(args.point.legalActions[args.point.actualActionIndex])
        : null,
    replayActionCharacterDefinitionId:
      args.point.actualActionIndex != null
        ? characterDefinitionId(args.point.legalActions[args.point.actualActionIndex])
        : null,
    replayActorCharacterDefinitionId: actorCharacterDefinitionId(args.point.state, args.point.actor),
    replayActionTags:
      args.point.actualActionIndex != null
        ? normalizeTags(digest.candidate_actions[args.point.actualActionIndex]?.tags)
        : [],
    policySelectedActionIndex:
      decision.selectedCandidateId != null ? Number(decision.selectedCandidateId) : null,
    policySelectedActionType:
      decision.selectedCandidateId != null
        ? args.point.legalActions[Number(decision.selectedCandidateId)]?.type ?? null
        : null,
    branches,
  }
}

async function runContinuation(
  state: GameState,
  policyA: PolicyLike,
  policyB: PolicyLike,
): Promise<0 | 1 | null> {
  const game = new Game(state)
  const data = getData(CURRENT_VERSION)
  const ioA = new PolicyPlayerIO({
    side: 0,
    policy: policyA,
    searchOptions: { enabled: false },
  })
  const ioB = new PolicyPlayerIO({
    side: 1,
    policy: policyB,
    searchOptions: { enabled: false },
  })
  ioA.attachGameContext({ data, stateProvider: () => game.state })
  ioB.attachGameContext({ data, stateProvider: () => game.state })
  game.players[0].io = ioA
  game.players[1].io = ioB

  // 60-second timeout safety net — if the game loop hangs for any reason,
  // we recover with a draw instead of blocking the entire pipeline forever.
  const TIMEOUT_MS = 60_000
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      console.warn(`[runContinuation] Timeout after ${TIMEOUT_MS}ms, treating as draw`)
      resolve(null)
    }, TIMEOUT_MS)
  })

  try {
    return await Promise.race([game.start(), timeoutPromise])
  } catch (e) {
    console.warn(`[runContinuation] Game error:`, e)
    return null
  }
}

function stableStateSignature(state: GameState): string {
  return JSON.stringify(
    serializeGameStateLog([{ state, canResume: true }]),
  )
}

function actionDefinitionId(action: ActionInfoWithModification | undefined): number | null {
  if (!action) {
    return null
  }
  switch (action.type) {
    case "useSkill":
      return action.skill.definition.id
    case "playCard":
      return action.skill.caller.definition.id
    case "switchActive":
      return action.to.definition.id
    case "elementalTuning":
      return action.card.definition.id
    case "declareEnd":
      return 0
    default:
      return null
  }
}

function actionDefinitionKind(
  action: ActionInfoWithModification | undefined,
): "skill" | "card" | "character" | "none" | null {
  if (!action) {
    return null
  }
  switch (action.type) {
    case "useSkill":
      return "skill"
    case "playCard":
    case "elementalTuning":
      return "card"
    case "switchActive":
      return "character"
    case "declareEnd":
      return "none"
    default:
      return null
  }
}

function skillDefinitionId(action: ActionInfoWithModification | undefined): number | null {
  if (!action || action.type !== "useSkill") {
    return null
  }
  return action.skill.definition.id
}

function cardDefinitionId(action: ActionInfoWithModification | undefined): number | null {
  if (!action) {
    return null
  }
  switch (action.type) {
    case "playCard":
      return action.skill.caller.definition.id
    case "elementalTuning":
      return action.card.definition.id
    default:
      return null
  }
}

function characterDefinitionId(action: ActionInfoWithModification | undefined): number | null {
  if (!action || action.type !== "switchActive") {
    return null
  }
  return action.to.definition.id
}

function actorCharacterDefinitionId(
  state: GameState,
  actor: 0 | 1,
): number | null {
  return activeCharacterDefinitionId(state, actor)
}

function flipSide(side: 0 | 1): 0 | 1 {
  return side === 0 ? 1 : 0
}

function activeCharacterDefinitionId(
  state: GameState,
  side: 0 | 1,
): number | null {
  const player = state.players[side]
  const activeCharacter = player.characters.find((item) => item.id === player.activeCharacterId)
  return activeCharacter?.definition.id ?? null
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : []
}

function formatSummary(report: {
  matchupId: string
  sampleCount: number
  points: Array<{
    pointIndex: number
    round: number
    legalActionCount: number
    branches: Array<{
      actionIndex: number
      isPolicyChoice: boolean
      isReplayChoice: boolean
      continuation: { winRate: number }
    }>
  }>
}) {
  const lines = [
    `Branch eval matchup: ${report.matchupId}`,
    `Sampled points: ${report.sampleCount}`,
  ]

  for (const point of report.points) {
    lines.push(
      `point#${point.pointIndex} round=${point.round} legal=${point.legalActionCount}`,
    )
    for (const branch of point.branches) {
      const flags = [
        branch.isPolicyChoice ? "policy" : null,
        branch.isReplayChoice ? "replay" : null,
      ].filter(Boolean).join(",")
      lines.push(
        `  action=${branch.actionIndex}${flags ? ` [${flags}]` : ""} winRate=${(branch.continuation.winRate * 100).toFixed(2)}%`,
      )
    }
  }

  return lines.join("\n")
}

await main()
