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
import {
  ReplayWindowAligner,
  buildCanonicalFingerprintFromReplayPoint,
  scoreWindowToReplayPoint,
} from "./replay-alignment.js"
import type { TreeRecord } from "./types.js"
import type { ReplayAlignmentPoint } from "./replay-alignment.js"

function buildTree(): TreeRecord {
  return {
    tree_id: "tree_replay",
    source_window_id: "window_replay",
    status: "validated",
    created_at: "2026-03-20T12:00:00.000Z",
    updated_at: "2026-03-20T12:00:00.000Z",
    replay_alignment: null,
    branch_eval_summary: null,
    validation_summary: null,
    source_window: {
      window_id: "window_replay",
      session_id: "sess_replay",
      source_window_kind: "session_sequence",
      sequence_index: 0,
      sequence_start_step: 0,
      action_count: 2,
      round: 2,
      turn: 0,
      started_at: null,
      ended_at: null,
      score: 12,
      deck_fingerprint_self: "1411-1510-2102",
      strategic_profile_ref: null,
      global_goal: null,
      tags: ["useSkill", "reaction"],
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
        tags: ["useSkill", "reaction"],
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
            session_id: "sess_replay",
            round: 2,
            turn: 0,
            pending_method: "action",
            self_summary: {
              active_character_id: -1,
              characters: [{ id: -1, hp: 6, max_hp: 10, energy: 1, max_energy: 2, alive: true }],
            },
            opponent_summary: {
              active_character_id: -2,
              characters: [{ id: -2, hp: 9, max_hp: 10, energy: 0, max_energy: 2, alive: true }],
            },
            resource_summary: {
              dice_count: 5,
              omni_count: 1,
            },
            candidate_actions: [
              {
                candidate_id: "cand_0",
                action_case: "useSkill",
                tags: ["useSkill", "reaction", "valid"],
              },
            ],
          },
          fragment: null,
          feedback: {
            session_id: "sess_replay",
            digest_ref: "d1",
            selected_candidate_id: "cand_0",
            execution_ok: true,
          },
          selected_candidate: {
            candidate_id: "cand_0",
            action_case: "useSkill",
            tags: ["useSkill", "reaction", "valid"],
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
        window_id: "window_replay",
        session_id: "sess_replay",
        matchup_id: null,
        deck_fingerprint_self: "1411-1510-2102",
        replay_path: null,
      },
      window_locator: {
        round: 2,
        turn: 0,
        sequence_index: 0,
        sequence_start_step: 0,
        action_count: 2,
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
        tags: ["useSkill", "reaction"],
      },
      combat_window_plan: {
        window_id: "plan",
        plan_horizon: { min_actions: 2, max_actions: 4 },
        entry_conditions: ["pending_method=action"],
        interrupt_conditions: [],
        success_conditions: [],
        fail_conditions: [],
        entry_node_id: "setup",
        nodes: [
          {
            id: "setup",
            kind: "setup",
            intent: "open",
            when: ["pending_method=action"],
            must_do: [],
            avoid: [],
            prefer_tags: ["useSkill"],
            next: [],
          },
        ],
      },
      candidate_review: {
        actual_line: ["cand_0"],
        preferred_line_tags: ["useSkill", "reaction"],
        rejected_patterns: [],
        key_branch_claims: [],
      },
      outcome_assessment: {
        local_result: "good",
        why: [],
        reusable: true,
        reuse_scope: "same_deck_same_matchup",
      },
      quality: {
        llm_confidence: 0.8,
        generalization_confidence: 0.5,
        risk_flags: [],
      },
    },
  }
}

test("scoreWindowToReplayPoint prefers replay points with matching action and buckets", () => {
  const tree = buildTree()
  const point: ReplayAlignmentPoint = {
    matchup_id: "matchup_1",
    replay_file: "D:/tmp/replay/game-0001-p0.json",
    replay_entry_index: 12,
    replay_next_state_index: 13,
    actor: 0,
    round: 2,
    turn: 0,
    self_deck_fingerprint: "1411-1510-2102",
    opponent_deck_fingerprint: "1311-1404-2304",
    self_active_character_definition_id: 1411,
    opp_active_character_definition_id: 2304,
    self_active_hp_bucket: "5-7",
    opp_active_hp_bucket: "8+",
    self_active_energy_bucket: "1/2",
    opp_active_energy_bucket: "0",
    dice_bucket: "3-5",
    omni_bucket: "1-2",
    support_bucket: "1",
    summon_bucket: "0",
    cards_in_hand_bucket: "2-3",
    legal_action_count: 1,
    actual_action_index: 0,
    actual_action_case: "useSkill",
    actual_action_definition_id: 2102,
    actual_action_tags: ["useSkill", "reaction", "valid"],
  }

  const scored = scoreWindowToReplayPoint(tree, point)
  expect(scored.similarity).toBeGreaterThan(0.8)
  expect(scored.matched_fields).toContain("actual_action_case")
})

test("ReplayWindowAligner returns matched summary for high-similarity point", () => {
  const tree = buildTree()
  const aligner = new ReplayWindowAligner()
  const summary = aligner.alignTreeToReplayPoints(tree, [{
    matchup_id: "matchup_1",
    replay_file: "D:/tmp/replay/game-0001-p0.json",
    replay_entry_index: 12,
    replay_next_state_index: 13,
    actor: 0,
    round: 2,
    turn: 0,
    self_deck_fingerprint: "1411-1510-2102",
    opponent_deck_fingerprint: "1311-1404-2304",
    self_active_character_definition_id: 1411,
    opp_active_character_definition_id: 2304,
    self_active_hp_bucket: "5-7",
    opp_active_hp_bucket: "8+",
    self_active_energy_bucket: "1/2",
    opp_active_energy_bucket: "0",
    dice_bucket: "3-5",
    omni_bucket: "1-2",
    support_bucket: "1",
    summon_bucket: "0",
    cards_in_hand_bucket: "2-3",
    legal_action_count: 1,
    actual_action_index: 0,
    actual_action_case: "useSkill",
    actual_action_definition_id: 2102,
    actual_action_tags: ["useSkill", "reaction", "valid"],
  }], { threshold: 0.6 })

  expect(summary.matched).toBe(true)
  expect(summary.replay_entry_index).toBe(12)
  expect(summary.replay_action_case).toBe("useSkill")
})

test("buildCanonicalFingerprintFromReplayPoint produces replay-backed canonical key", () => {
  const tree = buildTree()
  const fingerprint = buildCanonicalFingerprintFromReplayPoint(tree, {
    matchup_id: "matchup_1",
    replay_file: "D:/tmp/replay/game-0001-p0.json",
    replay_entry_index: 12,
    replay_next_state_index: 13,
    actor: 0,
    round: 2,
    turn: 0,
    self_deck_fingerprint: "1411-1510-2102",
    opponent_deck_fingerprint: "1311-1404-2304",
    self_active_character_definition_id: 1411,
    opp_active_character_definition_id: 2304,
    self_active_hp_bucket: "5-7",
    opp_active_hp_bucket: "8+",
    self_active_energy_bucket: "1/2",
    opp_active_energy_bucket: "0",
    dice_bucket: "3-5",
    omni_bucket: "1-2",
    support_bucket: "1",
    summon_bucket: "0",
    cards_in_hand_bucket: "2-3",
    legal_action_count: 1,
    actual_action_index: 0,
    actual_action_case: "useSkill",
    actual_action_definition_id: 2102,
    actual_action_tags: ["useSkill", "reaction", "valid"],
  })

  expect(fingerprint.fingerprint_quality).toBe("replay_backed")
  expect(fingerprint.deck_fingerprint_opp).toBe("1311-1404-2304")
  expect(fingerprint.first_action_definition_id).toBe(2102)
  expect(fingerprint.canonical_key.includes("1411-1510-2102")).toBe(true)
})
