import { expect, test } from "vitest"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type {
  RlDatasetManifestV1,
  RlDatasetShardV1,
  RlDatasetV1,
} from "../contracts/rl-types.js"
import { loadRlDatasetInput } from "./rl-input.js"

test("loadRlDatasetInput loads a manifest-backed rl dataset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rl-input-"))
  const shard: RlDatasetShardV1 = {
    schema_version: "rl_dataset_shard.v1",
    generated_at: "2026-04-03T00:00:00.000Z",
    shard_id: "shard-00001",
    source_capture_count: 1,
    sample_count: 1,
    by_matchup: { "matchup-a": 1 },
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
            characters: [],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: { counts_by_type: {}, total_count: 0, omni_count: 0, unspecified_count: 0 },
            hand: { visible_cards: [], card_count: 0 },
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
            characters: [],
            summons: [],
            supports: [],
            combat_statuses: [],
            dice: { counts_by_type: {}, total_count: 0, omni_count: 0, unspecified_count: 0 },
            hand: { visible_cards: [], card_count: 0 },
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
            self_damage_capacity_now: 0,
            opp_damage_capacity_now: 0,
            self_ko_pressure_now: 0,
            opp_ko_pressure_now: 0,
            self_resource_score: 0,
            opp_resource_score: 0,
            self_reaction_ready_score: 0,
            opp_reaction_ready_score: 0,
            self_burst_online_count: 0,
            opp_burst_online_count: 0,
            self_role_integrity_score: 0,
            opp_role_integrity_score: 0,
            self_window_score: 0,
            opp_window_score: 0,
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
          observation_ref: "obs:dp-1",
          candidate_count: 0,
          candidates: [],
        },
        next_observation: null,
        decision_log: {
          game_id: "game-1",
          episode_id: "episode-1",
          decision_point_id: "dp-1",
          observation_ref: "obs:dp-1",
          candidate_ids: [],
          candidate_scores: [],
          selected_candidate_id: null,
          selected_route: "rule_policy",
          reward_breakdown: null,
          value_prediction: null,
          terminal_outcome: null,
          model_version: "test",
          reward_version: "reward.v1",
          obs_version: "obs.v1",
          action_version: "action.v1",
        },
        chosen_candidate_id: null,
        selected_route: "rule_policy",
        reward_breakdown: null,
        outcome_label: 1,
      },
    ],
  }
  const manifest: RlDatasetManifestV1 = {
    schema_version: "rl_dataset_manifest.v1",
    generated_at: "2026-04-03T00:00:00.000Z",
    source_capture_count: 1,
    sample_count: 1,
    by_matchup: { "matchup-a": 1 },
    samples_schema_version: "rl_dataset.v1",
    shard_schema_version: "rl_dataset_shard.v1",
    shard_count: 1,
    shards: [
      {
        shard_id: "shard-00001",
        relative_path: "shard-00001.json",
        source_capture_count: 1,
        sample_count: 1,
        by_matchup: { "matchup-a": 1 },
      },
    ],
  }

  const shardPath = join(dir, "shard-00001.json")
  const manifestPath = join(dir, "manifest.json")
  await writeFile(shardPath, `${JSON.stringify(shard)}\n`, "utf8")
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8")

  const dataset = await loadRlDatasetInput(manifestPath)
  expect(dataset.schema_version).toBe("rl_dataset.v1")
  expect(dataset.sample_count).toBe(1)
  expect(dataset.by_matchup).toEqual({ "matchup-a": 1 })
  expect(dataset.samples[0]?.matchup_id).toBe("matchup-a")
})

test("loadRlDatasetInput falls back to rl-dataset.shards for manifest shards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rl-input-shards-"))
  const shardDir = join(dir, "rl-dataset.shards")
  await mkdir(shardDir, { recursive: true })

  const shard: RlDatasetShardV1 = {
    schema_version: "rl_dataset_shard.v1",
    generated_at: "2026-04-03T00:00:00.000Z",
    shard_id: "shard-00001",
    source_capture_count: 1,
    sample_count: 0,
    by_matchup: { "matchup-a": 0 },
    samples: [],
  }
  const manifest: RlDatasetManifestV1 = {
    schema_version: "rl_dataset_manifest.v1",
    generated_at: "2026-04-03T00:00:00.000Z",
    source_capture_count: 1,
    sample_count: 0,
    by_matchup: { "matchup-a": 0 },
    samples_schema_version: "rl_dataset.v1",
    shard_schema_version: "rl_dataset_shard.v1",
    shard_count: 1,
    shards: [
      {
        shard_id: "shard-00001",
        relative_path: "shard-00001.json",
        source_capture_count: 1,
        sample_count: 0,
        by_matchup: { "matchup-a": 0 },
      },
    ],
  }

  const shardPath = join(shardDir, "shard-00001.json")
  const manifestPath = join(dir, "rl-dataset.manifest.json")
  await writeFile(shardPath, `${JSON.stringify(shard)}\n`, "utf8")
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8")

  const dataset = await loadRlDatasetInput(manifestPath)
  expect(dataset.schema_version).toBe("rl_dataset.v1")
  expect(dataset.sample_count).toBe(0)
  expect(dataset.by_matchup).toEqual({ "matchup-a": 0 })
})
