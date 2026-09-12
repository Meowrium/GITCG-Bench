import type { DecisionShardV1 } from "../contracts"

export type BuildDecisionShardV1Args = {
  session_id: string
  plan_id: string
  shard_id?: string
  turn_range: DecisionShardV1["turn_range"]
  tactical_goal: string
  candidate_policies?: DecisionShardV1["candidate_policies"]
  execution_constraints?: Partial<DecisionShardV1["execution_constraints"]>
  fallback_chain?: DecisionShardV1["fallback_chain"]
  exit_conditions?: DecisionShardV1["exit_conditions"]
  combat_window_plan?: DecisionShardV1["combat_window_plan"]
  telemetry_requirements?: DecisionShardV1["telemetry_requirements"]
}

function buildDefaultPolicy(): DecisionShardV1["candidate_policies"][number] {
  return {
    id: "policy_default_fragmented_decision",
    priority: 50,
    preconditions: ["has_pending_rpc", "action_available"],
    action_template: {
      tool: "submit_decision_fragment_v1",
      args: {
        fragment_strategy: "pick_highest_valid_candidate",
      },
    },
  }
}

export function buildDefaultDecisionShardV1(
  args: BuildDecisionShardV1Args,
  now = new Date(),
): DecisionShardV1 {
  return {
    version: "DecisionShardV1",
    shard_id:
      typeof args.shard_id === "string" && args.shard_id.trim().length > 0
        ? args.shard_id
        : `shard_${args.session_id}_t${args.turn_range.start}_${now.getTime()}`,
    session_id: args.session_id,
    plan_id: args.plan_id,
    turn_range: args.turn_range,
    tactical_goal: args.tactical_goal,
    candidate_policies:
      Array.isArray(args.candidate_policies) && args.candidate_policies.length > 0
        ? args.candidate_policies
        : [buildDefaultPolicy()],
    execution_constraints: {
      max_actions_this_turn:
        Number.isInteger(args.execution_constraints?.max_actions_this_turn)
          ? args.execution_constraints!.max_actions_this_turn!
          : 3,
      dice_budget_mode:
        args.execution_constraints?.dice_budget_mode === "strict" ||
        args.execution_constraints?.dice_budget_mode === "balanced" ||
        args.execution_constraints?.dice_budget_mode === "aggressive"
          ? args.execution_constraints.dice_budget_mode
          : "balanced",
      ...(Array.isArray(args.execution_constraints?.protect_character_definition_ids)
        ? {
            protect_character_definition_ids: args.execution_constraints.protect_character_definition_ids,
          }
        : {}),
      ...(Array.isArray(args.execution_constraints?.forbid_actions)
        ? {
            forbid_actions: args.execution_constraints.forbid_actions,
          }
        : {}),
    },
    fallback_chain: Array.isArray(args.fallback_chain) ? args.fallback_chain : [],
    exit_conditions:
      Array.isArray(args.exit_conditions) && args.exit_conditions.length > 0
        ? args.exit_conditions
        : ["end_phase_reached"],
    ...(args.combat_window_plan ? { combat_window_plan: args.combat_window_plan } : {}),
    ...(args.telemetry_requirements ? { telemetry_requirements: args.telemetry_requirements } : {}),
  }
}
