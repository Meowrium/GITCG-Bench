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
import type {
  CandidateCombatWindow,
  CombatWindowAnalysisRecord,
  CombatWindowPlan,
  CombatWindowPlanNode,
  TreeRecord,
  TreeValidationRun,
  TreeValidationSummary,
} from "./types.js"

interface ValidationContext {
  pending_method: string
  round: number
  turn: number
  actions_taken: number
  self_active_hp: number
  opp_active_hp: number
  resource_dice_count: number
  resource_omni_count: number
}

export class CombatWindowTreeValidator {
  validateTree(tree: TreeRecord): {
    summary: TreeValidationSummary
    run: TreeValidationRun
  } {
    const summary = this.validate(tree.analysis, tree.source_window)
    return {
      summary,
      run: {
        run_id: `tree_validation_${randomUUID()}`,
        tree_id: tree.tree_id,
        summary,
        created_at: new Date().toISOString(),
      },
    }
  }

  validate(analysis: CombatWindowAnalysisRecord, window: CandidateCombatWindow): TreeValidationSummary {
    const reasons: string[] = []
    const schemaOk = validateSchema(analysis, reasons)
    if (!schemaOk) {
      return {
        schema_ok: false,
        entry_conditions_ok: null,
        replay_alignment_ok: null,
        legality_ok: null,
        branch_eval_ok: null,
        status: "rejected",
        reasons,
        matched_node_ids: [],
      }
    }

    const entryConditionsOk = validateEntryConditions(analysis.combat_window_plan, window, reasons)
    const matchedNodeIds = matchPlanToWindow(analysis.combat_window_plan, window, reasons)
    const replayAlignmentOk = matchedNodeIds.length === window.steps.length
    const legalityOk = replayAlignmentOk
      ? validateLegality(analysis.combat_window_plan, window, matchedNodeIds, reasons)
      : false
    const branchEvalOk = analysis.candidate_review.key_branch_claims.some((claim) => claim.needs_branch_eval)
      ? null
      : true

    return {
      schema_ok: true,
      entry_conditions_ok: entryConditionsOk,
      replay_alignment_ok: replayAlignmentOk,
      legality_ok: legalityOk,
      branch_eval_ok: branchEvalOk,
      status: entryConditionsOk && replayAlignmentOk && legalityOk ? "validated" : "rejected",
      reasons,
      matched_node_ids: matchedNodeIds,
    }
  }
}

function validateSchema(analysis: CombatWindowAnalysisRecord, reasons: string[]): boolean {
  const plan = analysis.combat_window_plan
  if (!plan || typeof plan !== "object") {
    reasons.push("combat_window_plan missing")
    return false
  }
  if (!plan.window_id || !plan.entry_node_id) {
    reasons.push("combat_window_plan missing window_id or entry_node_id")
    return false
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    reasons.push("combat_window_plan.nodes empty")
    return false
  }
  if (
    !plan.plan_horizon ||
    plan.plan_horizon.min_actions < 1 ||
    plan.plan_horizon.max_actions < plan.plan_horizon.min_actions
  ) {
    reasons.push("combat_window_plan.plan_horizon invalid")
    return false
  }
  const nodeIds = new Set<string>()
  for (const node of plan.nodes) {
    if (!node.id || nodeIds.has(node.id)) {
      reasons.push(`invalid or duplicate node id: ${node.id || "<empty>"}`)
      return false
    }
    nodeIds.add(node.id)
    if (
      !Array.isArray(node.when) ||
      !Array.isArray(node.must_do) ||
      !Array.isArray(node.avoid) ||
      !Array.isArray(node.prefer_tags) ||
      !Array.isArray(node.next)
    ) {
      reasons.push(`node ${node.id} has invalid array fields`)
      return false
    }
  }
  if (!nodeIds.has(plan.entry_node_id)) {
    reasons.push(`entry node not found: ${plan.entry_node_id}`)
    return false
  }
  for (const node of plan.nodes) {
    for (const transition of node.next) {
      if (!nodeIds.has(transition.to)) {
        reasons.push(`node ${node.id} points to missing node ${transition.to}`)
        return false
      }
    }
  }
  return true
}

function validateEntryConditions(plan: CombatWindowPlan, window: CandidateCombatWindow, reasons: string[]): boolean {
  const context = buildValidationContext(window)
  const ok = plan.entry_conditions.every((condition) => evaluateCondition(condition, context))
  if (!ok) {
    reasons.push("entry_conditions do not match source window")
  }
  if (window.action_count < plan.plan_horizon.min_actions || window.action_count > plan.plan_horizon.max_actions) {
    reasons.push("window action count outside plan horizon")
    return false
  }
  return ok
}

function buildValidationContext(window: CandidateCombatWindow): ValidationContext {
  const entryDigest = window.steps[0]!.digest
  const selfActive =
    entryDigest.self_summary.characters.find((item) => item.id === entryDigest.self_summary.active_character_id) ??
    entryDigest.self_summary.characters[0]
  const oppActive =
    entryDigest.opponent_summary.characters.find((item) => item.id === entryDigest.opponent_summary.active_character_id) ??
    entryDigest.opponent_summary.characters[0]
  return {
    pending_method: entryDigest.pending_method,
    round: entryDigest.round,
    turn: entryDigest.turn,
    actions_taken: window.action_count,
    self_active_hp: selfActive?.hp ?? 0,
    opp_active_hp: oppActive?.hp ?? 0,
    resource_dice_count: entryDigest.resource_summary.dice_count,
    resource_omni_count: entryDigest.resource_summary.omni_count,
  }
}

function evaluateCondition(condition: string, context: ValidationContext): boolean {
  const orParts = condition.split(/\s+or\s+/i).map((part) => part.trim()).filter(Boolean)
  if (orParts.length === 0) {
    return true
  }
  return orParts.some((orPart) => {
    const andParts = orPart.split(/\s+and\s+/i).map((part) => part.trim()).filter(Boolean)
    return andParts.every((andPart) => evaluateAtomicCondition(andPart, context))
  })
}

function evaluateAtomicCondition(condition: string, context: ValidationContext): boolean {
  const match = condition.match(/^([a-zA-Z0-9_.]+)\s*(==|=|!=|>=|<=|>|<)\s*([a-zA-Z0-9_.-]+)$/)
  if (!match) {
    return false
  }
  const [, left, operator, right] = match
  const leftValue = lookupConditionValue(left, context)
  if (typeof leftValue === "undefined") {
    return false
  }
  const numericRight = Number(right)
  const rightValue = Number.isNaN(numericRight) ? right : numericRight
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    switch (operator) {
      case "=":
      case "==":
        return leftValue === rightValue
      case "!=":
        return leftValue !== rightValue
      case ">":
        return leftValue > rightValue
      case "<":
        return leftValue < rightValue
      case ">=":
        return leftValue >= rightValue
      case "<=":
        return leftValue <= rightValue
    }
  }
  const leftText = String(leftValue)
  const rightText = String(rightValue)
  if (operator === "=" || operator === "==") {
    return leftText === rightText
  }
  if (operator === "!=") {
    return leftText !== rightText
  }
  return false
}

function lookupConditionValue(path: string, context: ValidationContext): string | number | undefined {
  switch (path) {
    case "pending_method":
      return context.pending_method
    case "round":
      return context.round
    case "turn":
      return context.turn
    case "actions_taken":
      return context.actions_taken
    case "self.active_hp":
      return context.self_active_hp
    case "opp.active_hp":
      return context.opp_active_hp
    case "resource.dice_count":
      return context.resource_dice_count
    case "resource.omni_count":
      return context.resource_omni_count
    default:
      return undefined
  }
}

function matchPlanToWindow(
  plan: CombatWindowPlan,
  window: CandidateCombatWindow,
  reasons: string[],
): string[] {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]))
  type MatchState = { nodeId: string; matched: string[] }
  let states: MatchState[] = [{ nodeId: plan.entry_node_id, matched: [] }]

  for (const step of window.steps) {
    const nextStates: MatchState[] = []
    for (const state of states) {
      const node = nodesById.get(state.nodeId)
      if (!node || !nodeMatchesStep(node, step)) {
        continue
      }
      if (step === window.steps[window.steps.length - 1]) {
        nextStates.push({
          nodeId: state.nodeId,
          matched: [...state.matched, state.nodeId],
        })
        continue
      }
      if (node.next.length === 0) {
        continue
      }
      for (const transition of node.next) {
        nextStates.push({
          nodeId: transition.to,
          matched: [...state.matched, state.nodeId],
        })
      }
    }
    states = dedupeStates(nextStates)
    if (states.length === 0) {
      reasons.push("source window does not align with any node path")
      return []
    }
  }

  const best = states[0]
  return best?.matched ?? []
}

function dedupeStates(states: Array<{ nodeId: string; matched: string[] }>) {
  const seen = new Set<string>()
  const result: Array<{ nodeId: string; matched: string[] }> = []
  for (const state of states) {
    const key = `${state.nodeId}:${state.matched.join(">")}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(state)
  }
  return result
}

function nodeMatchesStep(node: CombatWindowPlanNode, step: CandidateCombatWindow["steps"][number]): boolean {
  const candidate = step.selected_candidate
  if (!candidate) {
    return false
  }
  const actionCase = candidate.action_case
  const tagSet = new Set([actionCase, ...(candidate.tags ?? [])])
  if (node.expected_action_case && node.expected_action_case.length > 0) {
    if (!node.expected_action_case.includes(actionCase)) {
      return false
    }
  } else if (node.prefer_tags.length > 0) {
    const overlap = node.prefer_tags.some((tag) => tagSet.has(tag))
    if (!overlap) {
      return false
    }
  }
  if (node.avoid.some((tag) => tagSet.has(tag))) {
    return false
  }
  return true
}

function validateLegality(
  plan: CombatWindowPlan,
  window: CandidateCombatWindow,
  matchedNodeIds: string[],
  reasons: string[],
): boolean {
  const nodesById = new Map(plan.nodes.map((node) => [node.id, node]))
  for (let i = 0; i < matchedNodeIds.length; i += 1) {
    const node = nodesById.get(matchedNodeIds[i]!)
    const step = window.steps[i]
    const candidateId = step?.feedback.selected_candidate_id
    const digest = step?.digest
    if (!node || !step || !candidateId || !digest) {
      reasons.push("matched path missing node or step details")
      return false
    }
    const candidate = digest.candidate_actions.find((item) => item.candidate_id === candidateId)
    if (!candidate) {
      reasons.push(`selected candidate not found in digest: ${candidateId}`)
      return false
    }
    const tagSet = new Set([candidate.action_case, ...(candidate.tags ?? [])])
    if (node.avoid.some((tag) => tagSet.has(tag))) {
      reasons.push(`node ${node.id} conflicts with selected candidate tags`)
      return false
    }
  }
  return true
}
