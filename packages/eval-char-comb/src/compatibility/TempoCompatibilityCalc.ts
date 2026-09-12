/**
 * TempoCompatibilityCalc
 *
 * 计算两角色之间的节奏兼容性。
 *
 * 核心修正（review.md §1）：
 *   burstSyncScore → burstStaggerScore
 *   高分 = 爆发周期互补错开（正面信号）
 *   同步蓄Q是骰子黑洞，应为负面信号
 */

import type {
  TempoCompatibility,
  CharacterOutputProfile,
} from "../profiler/types.js";

/**
 * 计算两角色之间的节奏兼容性。
 */
export function computeTempoCompatibility(
  profileA: CharacterOutputProfile,
  profileB: CharacterOutputProfile,
): TempoCompatibility {
  return {
    burstStaggerScore: computeBurstStagger(profileA, profileB),
    gapComplementScore: computeGapComplement(profileA, profileB),
    roleClarityScore: computeRoleClarity(profileA, profileB),
    switchCostBetween: 1, // 切人固定消耗 1 骰（快速行动）
  };
}

// ─── burstStaggerScore（核心修正）──────────────────────────

/**
 * 爆发周期错开度。
 *
 * 逻辑（review.md §1）：
 * - cA == cB → 不再直接给 0.0，用 phaseDamage 差异补充区分
 * - |cA - cB| == 1 → 0.5（部分错开）
 * - |cA - cB| >= 2 → 0.8（自然错开）
 * - 有一方无爆发（Infinity）→ 1.0（无冲突）
 */
function computeBurstStagger(
  a: CharacterOutputProfile,
  b: CharacterOutputProfile,
): number {
  const cA = a.rhythm.minBurstCycle;
  const cB = b.rhythm.minBurstCycle;

  // 一方没有爆发 → 无周期冲突
  if (!isFinite(cA) || !isFinite(cB)) return 1.0;

  const diff = Math.abs(cA - cB);

  if (diff >= 2) return 0.8; // 差两回合以上
  if (diff === 1) return 0.5; // 差一回合

  // diff === 0：同回合蓄满Q
  // 用中期伤害差异补充：伤害差距大 → 主C/辅助分工明确 → 错开爆发节奏有策略意义
  const midDmgA = a.rhythm.phaseDamage[1];
  const midDmgB = b.rhythm.phaseDamage[1];
  const maxDmg = Math.max(midDmgA, midDmgB);
  const minDmg = Math.min(midDmgA, midDmgB);
  if (maxDmg > 0 && maxDmg !== minDmg) {
    const ratio = minDmg / maxDmg;
    // 比例越低（分工越明确），错开的策略意义越大，给分越高
    // ratio=0.3 → 0.4, ratio=0.7 → 0.15
    return Math.max(0.1, Math.min(0.4, 0.5 * ratio));
  }
  return 0.1; // 完全相同角色 → 同步爆发是最差情况
}

// ─── gapComplementScore ─────────────────────────────────────

/**
 * 输出空隙互补度。
 *
 * A是后台输出（DoT高 / 快速行动）时B可前台输出，反之亦然。
 */
function computeGapComplement(
  a: CharacterOutputProfile,
  b: CharacterOutputProfile,
): number {
  const aIsBackgroundOutput = a.rhythm.hasDoTOutput || a.rhythm.hasFastActionDamage;
  const bIsBackgroundOutput = b.rhythm.hasDoTOutput || b.rhythm.hasFastActionDamage;

  // 一前台一后台 → 互补
  if (aIsBackgroundOutput !== bIsBackgroundOutput) return 0.9;

  // 都是后台 → 缺前台主C
  if (aIsBackgroundOutput && bIsBackgroundOutput) return 0.3;

  // 都是前台 → 会争抢出场时间
  return 0.5;
}

// ─── roleClarityScore ───────────────────────────────────────

/**
 * 前台/后台分工清晰度。
 *
 * 基于每战斗行动伤害密度和 DoT 占比判断。
 */
function computeRoleClarity(
  a: CharacterOutputProfile,
  b: CharacterOutputProfile,
): number {
  // 用中期伤害（phaseDamage[1]）作为主要指标
  const aMidDmg = a.rhythm.phaseDamage[1];
  const bMidDmg = b.rhythm.phaseDamage[1];
  const aDoT = a.rhythm.dotDamagePerRound;
  const bDoT = b.rhythm.dotDamagePerRound;

  // 一方明显是主C（高直伤低DoT），另一方是辅助（低直伤高DoT）
  const aMainDps = aMidDmg > bMidDmg * 1.3;
  const bMainDps = bMidDmg > aMidDmg * 1.3;
  const aSupport = aDoT > aMidDmg * 0.5;
  const bSupport = bDoT > bMidDmg * 0.5;

  if ((aMainDps && bSupport) || (bMainDps && aSupport)) return 0.9;
  if (aMainDps || bMainDps) return 0.7;
  if (aSupport || bSupport) return 0.6;

  // 都差不多 → 分工不清晰
  return 0.4;
}

// ─── 三角色聚合 ─────────────────────────────────────────────

/**
 * 计算三角色的爆发错开度。
 * 理想：A→B→C 流水线轮流爆发。
 */
export function computeTripleBurstStagger(
  profiles: readonly [CharacterOutputProfile, CharacterOutputProfile, CharacterOutputProfile],
): number {
  const [a, b, c] = profiles;
  const ab = computeBurstStagger(a, b);
  const ac = computeBurstStagger(a, c);
  const bc = computeBurstStagger(b, c);
  return (ab + ac + bc) / 3;
}
