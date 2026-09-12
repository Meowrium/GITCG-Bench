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

import type { GameState } from "@gi-tcg/core"
import {
  ActionValidity,
  PbDamageType,
  PbDiceRequirementType,
  PbEntityArea,
  PbEntityType,
  PbEquipmentType,
  PbModifyDirection,
  PbMoveEntityReason,
  PbDiceType,
  type Notification,
  type PreviewData,
  type RpcRequest,
} from "@gi-tcg/typings"
import type { PolicyCandidateAction, PolicyTurnDigest } from "./types.js"
import type { ActionInfoWithModification } from "../adapters/internal-types.js"
import {
  buildCandidateStaticPrior,
  buildHandCardStaticAnnotation,
  buildPlayerHandStaticPriorSummary,
} from "../../learning/rl/static-priors.js"

type RpcAction = NonNullable<
  NonNullable<RpcRequest["request"]> & { $case: "action" }
>["value"]["action"][number]

type VisibleState = NonNullable<Notification["state"]>
type VisiblePlayerState = VisibleState["player"][number]

interface PreviewStats {
  damage: number
  reactions: number
  tempo: number
  selfPressure: number
  healing: number
  selfHeal: number
  teamHeal: number
  drawCount: number
  createSupportCount: number
  createSummonCount: number
  createEquipmentCount: number
  energyGainCount: number
  forcedSwitchCount: number
  selfSwitchCount: number
}

export function buildPolicyTurnDigest(
  state: Notification["state"] | undefined,
  side: 0 | 1,
  actions: Array<{ action: RpcAction; index: number }>,
): PolicyTurnDigest {
  const self = state?.player[side]
  const opponent = state?.player[flipSide(side)]
  const selfIds = new Set((self?.character ?? []).map((character) => character.id))
  const opponentIds = new Set((opponent?.character ?? []).map((character) => character.id))
  const selfHandCards =
    self?.handCard.map((card) => {
      const annotation = buildHandCardStaticAnnotation(card.definitionId, [], [])
      return {
        id: card.id,
        definition_id: card.definitionId,
        entity_type: card.type,
        equipment_type: card.equipment,
        cost: sumDefinitionCost(card.definitionCost ?? []),
        static_effect_tags: annotation.static_effect_tags,
        meta_effect_slots: annotation.meta_effect_slots,
      }
    }) ?? []
  const selfStaticPriorSummary = buildPlayerHandStaticPriorSummary(
    selfHandCards.map((card) => ({
      static_effect_tags: card.static_effect_tags,
      meta_effect_slots: card.meta_effect_slots,
    })),
  )

  return {
    round: state?.roundNumber ?? 0,
    turn: state?.currentTurn ?? 0,
    self_summary: {
      active_character_id: self?.activeCharacterId,
      hand_cards: selfHandCards,
      characters:
        self?.character.map((character) => ({
          id: character.id,
          definition_id: character.definitionId,
          hp: character.health,
          max_hp: character.maxHealth,
          energy: character.energy,
          max_energy: character.maxEnergy,
          alive: !character.defeated,
          aura: typeof character.aura === "number" ? character.aura : null,
          equipment_ids: (character.entity ?? [])
            .filter((e: { definitionId: number }) => {
              // Equipment entities have definition IDs in known equipment ranges
              // or can be filtered by entity type if available
              return true // include all entities; inference side will filter by known IDs
            })
            .map((e: { definitionId: number }) => e.definitionId),
          status_ids: (character.entity ?? [])
            .filter((e: { variableName?: string; variableValue?: number }) =>
              e.variableName != null && typeof e.variableValue === "number"
            )
            .map((e: { variableName?: string; variableValue?: number }) => ({
              name: e.variableName!,
              value: e.variableValue!,
            })),
        })) ?? [],
      combat_statuses: (self?.combatStatus ?? []).map((cs: { id: number; definitionId: number; variableName?: string; variableValue?: number }) => ({
        id: cs.id,
        definition_id: cs.definitionId,
        usage: typeof cs.variableValue === "number" ? cs.variableValue : undefined,
      })),
      summons: (self?.summon ?? []).map((s: { id: number; definitionId: number; variableName?: string; variableValue?: number }) => ({
        id: s.id,
        definition_id: s.definitionId,
        usage: typeof s.variableValue === "number" ? s.variableValue : undefined,
      })),
      effect_family_counts: selfStaticPriorSummary.effect_family_counts,
      meta_prior_slots: selfStaticPriorSummary.meta_prior_slots,
    },
    opponent_summary: {
      active_character_id: opponent?.activeCharacterId,
      characters:
        opponent?.character.map((character) => ({
          id: character.id,
          definition_id: character.definitionId,
          hp: character.health,
          max_hp: character.maxHealth,
          energy: character.energy,
          max_energy: character.maxEnergy,
          alive: !character.defeated,
          aura: typeof character.aura === "number" ? character.aura : null,
          equipment_ids: (character.entity ?? [])
            .map((e: { definitionId: number }) => e.definitionId),
        })) ?? [],
      combat_statuses: (opponent?.combatStatus ?? []).map((cs: { id: number; definitionId: number; variableName?: string; variableValue?: number }) => ({
        id: cs.id,
        definition_id: cs.definitionId,
        usage: typeof cs.variableValue === "number" ? cs.variableValue : undefined,
      })),
      summons: (opponent?.summon ?? []).map((s: { id: number; definitionId: number; variableName?: string; variableValue?: number }) => ({
        id: s.id,
        definition_id: s.definitionId,
        usage: typeof s.variableValue === "number" ? s.variableValue : undefined,
      })),
      effect_family_counts: {},
      meta_prior_slots: {},
    },
    resource_summary: {
      dice_count: self?.dice.length ?? 0,
      omni_count: self?.dice.filter((die) => die === PbDiceType.OMNI).length ?? 0,
      dice_values: [...(self?.dice ?? [])],
      cards_in_hand: self?.handCard.length ?? 0,
      support_count: self?.support.length ?? 0,
      summon_count: self?.summon.length ?? 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: actions.map(({ action, index }) =>
      actionToPolicyCandidate(
        action,
        index,
        side,
        self,
        selfIds,
        opponentIds,
      ),
    ),
    opponent_declared_end: opponent?.declaredEnd ?? false,
  }
}

export function buildPolicyTurnDigestFromGameState(
  state: GameState,
  side: 0 | 1,
  actions: readonly ActionInfoWithModification[],
): PolicyTurnDigest {
  const self = state.players[side]
  const opponent = state.players[flipSide(side)]
  const selfIds = new Set<number>(self.characters.map((character) => character.id))
  const opponentIds = new Set<number>(opponent.characters.map((character) => character.id))
  const selfHandCards = self.hands.map((card: GameState["players"][number]["hands"][number]) => {
    const annotation = buildHandCardStaticAnnotation(
      card.definition.id,
      Array.isArray(card.definition.tags)
        ? card.definition.tags.filter((tag): tag is string => typeof tag === "string")
        : [],
      [],
    )
    return {
      id: card.id,
      definition_id: card.definition.id,
      entity_type: entityDefinitionToPbType(card.definition.type),
      equipment_type: entityDefinitionToPbEquipment(card.definition),
      cost: 0,
      static_effect_tags: annotation.static_effect_tags,
      meta_effect_slots: annotation.meta_effect_slots,
    }
  })
  const selfStaticPriorSummary = buildPlayerHandStaticPriorSummary(
    selfHandCards.map((card) => ({
      static_effect_tags: card.static_effect_tags,
      meta_effect_slots: card.meta_effect_slots,
    })),
  )

  return {
    round: state.roundNumber,
    turn: state.currentTurn,
    self_summary: {
      active_character_id: self.activeCharacterId,
      hand_cards: selfHandCards,
      characters: self.characters.map((character: GameState["players"][number]["characters"][number]) => ({
        id: character.id,
        definition_id: character.definition.id,
        hp: character.variables.health,
        max_hp: character.variables.maxHealth,
        energy: character.variables.energy,
        max_energy: character.variables.maxEnergy,
        alive: !!character.variables.alive,
        aura: typeof character.variables.aura === "number" ? character.variables.aura : null,
        equipment_ids: character.entities
          .filter((e) => e.definition.type === "equipment" as any)
          .map((e) => e.definition.id),
      })),
      combat_statuses: self.combatStatuses.map((cs) => ({
        id: cs.id,
        definition_id: cs.definition.id,
        usage: typeof cs.variables.usage === "number" ? cs.variables.usage : undefined,
      })),
      summons: self.summons.map((s) => ({
        id: s.id,
        definition_id: s.definition.id,
        usage: typeof s.variables.usage === "number" ? s.variables.usage : undefined,
      })),
      effect_family_counts: selfStaticPriorSummary.effect_family_counts,
      meta_prior_slots: selfStaticPriorSummary.meta_prior_slots,
    },
    opponent_summary: {
      active_character_id: opponent.activeCharacterId,
      characters: opponent.characters.map((character: GameState["players"][number]["characters"][number]) => ({
        id: character.id,
        definition_id: character.definition.id,
        hp: character.variables.health,
        max_hp: character.variables.maxHealth,
        energy: character.variables.energy,
        max_energy: character.variables.maxEnergy,
        alive: !!character.variables.alive,
        aura: typeof character.variables.aura === "number" ? character.variables.aura : null,
        equipment_ids: character.entities
          .filter((e) => e.definition.type === "equipment" as any)
          .map((e) => e.definition.id),
      })),
      combat_statuses: opponent.combatStatuses.map((cs) => ({
        id: cs.id,
        definition_id: cs.definition.id,
        usage: typeof cs.variables.usage === "number" ? cs.variables.usage : undefined,
      })),
      summons: opponent.summons.map((s) => ({
        id: s.id,
        definition_id: s.definition.id,
        usage: typeof s.variables.usage === "number" ? s.variables.usage : undefined,
      })),
      effect_family_counts: {},
      meta_prior_slots: {},
    },
    resource_summary: {
      dice_count: self.dice.length,
      omni_count: self.dice.filter((die: number) => die === PbDiceType.OMNI).length,
      dice_values: [...self.dice],
      cards_in_hand: self.hands.length,
      support_count: self.supports.length,
      summon_count: self.summons.length,
      max_support_count: state.config.maxSupportsCount,
      max_summon_count: state.config.maxSummonsCount,
    },
    candidate_actions: actions.map((action, index) =>
      actionInfoToPolicyCandidate(action, index, side, self, selfIds, opponentIds),
    ),
    opponent_declared_end: opponent.declaredEnd,
  }
}

export function actionToPolicyCandidate(
  action: RpcAction,
  index: number,
  perspective: 0 | 1,
  self: VisiblePlayerState | undefined,
  selfIds: ReadonlySet<number>,
  opponentIds: ReadonlySet<number>,
): PolicyCandidateAction {
  const previewStats = summarizePreview(
    action.preview,
    perspective,
    selfIds,
    opponentIds,
  )
  const actionCase = action.action?.$case ?? "unknown"
  const playCardAction =
    action.action?.$case === "playCard" ? action.action.value : null
  const tuningAction =
    action.action?.$case === "elementalTuning" ? action.action.value : null
  const handCard = playCardAction
    ? self?.handCard.find((card) => card.id === playCardAction.cardId)
    : tuningAction
      ? self?.handCard.find((card) => card.id === tuningAction.removedCardId)
      : undefined

  const semanticTags = inferSemanticTags(
    actionCase,
    handCard?.type,
    handCard?.equipment,
    previewStats,
    playCardAction?.willBeEffectless ?? false,
  )
  const staticPrior = buildCandidateStaticPrior({
    action_case: actionCase,
    source_definition_id:
      playCardAction?.cardDefinitionId ??
      handCard?.definitionId ??
      null,
    sacrificed_definition_id:
      tuningAction?.removedCardId != null
        ? self?.handCard.find((card) => card.id === tuningAction.removedCardId)?.definitionId ?? null
        : null,
    required_cost: action.requiredCost.map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
    preview_summary: {
      damage: previewStats.damage,
      reactions: previewStats.reactions,
      tempo: previewStats.tempo,
      healing: previewStats.healing,
      draw_count: previewStats.drawCount,
      create_support_count: previewStats.createSupportCount,
      create_summon_count: previewStats.createSummonCount,
      energy_gain_count: previewStats.energyGainCount,
      forced_switch_count: previewStats.forcedSwitchCount,
    },
    skill_type:
      actionCase === "useSkill"
        ? hasEnergyCost(action.requiredCost)
          ? "burst"
          : null
        : null,
    will_be_effectless: playCardAction?.willBeEffectless ?? false,
  })
  const notes = [
    `validity=${ActionValidity[action.validity]}`,
    `autoDice=${action.autoSelectedDice.length}`,
  ]
  if (playCardAction?.willBeEffectless) {
    notes.push("effectless=true")
  }

  // V30 Stage 2.B — Pass through `skill_definition_id` and raw preview data so
  // EvaluatorPolicy / SelfPlayCollector can construct PreviewMutationVector +
  // Fingerprint extension features per candidate. Existing consumers ignore
  // these new fields (PolicyCandidateAction has an open index signature).
  //
  // RpcAction is a tagged union (proto): the discriminator is `action.$case`
  // and the payload is `action.value`. UseSkillAction.skillDefinitionId is the
  // resolved id matching FingerprintLake skill entries. PlayCardAction also
  // carries a `skillDefinitionId` (the underlying play-card skill).
  const useSkillAction =
    action.action?.$case === "useSkill" ? action.action.value : null
  const skillDefinitionId =
    useSkillAction !== null
      ? useSkillAction.skillDefinitionId
      : (playCardAction !== null && "skillDefinitionId" in playCardAction
          ? (playCardAction as { skillDefinitionId?: number }).skillDefinitionId ?? null
          : null)

  return {
    candidate_id: String(index),
    action_case: actionCase,
    skill_definition_id: skillDefinitionId,
    preview_data: action.preview ?? null,
    damage_estimate: previewStats.damage,
    reaction_value: previewStats.reactions,
    tempo_value: previewStats.tempo,
    survival_risk: previewStats.selfPressure,
    healing_estimate: previewStats.healing,
    self_heal_value: previewStats.selfHeal,
    team_heal_value: previewStats.teamHeal,
    draw_value: previewStats.drawCount,
    dice_fix_value: actionCase === "elementalTuning" ? 1 : 0,
    energy_gain_value: previewStats.energyGainCount,
    create_support_value: previewStats.createSupportCount,
    create_summon_value: previewStats.createSummonCount,
    create_equipment_value: previewStats.createEquipmentCount,
    forced_switch_value: previewStats.forcedSwitchCount,
    self_switch_value: previewStats.selfSwitchCount,
    card_definition_id:
      playCardAction?.cardDefinitionId ??
      handCard?.definitionId ??
      undefined,
    card_id:
      playCardAction?.cardId ??
      tuningAction?.removedCardId ??
      handCard?.id ??
      undefined,
    card_entity_type: handCard?.type ?? undefined,
    card_equipment_type: handCard?.equipment ?? undefined,
    target_ids:
      playCardAction?.targetIds ??
      (action.action?.$case === "useSkill" ? action.action.value.targetIds : []),
    target_count:
      playCardAction?.targetIds.length ??
      (action.action?.$case === "useSkill" ? action.action.value.targetIds.length : 0),
    will_be_effectless: playCardAction?.willBeEffectless ?? false,
    cost: sumActionCost(action.requiredCost),
    total_cost: sumActionCost(action.requiredCost),
    dice_cost: action.requiredCost.map((cost) => ({
      type: cost.type,
      count: cost.count,
    })),
    tags: [
      ...(action.isFast ? ["fast"] : []),
      ...semanticTags,
      ...staticPrior.static_effect_tags,
    ],
    static_effect_tags: staticPrior.static_effect_tags,
    meta_effect_slots: staticPrior.meta_effect_slots,
    synergy_slots: staticPrior.synergy_slots,
    notes,
  }
}

function summarizePreview(
  previews: readonly PreviewData[],
  perspective: 0 | 1,
  selfIds: ReadonlySet<number>,
  opponentIds: ReadonlySet<number>,
): PreviewStats {
  const result: PreviewStats = {
    damage: 0,
    reactions: 0,
    tempo: 0,
    selfPressure: 0,
    healing: 0,
    selfHeal: 0,
    teamHeal: 0,
    drawCount: 0,
    createSupportCount: 0,
    createSummonCount: 0,
    createEquipmentCount: 0,
    energyGainCount: 0,
    forcedSwitchCount: 0,
    selfSwitchCount: 0,
  }

  for (const preview of previews) {
    const mutation = preview.mutation
    if (!mutation) {
      continue
    }

    switch (mutation.$case) {
      case "damage":
        if (mutation.value.damageType === PbDamageType.HEAL) {
          result.healing += mutation.value.value
          if (selfIds.has(mutation.value.targetId)) {
            result.selfHeal += mutation.value.value
            result.teamHeal += mutation.value.value
          }
          continue
        }
        if (opponentIds.has(mutation.value.targetId)) {
          result.damage += mutation.value.value
        }
        if (mutation.value.reactionType !== 0) {
          result.reactions += 1
        }
        if (mutation.value.causeDefeated) {
          result.tempo += 3
        }
        break
      case "createEntity":
        if (mutation.value.who === perspective) {
          if (mutation.value.where === PbEntityArea.SUPPORT) {
            result.createSupportCount += 1
          } else if (mutation.value.where === PbEntityArea.SUMMON) {
            result.createSummonCount += 1
          } else if (mutation.value.where === PbEntityArea.HAND) {
            result.drawCount += 1
          } else if (
            mutation.value.entity?.type === PbEntityType.EQUIPMENT
          ) {
            result.createEquipmentCount += 1
          }
        }
        result.tempo += 1
        break
      case "moveEntity":
        if (
          mutation.value.toWho === perspective &&
          mutation.value.toWhere === PbEntityArea.HAND &&
          mutation.value.reason === PbMoveEntityReason.DRAW
        ) {
          result.drawCount += 1
        }
        if (
          mutation.value.toWho === perspective &&
          mutation.value.toWhere === PbEntityArea.SUPPORT
        ) {
          result.createSupportCount += 1
        }
        if (
          mutation.value.toWho === perspective &&
          mutation.value.reason === PbMoveEntityReason.EQUIP
        ) {
          result.createEquipmentCount += 1
        }
        result.tempo += 0.5
        break
      case "modifyEntityVar":
        if (
          mutation.value.direction === PbModifyDirection.INCREASE &&
          mutation.value.variableName.toLowerCase().includes("energy") &&
          selfIds.has(mutation.value.entityId)
        ) {
          result.energyGainCount += 1
        }
        break
      case "switchActive":
        if (mutation.value.who !== perspective) {
          result.tempo += 2
          result.forcedSwitchCount += 1
        } else {
          result.selfPressure += 0.5
          result.selfSwitchCount += 1
        }
        break
      case "removeEntity":
        result.tempo += 0.5
        break
      default:
        break
    }
  }

  return result
}

function actionInfoToPolicyCandidate(
  action: ActionInfoWithModification,
  index: number,
  perspective: 0 | 1,
  self: GameState["players"][number],
  selfIds: ReadonlySet<number>,
  opponentIds: ReadonlySet<number>,
): PolicyCandidateAction {
  const previewStats = summarizePreview(action.preview ?? [], perspective, selfIds, opponentIds)
  const handCard =
    action.type === "playCard"
      ? self.hands.find((card: GameState["players"][number]["hands"][number]) => card.id === action.skill.caller.id)
      : action.type === "elementalTuning"
        ? self.hands.find((card: GameState["players"][number]["hands"][number]) => card.id === action.card.id)
        : undefined
  const cardDefinition = handCard?.definition
  const actionCase = action.type
  const semanticTags = inferSemanticTags(
    actionCase,
    cardDefinition ? entityDefinitionToPbType(cardDefinition.type) : undefined,
    cardDefinition ? entityDefinitionToPbEquipment(cardDefinition) : undefined,
    previewStats,
    action.type === "playCard" ? action.willBeEffectless : false,
  )
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
    preview_summary: {
      damage: previewStats.damage,
      reactions: previewStats.reactions,
      tempo: previewStats.tempo,
      healing: previewStats.healing,
      draw_count: previewStats.drawCount,
      create_support_count: previewStats.createSupportCount,
      create_summon_count: previewStats.createSummonCount,
      energy_gain_count: previewStats.energyGainCount,
      forced_switch_count: previewStats.forcedSwitchCount,
    },
    skill_type:
      action.type === "useSkill"
        ? normalizeCommonSkillType(action.skill.definition.skillType)
        : null,
    will_be_effectless: action.type === "playCard" ? action.willBeEffectless : false,
  })

  // V30 Stage 2.B — Pass through `skill_definition_id` and raw preview data so
  // EvaluatorPolicy can construct PreviewMutationVector + Fingerprint extension
  // features per candidate. Existing consumers ignore these new fields.
  //
  // This function takes ActionInfoWithModification (engine-side type), so the
  // discriminator is `action.type` (`useSkill` | `playCard` | …), unlike the
  // proto-level `actionToPolicyCandidate` below which uses `action.action.$case`.
  const skillDefinitionId =
    action.type === "useSkill"
      ? action.skill.definition.id
      : action.type === "playCard"
        ? action.skill.definition.id
        : null

  return {
    candidate_id: String(index),
    action_case: actionCase,
    skill_definition_id: skillDefinitionId,
    preview_data: action.preview ?? null,
    damage_estimate: previewStats.damage,
    reaction_value: previewStats.reactions,
    tempo_value: previewStats.tempo,
    survival_risk: previewStats.selfPressure,
    healing_estimate: previewStats.healing,
    self_heal_value: previewStats.selfHeal,
    team_heal_value: previewStats.teamHeal,
    draw_value: previewStats.drawCount,
    dice_fix_value: action.type === "elementalTuning" ? 1 : 0,
    energy_gain_value: previewStats.energyGainCount,
    create_support_value: previewStats.createSupportCount,
    create_summon_value: previewStats.createSummonCount,
    create_equipment_value: previewStats.createEquipmentCount,
    forced_switch_value: previewStats.forcedSwitchCount,
    self_switch_value: previewStats.selfSwitchCount,
    card_definition_id:
      action.type === "playCard"
        ? action.skill.caller.definition.id
        : action.type === "elementalTuning"
          ? action.card.definition.id
          : undefined,
    card_id:
      action.type === "playCard"
        ? action.skill.caller.id
        : action.type === "elementalTuning"
          ? action.card.id
          : undefined,
    card_entity_type: cardDefinition ? entityDefinitionToPbType(cardDefinition.type) : undefined,
    card_equipment_type: cardDefinition ? entityDefinitionToPbEquipment(cardDefinition) : undefined,
    target_ids:
      action.type === "playCard" || action.type === "useSkill"
        ? action.targets.map((target) => target.id)
        : [],
    target_count:
      action.type === "playCard" || action.type === "useSkill"
        ? action.targets.length
        : 0,
    will_be_effectless: action.type === "playCard" ? action.willBeEffectless : false,
    cost: sumActionMapCost(action.cost),
    total_cost: sumActionMapCost(action.cost),
    dice_cost: [...action.cost.entries()].map(([type, count]) => ({ type, count })),
    tags: [
      ...(action.fast ? ["fast"] : []),
      ...semanticTags,
      ...staticPrior.static_effect_tags,
    ],
    static_effect_tags: staticPrior.static_effect_tags,
    meta_effect_slots: staticPrior.meta_effect_slots,
    synergy_slots: staticPrior.synergy_slots,
    notes: [
      `validity=${ActionValidity[action.validity]}`,
      `autoDice=${action.autoSelectedDice.length}`,
      ...(action.type === "playCard" && action.willBeEffectless ? ["effectless=true"] : []),
    ],
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

function inferSemanticTags(
  actionCase: string,
  entityType: PbEntityType | undefined,
  equipmentType: PbEquipmentType | undefined,
  previewStats: PreviewStats,
  willBeEffectless: boolean,
): string[] {
  const tags = new Set<string>()

  if (actionCase === "playCard") {
    tags.add("card")
  }
  if (entityType === PbEntityType.EVENT_CARD) {
    tags.add("event")
  }
  if (entityType === PbEntityType.SUPPORT) {
    tags.add("support_card")
  }
  if (entityType === PbEntityType.EQUIPMENT) {
    tags.add("equipment_card")
  }
  if (equipmentType === PbEquipmentType.WEAPON) {
    tags.add("weapon")
  }
  if (equipmentType === PbEquipmentType.ARTIFACT) {
    tags.add("artifact")
  }
  if (equipmentType === PbEquipmentType.TECHNIQUE) {
    tags.add("technique")
  }
  if (previewStats.healing > 0) {
    tags.add("heal")
  }
  if (previewStats.drawCount > 0) {
    tags.add("draw")
  }
  if (previewStats.createSupportCount > 0) {
    tags.add("support_engine")
  }
  if (previewStats.createSummonCount > 0) {
    tags.add("summon_engine")
  }
  if (previewStats.createEquipmentCount > 0) {
    tags.add("equip")
  }
  if (previewStats.energyGainCount > 0) {
    tags.add("energy")
  }
  if (previewStats.forcedSwitchCount > 0) {
    tags.add("force_switch")
  }
  if (actionCase === "elementalTuning") {
    tags.add("dice_fix")
  }
  if (willBeEffectless) {
    tags.add("effectless")
  }

  return [...tags]
}

function sumActionCost(costs: readonly { type: number; count: number }[]): number {
  return costs.reduce((sum, cost) => {
    if (
      cost.type === PbDiceRequirementType.ENERGY ||
      cost.type === PbDiceRequirementType.LEGEND
    ) {
      return sum
    }
    return sum + cost.count
  }, 0)
}

function sumActionMapCost(cost: ReadonlyMap<number, number>): number {
  let total = 0
  for (const [type, count] of cost) {
    if (
      type === PbDiceRequirementType.ENERGY ||
      type === PbDiceRequirementType.LEGEND
    ) {
      continue
    }
    total += count
  }
  return total
}

function sumDefinitionCost(
  costs: readonly { type: number; count: number }[],
): number {
  return costs.reduce((sum, cost) => {
    if (
      cost.type === PbDiceRequirementType.ENERGY ||
      cost.type === PbDiceRequirementType.LEGEND
    ) {
      return sum
    }
    return sum + cost.count
  }, 0)
}

function entityDefinitionToPbType(type: string): PbEntityType {
  switch (type) {
    case "eventCard":
      return PbEntityType.EVENT_CARD
    case "support":
      return PbEntityType.SUPPORT
    case "equipment":
      return PbEntityType.EQUIPMENT
    case "summon":
      return PbEntityType.SUMMON
    case "combatStatus":
      return PbEntityType.COMBAT_STATUS
    case "status":
      return PbEntityType.STATUS
    default:
      return PbEntityType.UNSPECIFIED
  }
}

function entityDefinitionToPbEquipment(definition: { tags: readonly string[] }): PbEquipmentType {
  if (definition.tags.includes("weapon")) {
    return PbEquipmentType.WEAPON
  }
  if (definition.tags.includes("artifact")) {
    return PbEquipmentType.ARTIFACT
  }
  if (definition.tags.includes("technique")) {
    return PbEquipmentType.TECHNIQUE
  }
  return PbEquipmentType.OTHER
}

function flipSide(side: 0 | 1): 0 | 1 {
  return side === 0 ? 1 : 0
}
