// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { expect, test } from "vitest";
import { flattenDeckMatchupPriors, scoreDeckPriorFeatures } from "../../learning/features/deck-prior-flattener.js";
import type {
  DeckFeaturesV2,
  MatchupFeaturesV2,
} from "../../../../llm-deck-analyzer/src/index.js";

const deck = (overrides?: Partial<DeckFeaturesV2>): DeckFeaturesV2 => ({
  deckCode: "a",
  version: "v2",
  dense: {
    characterCount: 3,
    elementCounts: {},
    nationCounts: {},
    weaponCounts: {},
    actionCardTypeCounts: {},
    actionCardSubtypeCounts: {},
    costCurve: { cost0: 0, cost1: 0, cost2: 0, cost3Plus: 0, averageCost: 1 },
    tempoProfile: {
      setupSpeed: 0.8,
      tempoPush: 0.7,
      longGameValue: 0.6,
      defensiveStability: 0.5,
      finisherDensity: 0.4,
    },
    strategyProfile: {
      reactionReliance: 0.3,
      supportReliance: 0.4,
      talentReliance: 0.2,
      equipmentReliance: 0.1,
      summonReliance: 0.05,
      dependencyRisk: 0.2,
    },
  },
  sparse: [],
  actionCards: {
    presence: [],
    counts: [],
    functionTags: [],
    packages: [],
    dependencies: [],
    thresholds: [],
    tempoProfile: {
      lowCostStarters: 0,
      diceFixers: 0,
      burstAmplifiers: 0,
      defensiveTools: 0,
      longGameEngines: 0,
    },
  },
  graph: { nodes: [], edges: [] },
  labels: {
    archetypes: ["support_engine"],
    plans: [],
    risks: [],
    routes: ["reaction_route", "carry_route"],
    packages: [],
  },
  diagnostics: {
    extractorVersion: "test",
    warnings: [],
    assumptions: [],
    coverage: { characterCoverage: 1, actionCardCoverage: 1, graphCoverage: 1 },
  },
  ...overrides,
});

const matchup = (overrides?: Partial<MatchupFeaturesV2>): MatchupFeaturesV2 => ({
  deckA: "a",
  deckB: "b",
  version: "v2",
  dense: {
    setupSpeedDelta: 0.2,
    longGameValueDelta: 0.1,
    supportGreedDelta: -0.1,
    defensiveStabilityDelta: 0.05,
    finisherDensityDelta: 0.08,
    punishGreedySetupDelta: 0.12,
    antiSummonDelta: 0,
    antiSupportDelta: 0.03,
    routeConflictScore: 2,
    dependencyPunishScore: -0.05,
  },
  sparse: [],
  graph: { nodes: [], edges: [] },
  labels: {
    tempoAxes: [],
    pressureAxes: [],
    routeConflicts: [],
    keyPackages: [],
    risks: [],
  },
  diagnostics: {
    extractorVersion: "test",
    warnings: [],
    assumptions: [],
    coverage: {
      characterCoverage: 1,
      actionCardCoverage: 1,
      graphCoverage: 1,
      matchupCrossCoverage: 1,
    },
  },
  ...overrides,
});

test("flattenDeckMatchupPriors maps dense and label fields", () => {
  const result = flattenDeckMatchupPriors(deck(), deck({ deckCode: "b", labels: { archetypes: [], plans: [], risks: [], routes: ["resource_route"], packages: [] } }), matchup());
  expect(result.selfDeckSetupSpeed).toBe(0.8);
  expect(result.selfRouteReaction).toBe(1);
  expect(result.selfArchetypeSupportEngine).toBe(1);
  expect(result.opponentRouteResource).toBe(1);
  expect(result.matchupRouteConflictScore).toBe(2);
});

test("scoreDeckPriorFeatures prefers stronger self priors", () => {
  const strong = flattenDeckMatchupPriors(deck(), deck({ deckCode: "b", dense: { ...deck().dense, tempoProfile: { ...deck().dense.tempoProfile, setupSpeed: 0.2 } } }), matchup());
  const weak = flattenDeckMatchupPriors(deck({ dense: { ...deck().dense, tempoProfile: { ...deck().dense.tempoProfile, setupSpeed: 0.2 } } }), deck({ deckCode: "b" }), matchup({ dense: { ...matchup().dense, setupSpeedDelta: -0.2 } }));
  expect(scoreDeckPriorFeatures(strong)).toBeGreaterThan(scoreDeckPriorFeatures(weak));
});
