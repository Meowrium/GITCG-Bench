/**
 * Smoke test: 验证核心流程可以运行
 */

import { describe, it, expect } from "bun:test";
import { DamageType, Reaction, Aura } from "@gi-tcg/typings";
import {
  computeElementalCompatibility,
  computeReactionCoverage,
} from "../src/compatibility/ElementalCompatibilityCalc.js";
import {
  computeTempoCompatibility,
} from "../src/compatibility/TempoCompatibilityCalc.js";
import {
  estimateSkillPhaseValue,
} from "../src/profiler/SkillPhaseValueEstimator.js";
import {
  parseSkillDamageFromSource,
  parseComplexityFromSource,
} from "../src/profiler/SourceParser.js";
import type {
  CharacterOutputProfile,
  SkillProfile,
} from "../src/profiler/types.js";

// ─── 元素兼容性测试 ──────────────────────────────────────

describe("ElementalCompatibilityCalc", () => {
  it("火+冰 → 融化(S级)", () => {
    const result = computeElementalCompatibility("pyro", "cryo");
    expect(result.possibleReactions).toContain(Reaction.Melt);
    expect(result.reactionTier).toBe("S");
  });

  it("火+水 → 蒸发(S级)", () => {
    const result = computeElementalCompatibility("pyro", "hydro");
    expect(result.possibleReactions).toContain(Reaction.Vaporize);
    expect(result.reactionTier).toBe("S");
  });

  it("冰+雷 → 超导(A级)", () => {
    const result = computeElementalCompatibility("cryo", "electro");
    expect(result.possibleReactions).toContain(Reaction.Superconduct);
    expect(result.reactionTier).toBe("A");
  });

  it("火+火 → 无反应", () => {
    const result = computeElementalCompatibility("pyro", "pyro");
    expect(result.possibleReactions).toHaveLength(0);
    expect(result.reactionTier).toBe("none");
  });

  it("三角色反应覆盖率", () => {
    const coverage = computeReactionCoverage(["pyro", "hydro", "cryo"]);
    expect(coverage).toBeGreaterThan(0);
    expect(coverage).toBeLessThanOrEqual(1);
  });
});

// ─── 节奏兼容性测试（核心修正验证）──────────────────────

describe("TempoCompatibility — burstStagger 修正", () => {
  const makeProfile = (
    minBurstCycle: number,
    dotOutput = false,
  ): CharacterOutputProfile => ({
    definitionId: 0,
    tags: ["pyro", "sword", "mondstadt"],
    base: { element: DamageType.Pyro, weapon: "sword", nation: "mondstadt", health: 10, maxEnergy: 2 },
    skills: [],
    rhythm: {
      minBurstCycle,
      burstCycleTotalDiceCost: 10,
      phaseDamage: [1, 2, 1.5],
      hasFastActionDamage: false,
      hasDoTOutput: dotOutput,
      dotDamagePerRound: dotOutput ? 2 : 0,
      hasDeferredBurst: false,
    },
    resourceProfile: { primaryElement: DamageType.Pyro, idealDicePerRound: 3, hasSelfFunding: false },
    complexity: {
      requiresSimulation: false,
      conditionalBranchCount: 0,
      hasCrossCharacterInteraction: false,
      requiresReactionTrigger: false,
      hasStateMachine: false,
      hasPhaseDependentValue: false,
    },
  });

  it("同周期 → burstStaggerScore = 0.1（骰子黑洞，最低 0.1）", () => {
    const a = makeProfile(3);
    const b = makeProfile(3);
    const result = computeTempoCompatibility(a, b);
    expect(result.burstStaggerScore).toBe(0.1);
  });

  it("差1回合 → burstStaggerScore = 0.5", () => {
    const a = makeProfile(3);
    const b = makeProfile(4);
    const result = computeTempoCompatibility(a, b);
    expect(result.burstStaggerScore).toBe(0.5);
  });

  it("差2回合以上 → burstStaggerScore = 0.8", () => {
    const a = makeProfile(3);
    const b = makeProfile(5);
    const result = computeTempoCompatibility(a, b);
    expect(result.burstStaggerScore).toBe(0.8);
  });

  it("一方无爆发 → burstStaggerScore = 1.0", () => {
    const a = makeProfile(3);
    const b = makeProfile(Infinity);
    const result = computeTempoCompatibility(a, b);
    expect(result.burstStaggerScore).toBe(1.0);
  });
});

// ─── SkillPhaseValue 测试 ────────────────────────────────

describe("SkillPhaseValueEstimator", () => {
  const baseSkill: SkillProfile = {
    definitionId: 1,
    type: "elemental",
    cost: { elementDice: 3, voidDice: 0, alignedDice: 0, energyCost: 0, totalDice: 3 },
    output: {
      mainDamageType: DamageType.Pyro,
      mainDamageValue: 3,
      additionalDamage: [],
      createsSummon: false,
      createsStatus: false,
    },
    gainEnergy: true,
    isFast: false,
  };

  it("召唤物技能 → decay 趋势（越早放越好）", () => {
    const summonSkill: SkillProfile = {
      ...baseSkill,
      output: { ...baseSkill.output, createsSummon: true, summonProfile: {
        definitionId: 100, endPhaseDamage: 2, endPhaseDamageElement: DamageType.Pyro, duration: 2,
      }},
    };
    const result = estimateSkillPhaseValue(summonSkill, {
      hasCrossCharacterInteraction: false,
      requiresReactionTrigger: false,
      hasStateMachine: false,
      hasDeferredBurst: false,
    });
    expect(result).toBeDefined();
    expect(result!.trend).toBe("decay");
    expect(result!.earlyGame).toBeGreaterThan(result!.lateGame);
  });

  it("状态buff技能 → spike_then_decay 趋势", () => {
    const buffSkill: SkillProfile = {
      ...baseSkill,
      output: { ...baseSkill.output, createsStatus: true },
    };
    const result = estimateSkillPhaseValue(buffSkill, {
      hasCrossCharacterInteraction: false,
      requiresReactionTrigger: false,
      hasStateMachine: false,
      hasDeferredBurst: false,
    });
    expect(result).toBeDefined();
    expect(result!.trend).toBe("spike_then_decay");
  });
});

// ─── 源码解析测试 ────────────────────────────────────────

describe("SourceParser", () => {
  const xianglingSource = `
import { character, skill, summon, combatStatus, card, DamageType, SkillHandle } from "@gi-tcg/core/builder";

export const Guoba = summon(113021)
  .endPhaseDamage(DamageType.Pyro, 2)
  .usage(2)
  .done();

export const DoughFu = skill(13021)
  .type("normal")
  .costPyro(1)
  .costVoid(2)
  .damage(DamageType.Physical, 2)
  .done();

export const GuobaAttack: SkillHandle = skill(13022)
  .type("elemental")
  .costPyro(3)
  .if((c) => c.self.hasEquipment(Crossfire))
  .damage(DamageType.Pyro, 1)
  .summon(Guoba)
  .done();

export const Pyronado: SkillHandle = skill(13023)
  .type("burst")
  .costPyro(4)
  .costEnergy(2)
  .damage(DamageType.Pyro, 3)
  .combatStatus(PyronadoStatus)
  .done();

export const Xiangling = character(1302)
  .since("v3.3.0")
  .tags("pyro", "pole", "liyue")
  .health(10)
  .energy(2)
  .skills(DoughFu, GuobaAttack, Pyronado)
  .done();
`;

  it("提取技能伤害值", () => {
    const map = parseSkillDamageFromSource(xianglingSource);
    // 白案功夫
    expect(map.get(13021)?.mainDamageValue).toBe(2);
    expect(map.get(13021)?.mainDamageType).toBe(DamageType.Physical);
    // 锅巴出击
    expect(map.get(13022)?.mainDamageValue).toBe(1);
    expect(map.get(13022)?.createsSummon).toBe(true);
    // 旋火轮
    expect(map.get(13023)?.mainDamageValue).toBe(3);
    expect(map.get(13023)?.createsStatus).toBe(true);
  });

  it("提取复杂度信息", () => {
    const map = parseComplexityFromSource(xianglingSource);
    const info = map.get(1302);
    expect(info).toBeDefined();
    expect(info!.ifCount).toBe(1); // if((c) => c.self.hasEquipment(Crossfire))
    expect(info!.hasCrossCharInteraction).toBe(false);
  });
});
