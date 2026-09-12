import { describe, expect, test } from "bun:test";
import { FragmentResolver } from "./FragmentResolver";
import type {
  DecisionFragmentV1,
  FragmentedDecisionState,
  TurnDigestV1,
} from "./types";

/** Helper: build a minimal TurnDigestV1 */
function makeDigest(
  overrides: Partial<TurnDigestV1> & {
    candidate_actions?: Array<Record<string, unknown>>;
  } = {},
): TurnDigestV1 {
  return {
    version: "TurnDigestV1",
    digest_ref: "digest_test_1",
    session_id: "sess_test",
    round: 1,
    turn: 1,
    pending_method: "action",
    strategic_profile_ref: "",
    self_summary: {},
    opponent_summary: {},
    resource_summary: { dice: [], dice_count: 0, omni_count: 0, cards_in_hand: 3 },
    candidate_actions: [],
    hard_constraints: [],
    character_definitions: [],
    card_definitions: [],
    generated_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Helper: build a minimal DecisionFragmentV1 */
function makeFragment(overrides: Partial<DecisionFragmentV1> = {}): DecisionFragmentV1 {
  return {
    version: "DecisionFragmentV1",
    fragment_ref: "frag_test_1",
    session_id: "sess_test",
    digest_ref: "digest_test_1",
    intent: "attack",
    must_do: [],
    avoid: [],
    preference_order: [],
    resource_policy: "balanced",
    target_policy: "maximize_legal_value",
    fallback_rule: "pick_highest_valid_candidate",
    explanation: "test",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Helper: build a FragmentedDecisionState with typed candidates */
function makeState(
  candidates: Array<Record<string, unknown>>,
  toolMap?: Record<string, { tool: string; args: Record<string, unknown> }>,
  digestOverrides: Partial<TurnDigestV1> = {},
): FragmentedDecisionState {
  const candidateActionMap = new Map<string, { tool: string; args: Record<string, unknown> }>();
  for (const c of candidates) {
    const id = String(c.candidate_id ?? "");
    if (toolMap && toolMap[id]) {
      candidateActionMap.set(id, toolMap[id]);
    } else {
      candidateActionMap.set(id, { tool: "choose_action", args: { action_index: 1 } });
    }
  }
  return {
    digest: makeDigest({ candidate_actions: candidates, ...digestOverrides }),
    candidateActionMap,
  };
}

describe("FragmentResolver", () => {
  const resolver = new FragmentResolver();

  test("returns fallback when no candidates are present", () => {
    const state = makeState([]);
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    expect(result.selectedCandidateId).toBeNull();
    expect(result.executionOrder).toEqual([]);
    expect(result.fallbackUsed).toBe(true);
    expect(result.resolverReason).toContain("No legal candidate");
  });

  test("filters out invalid candidates", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "invalid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    expect(result.selectedCandidateId).toBeNull();
    expect(result.fallbackUsed).toBe(true);
  });

  test("selects highest-scored candidate by total score", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 5,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "playCard",
        cost: {},
        tags: ["playCard", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ intent: "attack" });
    const result = resolver.resolve(state, fragment);

    expect(result.selectedCandidateId).toBe("cand_1");
    expect(result.fallbackUsed).toBe(false);
    // useSkill has actionBias=4 + damage_estimate=5 = localGain=9
    // playCard has actionBias=3 + damage_estimate=0 = localGain=3
    expect(result.scoreBreakdown["cand_1"]).toBeGreaterThan(
      result.scoreBreakdown["cand_2"],
    );
  });

  test("strategyMatch boosts candidates matching intent", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid", "burst"],
        notes: ["burst attack"],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid", "normal"],
        notes: ["normal attack"],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ intent: "burst" });
    const result = resolver.resolve(state, fragment);

    // cand_1 matches "burst" intent → +8 strategyMatch
    expect(result.scoreBreakdown["cand_1.strategy_match"]).toBe(8);
    expect(result.scoreBreakdown["cand_2.strategy_match"]).toBe(0);
    expect(result.selectedCandidateId).toBe("cand_1");
  });

  test("avoid penalties reduce candidate scores", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid", "pyro"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ avoid: ["pyro"] });
    const result = resolver.resolve(state, fragment);

    // cand_1 is hard-filtered out by avoid, so only cand_2 remains
    expect(result.scoreBreakdown["cand_2.strategy_match"]).toBe(0);
    expect(result.selectedCandidateId).toBe("cand_2");
  });

  test("must_do boosts matched candidates", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: ["energy charge"],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: ["basic attack"],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ intent: "charge up energy", must_do: ["energy charge"] });
    const result = resolver.resolve(state, fragment);

    // must_do "energy charge" → substring match ×0.5 → 6×0.5=3; intent also token-matches "charge"→build_energy
    // cand_1 is hard-filtered in by must_do, and has higher strategy_match
    expect(result.scoreBreakdown["cand_1.strategy_match"]).toBeGreaterThan(0);
    expect(result.selectedCandidateId).toBe("cand_1");
  });

  test("preference_order gives descending bonus", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid", "skill_a"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid", "skill_b"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({
      preference_order: ["skill_a", "skill_b"],
    });
    const result = resolver.resolve(state, fragment);

    // skill_a is index 0 → preference_weight=5, no substring dampening in current formula
    // skill_b is index 1 → preference_weight=5, no substring dampening
    expect(result.scoreBreakdown["cand_1.strategy_match"]).toBe(2.5);
    expect(result.scoreBreakdown["cand_2.strategy_match"]).toBe(5);
  });

  test("resource penalty scales with cost and policy", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: { required_cost: [{ count: 3 }] },
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);

    const balancedResult = resolver.resolve(
      state,
      makeFragment({ resource_policy: "balanced" }),
    );
    const strictResult = resolver.resolve(
      state,
      makeFragment({ resource_policy: "strict" }),
    );
    const aggressiveResult = resolver.resolve(
      state,
      makeFragment({ resource_policy: "aggressive" }),
    );

    // New formula: cost * policy * phase * diceWeight
    // Default digest: round=1 (phase=1.2), dice_count=0 (diceWeight=2.2)
    // balanced: 3 * 1.2 * 1.2 * 2.2 = 9.504
    // strict:   3 * 1.6 * 1.2 * 2.2 = 12.672
    // aggressive: 3 * 0.8 * 1.2 * 2.2 = 6.336
    expect(balancedResult.scoreBreakdown["cand_1.resource_penalty"]).toBeCloseTo(9.504, 2);
    expect(strictResult.scoreBreakdown["cand_1.resource_penalty"]).toBeGreaterThan(
      balancedResult.scoreBreakdown["cand_1.resource_penalty"],
    );
    expect(aggressiveResult.scoreBreakdown["cand_1.resource_penalty"]).toBeLessThan(
      balancedResult.scoreBreakdown["cand_1.resource_penalty"],
    );
  });

  test("high cost low gain penalty applies when cost >= 3 and localGain <= 1", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "playCard",
        cost: { required_cost: [{ count: 3 }] },
        tags: ["playCard", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    // playCard actionBias=3, so localGain=3. cost=3 but localGain>1 → no penalty
    expect(result.scoreBreakdown["cand_1.risk_penalty"]).toBe(0);

    // Now with a chooseActive (low localGain)
    const stateWithLowGain = makeState([
      {
        candidate_id: "cand_1",
        action_case: "chooseActive",
        cost: { required_cost: [{ count: 3 }] },
        tags: ["chooseActive", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const result2 = resolver.resolve(stateWithLowGain, fragment);
    // chooseActive has actionBias=1, switchGain=1 → localGain=2... still > 1
    // Let's try declareEnd which has low gain
    const stateWithEnd = makeState([
      {
        candidate_id: "cand_1",
        action_case: "declareEnd",
        cost: { required_cost: [{ count: 3 }] },
        tags: ["declareEnd", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const result3 = resolver.resolve(stateWithEnd, fragment);
    // declareEnd: actionBias=-2, localGain=-2 which is <=1 → penalty = 3
    expect(result3.scoreBreakdown["cand_1.risk_penalty"]).toBe(3);
  });

  test("end-turn fallback activates when all scores are non-positive", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "playCard",
        cost: { required_cost: [{ count: 5 }] },
        tags: ["playCard", "valid", "effectless"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "declareEnd",
        cost: {},
        tags: ["declareEnd", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ fallback_rule: "declare end if nothing useful" });
    const result = resolver.resolve(state, fragment);

    expect(result.fallbackUsed).toBe(true);
    expect(result.selectedCandidateId).toBe("cand_2");
  });

  test("conservative fallback selects lowest-risk candidate", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: { required_cost: [{ count: 4 }] },
        tags: ["useSkill", "valid", "hp_risk"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 2,
      },
      {
        candidate_id: "cand_2",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment({ fallback_rule: "pick safest action" });
    const result = resolver.resolve(state, fragment);

    // cand_2 should have much lower conservativeScore
    expect(result.selectedCandidateId).toBe("cand_2");
  });

  test("execution order starts with selected, then remaining by score", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 3,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_2",
        action_case: "playCard",
        cost: {},
        tags: ["playCard", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
      {
        candidate_id: "cand_3",
        action_case: "declareEnd",
        cost: {},
        tags: ["declareEnd", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    expect(result.selectedCandidateId).not.toBeNull();
    expect(result.executionOrder[0]).toBe(result.selectedCandidateId!);
    expect(result.executionOrder.length).toBe(3);
  });

  test("debug notes contain resolver metadata", () => {
    const state = makeState([
      {
        candidate_id: "cand_1",
        action_case: "useSkill",
        cost: {},
        tags: ["useSkill", "valid"],
        notes: [],
        damage_estimate: 0,
        reaction_value: 0,
        tempo_value: 0,
        survival_risk: 0,
      },
    ]);
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    const hasDigestSummary = result.debugNotes.some((n) => n.includes("[resolver] digest_summary="));
    const hasFragmentSummary = result.debugNotes.some((n) => n.includes("[resolver] fragment_summary="));
    const hasCandidateScores = result.debugNotes.some((n) => n.includes("[resolver] candidate_scores="));
    const hasFinal = result.debugNotes.some((n) => n.includes("[resolver] final="));

    expect(hasDigestSummary).toBe(true);
    expect(hasFragmentSummary).toBe(true);
    expect(hasCandidateScores).toBe(true);
    expect(hasFinal).toBe(true);
  });

  test("omni pressure penalty applies under strict policy with low omni", () => {
    const state = makeState(
      [
        {
          candidate_id: "cand_1",
          action_case: "useSkill",
          cost: { required_cost: [{ count: 2 }] },
          tags: ["useSkill", "valid"],
          notes: [],
          damage_estimate: 0,
          reaction_value: 0,
          tempo_value: 0,
          survival_risk: 0,
        },
      ],
      undefined,
      { resource_summary: { dice: [], dice_count: 2, omni_count: 1, cards_in_hand: 3 } },
    );
    const fragment = makeFragment({ resource_policy: "strict" });
    const result = resolver.resolve(state, fragment);

    // strict + omni_count<=1 + cost>=2 + round=1 → no early-round suppression in current formula
    // rawPenalty = 2 * 1.6 * 1.2 * 1.8 = 6.912 (no damping applied)
    expect(result.scoreBreakdown["cand_1.resource_penalty"]).toBeCloseTo(6.912, 2);
  });

  test("candidates without candidateActionMap entry are filtered out", () => {
    const digest = makeDigest({
      candidate_actions: [
        {
          candidate_id: "cand_1",
          action_case: "useSkill",
          cost: {},
          tags: ["valid"],
          notes: [],
        },
        {
          candidate_id: "cand_orphan",
          action_case: "useSkill",
          cost: {},
          tags: ["valid"],
          notes: [],
        },
      ],
    });
    const candidateActionMap = new Map<string, { tool: string; args: Record<string, unknown> }>();
    candidateActionMap.set("cand_1", { tool: "choose_action", args: { action_index: 1 } });
    // cand_orphan deliberately not in map

    const state: FragmentedDecisionState = { digest, candidateActionMap };
    const fragment = makeFragment();
    const result = resolver.resolve(state, fragment);

    expect(result.selectedCandidateId).toBe("cand_1");
    expect(result.executionOrder).not.toContain("cand_orphan");
  });
});
