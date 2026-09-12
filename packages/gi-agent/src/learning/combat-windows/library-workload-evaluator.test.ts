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
import { evaluateCombatWindowLibraryWorkload } from "./library-workload-evaluator.js"
import type { CombatWindowExtractionResult } from "./types.js"

test("evaluateCombatWindowLibraryWorkload summarizes match quality by deck pair", () => {
  const extraction: CombatWindowExtractionResult = {
    generated_at: "2026-03-21T18:00:00.000Z",
    runtime_plans_dir: "D:/tmp/runtime-plans",
    sessions_scanned: 2,
    windows: [
      makeWindow({
        windowId: "window_1",
        sessionId: "session_a",
        deckSelf: "1411-1510-2102",
        deckOpp: "1301-1404-2304",
        selfChar: 1411,
        oppChar: 2304,
        actionCase: "useSkill",
        actionDefId: 2102,
      }),
      makeWindow({
        windowId: "window_2",
        sessionId: "session_b",
        deckSelf: "9991-9992-9993",
        deckOpp: "9999-9998-9997",
        selfChar: 9991,
        oppChar: 9999,
        actionCase: "useSkill",
        actionDefId: 2102,
      }),
    ],
  }

  const library: CombatWindowLibrary = {
    generated_at: "2026-03-21T18:00:00.000Z",
    entry_count: 1,
    grouped_count: 1,
    entries: [
      {
        canonical_key: "key_1",
        tree_id: "tree_1",
        status: "promoted",
        matchup_id: "matchup_1",
        deck_fingerprint_self: "1411-1510-2102",
        deck_fingerprint_opp: "1301-1404-2304",
        fingerprint: {
          deck_fingerprint_self: "1411-1510-2102",
          deck_fingerprint_opp: "1301-1404-2304",
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
          tags: ["useSkill", "reaction"],
          matchup_id: "matchup_1",
          self_active_character_definition_id: 1411,
          opp_active_character_definition_id: 2304,
          support_bucket: "1",
          summon_bucket: "2-3",
          cards_in_hand_bucket: "2-3",
          first_action_case: "useSkill",
          first_action_definition_id: 2102,
          first_action_tags: ["useSkill", "reaction", "valid"],
          action_count_bucket: "3",
          canonical_key: "key_1",
        },
        combat_window_plan: {
          window_id: "plan_1",
          plan_horizon: { min_actions: 2, max_actions: 4 },
          entry_conditions: [],
          interrupt_conditions: [],
          success_conditions: [],
          fail_conditions: [],
          entry_node_id: "setup",
          nodes: [],
        },
        source_window_id: "window_tree_1",
        llm_confidence: 0.8,
        generalization_confidence: 0.6,
        promote_signal: "promote",
      },
    ],
  }

  const summary = evaluateCombatWindowLibraryWorkload(extraction, library, {
    minScore: 0,
    selectionLimit: 3,
    strongMatchThreshold: 0.7,
  })

  expect(summary.sessions_scanned).toBe(2)
  expect(summary.window_count).toBe(2)
  expect(summary.matched_window_count).toBe(1)
  expect(summary.strong_match_count).toBe(1)
  expect(summary.deck_pairs).toHaveLength(2)
  expect(summary.deck_pairs[0]?.window_count).toBe(1)
  expect(summary.top_match_matchups[0]?.matchup_id).toBe("matchup_1")
  expect(summary.windows[0]?.strong_match).toBe(true)
  expect(summary.windows[1]?.has_match).toBe(false)
})

function makeWindow(args: {
  windowId: string
  sessionId: string
  deckSelf: string
  deckOpp: string
  selfChar: number
  oppChar: number
  actionCase: string
  actionDefId: number
}) {
  return {
    window_id: args.windowId,
    session_id: args.sessionId,
    source_window_kind: "session_sequence" as const,
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
    tags: [args.actionCase],
    state_fingerprint: {
      deck_fingerprint_self: args.deckSelf,
      fingerprint_quality: "session" as const,
      pending_method: "action",
      round_bucket: "r2",
      turn_player: 0,
      self_active_hp_bucket: "5-7",
      opp_active_hp_bucket: "8+",
      self_active_energy_bucket: "burst_ready",
      opp_active_energy_bucket: "0",
      dice_bucket: "3-5",
      omni_bucket: "1-2",
      tags: [args.actionCase],
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
          digest_ref: `digest_${args.windowId}`,
          session_id: args.sessionId,
          round: 2,
          turn: 0,
          pending_method: "action",
          self_summary: {
            active_character_id: -1,
            hand_count: 3,
            characters: [
              {
                id: -1,
                definition_id: args.selfChar,
                hp: 6,
                max_hp: 10,
                energy: 2,
                max_energy: 2,
                alive: true,
              },
            ],
          },
          opponent_summary: {
            active_character_id: -101,
            characters: [
              {
                id: -101,
                definition_id: args.oppChar,
                hp: 9,
                max_hp: 10,
                energy: 0,
                max_energy: 2,
                alive: true,
              },
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
              action_case: args.actionCase,
              notes: [`skill_def_id=${args.actionDefId}`],
              tags: [args.actionCase, "reaction", "valid"],
            },
          ],
        },
        fragment: null,
        feedback: {
          session_id: args.sessionId,
          digest_ref: `digest_${args.windowId}`,
          execution_ok: true,
        },
        selected_candidate: {
          candidate_id: "0",
          action_case: args.actionCase,
          tags: [args.actionCase, "reaction", "valid"],
        },
      },
    ],
  }
}
