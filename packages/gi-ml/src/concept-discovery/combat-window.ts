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

export interface CombatWindowConceptSourceLike {
  tree_id?: string | null
  source_window?: {
    window_id: string
    global_goal?: string | null
    tags?: string[]
  } | null
  analysis: CombatWindowAnalysisLike
}

export interface CombatWindowAnalysisLike {
  analysis_meta: {
    created_at: string
  }
  source_context: {
    window_id: string
    session_id: string
    matchup_id: string | null
    deck_fingerprint_self: string | null
  }
  combat_window_plan: {
    window_id: string
    entry_conditions: string[]
    success_conditions: string[]
    fail_conditions: string[]
    entry_node_id: string
    nodes: CombatWindowPlanNodeLike[]
  }
  candidate_review: {
    preferred_line_tags: string[]
    rejected_patterns: string[]
    key_branch_claims: CombatWindowBranchClaimLike[]
  }
  outcome_assessment: {
    local_result: "good" | "mixed" | "bad"
    why: string[]
    reusable: boolean
    reuse_scope: "same_deck_same_matchup" | "same_deck_broad" | "narrow_only"
  }
  quality: {
    llm_confidence: number
    generalization_confidence: number
    risk_flags: string[]
  }
}

export interface CombatWindowPlanNodeLike {
  id: string
  kind: "setup" | "pivot" | "convert" | "burst" | "survive" | "exit"
  intent: string
  expected_action_case?: string[]
  when: string[]
  must_do: string[]
  avoid: string[]
  prefer_tags: string[]
}

export interface CombatWindowBranchClaimLike {
  claim: string
  evidence_type: "observed" | "heuristic" | "branch_eval"
  needs_branch_eval: boolean
}

export function extractConceptHypothesesFromCombatWindow(
  source: CombatWindowConceptSourceLike,
): MlConceptHypothesis[] {
  const concepts: MlConceptHypothesis[] = []
  const windowId = source.analysis.source_context.window_id
  const createdAt = source.analysis.analysis_meta.created_at
  const treeRef = source.tree_id ? [`tree:${source.tree_id}`] : []
  const windowRefs = [`combat_window:${windowId}`, ...treeRef]
  const sourceTags = compactStrings(source.source_window?.tags ?? [])
  const goal = source.source_window?.global_goal

  concepts.push({
    concept_id: buildConceptId(windowId, "plan", "primary"),
    name: buildPlanConceptName(source.analysis),
    scope: "window",
    description: buildPlanDescription(source.analysis, goal),
    evidence_refs: windowRefs,
    tags: uniqueStrings([
      "combat_window",
      "plan",
      source.analysis.outcome_assessment.reuse_scope,
      source.analysis.outcome_assessment.local_result,
      ...source.analysis.candidate_review.preferred_line_tags,
      ...sourceTags,
    ]),
    estimator_slot: null,
    validation_slot: {
      reusable: source.analysis.outcome_assessment.reusable,
      llm_confidence: source.analysis.quality.llm_confidence,
      generalization_confidence: source.analysis.quality.generalization_confidence,
    },
    ranking_slot: null,
    status: "draft",
    source: "combat_window",
    created_at: createdAt,
    updated_at: createdAt,
  })

  for (const node of source.analysis.combat_window_plan.nodes) {
    concepts.push({
      concept_id: buildConceptId(windowId, "node", node.id),
      name: `node-${node.kind}-${slugify(node.intent)}`,
      scope: "state_action",
      description: buildNodeDescription(node),
      evidence_refs: [...windowRefs, `combat_window_node:${windowId}:${node.id}`],
      tags: uniqueStrings([
        "combat_window_node",
        node.kind,
        ...compactStrings(node.expected_action_case ?? []),
        ...compactStrings(node.prefer_tags),
      ]),
      estimator_slot: buildNodeEstimatorSlot(node),
      validation_slot: {
        entry_node: source.analysis.combat_window_plan.entry_node_id === node.id,
      },
      ranking_slot: null,
      status: "draft",
      source: "combat_window",
      created_at: createdAt,
      updated_at: createdAt,
    })
  }

  const transitionConcepts = buildTransitionConcepts(source, windowRefs, createdAt)
  concepts.push(...transitionConcepts)

  source.analysis.candidate_review.key_branch_claims.forEach((claim, index) => {
    concepts.push({
      concept_id: buildConceptId(windowId, "claim", `${index}_${slugify(claim.claim)}`),
      name: `claim-${claim.evidence_type}-${index}`,
      scope: "state_action",
      description: claim.claim,
      evidence_refs: [...windowRefs, `combat_window_claim:${windowId}:${index}`],
      tags: uniqueStrings([
        "branch_claim",
        claim.evidence_type,
        ...(claim.needs_branch_eval ? ["needs_branch_eval"] : ["locally_supported"]),
      ]),
      estimator_slot: null,
      validation_slot: {
        needs_branch_eval: claim.needs_branch_eval,
      },
      ranking_slot: null,
      status: "draft",
      source: "combat_window",
      created_at: createdAt,
      updated_at: createdAt,
    })
  })

  return concepts
}

function buildTransitionConcepts(
  source: CombatWindowConceptSourceLike,
  windowRefs: string[],
  createdAt: string,
): MlConceptHypothesis[] {
  const windowId = source.analysis.source_context.window_id
  const nodes = source.analysis.combat_window_plan.nodes
  const concepts: MlConceptHypothesis[] = []

  if (nodes.length >= 2) {
    concepts.push({
      concept_id: buildConceptId(windowId, "line", "primary-sequence"),
      name: `line-${nodes.map((node) => node.kind).join("-")}`,
      scope: "window",
      description: buildLineDescription(nodes),
      evidence_refs: [...windowRefs, `combat_window_line:${windowId}`],
      tags: uniqueStrings([
        "combat_window_line",
        "multi_step",
        "sequence",
        ...nodes.map((node) => node.kind),
        ...nodes.flatMap((node) => compactStrings(node.prefer_tags)),
      ]),
      estimator_slot: null,
      validation_slot: {
        line_length: nodes.length,
        entry_node: source.analysis.combat_window_plan.entry_node_id,
      },
      ranking_slot: {
        sequence_kinds: nodes.map((node) => node.kind),
      },
      status: "draft",
      source: "combat_window",
      created_at: createdAt,
      updated_at: createdAt,
    })
  }

  for (let index = 0; index < nodes.length - 1; index += 1) {
    const fromNode = nodes[index]!
    const toNode = nodes[index + 1]!
    concepts.push({
      concept_id: buildConceptId(windowId, "transition", `${fromNode.id}_to_${toNode.id}`),
      name: `transition-${fromNode.kind}-to-${toNode.kind}`,
      scope: "window",
      description: buildTransitionDescription(fromNode, toNode),
      evidence_refs: [
        ...windowRefs,
        `combat_window_transition:${windowId}:${fromNode.id}:${toNode.id}`,
      ],
      tags: uniqueStrings([
        "combat_window_transition",
        "multi_step",
        "sequence",
        fromNode.kind,
        toNode.kind,
        ...compactStrings(fromNode.prefer_tags),
        ...compactStrings(toNode.prefer_tags),
      ]),
      estimator_slot: null,
      validation_slot: {
        transition_index: index,
        from_node_id: fromNode.id,
        to_node_id: toNode.id,
      },
      ranking_slot: {
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

export function extractConceptHypothesesFromCombatWindows(
  sources: readonly CombatWindowConceptSourceLike[],
): MlConceptHypothesis[] {
  return sources.flatMap((source) => extractConceptHypothesesFromCombatWindow(source))
}

function buildPlanConceptName(analysis: CombatWindowAnalysisLike): string {
  const tags = compactStrings(analysis.candidate_review.preferred_line_tags)
  if (tags.length > 0) {
    return `plan-${tags.slice(0, 3).join("-")}`
  }
  return `plan-${analysis.outcome_assessment.reuse_scope}`
}

function buildPlanDescription(
  analysis: CombatWindowAnalysisLike,
  goal: string | null | undefined,
): string {
  const parts = [
    goal ? `goal=${goal}` : null,
    analysis.outcome_assessment.why.length > 0
      ? `why=${analysis.outcome_assessment.why.join("; ")}`
      : null,
    analysis.combat_window_plan.entry_conditions.length > 0
      ? `entry=${analysis.combat_window_plan.entry_conditions.join(", ")}`
      : null,
    analysis.combat_window_plan.success_conditions.length > 0
      ? `success=${analysis.combat_window_plan.success_conditions.join(", ")}`
      : null,
    analysis.combat_window_plan.fail_conditions.length > 0
      ? `fail=${analysis.combat_window_plan.fail_conditions.join(", ")}`
      : null,
  ].filter((item): item is string => Boolean(item))

  return parts.join(" | ")
}

function buildNodeDescription(node: CombatWindowPlanNodeLike): string {
  const parts = [
    `intent=${node.intent}`,
    node.when.length > 0 ? `when=${node.when.join(", ")}` : null,
    node.must_do.length > 0 ? `must_do=${node.must_do.join(", ")}` : null,
    node.avoid.length > 0 ? `avoid=${node.avoid.join(", ")}` : null,
  ].filter((item): item is string => Boolean(item))

  return parts.join(" | ")
}

function buildLineDescription(nodes: readonly CombatWindowPlanNodeLike[]): string {
  return nodes
    .map((node, index) => `${index + 1}.${node.kind}:${node.intent}`)
    .join(" -> ")
}

function buildTransitionDescription(
  fromNode: CombatWindowPlanNodeLike,
  toNode: CombatWindowPlanNodeLike,
): string {
  return [
    `from=${fromNode.kind}:${fromNode.intent}`,
    `to=${toNode.kind}:${toNode.intent}`,
    fromNode.must_do.length > 0 ? `setup=${fromNode.must_do.join(", ")}` : null,
    toNode.must_do.length > 0 ? `follow_up=${toNode.must_do.join(", ")}` : null,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" | ")
}

function buildConceptId(windowId: string, kind: string, suffix: string): string {
  return `concept:${slugify(windowId)}:${kind}:${slugify(suffix)}`
}

function buildNodeEstimatorSlot(node: CombatWindowPlanNodeLike): SlotValue {
  const clauses: Array<Record<string, string>> = []

  const actionCases = compactStrings(node.expected_action_case ?? [])
  if (actionCases.length === 1) {
    clauses.push({
      action_case: actionCases[0],
    })
  }

  const preferTags = compactStrings(node.prefer_tags).filter((tag) => !isBoilerplateTag(tag))
  if (preferTags.length === 1) {
    clauses.push({
      candidate_tag: preferTags[0],
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
