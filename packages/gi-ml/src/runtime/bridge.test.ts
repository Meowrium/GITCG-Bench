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
import { GiMlRuntimeBridge, fromArtifactAndBank } from "./bridge.js"
import type { MlConceptBank, MlDecisionPoint } from "../contracts/index.js"
import type { SlotLinearRankerArtifact } from "../ranker/index.js"
import type { LinearValueArtifact } from "../value/index.js"

test("GiMlRuntimeBridge filters unsupported concepts and ranks with bank-backed evidence", async () => {
  const bank: MlConceptBank = {
    bank_version: "bank_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    compatibility: {
      feature_version: "feature_v1",
    },
    concepts: [
      {
        concept_id: "concept:burst-window",
        name: "burst-window",
        scope: "state",
        description: "burst timing",
        evidence_refs: ["bank:burst"],
        status: "validated",
      },
      {
        concept_id: "concept:combo-setup-burst",
        name: "combo-setup-burst",
        scope: "aggregate_candidate",
        description: "two-step setup into burst",
        evidence_refs: ["bank:combo"],
        tags: ["combat_window_combo", "multi_step"],
        status: "validated",
      },
    ],
  }
  const artifact: SlotLinearRankerArtifact = {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: "artifact_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    compatibility: {
      runtime_digest_version: "digest_v1",
    },
    config: {
      action_case_bias: {
        useSkill: 0.2,
        declareEnd: -0.2,
      },
      concept_presence_weights: {
        "concept:burst-window": 1,
      },
    },
  }

  const bridge = fromArtifactAndBank(artifact, bank)
  const query: MlDecisionPoint = {
    query_id: "q1",
    source: "runtime",
    state_ref: "state:1",
    matchup_ref: null,
    deck_refs: null,
    candidate_ids: ["c1", "c2"],
    evidence_refs: [],
    context_slots: null,
  }

  const result = await bridge.rankActions({
    query,
    candidates: [
      {
        candidate_id: "c1",
        query_id: "q1",
        action_case: "declareEnd",
      },
      {
        candidate_id: "c2",
        query_id: "q1",
        action_case: "useSkill",
      },
    ],
    concept_state: {
      query_id: "q1",
      values: [
        {
          concept_id: "concept:burst-window",
          confidence: 0.9,
          evidence_refs: ["runtime:burst"],
        },
        {
          concept_id: "concept:unknown",
          confidence: 0.5,
        },
        {
          concept_id: "concept:combo-setup-burst",
          confidence: 0.8,
          evidence_refs: ["runtime:combo"],
        },
      ],
    },
  })

  expect(result.manifest).toMatchObject({
    artifact_version: "artifact_v1",
    concept_bank_version: "bank_v1",
    ranker_model_ref: "slot_linear_ranker.v1",
  })
  expect(result.concept_state.values).toEqual([
    {
      concept_id: "concept:burst-window",
      value_slot: null,
      confidence: 0.9,
      evidence_refs: ["bank:burst", "runtime:burst"],
    },
    {
      concept_id: "concept:combo-setup-burst",
      value_slot: null,
      confidence: 0.8,
      evidence_refs: ["bank:combo", "runtime:combo"],
    },
  ])
  expect(result.concept_state.summary_slots).toMatchObject({
    active_concept_count: 2,
    active_combo_concept_ids: ["concept:combo-setup-burst"],
    missing_concept_ids: [],
    missing_combo_concept_ids: [],
    unsupported_concept_ids: ["concept:unknown"],
  })
  expect(result.ranked_actions[0]?.candidate_id).toBe("c2")
})

test("GiMlRuntimeBridge.load reads concept bank and artifact from files", async () => {
  const artifactPath = new URL("../../output/ranker-artifact.smoke.json", import.meta.url).pathname
  const bankPath = new URL("../../output/concept-bank.smoke.json", import.meta.url).pathname

  const bridge = await GiMlRuntimeBridge.load({
    conceptBankPath: bankPath,
    rankerArtifactPath: artifactPath,
  })

  expect(bridge.manifest.artifact_version).toBeDefined()
  expect(bridge.manifest.concept_bank_version).toBeDefined()
})

test("GiMlRuntimeBridge predicts observation value when a value artifact is attached", () => {
  const artifact: SlotLinearRankerArtifact = {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: "artifact_v1",
    created_at: "2026-03-22T00:00:00.000Z",
    config: {},
  }
  const valueArtifact: LinearValueArtifact = {
    artifact_type: "linear_value_baseline.v1",
    artifact_version: "value_v1",
    created_at: "2026-04-02T00:00:00.000Z",
    bias: 0.1,
    feature_weights: {
      "self.hand_count": 0.05,
      "self.dice_count": 0.02,
      "derived.self_resource_score": 0.08,
      "opponent.total_health": -0.01,
    },
    metadata: {
      dataset_id: "value_fixture",
      sample_count: 3,
    },
  }

  const bridge = fromArtifactAndBank(artifact, null, null, valueArtifact)
  const result = bridge.predictObservationValue({
    schema_version: "obs.v1",
    source: {
      game_version: "v6.3.0",
      card_pool_version: "v6.3.0",
      ruleset_version: "default",
      contract_version: "obs.v1",
      view_kind: "policy_public",
    },
    point: {
      game_id: "g1",
      episode_id: "e1",
      decision_point_id: "dp1",
      round_number: 3,
      phase: "action",
      pending_method: "action",
      actor_who: 0,
      current_turn: 0,
      action_count_in_round: 2,
    },
    self: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 1, definition_id: 11, alive: true, is_active: true, health: 9, max_health: 10, energy: 1, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 6, omni_count: 1, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 4 },
      pile_count: 10,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
    },
    opponent: {
      active_character_index: 0,
      characters: [{ slot_index: 0, id: 2, definition_id: 21, alive: true, is_active: true, health: 7, max_health: 10, energy: 0, max_energy: 2, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { counts_by_type: {}, total_count: 5, omni_count: 0, unspecified_count: 0 },
      hand: { visible_cards: [], card_count: 3 },
      pile_count: 8,
      discard_count: null,
      declared_end: false,
      can_charged: null,
      can_plunging: null,
      has_defeated: null,
      legend_used: false,
    },
    public_state: {
      winner: null,
      self_declared_end: false,
      opponent_declared_end: false,
      self_support_count: 0,
      opponent_support_count: 0,
      self_summon_count: 0,
      opponent_summon_count: 0,
    },
    hidden_estimate: null,
    derived: {
      self_damage_capacity_now: 1,
      opp_damage_capacity_now: 0.5,
      self_ko_pressure_now: 0.3,
      opp_ko_pressure_now: 0.1,
      self_resource_score: 5,
      opp_resource_score: 3,
      self_reaction_ready_score: 0,
      opp_reaction_ready_score: 0,
      self_burst_online_count: 0,
      opp_burst_online_count: 0,
      self_role_integrity_score: 1,
      opp_role_integrity_score: 1,
      self_window_score: 4,
      opp_window_score: 2,
      self_setup_window_score: 0,
      opp_setup_window_score: 0,
      self_reserve_value_score: 0,
      opp_reserve_value_score: 0,
      game_setup_completion: -1,
      game_phase_estimate: -1,
      game_primary_path_viable: -1,
      dice_efficiency: 0,
      summon_pressure: 0,
      action_economy_ratio: 1,
      elemental_application_map: {},
    },
  })

  expect(result).not.toBeNull()
  expect(result?.summary_slots).toMatchObject({
    artifact_version: "value_v1",
    round: 3,
    pending_method: "action",
  })
  expect(result?.predicted_value).toBeGreaterThan(0)
  expect(result?.predicted_value).toBeLessThanOrEqual(1)
  expect(bridge.manifest.value_model_ref).toBe("value_v1")
})
