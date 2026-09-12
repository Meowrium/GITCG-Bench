// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { CombatWindowLibrarySelection } from "../../learning/combat-windows/library-selector.js"
import type { CombatWindowPlanNode } from "../../learning/combat-windows/types.js"
import type { PolicyCandidateAction } from "./types.js"

export interface PlanSearchCandidateGuidance {
  score: number
  reasons: string[]
}

export interface PlanSearchGuidance {
  adjustments: Map<string, PlanSearchCandidateGuidance>
  notes: string[]
}

export function buildCombatWindowPlanSearchGuidance(
  candidates: readonly PolicyCandidateAction[],
  selection: CombatWindowLibrarySelection | null,
): PlanSearchGuidance {
  const best = selection?.matches[0]
  if (!best || best.final_score < 0.6) {
    return {
      adjustments: new Map(),
      notes: [],
    }
  }

  const plan = best.entry.combat_window_plan
  const entryNode =
    plan.nodes.find((node) => node.id === plan.entry_node_id) ??
    plan.nodes[0]
  if (!entryNode) {
    return {
      adjustments: new Map(),
      notes: [],
    }
  }

  const paths = enumerateNodePaths(
    plan.nodes,
    entryNode.id,
    Math.max(1, Math.min(3, plan.plan_horizon.max_actions)),
  )
  const adjustments = new Map<string, PlanSearchCandidateGuidance>()

  for (const candidate of candidates) {
    const reasons: string[] = []
    let score = scoreNodeAlignment(entryNode, candidate)
    if (score !== 0) {
      reasons.push(`plan_entry=${score.toFixed(2)}`)
    }

    const continuation = paths.reduce((bestScore, path) => {
      const future = path.slice(1)
      return Math.max(bestScore, scoreContinuationPotential(future, candidate))
    }, 0)
    if (continuation !== 0) {
      reasons.push(`plan_path=${continuation.toFixed(2)}`)
    }

    const finalScore = (score + continuation) * best.final_score
    adjustments.set(String(candidate.candidate_id ?? ""), {
      score: finalScore,
      reasons,
    })
  }

  return {
    adjustments,
    notes: [
      `combat_window=${best.entry.tree_id}`,
      `combat_window_score=${best.final_score.toFixed(2)}`,
      `combat_window_node=${entryNode.id}`,
    ],
  }
}

function enumerateNodePaths(
  nodes: readonly CombatWindowPlanNode[],
  startId: string,
  depth: number,
): CombatWindowPlanNode[][] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const start = nodeById.get(startId)
  if (!start) {
    return []
  }

  const paths: CombatWindowPlanNode[][] = []
  const walk = (current: CombatWindowPlanNode, currentPath: CombatWindowPlanNode[], remaining: number) => {
    paths.push(currentPath)
    if (remaining <= 1) {
      return
    }
    const nextNodes = [...current.next]
      .sort((left, right) => right.priority - left.priority)
      .slice(0, 2)
      .map((transition) => nodeById.get(transition.to))
      .filter((node): node is CombatWindowPlanNode => Boolean(node))
    for (const nextNode of nextNodes) {
      walk(nextNode, [...currentPath, nextNode], remaining - 1)
    }
  }

  walk(start, [start], depth)
  return paths
}

function scoreNodeAlignment(
  node: CombatWindowPlanNode,
  candidate: PolicyCandidateAction,
): number {
  const actionCase = String(candidate.action_case ?? "unknown")
  const tagSet = candidateTagSet(candidate)
  let score = 0

  if (node.expected_action_case?.includes(actionCase)) {
    score += 0.9
  } else if ((node.expected_action_case?.length ?? 0) > 0) {
    score -= 0.35
  }

  const preferMatches = node.prefer_tags.filter((tag) => tagSet.has(tag)).length
  score += Math.min(0.9, preferMatches * 0.25)

  const avoidMatches = node.avoid.filter((tag) => tagSet.has(tag)).length
  score -= Math.min(1.25, avoidMatches * 0.45)

  switch (node.kind) {
    case "setup":
      score +=
        safeNumber(candidate.create_support_value) * 0.55 +
        safeNumber(candidate.create_summon_value) * 0.65 +
        safeMetaSlot(candidate, "setup_dependency") * 0.35
      break
    case "convert":
      score +=
        safeNumber(candidate.damage_estimate) * 0.25 +
        safeNumber(candidate.reaction_value) * 0.35
      break
    case "burst":
      score +=
        safeMetaSlot(candidate, "burst_window_enable") * 0.55 +
        safeMetaSlot(candidate, "finisher_alignment") * 0.35
      break
    case "survive":
      score +=
        safeNumber(candidate.healing_estimate) * 0.5 +
        safeNumber(candidate.self_heal_value) * 0.3
      break
    case "pivot":
      if (actionCase === "switchActive") {
        score += 0.4
      }
      break
    default:
      break
  }

  return score
}

function scoreContinuationPotential(
  futureNodes: readonly CombatWindowPlanNode[],
  candidate: PolicyCandidateAction,
): number {
  return futureNodes.reduce((sum, node, index) => {
    const discount = Math.pow(0.6, index + 1)
    switch (node.kind) {
      case "burst":
        return sum + discount * (
          safeMetaSlot(candidate, "burst_window_enable") * 0.7 +
          safeMetaSlot(candidate, "finisher_alignment") * 0.5 +
          safeNumber(candidate.energy_gain_value) * 0.25
        )
      case "convert":
        return sum + discount * (
          safeMetaSlot(candidate, "reaction_window_enable") * 0.5 +
          safeNumber(candidate.damage_estimate) * 0.3 +
          safeNumber(candidate.reaction_value) * 0.4
        )
      case "setup":
        return sum + discount * (
          safeMetaSlot(candidate, "setup_dependency") * 0.45 +
          safeNumber(candidate.create_support_value) * 0.25 +
          safeNumber(candidate.create_summon_value) * 0.35
        )
      case "survive":
        return sum + discount * (
          safeNumber(candidate.healing_estimate) * 0.3 +
          safeNumber(candidate.self_heal_value) * 0.25
        )
      default:
        return sum
    }
  }, 0)
}

function candidateTagSet(candidate: PolicyCandidateAction): Set<string> {
  const tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : []
  return new Set([String(candidate.action_case ?? "unknown"), ...tags])
}

function safeMetaSlot(candidate: PolicyCandidateAction, key: string): number {
  if (!candidate.meta_effect_slots || typeof candidate.meta_effect_slots !== "object") {
    return 0
  }
  const value = Number((candidate.meta_effect_slots as Record<string, unknown>)[key] ?? 0)
  return Number.isFinite(value) ? value : 0
}

function safeNumber(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}
