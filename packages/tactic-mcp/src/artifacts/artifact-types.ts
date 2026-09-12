export type TacticArtifactKind =
  | "plan"
  | "shard"
  | "digest"
  | "fragment"
  | "feedback"
  | "critic"

export type TacticArtifactSchemaVersion =
  | "PlanV1"
  | "PlanV2"
  | "DecisionShardV1"
  | "TurnDigestV1"
  | "DecisionFragmentV1"
  | "ExecutionFeedbackV1"
  | "CriticResultV1"

export type TacticArtifactDescriptor = {
  kind: TacticArtifactKind
  session_id: string
  sanitized_session_id: string
  filename: string
  path: string
  protocol_version: string
  schema_version?: TacticArtifactSchemaVersion
  tool_name?: string
  timestamp?: number
}

export type TacticArtifactEnvelope<TPayload = unknown> = {
  protocol_version: string
  artifact: TacticArtifactDescriptor
  payload: TPayload
}
