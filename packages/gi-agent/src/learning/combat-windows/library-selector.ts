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

import type { PolicyTurnDigest } from "../../runtime/policy/types.js"
import type {
  CombatWindowLibrary,
  CombatWindowLibraryEntry,
} from "./export-library.js"
import {
  collectRuntimeCandidateDefinitionIds,
  deriveDeckFingerprintsFromRuntimeDigest,
  findRuntimeCharacterSummary,
  normalizeRuntimeTags,
  resolveRuntimeActiveDefinitionIds,
} from "./runtime-digest-utils.js"
import type {
  CandidateCombatWindow,
  CanonicalCombatWindowFingerprint,
  RuntimeDigestArtifact,
} from "./types.js"

export interface CombatWindowLibraryQuery {
  source:
    | "candidate_window"
    | "runtime_window"
    | "runtime_digest"
    | "policy_digest"
    | "canonical_fingerprint"
  deck_fingerprint_self: string | null
  deck_fingerprint_opp: string | null
  matchup_id: string | null
  pending_method: string
  round_bucket: string
  turn_player: number
  self_active_character_definition_id: number | null
  opp_active_character_definition_id: number | null
  self_active_hp_bucket: string
  opp_active_hp_bucket: string
  self_active_energy_bucket: string
  opp_active_energy_bucket: string
  dice_bucket: string
  omni_bucket: string
  support_bucket: string
  summon_bucket: string
  cards_in_hand_bucket: string
  action_count_bucket: string | null
  candidate_action_cases: string[]
  candidate_action_definition_ids: number[]
  candidate_action_tags: string[]
}

export interface CombatWindowLibraryQueryOptions {
  deckFingerprintSelf?: string | null
  deckFingerprintOpp?: string | null
  matchupId?: string | null
  selfActiveCharacterDefinitionId?: number | null
  oppActiveCharacterDefinitionId?: number | null
  expectedActionCount?: number | null
  pendingMethod?: string
}

export interface RankedCombatWindowLibraryEntry {
  entry: CombatWindowLibraryEntry
  state_similarity: number
  quality_prior: number
  final_score: number
  matched_fields: string[]
  mismatch_fields: string[]
}

export interface CombatWindowLibrarySelection {
  query: CombatWindowLibraryQuery
  candidate_count: number
  returned_count: number
  matches: RankedCombatWindowLibraryEntry[]
}

export interface CombatWindowLibrarySelectorOptions {
  limit?: number
  minScore?: number
  requireSameSelfDeck?: boolean
  includeRejected?: boolean
  dedupeByCanonicalKey?: boolean
}

export function buildLibraryQueryFromWindow(
  window: CandidateCombatWindow,
  options: CombatWindowLibraryQueryOptions = {},
): CombatWindowLibraryQuery {
  const firstDigest = window.steps[0]?.digest
  const selfActive = firstDigest
    ? findRuntimeCharacterSummary(
        firstDigest.self_summary.characters,
        firstDigest.self_summary.active_character_id,
      )
    : null
  const oppActive = firstDigest
    ? findRuntimeCharacterSummary(
        firstDigest.opponent_summary.characters,
        firstDigest.opponent_summary.active_character_id,
      )
    : null
  const candidates = firstDigest?.candidate_actions ?? []
  const observedDecks = firstDigest
    ? deriveDeckFingerprintsFromRuntimeDigest(firstDigest)
    : { deck_fingerprint_self: null, deck_fingerprint_opp: null }
  const observedActiveDefinitions = firstDigest
    ? resolveRuntimeActiveDefinitionIds(firstDigest)
    : {
        self_active_character_definition_id: null,
        opp_active_character_definition_id: null,
      }

  return {
    source: "candidate_window",
    deck_fingerprint_self:
      options.deckFingerprintSelf ??
      window.deck_fingerprint_self ??
      observedDecks.deck_fingerprint_self ??
      window.state_fingerprint.deck_fingerprint_self,
    deck_fingerprint_opp:
      options.deckFingerprintOpp ??
      window.deck_fingerprint_opp ??
      observedDecks.deck_fingerprint_opp,
    matchup_id: options.matchupId ?? null,
    pending_method:
      options.pendingMethod ??
      firstDigest?.pending_method ??
      window.state_fingerprint.pending_method,
    round_bucket: window.state_fingerprint.round_bucket,
    turn_player: window.turn,
    self_active_character_definition_id:
      options.selfActiveCharacterDefinitionId ??
      observedActiveDefinitions.self_active_character_definition_id,
    opp_active_character_definition_id:
      options.oppActiveCharacterDefinitionId ??
      observedActiveDefinitions.opp_active_character_definition_id,
    self_active_hp_bucket:
      selfActive != null
        ? bucketHp(selfActive.hp)
        : window.state_fingerprint.self_active_hp_bucket,
    opp_active_hp_bucket:
      oppActive != null
        ? bucketHp(oppActive.hp)
        : window.state_fingerprint.opp_active_hp_bucket,
    self_active_energy_bucket:
      selfActive != null
        ? bucketEnergy(selfActive.energy, selfActive.max_energy)
        : window.state_fingerprint.self_active_energy_bucket,
    opp_active_energy_bucket:
      oppActive != null
        ? bucketEnergy(oppActive.energy, oppActive.max_energy)
        : window.state_fingerprint.opp_active_energy_bucket,
    dice_bucket: window.state_fingerprint.dice_bucket,
    omni_bucket: window.state_fingerprint.omni_bucket,
    support_bucket: bucketCount(
      Number(firstDigest?.resource_summary.support_count ?? 0),
    ),
    summon_bucket: bucketCount(
      Number(firstDigest?.resource_summary.summon_count ?? 0),
    ),
    cards_in_hand_bucket: bucketCount(
      Number(
        firstDigest?.resource_summary.cards_in_hand ??
          firstDigest?.self_summary.hand_count ??
          0,
      ),
    ),
    action_count_bucket: bucketActionCount(window.action_count),
    candidate_action_cases: uniqueStrings(
      candidates.map((candidate) => candidate.action_case),
    ),
    candidate_action_definition_ids: collectRuntimeCandidateDefinitionIds(candidates),
    candidate_action_tags: uniqueStrings(
      candidates.flatMap((candidate) => normalizeRuntimeTags(candidate.tags)),
    ),
  }
}

export function buildLibraryQueryFromRuntimeDigest(
  digest: RuntimeDigestArtifact,
  options: CombatWindowLibraryQueryOptions = {},
): CombatWindowLibraryQuery {
  const selfActive = findRuntimeCharacterSummary(
    digest.self_summary.characters,
    digest.self_summary.active_character_id,
  )
  const oppActive = findRuntimeCharacterSummary(
    digest.opponent_summary.characters,
    digest.opponent_summary.active_character_id,
  )
  const observedDecks = deriveDeckFingerprintsFromRuntimeDigest(digest)
  const observedActiveDefinitions = resolveRuntimeActiveDefinitionIds(digest)

  return {
    source: "runtime_digest",
    deck_fingerprint_self:
      options.deckFingerprintSelf ?? observedDecks.deck_fingerprint_self,
    deck_fingerprint_opp:
      options.deckFingerprintOpp ?? observedDecks.deck_fingerprint_opp,
    matchup_id: options.matchupId ?? null,
    pending_method: options.pendingMethod ?? digest.pending_method,
    round_bucket: bucketRound(digest.round),
    turn_player: digest.turn,
    self_active_character_definition_id:
      options.selfActiveCharacterDefinitionId ??
      observedActiveDefinitions.self_active_character_definition_id,
    opp_active_character_definition_id:
      options.oppActiveCharacterDefinitionId ??
      observedActiveDefinitions.opp_active_character_definition_id,
    self_active_hp_bucket: bucketHp(Number(selfActive?.hp ?? 0)),
    opp_active_hp_bucket: bucketHp(Number(oppActive?.hp ?? 0)),
    self_active_energy_bucket: bucketEnergy(
      Number(selfActive?.energy ?? 0),
      Number(selfActive?.max_energy ?? 0),
    ),
    opp_active_energy_bucket: bucketEnergy(
      Number(oppActive?.energy ?? 0),
      Number(oppActive?.max_energy ?? 0),
    ),
    dice_bucket: bucketDice(Number(digest.resource_summary.dice_count ?? 0)),
    omni_bucket: bucketDice(Number(digest.resource_summary.omni_count ?? 0)),
    support_bucket: bucketCount(
      Number(digest.resource_summary.support_count ?? 0),
    ),
    summon_bucket: bucketCount(
      Number(digest.resource_summary.summon_count ?? 0),
    ),
    cards_in_hand_bucket: bucketCount(
      Number(
        digest.resource_summary.cards_in_hand ??
          digest.self_summary.hand_count ??
          0,
      ),
    ),
    action_count_bucket:
      options.expectedActionCount != null
        ? bucketActionCount(options.expectedActionCount)
        : null,
    candidate_action_cases: uniqueStrings(
      digest.candidate_actions.map((candidate) => candidate.action_case),
    ),
    candidate_action_definition_ids: collectRuntimeCandidateDefinitionIds(
      digest.candidate_actions,
    ),
    candidate_action_tags: uniqueStrings(
      digest.candidate_actions.flatMap((candidate) =>
        normalizeRuntimeTags(candidate.tags),
      ),
    ),
  }
}

export function buildLibraryQueryFromPolicyDigest(
  digest: PolicyTurnDigest,
  options: CombatWindowLibraryQueryOptions = {},
): CombatWindowLibraryQuery {
  const selfCharacters = arrayOfRecords(digest.self_summary.characters)
  const oppCharacters = arrayOfRecords(digest.opponent_summary.characters)
  const selfActive = findPolicyCharacter(
    selfCharacters,
    Number(digest.self_summary.active_character_id ?? 0),
  )
  const oppActive = findPolicyCharacter(
    oppCharacters,
    Number(digest.opponent_summary.active_character_id ?? 0),
  )
  const candidates = digest.candidate_actions ?? []

  return {
    source: "policy_digest",
    deck_fingerprint_self: options.deckFingerprintSelf ?? null,
    deck_fingerprint_opp: options.deckFingerprintOpp ?? null,
    matchup_id: options.matchupId ?? null,
    pending_method: options.pendingMethod ?? "action",
    round_bucket: bucketRound(digest.round),
    turn_player: digest.turn,
    self_active_character_definition_id:
      options.selfActiveCharacterDefinitionId ?? null,
    opp_active_character_definition_id:
      options.oppActiveCharacterDefinitionId ?? null,
    self_active_hp_bucket: bucketHp(Number(selfActive?.hp ?? 0)),
    opp_active_hp_bucket: bucketHp(Number(oppActive?.hp ?? 0)),
    self_active_energy_bucket: bucketEnergy(
      Number(selfActive?.energy ?? 0),
      Number(selfActive?.max_energy ?? 0),
    ),
    opp_active_energy_bucket: bucketEnergy(
      Number(oppActive?.energy ?? 0),
      Number(oppActive?.max_energy ?? 0),
    ),
    dice_bucket: bucketDice(Number(digest.resource_summary.dice_count ?? 0)),
    omni_bucket: bucketDice(Number(digest.resource_summary.omni_count ?? 0)),
    support_bucket: bucketCount(
      Number(digest.resource_summary.support_count ?? 0),
    ),
    summon_bucket: bucketCount(
      Number(digest.resource_summary.summon_count ?? 0),
    ),
    cards_in_hand_bucket: bucketCount(
      Number(digest.resource_summary.cards_in_hand ?? 0),
    ),
    action_count_bucket:
      options.expectedActionCount != null
        ? bucketActionCount(options.expectedActionCount)
        : null,
    candidate_action_cases: uniqueStrings(
      candidates.map((candidate) =>
        typeof candidate.action_case === "string" ? candidate.action_case : null,
      ),
    ),
    candidate_action_definition_ids: uniqueNumbers(
      candidates.map((candidate) =>
        typeof candidate.card_definition_id === "number"
          ? candidate.card_definition_id
          : null,
      ),
    ),
    candidate_action_tags: uniqueStrings(
      candidates.flatMap((candidate) => normalizeRuntimeTags(candidate.tags)),
    ),
  }
}

export function buildLibraryQueryFromCanonicalFingerprint(
  fingerprint: CanonicalCombatWindowFingerprint,
): CombatWindowLibraryQuery {
  return {
    source: "canonical_fingerprint",
    deck_fingerprint_self: fingerprint.deck_fingerprint_self,
    deck_fingerprint_opp: fingerprint.deck_fingerprint_opp,
    matchup_id: fingerprint.matchup_id,
    pending_method: fingerprint.pending_method,
    round_bucket: fingerprint.round_bucket,
    turn_player: fingerprint.turn_player,
    self_active_character_definition_id:
      fingerprint.self_active_character_definition_id,
    opp_active_character_definition_id:
      fingerprint.opp_active_character_definition_id,
    self_active_hp_bucket: fingerprint.self_active_hp_bucket,
    opp_active_hp_bucket: fingerprint.opp_active_hp_bucket,
    self_active_energy_bucket: fingerprint.self_active_energy_bucket,
    opp_active_energy_bucket: fingerprint.opp_active_energy_bucket,
    dice_bucket: fingerprint.dice_bucket,
    omni_bucket: fingerprint.omni_bucket,
    support_bucket: fingerprint.support_bucket,
    summon_bucket: fingerprint.summon_bucket,
    cards_in_hand_bucket: fingerprint.cards_in_hand_bucket,
    action_count_bucket: fingerprint.action_count_bucket,
    candidate_action_cases: fingerprint.first_action_case
      ? [fingerprint.first_action_case]
      : [],
    candidate_action_definition_ids:
      fingerprint.first_action_definition_id != null
        ? [fingerprint.first_action_definition_id]
        : [],
    candidate_action_tags: fingerprint.first_action_tags,
  }
}

export function selectCombatWindowLibrary(
  library: CombatWindowLibrary,
  query: CombatWindowLibraryQuery,
  options: CombatWindowLibrarySelectorOptions = {},
): CombatWindowLibrarySelection {
  const requireSameSelfDeck = options.requireSameSelfDeck ?? true
  const includeRejected = options.includeRejected ?? false
  const dedupeByCanonicalKey = options.dedupeByCanonicalKey ?? true
  const minScore = options.minScore ?? 0.45
  const limit = options.limit ?? 5

  const candidateEntries = library.entries.filter((entry) => {
    if (!includeRejected && entry.status === "rejected") {
      return false
    }
    if (
      requireSameSelfDeck &&
      query.deck_fingerprint_self &&
      entry.deck_fingerprint_self &&
      query.deck_fingerprint_self !== entry.deck_fingerprint_self
    ) {
      return false
    }
    return true
  })

  const ranked = candidateEntries
    .map((entry) => rankLibraryEntry(entry, query))
    .filter((match) => match.final_score >= minScore)
    .sort((left, right) => {
      if (right.final_score !== left.final_score) {
        return right.final_score - left.final_score
      }
      if (right.state_similarity !== left.state_similarity) {
        return right.state_similarity - left.state_similarity
      }
      return statusRank(right.entry.status) - statusRank(left.entry.status)
    })

  const selected = dedupeByCanonicalKey ? dedupeMatches(ranked) : ranked
  const matches = selected.slice(0, limit)
  return {
    query,
    candidate_count: candidateEntries.length,
    returned_count: matches.length,
    matches,
  }
}

function rankLibraryEntry(
  entry: CombatWindowLibraryEntry,
  query: CombatWindowLibraryQuery,
): RankedCombatWindowLibraryEntry {
  const matchedFields: string[] = []
  const mismatchFields: string[] = []
  let score = 0
  let maxScore = 0

  const compareExact = <T>(
    field: string,
    queryValue: T | null | undefined,
    entryValue: T | null | undefined,
    weight: number,
  ) => {
    if (queryValue == null || queryValue === "") {
      return
    }
    maxScore += weight
    if (queryValue === entryValue) {
      score += weight
      matchedFields.push(field)
    } else {
      mismatchFields.push(field)
    }
  }

  compareExact("deck_fingerprint_self", query.deck_fingerprint_self, entry.deck_fingerprint_self, 6)
  compareExact("deck_fingerprint_opp", query.deck_fingerprint_opp, entry.deck_fingerprint_opp, 4)
  compareExact("matchup_id", query.matchup_id, entry.matchup_id, 3)
  compareExact("pending_method", query.pending_method, entry.fingerprint.pending_method, 1)
  compareExact("round_bucket", query.round_bucket, entry.fingerprint.round_bucket, 2)
  compareExact("turn_player", query.turn_player, entry.fingerprint.turn_player, 1)
  compareExact(
    "self_active_character_definition_id",
    query.self_active_character_definition_id,
    entry.fingerprint.self_active_character_definition_id,
    3,
  )
  compareExact(
    "opp_active_character_definition_id",
    query.opp_active_character_definition_id,
    entry.fingerprint.opp_active_character_definition_id,
    3,
  )
  compareExact(
    "self_active_hp_bucket",
    query.self_active_hp_bucket,
    entry.fingerprint.self_active_hp_bucket,
    2,
  )
  compareExact(
    "opp_active_hp_bucket",
    query.opp_active_hp_bucket,
    entry.fingerprint.opp_active_hp_bucket,
    2,
  )
  compareExact(
    "self_active_energy_bucket",
    query.self_active_energy_bucket,
    entry.fingerprint.self_active_energy_bucket,
    1.5,
  )
  compareExact(
    "opp_active_energy_bucket",
    query.opp_active_energy_bucket,
    entry.fingerprint.opp_active_energy_bucket,
    1.5,
  )
  compareExact("dice_bucket", query.dice_bucket, entry.fingerprint.dice_bucket, 1)
  compareExact("omni_bucket", query.omni_bucket, entry.fingerprint.omni_bucket, 1)
  compareExact("support_bucket", query.support_bucket, entry.fingerprint.support_bucket, 1)
  compareExact("summon_bucket", query.summon_bucket, entry.fingerprint.summon_bucket, 1)
  compareExact(
    "cards_in_hand_bucket",
    query.cards_in_hand_bucket,
    entry.fingerprint.cards_in_hand_bucket,
    1,
  )
  compareExact(
    "action_count_bucket",
    query.action_count_bucket,
    entry.fingerprint.action_count_bucket,
    1,
  )

  if (query.candidate_action_cases.length > 0 && entry.fingerprint.first_action_case) {
    maxScore += 2
    if (query.candidate_action_cases.includes(entry.fingerprint.first_action_case)) {
      score += 2
      matchedFields.push("first_action_case")
    } else {
      mismatchFields.push("first_action_case")
    }
  }

  if (
    query.candidate_action_definition_ids.length > 0 &&
    entry.fingerprint.first_action_definition_id != null
  ) {
    maxScore += 1.5
    if (
      query.candidate_action_definition_ids.includes(
        entry.fingerprint.first_action_definition_id,
      )
    ) {
      score += 1.5
      matchedFields.push("first_action_definition_id")
    } else {
      mismatchFields.push("first_action_definition_id")
    }
  }

  const queryTags = new Set(query.candidate_action_tags)
  const entryTags = new Set(entry.fingerprint.first_action_tags)
  if (queryTags.size > 0 && entryTags.size > 0) {
    maxScore += 1.5
    const overlap = [...entryTags].filter((tag) => queryTags.has(tag)).length
    if (overlap > 0) {
      const normalized = overlap / Math.min(3, entryTags.size, queryTags.size)
      score += Math.min(1.5, normalized * 1.5)
      matchedFields.push("first_action_tags")
    } else {
      mismatchFields.push("first_action_tags")
    }
  }

  const stateSimilarity = maxScore > 0 ? score / maxScore : 0
  const qualityPrior = computeQualityPrior(entry)
  return {
    entry,
    state_similarity: stateSimilarity,
    quality_prior: qualityPrior,
    final_score: clamp(stateSimilarity * 0.85 + qualityPrior * 0.15, 0, 1),
    matched_fields: matchedFields,
    mismatch_fields: mismatchFields,
  }
}

function dedupeMatches(
  matches: RankedCombatWindowLibraryEntry[],
): RankedCombatWindowLibraryEntry[] {
  const bestByKey = new Map<string, RankedCombatWindowLibraryEntry>()
  for (const match of matches) {
    const previous = bestByKey.get(match.entry.canonical_key)
    if (!previous || match.final_score > previous.final_score) {
      bestByKey.set(match.entry.canonical_key, match)
    }
  }
  return [...bestByKey.values()].sort((left, right) => {
    if (right.final_score !== left.final_score) {
      return right.final_score - left.final_score
    }
    if (right.state_similarity !== left.state_similarity) {
      return right.state_similarity - left.state_similarity
    }
    return statusRank(right.entry.status) - statusRank(left.entry.status)
  })
}

function computeQualityPrior(entry: CombatWindowLibraryEntry): number {
  const statusBase = statusRank(entry.status) / 4
  const promoteBias =
    entry.promote_signal === "promote"
      ? 0.1
      : entry.promote_signal === "hold"
        ? 0.03
        : entry.promote_signal === "reject"
          ? -0.1
          : 0
  return clamp(
    statusBase * 0.45 +
      entry.llm_confidence * 0.35 +
      entry.generalization_confidence * 0.2 +
      promoteBias,
    0,
    1,
  )
}

function statusRank(status: CombatWindowLibraryEntry["status"]): number {
  switch (status) {
    case "promoted":
      return 4
    case "validated":
      return 3
    case "draft":
      return 2
    case "rejected":
      return 1
    default:
      return 0
  }
}

function findPolicyCharacter(
  list: Array<Record<string, unknown>>,
  activeCharacterId: number,
): Record<string, unknown> | null {
  return (
    list.find((character) => Number(character.id ?? 0) === activeCharacterId) ??
    list[0] ??
    null
  )
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item != null && typeof item === "object",
      )
    : []
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value != null))]
}

function bucketRound(round: number): string {
  return `r${Math.max(0, round)}`
}

function bucketHp(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 4) return "3-4"
  if (value <= 7) return "5-7"
  return "8+"
}

function bucketDice(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 5) return "3-5"
  return "6+"
}

function bucketCount(value: number): string {
  if (value <= 0) return "0"
  if (value === 1) return "1"
  if (value <= 3) return "2-3"
  return "4+"
}

function bucketEnergy(value: number, maxValue: number): string {
  if (maxValue > 0 && value >= maxValue) {
    return "burst_ready"
  }
  if (value <= 0) return "0"
  return `${value}/${maxValue}`
}

function bucketActionCount(value: number): string {
  if (value <= 2) return "2"
  if (value === 3) return "3"
  return "4+"
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
