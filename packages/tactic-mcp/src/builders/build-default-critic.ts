import type { CriticResultV1 } from "../contracts"

export type BuildCriticResultV1Args = {
  session_id: string
  plan_id: string
  turn: number
  step_id: string
  expected_policy_id: string
  actual_tool: string
  state_delta: {
    self_hp_delta: number
    opp_hp_delta: number
    dice_spent: number
    cards_spent: number
    notes?: string
  }
  hard_violations?: string[]
}

function clampScore(score: number): number {
  if (score < 0) {
    return 0
  }
  if (score > 1) {
    return 1
  }
  return Number(score.toFixed(4))
}

export function buildDefaultCriticResultV1(
  args: BuildCriticResultV1Args,
  now = new Date(),
): CriticResultV1 {
  const hardViolations = Array.isArray(args.hard_violations) ? args.hard_violations : []
  const baseScore =
    0.6 +
    (args.state_delta.opp_hp_delta - args.state_delta.self_hp_delta) * 0.08 -
    args.state_delta.dice_spent * 0.03 -
    args.state_delta.cards_spent * 0.04 -
    hardViolations.length * 0.12
  const score = clampScore(baseScore)
  const outcome: CriticResultV1["outcome"] = score >= 0.75 ? "success" : score >= 0.45 ? "partial" : "fail"
  const shouldReplan = hardViolations.length > 0 || score < 0.4

  return {
    version: "CriticResultV1",
    session_id: args.session_id,
    plan_id: args.plan_id,
    turn: args.turn,
    step_id: args.step_id,
    outcome,
    score,
    violations: hardViolations.map((violation, index) => ({
      code: `HARD_VIOLATION_${index + 1}`,
      severity: "critical",
      message: violation,
    })),
    observations: [
      `expected_policy_id=${args.expected_policy_id}`,
      `actual_tool=${args.actual_tool}`,
      ...(typeof args.state_delta.notes === "string" && args.state_delta.notes.trim().length > 0
        ? [args.state_delta.notes]
        : []),
    ],
    suggested_adjustments: shouldReplan
      ? ["Trigger replan and tighten next-turn resource constraints."]
      : ["Continue current shard and optimize dice efficiency."],
    should_replan: shouldReplan,
    replan_scope: shouldReplan ? "micro" : "none",
    reason: shouldReplan
      ? "Hard violations or low critic score detected."
      : "Current tactic remains acceptable.",
    next_constraints: shouldReplan
      ? ["reduce high-risk commitments", "preserve core HP threshold"]
      : ["maintain tempo and avoid unnecessary omni usage"],
    evaluated_at: now.toISOString(),
  }
}
