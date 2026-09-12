/**
 * eval-char-comb 类型定义
 *
 * 整合 eval-char-comb.md + eval-char-comb-review.md 的修正：
 * - burstSyncScore → burstStaggerScore（爆发周期错开度）
 * - rawDamagePerCombatAction → phaseDamage[3]（三阶段收益模型）
 * - 新增 SkillPhaseValue / hasPhaseDependentValue
 */

import type { DamageType, DiceType, Reaction } from "@gi-tcg/typings";
import type { CharacterTag } from "@gi-tcg/core/builder";

// ═══════════════════════════════════════════════════════════
//  Phase A: Character Output Profile
// ═══════════════════════════════════════════════════════════

/** 技能阶段收益模型（review.md §2 修正） */
export interface SkillPhaseValue {
  readonly skillId: number;
  /** 回合 1-3：相对于最大可能收益的百分比 0~1 */
  readonly earlyGame: number;
  /** 回合 4-6 */
  readonly midGame: number;
  /** 回合 7+ */
  readonly lateGame: number;
  /** 收益随回合的变化趋势 */
  readonly trend: SkillTrend;
  /** 收益高度依赖的前置条件（标记不可靠阶段） */
  readonly preconditions: readonly string[];
}

export type SkillTrend =
  | "ramp_up"
  | "stable"
  | "decay"
  | "spike_then_decay";

/** 技能费用 */
export interface SkillCost {
  readonly elementDice: number;
  readonly voidDice: number;
  readonly alignedDice: number;
  readonly energyCost: number;
  readonly totalDice: number;
}

/** 召唤物概要 */
export interface SummonProfile {
  readonly definitionId: number;
  readonly endPhaseDamage: number;
  readonly endPhaseDamageElement: DamageTypeValue;
  readonly duration: number;
}

/** 状态概要 */
export interface StatusProfile {
  readonly definitionId: number;
  readonly type: "status" | "combatStatus";
  readonly duration: number;
  readonly usage: number;
  /** 是否在队友行动时触发（如琉金火光：非宵宫角色使用技能后） */
  readonly teammateTriggerable?: boolean;
}

/** 附带伤害 */
export interface AdditionalDamage {
  readonly type: DamageTypeValue;
  readonly value: number;
}

/** 技能输出 */
export interface SkillOutput {
  readonly mainDamageType: DamageTypeValue;
  readonly mainDamageValue: number;
  readonly additionalDamage: readonly AdditionalDamage[];
  readonly createsSummon: boolean;
  readonly summonProfile?: SummonProfile;
  readonly createsStatus: boolean;
  readonly statusProfile?: StatusProfile;
}

/** 技能档案 */
export interface SkillProfile {
  readonly definitionId: number;
  readonly type: "normal" | "elemental" | "burst" | "technique" | "passive";
  readonly cost: SkillCost;
  readonly output: SkillOutput;
  readonly gainEnergy: boolean;
  readonly isFast: boolean;
  /** 阶段收益估值（review.md §2） */
  readonly phaseValues?: SkillPhaseValue;
}

/** 角色固有输出节奏 */
export interface RhythmProfile {
  /** 最小爆发周期：0充能→满充能释放Q需要的最少战斗行动数 */
  readonly minBurstCycle: number;
  /** 最小爆发周期所需总骰子成本 */
  readonly burstCycleTotalDiceCost: number;
  /** 三阶段每战斗行动伤害估值 [early, mid, late]（review.md 修正） */
  readonly phaseDamage: readonly [number, number, number];
  /** 是否有快速行动输出能力 */
  readonly hasFastActionDamage: boolean;
  /** 是否有持续伤害（召唤物/状态） */
  readonly hasDoTOutput: boolean;
  /** 持续伤害每回合期望值 */
  readonly dotDamagePerRound: number;
  /** 是否有延迟爆发（如优菈光降之剑） */
  readonly hasDeferredBurst: boolean;
}

/** 资源消耗特征 */
export interface ResourceProfile {
  /** 主要消耗元素（占比最高的骰子颜色） */
  readonly primaryElement: DiceTypeValue;
  /** 每回合理想消耗骰子数（满操作） */
  readonly idealDicePerRound: number;
  /** 是否有自产骰/减费能力 */
  readonly hasSelfFunding: boolean;
}

/** 复杂度标记 */
export interface ComplexityProfile {
  /** 是否需要模拟才能准确评估 */
  readonly requiresSimulation: boolean;
  /** 运行时条件分支数（.if() 中的分支） */
  readonly conditionalBranchCount: number;
  /** 是否有跨角色交互 */
  readonly hasCrossCharacterInteraction: boolean;
  /** 是否依赖元素反应触发 */
  readonly requiresReactionTrigger: boolean;
  /** 是否有状态机（姿态切换等） */
  readonly hasStateMachine: boolean;
  /** 技能收益是否随阶段显著变化（review.md 修正） */
  readonly hasPhaseDependentValue: boolean;
}

/** 角色输出档案 — Phase A 的核心产出 */
export interface CharacterOutputProfile {
  readonly definitionId: number;
  readonly tags: readonly string[];

  readonly base: {
    readonly element: DamageTypeValue;
    readonly weapon: string;
    readonly nation: string;
    readonly health: number;
    readonly maxEnergy: number;
  };

  readonly skills: readonly SkillProfile[];
  readonly rhythm: RhythmProfile;
  readonly resourceProfile: ResourceProfile;
  readonly complexity: ComplexityProfile;
}

// ═══════════════════════════════════════════════════════════
//  Phase B: Compatibility Matrix
// ═══════════════════════════════════════════════════════════

/** 元素兼容性（维度A） */
export interface ElementalCompatibility {
  readonly possibleReactions: readonly ReactionValue[];
  /** S=蒸发/融化 A=感电/超载/冻结 B=扩散/结晶/绽放/燃烧/超激化 C=无有效反应 */
  readonly reactionTier: "S" | "A" | "B" | "C" | "none";
  readonly satisfiesTeamElementRequirement: boolean;
}

/** 费用兼容性（维度B） */
export interface CostCompatibility {
  /** 骰子需求重叠度 0=完全互补, 1=完全重叠 */
  readonly diceConflictRate: number;
  /** 两角色同时满操作需要的最少骰子总量 */
  readonly minDiceForFullRotation: number;
  /** 8骰是否够两角色同时操作一次 */
  readonly canDualOutputInOneRound: boolean;
}

/** 节奏兼容性（维度C）— 含 review.md §1 修正 */
export interface TempoCompatibility {
  /** 爆发周期错开度：0~1, 1=完美错开（正面信号）— 修正自 burstSyncScore */
  readonly burstStaggerScore: number;
  /** 输出空隙互补度 */
  readonly gapComplementScore: number;
  /** 前台/后台分工清晰度 */
  readonly roleClarityScore: number;
  /** 切人成本 */
  readonly switchCostBetween: number;
}

/** 两两兼容性 */
export interface PairCompatibility {
  readonly charA: number;
  readonly charB: number;
  readonly elemental: ElementalCompatibility;
  readonly cost: CostCompatibility;
  readonly tempo: TempoCompatibility;
  readonly skillChainSynergy?: import("../compatibility/types.js").SkillChainSynergy;
}

/** 三角色牌组兼容性评分 */
export interface DeckCompatibilityScore {
  readonly characters: readonly [number, number, number];

  readonly elemental: {
    readonly reactionCoverage: number;
    readonly teamElementSatisfaction: number;
  };

  readonly cost: {
    readonly overallDiceConflict: number;
    readonly elementDiversity: number;
    readonly canTwoCharacterRound: boolean;
  };

  readonly tempo: {
    /** 三角色爆发错开度（review.md §1 修正） */
    readonly burstStagger: number;
    readonly outputContinuity: number;
    readonly mainDpsIdentified: boolean;
    readonly supportCoverage: number;
  };

  readonly skillChain: {
    readonly score: number;
  };

  readonly overallScore: number;
  readonly needsSimulationVerification: boolean;
  readonly simulationPriorityReasons: readonly string[];
}

// ═══════════════════════════════════════════════════════════
//  Phase C: Card-Character Affinity
// ═══════════════════════════════════════════════════════════

export type CardAffinityType =
  | "talent"
  | "weapon_match"
  | "element_match"
  | "artifact_match"
  | "cost_reduction"
  | "damage_buff"
  | "reaction_synergy"
  | "none";

export interface CardCharacterAffinity {
  readonly cardDefinitionId: number;
  readonly characterDefinitionId: number;
  readonly affinityType: CardAffinityType;
  /** 相性强度 0~1 */
  readonly strength: number;
  readonly needsSimulation: boolean;
}

// ═══════════════════════════════════════════════════════════
//  Value type aliases (for readability — actual values are numbers)
// ═══════════════════════════════════════════════════════════

/** DamageType 的值类型（0=Physical, 1=Cryo, ..., 9=Heal） */
export type DamageTypeValue = number;

/** DiceType 的值类型（0=Void, 1=Cryo, ..., 9=Energy） */
export type DiceTypeValue = number;

/** Reaction 的值类型 */
export type ReactionValue = number;
