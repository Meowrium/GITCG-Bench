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
import { buildValueDatasetFromRlDataset } from "./rl-value.js"

function createRlValueFixture(): RlDatasetV1 {
  return {
    schema_version: "rl_dataset.v1",
    generated_at: "2026-04-02T00:00:00.000Z",
    source_capture_count: 1,
    sample_count: 2,
    by_matchup: { "matchup-a": 2 },
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
            round_number: 1,
            phase: "action",
            pending_method: "action",
            actor_who: 0,
            current_turn: 0,
            action_count_in_round: 0,
          },
          self: {
            active_character_index: 0,
            characters: [{ slot_index: 0, id: 1, definition_id: 11, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, tags: 0, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
            hand: { visible_cards: [], card_count: 5 },
            pile_count: 0,
            discard_count: null,
            declared_end: false,
            can_charged: null,
            can_plunging: null,
            has_defeated: null,
            legend_used: false,
          },
          opponent: {
            active_character_index: 0,
            characters: [{ slot_index: 0, id: 2, definition_id: 21, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2, aura: null, tags: 0, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: { counts_by_type: {}, total_count: 8, omni_count: 0, unspecified_count: 0 },
            hand: { visible_cards: [], card_count: 5 },
            pile_count: 0,
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
            opp_damage_capacity_now: 1,
            self_ko_pressure_now: 0,
            opp_ko_pressure_now: 0,
            self_resource_score: 5,
            opp_resource_score: 5,
            self_reaction_ready_score: 0,
            opp_reaction_ready_score: 0,
            self_burst_online_count: 0,
            opp_burst_online_count: 0,
            self_role_integrity_score: 1,
            opp_role_integrity_score: 1,
            self_window_score: 5,
            opp_window_score: 5,
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
        decision_point: { schema_version: "action.v1", game_id: "game-1", episode_id: "episode-1", decision_point_id: "dp-1", pending_method: "action", actor_who: 0, observation_ref: "obs://game-1/dp-1", candidate_count: 0, candidates: [] },
        next_observation: null,
        decision_log: {
          game_id: "game-1", episode_id: "episode-1", decision_point_id: "dp-1", observation_ref: "obs://game-1/dp-1",
          candidate_ids: [], candidate_scores: [], selected_candidate_id: null, selected_route: "rule_policy",
          reward_breakdown: { reward_version: "reward.v1", terminal: 1, damage: 0, ko: 0, energy: 0, hand: 0, reaction_ready: 0, burst_online: 0, shaping_total: 0, clipped_shaping_total: 0, setup_window: 0, reserve_value: 0, setup_realization: 0, total: 1 },
          value_prediction: null, terminal_outcome: 1, model_version: "m", reward_version: "reward.v1", obs_version: "obs.v1", action_version: "action.v1",
        },
        chosen_candidate_id: null,
        selected_route: "rule_policy",
        reward_breakdown: { reward_version: "reward.v1", terminal: 1, damage: 0, ko: 0, energy: 0, hand: 0, reaction_ready: 0, burst_online: 0, shaping_total: 0, clipped_shaping_total: 0, setup_window: 0, reserve_value: 0, setup_realization: 0, total: 1 },
        outcome_label: 1,
      },
      {
        game_id: "game-2",
        episode_id: "episode-2",
        matchup_id: "matchup-a",
        side: 1,
        observation: {
          schema_version: "obs.v1",
          source: { game_version: "v6.3.0", card_pool_version: "v6.3.0", ruleset_version: "default", contract_version: "obs.v1", view_kind: "policy_public" },
          point: { game_id: "game-2", episode_id: "episode-2", decision_point_id: "dp-2", round_number: 5, phase: "action", pending_method: "action", actor_who: 1, current_turn: 1, action_count_in_round: 3 },
          self: { active_character_index: 0, characters: [{ slot_index: 0, id: 3, definition_id: 31, alive: true, is_active: true, health: 2, max_health: 10, energy: 0, max_energy: 2, aura: null, tags: 0, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }], summons: [], supports: [], combat_statuses: [], dice: { counts_by_type: {}, total_count: 1, omni_count: 0, unspecified_count: 0 }, hand: { visible_cards: [], card_count: 1 }, pile_count: 0, discard_count: null, declared_end: false, can_charged: null, can_plunging: null, has_defeated: null, legend_used: false },
          opponent: { active_character_index: 0, characters: [{ slot_index: 0, id: 4, definition_id: 41, alive: true, is_active: true, health: 8, max_health: 10, energy: 1, max_energy: 2, aura: null, tags: 0, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }], summons: [], supports: [], combat_statuses: [], dice: { counts_by_type: {}, total_count: 7, omni_count: 0, unspecified_count: 0 }, hand: { visible_cards: [], card_count: 4 }, pile_count: 0, discard_count: null, declared_end: false, can_charged: null, can_plunging: null, has_defeated: null, legend_used: false },
          public_state: { winner: null, self_declared_end: false, opponent_declared_end: false, self_support_count: 0, opponent_support_count: 0, self_summon_count: 0, opponent_summon_count: 0 },
          hidden_estimate: null,
          derived: { self_damage_capacity_now: 0.2, opp_damage_capacity_now: 1.2, self_ko_pressure_now: 0.1, opp_ko_pressure_now: 0.9, self_resource_score: 1, opp_resource_score: 6, self_reaction_ready_score: 0, opp_reaction_ready_score: 1, self_burst_online_count: 0, opp_burst_online_count: 1, self_role_integrity_score: 0.4, opp_role_integrity_score: 1, self_window_score: 1, opp_window_score: 6, self_setup_window_score: 0, opp_setup_window_score: 0, self_reserve_value_score: 0, opp_reserve_value_score: 0, game_setup_completion: -1, game_phase_estimate: -1, game_primary_path_viable: -1, dice_efficiency: 0, summon_pressure: 0, action_economy_ratio: 1, elemental_application_map: {} },
        },
        decision_point: { schema_version: "action.v1", game_id: "game-2", episode_id: "episode-2", decision_point_id: "dp-2", pending_method: "action", actor_who: 1, observation_ref: "obs://game-2/dp-2", candidate_count: 0, candidates: [] },
        next_observation: null,
        decision_log: { game_id: "game-2", episode_id: "episode-2", decision_point_id: "dp-2", observation_ref: "obs://game-2/dp-2", candidate_ids: [], candidate_scores: [], selected_candidate_id: null, selected_route: "rule_policy", reward_breakdown: { reward_version: "reward.v1", terminal: -1, damage: 0, ko: 0, energy: 0, hand: 0, reaction_ready: 0, burst_online: 0, shaping_total: 0, clipped_shaping_total: 0, setup_window: 0, reserve_value: 0, setup_realization: 0, total: -1 }, value_prediction: null, terminal_outcome: -1, model_version: "m", reward_version: "reward.v1", obs_version: "obs.v1", action_version: "action.v1" },
        chosen_candidate_id: null,
        selected_route: "rule_policy",
        reward_breakdown: { reward_version: "reward.v1", terminal: -1, damage: 0, ko: 0, energy: 0, hand: 0, reaction_ready: 0, burst_online: 0, shaping_total: 0, clipped_shaping_total: 0, setup_window: 0, reserve_value: 0, setup_realization: 0, total: -1 },
        outcome_label: 0,
      },
    ],
  }
}

test("buildValueDatasetFromRlDataset exports weighted value samples from observations", () => {
  const dataset = buildValueDatasetFromRlDataset(createRlValueFixture())

  expect(dataset.dataset_id).toBe("rl_value__2")
  expect(dataset.samples).toHaveLength(2)
  expect(dataset.samples[0]?.target_value).toBe(1)
  expect(dataset.samples[0]?.feature_slots).toMatchObject({
    self: { hand_count: 5, dice_count: 8 },
    derived: { self_resource_score: 5 },
  })
  expect(dataset.samples[1]?.target_value).toBe(0)
  expect(dataset.samples[1]?.weight).toBeGreaterThan(1)
})

test("buildValueDatasetFromRlDataset can export deterministic holdout subsets", () => {
  const fixture = createRlValueFixture()
  for (let sampleIndex = 3; sampleIndex <= 12; sampleIndex++) {
    const sample = structuredClone(fixture.samples[(sampleIndex - 1) % 2]!)
    sample.game_id = `game-${sampleIndex}`
    sample.episode_id = `episode-${sampleIndex}`
    sample.observation.point.game_id = `game-${sampleIndex}`
    sample.observation.point.episode_id = `episode-${sampleIndex}`
    sample.observation.point.decision_point_id = `dp-${sampleIndex}`
    sample.decision_point.game_id = `game-${sampleIndex}`
    sample.decision_point.episode_id = `episode-${sampleIndex}`
    sample.decision_point.decision_point_id = `dp-${sampleIndex}`
    sample.decision_point.observation_ref = `obs://game-${sampleIndex}/dp-${sampleIndex}`
    sample.decision_log.game_id = `game-${sampleIndex}`
    sample.decision_log.episode_id = `episode-${sampleIndex}`
    sample.decision_log.decision_point_id = `dp-${sampleIndex}`
    sample.decision_log.observation_ref = `obs://game-${sampleIndex}/dp-${sampleIndex}`
    fixture.samples.push(sample)
  }
  fixture.sample_count = fixture.samples.length
  fixture.by_matchup = Object.fromEntries(
    fixture.samples.map((sample, index) => [`matchup-${index + 1}`, 1]),
  )

  const train = buildValueDatasetFromRlDataset(fixture, {
    subset: "train",
    holdoutFraction: 0.25,
    holdoutSeed: "seed-a",
  })
  const holdout = buildValueDatasetFromRlDataset(fixture, {
    subset: "holdout",
    holdoutFraction: 0.25,
    holdoutSeed: "seed-a",
  })

  expect(train.samples.length).toBeGreaterThan(0)
  expect(holdout.samples.length).toBeGreaterThan(0)
  expect(train.samples.length + holdout.samples.length).toBe(fixture.samples.length)
  const overlap = train.samples.some((sample) =>
    holdout.samples.some((other) => other.sample_id === sample.sample_id))
  expect(overlap).toBe(false)
})
