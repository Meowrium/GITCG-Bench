/**
 * CharacterProfileExtractor
 *
 * 从 @gi-tcg/data 的 GameData 中提取所有角色的 CharacterOutputProfile。
 *
 * 策略：
 * - 费用、技能类型、充能等 → 直接从 SkillDefinition.initiativeSkillConfig 读取
 * - 伤害值 → 从源码文件做正则解析（builder DSL 的 .damage() 调用）
 * - 召唤物信息 → 从 EntityDefinition 的 hintText + varConfigs 推断
 * - 复杂度 → 从源码文件统计 .if() / .do() / .on() 调用
 */

import type { GameData } from "@gi-tcg/core";
import type {
  CharacterDefinition,
  InitiativeSkillDefinition,
  EntityDefinition,
} from "@gi-tcg/core/builder";
import { DiceType, DamageType } from "@gi-tcg/typings";
import type {
  CharacterOutputProfile,
  ComplexityProfile,
  DamageTypeValue,
  DiceTypeValue,
  ResourceProfile,
  RhythmProfile,
  SkillCost,
  SkillOutput,
  SkillProfile,
  SummonProfile,
  StatusProfile,
} from "./types.js";
import {
  estimateSkillPhaseValue,
  type PhaseEstimationContext,
} from "./SkillPhaseValueEstimator.js";
import {
  parseSkillDamageFromSource,
  parseComplexityFromSource,
  type SourceDamageInfo,
  type SourceComplexityInfo,
} from "./SourceParser.js";

// ─── element classification ───────────────────────────────

const ELEMENT_TAGS = new Set([
  "cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro",
]);
const WEAPON_TAGS = new Set([
  "sword", "claymore", "pole", "catalyst", "bow", "otherWeapon",
]);
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

const TAG_TO_DICE_TYPE: Record<string, DiceTypeValue> = {
  cryo: DiceType.Cryo,
  hydro: DiceType.Hydro,
  pyro: DiceType.Pyro,
  electro: DiceType.Electro,
  anemo: DiceType.Anemo,
  geo: DiceType.Geo,
  dendro: DiceType.Dendro,
};

// ─── element dice types (value 1-7) ──────────────────────

const ELEMENT_DICE_TYPES = new Set([
  DiceType.Cryo, DiceType.Hydro, DiceType.Pyro, DiceType.Electro,
  DiceType.Anemo, DiceType.Geo, DiceType.Dendro,
]);

// ═════════════════════════════════════════════════════════════
//  Main extractor
// ═════════════════════════════════════════════════════════════

export class CharacterProfileExtractor {
  private readonly data: GameData;
  /** 源码解析缓存：skillId → damage info */
  private sourceDamageCache: Map<number, SourceDamageInfo> | null = null;
  /** 源码解析缓存：角色文件 → complexity info */
  private sourceComplexityCache: Map<number, SourceComplexityInfo> | null = null;

  constructor(data: GameData) {
    this.data = data;
  }

  /**
   * 批量设置源码解析数据。
   * 调用 SourceParser.parseAllCharacterSources() 的结果传入此处。
   */
  setSourceData(
    damageMap: Map<number, SourceDamageInfo>,
    complexityMap: Map<number, SourceComplexityInfo>,
  ): void {
    this.sourceDamageCache = damageMap;
    this.sourceComplexityCache = complexityMap;
  }

  /** 提取所有角色档案 */
  extractAll(): CharacterOutputProfile[] {
    const profiles: CharacterOutputProfile[] = [];
    for (const [, charDef] of this.data.characters) {
      profiles.push(this.extractOne(charDef));
    }
    return profiles;
  }

  /** 提取单个角色档案 */
  extractOne(charDef: CharacterDefinition): CharacterOutputProfile {
    const tags = charDef.tags as readonly string[];
    const element = this.extractElement(tags);
    const weapon = this.extractWeapon(tags);
    const nation = this.extractNation(tags);
    const health = (charDef.varConfigs as any).maxHealth?.initialValue ?? 10;
    const maxEnergy = (charDef.varConfigs as any).maxEnergy?.initialValue ?? 0;

    const skills = this.extractSkills(charDef);
    const complexity = this.extractComplexity(charDef, skills);
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

  // ─── skill extraction ─────────────────────────────────────

  private extractSkills(charDef: CharacterDefinition): SkillProfile[] {
    const profiles: SkillProfile[] = [];

    for (const skillDef of charDef.skills) {
      const cfg = (skillDef as any).initiativeSkillConfig;
      if (!cfg) {
        // 被动技能 — 记录但标记为 passive
        profiles.push(this.makePassiveSkillProfile(skillDef.id));
        continue;
      }

      const initiativeSkill = skillDef as InitiativeSkillDefinition;
      const config = initiativeSkill.initiativeSkillConfig;
      const cost = this.extractCost(config.requiredCost);
      const output = this.extractOutput(skillDef.id);
      const skillType = this.mapSkillType(config.skillType, skillDef.id);

      profiles.push({
        definitionId: skillDef.id,
        type: skillType,
        cost,
        output,
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
      } else if (diceType === (DiceType as any).Aligned || diceType === 8) {
        // Aligned = 同色骰 (value 8)
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
        statusProfile: srcDamage.statusProfile,
      };
    }

    // fallback: 无源码数据时返回零值
    return {
      mainDamageType: DamageType.Physical,
      mainDamageValue: 0,
      additionalDamage: [],
      createsSummon: false,
      createsStatus: false,
    };
  }

  // ─── complexity ───────────────────────────────────────────

  private extractComplexity(
    charDef: CharacterDefinition,
    skills: SkillProfile[],
  ): ComplexityProfile {
    const srcInfo = this.sourceComplexityCache?.get(charDef.id);

    const conditionalBranchCount = srcInfo?.ifCount ?? 0;
    const hasCrossCharacterInteraction = srcInfo?.hasCrossCharInteraction ?? false;
    const hasStateMachine = srcInfo?.hasStateMachine ?? false;
    const requiresReactionTrigger = srcInfo?.requiresReactionTrigger ?? false;

    // 有延迟爆发的检测：召唤物中 autoDispose: false 或 usage(0)
    const hasDeferredBurst = srcInfo?.hasDeferredBurst ?? false;

    const hasPhaseDependentValue =
      hasDeferredBurst ||
      hasStateMachine ||
      requiresReactionTrigger ||
      hasCrossCharacterInteraction;

    const requiresSimulation =
      conditionalBranchCount > 3 ||
      hasCrossCharacterInteraction ||
      hasStateMachine;

    return {
      requiresSimulation,
      conditionalBranchCount,
      hasCrossCharacterInteraction,
      requiresReactionTrigger,
      hasStateMachine,
      hasPhaseDependentValue,
    };
  }

  // ─── rhythm computation ──────────────────────────────────

  private computeRhythm(
    skills: SkillProfile[],
    maxEnergy: number,
    complexity: ComplexityProfile,
  ): RhythmProfile {
    const burst = skills.find((s) => s.type === "burst");
    const generators = skills.filter(
      (s) => s.gainEnergy && s.type !== "burst" && s.type !== "passive",
    );

    let minBurstCycle = Infinity;
    let burstCycleTotalDiceCost = 0;

    if (burst && generators.length > 0 && maxEnergy > 0) {
      // 每个产能技能每次使用给 1 充能
      const turnsToCharge = maxEnergy; // 需要使用 maxEnergy 次产能技能
      minBurstCycle = turnsToCharge + 1; // +1 for the burst itself

      // 选成本最低的产能技能来计算最小费用
      const cheapest = generators.reduce((a, b) =>
        a.cost.totalDice <= b.cost.totalDice ? a : b,
      );
      burstCycleTotalDiceCost =
        cheapest.cost.totalDice * turnsToCharge + burst.cost.totalDice;
    }

    // 只统计主动非被动技能
    const combatSkills = skills.filter(
      (s) => s.type !== "passive" && !s.isFast,
    );
    const avgDamage =
      combatSkills.length > 0
        ? combatSkills.reduce(
            (sum, s) =>
              sum +
              s.output.mainDamageValue +
              s.output.additionalDamage.reduce((a, d) => a + d.value, 0),
            0,
          ) / combatSkills.length
        : 0;

    // 估算三阶段伤害
    const ctx: PhaseEstimationContext = {
      hasCrossCharacterInteraction: complexity.hasCrossCharacterInteraction,
      requiresReactionTrigger: complexity.requiresReactionTrigger,
      hasStateMachine: complexity.hasStateMachine,
      hasDeferredBurst: complexity.hasPhaseDependentValue,
    };

    const phaseMultipliers = this.estimatePhaseMultipliers(skills, ctx);
    const phaseDamage: [number, number, number] = [
      Math.round(avgDamage * phaseMultipliers[0] * 10) / 10,
      Math.round(avgDamage * phaseMultipliers[1] * 10) / 10,
      Math.round(avgDamage * phaseMultipliers[2] * 10) / 10,
    ];

    // DoT: 检查是否有创建召唤物的技能
    const dotSkills = skills.filter((s) => s.output.createsSummon && s.output.summonProfile);
    const dotPerRound = dotSkills.reduce(
      (sum, s) => sum + (s.output.summonProfile?.endPhaseDamage ?? 0),
      0,
    );

    return {
      minBurstCycle,
      burstCycleTotalDiceCost,
      phaseDamage,
      hasFastActionDamage: skills.some(
        (s) => s.isFast && s.output.mainDamageValue > 0,
      ),
      hasDoTOutput: dotSkills.length > 0,
      dotDamagePerRound: dotPerRound,
      hasDeferredBurst: complexity.hasPhaseDependentValue &&
        skills.some((s) => s.output.createsSummon),
    };
  }

  /**
   * 基于技能的阶段收益估值，汇总角色级别的三阶段伤害倍率
   */
  private estimatePhaseMultipliers(
    skills: SkillProfile[],
    ctx: PhaseEstimationContext,
  ): [number, number, number] {
    const combatSkills = skills.filter(
      (s) => s.type !== "passive",
    );

    if (combatSkills.length === 0) return [1, 1, 1];

    let earlySum = 0, midSum = 0, lateSum = 0;
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

    return [
      earlySum / count,
      midSum / count,
      lateSum / count,
    ];
  }

  // ─── resource profile ─────────────────────────────────────

  private computeResourceProfile(
    skills: SkillProfile[],
    charElement: DamageTypeValue,
  ): ResourceProfile {
    const combatSkills = skills.filter((s) => s.type !== "passive");

    // 主要消耗元素 = 角色本身元素对应的骰类型
    const primaryElement = charElement; // DamageType values 1-7 = DiceType values 1-7

    // 理想每回合消耗 = 非爆发技能中最贵的
    const nonBurst = combatSkills.filter((s) => s.type !== "burst");
    const idealDicePerRound =
      nonBurst.length > 0
        ? Math.max(...nonBurst.map((s) => s.cost.totalDice))
        : 0;

    return {
      primaryElement,
      idealDicePerRound,
      hasSelfFunding: false, // 需要源码分析才能判断，先默认 false
    };
  }

  // ─── helpers ──────────────────────────────────────────────

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

  private mapSkillType(
    engineType: string,
    skillId: number,
  ): "normal" | "elemental" | "burst" | "technique" | "passive" {
    // engineType from initiativeSkillConfig.skillType is unreliably undefined.
    // Use the skill definition ID pattern instead: last digit 1=normal, 2=elemental, 3=burst
    const lastDigit = skillId % 10;
    switch (lastDigit) {
      case 1: return "normal";
      case 2: return "elemental";
      case 3: return "burst";
      case 4: return "technique";
      case 5: return "passive";
      default: return "normal";
    }
  }
}
