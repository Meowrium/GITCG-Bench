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

import type {
  RuntimeCandidateAction,
  RuntimeCharacterDefinitionInfo,
  RuntimeCharacterSummary,
  RuntimeDigestArtifact,
} from "./types.js"

const CANDIDATE_DEF_PATTERNS = [
  /(?:skill|card)_def_id=(\d+)/i,
  /selected_definition_id=(\d+)/i,
  /target_character_def_id=(\d+)/i,
]

export function findRuntimeCharacterSummary(
  list: RuntimeCharacterSummary[],
  activeCharacterId: number,
): RuntimeCharacterSummary | null {
  return list.find((character) => character.id === activeCharacterId) ?? list[0] ?? null
}

export function normalizeRuntimeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0)
    : []
}

export function buildRuntimeCharacterDefinitionMap(
  digest: RuntimeDigestArtifact,
): Map<number, RuntimeCharacterDefinitionInfo> {
  return new Map(
    (digest.character_definitions ?? [])
      .filter((item) => Number.isInteger(item.id) && Number.isInteger(item.definition_id))
      .map((item) => [item.id, item]),
  )
}

export function resolveRuntimeActiveDefinitionIds(
  digest: RuntimeDigestArtifact,
): {
  self_active_character_definition_id: number | null
  opp_active_character_definition_id: number | null
} {
  const definitionMap = buildRuntimeCharacterDefinitionMap(digest)
  const selfActive = findRuntimeCharacterSummary(
    digest.self_summary.characters,
    digest.self_summary.active_character_id,
  )
  const oppActive = findRuntimeCharacterSummary(
    digest.opponent_summary.characters,
    digest.opponent_summary.active_character_id,
  )
  return {
    self_active_character_definition_id: resolveRuntimeCharacterDefinitionId(
      selfActive,
      definitionMap,
    ),
    opp_active_character_definition_id: resolveRuntimeCharacterDefinitionId(
      oppActive,
      definitionMap,
    ),
  }
}

export function deriveDeckFingerprintsFromRuntimeDigest(
  digest: RuntimeDigestArtifact,
): {
  deck_fingerprint_self: string | null
  deck_fingerprint_opp: string | null
} {
  const definitionMap = buildRuntimeCharacterDefinitionMap(digest)
  return {
    deck_fingerprint_self: deriveDeckFingerprint(
      digest.self_summary.characters,
      definitionMap,
    ),
    deck_fingerprint_opp: deriveDeckFingerprint(
      digest.opponent_summary.characters,
      definitionMap,
    ),
  }
}

export function collectRuntimeCandidateDefinitionIds(
  candidates: RuntimeCandidateAction[],
): number[] {
  const ids = new Set<number>()
  for (const candidate of candidates) {
    const directFields = [
      candidate.definition_id,
      candidate.card_definition_id,
    ]
    for (const value of directFields) {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        ids.add(value)
      }
    }
    for (const note of candidate.notes ?? []) {
      for (const pattern of CANDIDATE_DEF_PATTERNS) {
        const match = String(note).match(pattern)
        if (!match) {
          continue
        }
        const parsed = Number(match[1])
        if (Number.isInteger(parsed) && parsed > 0) {
          ids.add(parsed)
        }
      }
    }
  }
  return [...ids]
}

function resolveRuntimeCharacterDefinitionId(
  character: RuntimeCharacterSummary | null,
  definitionMap: Map<number, RuntimeCharacterDefinitionInfo>,
): number | null {
  if (!character) {
    return null
  }
  if (
    typeof character.definition_id === "number" &&
    Number.isInteger(character.definition_id) &&
    character.definition_id > 0
  ) {
    return character.definition_id
  }
  return definitionMap.get(character.id)?.definition_id ?? null
}

function deriveDeckFingerprint(
  characters: RuntimeCharacterSummary[],
  definitionMap: Map<number, RuntimeCharacterDefinitionInfo>,
): string | null {
  const definitionIds = characters
    .map((character) => resolveRuntimeCharacterDefinitionId(character, definitionMap))
    .filter((value): value is number => value != null && value > 0)
    .sort((left, right) => left - right)
  if (definitionIds.length === 0) {
    return null
  }
  return definitionIds.join("-")
}
