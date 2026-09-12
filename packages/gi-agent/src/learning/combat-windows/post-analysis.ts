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

import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import type {
  CandidateCombatWindow,
  CombatWindowAnalysisRecord,
  CombatWindowPlan,
  PostAnalysisBranchClaim,
} from "./types.js"

const PROMPT_VERSION = "post-analysis.v1"

const SYSTEM_PROMPT = `You are a post-match analyzer for Genius Invokation TCG.
Return JSON only.

Goal:
1. Summarize this 2-4 action window as a reusable combat_window_plan.
2. State where the plan is applicable.
3. Mark any unverified strategic claim as needs_branch_eval=true.

Hard rules:
- Do not output prose outside JSON.
- Do not describe actions that were illegal in the provided candidates.
- Do not generalize beyond the provided evidence.
- Keep combat_window_plan limited to the observed 2-4 action window.
- Use only these node kinds: setup, pivot, convert, burst, survive, exit.
- Each node.next item must include condition, to, priority.
- Prefer stable, short condition strings such as pending_method=action, round=2, self.active_hp<=2, actions_taken>=2.
`

export interface CombatWindowPostAnalyzerOptions {
  model?: string
  temperature?: number
}

export class CombatWindowPostAnalyzer {
  private readonly llm: ChatOpenAI
  private readonly model: string

  constructor(options: CombatWindowPostAnalyzerOptions = {}) {
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini"
    this.llm = new ChatOpenAI({
      model: this.model,
      temperature: options.temperature ?? 0,
    })
  }

  async analyzeWindow(window: CandidateCombatWindow): Promise<CombatWindowAnalysisRecord> {
    const response = await this.llm.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(buildUserPrompt(window)),
    ])
    const parsed = parseJsonResponse(normalizeContent(response.content))
    return hydrateAnalysis(window, parsed, this.model)
  }
}

function buildUserPrompt(window: CandidateCombatWindow): string {
  return JSON.stringify(
    {
      task: "analyze_combat_window",
      output_schema: {
        analysis_meta: {
          schema_version: "combat-window-analysis.v1",
          model: "string",
          prompt_version: "string",
          created_at: "ISO-8601 string",
        },
        source_context: {
          window_id: "string",
          session_id: "string",
          matchup_id: "string|null",
          deck_fingerprint_self: "string|null",
          replay_path: "string|null",
        },
        window_locator: {
          round: "number",
          turn: "number",
          sequence_index: "number",
          sequence_start_step: "number",
          action_count: "number",
        },
        state_fingerprint: "copy or refine provided state_fingerprint",
        combat_window_plan: {
          window_id: "string",
          plan_horizon: { min_actions: "number", max_actions: "number" },
          entry_conditions: ["string"],
          interrupt_conditions: ["string"],
          success_conditions: ["string"],
          fail_conditions: ["string"],
          entry_node_id: "string",
          nodes: [
            {
              id: "string",
              kind: "setup|pivot|convert|burst|survive|exit",
              intent: "string",
              expected_action_case: ["useSkill|playCard|switchActive|declareEnd|selectCard|elementalTuning"],
              when: ["string"],
              must_do: ["string"],
              avoid: ["string"],
              prefer_tags: ["string"],
              resource_policy: "strict|balanced|aggressive",
              fallback_rule: "string",
              next: [{ condition: "string", to: "string", priority: 100 }],
            },
          ],
        },
        candidate_review: {
          actual_line: ["candidate_id"],
          preferred_line_tags: ["string"],
          rejected_patterns: ["string"],
          key_branch_claims: [
            {
              claim: "string",
              evidence_type: "observed|heuristic|branch_eval",
              needs_branch_eval: true,
            },
          ],
        },
        outcome_assessment: {
          local_result: "good|mixed|bad",
          why: ["string"],
          reusable: true,
          reuse_scope: "same_deck_same_matchup|same_deck_broad|narrow_only",
        },
        quality: {
          llm_confidence: "0..1",
          generalization_confidence: "0..1",
          risk_flags: ["string"],
        },
      },
      source_window: window,
    },
    null,
    2,
  )
}

function normalizeContent(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === "string") {
    return content
  }
  return content
    .map((item) => item.text ?? "")
    .join("")
}

function parseJsonResponse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1]
    if (fenced) {
      return JSON.parse(fenced) as Record<string, unknown>
    }
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    }
    throw new Error("LLM did not return valid JSON")
  }
}

function hydrateAnalysis(
  window: CandidateCombatWindow,
  parsed: Record<string, unknown>,
  model: string,
): CombatWindowAnalysisRecord {
  const now = new Date().toISOString()
  const candidateReview = (parsed.candidate_review ?? {}) as Record<string, unknown>
  const sourceContext = (parsed.source_context ?? {}) as Record<string, unknown>
  const analysisMeta = (parsed.analysis_meta ?? {}) as Record<string, unknown>
  const windowLocator = (parsed.window_locator ?? {}) as Record<string, unknown>
  const plan = (parsed.combat_window_plan ?? {}) as Partial<CombatWindowPlan>
  const branchClaims = Array.isArray(candidateReview.key_branch_claims)
    ? (candidateReview.key_branch_claims as PostAnalysisBranchClaim[])
    : []

  return {
    analysis_meta: {
      schema_version: "combat-window-analysis.v1",
      model: typeof analysisMeta.model === "string" ? analysisMeta.model : model,
      prompt_version:
        typeof analysisMeta.prompt_version === "string" ? analysisMeta.prompt_version : PROMPT_VERSION,
      created_at:
        typeof analysisMeta.created_at === "string" ? analysisMeta.created_at : now,
    },
    source_context: {
      window_id: typeof sourceContext.window_id === "string" ? sourceContext.window_id : window.window_id,
      session_id: typeof sourceContext.session_id === "string" ? sourceContext.session_id : window.session_id,
      matchup_id: typeof sourceContext.matchup_id === "string" ? sourceContext.matchup_id : null,
      deck_fingerprint_self:
        typeof sourceContext.deck_fingerprint_self === "string"
          ? sourceContext.deck_fingerprint_self
          : window.deck_fingerprint_self,
      replay_path: typeof sourceContext.replay_path === "string" ? sourceContext.replay_path : null,
    },
    window_locator: {
      round: typeof windowLocator.round === "number" ? windowLocator.round : window.round,
      turn: typeof windowLocator.turn === "number" ? windowLocator.turn : window.turn,
      sequence_index:
        typeof windowLocator.sequence_index === "number"
          ? windowLocator.sequence_index
          : window.sequence_index,
      sequence_start_step:
        typeof windowLocator.sequence_start_step === "number"
          ? windowLocator.sequence_start_step
          : window.sequence_start_step,
      action_count:
        typeof windowLocator.action_count === "number"
          ? windowLocator.action_count
          : window.action_count,
    },
    state_fingerprint: parsed.state_fingerprint
      ? (parsed.state_fingerprint as CombatWindowAnalysisRecord["state_fingerprint"])
      : window.state_fingerprint,
    combat_window_plan: {
      window_id: typeof plan.window_id === "string" ? plan.window_id : window.window_id,
      plan_horizon: {
        min_actions: Math.max(2, plan.plan_horizon?.min_actions ?? window.action_count),
        max_actions: Math.max(
          Math.max(2, plan.plan_horizon?.min_actions ?? window.action_count),
          plan.plan_horizon?.max_actions ?? window.action_count,
        ),
      },
      entry_conditions: ensureStringArray(plan.entry_conditions, [`pending_method=${window.steps[0]!.digest.pending_method}`]),
      interrupt_conditions: ensureStringArray(plan.interrupt_conditions, ["pending_method!=action"]),
      success_conditions: ensureStringArray(plan.success_conditions, ["window_goal_reached"]),
      fail_conditions: ensureStringArray(plan.fail_conditions, []),
      entry_node_id: typeof plan.entry_node_id === "string" ? plan.entry_node_id : inferEntryNodeId(plan),
      nodes: Array.isArray(plan.nodes) ? plan.nodes : [],
    },
    candidate_review: {
      actual_line: ensureStringArray(
        candidateReview.actual_line,
        window.steps
          .map((step) => step.feedback.selected_candidate_id)
          .filter((item): item is string => typeof item === "string"),
      ),
      preferred_line_tags: ensureStringArray(candidateReview.preferred_line_tags, window.tags),
      rejected_patterns: ensureStringArray(candidateReview.rejected_patterns, []),
      key_branch_claims: branchClaims,
    },
    outcome_assessment: {
      local_result: parseLocalResult(parsed.outcome_assessment),
      why: ensureStringArray((parsed.outcome_assessment as Record<string, unknown> | undefined)?.why, []),
      reusable: Boolean((parsed.outcome_assessment as Record<string, unknown> | undefined)?.reusable ?? true),
      reuse_scope: parseReuseScope(parsed.outcome_assessment),
    },
    quality: {
      llm_confidence: clamp01((parsed.quality as Record<string, unknown> | undefined)?.llm_confidence, 0.6),
      generalization_confidence: clamp01(
        (parsed.quality as Record<string, unknown> | undefined)?.generalization_confidence,
        0.4,
      ),
      risk_flags: ensureStringArray((parsed.quality as Record<string, unknown> | undefined)?.risk_flags, []),
    },
  }
}

function ensureStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : fallback
}

function inferEntryNodeId(plan: Partial<CombatWindowPlan>): string {
  if (Array.isArray(plan.nodes) && plan.nodes.length > 0 && typeof plan.nodes[0]?.id === "string") {
    return plan.nodes[0].id
  }
  return "node_entry"
}

function parseLocalResult(value: unknown): "good" | "mixed" | "bad" {
  const result = (value as Record<string, unknown> | undefined)?.local_result
  return result === "good" || result === "mixed" || result === "bad" ? result : "mixed"
}

function parseReuseScope(value: unknown): "same_deck_same_matchup" | "same_deck_broad" | "narrow_only" {
  const scope = (value as Record<string, unknown> | undefined)?.reuse_scope
  return scope === "same_deck_same_matchup" || scope === "same_deck_broad" || scope === "narrow_only"
    ? scope
    : "narrow_only"
}

function clamp01(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (Number.isNaN(parsed)) {
    return fallback
  }
  return Math.max(0, Math.min(1, parsed))
}
