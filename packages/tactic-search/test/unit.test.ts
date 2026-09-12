// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { describe, test, expect, beforeEach } from "bun:test";
import { ComboRegistry } from "../src/combo-registry";
import {
  toRecommendations,
  formatAnnotation,
  toCandidatePolicies,
  toTurnPriorities,
} from "../src/mcp-output";
import { StateEvaluator, DEFAULT_WEIGHTS } from "../src/state-evaluator";
import type {
  ComboEntry,
  StateDelta,
  SearchResult,
  ActionDescription,
} from "../src/types";

// ─── Test Helpers ───

function makeDelta(overrides: Partial<StateDelta> = {}): StateDelta {
  return {
    damageDealt: 0,
    reactions: [],
    defeatedCount: 0,
    diceSpent: 0,
    diceGained: 0,
    cardsDrawn: 0,
    energyDelta: 0,
    entitiesCreated: 0,
    entitiesRemoved: 0,
    turnsConsumed: 0,
    opponentWindowsGiven: 0,
    myActiveChanged: false,
    oppActiveForced: false,
    healingDone: 0,
    myHealthLost: 0,
    diceFeasibility: 1.0,
    handDependencyTurns: 0,
    ...overrides,
  };
}

function makeComboEntry(overrides: Partial<ComboEntry> = {}): ComboEntry {
  return {
    id: "test-combo-001",
    deckContext: {
      characters: [1201, 1202, 1601],
      requiredCards: [],
    },
    preconditions: {
      phase: "early",
      myActive: { definitionId: 1601 },
      minDice: 6,
    },
    actionSequence: [
      { step: 1, type: "useSkill", definitionId: 12011, isFast: false },
      { step: 2, type: "useSkill", definitionId: 16012, isFast: false },
    ],
    evaluation: {
      totalScore: 25.0,
      delta: makeDelta({
        damageDealt: 8,
        diceSpent: 6,
        turnsConsumed: 2,
        diceFeasibility: 0.85,
      }),
      scoreBreakdown: { damage: 16, diceCost: -9 },
      riskFactors: {
        opponentResponseWindows: 1,
        comboBreakProbability: 0.15,
        resourceOvercommit: false,
      },
    },
    discoveredBy: "beam-search",
    gameVersion: "6.4.0",
    sampleCount: 1,
    avgWinrateContribution: 0,
    ...overrides,
  };
}

// ─── MCP Output Tests ───

describe("MCP Output: toRecommendations", () => {
  test("empty combos → empty recommendations", () => {
    expect(toRecommendations([])).toEqual([]);
  });

  test("single combo → priority ≥ 1", () => {
    const combos = [makeComboEntry()];
    const recs = toRecommendations(combos);
    expect(recs).toHaveLength(1);
    expect(recs[0].combo_id).toBe("test-combo-001");
    expect(recs[0].priority).toBeGreaterThanOrEqual(1);
    expect(recs[0].action_sequence).toHaveLength(2);
  });

  test("multiple combos → priorities ordered by score", () => {
    const combos = [
      makeComboEntry({
        id: "low",
        evaluation: {
          ...makeComboEntry().evaluation,
          totalScore: 10,
        },
      }),
      makeComboEntry({
        id: "high",
        evaluation: {
          ...makeComboEntry().evaluation,
          totalScore: 50,
        },
      }),
      makeComboEntry({
        id: "mid",
        evaluation: {
          ...makeComboEntry().evaluation,
          totalScore: 30,
        },
      }),
    ];

    const recs = toRecommendations(combos);
    const priorities = recs.map((r) => ({ id: r.combo_id, p: r.priority }));

    // Higher score → higher priority
    const highRec = recs.find((r) => r.combo_id === "high")!;
    const lowRec = recs.find((r) => r.combo_id === "low")!;
    expect(highRec.priority).toBeGreaterThan(lowRec.priority);
  });

  test("action_sequence maps tool types correctly", () => {
    const combos = [
      makeComboEntry({
        actionSequence: [
          {
            step: 1,
            type: "switchActive",
            definitionId: 1201,
            isFast: true,
          },
          {
            step: 2,
            type: "useSkill",
            definitionId: 12012,
            isFast: false,
          },
          {
            step: 3,
            type: "elementalTuning",
            definitionId: 30001,
            isFast: true,
          },
        ],
      }),
    ];

    const recs = toRecommendations(combos);
    expect(recs[0].action_sequence[0].tool).toBe("choose_active");
    expect(recs[0].action_sequence[1].tool).toBe("choose_action");
    expect(recs[0].action_sequence[2].tool).toBe("elemental_tuning");
  });

  test("evaluation fields are calculated", () => {
    const combos = [makeComboEntry()];
    const recs = toRecommendations(combos);
    const ev = recs[0].evaluation;

    expect(ev.total_score).toBe(25.0);
    expect(ev.damage_dealt).toBe(8);
    expect(ev.dice_efficiency).toBeCloseTo(8 / 6, 2);
    expect(ev.turns_consumed).toBe(2);
    expect(ev.dice_feasibility).toBe(0.85);
  });
});

describe("MCP Output: formatAnnotation", () => {
  test("produces correct annotation format", () => {
    const combo = makeComboEntry();
    const annotation = formatAnnotation(combo);

    expect(annotation).toContain("[useSkill:12011(combat)]");
    expect(annotation).toContain("[useSkill:16012(combat)]");
    expect(annotation).toContain("→");
    expect(annotation).toContain("dmg=8");
    expect(annotation).toContain("dice=6");
    expect(annotation).toContain("turns=2");
    expect(annotation).toContain("feas=0.85");
  });
});

describe("MCP Output: toCandidatePolicies", () => {
  test("creates candidate policies from combos", () => {
    const combos = [makeComboEntry()];
    const policies = toCandidatePolicies(combos);

    expect(policies).toHaveLength(1);
    expect(policies[0].id).toBe("test-combo-001");
    expect(policies[0].action_template.tool).toBe("choose_action");
  });
});

describe("MCP Output: toTurnPriorities", () => {
  test("groups combos by phase", () => {
    const combos = [
      makeComboEntry({
        id: "early1",
        preconditions: { phase: "early" },
      }),
      makeComboEntry({
        id: "mid1",
        preconditions: { phase: "mid" },
      }),
    ];

    const priorities = toTurnPriorities(combos);
    expect(priorities.length).toBe(2);
    expect(priorities[0].turn).toBe(1); // early
    expect(priorities[1].turn).toBe(3); // mid
  });
});

// ─── StateEvaluator Unit Tests ───

describe("StateEvaluator", () => {
  let evaluator: StateEvaluator;

  beforeEach(() => {
    evaluator = new StateEvaluator();
  });

  test("default weights are all positive", () => {
    for (const [key, value] of Object.entries(DEFAULT_WEIGHTS)) {
      expect(value).toBeGreaterThan(0);
    }
  });

  test("custom weights override defaults", () => {
    const custom = new StateEvaluator({ damageBase: 10.0 });
    const weights = custom.getWeights();
    expect(weights.damageBase).toBe(10.0);
    expect(weights.killBonus).toBe(DEFAULT_WEIGHTS.killBonus);
  });

  test("score of zero delta is zero", () => {
    const delta = makeDelta();
    const score = evaluator.score(delta, { perspective: 0, isFast: false });
    expect(score).toBe(0);
  });

  test("damage dealt produces positive score", () => {
    const delta = makeDelta({ damageDealt: 5 });
    const score = evaluator.score(delta, { perspective: 0, isFast: false });
    expect(score).toBeGreaterThan(0);
  });

  test("dice spent produces negative contribution", () => {
    const delta = makeDelta({ diceSpent: 4 });
    const score = evaluator.score(delta, { perspective: 0, isFast: false });
    expect(score).toBeLessThan(0);
  });

  test("defeat bonus is significant", () => {
    const noDemise = makeDelta({ damageDealt: 10 });
    const withDemise = makeDelta({ damageDealt: 10, defeatedCount: 1 });

    const scoreNoDemise = evaluator.score(noDemise, {
      perspective: 0,
      isFast: false,
    });
    const scoreWithDemise = evaluator.score(withDemise, {
      perspective: 0,
      isFast: false,
    });

    expect(scoreWithDemise).toBeGreaterThan(scoreNoDemise);
    expect(scoreWithDemise - scoreNoDemise).toBeGreaterThan(10);
  });
});

// ─── ComboRegistry Unit Tests ───

describe("ComboRegistry", () => {
  let registry: ComboRegistry;

  beforeEach(() => {
    registry = new ComboRegistry();
  });

  test("starts empty", () => {
    expect(registry.size).toBe(0);
  });

  test("export/import roundtrip", () => {
    // Manual insertion via import
    const entry = makeComboEntry();
    registry.importAll([entry]);

    expect(registry.size).toBe(1);
    expect(registry.get("test-combo-001")).toBeDefined();

    const exported = registry.exportAll();
    expect(exported).toHaveLength(1);
    expect(exported[0].id).toBe("test-combo-001");
  });

  test("import then export preserves data", () => {
    const entries = [
      makeComboEntry({ id: "a" }),
      makeComboEntry({ id: "b" }),
    ];
    registry.importAll(entries);
    expect(registry.size).toBe(2);

    const exported = registry.exportAll();
    const ids = exported.map((e) => e.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  test("clear removes all", () => {
    registry.importAll([makeComboEntry()]);
    expect(registry.size).toBe(1);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  test("remove by id", () => {
    registry.importAll([makeComboEntry({ id: "x" })]);
    expect(registry.get("x")).toBeDefined();
    registry.remove("x");
    expect(registry.get("x")).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});
