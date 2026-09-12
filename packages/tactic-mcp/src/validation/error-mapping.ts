import { getUnknownToolRecoverHint, type TacticCanonicalToolName } from "../registry/tool-registry"
import type { TacticValidationError, TacticValidationStage } from "../TacticToolContractValidator"

export type TacticValidationDetail = NonNullable<TacticValidationError["details"]>[number]

export function buildUnknownToolError(toolName: string): TacticValidationError {
  return {
    error_code: "TACTIC_SCHEMA_UNKNOWN_TOOL",
    message: `Unknown tool contract: ${toolName}`,
    recover_hint: getUnknownToolRecoverHint(),
  }
}

export function buildSchemaValidationError(
  stage: TacticValidationStage,
  toolName: TacticCanonicalToolName,
  details: TacticValidationDetail[],
): TacticValidationError {
  return {
    error_code:
      stage === "request" ? "TACTIC_SCHEMA_REQUEST_INVALID" : "TACTIC_SCHEMA_RESPONSE_INVALID",
    message: `${toolName} ${stage} validation failed`,
    recover_hint:
      stage === "request"
        ? "Adjust tool arguments to satisfy the request schema."
        : "Fix tool output to satisfy the response schema.",
    details,
  }
}

export function buildSemanticValidationError(
  stage: TacticValidationStage,
  toolName: TacticCanonicalToolName,
  details: TacticValidationDetail[],
): TacticValidationError {
  return {
    error_code:
      stage === "request" ? "TACTIC_SEMANTIC_REQUEST_INVALID" : "TACTIC_SEMANTIC_RESPONSE_INVALID",
    message: `${toolName} ${stage} semantic validation failed`,
    recover_hint:
      stage === "request"
        ? "Adjust tool arguments to satisfy tactic semantic rules."
        : "Fix tool output to satisfy tactic semantic rules.",
    details,
  }
}
