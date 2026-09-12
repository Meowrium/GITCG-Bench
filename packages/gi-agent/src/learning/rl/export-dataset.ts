// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import {
  DEFAULT_REWARD_CONFIG_V1,
} from "./reward-config.js"
import type {
  DecisionPointLogV1,
  DecisionPointV1,
  ObservationV1,
  RlDatasetManifestV1,
  RlDatasetManifestShardEntryV1,
  RlDatasetShardV1,
  RlDatasetV1,
  RlDecisionPointSampleV1,
  SelfPlayRlGameCaptureV1,
  SelfPlayRlSideCaptureV1,
} from "@gi-tcg/ml/contracts"

export interface ExportRlDatasetOptionsV1 {
  includeSides?: ReadonlyArray<0 | 1>
  requireChosenCandidate?: boolean
  excludeDrawMatchups?: ReadonlyArray<string>
}

export interface ExportRlDatasetShardsOptionsV1 extends ExportRlDatasetOptionsV1 {
  maxSamplesPerShard?: number
}

export interface ExportedRlDatasetShardsV1 {
  manifest: RlDatasetManifestV1
  shards: RlDatasetShardV1[]
}

export function exportRlDatasetV1(
  captures: readonly SelfPlayRlGameCaptureV1[],
  options: ExportRlDatasetOptionsV1 = {},
): RlDatasetV1 {
  const samples: RlDecisionPointSampleV1[] = []
  const byMatchup = new Map<string, number>()

  for (const capture of captures) {
    const captureSamples = exportRlDatasetSamplesFromCapture(capture, options)
    samples.push(...captureSamples)
    byMatchup.set(
      capture.matchup_id,
      (byMatchup.get(capture.matchup_id) ?? 0) + captureSamples.length,
    )
  }

  return {
    schema_version: "rl_dataset.v1",
    reward_version: DEFAULT_REWARD_CONFIG_V1.reward_version,
    generated_at: new Date().toISOString(),
    source_capture_count: captures.length,
    sample_count: samples.length,
    by_matchup: Object.fromEntries([...byMatchup.entries()].sort(([a], [b]) => a.localeCompare(b))),
    samples,
  }
}

export function exportRlDatasetShardsV1(
  captures: readonly SelfPlayRlGameCaptureV1[],
  options: ExportRlDatasetShardsOptionsV1 = {},
): ExportedRlDatasetShardsV1 {
  const maxSamplesPerShard = Math.max(1, options.maxSamplesPerShard ?? 2000)
  const shards: RlDatasetShardV1[] = []
  const allShardEntries: RlDatasetManifestShardEntryV1[] = []
  const globalByMatchup = new Map<string, number>()

  let currentSamples: RlDecisionPointSampleV1[] = []
  let currentCaptureCount = 0
  let currentByMatchup = new Map<string, number>()

  const flushShard = () => {
    if (currentSamples.length === 0) {
      return
    }
    const shardId = `shard-${String(shards.length + 1).padStart(5, "0")}`
    const shard: RlDatasetShardV1 = {
      schema_version: "rl_dataset_shard.v1",
      generated_at: new Date().toISOString(),
      shard_id: shardId,
      source_capture_count: currentCaptureCount,
      sample_count: currentSamples.length,
      by_matchup: toSortedRecord(currentByMatchup),
      samples: currentSamples,
    }
    shards.push(shard)
    allShardEntries.push({
      shard_id: shardId,
      relative_path: `${shardId}.json`,
      source_capture_count: shard.source_capture_count,
      sample_count: shard.sample_count,
      by_matchup: shard.by_matchup,
    })
    currentSamples = []
    currentCaptureCount = 0
    currentByMatchup = new Map<string, number>()
  }

  for (const capture of captures) {
    const captureSamples = exportRlDatasetSamplesFromCapture(capture, options)
    currentSamples.push(...captureSamples)
    currentCaptureCount += 1
    addMatchupCount(currentByMatchup, capture.matchup_id, captureSamples.length)
    addMatchupCount(globalByMatchup, capture.matchup_id, captureSamples.length)
    if (currentSamples.length >= maxSamplesPerShard) {
      flushShard()
    }
  }
  flushShard()

  return {
    manifest: {
      schema_version: "rl_dataset_manifest.v1",
      reward_version: DEFAULT_REWARD_CONFIG_V1.reward_version,
      generated_at: new Date().toISOString(),
      source_capture_count: captures.length,
      sample_count: shards.reduce((sum, shard) => sum + shard.sample_count, 0),
      by_matchup: toSortedRecord(globalByMatchup),
      samples_schema_version: "rl_dataset.v1",
      shard_schema_version: "rl_dataset_shard.v1",
      shard_count: shards.length,
      shards: allShardEntries,
    },
    shards,
  }
}

export function exportRlDatasetSamplesFromCapture(
  capture: SelfPlayRlGameCaptureV1,
  options: ExportRlDatasetOptionsV1 = {},
): RlDecisionPointSampleV1[] {
  if (
    capture.winner == null &&
    (options.excludeDrawMatchups?.includes(capture.matchup_id) ?? false)
  ) {
    return []
  }
  const includeSides = new Set(options.includeSides ?? [0, 1])
  const samples: RlDecisionPointSampleV1[] = []
  for (const sideCapture of capture.sides) {
    if (!includeSides.has(sideCapture.side)) {
      continue
    }
    samples.push(
      ...buildSamplesFromSideCapture(
        capture,
        sideCapture,
        options.requireChosenCandidate ?? false,
      ),
    )
  }
  return samples
}

function buildSamplesFromSideCapture(
  capture: SelfPlayRlGameCaptureV1,
  sideCapture: SelfPlayRlSideCaptureV1,
  requireChosenCandidate: boolean,
): RlDecisionPointSampleV1[] {
  const decisionPointById = new Map<string, DecisionPointV1>(
    sideCapture.decision_points.map((decisionPoint) => [decisionPoint.decision_point_id, decisionPoint]),
  )
  const observationById = new Map<string, ObservationV1>(
    sideCapture.observations.map((observation) => [observation.point.decision_point_id, observation]),
  )
  const nextObservationByOriginId = new Map<string, ObservationV1>(
    sideCapture.transition_observations
      .map((observation) => {
        const originId = observation.point.decision_point_id.replace(/:next$/, "")
        return [originId, observation] as const
      }),
  )

  return sideCapture.decision_logs.flatMap((decisionLog) => {
    if (requireChosenCandidate && !decisionLog.selected_candidate_id) {
      return []
    }
    const decisionPoint = decisionPointById.get(decisionLog.decision_point_id)
    const observation = observationById.get(decisionLog.decision_point_id)
    if (!decisionPoint || !observation) {
      return []
    }
    return [
      {
        game_id: capture.game_id,
        episode_id: capture.episode_id,
        matchup_id: capture.matchup_id,
        side: sideCapture.side,
        observation,
        decision_point: decisionPoint,
        next_observation: nextObservationByOriginId.get(decisionLog.decision_point_id) ?? null,
        decision_log: decisionLog,
        chosen_candidate_id: decisionLog.selected_candidate_id,
        selected_route: decisionLog.selected_route,
        reward_breakdown: decisionLog.reward_breakdown,
        outcome_label: normalizeOutcomeLabel(capture, sideCapture.side, decisionLog),
      },
    ]
  })
}

function normalizeOutcomeLabel(
  capture: SelfPlayRlGameCaptureV1,
  side: 0 | 1,
  decisionLog: DecisionPointLogV1,
): number | null {
  if (decisionLog.terminal_outcome == null) {
    return winnerToOutcomeLabel(capture.winner, side)
  }
  if (decisionLog.terminal_outcome > 0) {
    return 1
  }
  if (decisionLog.terminal_outcome < 0) {
    return 0
  }
  return 0.5
}

function winnerToOutcomeLabel(winner: 0 | 1 | null, side: 0 | 1): number | null {
  if (winner == null) {
    return 0.5
  }
  return winner === side ? 1 : 0
}

function addMatchupCount(map: Map<string, number>, matchupId: string, count: number): void {
  map.set(matchupId, (map.get(matchupId) ?? 0) + count)
}

function toSortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}
