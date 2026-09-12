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

import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CURRENT_VERSION,
  Game,
  serializeGameStateLog,
  type DeckConfig,
  type GameData,
  type GameState,
  type GameStateLogEntry,
  type PlayerIO,
  type Version,
} from "@gi-tcg/core"
import {
  ActionValidity,
  PbDiceType,
  type Notification,
  type RpcRequest,
  type RpcResponse,
  createRpcResponse,
} from "@gi-tcg/typings"
import type { SampleRecord } from "../../db/data-lake.js"
import {
  SelfPlayRlRecorder,
} from "../rl/self-play-recorder.js"
import type {
  ObservationViewKindV1,
  RewardConfigV1,
  SelfPlayRlGameCaptureV1,
} from "@gi-tcg/ml/contracts"
import { FeatureExtractor } from "../../learning/scoring/feature-extractor.js"
import { extractPreviewVector, type PreviewMutationVector } from "../fingerprint/preview-vector.js"
import { FeatureExtension } from "../scoring/feature-extension.js"
import type { FingerprintLake } from "../fingerprint/fingerprint-lake.js"
import { StateExporter } from "../encoder/state-exporter.js"
import type { StateObservation } from "../encoder/state-observation.js"
import { buildPolicyTurnDigest } from "../../runtime/policy/candidate-semantics.js"
import type { BaselinePolicy } from "../../runtime/policy/baseline-policy.js"
import type { EvaluatorPolicy } from "../../runtime/policy/evaluator-policy.js"
import type { PolicyCandidateAction, PolicyDecision, PolicyTurnDigest } from "../../runtime/policy/types.js"
import {
  StrategicPlanStateMachine,
  type PlanPhase,
  type PlanUpdateInput,
} from "../../runtime/plan/index.js"

// ── Mulligan Prior Helpers ──

interface MulliganPriorsFile {
  version: number
  perDeck: Record<string, {
    deckChars: number[]
    cards: Record<number, {
      keepWins: number; keepTotal: number; keepWinrate: number
      replaceWins: number; replaceTotal: number; replaceWinrate: number
      delta: number; confident: boolean
    }>
    combos: Array<{
      cardIds: [number, number]; jointWinrate: number
      expectedProduct: number; synergy: number; confident: boolean
    }>
  }>
}

let _mulliganPriorsCache: MulliganPriorsFile | null = null
let _mulliganPriorsLoaded = false

function loadMulliganPriors(): MulliganPriorsFile | null {
  if (_mulliganPriorsLoaded) return _mulliganPriorsCache
  _mulliganPriorsLoaded = true
  try {
    // Try artifacts directory first (bundled in Docker image)
    const fs = require("node:fs")
    const path = require("node:path")
    const candidates = [
      "/app/artifacts/mulligan-priors.json",
      "/app/v15-artifacts/mulligan-priors.json",
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        _mulliganPriorsCache = JSON.parse(fs.readFileSync(p, "utf-8"))
        return _mulliganPriorsCache
      }
    }
  } catch {
    // Not available
  }
  _mulliganPriorsCache = null
  return null
}

type PolicyLike = Pick<BaselinePolicy | EvaluatorPolicy, "choose">

export interface SelfPlaySide {
  name: string
  createPolicy: () => PolicyLike
  /** SPL: PlanPhase[] for this side's deck (null if SPL not used) */
  planPhases?: PlanPhase[] | null
}

export interface SelfPlayMatchup {
  id: string
  decks: readonly [DeckConfig, DeckConfig]
  games: number
  sideA: SelfPlaySide
  sideB: SelfPlaySide
}

export interface SelfPlayCollectorConfig {
  dbPath?: string
  data: GameData
  matchups: SelfPlayMatchup[]
  source?: "self_play" | "human_critic"
  replayLogCapture?: {
    directory: string
    maxGamesPerMatchup: number
    version?: Version
  }
  rlCapture?: {
    directory: string
    modelVersion: string
    viewKind?: ObservationViewKindV1
    rewardConfig?: RewardConfigV1
    gameVersion?: string
    cardPoolVersion?: string
    rulesetVersion?: string
    contractVersion?: string
  }
  /**
   * V30 Stage 2.E — When provided, each collected sample also carries a
   * FeatureExtension flat array (PreviewMutationVector + Fingerprint) for
   * extension-aware training. The lake is required to enrich fingerprint
   * dims; if absent fingerprint dims are zeroed.
   */
  featureExtension?: {
    enabled: boolean
    fingerprintLake?: import("../fingerprint/fingerprint-lake.js").FingerprintLake | null
  }
  /**
   * V30 Stage 3 — When provided, each collected sample additionally carries
   * a `StateObservation` (variable-length entity-set view) for the encoder
   * pipeline. Captures the same redacted notification view available to the
   * policy, so no hidden information leaks. Independent from `featureExtension`.
   */
  stateObservation?: {
    enabled: boolean
  }
  onGameComplete?: (event: {
    matchupId: string
    gameIndex: number
    totalGames: number
    winner: 0 | 1 | null
    insertedSamples: number
    replayPath?: string
    rlCapturePath?: string
  }) => void
}

export interface SelfPlayMatchupCollectionResult {
  matchupId: string
  games: number
  insertedSamples: number
  skippedSamples: number
}

export interface SelfPlayCollectionResult {
  totalGames: number
  insertedSamples: number
  skippedSamples: number
  matchups: SelfPlayMatchupCollectionResult[]
}

interface PendingSample {
  round: number
  turn: number
  actionCase: string
  features: number[]
  /** V30 Stage 2.E — optional FeatureExtension flat array (preview + fingerprint). */
  featuresExt?: number[] | null
  /** V30 Stage 3 — optional captured StateObservation. */
  stateObservation?: StateObservation | null
}

export class SelfPlayCollector {
  private readonly extractor = new FeatureExtractor()

  async collect(config: SelfPlayCollectorConfig): Promise<SelfPlayCollectionResult> {
    const lake = config.dbPath
      ? new (await import("../../db/data-lake.js")).DataLake(config.dbPath)
      : null
    const source = config.source ?? "self_play"

    try {
      const matchupResults: SelfPlayMatchupCollectionResult[] = []
      let totalGames = 0
      let insertedSamples = 0
      let skippedSamples = 0

      for (const matchup of config.matchups) {
        let matchupInserted = 0
        let matchupSkipped = 0

        for (let i = 0; i < matchup.games; i++) {
          const gameId = `${matchup.id}-${i + 1}-${randomUUID()}`
          const episodeId = gameId
          const rlRecorder0 = config.rlCapture
            ? new SelfPlayRlRecorder({
                gameId,
                episodeId,
                side: 0,
                modelVersion: config.rlCapture.modelVersion,
                viewKind: config.rlCapture.viewKind,
                rewardConfig: config.rlCapture.rewardConfig,
                gameVersion: config.rlCapture.gameVersion,
                cardPoolVersion: config.rlCapture.cardPoolVersion,
                rulesetVersion: config.rlCapture.rulesetVersion,
                contractVersion: config.rlCapture.contractVersion,
              })
            : undefined
          const rlRecorder1 = config.rlCapture
            ? new SelfPlayRlRecorder({
                gameId,
                episodeId,
                side: 1,
                modelVersion: config.rlCapture.modelVersion,
                viewKind: config.rlCapture.viewKind,
                rewardConfig: config.rlCapture.rewardConfig,
                gameVersion: config.rlCapture.gameVersion,
                cardPoolVersion: config.rlCapture.cardPoolVersion,
                rulesetVersion: config.rlCapture.rulesetVersion,
                contractVersion: config.rlCapture.contractVersion,
              })
            : undefined
          const io0 = new RecordingPolicyPlayerIO({
            side: 0,
            policy: matchup.sideA.createPolicy(),
            extractor: this.extractor,
            rlRecorder: rlRecorder0,
            planPhases: matchup.sideA.planPhases ?? null,
            gameData: config.data,
            extensionEnabled: config.featureExtension?.enabled ?? false,
            fingerprintLake: config.featureExtension?.fingerprintLake ?? null,
            stateObservationEnabled: config.stateObservation?.enabled ?? false,
            gameId,
          })
          const io1 = new RecordingPolicyPlayerIO({
            side: 1,
            policy: matchup.sideB.createPolicy(),
            extractor: this.extractor,
            rlRecorder: rlRecorder1,
            planPhases: matchup.sideB.planPhases ?? null,
            gameData: config.data,
            extensionEnabled: config.featureExtension?.enabled ?? false,
            fingerprintLake: config.featureExtension?.fingerprintLake ?? null,
            stateObservationEnabled: config.stateObservation?.enabled ?? false,
            gameId,
          })

          const game = new Game(
            Game.createInitialState({
              decks: matchup.decks,
              data: config.data,
            }),
          )
          const captureReplay = i < (config.replayLogCapture?.maxGamesPerMatchup ?? 0)
          const stateLog: GameStateLogEntry[] = []
          if (captureReplay || config.rlCapture) {
            game.onPause = async (state, _mutations, canResume) => {
              if (captureReplay) {
                stateLog.push({ state, canResume })
              }
              io0.settleRlState(state, state.phase === "gameEnd" ? state.winner : undefined)
              io1.settleRlState(state, state.phase === "gameEnd" ? state.winner : undefined)
            }
          }
          game.players[0].io = io0
          game.players[1].io = io1
          const winner = (await game.start()) as 0 | 1 | null

          // Save mulligan stats if both sides recorded
          if (config.rlCapture?.directory && io0.getMulliganRecord() && io1.getMulliganRecord()) {
            const m0 = io0.getMulliganRecord()!
            const m1 = io1.getMulliganRecord()!
            const mulliganPath = join(
              config.rlCapture.directory,
              `mulligan-${matchup.id}-${String(i + 1).padStart(3, "0")}-${formatWinner(winner)}.json`,
            )
            await mkdir(config.rlCapture.directory, { recursive: true })
            await writeFile(
              mulliganPath,
              JSON.stringify({
                matchupId: matchup.id,
                gameIndex: i + 1,
                winner,
                decks: matchup.decks.map(d => d.characters?.map((c: any) => c.definitionId ?? c.id) ?? []),
                side0: { handDefIds: m0.handDefIds, keptDefIds: m0.keptDefIds, replacedDefIds: m0.replacedDefIds },
                side1: { handDefIds: m1.handDefIds, keptDefIds: m1.keptDefIds, replacedDefIds: m1.replacedDefIds },
              }),
            )
          }

          const replayPath =
            captureReplay && config.replayLogCapture
              ? await saveReplayLog({
                  directory: config.replayLogCapture.directory,
                  matchupId: matchup.id,
                  gameIndex: i + 1,
                  winner,
                  version: config.replayLogCapture.version ?? CURRENT_VERSION,
                  stateLog,
                })
              : undefined
          const rlCapturePath =
            config.rlCapture && rlRecorder0 && rlRecorder1
              ? await saveRlCapture({
                  directory: config.rlCapture.directory,
                  matchupId: matchup.id,
                  gameIndex: i + 1,
                  winner,
                  capture: {
                    schema_version: "self_play_rl.v1",
                    game_id: gameId,
                    episode_id: episodeId,
                    matchup_id: matchup.id,
                    winner,
                    sides: [rlRecorder0.exportCapture(), rlRecorder1.exportCapture()],
                  },
                })
              : undefined

          const records = buildSampleRecords({
            gameId,
            winner,
            sides: [
              { side: 0, samples: io0.takeSamples() },
              { side: 1, samples: io1.takeSamples() },
            ],
            source,
          })

          if (records.length > 0) {
            lake?.insertBatch(records)
            insertedSamples += records.length
            matchupInserted += records.length
          }

          const discarded = io0.sampleCount + io1.sampleCount - records.length
          skippedSamples += discarded
          matchupSkipped += discarded
          totalGames += 1

          config.onGameComplete?.({
            matchupId: matchup.id,
            gameIndex: i + 1,
            totalGames: matchup.games,
            winner,
            insertedSamples: records.length,
            ...(replayPath ? { replayPath } : {}),
            ...(rlCapturePath ? { rlCapturePath } : {}),
          })
        }

        matchupResults.push({
          matchupId: matchup.id,
          games: matchup.games,
          insertedSamples: matchupInserted,
          skippedSamples: matchupSkipped,
        })
      }

      return {
        totalGames,
        insertedSamples,
        skippedSamples,
        matchups: matchupResults,
      }
    } finally {
      lake?.close()
    }
  }
}

async function saveReplayLog(args: {
  directory: string
  matchupId: string
  gameIndex: number
  winner: 0 | 1 | null
  version: Version
  stateLog: readonly GameStateLogEntry[]
}): Promise<string> {
  const matchupDir = join(args.directory, sanitizePathSegment(args.matchupId))
  await mkdir(matchupDir, { recursive: true })
  const replayPath = join(
    matchupDir,
    `game-${String(args.gameIndex).padStart(4, "0")}-${formatWinner(args.winner)}.json`,
  )
  await writeFile(
    replayPath,
    `${JSON.stringify({
      ...serializeGameStateLog(args.stateLog),
      gv: args.version,
    })}\n`,
    "utf8",
  )
  return replayPath
}

async function saveRlCapture(args: {
  directory: string
  matchupId: string
  gameIndex: number
  winner: 0 | 1 | null
  capture: SelfPlayRlGameCaptureV1
}): Promise<string> {
  const matchupDir = join(args.directory, sanitizePathSegment(args.matchupId))
  await mkdir(matchupDir, { recursive: true })
  const capturePath = join(
    matchupDir,
    `game-${String(args.gameIndex).padStart(4, "0")}-${formatWinner(args.winner)}.rl.json`,
  )
  await writeFile(capturePath, `${JSON.stringify(args.capture)}\n`, "utf8")
  return capturePath
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
}

function formatWinner(winner: 0 | 1 | null): string {
  if (winner === 0) return "p0"
  if (winner === 1) return "p1"
  return "draw"
}

class RecordingPolicyPlayerIO implements PlayerIO {
  private readonly side: 0 | 1
  private readonly policy: PolicyLike
  private readonly extractor: FeatureExtractor
  private readonly rlRecorder?: SelfPlayRlRecorder
  private latestNotificationState?: Notification["state"]
  private latestGameState?: GameState
  private readonly pendingSamples: PendingSample[] = []
  private readonly gameData?: GameData
  /** V30 Stage 2.E — when true, also record FeatureExtension array per sample. */
  private readonly extensionEnabled: boolean
  private readonly fingerprintLake: import("../fingerprint/fingerprint-lake.js").FingerprintLake | null
  /** V30 Stage 3 — when true, also record a StateObservation per sample. */
  private readonly stateObservationEnabled: boolean
  private readonly gameId: string
  private observationCounter = 0
  /**
   * V31 F6 / D7 (schema v3) — first-mover latched from the engine on the
   * earliest action-phase notification. Carried into every StateExporter call
   * for this game so `SideObservation.is_first_player` is consistent across
   * the whole trajectory (and across both perspectives).
   */
  private firstPlayer: 0 | 1 | null = null
  /** Mulligan tracking: hand cards seen and which were kept */
  private mulliganRecord?: {
    handDefIds: number[]
    keptDefIds: number[]
    replacedDefIds: number[]
  }

  /** SPL: Strategic Plan State Machine (null if SPL not used) */
  private readonly planStateMachine: StrategicPlanStateMachine | null = null

  constructor(options: {
    side: 0 | 1
    policy: PolicyLike
    extractor: FeatureExtractor
    rlRecorder?: SelfPlayRlRecorder
    planPhases?: PlanPhase[] | null
    gameData?: GameData
    /** V30 Stage 2.E — capture FeatureExtension flat array per sample. */
    extensionEnabled?: boolean
    fingerprintLake?: import("../fingerprint/fingerprint-lake.js").FingerprintLake | null
    /** V30 Stage 3 — capture StateObservation per sample. */
    stateObservationEnabled?: boolean
    gameId?: string
  }) {
    this.side = options.side
    this.policy = options.policy
    this.extractor = options.extractor
    this.rlRecorder = options.rlRecorder
    this.gameData = options.gameData
    this.extensionEnabled = options.extensionEnabled ?? false
    this.fingerprintLake = options.fingerprintLake ?? null
    this.stateObservationEnabled = options.stateObservationEnabled ?? false
    this.gameId = options.gameId ?? "unknown"
    if (options.planPhases && options.planPhases.length > 0) {
      this.planStateMachine = new StrategicPlanStateMachine(options.planPhases)
    }
  }

  get sampleCount(): number {
    return this.pendingSamples.length
  }

  notify(notification: Notification) {
    this.latestNotificationState = notification.state
    // V31 F6 / D7: latch first-mover at the earliest action-phase view of round 1.
    // PbGameState.phase === 3 (action) per the StateExporter phase map; PbGameState
    // .currentTurn is the engine `who` field. Once latched it stays for the game.
    if (
      this.firstPlayer === null &&
      notification.state?.phase === 3 &&
      (notification.state.roundNumber ?? 0) <= 1 &&
      typeof notification.state.currentTurn === "number"
    ) {
      this.firstPlayer = (notification.state.currentTurn & 1) as 0 | 1
    }
    this.rlRecorder?.notify(notification)
    // V30 Stage 3.G — forward latest notification to policies that need it
    // for runtime-side state-observation building (e.g. NeuralEvaluatorPolicy).
    const policyAny = this.policy as { setLatestNotification?: (s: Notification["state"]) => void }
    if (typeof policyAny.setLatestNotification === "function") {
      policyAny.setLatestNotification(notification.state)
    }
  }

  takeSamples(): PendingSample[] {
    return [...this.pendingSamples]
  }

  settleRlState(state: GameState, winner?: 0 | 1 | null): void {
    this.latestGameState = state
    this.rlRecorder?.settlePending(state, winner)
  }

  getMulliganRecord() {
    return this.mulliganRecord
  }

  async rpc(request: RpcRequest): Promise<RpcResponse> {
    const rpc = request.request
    if (!rpc) {
      throw new Error("Missing RPC request envelope")
    }

    switch (rpc.$case) {
      case "action": {
        const selection = this.chooseAction(rpc.value.action)
        this.rlRecorder?.recordResolvedRpc(request, {
          selectedActionIndex: selection.chosenActionIndex,
          policyDecision: selection.policyDecision,
        })
        return createRpcResponse("action", {
          chosenActionIndex: selection.chosenActionIndex,
          usedDice: selection.usedDice,
        })
      }
      case "chooseActive": {
        const activeCharacterId = this.chooseActiveRandomly(rpc.value.candidateIds)
        this.rlRecorder?.recordResolvedRpc(request, { activeCharacterId })
        return createRpcResponse("chooseActive", {
          activeCharacterId,
        })
      }
      case "switchHands": {
        const handDefIds = (rpc.value as any).handCardDefinitionIds as number[] ?? []
        const handEntityIds = (rpc.value as any).handCardEntityIds as number[] ?? []
        const removedIds = this.getCardsToMulligan(handDefIds, handEntityIds)
        const removedSet = new Set(removedIds)
        const keptDefIds: number[] = []
        const replacedDefIds: number[] = []
        for (let i = 0; i < handDefIds.length; i++) {
          if (removedSet.has(handEntityIds[i])) {
            replacedDefIds.push(handDefIds[i])
          } else {
            keptDefIds.push(handDefIds[i])
          }
        }
        this.mulliganRecord = { handDefIds, keptDefIds, replacedDefIds }
        this.rlRecorder?.recordResolvedRpc(request, {})
        return createRpcResponse("switchHands", {
          removedHandIds: removedIds,
        })
      }
      case "rerollDice": {
        this.rlRecorder?.recordResolvedRpc(request, {})
        return createRpcResponse("rerollDice", {
          diceToReroll: this.getDiceToReroll(),
        })
      }
      case "selectCard": {
        const selectedDefinitionId = rpc.value.candidateDefinitionIds[0] ?? 0
        this.rlRecorder?.recordResolvedRpc(request, { selectedDefinitionId })
        return createRpcResponse("selectCard", {
          selectedDefinitionId,
        })
      }
      default: {
        const _exhaustive: never = rpc
        throw new Error(`Unsupported RPC method: ${String(_exhaustive)}`)
      }
    }
  }

  private chooseAction(actions: readonly RpcAction[]): {
    chosenActionIndex: number
    usedDice: PbDiceType[]
    policyDecision: PolicyDecision | null
  } {
    const validActions = actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.validity === ActionValidity.VALID)

    if (validActions.length === 0) {
      const fallback = actions[0]
      return {
        chosenActionIndex: 0,
        usedDice: fallback?.autoSelectedDice ?? [],
        policyDecision: null,
      }
    }

    const digest = this.buildDigest(validActions)

    // Always provide stateProvider so MCTS policies can access game state.
    const latestState = this.latestGameState
    const stateProvider = latestState
      ? () => latestState
      : undefined

    // SPL: update state machine and build plan context
    let planContext: any = stateProvider
      ? { stateProvider }
      : undefined
    if (this.planStateMachine && this.latestNotificationState) {
      const input = buildPlanUpdateInputFromState(this.latestNotificationState, this.side)
      const splContext = this.planStateMachine.update(input)
      planContext = {
        observation: null,
        macroPlanState: null,
        gamePlanState: null,
        opponentModelState: null,
        actionBanList: splContext.actionBanList,
        threatBonusMap: splContext.threatBonusMap,
        diceBudget: splContext.diceBudget,
        primaryPatterns: splContext.primaryPatterns,
        primaryMatchBonus: 2.0,
        splPreFiltered: false,
        stateProvider, // needed for MCTS policies
      }
    }

    let decision = this.policy.choose(digest, planContext)
    let selected =
      validActions.find(
        ({ index }) => String(index) === decision.selectedCandidateId,
      ) ?? validActions[0]

    let selectedCandidate: PolicyCandidateAction | undefined =
      digest.candidate_actions.find(
        (candidate) => candidate.candidate_id === String(selected.index),
      ) ?? digest.candidate_actions[0]

    // ── P0: hard constraint — forbid declareEnd in R1-R2 ──
    // Override at the IO level so NO policy code path can leak declareEnd
    // in early rounds during self-play.
    const currentRound = this.latestNotificationState?.roundNumber ?? 999
    if (currentRound <= 2 && selectedCandidate?.action_case === "declareEnd") {
      // Find the best non-declareEnd action
      const nonDeEnd = validActions.filter(({ index }) => {
        const cand = digest.candidate_actions.find(
          (c) => c.candidate_id === String(index),
        )
        return cand && cand.action_case !== "declareEnd"
      })
      if (nonDeEnd.length > 0) {
        selected = nonDeEnd[0]
        selectedCandidate = digest.candidate_actions.find(
          (c) => c.candidate_id === String(selected.index),
        )
        // Also patch the policyDecision so the RL recorder sees the corrected choice.
        if (selectedCandidate && decision.selectedCandidateId !== selectedCandidate.candidate_id) {
          decision = {
            ...decision,
            selectedCandidateId: selectedCandidate.candidate_id ?? null,
          }
        }
      }
    }

    if (selectedCandidate) {
      const features = FeatureExtractor.toArray(
        this.extractor.extract(digest, selectedCandidate),
      )
      let featuresExt: number[] | null = null
      if (this.extensionEnabled) {
        const visibleState = this.latestNotificationState
        const selfIds = visibleState ? collectVisiblePlayerIds(visibleState.player[this.side]) : new Set<number>()
        const oppIds = visibleState ? collectVisiblePlayerIds(visibleState.player[1 - this.side as 0 | 1]) : new Set<number>()
        featuresExt = buildSampleExtension(selectedCandidate, this.fingerprintLake, this.side, selfIds, oppIds)
      }
      let stateObservation: StateObservation | null = null
      if (this.stateObservationEnabled && this.latestNotificationState) {
        try {
          const exported = StateExporter.export({
            notificationState: this.latestNotificationState,
            perspective: this.side,
            validActions,
            gameId: this.gameId,
            sampleIndex: this.observationCounter++,
            firstPlayer: this.firstPlayer ?? this.side,
          })
          // Mark which candidate was chosen.
          const chosenCandidateId = String(selected.index)
          const idx = exported.candidateIndexById.get(chosenCandidateId)
          if (typeof idx === "number") {
            exported.observation.selected_action_index = idx
          }
          stateObservation = exported.observation
        } catch {
          stateObservation = null
        }
      }
      this.pendingSamples.push({
        round: digest.round,
        turn: digest.turn,
        actionCase: String(selectedCandidate.action_case ?? "unknown"),
        features,
        featuresExt,
        stateObservation,
      })
    }

    return {
      chosenActionIndex: selected.index,
      usedDice: selected.action.autoSelectedDice,
      policyDecision: decision,
    }
  }

  private getDiceToReroll(): PbDiceType[] {
    const state = this.latestNotificationState
    const self = state?.player[this.side]
    if (!self) {
      return []
    }

    // Collect elements of all alive characters — keep dice matching ANY of them.
    const neededElements = new Set<number>()
    for (const ch of self.character) {
      if (!ch.defeated) {
        const elementDigit = Math.floor((ch.definitionId % 1000) / 100)
        if (elementDigit >= 1 && elementDigit <= 7) {
          neededElements.add(elementDigit)
        }
      }
    }

    return self.dice.filter(
      (die) =>
        die !== PbDiceType.OMNI &&
        die !== 0 &&
        !neededElements.has(die),
    )
  }

  /**
   * Q1 fix v2: 训练时随机选择出战角色，让模型从数据中学习最佳选择。
   */
  private chooseActiveRandomly(candidateIds: readonly number[]): number {
    if (candidateIds.length <= 1) {
      return candidateIds[0] ?? 0
    }
    const idx = Math.floor(Math.random() * candidateIds.length)
    return candidateIds[idx] ?? candidateIds[0] ?? 0
  }

  private buildDigest(
    actions: Array<{ action: RpcAction; index: number }>,
  ): PolicyTurnDigest {
    return buildPolicyTurnDigest(this.latestNotificationState, this.side, actions)
  }

  /**
   * Smart mulligan: use learned priors if available, otherwise fall back to cost heuristic.
   * Replaces cards with low keep-winrate or high dice cost.
   */
  private getCardsToMulligan(handDefIds: number[], handEntityIds: number[]): number[] {
    if (handEntityIds.length === 0) return []

    // Extract deck characters from state
    const state = this.latestNotificationState
    const self = state?.player[this.side]
    const charDefIds = (self?.character ?? []).map((c: any) => c.definitionId ?? c.id ?? 0).filter((id: number) => id > 0)
    const deckHash = charDefIds.length > 0 ? [...charDefIds].sort((a, b) => a - b).join(",") : null

    // Try learned priors
    const priors = loadMulliganPriors()
    const deckPriors = deckHash ? priors?.perDeck[deckHash] : undefined

    if (deckPriors) {
      // Build a scoring map for each hand card
      const cardScores: Array<{ entityId: number; defId: number; score: number; keep: boolean }> = []
      const keptDefIds = new Set<number>()

      // Phase 1: determine which cards to tentatively keep based on single-card stats
      for (let i = 0; i < handDefIds.length; i++) {
        const defId = handDefIds[i]
        const entityId = handEntityIds[i]
        const cs = deckPriors.cards[defId]
        let keep = false
        let score = 0

        if (cs && cs.confident && cs.delta > 0) {
          // Priors say keeping this card is better
          keep = true
          score = cs.delta
        }

        if (keep) {
          keptDefIds.add(defId)
        }
        cardScores.push({ entityId, defId, score, keep })
      }

      // Phase 2: boost cards that participate in confident combos with kept cards
      for (const combo of deckPriors.combos) {
        if (!combo.confident || combo.synergy <= 0) continue
        const [a, b] = combo.cardIds
        // If one of the pair is kept and the other is in hand, boost the other
        if (keptDefIds.has(a) || keptDefIds.has(b)) {
          const targetDefId = keptDefIds.has(a) ? b : a
          const entry = cardScores.find(c => c.defId === targetDefId)
          if (entry && !entry.keep) {
            entry.score += combo.synergy
            if (entry.score > 0) {
              entry.keep = true
              keptDefIds.add(targetDefId)
            }
          }
        }
      }

      const toRemove: number[] = []
      for (const c of cardScores) {
        if (!c.keep) {
          toRemove.push(c.entityId)
        }
      }

      if (toRemove.length > 0) {
        return toRemove
      }
      // If priors say keep everything, still apply cost heuristic for expensive cards
    }

    // Fallback: cost >= 3 heuristic
    const entities = this.gameData?.entities
    if (!entities) return handEntityIds

    const toRemove: number[] = []
    for (let i = 0; i < handDefIds.length; i++) {
      const entityDef = entities.get(handDefIds[i])
      if (!entityDef) continue
      const diceCost = (entityDef.skills[0] as any)?.computed$diceCostSize ?? 0
      if (diceCost >= 3) {
        toRemove.push(handEntityIds[i])
      }
    }
    return toRemove
  }
}

function buildSampleRecords(args: {
  gameId: string
  winner: 0 | 1 | null
  sides: Array<{ side: 0 | 1; samples: PendingSample[] }>
  source: "self_play" | "human_critic"
}): SampleRecord[] {
  if (args.winner == null) {
    return []
  }

  const allSamples = args.sides.flatMap((s) => s.samples)

  // V30 Stage 3 — Genius-Invokation-aware sample weighting.
  //
  // Replaces the legacy "early-round = more important" formula with a
  // structure that matches the game's actual signal-to-noise distribution:
  //
  //   1. CREDIT DECAY (against R7 — 80 actions share one terminal label):
  //      An action's contribution to win/loss is approximated by its
  //      proximity to the terminal step. Decisions far from the end have
  //      weaker causal links to outcome; decisions near the end (lethal,
  //      cash-in burst, decisive declareEnd) carry the actual signal.
  //      We use exponential decay credit = exp(-(1 - turn/maxTurn) * 1.5).
  //
  //   2. R1 PENALTY (against R1+R4a — coin flip + first-roll luck):
  //      Round 1 outcomes are dominated by the coin flip and initial roll.
  //      Down-weight R1 samples to ~0.6 so the encoder doesn't over-fit
  //      "this hand on R1 ⇒ win" patterns.
  //      R2+ first-player is a STRATEGIC consequence of the previous round's
  //      declareEnd timing — we KEEP that signal at full weight.
  //
  //   3. ROLE FACTOR (winner vs loser): kept at the legacy 1.0 / 0.8 ratio.
  //
  // Full weight = clamp(credit × r1Penalty × roleFactor, 0.2, 1.5)
  //
  // Empirically the weight range 0.2-1.5 is similar to the legacy 0.3-1.5,
  // so trained intercept / scale don't drift drastically between formulations.

  const samplesByGameTurn = allSamples
    .map((s) => s.turn)
    .sort((a, b) => a - b)
  const maxTurn = samplesByGameTurn.length > 0
    ? samplesByGameTurn[samplesByGameTurn.length - 1]
    : 1

  const records: SampleRecord[] = []
  for (const side of args.sides) {
    for (const sample of side.samples) {
      const isWinner = args.winner === side.side
      const roleFactor = isWinner ? 1.0 : 0.8

      // 1. credit decay: distance-from-end ∈ [0, 1], 0 = last action of game
      const distFromEnd = maxTurn > 0
        ? Math.max(0, 1 - sample.turn / maxTurn)
        : 0
      const credit = Math.exp(-distFromEnd * 1.5)

      // 2. R1 penalty: coin flip dominates R1 outcomes
      const r1Penalty = sample.round === 1 ? 0.6 : 1.0

      const weight = clamp(credit * r1Penalty * roleFactor, 0.2, 1.5)

      records.push({
        gameId: args.gameId,
        round: sample.round,
        turn: sample.turn,
        player: side.side,
        actionCase: sample.actionCase,
        features: sample.features,
        featuresExt: sample.featuresExt ?? null,
        stateObservation: sample.stateObservation ?? null,
        label: isWinner ? 1 : 0,
        source: args.source,
        weight: Math.round(weight * 1000) / 1000,
      })
    }
  }
  return records
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * V30 Stage 2.E — Build a FeatureExtension flat array for one self-play sample.
 *
 * Reads `preview_data` (PreviewData[]) and `skill_definition_id` /
 * `card_definition_id` from the candidate (transparently passed through by
 * candidate-semantics.ts), constructs a PreviewMutationVector + Fingerprint
 * pair, then returns the concatenated flat numeric array. When fields are
 * missing the corresponding dims are zeroed.
 */
function buildSampleExtension(
  candidate: import("../../runtime/policy/types.js").PolicyCandidateAction,
  lake: FingerprintLake | null,
  perspective: 0 | 1,
  selfIds: ReadonlySet<number>,
  opponentIds: ReadonlySet<number>,
): number[] {
  const previewData = candidate.preview_data as
    | ReadonlyArray<import("@gi-tcg/typings").PreviewData>
    | null
    | undefined

  let previewVector: PreviewMutationVector | null = null
  if (previewData && previewData.length > 0) {
    previewVector = extractPreviewVector(previewData, {
      perspective,
      selfIds,
      opponentIds,
    })
  }

  const skillId = candidate.skill_definition_id
  const cardId = candidate.card_definition_id
  const primaryDefinitionId =
    typeof skillId === "number"
      ? skillId
      : typeof cardId === "number"
        ? cardId
        : null

  const ext = FeatureExtension.extract({
    previewVector,
    primaryDefinitionId,
    lake: lake ?? null,
  })
  return FeatureExtension.toArray(ext)
}

/** V30 Stage 2.E — collect visible entity IDs from a notification's player view. */
function collectVisiblePlayerIds(
  player: NonNullable<Notification["state"]>["player"][number] | undefined,
): Set<number> {
  const ids = new Set<number>()
  if (!player) return ids
  for (const ch of player.character ?? []) {
    if (typeof ch.id === "number") ids.add(ch.id)
  }
  for (const s of player.summon ?? []) {
    if (typeof s.id === "number") ids.add(s.id)
  }
  for (const s of player.support ?? []) {
    if (typeof s.id === "number") ids.add(s.id)
  }
  for (const s of player.combatStatus ?? []) {
    if (typeof s.id === "number") ids.add(s.id)
  }
  return ids
}

type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number]

// ── SPL helper ──

function buildPlanUpdateInputFromState(
  notificationState: Notification["state"],
  side: 0 | 1,
): PlanUpdateInput {
  const self = notificationState?.player[side]
  const opponent = notificationState?.player[side === 0 ? 1 : 0]

  const selfChars = (self?.character ?? []).map((ch) => ({
    id: ch.id,
    hp: ch.health,
    maxHp: ch.maxHealth,
    energy: ch.energy,
    maxEnergy: ch.maxEnergy,
    defeated: ch.defeated,
    definitionId: ch.definitionId,
  }))

  const oppChars = (opponent?.character ?? []).map((ch) => ({
    id: ch.id,
    hp: ch.health,
    maxHp: ch.maxHealth,
    energy: ch.energy,
    maxEnergy: ch.maxEnergy,
    defeated: ch.defeated,
    definitionId: ch.definitionId,
  }))

  const summons = (self?.summon ?? []).map((s) => ({ characterId: s.definitionId }))

  const dice: Record<string, number> = {}
  for (const d of self?.dice ?? []) {
    const key = String(d)
    dice[key] = (dice[key] ?? 0) + 1
  }

  const handCardIds = (self?.handCard ?? []).map((c) => c.definitionId)

  return {
    round: notificationState?.roundNumber ?? 1,
    selfCharacters: selfChars,
    opponentCharacters: oppChars,
    summons,
    dice,
    handCardIds,
  }
}
