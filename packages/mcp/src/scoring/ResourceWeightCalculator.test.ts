import { describe, it, expect } from "bun:test";
import { ResourceWeightCalculator, type ResourceContext } from "./ResourceWeightCalculator";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Partial<ResourceContext> = {}): ResourceContext {
  return {
    diceCount: 8,
    omniCount: 2,
    cardsInHand: 5,
    round: 3,
    resourcePolicy: "balanced",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    candidate_id: "cand_1",
    action_case: "useSkill",
    cost: { required_cost: [] },
    tags: ["useSkill", "valid"],
    notes: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ResourceWeightCalculator", () => {
  const calc = new ResourceWeightCalculator();

  describe("computeWeights", () => {
    it("returns neutral weights for mid-game balanced state", () => {
      const w = calc.computeWeights(makeCtx());
      expect(w.diceWeight).toBe(1); // 8 dice → max(0, (6-8)*0.2) = 0 → 1+0
      expect(w.omniPremium).toBe(1.0);
      expect(w.cardWeight).toBe(1.0);
      expect(w.phaseMultiplier).toBe(1.0);
      expect(w.policyMultiplier).toBe(1.2);
    });

    it("dice scarcity increases diceWeight", () => {
      const w = calc.computeWeights(makeCtx({ diceCount: 2 }));
      // 1 + max(0, (6-2)*0.2) = 1 + 0.8 = 1.8
      expect(w.diceWeight).toBeCloseTo(1.8, 5);
    });

    it("zero dice gives maximum diceWeight", () => {
      const w = calc.computeWeights(makeCtx({ diceCount: 0 }));
      // 1 + max(0, (6-0)*0.2) = 1 + 1.2 = 2.2
      expect(w.diceWeight).toBeCloseTo(2.2, 5);
    });

    it("omni premium doubles when omni <= 1", () => {
      expect(calc.computeWeights(makeCtx({ omniCount: 1 })).omniPremium).toBe(2.0);
      expect(calc.computeWeights(makeCtx({ omniCount: 0 })).omniPremium).toBe(2.0);
      expect(calc.computeWeights(makeCtx({ omniCount: 2 })).omniPremium).toBe(1.0);
    });

    it("card weight increases when hand is small", () => {
      expect(calc.computeWeights(makeCtx({ cardsInHand: 2 })).cardWeight).toBe(1.5);
      expect(calc.computeWeights(makeCtx({ cardsInHand: 1 })).cardWeight).toBe(1.5);
      expect(calc.computeWeights(makeCtx({ cardsInHand: 3 })).cardWeight).toBe(1.0);
    });

    it("early rounds apply conservative phase multiplier", () => {
      expect(calc.computeWeights(makeCtx({ round: 1 })).phaseMultiplier).toBe(1.2);
      expect(calc.computeWeights(makeCtx({ round: 2 })).phaseMultiplier).toBe(1.2);
    });

    it("late rounds apply aggressive phase multiplier", () => {
      expect(calc.computeWeights(makeCtx({ round: 6 })).phaseMultiplier).toBe(0.85);
      expect(calc.computeWeights(makeCtx({ round: 10 })).phaseMultiplier).toBe(0.85);
    });

    it("mid rounds apply neutral phase multiplier", () => {
      expect(calc.computeWeights(makeCtx({ round: 3 })).phaseMultiplier).toBe(1.0);
      expect(calc.computeWeights(makeCtx({ round: 5 })).phaseMultiplier).toBe(1.0);
    });

    it("policy mappings are correct", () => {
      expect(calc.computeWeights(makeCtx({ resourcePolicy: "strict" })).policyMultiplier).toBe(1.6);
      expect(calc.computeWeights(makeCtx({ resourcePolicy: "balanced" })).policyMultiplier).toBe(1.2);
      expect(calc.computeWeights(makeCtx({ resourcePolicy: "aggressive" })).policyMultiplier).toBe(0.8);
    });
  });

  describe("evaluate", () => {
    it("returns zero penalty for zero-cost action", () => {
      const result = calc.evaluate(makeCandidate(), makeCtx());
      expect(result.total).toBe(0);
      expect(result.baseCostPenalty).toBe(0);
      expect(result.omniPressurePenalty).toBe(0);
      expect(result.cardWastePenalty).toBe(0);
    });

    it("scales base cost by policy × phase × diceWeight", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      // Mid-game, balanced, 8 dice: 3 * 1.2 * 1.0 * 1.0 = 3.6
      const result = calc.evaluate(candidate, makeCtx());
      expect(result.baseCostPenalty).toBeCloseTo(3.6, 5);
    });

    it("dice scarcity amplifies cost", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      // 2 dice, mid-game, balanced: 3 * 1.2 * 1.0 * 1.8 = 6.48
      const result = calc.evaluate(candidate, makeCtx({ diceCount: 2 }));
      expect(result.baseCostPenalty).toBeCloseTo(6.48, 5);
    });

    it("early round amplifies cost", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      // 8 dice, round 1, balanced: 3 * 1.2 * 1.2 * 1.0 = 4.32
      const result = calc.evaluate(candidate, makeCtx({ round: 1 }));
      expect(result.baseCostPenalty).toBeCloseTo(4.32, 5);
    });

    it("late round reduces cost", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      // 8 dice, round 7, balanced: 3 * 1.2 * 0.85 * 1.0 = 3.06
      const result = calc.evaluate(candidate, makeCtx({ round: 7 }));
      expect(result.baseCostPenalty).toBeCloseTo(3.06, 5);
    });

    it("omni pressure penalty triggers under strict with low omni and cost >= 2", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 2 }] },
      });
      const ctx = makeCtx({ resourcePolicy: "strict", omniCount: 1 });
      const result = calc.evaluate(candidate, ctx);
      // omniPressure = 2 * 2.0 = 4.0
      expect(result.omniPressurePenalty).toBe(4.0);
    });

    it("no omni pressure when omni is plentiful", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      const ctx = makeCtx({ resourcePolicy: "strict", omniCount: 3 });
      const result = calc.evaluate(candidate, ctx);
      expect(result.omniPressurePenalty).toBe(0);
    });

    it("no omni pressure under balanced policy", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      const ctx = makeCtx({ resourcePolicy: "balanced", omniCount: 0 });
      const result = calc.evaluate(candidate, ctx);
      expect(result.omniPressurePenalty).toBe(0);
    });

    it("card waste penalty applies for effectless playCard", () => {
      const candidate = makeCandidate({
        action_case: "playCard",
        tags: ["playCard", "valid", "effectless"],
      });
      // cardWeight = 1.0 (cardsInHand=5) → waste = 2 * 1.0
      const result = calc.evaluate(candidate, makeCtx());
      expect(result.cardWastePenalty).toBe(2.0);
    });

    it("card waste penalty scales with low hand count", () => {
      const candidate = makeCandidate({
        action_case: "playCard",
        tags: ["playCard", "valid", "effectless"],
      });
      // cardsInHand=1 → cardWeight=1.5 → waste = 2 * 1.5 = 3.0
      const result = calc.evaluate(candidate, makeCtx({ cardsInHand: 1 }));
      expect(result.cardWastePenalty).toBe(3.0);
    });

    it("no card waste for non-effectless playCard", () => {
      const candidate = makeCandidate({
        action_case: "playCard",
        tags: ["playCard", "valid"],
      });
      const result = calc.evaluate(candidate, makeCtx());
      expect(result.cardWastePenalty).toBe(0);
    });

    it("strict policy is significantly more expensive than aggressive", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ count: 3 }] },
      });
      const strict = calc.evaluate(candidate, makeCtx({ resourcePolicy: "strict" }));
      const aggressive = calc.evaluate(candidate, makeCtx({ resourcePolicy: "aggressive" }));
      expect(strict.total).toBeGreaterThan(aggressive.total * 1.5);
    });
  });
});
