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
import { CombatWindowTreeValidator } from "./tree-validator.js"
import type { TreeRecord } from "./types.js"

function buildTreeRecord(): TreeRecord {
  return {
    tree_id: "tree_valid",
    source_window_id: "window_1",
    status: "draft",
    created_at: "2026-03-20T12:00:00.000Z",
    updated_at: "2026-03-20T12:00:00.000Z",
    validation_summary: null,
    source_window: {
      window_id: "window_1",
      session_id: "sess_valid",
      source_window_kind: "session_sequence",
      sequence_index: 0,
      sequence_start_step: 0,
      action_count: 3,
      round: 2,
      turn: 0,
      started_at: "2026-03-20T12:00:00.000Z",
      ended_at: "2026-03-20T12:00:02.000Z",
      score: 20,
      deck_fingerprint_self: "1411-1510-2102",
      strategic_profile_ref: null,
      global_goal: "Burst through the opening window.",
      tags: ["useSkill", "switchActive", "playCard"],
      state_fingerprint: {
        deck_fingerprint_self: "1411-1510-2102",
        fingerprint_quality: "session",
        pending_method: "action",
        round_bucket: "r2",
        turn_player: 0,
        self_active_hp_bucket: "5-7",
        opp_active_hp_bucket: "8+",
        self_active_energy_bucket: "1/2",
        opp_active_energy_bucket: "0",
        dice_bucket: "3-5",
        omni_bucket: "1-2",
        tags: ["useSkill", "switchActive", "playCard"],
      },
      source_paths: {
        plan_path: null,
        artifact_dir: "D:/tmp/runtime-plans",
      },
      steps: [
        {
          step_index: 0,
          artifact_ts: 1,
          digest: {
            digest_ref: "d1",
            session_id: "sess_valid",
            round: 2,
            turn: 0,
            pending_method: "action",
            self_summary: {
              active_character_id: -1,
              characters: [
                { id: -1, hp: 6, max_hp: 10, energy: 1, max_energy: 2, alive: true },
              ],
            },
            opponent_summary: {
              active_character_id: -101,
              characters: [
                { id: -101, hp: 9, max_hp: 10, energy: 0, max_energy: 2, alive: true },
              ],
            },
            resource_summary: {
              dice_count: 5,
              omni_count: 1,
            },
            candidate_actions: [
              {
                candidate_id: "cand_a",
                action_case: "useSkill",
                tags: ["useSkill", "reaction", "valid"],
              },
            ],
          },
          fragment: null,
          feedback: {
            session_id: "sess_valid",
            digest_ref: "d1",
            selected_candidate_id: "cand_a",
            execution_ok: true,
          },
          selected_candidate: {
            candidate_id: "cand_a",
            action_case: "useSkill",
            tags: ["useSkill", "reaction", "valid"],
          },
        },
        {
          step_index: 1,
          artifact_ts: 2,
          digest: {
            digest_ref: "d2",
            session_id: "sess_valid",
            round: 2,
            turn: 0,
            pending_method: "action",
            self_summary: {
              active_character_id: -1,
              characters: [
                { id: -1, hp: 6, max_hp: 10, energy: 1, max_energy: 2, alive: true },
              ],
            },
            opponent_summary: {
              active_character_id: -101,
              characters: [
                { id: -101, hp: 8, max_hp: 10, energy: 0, max_energy: 2, alive: true },
              ],
            },
            resource_summary: {
              dice_count: 4,
              omni_count: 1,
            },
            candidate_actions: [
              {
                candidate_id: "cand_b",
                action_case: "switchActive",
                tags: ["switchActive", "fast_switch", "valid"],
              },
            ],
          },
          fragment: null,
          feedback: {
            session_id: "sess_valid",
            digest_ref: "d2",
            selected_candidate_id: "cand_b",
            execution_ok: true,
          },
          selected_candidate: {
            candidate_id: "cand_b",
            action_case: "switchActive",
            tags: ["switchActive", "fast_switch", "valid"],
          },
        },
        {
          step_index: 2,
          artifact_ts: 3,
          digest: {
            digest_ref: "d3",
            session_id: "sess_valid",
            round: 2,
            turn: 0,
            pending_method: "action",
            self_summary: {
              active_character_id: -1,
              characters: [
                { id: -1, hp: 6, max_hp: 10, energy: 2, max_energy: 2, alive: true },
              ],
            },
            opponent_summary: {
              active_character_id: -101,
              characters: [
                { id: -101, hp: 6, max_hp: 10, energy: 0, max_energy: 2, alive: true },
              ],
            },
            resource_summary: {
              dice_count: 3,
              omni_count: 1,
            },
            candidate_actions: [
              {
                candidate_id: "cand_c",
                action_case: "playCard",
                tags: ["playCard", "burst", "valid"],
              },
            ],
          },
          fragment: null,
          feedback: {
            session_id: "sess_valid",
            digest_ref: "d3",
            selected_candidate_id: "cand_c",
            execution_ok: true,
          },
          selected_candidate: {
            candidate_id: "cand_c",
            action_case: "playCard",
            tags: ["playCard", "burst", "valid"],
          },
        },
      ],
    },
    analysis: {
      analysis_meta: {
        schema_version: "combat-window-analysis.v1",
        model: "gpt-4o-mini",
        prompt_version: "post-analysis.v1",
        created_at: "2026-03-20T12:00:00.000Z",
      },
      source_context: {
        window_id: "window_1",
        session_id: "sess_valid",
        matchup_id: null,
        deck_fingerprint_self: "1411-1510-2102",
        replay_path: null,
      },
      window_locator: {
        round: 2,
        turn: 0,
        sequence_index: 0,
        sequence_start_step: 0,
        action_count: 3,
      },
      state_fingerprint: {
        deck_fingerprint_self: "1411-1510-2102",
        fingerprint_quality: "session",
        pending_method: "action",
        round_bucket: "r2",
        turn_player: 0,
        self_active_hp_bucket: "5-7",
        opp_active_hp_bucket: "8+",
        self_active_energy_bucket: "1/2",
        opp_active_energy_bucket: "0",
        dice_bucket: "3-5",
        omni_bucket: "1-2",
        tags: ["useSkill", "switchActive", "playCard"],
      },
      combat_window_plan: {
        window_id: "window_1_plan",
        plan_horizon: {
          min_actions: 2,
          max_actions: 4,
        },
        entry_conditions: ["pending_method=action", "round=2"],
        interrupt_conditions: ["pending_method!=action"],
        success_conditions: ["window_goal_reached"],
        fail_conditions: [],
        entry_node_id: "setup",
        nodes: [
          {
            id: "setup",
            kind: "setup",
            intent: "open_with_skill",
            expected_action_case: ["useSkill"],
            when: ["pending_method=action"],
            must_do: [],
            avoid: ["declareEnd"],
            prefer_tags: ["useSkill"],
            next: [{ condition: "actions_taken>=2", to: "pivot", priority: 100 }],
          },
          {
            id: "pivot",
            kind: "pivot",
            intent: "swap_to_converter",
            expected_action_case: ["switchActive"],
            when: ["pending_method=action"],
            must_do: [],
            avoid: ["declareEnd"],
            prefer_tags: ["switchActive", "fast_switch"],
            next: [{ condition: "actions_taken>=3", to: "convert", priority: 100 }],
          },
          {
            id: "convert",
            kind: "convert",
            intent: "cash_in_damage",
            expected_action_case: ["playCard"],
            when: ["pending_method=action"],
            must_do: [],
            avoid: ["declareEnd"],
            prefer_tags: ["playCard", "burst"],
            next: [],
          },
        ],
      },
      candidate_review: {
        actual_line: ["cand_a", "cand_b", "cand_c"],
        preferred_line_tags: ["useSkill", "fast_switch", "burst"],
        rejected_patterns: [],
        key_branch_claims: [],
      },
      outcome_assessment: {
        local_result: "good",
        why: ["tempo_gain"],
        reusable: true,
        reuse_scope: "same_deck_broad",
      },
      quality: {
        llm_confidence: 0.8,
        generalization_confidence: 0.4,
        risk_flags: [],
      },
    },
  }
}

test("CombatWindowTreeValidator validates aligned combat window plans", () => {
  const validator = new CombatWindowTreeValidator()
  const record = buildTreeRecord()
  const result = validator.validateTree(record)

  expect(result.summary.status).toBe("validated")
  expect(result.summary.schema_ok).toBe(true)
  expect(result.summary.entry_conditions_ok).toBe(true)
  expect(result.summary.replay_alignment_ok).toBe(true)
  expect(result.summary.legality_ok).toBe(true)
  expect(result.summary.matched_node_ids).toEqual(["setup", "pivot", "convert"])
})

test("CombatWindowTreeValidator rejects mismatched entry conditions", () => {
  const validator = new CombatWindowTreeValidator()
  const record = buildTreeRecord()
  record.analysis.combat_window_plan.entry_conditions = ["round=3"]

  const result = validator.validateTree(record)

  expect(result.summary.status).toBe("rejected")
  expect(result.summary.entry_conditions_ok).toBe(false)
  expect(result.summary.reasons.some((reason) => reason.includes("entry_conditions"))).toBe(true)
})
