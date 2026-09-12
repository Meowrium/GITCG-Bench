// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core"
import type { Notification, RpcRequest } from "@gi-tcg/typings"
import type { PolicyDecision } from "../../runtime/policy/types.js"
import {
  buildDecisionPointV1FromRpcRequest,
} from "./candidate-exporter.js"
import {
  buildObservationV1FromGameState,
  buildObservationV1FromVisibleState,
} from "./observation-exporter.js"
import {
  computeRewardBreakdownV1,
  DEFAULT_REWARD_CONFIG_V1,
} from "./reward-config.js"
import { buildDecisionPointLogV1 } from "./training-protocol.js"
import type {
  ActionRouteV1,
  DecisionPointLogV1,
  DecisionPointV1,
  ObservationViewKindV1,
  ObservationV1,
  RewardConfigV1,
  SelfPlayRlSideCaptureV1,
} from "@gi-tcg/ml/contracts"

type VisibleState = NonNullable<Notification["state"]>

export interface SelfPlayRlRecorderOptions {
  gameId: string
  episodeId: string
  side: 0 | 1
  modelVersion: string
  viewKind?: ObservationViewKindV1
  rewardConfig?: RewardConfigV1
  gameVersion?: string
  cardPoolVersion?: string
  rulesetVersion?: string
  contractVersion?: string
}

export interface SelfPlayRlSelectionInput {
  selectedActionIndex?: number
  policyDecision?: PolicyDecision | null
  activeCharacterId?: number
  selectedDefinitionId?: number
}

interface PendingDecisionRecord {
  observation: ObservationV1
  decisionPoint: DecisionPointV1
  candidateScores: number[]
  selectedCandidateId: string | null
  selectedRoute: ActionRouteV1
}

export class SelfPlayRlRecorder {
  private readonly options: SelfPlayRlRecorderOptions
  private latestVisibleState?: VisibleState
  private decisionCounter = 0
  private trackedRound = 0
  private actionCountInRound = 0
  private readonly pending: PendingDecisionRecord[] = []
  private readonly observations: ObservationV1[] = []
  private readonly decisionPoints: DecisionPointV1[] = []
  private readonly transitionObservations: ObservationV1[] = []
  private readonly decisionLogs: DecisionPointLogV1[] = []

  constructor(options: SelfPlayRlRecorderOptions) {
    this.options = options
  }

  notify(notification: Notification): void {
    if (notification.state) {
      this.latestVisibleState = notification.state as VisibleState
    }
  }

  recordResolvedRpc(request: RpcRequest, selection: SelfPlayRlSelectionInput = {}): void {
    const rpc = request.request
    if (!rpc || !this.latestVisibleState) {
      return
    }

    if (this.latestVisibleState.roundNumber !== this.trackedRound) {
      this.trackedRound = this.latestVisibleState.roundNumber
      this.actionCountInRound = 0
    }

    const decisionPointId = this.buildDecisionPointId()
    const observationRef = `obs://${this.options.gameId}/${decisionPointId}`
    const viewKind = this.options.viewKind ?? "policy_public"
    const observation = buildObservationV1FromVisibleState(this.latestVisibleState, this.options.side, {
      gameId: this.options.gameId,
      episodeId: this.options.episodeId,
      decisionPointId,
      actorWho: this.options.side,
      pendingMethod: rpc.$case,
      actionCountInRound: this.actionCountInRound,
      gameVersion: this.options.gameVersion,
      cardPoolVersion: this.options.cardPoolVersion,
      rulesetVersion: this.options.rulesetVersion,
      contractVersion: this.options.contractVersion,
      viewKind,
    })
    const decisionPoint = buildDecisionPointV1FromRpcRequest(
      request,
      this.latestVisibleState,
      {
        gameId: this.options.gameId,
        episodeId: this.options.episodeId,
        decisionPointId,
        actorWho: this.options.side,
        observationRef,
      },
    )
    const resolved = resolveSelection(decisionPoint, rpc.$case, selection)

    this.observations.push(observation)
    this.decisionPoints.push(decisionPoint)
    this.pending.push({
      observation,
      decisionPoint,
      candidateScores: resolved.candidateScores,
      selectedCandidateId: resolved.selectedCandidateId,
      selectedRoute: resolved.selectedRoute,
    })
    this.actionCountInRound += 1
  }

  settlePending(state?: GameState, winner?: 0 | 1 | null): void {
    if (this.pending.length === 0 || !this.latestVisibleState) {
      return
    }

    const terminalOutcome = mapTerminalOutcome(this.options.side, winner)
    while (this.pending.length > 0) {
      const pending = this.pending.shift()!
      const nextObservation = this.buildTransitionObservation(
        pending.decisionPoint.decision_point_id,
        state,
      )
      const rewardBreakdown = computeRewardBreakdownV1(
        pending.observation,
        nextObservation,
        {
          config: this.options.rewardConfig ?? DEFAULT_REWARD_CONFIG_V1,
          terminalOutcome,
        },
      )
      this.transitionObservations.push(nextObservation)
      this.decisionLogs.push(
        buildDecisionPointLogV1({
          decisionPoint: pending.decisionPoint,
          candidateScores: pending.candidateScores,
          selectedCandidateId: pending.selectedCandidateId,
          selectedRoute: pending.selectedRoute,
          rewardBreakdown,
          terminalOutcome: terminalOutcome == null ? null : rewardBreakdown.terminal,
          modelVersion: this.options.modelVersion,
        }),
      )
    }
  }

  exportCapture(): SelfPlayRlSideCaptureV1 {
    return {
      side: this.options.side,
      observations: [...this.observations],
      decision_points: [...this.decisionPoints],
      transition_observations: [...this.transitionObservations],
      decision_logs: [...this.decisionLogs],
    }
  }

  private buildDecisionPointId(): string {
    this.decisionCounter += 1
    return `${this.options.gameId}:p${this.options.side}:${String(this.decisionCounter).padStart(6, "0")}`
  }

  private buildTransitionObservation(
    originDecisionPointId: string,
    state?: GameState,
  ): ObservationV1 {
    const viewKind = this.options.viewKind ?? "policy_public"
    if (state && viewKind === "debug_full") {
      return buildObservationV1FromGameState(state, this.options.side, {
        gameId: this.options.gameId,
        episodeId: this.options.episodeId,
        decisionPointId: `${originDecisionPointId}:next`,
        actorWho: this.options.side,
        gameVersion: this.options.gameVersion,
        cardPoolVersion: this.options.cardPoolVersion,
        rulesetVersion: this.options.rulesetVersion,
        contractVersion: this.options.contractVersion,
        viewKind,
      })
    }

    return buildObservationV1FromVisibleState(this.latestVisibleState!, this.options.side, {
      gameId: this.options.gameId,
      episodeId: this.options.episodeId,
      decisionPointId: `${originDecisionPointId}:next`,
      actorWho: this.options.side,
      gameVersion: this.options.gameVersion,
      cardPoolVersion: this.options.cardPoolVersion,
      rulesetVersion: this.options.rulesetVersion,
      contractVersion: this.options.contractVersion,
      viewKind,
    })
  }
}

function resolveSelection(
  decisionPoint: DecisionPointV1,
  pendingMethod: NonNullable<NonNullable<RpcRequest["request"]>["$case"]>,
  selection: SelfPlayRlSelectionInput,
): {
  selectedCandidateId: string | null
  selectedRoute: ActionRouteV1
  candidateScores: number[]
} {
  switch (pendingMethod) {
    case "action": {
      const rankedScores = new Map(
        (selection.policyDecision?.ranked ?? []).map((candidate) => [
          candidate.candidateId,
          candidate.finalScore,
        ]),
      )
      const candidateScores = decisionPoint.candidates.map((candidate) => {
        const policyCandidateId =
          candidate.engine_index != null ? String(candidate.engine_index - 1) : null
        return policyCandidateId != null ? (rankedScores.get(policyCandidateId) ?? 0) : 0
      })
      const selectedCandidate =
        decisionPoint.candidates.find(
          (candidate) => candidate.engine_index === (selection.selectedActionIndex ?? 0) + 1,
        ) ?? decisionPoint.candidates.find(c => c.action_case !== "declareEnd") ?? decisionPoint.candidates[0]
      return {
        selectedCandidateId: selectedCandidate?.candidate_id ?? null,
        selectedRoute: selectedCandidate?.routing.route ?? "rule_policy",
        candidateScores,
      }
    }
    case "chooseActive": {
      const selectedCandidate =
        decisionPoint.candidates.find(
          (candidate) => candidate.target_ref?.entity_id === selection.activeCharacterId,
        ) ?? decisionPoint.candidates[0]
      return {
        selectedCandidateId: selectedCandidate?.candidate_id ?? null,
        selectedRoute: selectedCandidate?.routing.route ?? "rule_policy",
        candidateScores: [],
      }
    }
    case "selectCard": {
      const selectedCandidate =
        decisionPoint.candidates.find(
          (candidate) => candidate.target_ref?.definition_id === selection.selectedDefinitionId,
        ) ?? decisionPoint.candidates[0]
      return {
        selectedCandidateId: selectedCandidate?.candidate_id ?? null,
        selectedRoute: selectedCandidate?.routing.route ?? "rule_policy",
        candidateScores: [],
      }
    }
    case "rerollDice":
    case "switchHands": {
      const selectedCandidate = decisionPoint.candidates[0]
      return {
        selectedCandidateId: selectedCandidate?.candidate_id ?? null,
        selectedRoute: selectedCandidate?.routing.route ?? "rule_policy",
        candidateScores: [],
      }
    }
    default:
      return {
        selectedCandidateId: null,
        selectedRoute: "rule_policy",
        candidateScores: [],
      }
  }
}

function mapTerminalOutcome(
  side: 0 | 1,
  winner: 0 | 1 | null | undefined,
): "win" | "loss" | "draw" | null {
  if (typeof winner !== "number") {
    return winner === null ? "draw" : null
  }
  return winner === side ? "win" : "loss"
}
