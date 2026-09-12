// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { expect, test } from "vitest"
import type { MlDecisionPoint } from "../contracts/index.js"
import { LinearConceptModelPredictor } from "./concept-model.js"

test("LinearConceptModelPredictor predicts state and state-action concepts", () => {
  const predictor = new LinearConceptModelPredictor({
    artifact_type: "concept_model.linear.v1",
    artifact_version: "concept_model_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    bank_version: "bank_v1",
    compatibility: null,
    concepts: [
      {
        concept_id: "concept:late-round",
        scope: "state",
        bias: -1,
        feature_weights: {
          "query::round": 0.5,
        },
      },
      {
        concept_id: "concept:burst-window",
        scope: "state_action",
        bias: -1,
        feature_weights: {
          "candidate::action_case::useSkill": 1,
          "candidate::tag::burst": 1,
        },
      },
    ],
    metadata: null,
  })

  const query: MlDecisionPoint = {
    query_id: "q1",
    source: "runtime",
    state_ref: "state:q1",
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: ["q1:c1", "q1:c2"],
    evidence_refs: [],
    context_slots: {
      round: 5,
    },
  }

  const state = predictor.predict(query, [
    {
      candidate_id: "q1:c1",
      query_id: "q1",
      action_case: "useSkill",
      runtime_slots: {
        candidate_tags: ["burst"],
      },
    },
    {
      candidate_id: "q1:c2",
      query_id: "q1",
      action_case: "declareEnd",
      runtime_slots: {
        candidate_tags: ["end_turn"],
      },
    },
  ])

  expect(state.values).toHaveLength(2)
  expect(state.values[0]).toMatchObject({
    concept_id: "concept:burst-window",
    value_slot: {
      predicted: true,
      top_candidate_id: "q1:c1",
    },
  })
  expect(state.values[1]).toMatchObject({
    concept_id: "concept:late-round",
    value_slot: {
      predicted: true,
      scope: "state",
    },
  })
})

test("aggregate_candidate scope averages candidate probabilities, not sequential windows", () => {
  const predictor = new LinearConceptModelPredictor({
    artifact_type: "concept_model.linear.v1",
    artifact_version: "concept_model_v2",
    created_at: "2026-03-22T00:00:00.000Z",
    bank_version: "bank_v1",
    compatibility: null,
    concepts: [
      {
        concept_id: "concept:reaction-window",
        scope: "aggregate_candidate",
        bias: -0.5,
        feature_weights: {
          "candidate::tag::reaction_enable": 2,
          "query::round": 0.2,
        },
      },
      {
        concept_id: "concept:low-immediate-score-opens-lethal",
        scope: "aggregate_candidate",
        bias: -1,
        feature_weights: {
          "candidate::tag::setup": 1.5,
          "query::round": 0.3,
        },
      },
    ],
    metadata: null,
  })

  const query: MlDecisionPoint = {
    query_id: "q2",
    source: "runtime",
    state_ref: "state:q2",
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: ["q2:c1", "q2:c2", "q2:c3"],
    evidence_refs: [],
    context_slots: { round: 2 },
  }

  // Candidate 1: strong immediate reaction, C2: setup that enables lethal, C3: declareEnd
  const state = predictor.predict(query, [
    {
      candidate_id: "q2:c1",
      query_id: "q2",
      action_case: "useSkill",
      runtime_slots: { candidate_tags: ["reaction_enable", "direct_damage"] },
    },
    {
      candidate_id: "q2:c2",
      query_id: "q2",
      action_case: "playCard",
      runtime_slots: { candidate_tags: ["setup", "timing:endPhase"] },
    },
    {
      candidate_id: "q2:c3",
      query_id: "q2",
      action_case: "declareEnd",
      runtime_slots: { candidate_tags: ["end_turn"] },
    },
  ])

  expect(state.values).toHaveLength(2)

  // Both aggregate_candidate concepts should have scope "aggregate_candidate"
  for (const v of state.values) {
    expect(v.value_slot?.scope).toBe("aggregate_candidate")
  }

  // The aggregate scope averages probabilities — it does NOT distinguish
  // between a single low-score action that opens lethal and a high-score greed.
  // This is the documented limitation: aggregate_candidate ≠ true window model.
})
