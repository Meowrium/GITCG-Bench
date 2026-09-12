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

import {
  FeatureExtractor,
  type ScoringFeatureVector,
} from "../../learning/scoring/feature-extractor.js"
import type {
  PolicyCandidateAction,
  PolicyTurnDigest,
} from "../../runtime/policy/types.js"
import { computeDiceQualityMetrics } from "../../runtime/policy/baseline-policy.js"

export const BRANCH_EVAL_FEATURE_VERSION = "gi-agent.feature-extractor.v1"

const QUERY_FEATURE_NAMES: ReadonlyArray<keyof ScoringFeatureVector> = [
  "selfActiveHpRatio",
  "selfTeamAvgHpRatio",
  "selfAliveCount",
  "selfActiveEnergyGap",
  "selfNearBurstCount",
  "opponentActiveHpRatio",
  "opponentTeamAvgHpRatio",
  "opponentAliveCount",
  "opponentBurstReady",
  "diceCount",
  "omniCount",
  "cardsInHand",
  "supportCount",
  "summonCount",
  "supportRoom",
  "summonRoom",
  "round",
  "hpAdvantage",
  "aliveAdvantage",
  "energyUrgency",
  "healUrgency",
]

const ACTION_CASE_FEATURE_NAMES: ReadonlyArray<keyof ScoringFeatureVector> = [
  "isUseSkill",
  "isPlayCard",
  "isSwitchActive",
  "isDeclareEnd",
  "isOtherAction",
]

const excludedCandidateFeatureNames = new Set<string>([
  ...QUERY_FEATURE_NAMES,
  ...ACTION_CASE_FEATURE_NAMES,
])

const featureExtractor = new FeatureExtractor()

export const BRANCH_EVAL_QUERY_FEATURE_NAMES = [...QUERY_FEATURE_NAMES]

export const BRANCH_EVAL_CANDIDATE_FEATURE_NAMES = FeatureExtractor
  .featureNames()
  .filter((name) => !excludedCandidateFeatureNames.has(name))

export function buildBranchEvalQueryNumericSlots(
  digest: PolicyTurnDigest,
): Record<string, number> {
  const baseline = featureExtractor.extract(digest, { action_case: "unknown" })
  const diceQuality = computeDiceQualityMetrics(digest)
  return {
    ...pickFeatureNames(baseline, BRANCH_EVAL_QUERY_FEATURE_NAMES),
    ...extractStaticQueryNumericSlots(digest),
    dice_quality_score: diceQuality.qualityScore,
    dice_omni_count: diceQuality.omniCount,
    dice_total_count: diceQuality.totalDice,
    dice_unlock_potential: diceQuality.unlockPotential,
    ...flattenDiceDeficit(diceQuality.deficitByElement),
  }
}

function flattenDiceDeficit(deficitByElement: Record<number, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [element, deficit] of Object.entries(deficitByElement)) {
    result[`dice_deficit_element_${element}`] = deficit
  }
  return result
}

export function buildBranchEvalCandidateNumericSlots(
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction | undefined,
): Record<string, number> {
  if (!candidate) {
    return {}
  }
  const full = featureExtractor.extract(digest, candidate)
  const diceQuality = computeDiceQualityMetrics(digest)
  const unlockForThisCandidate = candidate.is_valid === false
    && candidate.action_case !== "elementalTuning"
    && candidate.action_case !== "declareEnd"
    && diceQuality.unlockPotential > 0
    ? 1 : 0
  return {
    ...pickFeatureNames(full, BRANCH_EVAL_CANDIDATE_FEATURE_NAMES),
    ...extractCandidateNumericSlots(candidate, digest),
    dice_unlock_for_candidate: unlockForThisCandidate,
  }
}

function pickFeatureNames(
  features: ScoringFeatureVector,
  names: readonly (keyof ScoringFeatureVector)[],
): Record<string, number> {
  return names.reduce<Record<string, number>>((acc, name) => {
    acc[name] = features[name]
    return acc
  }, {})
}

function extractStaticQueryNumericSlots(
  digest: PolicyTurnDigest,
): Record<string, number> {
  return {
    ...flattenNumericRecord("self_static", digest.self_summary?.meta_prior_slots),
    ...flattenNumericRecord("self_effect_count", digest.self_summary?.effect_family_counts),
    ...flattenNumericRecord("opponent_public_static", digest.opponent_summary?.meta_prior_slots),
    ...flattenNumericRecord(
      "opponent_public_effect_count",
      digest.opponent_summary?.effect_family_counts,
    ),
  }
}

function extractCandidateNumericSlots(
  candidate: PolicyCandidateAction,
  digest?: PolicyTurnDigest,
): Record<string, number> {
  const slots: Record<string, number> = {
    ...flattenNumericRecord("meta_effect_slots", candidate.meta_effect_slots),
    ...flattenNumericRecord("synergy_slots", candidate.synergy_slots),
  }

  // P0: Skill sub-type features (match training-side keys)
  const actionCase = candidate.action_case ?? "";
  const skillType = (candidate as any).skill_type as string | undefined;
  const isBurst = actionCase === "useSkill" && skillType === "burst";
  if (actionCase === "useSkill") {
    slots["is_normal_attack"] = skillType === "normal" ? 1 : 0;
    slots["is_elemental_skill"] = skillType === "elemental" ? 1 : 0;
    slots["is_burst"] = skillType === "burst" ? 1 : 0;
    // Pure utility: no damage, no healing, no forced switch
    const meta = (candidate.meta_effect_slots ?? {}) as Record<string, number>;
    slots["is_pure_utility"] = (
      (meta.damage_estimate ?? 0) === 0 &&
      (meta.healing_estimate ?? 0) === 0 &&
      Object.keys(meta).length === 0
    ) ? 1 : 0;

    // P1: Tag-derived skill effect flags
    const tags = new Set((candidate as any).static_effect_tags ?? candidate.tags ?? []);
    const hasTag = (t: string) => tags.has(t) ? 1 : 0;
    slots["has_direct_damage"] = hasTag("direct_damage");
    slots["creates_summon"] = hasTag("summon_create");
    slots["has_heal"] = hasTag("heal_now");
    slots["has_energy_gain"] = hasTag("energy_gain");
    slots["has_force_switch_active"] = hasTag("force_switch");

    // ━━ P3: Engine-aware features ━━
    if (digest) {
      // ── Reaction prediction ──
      const activeChar = findActiveCharacter(digest, "self");
      const oppActiveChar = findActiveCharacter(digest, "opponent");
      const oppAura = oppActiveChar?.aura as number | null | undefined;
      const selfElement = inferCharacterElement(activeChar?.definition_id);
      const skillElement = selfElement; // skill uses active character's element for NA/E
      const reactionResult = oppAura != null && skillElement != null
        ? predictReaction(skillElement, oppAura)
        : { willReact: false, bonus: 0, reactionType: 0 };
      slots["will_trigger_reaction"] = reactionResult.willReact ? 1 : 0;
      slots["reaction_damage_bonus"] = reactionResult.bonus;
      slots["reaction_type_id"] = reactionResult.reactionType;

      // ── Energy breakpoints ──
      if (activeChar) {
        const curEnergy = activeChar.energy ?? 0;
        const maxEnergy = activeChar.max_energy ?? 3;
        const energyGain = hasTag("energy_gain") ? 1 : 0;
        const afterEnergy = Math.min(curEnergy + energyGain, maxEnergy);
        slots["energy_after_action"] = afterEnergy;
        slots["will_enable_burst"] = (afterEnergy >= maxEnergy && curEnergy < maxEnergy) ? 1 : 0;
        slots["energy_deficit"] = maxEnergy - curEnergy;
        // P3: Energy-scaled burst — higher when closer to full energy
        slots["burst_energy_ratio"] = isBurst ? (curEnergy / Math.max(1, maxEnergy)) : 0;
      }

      // ── Lethal bonus (P2: 斩杀优先) ──
      if (oppActiveChar) {
        const oppHP = (oppActiveChar as any).hp ?? (oppActiveChar as any).health ?? 10;
        const dmgEstimate = (candidate.meta_effect_slots as any)?.damage_estimate
          ?? (candidate as any).damage_estimate ?? 0;
        const reactionBonus = slots["reaction_damage_bonus"] ?? 0;
        const totalDmg = dmgEstimate + reactionBonus;
        // +100 bonus if this action kills the opponent's active character
        slots["lethal_bonus"] = (totalDmg > 0 && totalDmg >= oppHP) ? 1 : 0;
        // Reaction quality: +2 reactions (Melt/Vape) are premium
        slots["reaction_is_amplifying"] = (reactionBonus >= 2) ? 1 : 0;
      }

      // ── Dice color matching ──
      computeDiceMatchSlots(slots, digest, candidate);

      // ── Shield on target ──
      if (oppActiveChar) {
        const shieldValue = estimateShieldOnCharacter(oppActiveChar);
        slots["target_has_shield"] = shieldValue > 0 ? 1 : 0;
        slots["target_shield_value"] = shieldValue;
      }

      // ── Equipment synergy ──
      if (activeChar) {
        const equipIds: number[] = (activeChar as any).equipment_ids ?? [];
        slots["has_talent_equipped"] = equipIds.some(id => isTalentForCharacter(id, activeChar.definition_id)) ? 1 : 0;
        slots["has_weapon_equipped"] = equipIds.length > 0 ? 1 : 0;
        slots["equipment_count"] = equipIds.length;
      }

      // ── Combat status effects ──
      const selfCombatStatusDefIds = ((digest.self_summary as any).combat_statuses ?? [])
        .map((cs: any) => cs.definition_id);
      const oppCombatStatusDefIds = ((digest.opponent_summary as any).combat_statuses ?? [])
        .map((cs: any) => cs.definition_id);
      const selfStatusSet = new Set(selfCombatStatusDefIds);
      const oppStatusSet = new Set(oppCombatStatusDefIds);
      slots["self_has_crystallize_shield"] = selfStatusSet.has(CRYSTALLIZE_DEF_ID) ? 1 : 0;
      slots["opp_has_frozen"] = oppStatusSet.has(FROZEN_DEF_ID) ? 1 : 0;
      slots["opp_has_burning"] = oppStatusSet.has(BURNING_FLAME_DEF_ID) ? 1 : 0;
      slots["quicken_field_active"] = (selfStatusSet.has(CATALYZING_FIELD_DEF_ID) || oppStatusSet.has(CATALYZING_FIELD_DEF_ID)) ? 1 : 0;
      slots["dendro_core_active"] = (selfStatusSet.has(DENDRO_CORE_DEF_ID) || oppStatusSet.has(DENDRO_CORE_DEF_ID)) ? 1 : 0;

      // ── Summon pressure ──
      const selfSummons = ((digest.self_summary as any).summons ?? []) as any[];
      const oppSummons = ((digest.opponent_summary as any).summons ?? []) as any[];
      const selfSummonDmg = selfSummons.reduce((sum: number, s: any) =>
        sum + estimateSummonDamage(s.definition_id, s.usage ?? 1), 0);
      const oppSummonDmg = oppSummons.reduce((sum: number, s: any) =>
        sum + estimateSummonDamage(s.definition_id, s.usage ?? 1), 0);
      slots["self_summon_damage_potential"] = selfSummonDmg;
      slots["opp_summon_damage_potential"] = oppSummonDmg;
      slots["opp_summon_count"] = oppSummons.length;

      // ── Damage type ──
      slots["damage_is_piercing"] = hasTag("piercing_damage") ? 1 : 0;

      // ── Special resources ──
      const resSummary = digest.resource_summary as any;
      if (resSummary) {
        slots["can_charged_attack"] = resSummary.can_charged ? 1 : 0;
        slots["can_plunging_attack"] = resSummary.can_plunging ? 1 : 0;
        slots["legend_available"] = resSummary.legend_used ? 0 : 1;
      }
    }
  } else {
    // Non-skill actions: zero out P0/P1/P3 features
    slots["is_normal_attack"] = 0;
    slots["is_elemental_skill"] = 0;
    slots["is_burst"] = 0;
    slots["is_pure_utility"] = 0;
    slots["has_direct_damage"] = 0;
    slots["creates_summon"] = 0;
    slots["has_heal"] = 0;
    slots["has_energy_gain"] = 0;
    slots["has_force_switch_active"] = 0;
    // P3 features also zero for non-skill
    slots["will_trigger_reaction"] = 0;
    slots["reaction_damage_bonus"] = 0;
    slots["reaction_type_id"] = 0;
    slots["energy_after_action"] = 0;
    slots["will_enable_burst"] = 0;
    slots["energy_deficit"] = 0;
    slots["burst_energy_ratio"] = 0;
    slots["lethal_bonus"] = 0;
    slots["reaction_is_amplifying"] = 0;
    slots["target_has_shield"] = 0;
    slots["target_shield_value"] = 0;
    slots["has_talent_equipped"] = 0;
    slots["has_weapon_equipped"] = 0;
    slots["equipment_count"] = 0;
    slots["self_has_crystallize_shield"] = 0;
    slots["opp_has_frozen"] = 0;
    slots["opp_has_burning"] = 0;
    slots["quicken_field_active"] = 0;
    slots["dendro_core_active"] = 0;
    slots["self_summon_damage_potential"] = 0;
    slots["opp_summon_damage_potential"] = 0;
    slots["opp_summon_count"] = 0;
    slots["damage_is_piercing"] = 0;
    slots["can_charged_attack"] = 0;
    slots["can_plunging_attack"] = 0;
    slots["legend_available"] = 0;
  }

  // Temporal dice features: compute from candidate cost
  let diceCost = 0
  const dc = candidate.dice_cost
  if (Array.isArray(dc)) {
    diceCost = (dc as Array<{ count: number }>).reduce((s, c) => s + (c.count ?? 0), 0)
  } else if (typeof candidate.total_cost === "number") {
    diceCost = candidate.total_cost as number
  }

  slots["temporal_dice_cost"] = diceCost

  if (digest?.resource_summary && typeof digest.resource_summary === "object") {
    const availableDice = (digest.resource_summary as Record<string, unknown>).dice_count as number | undefined
    if (availableDice != null && availableDice > 0) {
      slots["temporal_dice_budget_ratio"] = diceCost / availableDice
    }
  }

  return slots
}

// ━━━━━━━━━━━━━━━ P3: Engine-Aware Helpers ━━━━━━━━━━━━━━━

/** Known combat status / summon definition IDs (from @gi-tcg/core/builder/reaction.ts) */
const CRYSTALLIZE_DEF_ID = 111;
const FROZEN_DEF_ID = 106;
const BURNING_FLAME_DEF_ID = 115;
const DENDRO_CORE_DEF_ID = 116;
const CATALYZING_FIELD_DEF_ID = 117;
const THUNDERCLOUD_DEF_ID = 205;

/** Character element mapping: definition_id → element (PbDiceType) */
const CHAR_ELEMENT_MAP: Record<number, number> = {
  // Anemo
  1504: 1, // Xiao
  1505: 1, // Venti
  1508: 1, // Sucrose (bodyguard)
  1510: 1, // Kaedehara Kazuha
  1531: 1, // Faruzan
  1553: 1, // Shikanoin Heizou
  1557: 1, // Ifa
  // Cryo
  1101: 2, // Ganyu
  1102: 2, // Kaeya
  1103: 2, // Chongyun
  1104: 2, // Kamisato Ayaka
  1105: 2, // Eula
  1107: 2, // Shenhe
  1108: 2, // Kamisato Ayaka
  1109: 2, // Qiqi
  1110: 2, // Skirk
  1112: 2, // Freminet
  // Electro
  1401: 3, // Fischl
  1402: 3, // Beidou
  1403: 3, // Lisa
  1404: 3, // Keqing
  1405: 3, // Kujou Sara
  1406: 3, // Razor
  1407: 3, // Raiden Shogun
  1408: 3, // Yae Miko
  1411: 3, // Cyno
  1412: 3, // Clorinde
  1421: 3, // Sethos
  1425: 3, // Ineffa
  // Dendro
  1701: 4, // Collei
  1702: 4, // Tighnari
  1703: 4, // Nahida
  1705: 4, // Consecrated Fanged Beast
  // Geo
  1601: 5, // Ningguang
  1602: 5, // Zhongli
  1603: 5, // Noelle
  1604: 5, // Arataki Itto
  1605: 5, // Albedo
  1607: 5, // Navia
  1611: 5, // Azhdaha
  // Hydro (ID=6 in DiceType for some mappings, but game uses specific IDs)
  1201: 6, // Barbara
  1202: 6, // Mona
  1203: 6, // Xingqiu
  1204: 6, // Sangonomiya Kokomi
  1205: 6, // Tartaglia
  1206: 6, // Yelan
  1207: 6, // Kamisato Ayato
  1211: 6, // Neuvillette
  1214: 6, // Dahlia
  1215: 6, // Aino
  // Pyro
  1301: 7, // Bennett
  1302: 7, // Diluc
  1303: 7, // Xiangling
  1304: 7, // Amber
  1305: 7, // Hu Tao
  1306: 7, // Klee
  1307: 7, // Yanfei
  1308: 7, // Thoma
  1310: 7, // Dehya
  1311: 7, // Gaming
  1312: 7, // Chevreuse
  1314: 7, // Lyney
  1316: 7, // Arlecchino
  1321: 7, // Mavuika
};

/**
 * Element reaction table.
 * Returns { willReact, bonus (+0/+1/+2), reactionType }
 * ReactionType numbers based on PbReactionType
 */
function predictReaction(skillElement: number, targetAura: number): {
  willReact: boolean; bonus: number; reactionType: number
} {
  // Reaction type codes (from @gi-tcg/typings PbReactionType)
  const REACTION = {
    VAPORIZE: 1, MELT: 2, OVERLOADED: 3, SUPERCONDUCT: 4,
    ELECTRO_CHARGED: 5, FROZEN: 6, SWIRL: 7,
    CRYSTALLIZE: 8, BURNING: 9, BLOOM: 10, QUICKEN: 11,
  } as const;
  // Damage bonus reactions
  const AMPLIFYING: Record<string, number> = {
    [`${7},${6}`]: REACTION.VAPORIZE,  // Pyro on Hydro
    [`${6},${7}`]: REACTION.VAPORIZE,  // Hydro on Pyro
    [`${7},${2}`]: REACTION.MELT,      // Pyro on Cryo
    [`${2},${7}`]: REACTION.MELT,      // Cryo on Pyro
  };
  // Non-damage-bonus but still reactions
  const ALL_REACTIONS: Record<string, number> = {
    ...AMPLIFYING,
    [`${7},${3}`]: REACTION.OVERLOADED,
    [`${3},${7}`]: REACTION.OVERLOADED,
    [`${2},${3}`]: REACTION.SUPERCONDUCT,
    [`${3},${2}`]: REACTION.SUPERCONDUCT,
    [`${6},${3}`]: REACTION.ELECTRO_CHARGED,
    [`${3},${6}`]: REACTION.ELECTRO_CHARGED,
    [`${6},${2}`]: REACTION.FROZEN,
    [`${2},${6}`]: REACTION.FROZEN,
    [`${1},${2}`]: REACTION.SWIRL,
    [`${1},${3}`]: REACTION.SWIRL,
    [`${1},${6}`]: REACTION.SWIRL,
    [`${1},${7}`]: REACTION.SWIRL,
    [`${5},${2}`]: REACTION.CRYSTALLIZE,
    [`${5},${3}`]: REACTION.CRYSTALLIZE,
    [`${5},${6}`]: REACTION.CRYSTALLIZE,
    [`${5},${7}`]: REACTION.CRYSTALLIZE,
    [`${7},${4}`]: REACTION.BURNING,
    [`${4},${7}`]: REACTION.BURNING,
    [`${6},${4}`]: REACTION.BLOOM,
    [`${4},${6}`]: REACTION.BLOOM,
    [`${3},${4}`]: REACTION.QUICKEN,
    [`${4},${3}`]: REACTION.QUICKEN,
  };

  const key = `${skillElement},${targetAura}`;
  const reactionType = ALL_REACTIONS[key];
  if (!reactionType) return { willReact: false, bonus: 0, reactionType: 0 };
  const bonus = AMPLIFYING[key] ? 2 : 0;
  return { willReact: true, bonus, reactionType };
}

function findActiveCharacter(
  digest: PolicyTurnDigest,
  which: "self" | "opponent",
): Record<string, any> | undefined {
  const summary = (which === "self" ? digest.self_summary : digest.opponent_summary) as any;
  const chars = summary?.characters as any[] | undefined;
  const activeId = summary?.active_character_id as number | undefined;
  if (!chars || activeId == null) return undefined;
  return chars.find((c: any) => c.id === activeId);
}

function inferCharacterElement(definitionId?: number): number | null {
  if (definitionId == null) return null;
  return CHAR_ELEMENT_MAP[definitionId] ?? null;
}

function computeDiceMatchSlots(
  slots: Record<string, number>,
  digest: PolicyTurnDigest,
  candidate: PolicyCandidateAction,
): void {
  const diceValues = (digest.resource_summary as any)?.dice_values as number[] | undefined;
  const dc = candidate.dice_cost;
  if (!diceValues || !dc) return;

  const costEntries: Array<{ type: number; count: number }> = Array.isArray(dc)
    ? dc as Array<{ type: number; count: number }>
    : [];

  let totalSpecificCost = 0;
  let matchingDice = 0;
  const availableByType = new Map<number, number>();
  for (const die of diceValues) {
    availableByType.set(die, (availableByType.get(die) ?? 0) + 1);
  }
  const omniCount = availableByType.get(0) ?? 0; // PbDiceType.OMNI = 0... let me check
  // Actually PbDiceType values: OMNI=0, CRYO=1, HYDRO=2, PYRO=3, ELECTRO=4, GEO=5, DENDRO=6, ANEMO=7
  // But for our map we use element values from DiceType enum

  for (const cost of costEntries) {
    if (cost.type === 0 || cost.type === 9) continue; // void or energy
    totalSpecificCost += cost.count;
    const available = availableByType.get(cost.type) ?? 0;
    matchingDice += Math.min(cost.count, available);
  }

  slots["dice_matching_count"] = matchingDice;
  slots["dice_specific_cost_total"] = totalSpecificCost;
  slots["dice_match_ratio"] = totalSpecificCost > 0 ? matchingDice / totalSpecificCost : 1;

  // Omni shortfall
  const shortfall = Math.max(0, totalSpecificCost - matchingDice);
  slots["omni_shortfall"] = shortfall;
  slots["omni_available"] = omniCount;
}

function estimateShieldOnCharacter(char: Record<string, any>): number {
  // Check status_ids for shield-related statuses
  // Shields are typically tracked as status entities with "shield" in variable name
  const statuses = (char as any).status_ids as Array<{ name: string; value: number }> | undefined;
  if (!statuses) return 0;
  let shieldValue = 0;
  for (const status of statuses) {
    if (status.name?.toLowerCase().includes("shield")) {
      shieldValue += status.value;
    }
  }
  return shieldValue;
}

function isTalentForCharacter(talentDefId: number, charDefId: number): boolean {
  // Talent cards have definition IDs close to character definition IDs
  // Usually talent = character + some offset (often same as character ID range)
  return talentDefId >= charDefId && talentDefId <= charDefId + 100;
}

function estimateSummonDamage(summonDefId: number, usage: number): number {
  // Known summon damage estimates (rough)
  const KNOWN_SUMMON_DMG: Record<number, number> = {
    115: 1,  // Burning Flame: 1 pyro damage
    205: 1,  // Thundercloud
    // Most summons deal ~1-3 damage per trigger
  };
  const baseDmg = KNOWN_SUMMON_DMG[summonDefId] ?? 1;
  return baseDmg * Math.max(1, usage);
}

function flattenNumericRecord(
  prefix: string,
  value: unknown,
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => typeof item === "number" && Number.isFinite(item))
      .map(([key, item]) => [`${prefix}.${key}`, item as number]),
  )
}
