// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { exposeState, type GameState } from "@gi-tcg/core"
import {
  ActionValidity,
  PbDiceRequirementType,
  type Notification,
  type RpcRequest,
} from "@gi-tcg/typings"
import type { ActionInfoWithModification } from "../../runtime/adapters/internal-types.js"
import type {
  ActionCandidateFamilyV1,
  ActionCandidateV1,
  CandidateRoutingV1,
  DecisionPointExportOptionsV1,
  DecisionPointV1,
  EntityRefV1,
  PendingMethodV1,
} from "@gi-tcg/ml/contracts"
import {
  buildCandidateStaticPrior,
  summarizePreviewSignals,
} from "./static-priors.js"
import { computeCandidateTemporalFeatures } from "./temporal-candidate.js"

type VisibleState = NonNullable<Notification["state"]>
type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number]

const DEFAULT_MAIN_FAMILIES = new Set<ActionCandidateFamilyV1>([
  "action",
  "choose_active",
  "select_card",
])

const DEFAULT_FALLBACK_FAMILIES = new Set<ActionCandidateFamilyV1>([
  "reroll_dice",
  "switch_hands",
])

export function buildDecisionPointV1FromRpcRequest(
  request: RpcRequest,
  state: VisibleState | undefined,
  options: DecisionPointExportOptionsV1,
): DecisionPointV1 {
  const rpc = request.request
  if (!rpc) {
    throw new Error("Missing RPC request envelope")
  }

  switch (rpc.$case) {
    case "action":
      return finalizeDecisionPoint(
        options,
        "action",
        rpc.value.action.map((action, index) =>
          mapRpcActionCandidate(action, index, state, options),
        ),
      )
    case "chooseActive":
      return finalizeDecisionPoint(
        options,
        "chooseActive",
        rpc.value.candidateIds.map((characterId, index) =>
          makeSimpleCandidate({
            options,
            pendingMethod: "chooseActive",
            family: "choose_active",
            actionCase: "chooseActive",
            engineIndex: null,
            sourceRef: resolveActiveCharacterRef(state, options.actorWho),
            targetRef: resolveEntityRefById(state, characterId),
            targetRefs: [resolveEntityRefById(state, characterId)].filter(Boolean) as EntityRefV1[],
            candidateSeed: `${characterId}:${index}`,
          }),
        ),
      )
    case "selectCard":
      return finalizeDecisionPoint(
        options,
        "selectCard",
        rpc.value.candidateDefinitionIds.map((definitionId, index) =>
          makeSimpleCandidate({
            options,
            pendingMethod: "selectCard",
            family: "select_card",
            actionCase: "selectCard",
            engineIndex: null,
            sourceRef: null,
            targetRef: {
              side: options.actorWho,
              area: "hand",
              entity_id: null,
              definition_id: definitionId,
            },
            targetRefs: [
              {
                side: options.actorWho,
                area: "hand",
                entity_id: null,
                definition_id: definitionId,
              },
            ],
            candidateSeed: `${definitionId}:${index}`,
          }),
        ),
      )
    case "rerollDice":
      return finalizeDecisionPoint(options, "rerollDice", [
        makeSyntheticFallbackCandidate(options, "rerollDice", "reroll_dice", "rerollDice"),
      ])
    case "switchHands":
      return finalizeDecisionPoint(options, "switchHands", [
        makeSyntheticFallbackCandidate(options, "switchHands", "switch_hands", "switchHands"),
      ])
    default: {
      const _exhaustive: never = rpc
      throw new Error(`Unsupported RPC method: ${String(_exhaustive)}`)
    }
  }
}

export function buildDecisionPointV1FromActionInfos(
  state: GameState,
  side: 0 | 1,
  actions: readonly ActionInfoWithModification[],
  options: DecisionPointExportOptionsV1,
): DecisionPointV1 {
  const visibleState = exposeState(side, state) as VisibleState
  const candidates = actions.map((action, index) => {
    const actionCase = action.type
    const targetRefs =
      action.type === "useSkill" || action.type === "playCard"
        ? action.targets
            .map((target) => resolveRawEntityRefById(state, target.id))
            .filter((value): value is EntityRefV1 => value != null)
        : []
    const sourceRef =
      action.type === "playCard"
        ? {
            side,
            area: "hand" as const,
            entity_id: action.skill.caller.id,
            definition_id: action.skill.caller.definition.id,
          }
        : action.type === "useSkill"
          ? resolveRawActiveCharacterRef(state, side)
          : action.type === "switchActive"
            ? resolveRawActiveCharacterRef(state, side)
            : action.type === "elementalTuning"
              ? {
                  side,
                  area: "hand" as const,
                  entity_id: action.card.id,
                  definition_id: action.card.definition.id,
                }
              : null
    const targetRef = targetRefs[0] ?? null
    const family: ActionCandidateFamilyV1 = "action"
    const routing = determineRouting(family, options)
    const staticPrior = buildCandidateStaticPrior({
      action_case: actionCase,
      source_definition_id:
        action.type === "playCard"
          ? action.skill.caller.definition.id
          : action.type === "elementalTuning"
            ? action.card.definition.id
            : null,
      sacrificed_definition_id:
        action.type === "elementalTuning"
          ? action.card.definition.id
          : null,
      required_cost: [...action.cost.entries()].map(([type, count]) => ({ type, count })),
      // Extract damage estimate from action previews so ranker can learn lethal_bonus
      preview_summary: summarizePreviewSignals(
        action.preview ?? [],
        side,
        visibleState,
      ) as any,
      skill_type:
        action.type === "useSkill"
          ? normalizeCommonSkillType(action.skill.definition.skillType)
          : null,
      will_be_effectless: action.type === "playCard" ? action.willBeEffectless : false,
    })
    const damageEstimate = (staticPrior as { preview_summary?: { damage?: number } }).preview_summary?.damage ?? 0
    return {
      candidate_id: "",
      candidate_index: -1,
      engine_index: index + 1,
      pending_method: "action",
      family,
      action_case: actionCase,
      source_ref: sourceRef,
      target_ref: targetRef,
      target_refs: targetRefs,
      required_cost: [...action.cost.entries()].map(([type, count]) => ({ type, count })),
      auto_selected_dice: [...action.autoSelectedDice],
      selectable_dice_types: [...new Set(state.players[side].dice)],
      is_fast_action: action.fast,
      is_valid: action.validity === ActionValidity.VALID,
      validity_code: action.validity,
      is_model_selectable: routing.route === "main_head",
      is_fallback_only: routing.route !== "main_head",
      rule_tags: buildRuleTags(actionCase),
      static_effect_tags: staticPrior.static_effect_tags,
      meta_effect_slots: staticPrior.meta_effect_slots,
      synergy_slots: staticPrior.synergy_slots,
      routing,
      ...computeCandidateTemporalFeatures(
        {
          action_case: actionCase,
          source_ref: sourceRef,
          required_cost: [...action.cost.entries()].map(([type, count]) => ({ type, count })),
        },
        undefined,
        side,
        visibleState?.player[side]?.dice?.length,
      ),
    } satisfies ActionCandidateV1
  })

  return finalizeDecisionPoint(options, "action", candidates)
}

function finalizeDecisionPoint(
  options: DecisionPointExportOptionsV1,
  pendingMethod: Exclude<PendingMethodV1, null>,
  candidates: ActionCandidateV1[],
): DecisionPointV1 {
  const sorted = [...candidates].sort(compareCandidates).map((candidate, index) => ({
    ...candidate,
    candidate_index: index,
    candidate_id: `${options.decisionPointId}:${pendingMethod}:${index}`,
  }))

  return {
    schema_version: "action.v1",
    game_id: options.gameId,
    episode_id: options.episodeId,
    decision_point_id: options.decisionPointId,
    pending_method: pendingMethod,
    actor_who: options.actorWho,
    observation_ref: options.observationRef,
    candidate_count: sorted.length,
    candidates: sorted,
  }
}

function mapRpcActionCandidate(
  action: RpcAction,
  index: number,
  state: VisibleState | undefined,
  options: DecisionPointExportOptionsV1,
): ActionCandidateV1 {
  const actionCase = action.action?.$case ?? "unknown"
  const family: ActionCandidateFamilyV1 = "action"
  const routing = determineRouting(family, options)
  const actorSide = options.actorWho
  const targetIds =
    action.action?.$case === "useSkill"
      ? action.action.value.targetIds
      : action.action?.$case === "playCard"
        ? action.action.value.targetIds
        : []
  const targetRefs = targetIds
    .map((targetId) => resolveEntityRefById(state, targetId))
    .filter((value): value is EntityRefV1 => value != null)
  const sourceRef =
    action.action?.$case === "playCard"
      ? resolveHandCardRef(state, actorSide, action.action.value.cardId)
      : action.action?.$case === "elementalTuning"
        ? resolveHandCardRef(state, actorSide, action.action.value.removedCardId)
        : action.action?.$case === "useSkill"
          ? resolveActiveCharacterRef(state, actorSide)
          : action.action?.$case === "switchActive"
            ? resolveActiveCharacterRef(state, actorSide)
            : null
  const targetRef =
    action.action?.$case === "switchActive"
      ? resolveEntityRefById(state, action.action.value.characterId)
      : targetRefs[0] ?? null
  const staticPrior = buildCandidateStaticPrior({
    action_case: actionCase,
    source_definition_id:
      action.action?.$case === "playCard"
        ? action.action.value.cardDefinitionId
        : action.action?.$case === "elementalTuning"
          ? resolveHandCardRef(state, actorSide, action.action.value.removedCardId)?.definition_id ?? null
          : null,
    sacrificed_definition_id:
      action.action?.$case === "elementalTuning"
        ? resolveHandCardRef(state, actorSide, action.action.value.removedCardId)?.definition_id ?? null
        : null,
    required_cost: (action.requiredCost ?? []).map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
    preview_summary: summarizePreviewSignals(action.preview ?? [], actorSide, state),
    skill_type:
      action.action?.$case === "useSkill"
        ? hasEnergyCost(action.requiredCost ?? [])
          ? "burst"
          : null
        : null,
    will_be_effectless:
      action.action?.$case === "playCard" ? action.action.value.willBeEffectless : false,
  })

  return {
    candidate_id: "",
    candidate_index: -1,
    engine_index: index + 1,
    pending_method: "action",
    family,
    action_case: actionCase,
    source_ref: sourceRef,
    target_ref: targetRef,
    target_refs: targetRefs,
    required_cost: (action.requiredCost ?? []).map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
    auto_selected_dice: [...(action.autoSelectedDice ?? [])],
    selectable_dice_types: [...new Set(state?.player[actorSide]?.dice ?? [])],
    is_fast_action: !!action.isFast,
    is_valid: action.validity === ActionValidity.VALID,
    validity_code: action.validity,
    is_model_selectable: routing.route === "main_head",
    is_fallback_only: routing.route !== "main_head",
    rule_tags: buildRuleTags(actionCase),
    static_effect_tags: staticPrior.static_effect_tags,
    meta_effect_slots: staticPrior.meta_effect_slots,
    synergy_slots: staticPrior.synergy_slots,
    routing,
    ...computeCandidateTemporalFeatures(
      {
        action_case: actionCase,
        source_ref: sourceRef,
        required_cost: (action.requiredCost ?? []).map((cost) => ({
          type: cost.type,
          count: cost.count,
        })),
      },
      state ?? undefined,
      actorSide,
      state?.player[actorSide]?.dice?.length,
    ),
  }
}

function makeSimpleCandidate(args: {
  options: DecisionPointExportOptionsV1
  pendingMethod: Exclude<PendingMethodV1, null>
  family: ActionCandidateFamilyV1
  actionCase: string
  engineIndex: number | null
  sourceRef: EntityRefV1 | null
  targetRef: EntityRefV1 | null
  targetRefs: EntityRefV1[]
  candidateSeed: string
}): ActionCandidateV1 {
  const routing = determineRouting(args.family, args.options)
  return {
    candidate_id: "",
    candidate_index: -1,
    engine_index: args.engineIndex,
    pending_method: args.pendingMethod,
    family: args.family,
    action_case: args.actionCase,
    source_ref: args.sourceRef,
    target_ref: args.targetRef,
    target_refs: args.targetRefs,
    required_cost: [],
    auto_selected_dice: [],
    selectable_dice_types: [],
    is_fast_action: false,
    is_valid: true,
    validity_code: ActionValidity.VALID,
    is_model_selectable: routing.route === "main_head",
    is_fallback_only: routing.route !== "main_head",
    rule_tags: [...buildRuleTags(args.actionCase), args.candidateSeed],
    static_effect_tags: [],
    meta_effect_slots: {},
    synergy_slots: {},
    routing,
    temporal_option_kind: null,
    temporal_prereq_satisfied: null,
    temporal_portfolio_stage: "unknown",
    temporal_dice_cost: null,
    temporal_dice_budget_ratio: null,
  }
}

function makeSyntheticFallbackCandidate(
  options: DecisionPointExportOptionsV1,
  pendingMethod: "rerollDice" | "switchHands",
  family: "reroll_dice" | "switch_hands",
  actionCase: string,
): ActionCandidateV1 {
  const routing = determineRouting(family, options)
  return {
    candidate_id: "",
    candidate_index: -1,
    engine_index: null,
    pending_method: pendingMethod,
    family,
    action_case: actionCase,
    source_ref: null,
    target_ref: null,
    target_refs: [],
    required_cost: [],
    auto_selected_dice: [],
    selectable_dice_types: [],
    is_fast_action: false,
    is_valid: true,
    validity_code: ActionValidity.VALID,
    is_model_selectable: false,
    is_fallback_only: true,
    rule_tags: [pendingMethod, "fallback_only", "combinatorial"],
    static_effect_tags: [],
    meta_effect_slots: {},
    synergy_slots: {},
    routing,
    temporal_option_kind: null,
    temporal_prereq_satisfied: null,
    temporal_portfolio_stage: "unknown",
    temporal_dice_cost: null,
    temporal_dice_budget_ratio: null,
  }
}

function determineRouting(
  family: ActionCandidateFamilyV1,
  options: DecisionPointExportOptionsV1,
): CandidateRoutingV1 {
  const mainFamilies = options.mainSelectableFamilies ?? DEFAULT_MAIN_FAMILIES
  const fallbackFamilies = options.fallbackFamilies ?? DEFAULT_FALLBACK_FAMILIES
  if (mainFamilies.has(family)) {
    return {
      route: "main_head",
      reason: "high_freq_family",
    }
  }
  if (fallbackFamilies.has(family)) {
    return {
      route: "fallback_head",
      reason: "disabled_in_v1",
    }
  }
  return {
    route: "rule_policy",
    reason: "rare_pending_method",
  }
}

function buildRuleTags(actionCase: string): string[] {
  switch (actionCase) {
    case "useSkill":
      return ["skill"]
    case "playCard":
      return ["card"]
    case "switchActive":
      return ["switch"]
    case "elementalTuning":
      return ["dice_fix"]
    case "declareEnd":
      return ["end_round"]
    case "chooseActive":
      return ["choose_active"]
    case "selectCard":
      return ["select_card"]
    default:
      return [actionCase]
  }
}

function hasEnergyCost(costs: readonly { type: number; count: number }[]): boolean {
  return costs.some((cost) => cost.type === PbDiceRequirementType.ENERGY && cost.count > 0)
}

function normalizeCommonSkillType(
  skillType: string | null | undefined,
): "normal" | "elemental" | "burst" | "technique" | null {
  switch (skillType) {
    case "normal":
    case "elemental":
    case "burst":
    case "technique":
      return skillType
    default:
      return null
  }
}

function compareCandidates(left: ActionCandidateV1, right: ActionCandidateV1): number {
  const leftKey = buildSortKey(left)
  const rightKey = buildSortKey(right)
  return leftKey.localeCompare(rightKey)
}

function buildSortKey(candidate: ActionCandidateV1): string {
  return [
    candidate.pending_method,
    candidate.family,
    candidate.action_case,
    candidate.source_ref?.definition_id ?? -1,
    candidate.target_ref?.definition_id ?? -1,
    JSON.stringify(candidate.required_cost),
    candidate.engine_index ?? -1,
  ].join("|")
}

function resolveEntityRefById(
  state: VisibleState | undefined,
  entityId: number,
): EntityRefV1 | null {
  if (!state) {
    return {
      side: null,
      area: "unknown",
      entity_id: entityId,
      definition_id: null,
    }
  }
  for (const side of [0, 1] as const) {
    const player = state.player[side]
    const charIndex = player.character.findIndex((character) => character.id === entityId)
    if (charIndex !== -1) {
      const character = player.character[charIndex]
      return {
        side,
        area: "character",
        entity_id: entityId,
        definition_id: character.definitionId,
        slot_index: charIndex,
      }
    }
    const support = player.support.find((entity) => entity.id === entityId)
    if (support) {
      return {
        side,
        area: "support",
        entity_id: entityId,
        definition_id: support.definitionId,
      }
    }
    const summon = player.summon.find((entity) => entity.id === entityId)
    if (summon) {
      return {
        side,
        area: "summon",
        entity_id: entityId,
        definition_id: summon.definitionId,
      }
    }
    const combatStatus = player.combatStatus.find((entity) => entity.id === entityId)
    if (combatStatus) {
      return {
        side,
        area: "combat_status",
        entity_id: entityId,
        definition_id: combatStatus.definitionId,
      }
    }
    const handCard = player.handCard.find((entity) => entity.id === entityId)
    if (handCard) {
      return {
        side,
        area: "hand",
        entity_id: entityId,
        definition_id: handCard.definitionId,
      }
    }
  }
  return {
    side: null,
    area: "unknown",
    entity_id: entityId,
    definition_id: null,
  }
}

function resolveHandCardRef(
  state: VisibleState | undefined,
  side: 0 | 1,
  cardId: number,
): EntityRefV1 | null {
  const handCard = state?.player[side]?.handCard.find((card) => card.id === cardId)
  if (!handCard) {
    return {
      side,
      area: "hand",
      entity_id: cardId,
      definition_id: null,
    }
  }
  return {
    side,
    area: "hand",
    entity_id: cardId,
    definition_id: handCard.definitionId,
  }
}

function resolveActiveCharacterRef(
  state: VisibleState | undefined,
  side: 0 | 1,
): EntityRefV1 | null {
  const player = state?.player[side]
  if (!player || player.activeCharacterId == null) {
    return null
  }
  return resolveEntityRefById(state, player.activeCharacterId)
}

function resolveRawActiveCharacterRef(state: GameState, side: 0 | 1): EntityRefV1 | null {
  const player = state.players[side]
  const index = player.characters.findIndex((character) => character.id === player.activeCharacterId)
  const active = player.characters[index]
  if (!active) {
    return null
  }
  return {
    side,
    area: "character",
    entity_id: active.id,
    definition_id: active.definition.id,
    slot_index: index,
  }
}

function sideOfEntityId(state: GameState, entityId: number): 0 | 1 | null {
  for (const side of [0, 1] as const) {
    const player = state.players[side]
    if (player.characters.some((character) => character.id === entityId)) {
      return side
    }
  }
  return null
}

function resolveRawEntityRefById(state: GameState, entityId: number): EntityRefV1 | null {
  for (const side of [0, 1] as const) {
    const player = state.players[side]
    const characterIndex = player.characters.findIndex((character) => character.id === entityId)
    if (characterIndex !== -1) {
      const character = player.characters[characterIndex]
      return {
        side,
        area: "character",
        entity_id: entityId,
        definition_id: character.definition.id,
        slot_index: characterIndex,
      }
    }
    const handCard = player.hands.find((card) => card.id === entityId)
    if (handCard) {
      return {
        side,
        area: "hand",
        entity_id: entityId,
        definition_id: handCard.definition.id,
      }
    }
    const support = player.supports.find((entity) => entity.id === entityId)
    if (support) {
      return {
        side,
        area: "support",
        entity_id: entityId,
        definition_id: support.definition.id,
      }
    }
    const summon = player.summons.find((entity) => entity.id === entityId)
    if (summon) {
      return {
        side,
        area: "summon",
        entity_id: entityId,
        definition_id: summon.definition.id,
      }
    }
    const combatStatus = player.combatStatuses.find((entity) => entity.id === entityId)
    if (combatStatus) {
      return {
        side,
        area: "combat_status",
        entity_id: entityId,
        definition_id: combatStatus.definition.id,
      }
    }
  }
  return {
    side: sideOfEntityId(state, entityId),
    area: "unknown",
    entity_id: entityId,
    definition_id: null,
  }
}
