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

import type { MlConceptHypothesis, SlotValue } from "../contracts/index.js"
import type {
  CombatWindowConceptSourceLike,
  CombatWindowPlanNodeLike,
} from "./combat-window.js"

export function extractComboConceptHypothesesFromCombatWindow(
  source: CombatWindowConceptSourceLike,
): MlConceptHypothesis[] {
  const windowId = source.analysis.source_context.window_id
  const createdAt = source.analysis.analysis_meta.created_at
  const treeRef = source.tree_id ? [`tree:${source.tree_id}`] : []
  const windowRefs = [`combat_window:${windowId}`, ...treeRef]
  const nodes = source.analysis.combat_window_plan.nodes
  const concepts: MlConceptHypothesis[] = []

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const fromNode = nodes[index]!
    const toNode = nodes[index + 1]!
    const estimatorSlot = buildComboEstimatorSlot(fromNode, toNode)
    if (!estimatorSlot) {
      continue
    }

    concepts.push({
      concept_id: buildComboConceptId(windowId, fromNode, toNode, index),
      name: buildComboConceptName(fromNode, toNode),
      scope: "window",
      description: buildComboDescription(fromNode, toNode),
      evidence_refs: [
        ...windowRefs,
        `combat_window_transition:${windowId}:${fromNode.id}:${toNode.id}`,
      ],
      tags: uniqueStrings([
        "combat_window_combo",
        "multi_step",
        "combo_pattern",
        fromNode.kind,
        toNode.kind,
        ...compactStrings(fromNode.expected_action_case ?? []),
        ...compactStrings(toNode.expected_action_case ?? []),
        ...compactStrings(fromNode.prefer_tags),
        ...compactStrings(toNode.prefer_tags),
      ]),
      estimator_slot: estimatorSlot,
      validation_slot: {
        transition_index: index,
        from_node_id: fromNode.id,
        to_node_id: toNode.id,
        line_length: nodes.length,
      },
      ranking_slot: {
        combo_role: "two_step_window_pattern",
        from_kind: fromNode.kind,
        to_kind: toNode.kind,
      },
      status: "draft",
      source: "combat_window",
      created_at: createdAt,
      updated_at: createdAt,
    })
  }

  return concepts
}

export function extractComboConceptHypothesesFromCombatWindows(
  sources: readonly CombatWindowConceptSourceLike[],
): MlConceptHypothesis[] {
  return sources.flatMap((source) => extractComboConceptHypothesesFromCombatWindow(source))
}

function buildComboEstimatorSlot(
  fromNode: CombatWindowPlanNodeLike,
  toNode: CombatWindowPlanNodeLike,
): SlotValue {
  const fromStep = buildComboStepSlot(fromNode)
  const toStep = buildComboStepSlot(toNode)
  if (!fromStep || !toStep) {
    return null
  }

  return {
    kind: "combo_pattern.v1",
    in_order: [fromStep, toStep],
    max_step_gap: 1,
  }
}

function buildComboStepSlot(node: CombatWindowPlanNodeLike): SlotValue {
  const clauses: Array<Record<string, string>> = []
  const actionCases = compactStrings(node.expected_action_case ?? [])
  const preferTags = compactStrings(node.prefer_tags)

  if (actionCases.length > 0) {
    clauses.push({
      action_case: actionCases[0]!,
    })
  }
  const firstTag = preferTags.find((tag) => !isBoilerplateTag(tag))
  if (firstTag) {
    clauses.push({
      candidate_tag: firstTag,
    })
  }

  if (clauses.length === 0) {
    return null
  }
  if (clauses.length === 1) {
    return clauses[0]!
  }
  return {
    all_of: clauses,
  }
}

function buildComboConceptId(
  windowId: string,
  fromNode: CombatWindowPlanNodeLike,
  toNode: CombatWindowPlanNodeLike,
  index: number,
): string {
  return `concept:${slugify(windowId)}:combo:${index}-${slugify(fromNode.kind)}-to-${slugify(toNode.kind)}`
}

function buildComboConceptName(
  fromNode: CombatWindowPlanNodeLike,
  toNode: CombatWindowPlanNodeLike,
): string {
  return `combo-${fromNode.kind}-to-${toNode.kind}`
}

function buildComboDescription(
  fromNode: CombatWindowPlanNodeLike,
  toNode: CombatWindowPlanNodeLike,
): string {
  const fromAction = compactStrings(fromNode.expected_action_case ?? []).join("/")
  const toAction = compactStrings(toNode.expected_action_case ?? []).join("/")
  const fromTags = compactStrings(fromNode.prefer_tags).join("/")
  const toTags = compactStrings(toNode.prefer_tags).join("/")

  return [
    `from=${fromNode.kind}:${fromNode.intent}`,
    fromAction ? `from_action=${fromAction}` : null,
    fromTags ? `from_tags=${fromTags}` : null,
    `to=${toNode.kind}:${toNode.intent}`,
    toAction ? `to_action=${toAction}` : null,
    toTags ? `to_tags=${toTags}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" | ")
}

function compactStrings(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0)
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(compactStrings(values))]
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function isBoilerplateTag(tag: string): boolean {
  return [
    "combat_window",
    "combat_window_node",
    "branch_claim",
    "plan",
    "good",
    "mixed",
    "bad",
    "same_deck_same_matchup",
    "same_deck_broad",
    "narrow_only",
  ].includes(tag)
}
