import type { SkillPhaseValue, SkillProfile, SkillTrend } from "./types.js";

export function estimateSkillPhaseValue(
  skill: SkillProfile,
  context: PhaseEstimationContext,
): SkillPhaseValue | undefined {
  if (skill.type === "passive") return undefined;

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
  hasCrossCharacterInteraction: boolean;
  requiresReactionTrigger: boolean;
  hasStateMachine: boolean;
  hasDeferredBurst: boolean;
}

interface PhaseRule {
  early: number;
  mid: number;
  late: number;
  trend: SkillTrend;
  preconditions: string[];
}

function selectRule(skill: SkillProfile, ctx: PhaseEstimationContext): PhaseRule {
  if (ctx.hasDeferredBurst && skill.type === "burst") {
    return {
      early: 0.2, mid: 0.6, late: 1.0,
      trend: "ramp_up",
      preconditions: ["需要前置普攻/E积累层数"],
    };
  }

  if (skill.output.createsSummon) {
    return {
      early: 0.9, mid: 0.7, late: 0.5,
      trend: "decay",
      preconditions: [],
    };
  }

  if (skill.output.createsStatus && skill.type !== "burst") {
    return {
      early: 0.3, mid: 1.0, late: 0.5,
      trend: "spike_then_decay",
      preconditions: ["后续技能需要利用buff"],
    };
  }

  if (skill.type === "burst") {
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

  if (ctx.requiresReactionTrigger) {
    return {
      early: 0.8, mid: 1.0, late: 0.6,
      trend: "decay",
      preconditions: ["需要队友先挂元素"],
    };
  }

  if (ctx.hasStateMachine) {
    return {
      early: 0.4, mid: 1.0, late: 0.8,
      trend: "ramp_up",
      preconditions: ["需要姿态/状态切换"],
    };
  }

  return {
    early: 0.7, mid: 1.0, late: 0.8,
    trend: "stable",
    preconditions: [],
  };
}
