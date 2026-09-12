// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import getData from "@gi-tcg/data"
import {
  PbDamageType,
  PbDiceRequirementType,
  PbEntityArea,
  PbModifyDirection,
  PbMoveEntityReason,
  type Notification,
  type PreviewData,
} from "@gi-tcg/typings"
import type {
  CostEntryV1,
  HandCardObservationV1,
} from "@gi-tcg/ml/contracts"

type VisibleState = NonNullable<Notification["state"]>

export interface StaticPriorDefinitionV1 {
  static_effect_tags: string[]
  meta_effect_slots: Record<string, number>
  retention_value: number
}

export interface PreviewSignalSummaryV1 {
  damage: number
  reactions: number
  tempo: number
  healing: number
  draw_count: number
  create_support_count: number
  create_summon_count: number
  energy_gain_count: number
  forced_switch_count: number
}

export interface CandidateStaticPriorInputV1 {
  action_case: string
  source_definition_id?: number | null
  sacrificed_definition_id?: number | null
  required_cost?: readonly CostEntryV1[]
  preview_summary?: PreviewSignalSummaryV1 | null
  skill_type?: "normal" | "elemental" | "burst" | "technique" | null
  will_be_effectless?: boolean
}

const EFFECT_FAMILY_TAGS = new Set([
  "direct_damage",
  "heal_now",
  "energy_gain",
  "dice_fix",
  "draw_cards",
  "summon_create",
  "support_create",
  "reaction_enable",
  "burst_enable",
  "force_switch",
  "future_random_value",
])

// ━━━━━━━━━━━━━━━━━━━━━━━━ Skill Semantic Extraction ━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Runtime type-check helpers.  We cannot import SkillDefinition / InitiativeSkillDefinition
 * directly from @gi-tcg/core because they are not in the public API; but the runtime data
 * always has `triggerOn` (string) and `initiativeSkillConfig` (object|null).
 */
interface RuntimeSkillDef {
  readonly type: "skill"
  readonly triggerOn: string
  readonly initiativeSkillConfig: null | {
    readonly skillType: string
    readonly gainEnergy?: boolean
    readonly shouldFast?: boolean
    readonly requiredCost?: ReadonlyArray<{ readonly type: number; readonly count: number }>
    readonly hidden?: boolean
  }
  readonly filter: unknown // opaque function — not inspectable
}

/** Mapping: triggerOn → semantic timing/effect tags */
const TRIGGER_TAG_MAP: Record<string, string[]> = {
  // ── Turn-structure triggers (timing profile) ──
  onEndPhase:          ["timing:endPhase"],
  onActionPhase:       ["timing:actionPhase"],
  onRoundBegin:        ["timing:roundStart"],
  onRoundEnd:          ["timing:roundEnd"],
  onBattleBegin:       ["timing:battleStart"],

  // ── Reactive triggers (what cues the effect) ──
  onPlayCard:          ["timing:reactive", "effect:triggerOnPlayCard"],
  onBeforePlayCard:    ["timing:reactive", "effect:triggerOnPlayCard"],
  onUseSkill:          ["timing:reactive", "effect:triggerOnSkill"],
  onBeforeUseSkill:    ["timing:reactive", "effect:triggerOnSkill"],
  onSwitchActive:      ["timing:reactive", "effect:triggerOnSwitch"],
  onReaction:          ["timing:reactive", "effect:triggerOnReaction"],
  onTransformDefinition: ["timing:reactive"],

  // ── Damage pipeline (combat amplification/mitigation) ──
  modifyDamage0:       ["effect:modifyDamage", "effect:damageTypeOverride"],
  modifyDamage1:       ["effect:modifyDamage", "effect:damageIncrease"],
  modifyDamage2:       ["effect:modifyDamage", "effect:damageMultiply"],
  modifyDamage3:       ["effect:modifyDamage", "effect:damageDecrease"],
  multiplySkillDamage: ["effect:modifyDamage", "effect:damageMultiplier"],
  increaseDamaged:     ["effect:damageAmplify", "effect:vulnerability"],
  decreaseDamaged:     ["effect:damageReduction", "effect:shield"],
  onDamageOrHeal:      ["timing:reactive", "effect:triggerOnDamageHeal"],

  // ── Healing pipeline ──
  modifyHeal0:         ["effect:modifyHeal", "effect:healCancel"],
  modifyHeal1:         ["effect:modifyHeal", "effect:healDecrease"],
  modifyReaction:      ["effect:modifyReaction"],

  // ── Entry / disposal ──
  onEnter:             ["timing:onDeploy"],
  onDispose:           ["timing:onDestroy"],

  // ── Resource manipulation ──
  onGenerateDice:      ["effect:diceManipulation", "effect:diceGeneration"],
  modifyRoll:          ["effect:diceFix"],
  onHandCardInserted:  ["effect:handManipulation"],

  // ── Action modification ──
  modifyAction0:       ["effect:actionCostMod", "effect:addDiceCost"],
  modifyAction1:       ["effect:actionCostMod", "effect:addColorCost"],
  modifyAction2:       ["effect:actionCostMod", "effect:reduceAnyCost", "effect:setFastAction"],
  modifyAction3:       ["effect:actionCostMod", "effect:deductAllCost"],
  replaceAction:       ["effect:actionOverride"],

  // ── Initiative control ──
  beforeFastSwitch:    ["effect:fastAction", "effect:tempoSwitch"],

  // ── Special ──
  onRevive:            ["effect:revive"],
  modifyZeroHealth:    ["effect:deathSave"],
  onChangeVariable:    ["timing:reactive"],
  modifyChangeVariable:["timing:reactive"],
  onSelectCard:        ["timing:reactive"],
  onCustomEvent:       ["timing:custom"],
}

/** Initiative skill type → strategic tag (applies to both character skills and card play skills) */
const SKILL_TYPE_TAG_MAP: Record<string, string[]> = {
  normal:    ["skill:normal"],
  elemental: ["skill:elemental"],
  burst:     ["skill:burst", "burst_enable"],
  technique: ["skill:technique"],
}

/**
 * Extract semantic tags from an entity or character's skill definitions.
 *
 * Works on both EntityDefinition.skills (cards, summons, statuses) and
 * CharacterDefinition.skills (character passive & initiative skills).
 *
 * Strategy:
 *  - For triggered skills (triggerOn !== "initiative"): extract timing/effect
 *    tags from the trigger event name.
 *  - For initiative skills (triggerOn === "initiative"): extract skill-type,
 *    energy-gain, and fast-action tags from initiativeSkillConfig.
 *
 * This avoids deep function inspection (impossible on opaque closures) while
 * capturing the key strategic dimensions that generic entity-type tagging misses.
 */
function extractSkillSemanticTags(skills: ReadonlyArray<RuntimeSkillDef> | undefined): string[] {
  if (!skills || skills.length === 0) return []

  const tags = new Set<string>()

  for (const skill of skills) {
    // --- Triggered (reactive/passive) skills ---
    if (skill.triggerOn !== "initiative") {
      const mapped = TRIGGER_TAG_MAP[skill.triggerOn]
      if (mapped) {
        for (const tag of mapped) {
          tags.add(tag)
        }
      }
      continue
    }

    // --- Initiative (active) skills ---
    // Used both for character active skills and for card "playSkill"
    const config = skill.initiativeSkillConfig
    if (!config) continue

    // Skill type
    const typeTags = SKILL_TYPE_TAG_MAP[config.skillType]
    if (typeTags) {
      for (const tag of typeTags) {
        tags.add(tag)
      }
    }

    // Energy gain (e.g. normal attacks generate 1 energy)
    if (config.gainEnergy) {
      tags.add("effect:energyGain")
      tags.add("energy_gain")
    }

    // Fast action (某些技能/特技默认为快速行动)
    if (config.shouldFast) {
      tags.add("effect:fastAction")
    }

    // Hidden skills (e.g. 准备技能第二阶段, 不可直接选择)
    if (config.hidden) {
      tags.add("skill:hidden")
    }
  }

  return [...tags].sort()
}

const OFFICIAL_DATA = getData()
const STATIC_PRIOR_BY_DEFINITION_ID = buildDefinitionPriorMap()

export function summarizePreviewSignals(
  previews: readonly PreviewData[],
  perspective: 0 | 1,
  state: VisibleState | undefined,
): PreviewSignalSummaryV1 {
  const result: PreviewSignalSummaryV1 = {
    damage: 0,
    reactions: 0,
    tempo: 0,
    healing: 0,
    draw_count: 0,
    create_support_count: 0,
    create_summon_count: 0,
    energy_gain_count: 0,
    forced_switch_count: 0,
  }

  const selfIds = new Set((state?.player[perspective]?.character ?? []).map((character) => character.id))
  const opponentIds = new Set(
    (state?.player[flipSide(perspective)]?.character ?? []).map((character) => character.id),
  )

  for (const preview of previews) {
    const mutation = preview.mutation
    if (!mutation) {
      continue
    }

    switch (mutation.$case) {
      case "damage":
        if (mutation.value.damageType === PbDamageType.HEAL) {
          if (selfIds.has(mutation.value.targetId)) {
            result.healing += mutation.value.value
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
            result.create_support_count += 1
          } else if (mutation.value.where === PbEntityArea.SUMMON) {
            result.create_summon_count += 1
          } else if (mutation.value.where === PbEntityArea.HAND) {
            result.draw_count += 1
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
          result.draw_count += 1
        }
        if (
          mutation.value.toWho === perspective &&
          mutation.value.toWhere === PbEntityArea.SUPPORT
        ) {
          result.create_support_count += 1
        }
        result.tempo += 0.5
        break
      case "modifyEntityVar":
        if (
          mutation.value.direction === PbModifyDirection.INCREASE &&
          mutation.value.variableName.toLowerCase().includes("energy") &&
          selfIds.has(mutation.value.entityId)
        ) {
          result.energy_gain_count += 1
        }
        break
      case "switchActive":
        if (mutation.value.who !== perspective) {
          result.forced_switch_count += 1
          result.tempo += 2
        }
        break
      default:
        break
    }
  }

  return result
}

export function buildHandCardStaticAnnotation(
  definitionId: number | null,
  existingTags: readonly string[] = [],
  costSummary: readonly CostEntryV1[] = [],
): Pick<HandCardObservationV1, "static_effect_tags" | "meta_effect_slots" | "tags"> {
  const base = getStaticPriorForDefinitionId(definitionId)
  const tags = new Set(existingTags)
  for (const tag of base.static_effect_tags) {
    tags.add(tag)
  }

  const metaEffectSlots = {
    ...base.meta_effect_slots,
  }
  if (costSummary.length > 0) {
    metaEffectSlots.hand_cost_total = costSummary.reduce((sum, cost) => sum + cost.count, 0)
  }

  return {
    tags: [...tags].sort(),
    static_effect_tags: base.static_effect_tags,
    meta_effect_slots: compactNumericSlots(metaEffectSlots),
  }
}

export function buildPlayerHandStaticPriorSummary(
  cards: readonly Pick<HandCardObservationV1, "static_effect_tags" | "meta_effect_slots">[],
): {
  effect_family_counts: Record<string, number>
  meta_prior_slots: Record<string, number>
} {
  const effectFamilyCounts: Record<string, number> = {}
  const metaPriorSlots = {
    hand_retention_total: 0,
    hand_setup_dependency_total: 0,
    hand_reaction_window_total: 0,
    hand_finisher_alignment_total: 0,
    hand_high_value_card_count: 0,
    hand_heal_like_count: 0,
    hand_reaction_enable_count: 0,
  }

  for (const card of cards) {
    for (const tag of card.static_effect_tags ?? []) {
      if (EFFECT_FAMILY_TAGS.has(tag)) {
        effectFamilyCounts[tag] = (effectFamilyCounts[tag] ?? 0) + 1
      }
    }
    const meta = card.meta_effect_slots ?? {}
    metaPriorSlots.hand_retention_total += meta.retention_value_proxy ?? 0
    metaPriorSlots.hand_setup_dependency_total += meta.setup_dependency ?? 0
    metaPriorSlots.hand_reaction_window_total += meta.reaction_window_enable ?? 0
    metaPriorSlots.hand_finisher_alignment_total += meta.finisher_alignment ?? 0
    if ((meta.retention_value_proxy ?? 0) >= 2.5) {
      metaPriorSlots.hand_high_value_card_count += 1
    }
    if ((card.static_effect_tags ?? []).includes("heal_now")) {
      metaPriorSlots.hand_heal_like_count += 1
    }
    if ((card.static_effect_tags ?? []).includes("reaction_enable")) {
      metaPriorSlots.hand_reaction_enable_count += 1
    }
  }

  return {
    effect_family_counts: effectFamilyCounts,
    meta_prior_slots: compactNumericSlots(metaPriorSlots),
  }
}

export function buildCandidateStaticPrior(
  input: CandidateStaticPriorInputV1,
): {
  static_effect_tags: string[]
  meta_effect_slots: Record<string, number>
  synergy_slots: Record<string, number>
} {
  const source = getStaticPriorForDefinitionId(input.source_definition_id ?? null)
  const sacrificed = getStaticPriorForDefinitionId(input.sacrificed_definition_id ?? null)
  const preview = input.preview_summary
  const tags = new Set<string>(source.static_effect_tags)

  switch (input.action_case) {
    case "playCard":
      tags.add("play_card")
      break
    case "useSkill":
      tags.add("use_skill")
      break
    case "switchActive":
      tags.add("switch_active")
      break
    case "elementalTuning":
      tags.add("dice_fix")
      tags.add("tune_sacrifice")
      break
    case "declareEnd":
      tags.add("end_round")
      break
  }

  if (input.skill_type) {
    tags.add(`skill_type:${input.skill_type}`)
    if (input.skill_type === "burst") {
      tags.add("burst_enable")
    }
  } else if (input.action_case === "useSkill" && hasEnergyCost(input.required_cost ?? [])) {
    tags.add("skill_type:burst")
    tags.add("burst_enable")
  }

  if ((preview?.damage ?? 0) > 0) tags.add("direct_damage")
  if ((preview?.healing ?? 0) > 0) tags.add("heal_now")
  if ((preview?.draw_count ?? 0) > 0) tags.add("draw_cards")
  if ((preview?.create_support_count ?? 0) > 0) tags.add("support_create")
  if ((preview?.create_summon_count ?? 0) > 0) tags.add("summon_create")
  if ((preview?.energy_gain_count ?? 0) > 0) tags.add("energy_gain")
  if ((preview?.forced_switch_count ?? 0) > 0) tags.add("force_switch")
  if ((preview?.reactions ?? 0) > 0) tags.add("reaction_enable")
  if (input.will_be_effectless) tags.add("effectless")

  const metaEffectSlots = {
    ...source.meta_effect_slots,
    damage_estimate: preview?.damage ?? 0,
    tempo_gain_now: Math.max(source.meta_effect_slots.tempo_gain_now ?? 0, preview?.tempo ?? 0),
    reaction_window_enable: Math.max(
      source.meta_effect_slots.reaction_window_enable ?? 0,
      (preview?.reactions ?? 0) > 0 ? 1 : 0,
    ),
    burst_window_enable: Math.max(
      source.meta_effect_slots.burst_window_enable ?? 0,
      tags.has("burst_enable") ? 1 : 0,
    ),
    action_density_gain:
      (source.meta_effect_slots.action_density_gain ?? 0) +
      (preview?.draw_count ?? 0) +
      (preview?.create_support_count ?? 0) * 0.5 +
      (preview?.create_summon_count ?? 0) * 0.5,
    stability_gain:
      (source.meta_effect_slots.stability_gain ?? 0) +
      Math.min((preview?.healing ?? 0) / 2, 3),
    finisher_alignment:
      (source.meta_effect_slots.finisher_alignment ?? 0) +
      (tags.has("burst_enable") ? 1 : tags.has("direct_damage") ? 0.25 : 0),
    setup_dependency:
      (source.meta_effect_slots.setup_dependency ?? 0) +
      ((preview?.create_support_count ?? 0) + (preview?.create_summon_count ?? 0) > 0 ? 0.5 : 0),
    resource_conversion_score:
      input.action_case === "elementalTuning"
        ? Math.max(0.25, 1.75 - sacrificed.retention_value * 0.35)
        : source.meta_effect_slots.resource_conversion_score ?? 0,
    retention_value_proxy:
      input.action_case === "elementalTuning"
        ? sacrificed.retention_value
        : source.retention_value,
    setup_dependency_loss:
      input.action_case === "elementalTuning"
        ? sacrificed.meta_effect_slots.setup_dependency ?? 0
        : 0,
    reaction_window_loss:
      input.action_case === "elementalTuning"
        ? sacrificed.meta_effect_slots.reaction_window_enable ?? 0
        : 0,
    finisher_alignment_loss:
      input.action_case === "elementalTuning"
        ? sacrificed.meta_effect_slots.finisher_alignment ?? 0
        : 0,
  }

  const synergySlots = compactNumericSlots({
    sacrifice_is_high_value:
      input.action_case === "elementalTuning" && sacrificed.retention_value >= 2.5 ? 1 : 0,
    sacrifice_is_setup_piece:
      input.action_case === "elementalTuning" &&
      (sacrificed.meta_effect_slots.setup_dependency ?? 0) >= 1
        ? 1
        : 0,
    sacrifice_is_reaction_piece:
      input.action_case === "elementalTuning" &&
      (sacrificed.meta_effect_slots.reaction_window_enable ?? 0) >= 1
        ? 1
        : 0,
  })

  return {
    static_effect_tags: [...tags].sort(),
    meta_effect_slots: compactNumericSlots(metaEffectSlots),
    synergy_slots: synergySlots,
  }
}

export function getStaticPriorForDefinitionId(definitionId: number | null): StaticPriorDefinitionV1 {
  if (definitionId == null) {
    return {
      static_effect_tags: [],
      meta_effect_slots: {},
      retention_value: 0,
    }
  }
  return STATIC_PRIOR_BY_DEFINITION_ID.get(definitionId) ?? {
    static_effect_tags: [],
    meta_effect_slots: {},
    retention_value: 0,
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━ Priority Map Builder ━━━━━━━━━━━━━━━━━━━━━━━━

function buildDefinitionPriorMap(): Map<number, StaticPriorDefinitionV1> {
  const result = new Map<number, StaticPriorDefinitionV1>()

  for (const definition of OFFICIAL_DATA.entities.values()) {
    const tags = new Set<string>([`entity:${definition.type}`])
    const meta: Record<string, number> = {}
    let retentionValue = definition.disableTuning ? 2.5 : 1

    // --- Fine-grained semantic tags (Scheme 3) ---
    // Card category tags based on entity type
    switch (definition.type) {
      case "eventCard":
        tags.add("card:event")
        break
      case "equipment":
        tags.add("card:equipment")
        break
      case "support":
        tags.add("card:support")
        break
      case "summon":
        tags.add("entity:summon")
        break
      case "status":
      case "combatStatus":
        tags.add("entity:status")
        break
    }

    for (const tag of definition.tags) {
      tags.add(`tag:${tag}`)
      switch (tag) {
        case "food":
          tags.add("heal_now")
          tags.add("category:consumable")
          meta.stability_gain = Math.max(meta.stability_gain ?? 0, 1)
          retentionValue += 0.5
          break
        case "resonance":
          tags.add("reaction_enable")
          tags.add("category:resonance")
          meta.reaction_window_enable = Math.max(meta.reaction_window_enable ?? 0, 1.5)
          retentionValue += 1.5
          break
        case "legend":
          tags.add("future_random_value")
          tags.add("category:legendary")
          meta.finisher_alignment = Math.max(meta.finisher_alignment ?? 0, 0.5)
          retentionValue += 1.25
          break
        case "talent":
          tags.add("category:talent")
          meta.setup_dependency = Math.max(meta.setup_dependency ?? 0, 1.5)
          meta.finisher_alignment = Math.max(meta.finisher_alignment ?? 0, 1.5)
          retentionValue += 2
          break
        case "weapon":
        case "artifact":
          tags.add("category:equipment")
          meta.setup_dependency = Math.max(meta.setup_dependency ?? 0, 0.75)
          meta.finisher_alignment = Math.max(meta.finisher_alignment ?? 0, 0.75)
          retentionValue += 0.75
          break
        case "technique":
          tags.add("category:technique")
          meta.setup_dependency = Math.max(meta.setup_dependency ?? 0, 1)
          retentionValue += 0.75
          break
        case "action":
          retentionValue += 0.25
          break
        default:
          break
      }
    }

    // --- Element-specific tags for elemental cards ---
    // Map elemental dice-related tags to element categories
    for (const tag of definition.tags) {
      if (["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"].includes(tag)) {
        tags.add(`element:${tag}`)
      }
      if (["sword", "claymore", "polearm", "bow", "catalyst"].includes(tag)) {
        tags.add(`weapon:${tag}`)
      }
    }

    // --- Cost tier tags based on variable configs ---
    const usageVar = definition.varConfigs?.usage
    if (usageVar && typeof usageVar.initialValue === "number") {
      const usage = usageVar.initialValue
      if (usage <= 1) tags.add("durability:single_use")
      else if (usage <= 2) tags.add("durability:short")
      else if (usage <= 3) tags.add("durability:medium")
      else tags.add("durability:long")
    }

    switch (definition.type) {
      case "support":
        tags.add("support_create")
        meta.setup_dependency = Math.max(meta.setup_dependency ?? 0, 1)
        meta.action_density_gain = Math.max(meta.action_density_gain ?? 0, 0.5)
        retentionValue += 1
        break
      case "summon":
        tags.add("summon_create")
        meta.setup_dependency = Math.max(meta.setup_dependency ?? 0, 1)
        retentionValue += 0.75
        break
      case "equipment":
        retentionValue += 0.5
        break
      default:
        break
    }

    // --- Skill count tag (for characters played via card) ---
    const skillCount = definition.skills?.length ?? 0
    if (skillCount > 0) {
      tags.add("has_initiative_skill")
      if (skillCount >= 4) tags.add("skill_count:high")
      else if (skillCount >= 3) tags.add("skill_count:normal")
    }

    // ── V5: DSL skill semantic extraction (Section 5.1) ──
    // Append trigger-timing, effect-category, and initiative-skill-type tags
    // derived directly from the compiled SkillDefinition objects.
    const skillTags = extractSkillSemanticTags(definition.skills as unknown as RuntimeSkillDef[] | undefined)
    for (const tag of skillTags) {
      tags.add(tag)
    }

    result.set(definition.id, {
      static_effect_tags: [...tags].sort(),
      meta_effect_slots: compactNumericSlots({
        ...meta,
        retention_value_proxy: clamp(retentionValue, 0, 5),
      }),
      retention_value: clamp(retentionValue, 0, 5),
    })
  }

  // --- Also add character definitions to the prior map ---
  // Characters use their tags (element, weapon, nation) for semantic features
  for (const [id, character] of OFFICIAL_DATA.characters) {
    if (result.has(id)) continue  // Don't overwrite entity entries
    const tags = new Set<string>(["entity:character"])
    const meta: Record<string, number> = {}
    const characterTags = Array.isArray(character.tags)
      ? character.tags.filter((t): t is string => typeof t === "string")
      : []

    for (const tag of characterTags) {
      tags.add(`tag:${tag}`)
      // Element tags
      if (["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"].includes(tag)) {
        tags.add(`element:${tag}`)
      }
      // Weapon tags
      if (["sword", "claymore", "polearm", "bow", "catalyst", "otherWeapon"].includes(tag)) {
        tags.add(`weapon:${tag}`)
      }
    }

    // HP tier from varConfigs
    const maxHp = character.varConfigs?.maxHealth?.initialValue
    if (maxHp != null) {
      meta.base_hp = maxHp
      if (maxHp <= 7) tags.add("hp_tier:low")
      else if (maxHp <= 9) tags.add("hp_tier:mid")
      else tags.add("hp_tier:high")
    }

    // Energy tier from varConfigs
    const maxEnergy = character.varConfigs?.maxEnergy?.initialValue
    if (maxEnergy != null) {
      meta.base_energy = maxEnergy
      if (maxEnergy <= 2) tags.add("energy_tier:low")
      else if (maxEnergy <= 3) tags.add("energy_tier:mid")
      else tags.add("energy_tier:high")
    }

    // Skill count
    const charSkillCount = character.skills?.length ?? 0
    if (charSkillCount >= 4) tags.add("skill_count:high")
    else if (charSkillCount >= 3) tags.add("skill_count:normal")

    // ── V5: DSL skill semantic extraction for characters ──
    // Characters have both passive skills (triggered) and initiative skills (N/E/Q/T).
    const charSkillTags = extractSkillSemanticTags(character.skills as unknown as RuntimeSkillDef[] | undefined)
    for (const tag of charSkillTags) {
      tags.add(tag)
    }

    result.set(id, {
      static_effect_tags: [...tags].sort(),
      meta_effect_slots: compactNumericSlots({
        ...meta,
        retention_value_proxy: 5,  // Characters are always high retention
      }),
      retention_value: 5,
    })
  }

  return result
}

function hasEnergyCost(costs: readonly CostEntryV1[]): boolean {
  return costs.some((cost) => cost.type === PbDiceRequirementType.ENERGY && cost.count > 0)
}

function compactNumericSlots(slots: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(slots)
      .filter(([, value]) => Number.isFinite(value) && value !== 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function flipSide(side: 0 | 1): 0 | 1 {
  return side === 0 ? 1 : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
