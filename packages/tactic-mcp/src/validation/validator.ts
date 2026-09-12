import type { ErrorObject } from "ajv/dist/2020.js"
import type { TacticCanonicalToolName } from "../registry/tool-registry"
import type { TacticValidationResult, TacticValidationStage } from "../TacticToolContractValidator"
import {
  buildSchemaValidationError,
  type TacticValidationDetail,
} from "./error-mapping"
import { validateSemanticRequest, validateSemanticResponse } from "./semantic-validator"

export function mapAjvErrors(errors: ErrorObject[]): TacticValidationDetail[] {
  return errors.map((error) => ({
    field: error.instancePath || "/",
    rule: error.keyword,
    message: error.message ?? "schema validation error",
    params: (error.params ?? {}) as Record<string, unknown>,
  }))
}

export function buildSchemaResult(
  stage: TacticValidationStage,
  toolName: TacticCanonicalToolName,
  errors: ErrorObject[],
): TacticValidationResult {
  return {
    ok: false,
    error: buildSchemaValidationError(stage, toolName, mapAjvErrors(errors)),
  }
}

export function buildSemanticRequestResult(
  toolName: TacticCanonicalToolName,
  args: Record<string, unknown>,
): TacticValidationResult {
  return validateSemanticRequest(toolName, args)
}

export function buildSemanticResponseResult(
  toolName: TacticCanonicalToolName,
  payload: Record<string, unknown>,
): TacticValidationResult {
  return validateSemanticResponse(toolName, payload)
}
