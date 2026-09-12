/**
 * Compatibility module types — supplements profiler/types.ts
 */

import type { ReactionValue } from "../profiler/types.js";

// ═══════════════════════════════════════════════════════════
//  Skill Chain Synergy (维度D)
// ═══════════════════════════════════════════════════════════

/** 技能链配合效率 — 评估角色A的技能能否被角色B利用 */
export interface SkillChainSynergy {
  readonly charA: number;
  readonly charB: number;
  /** 综合得分 0~1 */
  readonly score: number;
  /** 检测到的链模式（调试用） */
  readonly detectedPatterns: readonly string[];
}
