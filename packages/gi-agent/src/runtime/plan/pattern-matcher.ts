// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { PolicyCandidateAction } from "../policy/types.js"
import type { ActionPattern } from "./types.js"

/**
 * Match a candidate action against an ActionPattern.
 *
 * This is the core predicate that connects declarative plan patterns
 * ("play a support card", "use Shenhe's elemental skill") to concrete
 * candidate actions flowing through the policy pipeline.
 */
export function matchPattern(
  pattern: ActionPattern,
  candidate: PolicyCandidateAction,
): boolean {
  switch (pattern.type) {
    case "play_card":
      return (
        candidate.action_case === "playCard" &&
        candidate.card_id === pattern.cardId
      )

    case "play_card_class": {
      if (candidate.action_case !== "playCard") return false
      const cardClass = candidate.card_entity_type
      if (cardClass == null) return false
      return cardClassString(cardClass) === pattern.cardClass
    }

    case "play_card_tag": {
      if (candidate.action_case !== "playCard") return false
      const tags = extractTags(candidate)
      return tags.some((t) => matchesTag(t, pattern.tag))
    }

    case "use_skill":
      return (
        candidate.action_case === "useSkill" &&
        candidate.target_ids != null &&
        candidate.target_ids.includes(pattern.skillId)
      )

    case "use_skill_of":
      return (
        candidate.action_case === "useSkill" &&
        candidate.target_ids != null &&
        (candidate as Record<string, unknown>).source_character_id ===
          pattern.characterId
      )

    case "switch_to":
      return (
        candidate.action_case === "switchActive" &&
        candidate.target_ids != null &&
        candidate.target_ids.includes(pattern.characterId)
      )

    case "normal_attack":
      return (
        candidate.action_case === "useSkill" &&
        (candidate as Record<string, unknown>).skill_type === "normal_attack" &&
        (candidate as Record<string, unknown>).source_character_id ===
          pattern.characterId
      )

    case "elemental_skill":
      return (
        candidate.action_case === "useSkill" &&
        (candidate as Record<string, unknown>).skill_type === "elemental_skill" &&
        (candidate as Record<string, unknown>).source_character_id ===
          pattern.characterId
      )

    case "elemental_burst":
      return (
        candidate.action_case === "useSkill" &&
        (candidate as Record<string, unknown>).skill_type === "elemental_burst" &&
        (candidate as Record<string, unknown>).source_character_id ===
          pattern.characterId
      )

    case "declare_end":
      return candidate.action_case === "declareEnd"

    case "elemental_tuning":
      return candidate.action_case === "elementalTuning"

    default: {
      const _exhaustive: never = pattern
      return false
    }
  }
}

/**
 * Check if any pattern in a list matches a candidate action.
 */
export function matchAnyPattern(
  patterns: readonly ActionPattern[],
  candidate: PolicyCandidateAction,
): boolean {
  return patterns.some((p) => matchPattern(p, candidate))
}

/**
 * Find the first matching pattern from a list.
 */
export function findMatchingPattern(
  patterns: readonly ActionPattern[],
  candidate: PolicyCandidateAction,
): ActionPattern | null {
  return patterns.find((p) => matchPattern(p, candidate)) ?? null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CARD_CLASS_LABELS: Record<number, string> = {
  0: "weapon",
  1: "artifact",
  2: "support",
  3: "event",
  4: "food",
  5: "talent",
  6: "arcane",
}

function cardClassString(cardEntityType: number): string {
  return CARD_CLASS_LABELS[cardEntityType] ?? "unknown"
}

function extractTags(candidate: PolicyCandidateAction): string[] {
  const tags = candidate.tags
  if (Array.isArray(tags)) {
    return tags.map((t: unknown) => String(t))
  }
  if (typeof tags === "string") {
    return tags.split(",").map((s) => s.trim())
  }
  // Try meta_effect_slots
  const metaSlots = candidate.meta_effect_slots
  if (Array.isArray(metaSlots)) {
    return metaSlots
      .map((s: unknown) => {
        if (s && typeof s === "object" && "tag" in (s as Record<string, unknown>)) {
          return String((s as Record<string, unknown>).tag)
        }
        return null
      })
      .filter((t): t is string => t != null)
  }
  return []
}

function matchesTag(tag: string, pattern: string): boolean {
  return tag.toLowerCase().includes(pattern.toLowerCase())
}
