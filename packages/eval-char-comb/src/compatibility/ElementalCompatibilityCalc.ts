/**
 * ElementalCompatibilityCalc
 *
 * 基于七圣召唤的元素反应表，计算两个角色之间的元素兼容性。
 */

import { Reaction, DamageType, Aura } from "@gi-tcg/typings";
import type {
  ElementalCompatibility,
  DamageTypeValue,
  ReactionValue,
} from "../profiler/types.js";

// ─── 反应表（从 core/src/base/reaction.ts 静态提取）────────

/**
 * REACTION_MAP[被挂元素][攻击元素] = [新元素, 反应 | null]
 * 仅收录能产生反应的组合。
 */
const REACTION_TABLE: Array<{
  aura: number;
  attack: DamageTypeValue;
  reaction: ReactionValue;
}> = [
  // Cryo 附着
  { aura: Aura.Cryo, attack: DamageType.Hydro, reaction: Reaction.Frozen },
  { aura: Aura.Cryo, attack: DamageType.Pyro, reaction: Reaction.Melt },
  { aura: Aura.Cryo, attack: DamageType.Electro, reaction: Reaction.Superconduct },
  { aura: Aura.Cryo, attack: DamageType.Anemo, reaction: Reaction.SwirlCryo },
  { aura: Aura.Cryo, attack: DamageType.Geo, reaction: Reaction.CrystallizeCryo },
  // Hydro 附着
  { aura: Aura.Hydro, attack: DamageType.Cryo, reaction: Reaction.Frozen },
  { aura: Aura.Hydro, attack: DamageType.Pyro, reaction: Reaction.Vaporize },
  { aura: Aura.Hydro, attack: DamageType.Electro, reaction: Reaction.ElectroCharged },
  { aura: Aura.Hydro, attack: DamageType.Anemo, reaction: Reaction.SwirlHydro },
  { aura: Aura.Hydro, attack: DamageType.Geo, reaction: Reaction.CrystallizeHydro },
  { aura: Aura.Hydro, attack: DamageType.Dendro, reaction: Reaction.Bloom },
  // Pyro 附着
  { aura: Aura.Pyro, attack: DamageType.Cryo, reaction: Reaction.Melt },
  { aura: Aura.Pyro, attack: DamageType.Hydro, reaction: Reaction.Vaporize },
  { aura: Aura.Pyro, attack: DamageType.Electro, reaction: Reaction.Overloaded },
  { aura: Aura.Pyro, attack: DamageType.Anemo, reaction: Reaction.SwirlPyro },
  { aura: Aura.Pyro, attack: DamageType.Geo, reaction: Reaction.CrystallizePyro },
  { aura: Aura.Pyro, attack: DamageType.Dendro, reaction: Reaction.Burning },
  // Electro 附着
  { aura: Aura.Electro, attack: DamageType.Cryo, reaction: Reaction.Superconduct },
  { aura: Aura.Electro, attack: DamageType.Hydro, reaction: Reaction.ElectroCharged },
  { aura: Aura.Electro, attack: DamageType.Pyro, reaction: Reaction.Overloaded },
  { aura: Aura.Electro, attack: DamageType.Anemo, reaction: Reaction.SwirlElectro },
  { aura: Aura.Electro, attack: DamageType.Geo, reaction: Reaction.CrystallizeElectro },
  { aura: Aura.Electro, attack: DamageType.Dendro, reaction: Reaction.Quicken },
  // Dendro 附着
  { aura: Aura.Dendro, attack: DamageType.Hydro, reaction: Reaction.Bloom },
  { aura: Aura.Dendro, attack: DamageType.Pyro, reaction: Reaction.Burning },
  { aura: Aura.Dendro, attack: DamageType.Electro, reaction: Reaction.Quicken },
];

// 元素 → 可能作为攻击方触发的伤害类型
const ELEMENT_TO_DAMAGE: Record<string, DamageTypeValue[]> = {
  cryo: [DamageType.Cryo],
  hydro: [DamageType.Hydro],
  pyro: [DamageType.Pyro],
  electro: [DamageType.Electro],
  anemo: [DamageType.Anemo],
  geo: [DamageType.Geo],
  dendro: [DamageType.Dendro],
};

// DamageType → Aura（角色挂上的元素附着）
const DAMAGE_TO_AURA: Record<number, number> = {
  [DamageType.Cryo]: Aura.Cryo,
  [DamageType.Hydro]: Aura.Hydro,
  [DamageType.Pyro]: Aura.Pyro,
  [DamageType.Electro]: Aura.Electro,
  [DamageType.Dendro]: Aura.Dendro,
};

// ─── 反应分级 ────────────────────────────────────────────────

const S_TIER = new Set([Reaction.Melt, Reaction.Vaporize]);
const A_TIER = new Set([
  Reaction.ElectroCharged, Reaction.Overloaded, Reaction.Frozen,
  Reaction.Superconduct,
]);
// B_TIER = 其余有效反应

function reactionTier(
  reactions: ReactionValue[],
): "S" | "A" | "B" | "C" | "none" {
  if (reactions.length === 0) return "none";
  if (reactions.some((r) => S_TIER.has(r))) return "S";
  if (reactions.some((r) => A_TIER.has(r))) return "A";
  return "B";
}

// ═════════════════════════════════════════════════════════════
//  公共 API
// ═════════════════════════════════════════════════════════════

/**
 * 计算两角色之间的元素兼容性。
 * @param elementA - 角色A的元素 tag（如 "pyro"）
 * @param elementB - 角色B的元素 tag
 */
export function computeElementalCompatibility(
  elementA: string,
  elementB: string,
): ElementalCompatibility {
  const aDamages = ELEMENT_TO_DAMAGE[elementA] ?? [];
  const bDamages = ELEMENT_TO_DAMAGE[elementB] ?? [];

  const possibleReactions = new Set<ReactionValue>();

  // A挂元素 → B攻击触发
  for (const aDmg of aDamages) {
    const aura = DAMAGE_TO_AURA[aDmg];
    if (aura === undefined) continue;
    for (const bDmg of bDamages) {
      for (const entry of REACTION_TABLE) {
        if (entry.aura === aura && entry.attack === bDmg) {
          possibleReactions.add(entry.reaction);
        }
      }
    }
  }

  // B挂元素 → A攻击触发
  for (const bDmg of bDamages) {
    const aura = DAMAGE_TO_AURA[bDmg];
    if (aura === undefined) continue;
    for (const aDmg of aDamages) {
      for (const entry of REACTION_TABLE) {
        if (entry.aura === aura && entry.attack === aDmg) {
          possibleReactions.add(entry.reaction);
        }
      }
    }
  }

  const reactions = [...possibleReactions];

  return {
    possibleReactions: reactions,
    reactionTier: reactionTier(reactions),
    satisfiesTeamElementRequirement: false, // 需要针对特定角色检查
  };
}

// ─── 反应分级权重 ──────────────────────────────────────────────

// 基于 core/src/base/reaction.ts 的实际反应表
// S = 蒸发/融化（游戏中 2.0x 伤害倍率）
// A = 感电/超载/冻结/超导（控制+伤害兼顾）
// B = 扩散/结晶/绽放/燃烧/超激化（辅助/条件触发）
const REACTION_WEIGHT: Partial<Record<ReactionValue, number>> = {
  [Reaction.Melt]: 3.0,
  [Reaction.Vaporize]: 3.0,
  [Reaction.ElectroCharged]: 2.0,
  [Reaction.Overloaded]: 2.0,
  [Reaction.Frozen]: 2.0,
  [Reaction.Superconduct]: 2.0,
  [Reaction.SwirlCryo]: 1.0,
  [Reaction.SwirlHydro]: 1.0,
  [Reaction.SwirlPyro]: 1.0,
  [Reaction.SwirlElectro]: 1.0,
  [Reaction.CrystallizeCryo]: 1.0,
  [Reaction.CrystallizeHydro]: 1.0,
  [Reaction.CrystallizePyro]: 1.0,
  [Reaction.CrystallizeElectro]: 1.0,
  [Reaction.Bloom]: 1.0,
  [Reaction.Burning]: 1.0,
  [Reaction.Quicken]: 1.0,
};

// 最大可能反应得分 = 三个S级反应（理论最优三元素队，如冰+水+火）
// 能同时触发 Melt + Vaporize + Frozen = 3+3+2 = 8
const MAX_REACTION_SCORE = 8.0;

/**
 * 计算三角色的元素反应加权得分。
 *
 * 使用反应等级权重（S=3, A=2, B=1）而非简单种类计数。
 * 冰+水+火 → Melt(3) + Vaporize(3) + Frozen(2) = 8/8 = 1.0
 * 冰+雷+风 → Superconduct(2) + Swirl(1) = 3/8 = 0.375
 */
export function computeReactionCoverage(
  elements: readonly [string, string, string],
): number {
  const allReactions = new Set<ReactionValue>();
  const pairs: [string, string][] = [
    [elements[0], elements[1]],
    [elements[0], elements[2]],
    [elements[1], elements[2]],
  ];
  for (const [a, b] of pairs) {
    const compat = computeElementalCompatibility(a, b);
    for (const r of compat.possibleReactions) {
      allReactions.add(r);
    }
  }
  // 对去重后的反应集合求加权总分
  let totalWeight = 0;
  for (const r of allReactions) {
    totalWeight += REACTION_WEIGHT[r] ?? 0;
  }
  return Math.min(1.0, totalWeight / MAX_REACTION_SCORE);
}
