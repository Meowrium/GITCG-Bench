import { describe, test, expect } from "bun:test";
import { StrategyMatcher } from "./StrategyMatcher";

const matcher = new StrategyMatcher();

// ── resolveLabel ────────────────────────────────────────────────────

describe("StrategyMatcher > resolveLabel", () => {
  test("returns standard label unchanged", () => {
    expect(matcher.resolveLabel("attack")).toBe("attack");
    expect(matcher.resolveLabel("burst_finish")).toBe("burst_finish");
    expect(matcher.resolveLabel("stabilize_tempo")).toBe("stabilize_tempo");
  });

  test("resolves Chinese synonym to standard label", () => {
    expect(matcher.resolveLabel("稳定节奏")).toBe("stabilize_tempo");
    expect(matcher.resolveLabel("全力进攻")).toBe("aggressive_push");
    expect(matcher.resolveLabel("充能")).toBe("build_energy");
    expect(matcher.resolveLabel("元素反应")).toBe("setup_reaction");
    expect(matcher.resolveLabel("保护核心")).toBe("protect_core");
    expect(matcher.resolveLabel("节省资源")).toBe("conserve_resources");
    expect(matcher.resolveLabel("大招收割")).toBe("burst_finish");
  });

  test("resolves English synonym to standard label", () => {
    expect(matcher.resolveLabel("aggressive")).toBe("aggressive_push");
    expect(matcher.resolveLabel("tempo")).toBe("stabilize_tempo");
    expect(matcher.resolveLabel("conserve")).toBe("conserve_resources");
    expect(matcher.resolveLabel("finish")).toBe("burst_finish");
  });

  test("resolves action category Chinese synonyms", () => {
    expect(matcher.resolveLabel("普攻")).toBe("normal_attack");
    expect(matcher.resolveLabel("大招")).toBe("elemental_burst");
    expect(matcher.resolveLabel("战技")).toBe("elemental_skill");
    expect(matcher.resolveLabel("切人")).toBe("switch");
    expect(matcher.resolveLabel("治疗")).toBe("heal");
    expect(matcher.resolveLabel("护盾")).toBe("shield");
    expect(matcher.resolveLabel("召唤")).toBe("summon");
    expect(matcher.resolveLabel("结束回合")).toBe("end_turn");
    // "技能" remains generic, covering all three types
    expect(matcher.resolveLabel("技能")).toBe("skill");
  });

  test("is case-insensitive", () => {
    expect(matcher.resolveLabel("ATTACK")).toBe("attack");
    expect(matcher.resolveLabel("Aggressive")).toBe("aggressive_push");
  });

  test("returns normalized unknown text unchanged", () => {
    expect(matcher.resolveLabel("some random text")).toBe("some random text");
    expect(matcher.resolveLabel("先打一下再说")).toBe("先打一下再说");
  });
});

// ── matchTerm ───────────────────────────────────────────────────────

describe("StrategyMatcher > matchTerm", () => {
  test("exact match when standard label matches candidate", () => {
    const result = matcher.matchTerm("attack", "useSkill attack pyro");
    expect(result.matched).toBe(true);
    expect(result.tier).toBe("exact");
    expect(result.weight).toBe(1.0);
  });

  test("synonym match when Chinese text resolves to standard label in candidate", () => {
    // Fragment says "稳定节奏" → resolves to "stabilize_tempo"
    // Candidate has "stabilize_tempo" in its tags
    const result = matcher.matchTerm("稳定节奏", "useSkill stabilize_tempo");
    expect(result.matched).toBe(true);
    expect(result.tier).toBe("synonym");
    expect(result.weight).toBe(0.8);
  });

  test("substring fallback when non-standard term matches candidate directly", () => {
    // "pyro" is not a standard label nor has a synonym mapping
    const result = matcher.matchTerm("pyro", "useSkill pyro attack");
    expect(result.matched).toBe(true);
    expect(result.tier).toBe("substring");
    expect(result.weight).toBe(0.5);
  });

  test("no match when term does not appear in candidate", () => {
    const result = matcher.matchTerm("heal", "useSkill attack pyro");
    expect(result.matched).toBe(false);
    expect(result.tier).toBe("none");
    expect(result.weight).toBe(0);
  });

  test("Chinese synonym resolves and matches English candidate tag", () => {
    // "普攻" → "normal_attack", candidate has "normal_attack"
    const result = matcher.matchTerm("普攻", "useSkill normal_attack valid");
    expect(result.matched).toBe(true);
    expect(result.tier).toBe("synonym");
    expect(result.weight).toBe(0.8);
  });

  test("standard label that is not in candidate returns none", () => {
    const result = matcher.matchTerm("heal", "useSkill attack burst");
    expect(result.matched).toBe(false);
    expect(result.tier).toBe("none");
  });

  test("free-text that matches substring but is not standard gets 0.5", () => {
    const result = matcher.matchTerm("energy charge", "useSkill energy charge valid");
    expect(result.matched).toBe(true);
    expect(result.tier).toBe("substring");
    expect(result.weight).toBe(0.5);
  });
});

// ── computeStrategyMatch ────────────────────────────────────────────

describe("StrategyMatcher > computeStrategyMatch", () => {
  const baseFragment = {
    intent: "",
    must_do: [] as string[],
    avoid: [] as string[],
    preference_order: [] as string[],
  };

  test("intent exact match gives full 8 points", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack burst",
      { ...baseFragment, intent: "attack" },
      [],
    );
    expect(result.intentScore).toBe(8);
    expect(result.total).toBe(8);
  });

  test("intent synonym match gives 8 × 0.8 = 6.4", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill normal_attack burst",
      { ...baseFragment, intent: "普攻" },
      [],
    );
    expect(result.intentScore).toBeCloseTo(6.4);
    expect(result.total).toBeCloseTo(6.4);
  });

  test("intent substring match gives 8 × 0.5 = 4", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill pyro fire",
      { ...baseFragment, intent: "pyro" },
      [],
    );
    expect(result.intentScore).toBe(4);
    expect(result.total).toBe(4);
  });

  test("稳定节奏 and stabilize_tempo give consistent scores", () => {
    const candidate = "useSkill stabilize_tempo support";
    const chineseResult = matcher.computeStrategyMatch(
      candidate,
      { ...baseFragment, intent: "稳定节奏" },
      [],
    );
    const englishResult = matcher.computeStrategyMatch(
      candidate,
      { ...baseFragment, intent: "stabilize_tempo" },
      [],
    );
    // Chinese synonym: 8 × 0.8 = 6.4
    expect(chineseResult.intentScore).toBeCloseTo(6.4);
    // English standard: 8 × 1.0 = 8
    expect(englishResult.intentScore).toBe(8);
    // Both still match, just different tiers
    expect(chineseResult.intentScore).toBeGreaterThan(0);
    expect(englishResult.intentScore).toBeGreaterThan(0);
  });

  test("must_do exact match gives 6 per item", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack heal",
      { ...baseFragment, must_do: ["attack", "heal"] },
      [],
    );
    expect(result.mustDoScore).toBe(12); // 6 + 6
  });

  test("avoid exact match gives 8 penalty per item", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill end_turn",
      { ...baseFragment, avoid: ["end_turn"] },
      [],
    );
    expect(result.avoidScore).toBe(8);
    expect(result.total).toBe(-8);
  });

  test("avoid substring match gives 8 × 0.5 penalty", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill pyro fire",
      { ...baseFragment, avoid: ["pyro"] },
      [],
    );
    expect(result.avoidScore).toBe(4);
    expect(result.total).toBe(-4);
  });

  test("preference_order gives descending weighted bonus", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack burst",
      { ...baseFragment, preference_order: ["heal", "burst", "attack"] },
      [],
    );
    // "heal" not found, "burst" found at index 1 → base max(1,5-1)=4, exact → 4
    expect(result.preferenceScore).toBe(4);
  });

  test("preference stops at first match", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack burst",
      { ...baseFragment, preference_order: ["attack", "burst"] },
      [],
    );
    // "attack" found at index 0 → base max(1,5-0)=5
    expect(result.preferenceScore).toBe(5);
  });

  test("profile keywords add 1 point", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack special",
      { ...baseFragment },
      ["special"],
    );
    expect(result.profileScore).toBe(1);
    expect(result.total).toBe(1);
  });

  test("Chinese free text does not wrongly match unrelated labels", () => {
    // "先打一下再说" should NOT match "aggressive_push"
    const result = matcher.computeStrategyMatch(
      "useSkill attack normal",
      { ...baseFragment, intent: "先打一下再说" },
      [],
    );
    // No synonym mapping, no substring match on candidate
    expect(result.intentScore).toBe(0);
  });

  test("backward compatible: non-standard substring terms still work", () => {
    // Old behavior: free text that happens to match candidate tag → works but at reduced weight
    const result = matcher.computeStrategyMatch(
      "switchActive low_hp target_char",
      { ...baseFragment, avoid: ["low_hp"] },
      [],
    );
    expect(result.avoidScore).toBe(4); // 8 × 0.5
    expect(result.total).toBe(-4);
  });

  test("full breakdown sums correctly", () => {
    const result = matcher.computeStrategyMatch(
      "useSkill attack burst heal",
      {
        intent: "attack",
        must_do: ["burst"],
        avoid: ["heal"],
        preference_order: ["attack"],
      },
      ["attack"],
    );
    // intent: "attack" exact → 8
    // must_do: "burst" exact → 6
    // avoid: "heal" exact → 8
    // preference: "attack" exact index 0 → 5
    // profile: "attack" → 1
    expect(result.intentScore).toBe(8);
    expect(result.mustDoScore).toBe(6);
    expect(result.avoidScore).toBe(8);
    expect(result.preferenceScore).toBe(5);
    expect(result.profileScore).toBe(1);
    expect(result.total).toBe(8 + 6 - 8 + 5 + 1); // 12
  });
});
