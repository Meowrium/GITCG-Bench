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

import type { BranchEvalSummary, TreeRecord } from "./types.js"
import { normalizeReplayFilePath, replayFileBaseName } from "./replay-alignment.js"

export interface BranchEvalReport {
  matchupId: string
  replayDir: string
  featureVersion?: string
  candidateFeatureNames?: string[]
  queryFeatureNames?: string[]
  points: BranchEvalPoint[]
}

export interface BranchEvalPoint {
  replayFile: string
  replayEntryIndex: number
  replayNextStateIndex: number | null
  replayActionIndex: number | null
  replayActionType?: string | null
  replayActionDefinitionId?: number | null
  replayActionTags?: string[]
  policySelectedActionIndex: number | null
  policySelectedActionType?: string | null
  queryNumericSlots?: Record<string, number>
  branches: Array<{
    actionIndex: number
    actionType: string
    definitionId: number | null
    candidateTags?: string[]
    candidateNumericSlots?: Record<string, number>
    isPolicyChoice: boolean
    isReplayChoice: boolean
    continuation: {
      winRate: number
    }
  }>
}

export class BranchEvalImporter {
  findMatchingPoint(tree: TreeRecord, report: BranchEvalReport): BranchEvalPoint | null {
    const alignment = tree.replay_alignment
    if (!alignment?.matched || !alignment.replay_file || alignment.replay_entry_index == null) {
      return null
    }
    const alignedPath = normalizeReplayFilePath(alignment.replay_file)
    return (
      report.points.find((point) => {
        if (point.replayEntryIndex !== alignment.replay_entry_index) {
          return false
        }
        const pointPath = normalizeReplayFilePath(point.replayFile)
        return pointPath === alignedPath || replayFileBaseName(pointPath) === replayFileBaseName(alignedPath)
      }) ?? null
    )
  }

  buildSummary(tree: TreeRecord, report: BranchEvalReport, point: BranchEvalPoint): BranchEvalSummary {
    const replayBranch =
      point.branches.find((branch) => branch.isReplayChoice) ??
      point.branches.find((branch) => branch.actionIndex === point.replayActionIndex) ??
      null
    const policyBranch =
      point.branches.find((branch) => branch.isPolicyChoice) ??
      point.branches.find((branch) => branch.actionIndex === point.policySelectedActionIndex) ??
      null
    const bestBranch = [...point.branches].sort(
      (a, b) => b.continuation.winRate - a.continuation.winRate,
    )[0] ?? null
    const treeFirstActionCase = tree.source_window.steps[0]?.selected_candidate?.action_case ?? null
    const replayActionWinRate = replayBranch?.continuation.winRate ?? null
    const policyActionWinRate = policyBranch?.continuation.winRate ?? null
    const bestActionWinRate = bestBranch?.continuation.winRate ?? null
    const liftVsReplay =
      replayActionWinRate != null && bestActionWinRate != null
        ? bestActionWinRate - replayActionWinRate
        : null
    const liftVsPolicy =
      policyActionWinRate != null && bestActionWinRate != null
        ? bestActionWinRate - policyActionWinRate
        : null
    const treeMatchesReplay = treeFirstActionCase != null && treeFirstActionCase === (point.replayActionType ?? replayBranch?.actionType ?? null)
    return {
      matchup_id: report.matchupId,
      replay_file: point.replayFile,
      replay_entry_index: point.replayEntryIndex,
      replay_action_index: point.replayActionIndex,
      replay_action_type: point.replayActionType ?? replayBranch?.actionType ?? null,
      replay_action_definition_id: point.replayActionDefinitionId ?? replayBranch?.definitionId ?? null,
      replay_action_tags: point.replayActionTags ?? replayBranch?.candidateTags ?? [],
      policy_selected_action_index: point.policySelectedActionIndex,
      policy_selected_action_type: point.policySelectedActionType ?? policyBranch?.actionType ?? null,
      best_action_index: bestBranch?.actionIndex ?? null,
      best_action_type: bestBranch?.actionType ?? null,
      best_action_definition_id: bestBranch?.definitionId ?? null,
      best_action_tags: bestBranch?.candidateTags ?? [],
      replay_action_win_rate: replayActionWinRate,
      policy_action_win_rate: policyActionWinRate,
      best_action_win_rate: bestActionWinRate,
      lift_vs_replay: liftVsReplay,
      lift_vs_policy: liftVsPolicy,
      tree_first_action_case_matches_replay: treeMatchesReplay,
      promote_signal: choosePromoteSignal({
        treeMatchesReplay,
        liftVsReplay,
      }),
    }
  }
}

function choosePromoteSignal(args: {
  treeMatchesReplay: boolean
  liftVsReplay: number | null
}): "promote" | "hold" | "reject" {
  if (!args.treeMatchesReplay || args.liftVsReplay == null) {
    return "hold"
  }
  if (args.liftVsReplay <= 0.02) {
    return "promote"
  }
  if (args.liftVsReplay >= 0.12) {
    return "reject"
  }
  return "hold"
}
