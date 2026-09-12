/**
 * DeckCompatibilityScorer
 *
 * 综合三维兼容性（元素/费用/节奏），对三角色组合给出最终评分。
 */

import type {
  CharacterOutputProfile,
  DeckCompatibilityScore,
  PairCompatibility,
} from "../profiler/types.js";
import {
  computeElementalCompatibility,
  computeReactionCoverage,
} from "./ElementalCompatibilityCalc.js";
import { computeCostCompatibility } from "./CostCompatibilityCalc.js";
import {
  computeTempoCompatibility,
  computeTripleBurstStagger,
} from "./TempoCompatibilityCalc.js";
import { computeTripleSkillChain } from "./SkillChainSynergyCalc.js";

// ─── 权重配置 ─────────────────────────────────────────────

const WEIGHTS = {
  reaction: 0.25,
  skillChain: 0.35,
  cost: 0.15,
  tempo: 0.15,
  roleBalance: 0.10,
} as const;

// ═════════════════════════════════════════════════════════════
//  公共 API
// ═════════════════════════════════════════════════════════════

/**
 * 计算两角色间的完整兼容性。
 */
export function computePairCompatibility(
  a: CharacterOutputProfile,
  b: CharacterOutputProfile,
): PairCompatibility {
  const elemA = getElementTag(a);
  const elemB = getElementTag(b);

  return {
    charA: a.definitionId,
    charB: b.definitionId,
    elemental: computeElementalCompatibility(elemA, elemB),
    cost: computeCostCompatibility(a, b),
    tempo: computeTempoCompatibility(a, b),
  };
}

/**
 * 计算三角色牌组的综合兼容性评分。
 */
export function computeDeckCompatibility(
  profiles: readonly [CharacterOutputProfile, CharacterOutputProfile, CharacterOutputProfile],
): DeckCompatibilityScore {
  const [a, b, c] = profiles;
  const elements: [string, string, string] = [
    getElementTag(a),
    getElementTag(b),
    getElementTag(c),
  ];

  // ── 元素 ──
  const reactionCoverage = computeReactionCoverage(elements);
  const teamElementSatisfaction = 0; // TODO: 角色特定需求检查

  // ── 费用 ──
  const ab = computeCostCompatibility(a, b);
  const ac = computeCostCompatibility(a, c);
  const bc = computeCostCompatibility(b, c);
  const overallDiceConflict = (ab.diceConflictRate + ac.diceConflictRate + bc.diceConflictRate) / 3;
  const uniqueElements = new Set(elements).size;
  const canTwoCharacterRound = ab.canDualOutputInOneRound || ac.canDualOutputInOneRound || bc.canDualOutputInOneRound;

  // ── 节奏 ──
  const burstStagger = computeTripleBurstStagger(profiles);
  const outputContinuity = computeOutputContinuity(profiles);
  const mainDpsIdentified = identifyMainDps(profiles);
  const supportCoverage = computeSupportCoverage(profiles);

  // ── 综合评分 ──
  const reactionScore = reactionCoverage;
  const skillChainScore = computeTripleSkillChain(profiles);
  const costScore = 1 - overallDiceConflict;
  const tempoScore = burstStagger * 0.4 + outputContinuity * 0.6;
  const roleScore = (mainDpsIdentified ? 0.6 : 0.3) + supportCoverage * 0.4;

  const overallScore =
    reactionScore * WEIGHTS.reaction +
    skillChainScore * WEIGHTS.skillChain +
    costScore * WEIGHTS.cost +
    tempoScore * WEIGHTS.tempo +
    roleScore * WEIGHTS.roleBalance;

  // ── 模拟验证标记 ──
  const simulationPriorityReasons: string[] = [];
  if (a.complexity.requiresSimulation) simulationPriorityReasons.push(`${a.definitionId} 需要模拟`);
  if (b.complexity.requiresSimulation) simulationPriorityReasons.push(`${b.definitionId} 需要模拟`);
  if (c.complexity.requiresSimulation) simulationPriorityReasons.push(`${c.definitionId} 需要模拟`);

  return {
    characters: [a.definitionId, b.definitionId, c.definitionId],
    elemental: { reactionCoverage, teamElementSatisfaction },
    cost: {
      overallDiceConflict: Math.round(overallDiceConflict * 100) / 100,
      elementDiversity: uniqueElements,
      canTwoCharacterRound,
    },
    tempo: {
      burstStagger: Math.round(burstStagger * 100) / 100,
      outputContinuity: Math.round(outputContinuity * 100) / 100,
      mainDpsIdentified,
      supportCoverage: Math.round(supportCoverage * 100) / 100,
    },
    skillChain: {
      score: skillChainScore,
    },
    overallScore: Math.round(overallScore * 1000) / 1000,
    needsSimulationVerification: simulationPriorityReasons.length > 0,
    simulationPriorityReasons,
  };
}

// ─── 辅助计算 ─────────────────────────────────────────────

/** 输出连续性：结合 DoT、快速行动、中期伤害方差综合评估 */
function computeOutputContinuity(
  profiles: readonly CharacterOutputProfile[],
): number {
  let continuityScore = 0;

  // 有DoT的角色越多，回合间空隙越少
  const dotCount = profiles.filter((p) => p.rhythm.hasDoTOutput).length;
  continuityScore += dotCount * 0.2;

  // DoT 绝对量（2点DoT比1点更有价值）
  const totalDot = profiles.reduce((s, p) => s + p.rhythm.dotDamagePerRound, 0);
  continuityScore += Math.min(0.2, totalDot * 0.05);

  // 有快速行动输出的角色
  const fastCount = profiles.filter((p) => p.rhythm.hasFastActionDamage).length;
  continuityScore += fastCount * 0.15;

  // 中期伤害分布：有明显的伤害梯度（主C > 辅助）= 更好的分工
  const midDamages = profiles.map((p) => p.rhythm.phaseDamage[1]);
  const maxDmg = Math.max(...midDamages);
  const minDmg = Math.min(...midDamages);
  if (maxDmg > 0) {
    // 伤害比（最高/最低）：2~5倍 = 合理分工，太高=有个完全没用的角色
    const ratio = maxDmg / Math.max(0.1, minDmg);
    if (ratio >= 2 && ratio <= 5) {
      continuityScore += 0.15;
    } else if (ratio > 5) {
      continuityScore += 0.05; // 太极端，可能有个纯辅助
    }
  }

  return Math.min(1.0, continuityScore);
}

/** 识别主C：是否有一个角色的中期伤害显著高于其他两个 */
function identifyMainDps(
  profiles: readonly CharacterOutputProfile[],
): boolean {
  const damages = profiles.map((p) => p.rhythm.phaseDamage[1]);
  const maxDmg = Math.max(...damages);
  const others = damages.filter((d) => d !== maxDmg);
  if (others.length === 0) return false;
  const avgOther = others.reduce((a, b) => a + b, 0) / others.length;
  return maxDmg > avgOther * 1.5;
}

/** 辅助覆盖度：是否有治疗/护盾类角色 */
function computeSupportCoverage(
  profiles: readonly CharacterOutputProfile[],
): number {
  // 简化：DoT高且直伤低的角色更可能是辅助
  let supportScore = 0;
  for (const p of profiles) {
    const midDmg = p.rhythm.phaseDamage[1];
    const dot = p.rhythm.dotDamagePerRound;
    if (dot > 0 && midDmg < 2) {
      // 低直伤 + 有后台输出 = 可能是辅助
      supportScore += 0.5;
    }
  }
  return Math.min(1.0, supportScore);
}

// ─── helpers ────────────────────────────────────────────────

function getElementTag(profile: CharacterOutputProfile): string {
  const elementTags = new Set([
    "cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro",
  ]);
  for (const t of profile.tags) {
    if (elementTags.has(t)) return t;
  }
  return "unknown";
}
