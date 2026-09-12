import { describe, test, expect } from "bun:test";
import {
  FuturePotentialEvaluator,
  type FuturePotentialContext,
  type CharacterEnergyInfo,
} from "./FuturePotentialEvaluator";

const evaluator = new FuturePotentialEvaluator();

function makeCtx(
  overrides: Partial<FuturePotentialContext> = {},
): FuturePotentialContext {
  return {
    selfCharacters: [],
    activeCharacterId: 1,
    candidateTags: [],
    candidateNotes: [],
    ...overrides,
  };
}

function makeChar(
  overrides: Partial<CharacterEnergyInfo> = {},
): CharacterEnergyInfo {
  return { id: 1, energy: 0, maxEnergy: 3, alive: true, ...overrides };
}

// ── energyPotential ────────────────────────────────────────────────

describe("FuturePotentialEvaluator > energyPotential", () => {
  test("returns 5 for burst action", () => {
    const ctx = makeCtx({ candidateTags: ["burst"] });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(5);
  });

  test("returns 4 when useSkill and energy gap is 1", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 1, energy: 2, maxEnergy: 3 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(4);
  });

  test("returns 2 when useSkill and energy gap is 2", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 1, energy: 1, maxEnergy: 3 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(2);
  });

  test("returns 1 when useSkill and energy gap >= 3", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 1, energy: 0, maxEnergy: 3 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(1);
  });

  test("returns 0 for non-useSkill action", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 1, energy: 2, maxEnergy: 3 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "playCard" }, ctx);
    expect(result.energyPotential).toBe(0);
  });

  test("returns 0 when no active character found", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 2, energy: 2, maxEnergy: 3 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(0);
  });

  test("returns 0 when maxEnergy is 0", () => {
    const ctx = makeCtx({
      selfCharacters: [makeChar({ id: 1, energy: 0, maxEnergy: 0 })],
      activeCharacterId: 1,
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.energyPotential).toBe(0);
  });
});

// ── reactionChainPotential ─────────────────────────────────────────

describe("FuturePotentialEvaluator > reactionChainPotential", () => {
  test("returns 1 when candidate already has reaction_value", () => {
    const ctx = makeCtx();
    const result = evaluator.evaluate({ reaction_value: 3 }, ctx);
    expect(result.reactionChainPotential).toBe(1);
  });

  test("returns 2 when applying element without reaction", () => {
    const ctx = makeCtx({ candidateTags: ["pyro"] });
    const result = evaluator.evaluate({ reaction_value: 0 }, ctx);
    expect(result.reactionChainPotential).toBe(2);
  });

  test("returns 3 for summon tag (default duration=2, dmg_per_round=1, ×1.5)", () => {
    const ctx = makeCtx({ candidateTags: ["summon"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.reactionChainPotential).toBe(3);
  });

  test("returns 1 for status or shield tags", () => {
    const ctx = makeCtx({ candidateTags: ["shield"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.reactionChainPotential).toBe(1);
  });

  test("returns 0 for no relevant tags", () => {
    const ctx = makeCtx({ candidateTags: ["normal_attack"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.reactionChainPotential).toBe(0);
  });

  test("reaction_value > 0 returns 1 even with element tag", () => {
    // reaction already consumed the element, so chain value is lower
    const ctx = makeCtx({ candidateTags: ["cryo"] });
    const result = evaluator.evaluate({ reaction_value: 2 }, ctx);
    expect(result.reactionChainPotential).toBe(1);
  });
});

// ── tempoAdvantage ─────────────────────────────────────────────────

describe("FuturePotentialEvaluator > tempoAdvantage", () => {
  test("returns 2 for fast action", () => {
    const ctx = makeCtx({ candidateTags: ["fast"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.tempoAdvantage).toBe(2);
  });

  test("returns 2 for summon action", () => {
    const ctx = makeCtx({ candidateTags: ["summon"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.tempoAdvantage).toBe(2);
  });

  test("returns 4 for fast summon action", () => {
    const ctx = makeCtx({ candidateTags: ["fast", "summon"] });
    const result = evaluator.evaluate({}, ctx);
    expect(result.tempoAdvantage).toBe(4);
  });

  test("returns -1 for declareEnd", () => {
    const ctx = makeCtx();
    const result = evaluator.evaluate({ action_case: "declareEnd" }, ctx);
    expect(result.tempoAdvantage).toBe(-1);
  });

  test("returns 1 for elementalTuning", () => {
    const ctx = makeCtx();
    const result = evaluator.evaluate(
      { action_case: "elementalTuning" },
      ctx,
    );
    expect(result.tempoAdvantage).toBe(1);
  });

  test("returns 0 for normal useSkill without tempo tags", () => {
    const ctx = makeCtx();
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.tempoAdvantage).toBe(0);
  });
});

// ── positionalValue ────────────────────────────────────────────────

describe("FuturePotentialEvaluator > positionalValue", () => {
  test("returns 0 for non-switch actions", () => {
    const ctx = makeCtx({ candidateTags: ["burst_ready"] });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    expect(result.positionalValue).toBe(0);
  });

  test("returns 2 for switchActive to burst_ready", () => {
    const ctx = makeCtx({ candidateTags: ["burst_ready"] });
    const result = evaluator.evaluate({ action_case: "switchActive" }, ctx);
    expect(result.positionalValue).toBe(2);
  });

  test("returns -2 for switchActive to low_hp", () => {
    const ctx = makeCtx({ candidateTags: ["low_hp"] });
    const result = evaluator.evaluate({ action_case: "switchActive" }, ctx);
    expect(result.positionalValue).toBe(-2);
  });

  test("returns 1 for chooseActive to near_burst", () => {
    const ctx = makeCtx({ candidateTags: ["near_burst"] });
    const result = evaluator.evaluate({ action_case: "chooseActive" }, ctx);
    expect(result.positionalValue).toBe(1);
  });

  test("returns 0 for switchActive with no position-relevant tags", () => {
    const ctx = makeCtx({ candidateTags: ["normal_attack"] });
    const result = evaluator.evaluate({ action_case: "switchActive" }, ctx);
    expect(result.positionalValue).toBe(0);
  });

  test("burst_ready + low_hp cancel to 0 for switchActive", () => {
    const ctx = makeCtx({ candidateTags: ["burst_ready", "low_hp"] });
    const result = evaluator.evaluate({ action_case: "switchActive" }, ctx);
    expect(result.positionalValue).toBe(0); // +2 - 2
  });
});

// ── total integration ──────────────────────────────────────────────

describe("FuturePotentialEvaluator > total", () => {
  test("sums all sub-dimensions", () => {
    // burst (energy=5) + reaction with element applied (=1) + no tempo + no positional
    const ctx = makeCtx({ candidateTags: ["burst"] });
    const result = evaluator.evaluate(
      { action_case: "useSkill", reaction_value: 2 },
      ctx,
    );
    expect(result.total).toBe(
      result.energyPotential +
        result.reactionChainPotential +
        result.tempoAdvantage +
        result.positionalValue,
    );
    expect(result.energyPotential).toBe(5);
    expect(result.reactionChainPotential).toBe(1);
  });

  test("returns all zeros for neutral scenario", () => {
    const ctx = makeCtx();
    const result = evaluator.evaluate({ action_case: "playCard" }, ctx);
    expect(result.total).toBe(0);
    expect(result.energyPotential).toBe(0);
    expect(result.reactionChainPotential).toBe(0);
    expect(result.tempoAdvantage).toBe(0);
    expect(result.positionalValue).toBe(0);
  });

  test("high value scenario: burst + fast + element", () => {
    const ctx = makeCtx({
      candidateTags: ["burst", "fast", "cryo"],
    });
    const result = evaluator.evaluate({ action_case: "useSkill" }, ctx);
    // energy=5 (burst), reaction=0 (burst takes precedence, cryo would be 2 but reaction_value check first, actually: reaction_value=undefined→safeNumber=0, then element check: cryo→2), tempo=2 (fast), positional=0
    expect(result.energyPotential).toBe(5);
    expect(result.reactionChainPotential).toBe(2); // cryo applies, no reaction_value
    expect(result.tempoAdvantage).toBe(2);
    expect(result.positionalValue).toBe(0);
    expect(result.total).toBe(9);
  });
});
