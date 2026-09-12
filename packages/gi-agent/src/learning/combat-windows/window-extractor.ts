// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import {
  listRuntimeArtifacts,
  readJsonFile,
  type ParsedRuntimeArtifactPath,
} from "./artifact-utils.js"
import type {
  CandidateCombatWindow,
  CombatWindowExtractionConfig,
  CombatWindowExtractionResult,
  CombatWindowFingerprint,
  RuntimeCandidateAction,
  RuntimeDigestArtifact,
  RuntimeFeedbackArtifact,
  RuntimeFragmentArtifact,
  RuntimePlanArtifact,
  RuntimeWindowStep,
} from "./types.js"
import { deriveDeckFingerprintsFromRuntimeDigest } from "./runtime-digest-utils.js"

interface SessionArtifacts {
  session_id: string
  plan: ParsedRuntimeArtifactPath | null
  digests: ParsedRuntimeArtifactPath[]
  fragments: ParsedRuntimeArtifactPath[]
  feedbacks: ParsedRuntimeArtifactPath[]
}

interface SessionPlanMetadata {
  path: string | null
  deck_fingerprint_self: string | null
  global_goal: string | null
}

export class CombatWindowExtractor {
  async extract(config: CombatWindowExtractionConfig): Promise<CombatWindowExtractionResult> {
    const minActions = Math.max(2, config.min_actions ?? 2)
    const maxActions = Math.max(minActions, config.max_actions ?? 4)
    const topK = Math.max(1, config.top_k_per_session ?? 24)
    const artifacts = await listRuntimeArtifacts(config.runtime_plans_dir)
    const sessions = groupArtifactsBySession(artifacts, config.session_id)
    const windows: CandidateCombatWindow[] = []

    for (const session of sessions) {
      const extracted = await this.extractSessionWindows(session, {
        minActions,
        maxActions,
        topK,
        runtimePlansDir: config.runtime_plans_dir,
      })
      windows.push(...extracted)
    }

    return {
      generated_at: new Date().toISOString(),
      runtime_plans_dir: config.runtime_plans_dir,
      sessions_scanned: sessions.length,
      windows,
    }
  }

  private async extractSessionWindows(
    session: SessionArtifacts,
    options: {
      minActions: number
      maxActions: number
      topK: number
      runtimePlansDir: string
    },
  ): Promise<CandidateCombatWindow[]> {
    const plan = await loadPlanMetadata(session.plan)
    const digests = await loadArtifactsByRef<RuntimeDigestArtifact, "digest_ref">(session.digests, "digest_ref")
    const fragments = await loadArtifactsByRef<RuntimeFragmentArtifact, "fragment_ref">(session.fragments, "fragment_ref")
    const feedbacks = await Promise.all(
      session.feedbacks
        .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        .map(async (artifact) => ({
          artifact,
          payload: await readJsonFile<RuntimeFeedbackArtifact>(artifact.path),
        })),
    )

    const steps: RuntimeWindowStep[] = []
    for (const item of feedbacks) {
      const feedback = item.payload
      if (!feedback.execution_ok || !feedback.selected_candidate_id) {
        continue
      }
      const digest = digests.get(feedback.digest_ref)
      if (!digest || digest.pending_method !== "action") {
        continue
      }
      const fragment =
        typeof feedback.fragment_ref === "string" && feedback.fragment_ref.length > 0
          ? (fragments.get(feedback.fragment_ref) ?? null)
          : null
      const selectedCandidate =
        digest.candidate_actions.find((candidate) => candidate.candidate_id === feedback.selected_candidate_id) ?? null
      steps.push({
        step_index: steps.length,
        artifact_ts: item.artifact.timestamp ?? 0,
        digest,
        fragment,
        feedback,
        selected_candidate: selectedCandidate,
      })
    }

    const sequences = splitIntoSequences(steps)
    const candidates: CandidateCombatWindow[] = []

    for (let sequenceIndex = 0; sequenceIndex < sequences.length; sequenceIndex += 1) {
      const sequence = sequences[sequenceIndex]!
      if (sequence.length < options.minActions) {
        continue
      }
      for (let start = 0; start < sequence.length; start += 1) {
        for (let length = options.minActions; length <= options.maxActions; length += 1) {
          if (start + length > sequence.length) {
            continue
          }
          const slice = sequence.slice(start, start + length)
          candidates.push(
            buildCandidateWindow({
              sessionId: session.session_id,
              sequenceIndex,
              sequenceStartStep: start,
              plan,
              slice,
              runtimePlansDir: options.runtimePlansDir,
            }),
          )
        }
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, options.topK)
  }
}

function groupArtifactsBySession(
  artifacts: ParsedRuntimeArtifactPath[],
  sessionId: string | undefined,
): SessionArtifacts[] {
  const grouped = new Map<string, SessionArtifacts>()
  for (const artifact of artifacts) {
    if (sessionId && artifact.session_id !== sessionId) {
      continue
    }
    const current = grouped.get(artifact.session_id) ?? {
      session_id: artifact.session_id,
      plan: null,
      digests: [],
      fragments: [],
      feedbacks: [],
    }
    if (artifact.kind === "plan") {
      current.plan = artifact
    } else if (artifact.kind === "digest") {
      current.digests.push(artifact)
    } else if (artifact.kind === "fragment") {
      current.fragments.push(artifact)
    } else if (artifact.kind === "feedback") {
      current.feedbacks.push(artifact)
    }
    grouped.set(artifact.session_id, current)
  }
  return Array.from(grouped.values()).filter((session) => session.feedbacks.length > 0)
}

async function loadPlanMetadata(planArtifact: ParsedRuntimeArtifactPath | null): Promise<SessionPlanMetadata> {
  if (!planArtifact) {
    return {
      path: null,
      deck_fingerprint_self: null,
      global_goal: null,
    }
  }
  const plan = await readJsonFile<RuntimePlanArtifact>(planArtifact.path)
  return {
    path: planArtifact.path,
    deck_fingerprint_self: plan.deck_fingerprint ?? null,
    global_goal: plan.global_goal ?? null,
  }
}

async function loadArtifactsByRef<T extends Record<TKey, string>, TKey extends keyof T & string>(
  artifacts: ParsedRuntimeArtifactPath[],
  key: TKey,
): Promise<Map<string, T>> {
  const result = new Map<string, T>()
  for (const artifact of artifacts) {
    const payload = await readJsonFile<T>(artifact.path)
    result.set(payload[key], payload)
  }
  return result
}

function splitIntoSequences(steps: RuntimeWindowStep[]): RuntimeWindowStep[][] {
  if (steps.length === 0) {
    return []
  }
  const sequences: RuntimeWindowStep[][] = []
  let current: RuntimeWindowStep[] = []
  for (const step of steps) {
    const previous = current[current.length - 1]
    if (!previous || !shouldSplitSequence(previous, step)) {
      current.push(step)
      continue
    }
    sequences.push(current)
    current = [step]
  }
  if (current.length > 0) {
    sequences.push(current)
  }
  return sequences
}

function shouldSplitSequence(previous: RuntimeWindowStep, next: RuntimeWindowStep): boolean {
  const previousWindowId = previous.feedback.active_window_id ?? previous.digest.active_combat_window?.window_id ?? null
  const nextWindowId = next.feedback.active_window_id ?? next.digest.active_combat_window?.window_id ?? null
  if (previousWindowId && nextWindowId && previousWindowId !== nextWindowId) {
    return true
  }
  const transitionReason = (previous.feedback.transition_reason ?? "").toLowerCase()
  if (transitionReason === "completed" || transitionReason === "interrupted") {
    return true
  }
  if (previous.digest.round !== next.digest.round) {
    return true
  }
  if (previous.digest.turn !== next.digest.turn) {
    return true
  }
  return false
}

function buildCandidateWindow(args: {
  sessionId: string
  sequenceIndex: number
  sequenceStartStep: number
  plan: SessionPlanMetadata
  slice: RuntimeWindowStep[]
  runtimePlansDir: string
}): CandidateCombatWindow {
  const first = args.slice[0]!
  const last = args.slice[args.slice.length - 1]!
  const tags = collectWindowTags(args.slice)
  const stateFingerprint = buildStateFingerprint(first.digest, args.plan.deck_fingerprint_self, tags)
  const observedDecks = deriveDeckFingerprintsFromRuntimeDigest(first.digest)
  return {
    window_id: `${args.sessionId}_seq${args.sequenceIndex}_start${args.sequenceStartStep}_len${args.slice.length}`,
    session_id: args.sessionId,
    source_window_kind: "session_sequence",
    sequence_index: args.sequenceIndex,
    sequence_start_step: args.sequenceStartStep,
    action_count: args.slice.length,
    round: first.digest.round,
    turn: first.digest.turn,
    started_at: first.feedback.created_at ?? null,
    ended_at: last.feedback.created_at ?? null,
    score: scoreWindow(args.slice),
    deck_fingerprint_self: args.plan.deck_fingerprint_self ?? observedDecks.deck_fingerprint_self,
    deck_fingerprint_opp: observedDecks.deck_fingerprint_opp,
    strategic_profile_ref: first.digest.strategic_profile_ref ?? args.plan.path,
    global_goal: args.plan.global_goal,
    tags,
    state_fingerprint: stateFingerprint,
    source_paths: {
      plan_path: args.plan.path,
      artifact_dir: args.runtimePlansDir,
    },
    steps: args.slice,
  }
}

function collectWindowTags(steps: RuntimeWindowStep[]): string[] {
  const tagWeights = new Map<string, number>()
  for (const step of steps) {
    const selectedTags = step.selected_candidate?.tags ?? []
    for (const tag of [...selectedTags, step.selected_candidate?.action_case ?? "", step.fragment?.intent ?? ""]) {
      const normalized = tag.trim()
      if (!normalized) {
        continue
      }
      tagWeights.set(normalized, (tagWeights.get(normalized) ?? 0) + 1)
    }
  }
  return Array.from(tagWeights.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([tag]) => tag)
}

function buildStateFingerprint(
  digest: RuntimeDigestArtifact,
  deckFingerprintSelf: string | null,
  tags: string[],
): CombatWindowFingerprint {
  const selfActive = findCharacterSummary(digest.self_summary.active_character_id, digest.self_summary.characters)
  const oppActive = findCharacterSummary(digest.opponent_summary.active_character_id, digest.opponent_summary.characters)
  return {
    deck_fingerprint_self: deckFingerprintSelf,
    fingerprint_quality: "session",
    pending_method: digest.pending_method,
    round_bucket: `r${digest.round}`,
    turn_player: digest.turn,
    self_active_hp_bucket: bucketHp(selfActive?.hp ?? 0),
    opp_active_hp_bucket: bucketHp(oppActive?.hp ?? 0),
    self_active_energy_bucket: bucketEnergy(selfActive?.energy ?? 0, selfActive?.max_energy ?? 0),
    opp_active_energy_bucket: bucketEnergy(oppActive?.energy ?? 0, oppActive?.max_energy ?? 0),
    dice_bucket: bucketDice(digest.resource_summary.dice_count),
    omni_bucket: bucketDice(digest.resource_summary.omni_count),
    tags,
  }
}

function findCharacterSummary(characterId: number, list: RuntimeDigestArtifact["self_summary"]["characters"]) {
  return list.find((character) => character.id === characterId) ?? list[0]
}

function scoreWindow(steps: RuntimeWindowStep[]): number {
  let score = steps.length * 5
  for (const step of steps) {
    const actionCase = step.selected_candidate?.action_case ?? "unknown"
    if (actionCase === "useSkill" || actionCase === "playCard") {
      score += 4
    }
    if (actionCase === "switchActive") {
      score += 3
    }
    if (actionCase === "declareEnd") {
      score -= 2
    }
    if (step.feedback.fallback_used) {
      score -= 3
    }
    score += Math.min(step.digest.candidate_actions.length, 10)
    score += countInterestingTags(step.selected_candidate) * 2
  }
  return score
}

function countInterestingTags(candidate: RuntimeCandidateAction | null): number {
  if (!candidate) {
    return 0
  }
  const interesting = new Set(["burst", "reaction", "fast_switch", "summon", "heal", "shield", "valid"])
  return (candidate.tags ?? []).filter((tag) => interesting.has(tag)).length
}

function bucketHp(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 4) return "3-4"
  if (value <= 7) return "5-7"
  return "8+"
}

function bucketEnergy(value: number, maxValue: number): string {
  if (maxValue > 0 && value >= maxValue) {
    return "burst_ready"
  }
  if (value <= 0) return "0"
  return `${value}/${maxValue}`
}

function bucketDice(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 5) return "3-5"
  return "6+"
}
