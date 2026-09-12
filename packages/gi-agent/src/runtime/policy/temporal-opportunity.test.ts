// Copyright (C) 2024-2025 Guyutongxue
//
// Updated tests: portfolio-based temporal opportunity scoring.

import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import type { HandCardObservationV1, ObservationV1 } from "@gi-tcg/ml/contracts"
import { getStaticPriorForDefinitionId } from "../../learning/rl/static-priors.js"
import type { PolicyCandidateAction, PolicyTurnDigest } from "./types.js"
import { scoreTemporalOpportunity } from "./temporal-opportunity.js"

const ALLY_SOURCE = readFileSync(
  new URL("../../../../data/src/cards/support/ally.ts", import.meta.url),
  "utf-8",
)

test("TemporalOpportunityModel source assumptions match support ally DSL", () => {
  const chefMaoBlock = sourceBlock("ChefMao")
  const timaeusBlock = sourceBlock("Timaeus")
  const libenBlock = sourceBlock("Liben")

  expect(chefMaoBlock).toContain('e.hasCardTag("food")')
  expect(timaeusBlock).toContain('e.hasCardTag("artifact")')
  expect(timaeusBlock).toContain('.addVariable("material", 1)')
  expect(libenBlock).toContain('c.absorbDice("diff"')
  expect(libenBlock).toContain("c.drawCards(2)")
  expect(libenBlock).toContain("c.generateDice(DiceType.Omni, 2)")
})

test("TemporalOpportunityModel values Liben as an early deferred dice bank", () => {
  const liben = playCardCandidate(322008)
  const prior = getStaticPriorForDefinitionId(322008)

  expect(prior.static_effect_tags).toContain("timing:endPhase")
  expect(prior.static_effect_tags).toContain("timing:actionPhase")

  const estimate = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    liben,
    observation({ dice: 8 }),
    null,
  )

  expect(estimate.score).toBeGreaterThan(0.2)
  expect(estimate.reasons.some((r) => r.startsWith("temporal_liben_bank="))).toBe(true)
})

test("Portfolio: discounts crowded deferred support slots", () => {
  const liben = playCardCandidate(322008)
  const empty = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8, supportCount: 0 }),
    liben,
    observation({ dice: 8, supports: [] }),
    null,
  )
  const crowded = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8, supportCount: 3 }),
    liben,
    observation({ dice: 8, supports: [322001, 322003, 322008] }),
    null,
  )

  expect(crowded.score).toBeLessThan(empty.score)
  // Portfolio detects duplicate (322008 already on board)
  expect(crowded.reasons.some((r) => r.startsWith("portfolio_duplicate"))).toBe(true)
  // Portfolio detects slot pressure (3/4 supports filled)
  expect(crowded.reasons.some((r) => r.startsWith("portfolio_slot_pressure"))).toBe(true)
})

test("Portfolio: blocks Chef Mao without food synergy", () => {
  const chefMao = playCardCandidate(322005)
  const food = handCard(333011)

  const withoutFood = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    chefMao,
    observation({ dice: 8, hand: [] }),
    null,
  )
  const withFood = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    chefMao,
    observation({ dice: 8, hand: [food] }),
    null,
  )

  // Without food: should be blocked
  expect(withoutFood.reasons.some((r) =>
    r.startsWith("portfolio_synergy_blocked")
  )).toBe(true)

  // With food: should be higher score
  expect(withFood.score).toBeGreaterThan(withoutFood.score)
  expect(withFood.reasons.some((r) =>
    r.startsWith("portfolio_synergy_ready")
  )).toBe(true)
})

test("Portfolio: detects synergy from candidate actions", () => {
  const chefMao = playCardCandidate(322005)
  const food = playCardCandidate(333011)

  const estimate = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8, candidateActions: [chefMao, food] }),
    chefMao,
    observation({ dice: 8, hand: [] }),
    null,
  )

  expect(estimate.score).toBeGreaterThan(0)
  expect(estimate.reasons.some((r) =>
    r.startsWith("portfolio_synergy_ready")
  )).toBe(true)
})

test("Portfolio: blocks Timaeus without artifact, enables with artifact", () => {
  const timaeus = playCardCandidate(322003)
  const artifact = handCard(312101)

  const withoutArtifact = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    timaeus,
    observation({ dice: 8, hand: [] }),
    null,
  )
  const withArtifact = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    timaeus,
    observation({ dice: 8, hand: [artifact] }),
    null,
  )

  expect(withoutArtifact.reasons.some((r) =>
    r.startsWith("portfolio_synergy_blocked")
  )).toBe(true)
  expect(withArtifact.score).toBeGreaterThan(withoutArtifact.score)
})

test("Portfolio: rewards skill conversion when setup is saturated", () => {
  const skill: PolicyCandidateAction = {
    candidate_id: "skill",
    action_case: "useSkill",
    damage_estimate: 3,
    reaction_value: 1,
    energy_gain_value: 1,
    tags: ["direct_damage", "reaction_enable"],
  }

  const estimate = scoreTemporalOpportunity(
    digest({ round: 2, dice: 6, supportCount: 3, candidateActions: [skill] }),
    skill,
    observation({ dice: 6, supports: [322001, 322003, 322008] }),
    {
      kind: "reaction_convert",
      intent: "cash_in_existing_setup",
      source: "heuristic",
      confidence: 0.7,
      prefer_action_cases: ["useSkill"],
      prefer_tags: ["reaction_enable"],
      avoid_tags: [],
      resource_policy: "balanced",
      remaining_actions: 2,
    },
  )

  expect(estimate.score).toBeGreaterThan(0)
  expect(estimate.reasons.some((r) => r.startsWith("portfolio_cash_ready"))).toBe(true)
})

test("Portfolio: penalizes deferred option in late game", () => {
  const liben = playCardCandidate(322008)
  const early = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    liben,
    observation({ dice: 8 }),
    null,
  )
  const late = scoreTemporalOpportunity(
    digest({ round: 4, dice: 6 }),
    liben,
    observation({ dice: 6 }),
    null,
  )

  expect(late.score).toBeLessThan(early.score)
})

test("Portfolio: dice_opportunity_cost penalizes high-cost cards, passes 0-cost", () => {
  const liben = playCardCandidate(322008)     // 立本: no .costSame → 0 cost
  const paimon = playCardCandidate(322001)    // 派蒙: .costSame(3) → 3 cost, no prereqs

  const libenR1 = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    liben,
    observation({ dice: 8 }),
    null,
  )
  const paimonR1 = scoreTemporalOpportunity(
    digest({ round: 1, dice: 8 }),
    paimon,
    observation({ dice: 8 }),
    null,
  )

  // 立本 (0-cost) should NOT have dice_opp penalty
  expect(libenR1.reasons.some((r) => r.startsWith("portfolio_dice_opp"))).toBe(false)

  // 派蒙 (3-cost, no prerequisites → unblocked) SHOULD have dice_opp penalty
  expect(paimonR1.reasons.some((r) => r.startsWith("portfolio_dice_opp"))).toBe(true)

  // 0-cost card should score HIGHER than 3-cost card
  expect(libenR1.score).toBeGreaterThan(paimonR1.score)
})

test("Portfolio: dice_opportunity capped at -0.08 (weaker prior for GBDT learning)", () => {
  const paimon = playCardCandidate(322001)
  const r1 = scoreTemporalOpportunity(digest({ round: 1, dice: 8 }), paimon, observation({ dice: 8 }), null)
  const r1DiceOpp = r1.reasons.find((r) => r.startsWith("portfolio_dice_opp="))
  expect(r1DiceOpp).toBeDefined()
  const r1Val = parseFloat(r1DiceOpp!.split("=")[1])
  // -3/8 * 0.3 * 1.0 = -0.1125, capped at -0.08
  expect(Math.abs(r1Val)).toBeLessThanOrEqual(0.08)
})

// ── Test fixtures ──

function playCardCandidate(definitionId: number): PolicyCandidateAction {
  const prior = getStaticPriorForDefinitionId(definitionId)
  return {
    candidate_id: `play_${definitionId}`,
    action_case: "playCard",
    card_definition_id: definitionId,
    create_support_value: prior.static_effect_tags.includes("support_create") ? 1 : 0,
    tags: prior.static_effect_tags,
    static_effect_tags: prior.static_effect_tags,
    meta_effect_slots: prior.meta_effect_slots,
  }
}

function handCard(definitionId: number): HandCardObservationV1 {
  const prior = getStaticPriorForDefinitionId(definitionId)
  return {
    entity_id: -definitionId,
    definition_id: definitionId,
    tags: prior.static_effect_tags
      .map((tag) => tag.startsWith("tag:") ? tag.slice(4) : tag)
      .filter((tag) => tag === "food" || tag === "artifact" || tag === "weapon" || tag === "place"),
    cost_summary: [],
    static_effect_tags: prior.static_effect_tags,
    meta_effect_slots: prior.meta_effect_slots,
  }
}

function digest(args: {
  round: number
  dice: number
  supportCount?: number
  candidateActions?: PolicyCandidateAction[]
}): PolicyTurnDigest {
  return {
    round: args.round,
    turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: {
      dice_count: args.dice,
      support_count: args.supportCount ?? 0,
      max_support_count: 4,
    },
    candidate_actions: args.candidateActions ?? [],
  }
}

function observation(args: {
  dice: number
  hand?: HandCardObservationV1[]
  supports?: number[]
}): ObservationV1 {
  return {
    schema_version: "obs.v1",
    source: {
      game_version: "v6.3.0",
      card_pool_version: "v6.3.0",
      ruleset_version: "default",
      contract_version: "obs.v1",
      view_kind: "policy_public",
    },
    point: {
      game_id: "g", episode_id: "e", decision_point_id: "dp",
      round_number: 1, phase: "action", pending_method: "action",
      actor_who: 0, current_turn: 0, action_count_in_round: 0,
    },
    self: {
      active_character_index: 0,
      characters: [{
        slot_index: 0, id: 1, definition_id: 1205,
        alive: true, is_active: true,
        health: 10, max_health: 10, energy: 0, max_energy: 2,
        aura: null, equipment_ids: [], status_ids: [],
        usage_counters: {}, entities: [],
      }],
      summons: [],
      supports: (args.supports ?? []).map((definitionId, index) => ({
        id: 100 + index, definition_id: definitionId,
      })),
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: args.dice, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: args.hand ?? [], card_count: args.hand?.length ?? 0 },
      pile_count: 25, discard_count: null, declared_end: false,
      can_charged: null, can_plunging: null, has_defeated: null, legend_used: false,
    },
    opponent: {
      active_character_index: 0,
      characters: [{
        slot_index: 0, id: 2, definition_id: 1101,
        alive: true, is_active: true,
        health: 10, max_health: 10, energy: 0, max_energy: 2,
        aura: null, equipment_ids: [], status_ids: [],
        usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 0 },
      pile_count: 25, discard_count: null, declared_end: false,
      can_charged: null, can_plunging: null, has_defeated: null, legend_used: false,
    },
    public_state: {
      winner: null, self_declared_end: false, opponent_declared_end: false,
      self_support_count: args.supports?.length ?? 0, opponent_support_count: 0,
      self_summon_count: 0, opponent_summon_count: 0,
    },
    hidden_estimate: null,
    derived: {
      self_damage_capacity_now: 0, opp_damage_capacity_now: 0,
      self_ko_pressure_now: 0, opp_ko_pressure_now: 0,
      self_resource_score: 0, opp_resource_score: 0,
      self_reaction_ready_score: 0, opp_reaction_ready_score: 0,
      self_burst_online_count: 0, opp_burst_online_count: 0,
      self_setup_window_score: 0, opp_setup_window_score: 0,
      self_reserve_value_score: 0, opp_reserve_value_score: 0,
      self_role_integrity_score: 1, opp_role_integrity_score: 1,
      self_window_score: 0, opp_window_score: 0,
      game_setup_completion: -1, game_phase_estimate: -1,
      game_primary_path_viable: -1,
      dice_efficiency: 0, summon_pressure: 0,
      action_economy_ratio: 1, elemental_application_map: {},
      self_temporal_setup_saturation: 0,
      self_ready_to_cash_option_count: 0,
      self_blocked_synergy_option_count: 0,
      self_available_deferred_option_count: 0,
      opp_temporal_setup_saturation: 0,
      opp_ready_to_cash_option_count: 0,
      opp_blocked_synergy_option_count: 0,
      opp_available_deferred_option_count: 0,
    },
  }
}

function sourceBlock(exportName: string): string {
  const pattern = new RegExp(`export const ${exportName} =[\\s\\S]*?\\.done\\(\\);`)
  return ALLY_SOURCE.match(pattern)?.[0] ?? ""
}
