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
import type { CombatWindowLibrary } from "./export-library.js"
import { evaluateCombatWindowLibrary } from "./library-evaluator.js"
import type { TreeRecord } from "./types.js"

test("evaluateCombatWindowLibrary separates coverage from retrieval hits", () => {
  const trees: TreeRecord[] = [
    makeTreeRecord({
      treeId: "tree_a",
      canonicalKey: "key_a",
      matchupId: "matchup_1",
      deckSelf: "1411-1510-2102",
      deckOpp: "1301-1404-2304",
      selfChar: 1411,
      oppChar: 2304,
      firstActionDefinitionId: 2102,
      firstActionCase: "useSkill",
      firstActionTags: ["useSkill", "reaction", "valid"],
    }),
    makeTreeRecord({
      treeId: "tree_missing",
      canonicalKey: "key_missing",
      matchupId: "matchup_1",
      deckSelf: "1411-1510-2102",
      deckOpp: "1301-1404-2304",
      selfChar: 1510,
      oppChar: 2304,
      firstActionDefinitionId: 215001,
      firstActionCase: "playCard",
      firstActionTags: ["card", "support_engine", "valid"],
    }),
  ]

  const library: CombatWindowLibrary = {
    generated_at: "2026-03-21T16:00:00.000Z",
    entry_count: 1,
    grouped_count: 1,
    entries: [
      {
        canonical_key: "key_a",
        tree_id: "tree_a",
        status: "promoted",
        matchup_id: "matchup_1",
        deck_fingerprint_self: "1411-1510-2102",
        deck_fingerprint_opp: "1301-1404-2304",
        fingerprint: trees[0]!.canonical_fingerprint!,
        combat_window_plan: trees[0]!.analysis.combat_window_plan,
        source_window_id: trees[0]!.source_window_id,
        llm_confidence: 0.8,
        generalization_confidence: 0.6,
        promote_signal: "promote",
      },
    ],
  }

  const report = evaluateCombatWindowLibrary(trees, library, {
    queryModes: ["runtime", "canonical", "window"],
    minScore: 0,
    selectionLimit: 5,
  })

  expect(report.summaries).toHaveLength(3)

  const runtimeSummary = report.summaries.find(
    (summary) => summary.query_mode === "runtime",
  )!
  expect(runtimeSummary.query_count).toBe(2)
  expect(runtimeSummary.coverable_count).toBe(1)
  expect(runtimeSummary.hit_at_1_coverable).toBe(1)

  const canonicalSummary = report.summaries.find(
    (summary) => summary.query_mode === "canonical",
  )!
  expect(canonicalSummary.query_count).toBe(2)
  expect(canonicalSummary.coverable_count).toBe(1)
  expect(canonicalSummary.hit_at_1_all).toBe(0.5)
  expect(canonicalSummary.hit_at_1_coverable).toBe(1)
  expect(canonicalSummary.queries[0]?.same_key_rank).toBe(1)

  const windowSummary = report.summaries.find(
    (summary) => summary.query_mode === "window",
  )!
  expect(windowSummary.query_count).toBe(2)
  expect(windowSummary.coverable_count).toBe(1)
  expect(windowSummary.hit_at_1_coverable).toBe(1)
  expect(windowSummary.queries.some((query) => query.same_key_in_library === false)).toBe(true)
})

function makeTreeRecord(args: {
  treeId: string
  canonicalKey: string
  matchupId: string
  deckSelf: string
  deckOpp: string
  selfChar: number
  oppChar: number
  firstActionDefinitionId: number
  firstActionCase: string
  firstActionTags: string[]
}): TreeRecord {
  return {
    tree_id: args.treeId,
    source_window_id: `window_${args.treeId}`,
    status: "validated",
    created_at: "2026-03-21T16:00:00.000Z",
    updated_at: "2026-03-21T16:00:00.000Z",
    source_window: {
      window_id: `window_${args.treeId}`,
      session_id: `session_${args.treeId}`,
      source_window_kind: "session_sequence",
      sequence_index: 0,
      sequence_start_step: 0,
      action_count: 3,
      round: 2,
      turn: 0,
      started_at: null,
      ended_at: null,
      score: 10,
      deck_fingerprint_self: args.deckSelf,
      deck_fingerprint_opp: args.deckOpp,
      strategic_profile_ref: null,
      global_goal: null,
      tags: args.firstActionTags,
      state_fingerprint: {
        deck_fingerprint_self: args.deckSelf,
        fingerprint_quality: "session",
        pending_method: "action",
        round_bucket: "r2",
        turn_player: 0,
        self_active_hp_bucket: "5-7",
        opp_active_hp_bucket: "8+",
        self_active_energy_bucket: "burst_ready",
        opp_active_energy_bucket: "0",
        dice_bucket: "3-5",
        omni_bucket: "1-2",
        tags: args.firstActionTags,
      },
      source_paths: {
        plan_path: null,
        artifact_dir: "D:/tmp/runtime",
      },
      steps: [
        {
          step_index: 0,
          artifact_ts: 1000,
          digest: {
            digest_ref: `digest_${args.treeId}`,
            session_id: `session_${args.treeId}`,
            round: 2,
            turn: 0,
            pending_method: "action",
            self_summary: {
              active_character_id: -1,
              hand_count: 3,
              characters: [
                { id: -1, hp: 6, max_hp: 10, energy: 2, max_energy: 2, alive: true },
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
              cards_in_hand: 3,
              support_count: 1,
              summon_count: 2,
            },
            character_definitions: [
              {
                id: -1,
                definition_id: args.selfChar,
                name: "Self Active",
                element: "hydro",
                weapon_type: "catalyst",
              },
              {
                id: -101,
                definition_id: args.oppChar,
                name: "Opp Active",
                element: "pyro",
                weapon_type: "pole",
              },
            ],
            candidate_actions: [
              {
                candidate_id: "0",
                action_case: args.firstActionCase,
                card_definition_id: args.firstActionDefinitionId,
                tags: args.firstActionTags,
              },
            ],
          },
          fragment: null,
          feedback: {
            session_id: `session_${args.treeId}`,
            digest_ref: `digest_${args.treeId}`,
            execution_ok: true,
          },
          selected_candidate: {
            candidate_id: "0",
            action_case: args.firstActionCase,
            card_definition_id: args.firstActionDefinitionId,
            tags: args.firstActionTags,
          },
        },
      ],
    },
    analysis: {
      analysis_meta: {
        schema_version: "combat-window-analysis.v1",
        model: "gpt-4o-mini",
        prompt_version: "post-analysis.v1",
        created_at: "2026-03-21T16:00:00.000Z",
      },
      source_context: {
        window_id: `window_${args.treeId}`,
        session_id: `session_${args.treeId}`,
        matchup_id: args.matchupId,
        deck_fingerprint_self: args.deckSelf,
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
        deck_fingerprint_self: args.deckSelf,
        fingerprint_quality: "session",
        pending_method: "action",
        round_bucket: "r2",
        turn_player: 0,
        self_active_hp_bucket: "5-7",
        opp_active_hp_bucket: "8+",
        self_active_energy_bucket: "burst_ready",
        opp_active_energy_bucket: "0",
        dice_bucket: "3-5",
        omni_bucket: "1-2",
        tags: args.firstActionTags,
      },
      combat_window_plan: {
        window_id: `plan_${args.treeId}`,
        plan_horizon: { min_actions: 2, max_actions: 4 },
        entry_conditions: ["pending_method=action"],
        interrupt_conditions: [],
        success_conditions: [],
        fail_conditions: [],
        entry_node_id: "setup",
        nodes: [],
      },
      candidate_review: {
        actual_line: ["0"],
        preferred_line_tags: args.firstActionTags,
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
        generalization_confidence: 0.6,
        risk_flags: [],
      },
    },
    canonical_fingerprint: {
      deck_fingerprint_self: args.deckSelf,
      deck_fingerprint_opp: args.deckOpp,
      fingerprint_quality: "replay_backed",
      pending_method: "action",
      round_bucket: "r2",
      turn_player: 0,
      self_active_hp_bucket: "5-7",
      opp_active_hp_bucket: "8+",
      self_active_energy_bucket: "burst_ready",
      opp_active_energy_bucket: "0",
      dice_bucket: "3-5",
      omni_bucket: "1-2",
      tags: args.firstActionTags,
      matchup_id: args.matchupId,
      self_active_character_definition_id: args.selfChar,
      opp_active_character_definition_id: args.oppChar,
      support_bucket: "1",
      summon_bucket: "2-3",
      cards_in_hand_bucket: "2-3",
      first_action_case: args.firstActionCase,
      first_action_definition_id: args.firstActionDefinitionId,
      first_action_tags: args.firstActionTags,
      action_count_bucket: "3",
      canonical_key: args.canonicalKey,
    },
    replay_alignment: null,
    branch_eval_summary: null,
    validation_summary: null,
  }
}
