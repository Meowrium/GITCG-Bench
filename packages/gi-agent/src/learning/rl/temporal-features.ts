// Copyright (C) 2024-2025 Guyutongxue
//
// Temporal portfolio features for RL training data.
// Extracts state-based temporal signals from observation.

import { getProfile, loadProfiles } from "../../knowledge/temporal-profiles/profile-registry.js"
import { getStaticPriorForDefinitionId } from "./static-priors.js"
import type { PlayerObservationV1 } from "@gi-tcg/ml/contracts"

export interface TemporalFeatures {
  temporal_setup_saturation: number
  ready_to_cash_option_count: number
  blocked_synergy_option_count: number
  available_deferred_option_count: number
}

const MAX_SUPPORT_SLOTS = 4

/** Compute temporal portfolio features for one player from their observation */
export function buildTemporalFeatures(
  player: PlayerObservationV1,
): TemporalFeatures {
  loadProfiles()

  const supports = player.supports ?? []
  const handCards = player.hand?.visible_cards ?? []

  // ── Board-based: count active deferred/recurring/ready options ──
  let activeDeferred = 0
  let readyToCash = 0

  for (const entity of [...supports, ...player.summons ?? [], ...player.combat_statuses ?? []]) {
    if (entity.definition_id == null) continue
    const profile = getProfile(entity.definition_id)
    if (!profile) continue

    const kind = profile.optionKind
    if (kind === "deferred_bank") {
      activeDeferred++
      // If it has endPhase + actionPhase triggers, it might be ready
      if (profile.triggerWindows.includes("action_phase") && profile.triggerWindows.includes("end_phase")) {
        // Can't determine from observation alone, treat as progressing
      }
    }
    if (kind === "recurring_engine" || kind === "burst_enabler") {
      readyToCash++
    }
  }

  // ── Hand-based: count available vs blocked options ──
  let availableDeferred = 0
  let blockedSynergy = 0

  for (const card of handCards) {
    if (card.definition_id == null) continue
    const profile = getProfile(card.definition_id)
    if (!profile) continue

    // Only count setup-oriented cards
    if (!["deferred_bank", "recurring_engine", "conditional_engine", "burst_enabler"].includes(profile.optionKind)) {
      continue
    }

    // Check if prerequisites are satisfied by hand/board
    const prereqs = profile.prerequisites.filter(p => p.kind === "card_tag")
    if (prereqs.length === 0) {
      availableDeferred++
      continue
    }

    const cardDefId = card.definition_id
    const allSatisfied = prereqs.every(p =>
      hasTagInHand(handCards, p.value, cardDefId) ||
      hasTagOnBoard(supports, p.value)
    )

    if (allSatisfied) {
      availableDeferred++
    } else {
      blockedSynergy++
    }
  }

  const setupSaturation = Math.min(supports.length / MAX_SUPPORT_SLOTS, 1)

  return {
    temporal_setup_saturation: setupSaturation,
    ready_to_cash_option_count: readyToCash,
    blocked_synergy_option_count: blockedSynergy,
    available_deferred_option_count: availableDeferred,
  }
}

function hasTagInHand(
  handCards: PlayerObservationV1["hand"]["visible_cards"],
  tag: string,
  excludeDefId: number,
): boolean {
  return handCards.some(card =>
    card.definition_id !== excludeDefId &&
    card.tags.some(t => t === tag || t === `tag:${tag}` || t === `category:${tag}`)
  )
}

function hasTagOnBoard(
  supports: PlayerObservationV1["supports"],
  tag: string,
): boolean {
  return supports.some(entity => {
    if (entity.definition_id == null) return false
    const prior = getStaticPriorForDefinitionId(entity.definition_id)
    return prior.static_effect_tags.some(t => t === tag || t === `tag:${tag}`)
  })
}
