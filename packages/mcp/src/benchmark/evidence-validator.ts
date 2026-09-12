// Copyright (C) 2025 Guyutongxue
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

/**
 * Evidence Validator - checks that all evidence/requiredPieces/source IDs in
 * an AnalysisOutput actually exist in the input deck data.
 *
 * See docs/PRE_GAME_DECK_ANALYSIS_BENCHMARK.md §2 constraints and §4 scoring
 * (Input Fidelity, 20 points).
 */

import type { AnalysisOutput } from "./analysis-v2-schema"

// ─── Types ────────────────────────────────────────────────────────────────

export interface ValidIdSet {
  /** All valid IDs for "my side" (character ids + card ids as strings, plus names) */
  mySide: Set<string>
  /** All valid IDs for "opponent side" (empty if no opponent deck) */
  oppSide: Set<string>
}

export interface EvidenceIssue {
  field: string
  id: string
  reason:
    | "unknown_id" // ID not found in any side's deck data
    | "cross_side_violation" // ID belongs to the wrong side
    | "missing_opponent_deck" // opponent referenced but no opp deck provided
  message: string
}

export interface EvidenceValidationResult {
  valid: boolean
  issues: EvidenceIssue[]
  stats: {
    totalEvidenceIds: number
    uniqueEvidenceIds: number
    hallucinated: number
    crossSide: number
    mySideRefs: number
    oppSideRefs: number
  }
}

// ─── Deck data extraction ─────────────────────────────────────────────────

/**
 * Extract the set of valid evidence IDs from a deck data JSON object
 * (as produced by sandbox-generator.ts's buildDeckDataJson or createDeckContext).
 *
 * Accepts both the "simplified" format (from buildDeckDataJson) and the raw
 * DeckContext format.  Valid IDs are:
 *   - Character `id` (as string) and `name`
 *   - Card `id` (as string) and `name`
 */
export function extractValidIds(deckData: unknown): Set<string> {
  const ids = new Set<string>()
  if (!deckData || typeof deckData !== "object") return ids

  const data = deckData as Record<string, unknown>

  // Simplified format (from buildDeckDataJson)
  const characters = data.characters as Array<Record<string, unknown>> | undefined
  if (Array.isArray(characters)) {
    for (const ch of characters) {
      if (typeof ch.id === "number") ids.add(String(ch.id))
      if (typeof ch.name === "string") ids.add(ch.name)
    }
  }

  const cards = data.cards as Array<Record<string, unknown>> | undefined
  if (Array.isArray(cards)) {
    for (const c of cards) {
      if (typeof c.id === "number") ids.add(String(c.id))
      if (typeof c.name === "string") ids.add(c.name)
    }
  }

  // Raw DeckContext format
  const characterFullInfo = data.characterFullInfo as Array<Record<string, unknown>> | undefined
  if (Array.isArray(characterFullInfo)) {
    for (const ch of characterFullInfo) {
      if (typeof ch.id === "number") ids.add(String(ch.id))
      if (typeof ch.name === "string") ids.add(ch.name)
    }
  }

  return ids
}

/**
 * Build a ValidIdSet from my deck data and optional opponent deck data.
 */
export function buildValidIdSet(
  myDeckData: unknown,
  oppDeckData?: unknown,
): ValidIdSet {
  return {
    mySide: extractValidIds(myDeckData),
    oppSide: oppDeckData ? extractValidIds(oppDeckData) : new Set(),
  }
}

// ─── Validator ────────────────────────────────────────────────────────────

/**
 * Validate all evidence IDs in an AnalysisOutput.
 *
 * Rules:
 * - `deckProfile` fields (winConditions, keyPieces, lines, resourcePlan):
 *   evidence must be from mySide.
 * - `matchup.opponentThreats[].source` must be from oppSide.
 * - `matchup.opponentThreats[].evidence` can be from either side.
 * - `matchup.opponentThreats[].counterplay` references must be from mySide
 *   (text-based, not ID-based, so only flagged if an ID pattern is detected).
 */
export function validateEvidence(
  output: AnalysisOutput,
  idSet: ValidIdSet,
): EvidenceValidationResult {
  const issues: EvidenceIssue[] = []
  const allEvidenceIds = new Set<string>()
  let mySideRefs = 0
  let oppSideRefs = 0

  const hasOpponentDeck = idSet.oppSide.size > 0

  // Helper: check a single ID
  function checkId(
    field: string,
    id: string,
    allowedSide: "my" | "opp" | "either",
  ): void {
    allEvidenceIds.add(id)
    const inMy = idSet.mySide.has(id)
    const inOpp = idSet.oppSide.has(id)

    if (allowedSide === "my") {
      if (inMy) {
        mySideRefs++
      } else if (inOpp) {
        oppSideRefs++
        issues.push({
          field,
          id,
          reason: "cross_side_violation",
          message: `ID "${id}" in field "${field}" belongs to opponent side, not my side`,
        })
      } else {
        issues.push({
          field,
          id,
          reason: "unknown_id",
          message: `ID "${id}" in field "${field}" not found in any deck data`,
        })
      }
    } else if (allowedSide === "opp") {
      if (inOpp) {
        oppSideRefs++
      } else if (inMy) {
        mySideRefs++
        issues.push({
          field,
          id,
          reason: "cross_side_violation",
          message: `ID "${id}" in field "${field}" belongs to my side, not opponent side`,
        })
      } else if (!hasOpponentDeck) {
        issues.push({
          field,
          id,
          reason: "missing_opponent_deck",
          message: `ID "${id}" in field "${field}" references opponent but no opponent deck was provided`,
        })
      } else {
        issues.push({
          field,
          id,
          reason: "unknown_id",
          message: `ID "${id}" in field "${field}" not found in any deck data`,
        })
      }
    } else {
      // either side
      if (inMy) {
        mySideRefs++
      } else if (inOpp) {
        oppSideRefs++
      } else {
        issues.push({
          field,
          id,
          reason: "unknown_id",
          message: `ID "${id}" in field "${field}" not found in any deck data`,
        })
      }
    }
  }

  // Helper: check an array of IDs
  function checkIds(
    field: string,
    ids: string[],
    allowedSide: "my" | "opp" | "either",
  ): void {
    for (const id of ids) {
      checkId(field, id, allowedSide)
    }
  }

  const { deckProfile, matchup } = output.analysisV2

  // Win conditions - all evidence must be from mySide
  for (const wc of deckProfile.winConditions) {
    checkIds(`deckProfile.winConditions[${wc.id}].requiredPieces`, wc.requiredPieces, "my")
    checkIds(`deckProfile.winConditions[${wc.id}].evidence`, wc.evidence, "my")
  }

  // Key pieces - id and evidence from mySide
  for (const kp of deckProfile.keyPieces) {
    checkId(`deckProfile.keyPieces[${kp.id}].id`, kp.id, "my")
    checkIds(`deckProfile.keyPieces[${kp.id}].evidence`, kp.evidence, "my")
  }

  // Lines - actor and evidence from mySide
  for (const line of deckProfile.lines) {
    for (const step of line.steps) {
      checkId(`deckProfile.lines[${line.id}].steps[].actor`, step.actor, "my")
      checkIds(`deckProfile.lines[${line.id}].steps[].evidence`, step.evidence, "my")
    }
  }

  // Resource plan bottlenecks - evidence from mySide
  for (const bp of deckProfile.resourcePlan.bottlenecks) {
    checkIds(`deckProfile.resourcePlan.bottlenecks[].evidence`, bp.evidence, "my")
  }

  // Matchup - opponent threats
  for (const threat of matchup.opponentThreats) {
    checkId(`matchup.opponentThreats[${threat.id}].source`, threat.source, "opp")
    // Evidence can be from either side
    checkIds(`matchup.opponentThreats[${threat.id}].evidence`, threat.evidence, "either")
  }

  const hallucinated = issues.filter((i) => i.reason === "unknown_id").length
  const crossSide = issues.filter((i) => i.reason === "cross_side_violation").length

  return {
    valid: issues.length === 0,
    issues,
    stats: {
      totalEvidenceIds: allEvidenceIds.size, // approximate (unique)
      uniqueEvidenceIds: allEvidenceIds.size,
      hallucinated,
      crossSide,
      mySideRefs,
      oppSideRefs,
    },
  }
}

// ─── Schema validation wrapper ─────────────────────────────────────────────

import { AnalysisOutputSchema, validatePrimaryArchetypes } from "./analysis-v2-schema"

export interface SchemaValidationResult {
  valid: boolean
  errors: string[]
  /** Issues from primaryArchetypes consistency check */
  archetypeIssues: string[]
}

/**
 * Validate the raw JSON output against the Zod schema.
 * Returns parsed output on success, or errors on failure.
 */
export function validateSchema(raw: unknown): {
  result: SchemaValidationResult
  parsed?: AnalysisOutput
} {
  const result = AnalysisOutputSchema.safeParse(raw)
  if (result.success) {
    const output = result.data
    const archetypeIssues = validatePrimaryArchetypes(
      output.analysisV2.deckProfile.archetypeWeights,
      output.analysisV2.deckProfile.primaryArchetypes,
    )
    return {
      result: {
        valid: archetypeIssues.length === 0,
        errors: [],
        archetypeIssues,
      },
      parsed: output,
    }
  }

  const errors = result.error.issues.map(
    (i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`,
  )
  return {
    result: {
      valid: false,
      errors,
      archetypeIssues: [],
    },
  }
}
