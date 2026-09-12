import type { Reaction } from "@gi-tcg/typings";

export interface SkillPhaseValue {
  readonly skillId: number;
  readonly earlyGame: number;
  readonly midGame: number;
  readonly lateGame: number;
  readonly trend: SkillTrend;
  readonly preconditions: readonly string[];
}

export type SkillTrend =
  | "ramp_up"
  | "stable"
  | "decay"
  | "spike_then_decay";

export interface SkillCost {
  readonly elementDice: number;
  readonly voidDice: number;
  readonly alignedDice: number;
  readonly energyCost: number;
  readonly totalDice: number;
}

export interface SummonProfile {
  readonly definitionId: number;
  readonly endPhaseDamage: number;
  readonly endPhaseDamageElement: DamageTypeValue;
  readonly duration: number;
}

export interface StatusProfile {
  readonly definitionId: number;
  readonly type: "status" | "combatStatus";
  readonly duration: number;
  readonly usage: number;
}

export interface AdditionalDamage {
  readonly type: DamageTypeValue;
  readonly value: number;
}

export interface SkillOutput {
  readonly mainDamageType: DamageTypeValue;
  readonly mainDamageValue: number;
  readonly additionalDamage: readonly AdditionalDamage[];
  readonly createsSummon: boolean;
  readonly summonProfile?: SummonProfile;
  readonly createsStatus: boolean;
  readonly statusProfile?: StatusProfile;
}

export interface SkillProfile {
  readonly definitionId: number;
  readonly type: "normal" | "elemental" | "burst" | "technique" | "passive";
  readonly cost: SkillCost;
  readonly output: SkillOutput;
  readonly gainEnergy: boolean;
  readonly isFast: boolean;
  readonly phaseValues?: SkillPhaseValue;
}

export interface RhythmProfile {
  readonly minBurstCycle: number;
  readonly burstCycleTotalDiceCost: number;
  readonly phaseDamage: readonly [number, number, number];
  readonly hasFastActionDamage: boolean;
  readonly hasDoTOutput: boolean;
  readonly dotDamagePerRound: number;
  readonly hasDeferredBurst: boolean;
}

export interface ResourceProfile {
  readonly primaryElement: DiceTypeValue;
  readonly idealDicePerRound: number;
  readonly hasSelfFunding: boolean;
}

export interface ComplexityProfile {
  readonly requiresSimulation: boolean;
  readonly conditionalBranchCount: number;
  readonly hasCrossCharacterInteraction: boolean;
  readonly requiresReactionTrigger: boolean;
  readonly hasStateMachine: boolean;
  readonly hasPhaseDependentValue: boolean;
}

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
  readonly strength: number;
  readonly needsSimulation: boolean;
}

export type DamageTypeValue = number;
export type DiceTypeValue = number;
export type ReactionValue = number;

export interface ElementalCompatibility {
  readonly possibleReactions: readonly ReactionValue[];
  readonly reactionTier: "S" | "A" | "B" | "C" | "none";
  readonly satisfiesTeamElementRequirement: boolean;
}

export interface CostCompatibility {
  readonly diceConflictRate: number;
  readonly minDiceForFullRotation: number;
  readonly canDualOutputInOneRound: boolean;
}

export interface TempoCompatibility {
  readonly burstStaggerScore: number;
  readonly gapComplementScore: number;
  readonly roleClarityScore: number;
  readonly switchCostBetween: number;
}

export interface PairCompatibility {
  readonly charA: number;
  readonly charB: number;
  readonly elemental: ElementalCompatibility;
  readonly cost: CostCompatibility;
  readonly tempo: TempoCompatibility;
}

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
    readonly burstStagger: number;
    readonly outputContinuity: number;
    readonly mainDpsIdentified: boolean;
    readonly supportCoverage: number;
  };
  readonly overallScore: number;
  readonly needsSimulationVerification: boolean;
  readonly simulationPriorityReasons: readonly string[];
}
