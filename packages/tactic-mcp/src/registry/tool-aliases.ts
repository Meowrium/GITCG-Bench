export const TACTIC_TOOL_ALIASES = {
  create_decision_shard_v2: "create_decision_shard_v1",
} as const

export type TacticToolAliasName = keyof typeof TACTIC_TOOL_ALIASES
