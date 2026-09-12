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
import type { RlDatasetV1 } from "../contracts/rl-types.js"
import { buildRankingDatasetFromRlDataset } from "./rl.js"

function createRlDatasetFixture(): RlDatasetV1 {
  return {
    schema_version: "rl_dataset.v1",
    generated_at: "2026-04-02T00:00:00.000Z",
    source_capture_count: 1,
    sample_count: 1,
    by_matchup: {
      "matchup-a": 1,
    },
    samples: [
      {
        game_id: "game-1",
        episode_id: "episode-1",
        matchup_id: "matchup-a",
        side: 0,
        observation: {
          schema_version: "obs.v1",
          source: {
            game_version: "v6.3.0",
            card_pool_version: "v6.3.0",
            ruleset_version: "default",
            contract_version: "obs.v1",
            view_kind: "policy_public",
          },
          point: {
            game_id: "game-1",
            episode_id: "episode-1",
            decision_point_id: "dp-1",
            round_number: 3,
            phase: "action",
            pending_method: "action",
            actor_who: 0,
            current_turn: 0,
            action_count_in_round: 2,
          },
          self: {
            active_character_index: 0,
            characters: [
              {
                slot_index: 0,
                id: 1001,
                definition_id: 1101,
                alive: true,
                is_active: true,
                health: 8,
                max_health: 10,
                energy: 1,
                max_energy: 2,
                aura: null,
                tags: 0,
                equipment_ids: [],
                status_ids: [],
                usage_counters: {},
                entities: [],
              },
            ],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: {
              counts_by_type: { "8": 2 },
              total_count: 2,
              omni_count: 0,
              unspecified_count: 0,
            },
            hand: {
              visible_cards: [],
              card_count: 3,
            },
            pile_count: 5,
            discard_count: null,
            declared_end: false,
            can_charged: null,
            can_plunging: null,
            has_defeated: null,
            legend_used: false,
          },
          opponent: {
            active_character_index: 0,
            characters: [
              {
                slot_index: 0,
                id: 2001,
                definition_id: 2101,
                alive: true,
                is_active: true,
                health: 5,
                max_health: 10,
                energy: 0,
                max_energy: 2,
                aura: null,
                tags: 0,
                equipment_ids: [],
                status_ids: [],
                usage_counters: {},
                entities: [],
              },
            ],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: {
              counts_by_type: { "8": 1 },
              total_count: 1,
              omni_count: 0,
              unspecified_count: 0,
            },
            hand: {
              visible_cards: [],
              card_count: 2,
            },
            pile_count: 7,
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
            self_ko_pressure_now: 0.7,
            opp_ko_pressure_now: 0.2,
            self_resource_score: 2,
            opp_resource_score: 1,
            self_reaction_ready_score: 1,
            opp_reaction_ready_score: 0,
            self_burst_online_count: 1,
            opp_burst_online_count: 0,
            self_role_integrity_score: 1,
            opp_role_integrity_score: 1,
            self_window_score: 3,
            opp_window_score: 1,
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
        },
        decision_point: {
          schema_version: "action.v1",
          game_id: "game-1",
          episode_id: "episode-1",
          decision_point_id: "dp-1",
          pending_method: "action",
          actor_who: 0,
          observation_ref: "obs://game-1/dp-1",
          candidate_count: 2,
          candidates: [
            {
              candidate_id: "dp-1:action:0",
              candidate_index: 0,
              engine_index: 1,
              pending_method: "action",
              family: "action",
              action_case: "declareEnd",
              source_ref: null,
              target_ref: null,
              target_refs: [],
              required_cost: [],
              auto_selected_dice: [],
              selectable_dice_types: [],
              is_fast_action: false,
              is_valid: true,
              validity_code: 1,
              is_model_selectable: true,
              is_fallback_only: false,
              rule_tags: ["end_round"],
              routing: {
                route: "main_head",
                reason: "high_freq_family",
              },
            },
            {
              candidate_id: "dp-1:action:1",
              candidate_index: 1,
              engine_index: 2,
              pending_method: "action",
              family: "action",
              action_case: "useSkill",
              source_ref: {
                side: 0,
                area: "character",
                entity_id: 1001,
                definition_id: 1101,
              },
              target_ref: {
                side: 1,
                area: "character",
                entity_id: 2001,
                definition_id: 2101,
              },
              target_refs: [
                {
                  side: 1,
                  area: "character",
                  entity_id: 2001,
                  definition_id: 2101,
                },
              ],
              required_cost: [
                {
                  type: 8,
                  count: 2,
                },
              ],
              auto_selected_dice: [8, 8],
              selectable_dice_types: [8],
              is_fast_action: false,
              is_valid: true,
              validity_code: 1,
              is_model_selectable: true,
              is_fallback_only: false,
              rule_tags: ["skill"],
              routing: {
                route: "main_head",
                reason: "high_freq_family",
              },
            },
          ],
        },
        next_observation: null,
        decision_log: {
          game_id: "game-1",
          episode_id: "episode-1",
          decision_point_id: "dp-1",
          observation_ref: "obs://game-1/dp-1",
          candidate_ids: ["dp-1:action:0", "dp-1:action:1"],
          candidate_scores: [0.1, 0.8],
          selected_candidate_id: "dp-1:action:1",
          selected_route: "main_head",
          reward_breakdown: {
            reward_version: "reward.v1",
            terminal: 1,
            damage: 0.1,
            ko: 0,
            energy: 0,
            hand: 0,
            reaction_ready: 0.03,
            burst_online: 0.04,
            shaping_total: 0.17,
            clipped_shaping_total: 0.17,
            setup_window: 0,
            reserve_value: 0,
            setup_realization: 0,
            total: 1.17,
          },
          value_prediction: 0.4,
          terminal_outcome: 1,
          model_version: "smoke-baseline-v1",
          reward_version: "reward.v1",
          obs_version: "obs.v1",
          action_version: "action.v1",
        },
        chosen_candidate_id: "dp-1:action:1",
        selected_route: "main_head",
        reward_breakdown: {
          reward_version: "reward.v1",
          terminal: 1,
          damage: 0.1,
          ko: 0,
          energy: 0,
          hand: 0,
          reaction_ready: 0.03,
          burst_online: 0.04,
          shaping_total: 0.17,
            clipped_shaping_total: 0.17,
            setup_window: 0,
            reserve_value: 0,
            setup_realization: 0,
            total: 1.17,
          },
        outcome_label: 1,
      },
    ],
  }
}

test("buildRankingDatasetFromRlDataset exports query groups and pairwise preferences", () => {
  const dataset = buildRankingDatasetFromRlDataset(createRlDatasetFixture())

  expect(dataset.dataset_id).toBe("rl_self_play__1")
  expect(dataset.query_groups).toHaveLength(1)
  const group = dataset.query_groups[0]!
  expect(group.query_id).toBe("dp-1")
  expect(group.source).toBe("self_play")
  expect(group.candidates).toHaveLength(2)
  expect(group.candidates[1]?.runtime_slots).toMatchObject({
    family: "action",
    pending_method: "action",
    candidate_tags: expect.arrayContaining(["family:action", "action:useSkill"]),
  })
  expect(group.candidates[1]?.runtime_slots).not.toHaveProperty("continuation")
  expect(group.context_slots).not.toHaveProperty("reward_total")
  expect(group.context_slots).not.toHaveProperty("outcome_label")
  expect(group.candidates[1]?.runtime_slots?.candidate_numeric_slots).not.toHaveProperty("chosen")
  expect(group.candidates[1]?.runtime_slots?.candidate_numeric_slots).not.toHaveProperty("reward_total")
  expect(group.pairwise_preferences).toHaveLength(1)
  expect(group.pairwise_preferences?.[0]).toMatchObject({
    candidate_a_id: "dp-1:action:1",
    candidate_b_id: "dp-1:action:0",
    preference_label: 1,
  })
  expect(group.pairwise_preferences?.[0]?.confidence).toBeGreaterThan(0.5)
})

test("buildRankingDatasetFromRlDataset can drop unchosen queries by default", () => {
  const fixture = createRlDatasetFixture()
  fixture.samples[0]!.chosen_candidate_id = null
  fixture.samples[0]!.decision_log.selected_candidate_id = null

  const dropped = buildRankingDatasetFromRlDataset(fixture)
  expect(dropped.query_groups).toHaveLength(0)

  const kept = buildRankingDatasetFromRlDataset(fixture, {
    includeUnchosenQueries: true,
  })
  expect(kept.query_groups).toHaveLength(1)
  expect(kept.query_groups[0]?.pairwise_preferences).toEqual([])
})

test("buildRankingDatasetFromRlDataset can export deterministic holdout subsets", () => {
  const fixture = createRlDatasetFixture()
  for (let sampleIndex = 2; sampleIndex <= 12; sampleIndex++) {
    const sample = structuredClone(fixture.samples[0]!)
    sample.game_id = `game-${sampleIndex}`
    sample.episode_id = `episode-${sampleIndex}`
    sample.matchup_id = `matchup-${sampleIndex}`
    sample.observation.point.game_id = `game-${sampleIndex}`
    sample.observation.point.episode_id = `episode-${sampleIndex}`
    sample.observation.point.decision_point_id = `dp-${sampleIndex}`
    sample.decision_point.game_id = `game-${sampleIndex}`
    sample.decision_point.episode_id = `episode-${sampleIndex}`
    sample.decision_point.decision_point_id = `dp-${sampleIndex}`
    sample.decision_point.observation_ref = `obs://game-${sampleIndex}/dp-${sampleIndex}`
    sample.decision_point.candidates = sample.decision_point.candidates.map((candidate, index) => ({
      ...candidate,
      candidate_id: `dp-${sampleIndex}:action:${index}`,
    }))
    sample.decision_log.game_id = `game-${sampleIndex}`
    sample.decision_log.episode_id = `episode-${sampleIndex}`
    sample.decision_log.decision_point_id = `dp-${sampleIndex}`
    sample.decision_log.observation_ref = `obs://game-${sampleIndex}/dp-${sampleIndex}`
    sample.decision_log.candidate_ids = [
      `dp-${sampleIndex}:action:0`,
      `dp-${sampleIndex}:action:1`,
    ]
    sample.decision_log.selected_candidate_id = `dp-${sampleIndex}:action:1`
    sample.chosen_candidate_id = `dp-${sampleIndex}:action:1`
    fixture.samples.push(sample)
  }
  fixture.sample_count = fixture.samples.length
  fixture.by_matchup = Object.fromEntries(
    fixture.samples.map((sample) => [sample.matchup_id, 1]),
  )

  const train = buildRankingDatasetFromRlDataset(fixture, {
    subset: "train",
    holdoutFraction: 0.25,
    holdoutSeed: "seed-a",
  })
  const holdout = buildRankingDatasetFromRlDataset(fixture, {
    subset: "holdout",
    holdoutFraction: 0.25,
    holdoutSeed: "seed-a",
  })

  expect(train.query_groups.length).toBeGreaterThan(0)
  expect(holdout.query_groups.length).toBeGreaterThan(0)
  expect(train.query_groups.length + holdout.query_groups.length).toBe(fixture.samples.length)
  const overlap = train.query_groups.some((group) =>
    holdout.query_groups.some((other) => other.query_id === group.query_id))
  expect(overlap).toBe(false)
})
