export type CriticOutcome = "success" | "partial" | "fail"

export type CriticSeverity = "low" | "medium" | "high" | "critical"

export type CriticReplanScope = "none" | "micro" | "opening" | "midgame" | "full"

export type CriticResultV1 = {
  version: "CriticResultV1"
  session_id: string
  plan_id: string
  turn: number
  step_id: string
  outcome: CriticOutcome
  score: number
  violations: Array<{
    code: string
    severity: CriticSeverity
    message: string
  }>
  observations: string[]
  suggested_adjustments: string[]
  should_replan: boolean
  replan_scope: CriticReplanScope
  reason: string
  next_constraints: string[]
  evaluated_at: string
}
