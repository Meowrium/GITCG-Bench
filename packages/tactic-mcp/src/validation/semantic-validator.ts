import type { TacticCanonicalToolName } from "../registry/tool-registry"
import type { TacticValidationStage } from "../TacticToolContractValidator"
import { buildSemanticValidationError, type TacticValidationDetail } from "./error-mapping"

type SemanticValidationResult =
  | { ok: true }
  | { ok: false; error: ReturnType<typeof buildSemanticValidationError> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function pushRangeOrderIssue(
  details: TacticValidationDetail[],
  field: string,
  start: unknown,
  end: unknown,
) {
  if (Number.isInteger(start) && Number.isInteger(end) && (end as number) < (start as number)) {
    details.push({
      field,
      rule: "range_order",
      message: "end must be greater than or equal to start",
      params: {
        start,
        end,
      },
    })
  }
}

function pushReplanConsistencyIssue(details: TacticValidationDetail[], payload: Record<string, unknown>) {
  if (payload.should_replan === false && payload.replan_scope !== "none") {
    details.push({
      field: "/critic_result/replan_scope",
      rule: "replan_consistency",
      message: "replan_scope must be 'none' when should_replan is false",
      params: {
        should_replan: payload.should_replan,
        replan_scope: payload.replan_scope,
      },
    })
  }
}

export function validateSemanticRequest(
  toolName: TacticCanonicalToolName,
  args: Record<string, unknown>,
): SemanticValidationResult {
  const details: TacticValidationDetail[] = []

  if (toolName === "create_opening_plan_v2" && isRecord(args.opening_window)) {
    pushRangeOrderIssue(
      details,
      "/arguments/opening_window",
      args.opening_window.start_turn,
      args.opening_window.end_turn,
    )
  }

  if (toolName === "create_decision_shard_v1" && isRecord(args.turn_range)) {
    pushRangeOrderIssue(
      details,
      "/arguments/turn_range",
      args.turn_range.start,
      args.turn_range.end,
    )
  }

  if (details.length === 0) {
    return { ok: true }
  }

  return {
    ok: false,
    error: buildSemanticValidationError("request", toolName, details),
  }
}

export function validateSemanticResponse(
  toolName: TacticCanonicalToolName,
  payload: Record<string, unknown>,
): SemanticValidationResult {
  const details: TacticValidationDetail[] = []

  if (toolName === "create_opening_plan_v2" && isRecord(payload.plan) && isRecord(payload.plan.opening_window)) {
    pushRangeOrderIssue(
      details,
      "/plan/opening_window",
      payload.plan.opening_window.start_turn,
      payload.plan.opening_window.end_turn,
    )
  }

  if (
    toolName === "create_decision_shard_v1" &&
    isRecord(payload.decision_shard) &&
    isRecord(payload.decision_shard.turn_range)
  ) {
    pushRangeOrderIssue(
      details,
      "/decision_shard/turn_range",
      payload.decision_shard.turn_range.start,
      payload.decision_shard.turn_range.end,
    )
  }

  if (toolName === "critic_evaluate_v1" && isRecord(payload.critic_result)) {
    pushReplanConsistencyIssue(details, payload.critic_result)
  }

  if (details.length === 0) {
    return { ok: true }
  }

  return {
    ok: false,
    error: buildSemanticValidationError("response", toolName, details),
  }
}
