export type DecisionShardActionTool =
  | "submit_decision_fragment_v1"
  | "choose_action"
  | "elemental_tuning"
  | "choose_active"
  | "reroll_dice"
  | "switch_hands"
  | "select_card"

export type DecisionShardBudgetMode = "strict" | "balanced" | "aggressive"

export type DecisionShardFallbackPolicy =
  | "skip_low_value"
  | "save_dice"
  | "hp_stabilize"
  | "force_switch"

export type CombatWindowNodeKind =
  | "setup"
  | "pivot"
  | "convert"
  | "burst"
  | "survive"
  | "exit"

export type CombatWindowPlanNodeV1 = {
  id: string
  kind: CombatWindowNodeKind
  intent: string
  expected_action_case?: Array<"useSkill" | "playCard" | "switchActive" | "declareEnd" | "selectCard">
  when: string[]
  must_do: string[]
  avoid: string[]
  prefer_tags: string[]
  resource_policy?: DecisionShardBudgetMode
  fallback_rule?: string
  next: Array<{
    condition: string
    to: string
    priority: number
  }>
}

export type CombatWindowPlanV1 = {
  window_id: string
  plan_horizon: {
    min_actions: number
    max_actions: number
  }
  entry_conditions: string[]
  interrupt_conditions: string[]
  success_conditions: string[]
  fail_conditions: string[]
  entry_node_id: string
  nodes: CombatWindowPlanNodeV1[]
}

export type DecisionShardV1 = {
  version: "DecisionShardV1"
  shard_id: string
  session_id: string
  plan_id: string
  turn_range: {
    start: number
    end: number
  }
  tactical_goal: string
  candidate_policies: Array<{
    id: string
    priority: number
    preconditions: string[]
    action_template: {
      tool: DecisionShardActionTool
      args: Record<string, unknown>
    }
  }>
  execution_constraints: {
    max_actions_this_turn: number
    dice_budget_mode: DecisionShardBudgetMode
    protect_character_definition_ids?: number[]
    forbid_actions?: string[]
  }
  fallback_chain: Array<{
    when: string
    policy: DecisionShardFallbackPolicy
  }>
  exit_conditions: string[]
  combat_window_plan?: CombatWindowPlanV1
  telemetry_requirements?: {
    record_fields?: string[]
  }
}
