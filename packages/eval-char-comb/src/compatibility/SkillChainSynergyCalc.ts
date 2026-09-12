/**
 * SkillChainSynergyCalc
 *
 * 计算两角色之间的技能链配合效率（synergy-metrics 文档维度②）。
 *
 * 模式包括：
 * - 跨角色链：A的产出 → B利用（召唤反应、战斗状态、元素附着、能量桥）
 * - 自引擎链：角色自身的技能形成闭环（E→Q、召唤自buff、状态自触发）
 */

import type {
  CharacterOutputProfile,
  SkillProfile,
  DamageTypeValue,
} from "../profiler/types.js";
import type { SkillChainSynergy } from "./types.js";

// ─── 权重配置 ─────────────────────────────────────────────

const PATTERN_WEIGHTS = {
  /** A.E产出召唤物→B普攻触发反应 */
  summonReaction: 0.22,
  /** A.Q产出战斗状态→B技能利用 */
  combatStatusUtil: 0.20,
  /** A挂元素→切B触发反应链 */
  auraReactionChain: 0.18,
  /** A.E能量→B.Q充能 */
  energyBridge: 0.15,
  /** 角色自引擎（skill chain 自指） */
  selfEngine: 0.15,
  /** 跨角色召唤/状态即使无反应也有价值（如结晶护盾） */
  passiveSynergy: 0.10,
} as const;

// ─── 元素反应对查找 ──────────────────────────────────────

const REACTION_TIER: Record<string, "S" | "A" | "B"> = {
  "cryo+pyro": "S", "pyro+cryo": "S",
  "hydro+pyro": "S", "pyro+hydro": "S",
  "hydro+electro": "A", "electro+hydro": "A",
  "pyro+electro": "A", "electro+pyro": "A",
  "cryo+electro": "A", "electro+cryo": "A",
  "cryo+hydro": "A", "hydro+cryo": "A",
  "electro+dendro": "A", "dendro+electro": "A",
  "hydro+dendro": "B", "dendro+hydro": "B",
  "pyro+dendro": "B", "dendro+pyro": "B",
};

const DAMAGE_TYPE_NAMES: Record<number, string> = {
  0: "physical", 1: "cryo", 2: "hydro", 3: "pyro",
  4: "electro", 5: "anemo", 6: "geo", 7: "dendro",
};

function elementName(t: DamageTypeValue): string {
  return DAMAGE_TYPE_NAMES[t] ?? "unknown";
}

function reactionTier(elA: string, elB: string): "S" | "A" | "B" | null {
  return REACTION_TIER[`${elA}+${elB}`] ?? null;
}

// ═══════════════════════════════════════════════════════════
//  自引擎检测
// ═══════════════════════════════════════════════════════════

/**
 * 计算单个角色的自引擎得分。
 * 检测角色的技能是否形成自闭环：
 * - E→Q 能量链（E 产生能量 → Q 消耗能量）
 * - 召唤物/状态 为自己提供 buff
 * - 多段技能组合（如 E→E→E 连段）
 */
function computeSelfEngineScore(profile: CharacterOutputProfile): number {
  let score = 0;
  const detected: string[] = [];

  // 1) E→Q 能量闭环
  const elementalSkills = profile.skills.filter(s => s.type === "elemental" && s.gainEnergy);
  const burstSkills = profile.skills.filter(s => s.type === "burst" && s.cost.energyCost > 0);
  if (elementalSkills.length > 0 && burstSkills.length > 0) {
    score += 0.4;
    detected.push("eToQ");
  }

  // 2) 召唤物 → 自己享受（如一斗阿丑 → buff 自身）
  const summonSkills = profile.skills.filter(s => s.output.createsSummon);
  const hasSelfBuffingSummon = summonSkills.some(s => {
    const sp = s.output.summonProfile;
    // 召唤物 + 自己还有其他攻击技能 = 召唤物在为自己服务
    return sp && profile.skills.some(sk =>
      sk !== s && sk.type !== "passive" && sk.output.mainDamageValue > 0
    );
  });
  if (hasSelfBuffingSummon) {
    score += 0.3;
    detected.push("summonSelfBuff");
  }

  // 3) 战斗状态 → 自己触发（多段技能取状态）
  const statusSkills = profile.skills.filter(s => s.output.createsStatus);
  const hasSelfTriggeringStatus = statusSkills.some(s => {
    const st = s.output.statusProfile;
    // 状态类型是 combatStatus + 自己有其他技能可利用
    return st && st.type === "combatStatus" && profile.skills.some(sk =>
      sk !== s && sk.type !== "passive" && sk.output.mainDamageValue > 0
    );
  });
  if (hasSelfTriggeringStatus) {
    score += 0.3;
    detected.push("statusSelfTrigger");
  }

  // 4) 多段同类型攻击技能（如迪卢克 EEE 连段、一斗 普攻→E→Q 全覆盖）
  const combatTypes = new Set(
    profile.skills
      .filter(s => s.type !== "passive" && s.output.mainDamageValue > 0)
      .map(s => s.type)
  );
  if (combatTypes.size >= 3) {
    // 有 normal + elemental + burst 三件套 = 完整战斗回路
    score += 0.2;
    detected.push("fullCombatKit");
  } else if (combatTypes.size === 2) {
    score += 0.1;
    detected.push("dualCombatKit");
  }

  // 5) 低能量需求 + E 提供能量 = 快速蓄满
  const lowCostBurst = burstSkills.filter(s => s.cost.energyCost <= 2);
  if (lowCostBurst.length > 0 && elementalSkills.length > 0) {
    score += 0.2;
    detected.push("fastBurst");
  }

  // 6) 有 DoT 输出 = 即使切走也在贡献
  if (profile.rhythm.hasDoTOutput) {
    score += 0.15;
    detected.push("dotOutput");
  }

  return Math.min(1.0, score);
}

// ═══════════════════════════════════════════════════════════
//  跨角色链检测
// ═══════════════════════════════════════════════════════════

/**
 * 计算两角色之间的技能链配合得分。
 */
export function computeSkillChainPair(
  a: CharacterOutputProfile,
  b: CharacterOutputProfile,
): SkillChainSynergy {
  const elemA = elementName(a.base.element);
  const elemB = elementName(b.base.element);

  let summonScore = 0;
  let combatStatusScore = 0;
  let auraChainScore = 0;
  let energyBridgeScore = 0;
  let passiveScore = 0;

  const detected = new Map<string, number>();

  for (const skill of a.skills) {
    // ── 模式 1: A 产出召唤物 → B 元素能触发反应 ──
    if (skill.output.createsSummon && skill.output.summonProfile) {
      const sElem = elementName(skill.output.summonProfile.endPhaseDamageElement);
      const tier = reactionTier(sElem, elemB);
      if (tier) {
        const score = tier === "S" ? 1.0 : tier === "A" ? 0.65 : 0.35;
        summonScore = Math.max(summonScore, score);
        detected.set("summonReaction", score);
      } else if (sElem !== "physical" && elemB !== sElem && elemA !== elemB) {
        // 召唤物有元素但无直接反应 → 潜在被动价值
        passiveScore = Math.max(passiveScore, 0.3);
        detected.set("passiveSynergy", 0.3);
      }
    }

    // ── 模式 2: A 产出战斗状态 → B 技能可触发 ──
    if (skill.output.createsStatus && skill.output.statusProfile) {
      const st = skill.output.statusProfile;
      if (st.teammateTriggerable) {
        combatStatusScore = Math.max(combatStatusScore, 0.8);
        detected.set("combatStatusUtil", 0.8);
      } else if (st.type === "combatStatus") {
        combatStatusScore = Math.max(combatStatusScore, 0.5);
        detected.set("combatStatusUtil", 0.5);
      }
    }

    // ── 模式 3: A 挂元素 → B 可触发反应 ──
    if (skill.type !== "passive" && skill.output.mainDamageValue > 0) {
      const dmgEl = elementName(skill.output.mainDamageType);
      const tier = reactionTier(dmgEl, elemB);
      if (tier && elemA !== elemB) {
        const score = tier === "S" ? 0.9 : tier === "A" ? 0.55 : 0.3;
        auraChainScore = Math.max(auraChainScore, score);
        detected.set("auraReactionChain", score);
      }
    }

    // ── 模式 4: A.E 充能 → B.Q ──
    if (skill.gainEnergy && skill.type === "elemental") {
      const bBurst = b.skills.find(s => s.type === "burst");
      if (bBurst && bBurst.cost.energyCost > 0) {
        energyBridgeScore = Math.max(energyBridgeScore, 0.6);
        detected.set("energyBridge", 0.6);
      }
    }
  }

  // B→A 方向补充检测
  for (const skill of b.skills) {
    if (skill.gainEnergy && skill.type === "elemental") {
      const aBurst = a.skills.find(s => s.type === "burst");
      if (aBurst && aBurst.cost.energyCost > 0 && energyBridgeScore < 0.6) {
        energyBridgeScore = Math.max(energyBridgeScore, 0.5);
        detected.set("energyBridge", 0.5);
      }
    }
  }

  const crossScore =
    summonScore * PATTERN_WEIGHTS.summonReaction +
    combatStatusScore * PATTERN_WEIGHTS.combatStatusUtil +
    auraChainScore * PATTERN_WEIGHTS.auraReactionChain +
    energyBridgeScore * PATTERN_WEIGHTS.energyBridge +
    passiveScore * PATTERN_WEIGHTS.passiveSynergy;

  return {
    charA: a.definitionId,
    charB: b.definitionId,
    score: Math.round(crossScore * 1000) / 1000,
    detectedPatterns: [...detected.entries()].map(([k, v]) => `${k}:${v.toFixed(2)}`),
  };
}

/**
 * 计算三角色牌组的技能链综合得分。
 * 包含跨角色对 + 每个角色的自引擎得分。
 */
export function computeTripleSkillChain(
  profiles: readonly [CharacterOutputProfile, CharacterOutputProfile, CharacterOutputProfile],
): number {
  const [a, b, c] = profiles;

  // 跨角色对
  const ab = computeSkillChainPair(a, b);
  const ac = computeSkillChainPair(a, c);
  const bc = computeSkillChainPair(b, c);
  const ba = computeSkillChainPair(b, a);
  const ca = computeSkillChainPair(c, a);
  const cb = computeSkillChainPair(c, b);

  const pairScores = [
    Math.max(ab.score, ba.score),
    Math.max(ac.score, ca.score),
    Math.max(bc.score, cb.score),
  ];

  // 自引擎得分：每个角色独立
  const selfScores = [
    computeSelfEngineScore(a),
    computeSelfEngineScore(b),
    computeSelfEngineScore(c),
  ];

  // 聚合：对高 + 自引擎平均
  const sortedPairs = [...pairScores].sort((x, y) => y - x);
  const avgPair = sortedPairs[0] * 0.45 + sortedPairs[1] * 0.30 + sortedPairs[2] * 0.15;
  const avgSelf = selfScores.reduce((s, v) => s + v, 0) / 3;

  // 综合: 跨角色 70% + 自引擎 30%
  return Math.round((avgPair * 0.70 + avgSelf * 0.30) * 1000) / 1000;
}
