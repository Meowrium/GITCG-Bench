export type PlanV2TriggerOperator = ">" | ">=" | "<" | "<=" | "==" | "!="

export type PlanV2ReplanScope = "micro" | "opening" | "midgame" | "full"

export type PlanV2FallbackPolicy =
  | "conservative"
  | "resource_hold"
  | "hp_stabilize"
  | "tempo_recover"

export type PlanV1 = {
  version: "PlanV1"
  plan_id: string
  session_id: string
  deck_fingerprint: string
  source_skills: string[]
  global_goal: string
  turn1_3_priorities: string[]
  risk_rules: string[]
  pivot_rules: string[]
  created_at: string
  updated_at: string
}

export type PlanV2 = {
  version: "PlanV2"
  plan_id: string
  session_id: string
  deck_fingerprint: string
  source_skills: string[]
  global_goal: string
  opening_window: {
    start_turn: number
    end_turn: number
  }
  turn_priorities: Array<{
    turn: number
    objectives: string[]
  }>
  risk_rules: Array<{
    id: string
    condition: string
    action: string
    priority: number
  }>
  pivot_rules: Array<{
    id: string
    when: string
    then: string
  }>
  trigger_rules: Array<{
    id: string
    event: string
    operator?: PlanV2TriggerOperator
    value?: number | string | boolean
    replan_scope: PlanV2ReplanScope
    cooldown_turns?: number
  }>
  fallback_rules: Array<{
    id: string
    on_failure: string
    policy: PlanV2FallbackPolicy
  }>
  created_at: string
  updated_at: string
  notes?: string
}
