/**
 * 技能阶段收益估值器
 *
 * 基于 eval-char-comb-review.md §2 的启发式规则：
 * 按技能类型分基准曲线 + 按元素反应依赖修正
 */

import type { SkillPhaseValue, SkillProfile, SkillTrend } from "./types.js";

/**
 * 根据技能特征推断其三阶段收益分布。
 *
 * 返回 SkillPhaseValue，或 undefined（被动技能无法估值）。
 */
export function estimateSkillPhaseValue(
  skill: SkillProfile,
  context: PhaseEstimationContext,
): SkillPhaseValue | undefined {
  if (skill.type === "passive") return undefined;

  // 按优先级匹配规则
  const rule = selectRule(skill, context);

  return {
    skillId: skill.definitionId,
    earlyGame: rule.early,
    midGame: rule.mid,
    lateGame: rule.late,
    trend: rule.trend,
    preconditions: rule.preconditions,
  };
}

export interface PhaseEstimationContext {
  /** 角色是否有跨角色交互 */
  hasCrossCharacterInteraction: boolean;
  /** 角色是否依赖元素反应 */
  requiresReactionTrigger: boolean;
  /** 角色是否有状态机 */
  hasStateMachine: boolean;
  /** 角色是否有延迟爆发 */
  hasDeferredBurst: boolean;
}

interface PhaseRule {
  early: number;
  mid: number;
  late: number;
  trend: SkillTrend;
  preconditions: string[];
}

function selectRule(
  skill: SkillProfile,
  ctx: PhaseEstimationContext,
): PhaseRule {
  // 1. 延迟爆发类（优菈光降之剑）
  if (ctx.hasDeferredBurst && skill.type === "burst") {
    return {
      early: 0.2, mid: 0.6, late: 1.0,
      trend: "ramp_up",
      preconditions: ["需要前置普攻/E积累层数"],
    };
  }

  // 2. 召唤物技能 — 越早放运作时间越长
  if (skill.output.createsSummon) {
    return {
      early: 0.9, mid: 0.7, late: 0.5,
      trend: "decay",
      preconditions: [],
    };
  }

  // 3. 创建增伤/持续战斗状态
  if (skill.output.createsStatus && skill.type !== "burst") {
    return {
      early: 0.3, mid: 1.0, late: 0.5,
      trend: "spike_then_decay",
      preconditions: ["后续技能需要利用buff"],
    };
  }

  // 4. 元素爆发
  if (skill.type === "burst") {
    // 爆发一般中期价值最高
    if (ctx.requiresReactionTrigger) {
      return {
        early: 0.2, mid: 1.0, late: 0.7,
        trend: "spike_then_decay",
        preconditions: ["需要后台元素附着配合"],
      };
    }
    return {
      early: 0.3, mid: 1.0, late: 0.8,
      trend: "spike_then_decay",
      preconditions: [],
    };
  }

  // 5. 依赖反应的固定伤害技能
  if (ctx.requiresReactionTrigger) {
    return {
      early: 0.8, mid: 1.0, late: 0.6,
      trend: "decay",
      preconditions: ["需要队友先挂元素"],
    };
  }

  // 6. 有状态机的角色（达达利亚姿态切换等）— 中期收益最高
  if (ctx.hasStateMachine) {
    return {
      early: 0.4, mid: 1.0, late: 0.8,
      trend: "ramp_up",
      preconditions: ["需要姿态/状态切换"],
    };
  }

  // 7. 默认：稳定型（如普通攻击、简单元素战技）
  return {
    early: 0.7, mid: 1.0, late: 0.8,
    trend: "stable",
    preconditions: [],
  };
}
