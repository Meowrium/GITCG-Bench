// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { describe, expect, it } from "vitest"
import { V30NeuralPredictor, type EncoderWeightsBundle } from "./neural-predictor.js"
import { STATE_OBSERVATION_SCHEMA_VERSION, type StateObservation } from "./state-observation.js"

/**
 * Build a synthetic, deterministic weights bundle whose forward pass we can
 * predict by hand: every weight is zero except biases set so that V(s)=0,
 * advantages all equal a constant per case, hence Q(s,a) = 0 for all valid
 * candidates and winProb = 0.5 exactly.
 *
 * This isn't a numerical test of the math (that's the job of the Python
 * round-trip in CI when `torch` is available); it's a structural test that
 * the predictor can ingest the bundle, walk every embedding/MLP path without
 * dimensional mismatches, and produce one output per candidate.
 */
function zeroTensor(shape: number[]): { shape: number[]; dtype: string; values: number[] } {
  const total = shape.reduce((a, b) => a * b, 1)
  return { shape, dtype: "float32", values: new Array(total).fill(0) }
}

function buildSyntheticBundle(): EncoderWeightsBundle {
  const E = 8
  const H = 16
  const S = 16 // state_repr_dim
  const A = 12 // action_repr_dim
  const VOCAB_SIZE = 4
  const COST_BUCKETS = 11
  const PREVIEW_VECTOR_DIM = 29 + 9 + 8

  const sd: Record<string, ReturnType<typeof zeroTensor>> = {}
  // Embeddings
  sd["aura_emb.weight"] = zeroTensor([8, 4])
  sd["case_emb.weight"] = zeroTensor([6, 8])
  sd["char_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["summon_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["support_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["cs_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["cstat_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["hand_emb.weight"] = zeroTensor([VOCAB_SIZE, E])
  sd["target_emb.weight"] = zeroTensor([VOCAB_SIZE, E])

  // MLPs (Linear, GELU, Dropout, Linear)
  // char_proj: in = E + 4 + E
  const charIn = E + 4 + E
  sd["char_proj.0.weight"] = zeroTensor([H, charIn])
  sd["char_proj.0.bias"] = zeroTensor([H])
  sd["char_proj.3.weight"] = zeroTensor([S / 2, H])
  sd["char_proj.3.bias"] = zeroTensor([S / 2])
  // summon_proj / support_proj: in = E + 1
  for (const name of ["summon_proj", "support_proj"]) {
    sd[`${name}.0.weight`] = zeroTensor([H, E + 1])
    sd[`${name}.0.bias`] = zeroTensor([H])
    sd[`${name}.3.weight`] = zeroTensor([S / 2, H])
    sd[`${name}.3.bias`] = zeroTensor([S / 2])
  }
  // cs_proj / hand_proj: in = E
  for (const name of ["cs_proj", "hand_proj"]) {
    sd[`${name}.0.weight`] = zeroTensor([H, E])
    sd[`${name}.0.bias`] = zeroTensor([H])
    sd[`${name}.3.weight`] = zeroTensor([S / 2, H])
    sd[`${name}.3.bias`] = zeroTensor([S / 2])
  }
  // side_proj: in = 5 * 3 * (S/2) + 7 (V31 D7 side_meta) + 9
  const sideIn = 5 * 3 * (S / 2) + 7 + 9
  sd["side_proj.0.weight"] = zeroTensor([H, sideIn])
  sd["side_proj.0.bias"] = zeroTensor([H])
  sd["side_proj.3.weight"] = zeroTensor([S, H])
  sd["side_proj.3.bias"] = zeroTensor([S])
  // state_proj: in = 2*S + 3
  sd["state_proj.0.weight"] = zeroTensor([H, 2 * S + 3])
  sd["state_proj.0.bias"] = zeroTensor([H])
  sd["state_proj.3.weight"] = zeroTensor([S, H])
  sd["state_proj.3.bias"] = zeroTensor([S])
  // value_head
  sd["value_head.0.weight"] = zeroTensor([H, S])
  sd["value_head.0.bias"] = zeroTensor([H])
  sd["value_head.3.weight"] = zeroTensor([1, H])
  sd["value_head.3.bias"] = zeroTensor([1])
  // action_proj: in = E + 8 + COST_BUCKETS + PREVIEW_VECTOR_DIM + 6 (V31 flags)
  const actionIn = E + 8 + COST_BUCKETS + PREVIEW_VECTOR_DIM + 6
  sd["action_proj.0.weight"] = zeroTensor([H, actionIn])
  sd["action_proj.0.bias"] = zeroTensor([H])
  sd["action_proj.3.weight"] = zeroTensor([A, H])
  sd["action_proj.3.bias"] = zeroTensor([A])
  // advantage_head
  sd["advantage_head.0.weight"] = zeroTensor([H, S + A])
  sd["advantage_head.0.bias"] = zeroTensor([H])
  sd["advantage_head.3.weight"] = zeroTensor([1, H])
  sd["advantage_head.3.bias"] = zeroTensor([1])

  return {
    schema_version: STATE_OBSERVATION_SCHEMA_VERSION,
    h_params: {
      embed_dim: E,
      hidden_dim: H,
      state_repr_dim: S,
      action_repr_dim: A,
      dropout: 0,
    },
    vocabularies: {
      character: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: { "1101": 2, "1102": 3 } },
      summon: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: {} },
      support: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: {} },
      combat_status: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: {} },
      character_status: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: {} },
      hand_card: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: {} },
      action_target: { pad_token: 0, unk_token: 1, size: VOCAB_SIZE, id_to_index: { "11011": 2, "11012": 3 } },
    },
    constants: {
      MAX_CHARS: 4,
      MAX_SUMMONS: 6,
      MAX_SUPPORTS: 6,
      MAX_COMBAT_STATUSES: 6,
      MAX_HAND: 12,
      MAX_CANDIDATES: 64,
      DICE_BUCKETS: 9,
      COST_BUCKETS: 11,
      PREVIEW_VECTOR_DIM,
      ACTION_CASES: ["useSkill", "playCard", "switchActive", "elementalTuning", "declareEnd", "unknown"],
      AURA_VOCAB: [0, 1, 2, 3, 4, 7, 113],
    },
    state_dict: sd,
  }
}

function fakeObservation(): StateObservation {
  return {
    meta: {
      schema_version: STATE_OBSERVATION_SCHEMA_VERSION,
      game_id: "g",
      sample_index: 0,
      perspective: 0,
      round: 1,
      turn: 1,
      phase: "action",
      opponent_declared_end: false,
    },
    self: {
      side: 0,
      declared_end: false,
      legend_used: false,
      characters: [
        {
          entity_id: 1,
          definition_id: 1101,
          is_active: true,
          defeated: false,
          health: 10,
          max_health: 10,
          energy: 0,
          max_energy: 3,
          aura: 0,
          attached_definition_ids: [],
        },
      ],
      summons: [],
      supports: [],
      combat_statuses: [],
      hand: [],
      hand_size: 0,
      pile_size: 0,
      dice_counts: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      active_definition_id: 1101,
      active_element: 1,
      is_first_player: true,
    },
    opponent: {
      side: 1,
      declared_end: false,
      legend_used: false,
      characters: [
        {
          entity_id: 2,
          definition_id: 1102,
          is_active: true,
          defeated: false,
          health: 10,
          max_health: 10,
          energy: 0,
          max_energy: 3,
          aura: 0,
          attached_definition_ids: [],
        },
      ],
      summons: [],
      supports: [],
      combat_statuses: [],
      hand: [],
      hand_size: 0,
      pile_size: 0,
      dice_counts: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      active_definition_id: 1102,
      active_element: 1,
      is_first_player: false,
    },
    candidate_actions: [
      {
        candidate_id: "0",
        action_case: "useSkill",
        primary_definition_id: 11011,
        cost_by_type: [0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0],
        cost_total_dice: 2,
        cost_energy: 0,
        is_fast: false,
        target_ids: [],
        preview_vector: null,
      },
      {
        candidate_id: "1",
        action_case: "useSkill",
        primary_definition_id: 11012,
        cost_by_type: [0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0],
        cost_total_dice: 3,
        cost_energy: 0,
        is_fast: false,
        target_ids: [],
        preview_vector: null,
      },
    ],
    selected_action_index: 0,
  }
}

describe("V30NeuralPredictor", () => {
  it("predicts a finite Q value per candidate from a synthetic zero-bundle", () => {
    const predictor = new V30NeuralPredictor(buildSyntheticBundle())
    const out = predictor.predict({ observation: fakeObservation() })
    expect(out.q).toHaveLength(2)
    expect(out.candidateIds).toEqual(["0", "1"])
    for (const q of out.q) expect(Number.isFinite(q)).toBe(true)
    for (const w of out.winProb) {
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThanOrEqual(1)
    }
    // With all-zero weights and biases, Q == 0 → winProb == 0.5 exactly.
    for (const q of out.q) expect(q).toBeCloseTo(0, 6)
    for (const w of out.winProb) expect(w).toBeCloseTo(0.5, 6)
  })
})
