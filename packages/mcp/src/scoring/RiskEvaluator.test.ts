import { describe, it, expect } from "bun:test";
import { RiskEvaluator, type RiskContext, type CharacterSummary } from "./RiskEvaluator";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    candidate_id: "cand_1",
    action_case: "useSkill",
    cost: { required_cost: [] },
    damage_estimate: 0,
    reaction_value: 0,
    tempo_value: 0,
    survival_risk: 0,
    tags: ["useSkill", "valid"],
    notes: [],
    ...overrides,
  };
}

function makeChar(id: number, hp: number, maxHp: number, energy = 0, maxEnergy = 3): CharacterSummary {
  return { id, hp, max_hp: maxHp, energy, max_energy: maxEnergy, alive: hp > 0 };
}

function makeCtx(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    selfSummary: {
      active_character_id: 1,
      characters: [
        makeChar(1, 10, 10),
        makeChar(2, 8, 10),
        makeChar(3, 6, 10),
      ],
    },
    opponentSummary: {
      active_character_id: 11,
      characters: [
        makeChar(11, 8, 10, 1, 3),
        makeChar(12, 6, 10, 0, 3),
        makeChar(13, 4, 10, 0, 3),
      ],
    },
    resourceSummary: { dice_count: 8, omni_count: 2 },
    round: 3,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RiskEvaluator", () => {
  const evaluator = new RiskEvaluator();

  describe("characterSurvival", () => {
    it("returns 0 when all characters are healthy", () => {
      const result = evaluator.evaluate(makeCandidate(), makeCtx(), 5);
      expect(result.characterSurvival).toBe(0);
    });

    it("adds penalty from candidate survival_risk", () => {
      const candidate = makeCandidate({ survival_risk: 2 });
      const result = evaluator.evaluate(candidate, makeCtx(), 5);
      expect(result.characterSurvival).toBe(2);
    });

    it("adds critical HP amplifier when active char HP <= 20%", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [makeChar(1, 2, 10), makeChar(2, 8, 10)],
        },
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      // survival_risk=0 + criticalHP amplifier=2
      expect(result.characterSurvival).toBe(2);
    });

    it("no critical HP amplifier when switching away", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [makeChar(1, 2, 10), makeChar(2, 8, 10)],
        },
      });
      const candidate = makeCandidate({ action_case: "switchActive" });
      const result = evaluator.evaluate(candidate, ctx, 5);
      // switchActive exempts from critical HP amplifier
      expect(result.characterSurvival).toBe(0);
    });

    it("adds team critical penalty when 2+ characters are low HP", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [
            makeChar(1, 3, 10), // 30% → critical
            makeChar(2, 2, 10), // 20% → critical
            makeChar(3, 8, 10),
          ],
        },
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      // char1 HP=30% → not ≤20% so no critical amplifier
      // but criticalCount=2 (char1 at 30%, char2 at 20%) → teamCritical=+1
      expect(result.characterSurvival).toBe(1);
    });

    it("adds tag-based risk for expose_core", () => {
      const candidate = makeCandidate({ tags: ["useSkill", "valid", "expose_core"] });
      const result = evaluator.evaluate(candidate, makeCtx(), 5);
      expect(result.characterSurvival).toBe(3);
    });
  });

  describe("opponentBurst", () => {
    it("returns 0 when opponent is not burst-ready", () => {
      const result = evaluator.evaluate(makeCandidate(), makeCtx(), 5);
      expect(result.opponentBurst).toBe(0);
    });

    it("adds penalty when opponent active char has full energy", () => {
      const ctx = makeCtx({
        opponentSummary: {
          active_character_id: 11,
          characters: [
            makeChar(11, 8, 10, 3, 3), // energy full
            makeChar(12, 6, 10, 0, 3),
          ],
        },
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      expect(result.opponentBurst).toBe(2);
    });

    it("extra penalty for declareEnd when opponent is burst-ready", () => {
      const ctx = makeCtx({
        opponentSummary: {
          active_character_id: 11,
          characters: [makeChar(11, 8, 10, 3, 3)],
        },
      });
      const candidate = makeCandidate({ action_case: "declareEnd" });
      const result = evaluator.evaluate(candidate, ctx, 5);
      // burst=2 + declareEnd extra=1
      expect(result.opponentBurst).toBe(3);
    });

    it("adds penalty when multiple opponent chars near burst", () => {
      const ctx = makeCtx({
        opponentSummary: {
          active_character_id: 11,
          characters: [
            makeChar(11, 8, 10, 2, 3), // 1 away from burst
            makeChar(12, 6, 10, 3, 3), // burst ready
            makeChar(13, 4, 10, 2, 3), // 1 away from burst
          ],
        },
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      // active(11) not full → no base burst penalty
      // but nearBurstCount = 3 (all within 1) >= 2 → +1
      expect(result.opponentBurst).toBe(1);
    });
  });

  describe("boardControl", () => {
    it("returns 0 with equal board state", () => {
      const result = evaluator.evaluate(makeCandidate(), makeCtx(), 5);
      expect(result.boardControl).toBe(0);
    });

    it("adds penalty when opponent has more alive characters", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [makeChar(1, 8, 10), makeChar(2, 0, 10)],
        },
        opponentSummary: {
          active_character_id: 11,
          characters: [makeChar(11, 8, 10), makeChar(12, 6, 10), makeChar(13, 4, 10)],
        },
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      // selfAlive=1, opponentAlive=3 → +1
      expect(result.boardControl).toBe(1);
    });

    it("adds late-game penalty when round >= 5 and only 1 char alive", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [makeChar(1, 8, 10), makeChar(2, 0, 10), makeChar(3, 0, 10)],
        },
        opponentSummary: {
          active_character_id: 11,
          characters: [makeChar(11, 5, 10)],
        },
        round: 6,
      });
      const result = evaluator.evaluate(makeCandidate(), ctx, 5);
      // selfAlive=1 <= opponentAlive=1 → no character disadvantage
      // round=6 >= 5 && selfAlive=1 → +1
      expect(result.boardControl).toBe(1);
    });

    it("adds dice scarcity penalty for costly actions with few dice", () => {
      const ctx = makeCtx({
        resourceSummary: { dice_count: 2, omni_count: 1 },
      });
      const candidate = makeCandidate({ action_case: "useSkill" });
      const result = evaluator.evaluate(candidate, ctx, 5);
      // diceCount=2 <=2 && useSkill → +1
      expect(result.boardControl).toBe(1);
    });

    it("no dice scarcity penalty for declareEnd", () => {
      const ctx = makeCtx({
        resourceSummary: { dice_count: 1, omni_count: 0 },
      });
      const candidate = makeCandidate({ action_case: "declareEnd" });
      const result = evaluator.evaluate(candidate, ctx, 5);
      expect(result.boardControl).toBe(0);
    });
  });

  describe("costEfficiency", () => {
    it("returns 0 for low cost action", () => {
      const candidate = makeCandidate({ cost: { required_cost: [{ type: 1, count: 1 }] } });
      const result = evaluator.evaluate(candidate, makeCtx(), 5);
      expect(result.costEfficiency).toBe(0);
    });

    it("adds high penalty for cost >= 3 and gain <= 1", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ type: 1, count: 2 }, { type: 8, count: 1 }] }, // total cost = 3
      });
      const result = evaluator.evaluate(candidate, makeCtx(), 1); // localGain=1
      expect(result.costEfficiency).toBe(3);
    });

    it("adds moderate penalty for cost >= 4 and gain <= 3", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ type: 1, count: 4 }] },
      });
      const result = evaluator.evaluate(candidate, makeCtx(), 3); // localGain=3
      // cost=4 >= 3 but localGain=3 > 1 → no +3
      // cost=4 >= 4 and localGain=3 <= 3 → +1
      expect(result.costEfficiency).toBe(1);
    });

    it("primary penalty takes precedence over moderate", () => {
      const candidate = makeCandidate({
        cost: { required_cost: [{ type: 1, count: 4 }] },
      });
      const result = evaluator.evaluate(candidate, makeCtx(), 0); // localGain=0
      // cost=4 >= 3 && localGain=0 <= 1 → +3
      // also cost=4 >= 4 && localGain=0 <= 3, but "else if" so not cumulative
      expect(result.costEfficiency).toBe(3);
    });
  });

  describe("total risk", () => {
    it("sums all dimensions", () => {
      const ctx = makeCtx({
        selfSummary: {
          active_character_id: 1,
          characters: [makeChar(1, 2, 10)], // critical HP
        },
        opponentSummary: {
          active_character_id: 11,
          characters: [makeChar(11, 8, 10, 3, 3)], // burst ready
        },
        resourceSummary: { dice_count: 2, omni_count: 0 },
        round: 6,
      });
      const candidate = makeCandidate({
        action_case: "useSkill",
        cost: { required_cost: [{ type: 1, count: 3 }] },
      });
      const result = evaluator.evaluate(candidate, ctx, 1);

      // characterSurvival: criticalHP amplifier=2 + selfAlive=1 so no team critical
      // opponentBurst: full energy=2
      // boardControl: opponentAlive(1) = selfAlive(1) → 0; round=6 & selfAlive=1 → +1; dice=2 & useSkill → +1
      // costEfficiency: cost=3 & gain=1 → +3
      expect(result.characterSurvival).toBe(2);
      expect(result.opponentBurst).toBe(2);
      expect(result.boardControl).toBe(2);
      expect(result.costEfficiency).toBe(3);
      expect(result.total).toBe(9);
    });

    it("returns all zeros for safe scenario", () => {
      const result = evaluator.evaluate(makeCandidate(), makeCtx(), 10);
      expect(result.total).toBe(0);
      expect(result.characterSurvival).toBe(0);
      expect(result.opponentBurst).toBe(0);
      expect(result.boardControl).toBe(0);
      expect(result.costEfficiency).toBe(0);
    });
  });
});
