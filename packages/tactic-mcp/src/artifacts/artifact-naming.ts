import { join, resolve } from "node:path"
import { TACTIC_PROTOCOL_VERSION } from "../registry/protocol-version"
import type {
  TacticArtifactEnvelope,
  TacticArtifactDescriptor,
  TacticArtifactKind,
  TacticArtifactSchemaVersion,
} from "./artifact-types"

export type CreateArtifactDescriptorArgs = {
  kind: TacticArtifactKind
  session_id: string
  runtime_plans_dir?: string
  timestamp?: number
  schema_version?: TacticArtifactSchemaVersion
  tool_name?: string
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

export function getRuntimePlansDir(cwd = process.cwd()): string {
  return resolve(cwd, "runtime-plans")
}

function buildArtifactFilename(kind: TacticArtifactKind, sanitizedSessionId: string, timestamp?: number): string {
  switch (kind) {
    case "plan":
      return `${sanitizedSessionId}.json`
    case "shard":
      return `${sanitizedSessionId}_shard_${timestamp}.json`
    case "digest":
      return `${sanitizedSessionId}_digest_${timestamp}.json`
    case "fragment":
      return `${sanitizedSessionId}_fragment_${timestamp}.json`
    case "feedback":
      return `${sanitizedSessionId}_feedback_${timestamp}.json`
    case "critic":
      return `${sanitizedSessionId}_critic_${timestamp}.json`
  }
}

export function createArtifactDescriptor(args: CreateArtifactDescriptorArgs): TacticArtifactDescriptor {
  const runtimePlansDir = args.runtime_plans_dir ?? getRuntimePlansDir()
  const sanitizedSessionId = sanitizeSessionId(args.session_id)
  const filename = buildArtifactFilename(args.kind, sanitizedSessionId, args.timestamp)

  return {
    kind: args.kind,
    session_id: args.session_id,
    sanitized_session_id: sanitizedSessionId,
    filename,
    path: join(runtimePlansDir, filename),
    protocol_version: TACTIC_PROTOCOL_VERSION,
    ...(typeof args.schema_version === "string" ? { schema_version: args.schema_version } : {}),
    ...(typeof args.tool_name === "string" ? { tool_name: args.tool_name } : {}),
    ...(typeof args.timestamp === "number" ? { timestamp: args.timestamp } : {}),
  }
}

export function createArtifactEnvelope<TPayload>(
  descriptor: TacticArtifactDescriptor,
  payload: TPayload,
): TacticArtifactEnvelope<TPayload> {
  return {
    protocol_version: descriptor.protocol_version,
    artifact: descriptor,
    payload,
  }
}
