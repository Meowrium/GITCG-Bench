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
import type { PolicyTurnDigest } from "../../runtime/policy/types.js"
import type { CombatWindowLibrary } from "./export-library.js"
import {
  buildLibraryQueryFromCanonicalFingerprint,
  buildLibraryQueryFromPolicyDigest,
  buildLibraryQueryFromWindow,
  selectCombatWindowLibrary,
} from "./library-selector.js"
import type { CandidateCombatWindow } from "./types.js"

test("buildLibraryQueryFromWindow collects candidate action features and buckets", () => {
  const window: CandidateCombatWindow = {
    window_id: "window_1",
    session_id: "session_1",
    source_window_kind: "session_sequence",
    sequence_index: 0,
    sequence_start_step: 0,
    action_count: 3,
    round: 2,
    turn: 0,
    started_at: null,
    ended_at: null,
    score: 12,
    deck_fingerprint_self: "1411-1510-2102",
    deck_fingerprint_opp: null,
    strategic_profile_ref: null,
    global_goal: null,
    tags: ["useSkill", "fast_switch"],
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
      artifact_dir: "D:/tmp/runtime",
    },
    steps: [
      {
        step_index: 0,
        artifact_ts: 1000,
        digest: {
          digest_ref: "digest_1",
          session_id: "session_1",
          round: 2,
          turn: 0,
          pending_method: "action",
          self_summary: {
            active_character_id: -1,
            hand_count: 3,
            characters: [
              { id: -1, hp: 6, max_hp: 10, energy: 2, max_energy: 2, alive: true },
              { id: -2, hp: 10, max_hp: 10, energy: 0, max_energy: 2, alive: true },
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
              definition_id: 1411,
              name: "Character A",
              element: "hydro",
              weapon_type: "catalyst",
            },
            {
              id: -2,
              definition_id: 1510,
              name: "Character B",
              element: "electro",
              weapon_type: "sword",
            },
            {
              id: -101,
              definition_id: 2304,
              name: "Character X",
              element: "pyro",
              weapon_type: "pole",
            },
          ],
          candidate_actions: [
            {
              candidate_id: "0",
              action_case: "useSkill",
              notes: ["skill_def_id=2102"],
              tags: ["useSkill", "reaction", "valid"],
            },
            {
              candidate_id: "1",
              action_case: "switchActive",
              tags: ["switchActive", "fast_switch", "valid"],
            },
          ],
        },
        fragment: null,
        feedback: {
          session_id: "session_1",
          digest_ref: "digest_1",
          execution_ok: true,
        },
        selected_candidate: {
          candidate_id: "0",
          action_case: "useSkill",
          tags: ["useSkill", "reaction", "valid"],
        },
      },
    ],
  }

  const query = buildLibraryQueryFromWindow(window, {
    deckFingerprintOpp: "1301-1404-2304",
    matchupId: "matchup_1",
  })

  expect(query.round_bucket).toBe("r2")
  expect(query.self_active_character_definition_id).toBe(1411)
  expect(query.opp_active_character_definition_id).toBe(2304)
  expect(query.support_bucket).toBe("1")
  expect(query.summon_bucket).toBe("2-3")
  expect(query.cards_in_hand_bucket).toBe("2-3")
  expect(query.self_active_energy_bucket).toBe("burst_ready")
  expect(query.deck_fingerprint_opp).toBe("1301-1404-2304")
  expect(query.candidate_action_cases).toEqual(["useSkill", "switchActive"])
  expect(query.candidate_action_definition_ids).toEqual([2102])
  expect(query.candidate_action_tags).toContain("fast_switch")
})

test("buildLibraryQueryFromPolicyDigest accepts offline metadata overrides", () => {
  const digest: PolicyTurnDigest = {
    round: 3,
    turn: 1,
    self_summary: {
      active_character_id: -1,
      characters: [
        { id: -1, hp: 4, max_hp: 10, energy: 1, max_energy: 2, alive: true },
      ],
    },
    opponent_summary: {
      active_character_id: -101,
      characters: [
        { id: -101, hp: 6, max_hp: 10, energy: 2, max_energy: 2, alive: true },
      ],
    },
    resource_summary: {
      dice_count: 4,
      omni_count: 0,
      cards_in_hand: 2,
      support_count: 0,
      summon_count: 1,
    },
    candidate_actions: [
      {
        candidate_id: "0",
        action_case: "playCard",
        card_definition_id: 215001,
        tags: ["card", "support_engine", "valid"],
      },
      {
        candidate_id: "1",
        action_case: "useSkill",
        tags: ["useSkill", "valid"],
      },
    ],
  }

  const query = buildLibraryQueryFromPolicyDigest(digest, {
    deckFingerprintSelf: "1411-1510-2102",
    deckFingerprintOpp: "1301-1404-2304",
    matchupId: "matchup_2",
    selfActiveCharacterDefinitionId: 1411,
    oppActiveCharacterDefinitionId: 2304,
    expectedActionCount: 2,
  })

  expect(query.deck_fingerprint_self).toBe("1411-1510-2102")
  expect(query.matchup_id).toBe("matchup_2")
  expect(query.self_active_character_definition_id).toBe(1411)
  expect(query.opp_active_character_definition_id).toBe(2304)
  expect(query.action_count_bucket).toBe("2")
  expect(query.candidate_action_cases).toEqual(["playCard", "useSkill"])
  expect(query.candidate_action_tags).toContain("support_engine")
})

test("selectCombatWindowLibrary prefers exact canonical matches and dedupes canonical keys", () => {
  const library: CombatWindowLibrary = {
    generated_at: "2026-03-21T15:00:00.000Z",
    entry_count: 3,
    grouped_count: 2,
    entries: [
      {
        canonical_key: "key_exact",
        tree_id: "tree_promoted",
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
          canonical_key: "key_exact",
        },
        combat_window_plan: {
          window_id: "plan_exact",
          plan_horizon: { min_actions: 2, max_actions: 4 },
          entry_conditions: ["pending_method=action"],
          interrupt_conditions: [],
          success_conditions: [],
          fail_conditions: [],
          entry_node_id: "setup",
          nodes: [],
        },
        source_window_id: "window_promoted",
        llm_confidence: 0.8,
        generalization_confidence: 0.6,
        promote_signal: "promote",
      },
      {
        canonical_key: "key_exact",
        tree_id: "tree_validated_duplicate",
        status: "validated",
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
          canonical_key: "key_exact",
        },
        combat_window_plan: {
          window_id: "plan_exact_dupe",
          plan_horizon: { min_actions: 2, max_actions: 4 },
          entry_conditions: [],
          interrupt_conditions: [],
          success_conditions: [],
          fail_conditions: [],
          entry_node_id: "setup",
          nodes: [],
        },
        source_window_id: "window_dupe",
        llm_confidence: 0.7,
        generalization_confidence: 0.5,
        promote_signal: "hold",
      },
      {
        canonical_key: "key_loose",
        tree_id: "tree_loose",
        status: "validated",
        matchup_id: "matchup_1",
        deck_fingerprint_self: "1411-1510-2102",
        deck_fingerprint_opp: "1301-1404-2304",
        fingerprint: {
          deck_fingerprint_self: "1411-1510-2102",
          deck_fingerprint_opp: "1301-1404-2304",
          fingerprint_quality: "replay_backed",
          pending_method: "action",
          round_bucket: "r3",
          turn_player: 0,
          self_active_hp_bucket: "3-4",
          opp_active_hp_bucket: "5-7",
          self_active_energy_bucket: "1/2",
          opp_active_energy_bucket: "burst_ready",
          dice_bucket: "1-2",
          omni_bucket: "0",
          tags: ["playCard"],
          matchup_id: "matchup_1",
          self_active_character_definition_id: 1411,
          opp_active_character_definition_id: 2304,
          support_bucket: "0",
          summon_bucket: "0",
          cards_in_hand_bucket: "1",
          first_action_case: "playCard",
          first_action_definition_id: 215001,
          first_action_tags: ["card", "support_engine", "valid"],
          action_count_bucket: "2",
          canonical_key: "key_loose",
        },
        combat_window_plan: {
          window_id: "plan_loose",
          plan_horizon: { min_actions: 2, max_actions: 4 },
          entry_conditions: [],
          interrupt_conditions: [],
          success_conditions: [],
          fail_conditions: [],
          entry_node_id: "setup",
          nodes: [],
        },
        source_window_id: "window_loose",
        llm_confidence: 0.65,
        generalization_confidence: 0.4,
        promote_signal: "hold",
      },
    ],
  }

  const query = buildLibraryQueryFromCanonicalFingerprint(library.entries[0]!.fingerprint)
  const selection = selectCombatWindowLibrary(library, query, {
    minScore: 0,
    limit: 5,
  })

  expect(selection.candidate_count).toBe(3)
  expect(selection.returned_count).toBe(2)
  expect(selection.matches[0]?.entry.tree_id).toBe("tree_promoted")
  expect(selection.matches[0]?.state_similarity).toBe(1)
  expect(selection.matches[1]?.entry.tree_id).toBe("tree_loose")
})
