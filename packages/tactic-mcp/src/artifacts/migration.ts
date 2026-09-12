import { createArtifactDescriptor, sanitizeSessionId, type CreateArtifactDescriptorArgs } from "./artifact-naming"

export function createLegacyCompatibleArtifactCandidates(
  args: CreateArtifactDescriptorArgs,
): string[] {
  const descriptor = createArtifactDescriptor(args)
  const candidates = [descriptor.path]

  if (args.kind === "plan") {
    candidates.push(descriptor.path.replace(/\.json$/, ".plan.json"))
  }

  return Array.from(new Set(candidates))
}

export function isArtifactOwnedBySession(path: string, sessionId: string): boolean {
  return path.includes(sanitizeSessionId(sessionId))
}
