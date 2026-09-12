import { expect, test } from "vitest"
import { chooseSearchGuidedActionIndex } from "./policy-player-io.js"
import type { PolicyDecision } from "../policy/types.js"
import type { SearchResult } from "../search/types.js"

test("chooseSearchGuidedActionIndex lets strong search guidance overturn a short-sighted local rank", () => {
  const validActions = [
    {
      index: 0,
      action: {
        type: "useSkill",
        skill: {
          definition: { id: 13061 },
        },
      },
    },
    {
      index: 1,
      action: {
        type: "playCard",
        skill: {
          definition: { id: 0 },
          caller: { definition: { id: 321010 } },
        },
      },
    },
  ]
  const decision: PolicyDecision = {
    selectedCandidateId: "0",
    ranked: [
      {
        candidateId: "0",
        actionCase: "useSkill",
        heuristicScore: 2,
        finalScore: 2,
        reasons: [],
        candidate: { candidate_id: "0", action_case: "useSkill" },
      },
      {
        candidateId: "1",
        actionCase: "playCard",
        heuristicScore: 1.2,
        finalScore: 1.2,
        reasons: [],
        candidate: { candidate_id: "1", action_case: "playCard" },
      },
    ],
    macroPlanState: null,
    guidanceNotes: [],
  }
  const searchResults: SearchResult[] = [
    {
      path: [{ type: "playCard", definitionId: 321010, isFast: false }],
      stateAfter: {} as never,
      score: 10,
      deltas: [],
      feasibility: 1,
    },
    {
      path: [{ type: "useSkill", definitionId: 13061, isFast: false }],
      stateAfter: {} as never,
      score: 1,
      deltas: [],
      feasibility: 1,
    },
  ]

  const chosen = chooseSearchGuidedActionIndex(validActions, decision, searchResults, 1.2)

  expect(chosen).toBe(1)
})

test("chooseSearchGuidedActionIndex matches elemental tuning by sacrificed card and target dice", () => {
  const validActions = [
    {
      index: 0,
      action: {
        type: "elementalTuning",
        card: {
          definition: { id: 331302 },
        },
        result: 3,
      },
    },
    {
      index: 1,
      action: {
        type: "useSkill",
        skill: {
          definition: { id: 13061 },
        },
      },
    },
  ]
  const decision: PolicyDecision = {
    selectedCandidateId: "1",
    ranked: [
      {
        candidateId: "1",
        actionCase: "useSkill",
        heuristicScore: 1.5,
        finalScore: 1.5,
        reasons: [],
        candidate: { candidate_id: "1", action_case: "useSkill" },
      },
      {
        candidateId: "0",
        actionCase: "elementalTuning",
        heuristicScore: 1.1,
        finalScore: 1.1,
        reasons: [],
        candidate: { candidate_id: "0", action_case: "elementalTuning" },
      },
    ],
    macroPlanState: null,
    guidanceNotes: [],
  }
  const searchResults: SearchResult[] = [
    {
      path: [{
        type: "elementalTuning",
        definitionId: 3,
        tuningCardDefinitionId: 331302,
        isFast: true,
      }],
      stateAfter: {} as never,
      score: 8,
      deltas: [],
      feasibility: 1,
    },
  ]

  const chosen = chooseSearchGuidedActionIndex(validActions, decision, searchResults, 1)

  expect(chosen).toBe(0)
})
