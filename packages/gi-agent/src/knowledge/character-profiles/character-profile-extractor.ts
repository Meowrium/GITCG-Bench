import type { GameData } from "@gi-tcg/core";
import type { CharacterDefinition } from "@gi-tcg/core/builder";
import { DiceType, DamageType } from "@gi-tcg/typings";
import type {
  CharacterOutputProfile,
  ComplexityProfile,
  DamageTypeValue,
  ResourceProfile,
  RhythmProfile,
  SkillCost,
  SkillOutput,
  SkillProfile,
} from "./types.js";
import {
  estimateSkillPhaseValue,
  type PhaseEstimationContext,
} from "./skill-phase-value-estimator.js";
import type { SourceComplexityInfo, SourceDamageInfo } from "./source-parser.js";

const ELEMENT_TAGS = new Set(["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"]);
const WEAPON_TAGS = new Set(["sword", "claymore", "pole", "catalyst", "bow", "otherWeapon"]);
const NATION_TAGS = new Set([
  "mondstadt", "liyue", "inazuma", "sumeru", "fontaine", "natlan",
  "nodkrai", "fatui", "eremite", "monster", "hilichurl", "sacread", "calamity",
]);

const TAG_TO_DAMAGE_TYPE: Record<string, DamageTypeValue> = {
  cryo: DamageType.Cryo,
  hydro: DamageType.Hydro,
  pyro: DamageType.Pyro,
  electro: DamageType.Electro,
  anemo: DamageType.Anemo,
  geo: DamageType.Geo,
  dendro: DamageType.Dendro,
};

const ELEMENT_DICE_TYPES = new Set([
  DiceType.Cryo, DiceType.Hydro, DiceType.Pyro, DiceType.Electro,
  DiceType.Anemo, DiceType.Geo, DiceType.Dendro,
]);

export class CharacterProfileExtractor {
  private readonly data: GameData;
  private sourceDamageCache: Map<number, SourceDamageInfo> | null = null;
  private sourceComplexityCache: Map<number, SourceComplexityInfo> | null = null;

  constructor(data: GameData) {
    this.data = data;
  }

  setSourceData(
    damageMap: Map<number, SourceDamageInfo>,
    complexityMap: Map<number, SourceComplexityInfo>,
  ): void {
    this.sourceDamageCache = damageMap;
    this.sourceComplexityCache = complexityMap;
  }

  extractAll(): CharacterOutputProfile[] {
    const profiles: CharacterOutputProfile[] = [];
    for (const [, charDef] of this.data.characters) {
      profiles.push(this.extractOne(charDef));
    }
    return profiles;
  }

  extractOne(charDef: CharacterDefinition): CharacterOutputProfile {
    const tags = charDef.tags as readonly string[];
    const element = this.extractElement(tags);
    const weapon = this.extractWeapon(tags);
    const nation = this.extractNation(tags);
    const varConfigs = charDef.varConfigs as Record<string, { initialValue?: number }>;
    const health = varConfigs.maxHealth?.initialValue ?? 10;
    const maxEnergy = varConfigs.maxEnergy?.initialValue ?? 0;

    const skills = this.extractSkills(charDef);
    const complexity = this.extractComplexity(charDef);
    const rhythm = this.computeRhythm(skills, maxEnergy, complexity);
    const resourceProfile = this.computeResourceProfile(skills, element);

    return {
      definitionId: charDef.id,
      tags,
      base: { element, weapon, nation, health, maxEnergy },
      skills,
      rhythm,
      resourceProfile,
      complexity,
    };
  }

  private extractSkills(charDef: CharacterDefinition): SkillProfile[] {
    const profiles: SkillProfile[] = [];

    for (const skillDef of charDef.skills) {
      const cfg = (skillDef as unknown as { initiativeSkillConfig?: object }).initiativeSkillConfig;
      if (!cfg) {
        profiles.push(this.makePassiveSkillProfile(skillDef.id));
        continue;
      }

      const initiativeSkill = skillDef as unknown as {
        initiativeSkillConfig: {
          readonly requiredCost: ReadonlyMap<number, number>;
          readonly gainEnergy: boolean;
          readonly shouldFast: boolean;
          readonly skillType: string;
        };
      };
      const config = initiativeSkill.initiativeSkillConfig;
      profiles.push({
        definitionId: skillDef.id,
        type: this.mapSkillType(config.skillType),
        cost: this.extractCost(config.requiredCost),
        output: this.extractOutput(skillDef.id),
        gainEnergy: config.gainEnergy,
        isFast: config.shouldFast,
      });
    }

    return profiles;
  }

  private makePassiveSkillProfile(id: number): SkillProfile {
    return {
      definitionId: id,
      type: "passive",
      cost: { elementDice: 0, voidDice: 0, alignedDice: 0, energyCost: 0, totalDice: 0 },
      output: {
        mainDamageType: 0,
        mainDamageValue: 0,
        additionalDamage: [],
        createsSummon: false,
        createsStatus: false,
      },
      gainEnergy: false,
      isFast: false,
    };
  }

  private extractCost(requiredCost: ReadonlyMap<number, number>): SkillCost {
    let elementDice = 0;
    let voidDice = 0;
    let alignedDice = 0;
    let energyCost = 0;

    for (const [diceType, count] of requiredCost) {
      if (diceType === DiceType.Energy) {
        energyCost = count;
      } else if (diceType === DiceType.Void) {
        voidDice = count;
      } else if (diceType === 8) {
        alignedDice = count;
      } else if (ELEMENT_DICE_TYPES.has(diceType)) {
        elementDice += count;
      }
    }

    return {
      elementDice,
      voidDice,
      alignedDice,
      energyCost,
      totalDice: elementDice + voidDice + alignedDice,
    };
  }

  private extractOutput(skillId: number): SkillOutput {
    const srcDamage = this.sourceDamageCache?.get(skillId);
    if (srcDamage) {
      return {
        mainDamageType: srcDamage.mainDamageType,
        mainDamageValue: srcDamage.mainDamageValue,
        additionalDamage: srcDamage.additionalDamage,
        createsSummon: srcDamage.createsSummon,
        summonProfile: srcDamage.summonProfile,
        createsStatus: srcDamage.createsStatus,
      };
    }

    return {
      mainDamageType: DamageType.Physical,
      mainDamageValue: 0,
      additionalDamage: [],
      createsSummon: false,
      createsStatus: false,
    };
  }

  private extractComplexity(charDef: CharacterDefinition): ComplexityProfile {
    const srcInfo = this.sourceComplexityCache?.get(charDef.id);
    const conditionalBranchCount = srcInfo?.ifCount ?? 0;
    const hasCrossCharacterInteraction = srcInfo?.hasCrossCharInteraction ?? false;
    const hasStateMachine = srcInfo?.hasStateMachine ?? false;
    const requiresReactionTrigger = srcInfo?.requiresReactionTrigger ?? false;
    const hasDeferredBurst = srcInfo?.hasDeferredBurst ?? false;

    return {
      requiresSimulation:
        conditionalBranchCount > 3 || hasCrossCharacterInteraction || hasStateMachine,
      conditionalBranchCount,
      hasCrossCharacterInteraction,
      requiresReactionTrigger,
      hasStateMachine,
      hasPhaseDependentValue:
        hasDeferredBurst || hasStateMachine || requiresReactionTrigger || hasCrossCharacterInteraction,
    };
  }

  private computeRhythm(
    skills: SkillProfile[],
    maxEnergy: number,
    complexity: ComplexityProfile,
  ): RhythmProfile {
    const burst = skills.find((s) => s.type === "burst");
    const generators = skills.filter((s) => s.gainEnergy && s.type !== "burst" && s.type !== "passive");

    let minBurstCycle = Infinity;
    let burstCycleTotalDiceCost = 0;

    if (burst && generators.length > 0 && maxEnergy > 0) {
      const turnsToCharge = maxEnergy;
      minBurstCycle = turnsToCharge + 1;
      const cheapest = generators.reduce((a, b) => a.cost.totalDice <= b.cost.totalDice ? a : b);
      burstCycleTotalDiceCost = cheapest.cost.totalDice * turnsToCharge + burst.cost.totalDice;
    }

    const combatSkills = skills.filter((s) => s.type !== "passive" && !s.isFast);
    const avgDamage =
      combatSkills.length > 0
        ? combatSkills.reduce(
            (sum, s) => sum + s.output.mainDamageValue + s.output.additionalDamage.reduce((a, d) => a + d.value, 0),
            0,
          ) / combatSkills.length
        : 0;

    const ctx: PhaseEstimationContext = {
      hasCrossCharacterInteraction: complexity.hasCrossCharacterInteraction,
      requiresReactionTrigger: complexity.requiresReactionTrigger,
      hasStateMachine: complexity.hasStateMachine,
      hasDeferredBurst: complexity.hasPhaseDependentValue,
    };

    const phaseMultipliers = this.estimatePhaseMultipliers(skills, ctx);
    const dotSkills = skills.filter((s) => s.output.createsSummon && s.output.summonProfile);

    return {
      minBurstCycle,
      burstCycleTotalDiceCost,
      phaseDamage: [
        Math.round(avgDamage * phaseMultipliers[0] * 10) / 10,
        Math.round(avgDamage * phaseMultipliers[1] * 10) / 10,
        Math.round(avgDamage * phaseMultipliers[2] * 10) / 10,
      ],
      hasFastActionDamage: skills.some((s) => s.isFast && s.output.mainDamageValue > 0),
      hasDoTOutput: dotSkills.length > 0,
      dotDamagePerRound: dotSkills.reduce((sum, s) => sum + (s.output.summonProfile?.endPhaseDamage ?? 0), 0),
      hasDeferredBurst: complexity.hasPhaseDependentValue && skills.some((s) => s.output.createsSummon),
    };
  }

  private estimatePhaseMultipliers(
    skills: SkillProfile[],
    ctx: PhaseEstimationContext,
  ): [number, number, number] {
    const combatSkills = skills.filter((s) => s.type !== "passive");
    if (combatSkills.length === 0) return [1, 1, 1];

    let earlySum = 0;
    let midSum = 0;
    let lateSum = 0;
    let count = 0;

    for (const sk of combatSkills) {
      const phaseVal = estimateSkillPhaseValue(sk, ctx);
      if (phaseVal) {
        earlySum += phaseVal.earlyGame;
        midSum += phaseVal.midGame;
        lateSum += phaseVal.lateGame;
        count++;
      }
    }

    if (count === 0) return [1, 1, 1];
    return [earlySum / count, midSum / count, lateSum / count];
  }

  private computeResourceProfile(skills: SkillProfile[], charElement: DamageTypeValue): ResourceProfile {
    const combatSkills = skills.filter((s) => s.type !== "passive");
    const nonBurst = combatSkills.filter((s) => s.type !== "burst");
    return {
      primaryElement: charElement,
      idealDicePerRound: nonBurst.length > 0 ? Math.max(...nonBurst.map((s) => s.cost.totalDice)) : 0,
      hasSelfFunding: false,
    };
  }

  private extractElement(tags: readonly string[]): DamageTypeValue {
    for (const t of tags) {
      if (ELEMENT_TAGS.has(t)) return TAG_TO_DAMAGE_TYPE[t] ?? DamageType.Physical;
    }
    return DamageType.Physical;
  }

  private extractWeapon(tags: readonly string[]): string {
    for (const t of tags) {
      if (WEAPON_TAGS.has(t)) return t;
    }
    return "otherWeapon";
  }

  private extractNation(tags: readonly string[]): string {
    for (const t of tags) {
      if (NATION_TAGS.has(t)) return t;
    }
    return "unknown";
  }

  private mapSkillType(engineType: string): "normal" | "elemental" | "burst" | "technique" {
    switch (engineType) {
      case "normal": return "normal";
      case "elemental": return "elemental";
      case "burst": return "burst";
      case "technique": return "technique";
      default: return "normal";
    }
  }
}
