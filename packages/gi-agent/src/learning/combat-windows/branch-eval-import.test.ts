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
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BranchEvalImporter } from "./branch-eval-import.js"
import { TreeLake } from "./tree-lake.js"
import type { TreeRecord } from "./types.js"

function buildTreeRecord(): TreeRecord {
  return {
    tree_id: "tree_branch_eval",
    source_window_id: "window_branch_eval",
    status: "validated",
    created_at: "2026-03-20T12:00:00.000Z",
    updated_at: "2026-03-20T12:00:00.000Z",
    replay_alignment: {
      matched: true,
      benchmark_path: "D:/tmp/benchmark.json",
      matchup_id: "ShuiNing-mirror",
      replay_dir: "D:/tmp/replays",
      replay_file: "D:/tmp/replays/game-0001-p0.json",
      replay_entry_index: 12,
      replay_next_state_index: 13,
      replay_action_index: 0,
      replay_action_case: "useSkill",
      replay_action_tags: ["useSkill", "reaction", "valid"],
      self_deck_fingerprint: "1411-1510-2102",
      opponent_deck_fingerprint: "1411-1510-2102",
      similarity: 0.95,
      matched_fields: ["self_deck_fingerprint", "actual_action_case"],
    },
    branch_eval_summary: null,
    validation_summary: null,
    source_window: {
      window_id: "window_branch_eval",
      session_id: "sess_branch_eval",
      source_window_kind: "session_sequence",
      sequence_index: 0,
      sequence_start_step: 0,
      action_count: 2,
      round: 2,
      turn: 0,
      started_at: null,
      ended_at: null,
      score: 10,
      deck_fingerprint_self: "1411-1510-2102",
      strategic_profile_ref: null,
      global_goal: null,
      tags: ["useSkill"],
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
        tags: ["useSkill"],
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
            session_id: "sess_branch_eval",
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
            session_id: "sess_branch_eval",
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
        window_id: "window_branch_eval",
        session_id: "sess_branch_eval",
        matchup_id: "ShuiNing-mirror",
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
        tags: ["useSkill"],
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
        preferred_line_tags: ["useSkill"],
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

test("BranchEvalImporter can promote validated tree when replay action is near-best", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "gi-agent-tree-lake-"))
  const dbPath = join(tempDir, "tree-lake.sqlite")
  const lake = new TreeLake(dbPath)
  const record = buildTreeRecord()
  const saved = lake.saveDraft({
    sourceWindow: record.source_window,
    analysis: record.analysis,
  })
  lake.updateValidation({
    treeId: saved.tree_id,
    summary: {
      schema_ok: true,
      entry_conditions_ok: true,
      replay_alignment_ok: true,
      legality_ok: true,
      branch_eval_ok: null,
      status: "validated",
      reasons: [],
      matched_node_ids: [],
    },
  })
  lake.updateReplayAlignment({
    treeId: saved.tree_id,
    replayAlignment: record.replay_alignment!,
  })

  const importer = new BranchEvalImporter()
  const report = {
    matchupId: "ShuiNing-mirror",
    replayDir: "D:/tmp/replays",
    points: [
      {
        replayFile: "D:/tmp/replays/game-0001-p0.json",
        replayEntryIndex: 12,
        replayNextStateIndex: 13,
        replayActionIndex: 0,
        replayActionType: "useSkill",
        replayActionDefinitionId: 2102,
        replayActionTags: ["useSkill", "reaction", "valid"],
        policySelectedActionIndex: 1,
        policySelectedActionType: "playCard",
        branches: [
          {
            actionIndex: 0,
            actionType: "useSkill",
            definitionId: 2102,
            candidateTags: ["useSkill", "reaction", "valid"],
            isPolicyChoice: false,
            isReplayChoice: true,
            continuation: { winRate: 0.68 },
          },
          {
            actionIndex: 1,
            actionType: "playCard",
            definitionId: 330007,
            candidateTags: ["playCard", "valid"],
            isPolicyChoice: true,
            isReplayChoice: false,
            continuation: { winRate: 0.69 },
          },
        ],
      },
    ],
  }

  const tree = lake.getTree(saved.tree_id)!
  const point = importer.findMatchingPoint(tree, report)
  expect(point).not.toBeNull()
  const summary = importer.buildSummary(tree, report, point!)
  expect(summary.promote_signal).toBe("promote")
  lake.updateBranchEvalSummary({
    treeId: tree.tree_id,
    branchEvalSummary: summary,
  })

  const updated = lake.getTree(saved.tree_id)!
  expect(updated.status).toBe("promoted")
  expect(updated.branch_eval_summary?.best_action_win_rate).toBe(0.69)

  lake.close()
})
