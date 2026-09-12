// Copyright (C) 2024-2025 Guyutongxue
//
// Temporal candidate features — compute per-candidate temporal semantics
// for RL training data export.

import type { Notification } from "@gi-tcg/typings"
import { getProfile } from "../../knowledge/temporal-profiles/profile-registry.js"
import { getStaticPriorForDefinitionId } from "./static-priors.js"
import type { CostEntryV1, EntityRefV1 } from "@gi-tcg/ml/contracts"

type VisibleState = NonNullable<Notification["state"]>

export interface CandidateTemporalFeatures {
  temporal_option_kind: string | null
  temporal_prereq_satisfied: boolean | null
  temporal_portfolio_stage: string | null
  /** Total dice cost of this candidate action (sum of required_cost) */
  temporal_dice_cost: number | null
  /** Dice cost / available dice ratio (0-1); null if unknown */
  temporal_dice_budget_ratio: number | null
}

/** Minimal fields needed from a candidate to compute temporal semantics. */
export interface CandidateTemporalInput {
  action_case: string
  source_ref: EntityRefV1 | null
  required_cost: readonly CostEntryV1[]
}

/**
 * Compute candidate-level temporal semantics for a single action candidate.
 *
 * Maps each candidate to a portfolio stage:
 *  - "setup"        — deferred_bank card that needs to be played early
 *  - "ready_to_cash" — recurring engine or conditional engine with prereqs met
 *  - "blocked"      — conditional engine with unsatisfied prerequisites
 *  - "immediate"    — converter / defense / burst / skill (no timing constraint)
 *  - "unknown"      — declare end, reroll, etc.
 */
export function computeCandidateTemporalFeatures(
  candidate: CandidateTemporalInput,
  state: VisibleState | undefined,
  side: 0 | 1,
  availableDice?: number,
): CandidateTemporalFeatures {
  const features: CandidateTemporalFeatures = (() => {
  switch (candidate.action_case) {
    case "playCard":
      return computePlayCardTemporal(candidate, state, side)
    case "useSkill":
      return computeUseSkillTemporal(candidate, state, side)
    case "switchActive":
      return {
        temporal_option_kind: "immediate",
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "immediate",
        temporal_dice_cost: 1, // switch costs 1 die
        temporal_dice_budget_ratio: null,
      }
    case "elementalTuning":
      return {
        temporal_option_kind: "immediate",
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "immediate",
        temporal_dice_cost: 0,
        temporal_dice_budget_ratio: null,
      }
    case "declareEnd":
      return {
        temporal_option_kind: null,
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "unknown",
        temporal_dice_cost: 0,
        temporal_dice_budget_ratio: null,
      }
    default:
      return {
        temporal_option_kind: null,
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "unknown",
        temporal_dice_cost: null,
        temporal_dice_budget_ratio: null,
      }
  }
  })()
  // Override budget_ratio if availableDice provided
  if (availableDice != null && availableDice > 0 && features.temporal_dice_cost != null) {
    features.temporal_dice_budget_ratio = features.temporal_dice_cost / availableDice
  }
  return features
}

function computePlayCardTemporal(
  candidate: CandidateTemporalInput,
  state: VisibleState | undefined,
  side: 0 | 1,
): CandidateTemporalFeatures {
  const definitionId = candidate.source_ref?.definition_id ?? null
  if (definitionId == null) {
    return {
      temporal_option_kind: null,
      temporal_prereq_satisfied: null,
      temporal_portfolio_stage: "immediate",
      temporal_dice_cost: computeTotalDiceCost(candidate.required_cost),
      temporal_dice_budget_ratio: null,
    }
  }

  const profile = getProfile(definitionId)

  // No DSL profile → fall back to static-prior heuristics
  if (!profile) {
    const result = computeStaticPriorTemporal(definitionId)
    return {
      ...result,
      temporal_dice_cost: computeTotalDiceCost(candidate.required_cost),
      temporal_dice_budget_ratio: null,
    }
  }

  const optionKind = profile.optionKind
  let portfolioStage: string
  let prereqSatisfied: boolean | null = null

  switch (optionKind) {
    case "deferred_bank": {
      // Always "setup" when playing — the payoff comes later
      portfolioStage = "setup"
      break
    }
    case "recurring_engine": {
      // Playing a recurring engine that will generate value each round
      portfolioStage = "ready_to_cash"
      break
    }
    case "conditional_engine": {
      // Check if prerequisites are satisfied
      const tagPrereqs = profile.prerequisites.filter(p => p.kind === "card_tag")
      if (tagPrereqs.length === 0) {
        portfolioStage = "ready_to_cash"
        prereqSatisfied = true
      } else if (state) {
        prereqSatisfied = checkCardTagPrereqs(state, side, definitionId, tagPrereqs.map(p => p.value))
        portfolioStage = prereqSatisfied ? "ready_to_cash" : "blocked"
      } else {
        portfolioStage = "ready_to_cash" // assume satisfied when state is unknown
        prereqSatisfied = null
      }
      break
    }
    case "burst_enabler": {
      portfolioStage = "immediate"
      break
    }
    case "converter":
    case "defense": {
      portfolioStage = "immediate"
      break
    }
    default: {
      portfolioStage = "setup"
      break
    }
  }

  return {
    temporal_option_kind: optionKind,
    temporal_prereq_satisfied: prereqSatisfied,
    temporal_portfolio_stage: portfolioStage,
    temporal_dice_cost: computeTotalDiceCost(candidate.required_cost),
    temporal_dice_budget_ratio: null, // computed in candidate-exporter from observation
  }
}

function computeUseSkillTemporal(
  candidate: CandidateTemporalInput,
  _state: VisibleState | undefined,
  _side: 0 | 1,
): CandidateTemporalFeatures {
  const isBurst = candidate.required_cost.some(
    (cost: CostEntryV1) => cost.type === 2 && cost.count > 0,
  )
  return {
    temporal_option_kind: isBurst ? "burst_enabler" : "converter",
    temporal_prereq_satisfied: null,
    temporal_portfolio_stage: "immediate",
    temporal_dice_cost: computeTotalDiceCost(candidate.required_cost),
    temporal_dice_budget_ratio: null,
  }
}

/**
 * Static-prior fallback: use card type tags when no DSL profile exists.
 */
function computeStaticPriorTemporal(definitionId: number): CandidateTemporalFeatures {
  const prior = getStaticPriorForDefinitionId(definitionId)
  const tags = new Set(prior.static_effect_tags)

  // Support cards usually have deferred/recurring effects
  if (tags.has("card:support") || tags.has("entity:support")) {
    if (tags.has("tag:food") || tags.has("tag:weapon") || tags.has("tag:artifact") || tags.has("tag:place")) {
      return {
        temporal_option_kind: "conditional_engine",
        temporal_prereq_satisfied: null,
        temporal_portfolio_stage: "ready_to_cash",
        temporal_dice_cost: null,
        temporal_dice_budget_ratio: null,
      }
    }
    return {
      temporal_option_kind: "generic_setup",
      temporal_prereq_satisfied: null,
      temporal_portfolio_stage: "setup",
      temporal_dice_cost: null,
      temporal_dice_budget_ratio: null,
    }
  }

  // Equipment cards are immediate attachments
  if (tags.has("card:equipment") || tags.has("entity:equipment")) {
    return {
      temporal_option_kind: "converter",
      temporal_prereq_satisfied: null,
      temporal_portfolio_stage: "immediate",
      temporal_dice_cost: null,
      temporal_dice_budget_ratio: null,
    }
  }

  // Event cards are generally immediate
  return {
    temporal_option_kind: "converter",
    temporal_prereq_satisfied: null,
    temporal_portfolio_stage: "immediate",
    temporal_dice_cost: null,
    temporal_dice_budget_ratio: null,
  }
}

/**
 * Check if the prerequisite card tags are satisfied by hand cards
 * (excluding the card being played) or board supports.
 */
function checkCardTagPrereqs(
  state: VisibleState,
  side: 0 | 1,
  excludeDefinitionId: number,
  requiredTags: string[],
): boolean {
  const player = state.player[side]

  // Check hand cards (excluding the one being played)
  for (const card of player.handCard) {
    if (card.definitionId === excludeDefinitionId) continue
    const prior = getStaticPriorForDefinitionId(card.definitionId)
    if (prior.static_effect_tags.some(t => requiredTags.some(r => t === r || t === `tag:${r}` || t === `category:${r}`))) {
      return true
    }
  }

  // Check board supports
  for (const entity of player.support) {
    const prior = getStaticPriorForDefinitionId(entity.definitionId)
    if (prior.static_effect_tags.some(t => requiredTags.some(r => t === r || t === `tag:${r}`))) {
      return true
    }
  }

  // Check board summons (some may provide relevant tags)
  for (const entity of player.summon) {
    const prior = getStaticPriorForDefinitionId(entity.definitionId)
    if (prior.static_effect_tags.some(t => requiredTags.some(r => t === r || t === `tag:${r}`))) {
      return true
    }
  }

  return false
}

function computeTotalDiceCost(costs: readonly CostEntryV1[]): number {
  return costs.reduce((sum, c) => sum + c.count, 0)
}
