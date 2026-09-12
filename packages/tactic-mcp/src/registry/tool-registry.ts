import { join } from "node:path"
import { TACTIC_TOOL_ALIASES, type TacticToolAliasName } from "./tool-aliases"

export type TacticCanonicalToolName =
  | "create_opening_plan_v2"
  | "create_decision_shard_v1"
  | "critic_evaluate_v1"

export type TacticToolName = TacticCanonicalToolName | TacticToolAliasName

export type ToolContractsIndex = {
  tools: Array<{
    name: TacticCanonicalToolName
    request_schema: string
    response_schema: string
  }>
}

export type TacticToolContractEntry = ToolContractsIndex["tools"][number]

const UNKNOWN_TOOL_RECOVER_HINT =
  "Use one of create_opening_plan_v2/create_decision_shard_v1/create_decision_shard_v2/critic_evaluate_v1."

export function getUnknownToolRecoverHint(): string {
  return UNKNOWN_TOOL_RECOVER_HINT
}

export function resolveCanonicalToolName(toolName: string): TacticCanonicalToolName | null {
  if (toolName in TACTIC_TOOL_ALIASES) {
    return TACTIC_TOOL_ALIASES[toolName as TacticToolAliasName]
  }

  if (
    toolName === "create_opening_plan_v2" ||
    toolName === "create_decision_shard_v1" ||
    toolName === "critic_evaluate_v1"
  ) {
    return toolName
  }

  return null
}

export function getIndexPath(schemasRoot: string): string {
  return join(schemasRoot, "mcp", "tool-contracts.index.json")
}

export function getContractPaths(schemasRoot: string, entry: TacticToolContractEntry) {
  const indexDir = join(schemasRoot, "mcp")
  return {
    requestSchemaPath: join(indexDir, entry.request_schema),
    responseSchemaPath: join(indexDir, entry.response_schema),
  }
}
