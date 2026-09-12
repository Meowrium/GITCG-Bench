// Copyright (C) 2024-2025 Guyutongxue
//
// Streaming slot-linear ranker builder — incremental stat accumulation.
// Avoids materializing the full MlRankingDataset in memory.

import type {
  RlDatasetShardV1,
  RlDecisionPointSampleV1,
  ActionCandidateV1,
  CharacterObservationV1,
  PlayerObservationV1,
  ObservationV1,
} from "../contracts/rl-types.js"
import type { SlotLinearRankerArtifact, SlotLinearWeightMap } from "./artifact.js"

export interface StreamingRankerOptions {
  artifactVersion?: string
  topTagCount?: number
  topCandidateNumericSlotCount?: number
}

// ── Incremental stats accumulators ──

interface CountTotal {
  total: number
  count: number
}

interface NumericWeightStats {
  count: number
  sumValue: number
  sumScore: number
  sumValueSq: number
  sumValueScore: number
}

export class StreamingRankerStats {
  actionCaseStats = new Map<string, CountTotal>()
  tagStats = new Map<string, CountTotal>()
  numericSlotStats = new Map<string, NumericWeightStats>()
  totalQueries = 0

  /** Process a single shard. Returns the number of queries processed. */
  processShard(shard: RlDatasetShardV1): number {
    let queries = 0
    for (const sample of shard.samples) {
      // Build query group from sample (same logic as buildQueryGroup in rl.ts)
      const candidates = sample.decision_point.candidates
      if (candidates.length === 0) continue

      const preferences = buildPairwisePreferencesFromSample(sample)
      const candidateScores = scoreCandidatesInGroup(candidates, preferences)

      // If no pairwise preferences, skip — can't derive ranking signal
      if (preferences.length === 0) continue

      queries++

      // Accumulate action case stats
      for (const candidate of candidates) {
        const score = candidateScores.get(candidate.candidate_id) ?? 0
        const actionCase = candidate.action_case

        const acs = this.actionCaseStats.get(actionCase) ?? { total: 0, count: 0 }
        acs.total += score
        acs.count += 1
        this.actionCaseStats.set(actionCase, acs)

        // Accumulate tag stats
        const tags = extractAllCandidateTags(candidate)
        for (const tag of tags) {
          const ts = this.tagStats.get(tag) ?? { total: 0, count: 0 }
          ts.total += score
          ts.count += 1
          this.tagStats.set(tag, ts)
        }

        // Accumulate numeric slot stats
        const numericSlots = extractCandidateNumericSlotsFlat(candidate)
        // P0: Observation-context features (lethal_bonus, burst_energy_ratio, reaction_is_amplifying)
        if (sample.observation) {
          const ctxSlots = extractObservationContextSlots(sample.observation, candidate)
          Object.assign(numericSlots, ctxSlots)
        }
        for (const [path, value] of Object.entries(numericSlots)) {
          updateNumericWeightStats(this.numericSlotStats, path, value, score)
        }
      }
    }
    this.totalQueries += queries
    return queries
  }
}

// ── Pairwise preferences (extracted from rl.ts) ──

interface PairwisePreference {
  candidate_a_id: string
  candidate_b_id: string
  preference_label: number
  confidence: number
}

function computePreferenceConfidence(rewardBreakdown: unknown, outcomeLabel: number | null): number {
  const rb = rewardBreakdown as Record<string, number> | null
  const rewardSignal = Math.min(1, Math.abs(rb?.total ?? 0))
  const outcomeSignal =
    outcomeLabel == null ? 0.15 : outcomeLabel === 1 ? 0.35 : outcomeLabel === 0.5 ? 0.2 : 0.1
  return Math.min(1, Math.max(0.05, 0.2 + rewardSignal * 0.4 + outcomeSignal))
}

function buildPairwisePreferencesFromSample(sample: RlDecisionPointSampleV1): PairwisePreference[] {
  const chosenCandidateId = sample.chosen_candidate_id
  if (!chosenCandidateId) return []

  const confidence = computePreferenceConfidence(sample.reward_breakdown, sample.outcome_label)

  return sample.decision_point.candidates
    .filter((candidate) => candidate.candidate_id !== chosenCandidateId)
    .map((candidate) => ({
      candidate_a_id: chosenCandidateId!,
      candidate_b_id: candidate.candidate_id,
      preference_label: 1,
      confidence,
    }))
}

// ── Candidate scoring ──

function scoreCandidatesInGroup(
  candidates: readonly ActionCandidateV1[],
  preferences: readonly PairwisePreference[],
): Map<string, number> {
  const scores = new Map<string, number>(
    candidates.map((candidate) => [candidate.candidate_id, 0]),
  )
  for (const preference of preferences) {
    const conf = preference.confidence
    if (preference.preference_label > 0) {
      addScore(scores, preference.candidate_a_id, conf)
      addScore(scores, preference.candidate_b_id, -conf)
    } else if (preference.preference_label < 0) {
      addScore(scores, preference.candidate_a_id, -conf)
      addScore(scores, preference.candidate_b_id, conf)
    }
  }
  return scores
}

function addScore(map: Map<string, number>, id: string, delta: number): void {
  map.set(id, (map.get(id) ?? 0) + delta)
}

// ── Tag extraction ──

function extractAllCandidateTags(candidate: ActionCandidateV1): string[] {
  const tags = new Set<string>()
  for (const tag of candidate.rule_tags ?? []) tags.add(tag)
  for (const tag of candidate.static_effect_tags ?? []) tags.add(tag)
  tags.add(`family:${candidate.family}`)
  tags.add(`pending:${candidate.pending_method}`)
  tags.add(`route:${candidate.routing.route}`)
  tags.add(`action:${candidate.action_case}`)
  if (candidate.is_fast_action) tags.add("fast_action")
  if (candidate.is_fallback_only) tags.add("fallback_only")
  if (candidate.is_model_selectable) tags.add("model_selectable")
  // P2-3: temporal tags
  if (candidate.temporal_option_kind) tags.add(`temporal_opt:${candidate.temporal_option_kind}`)
  if (candidate.temporal_portfolio_stage) tags.add(`temporal_stage:${candidate.temporal_portfolio_stage}`)
  return [...tags]
}

// ── Numeric slot extraction (flattened) ──

function extractCandidateNumericSlotsFlat(candidate: ActionCandidateV1): Record<string, number> {
  const result: Record<string, number> = {
    candidate_index: candidate.candidate_index,
    engine_index: candidate.engine_index ?? -1,
    target_count: candidate.target_refs.length,
    required_cost_count: (candidate.required_cost ?? []).reduce((sum, c) => sum + c.count, 0),
    auto_selected_dice_count: candidate.auto_selected_dice.length,
    selectable_dice_type_count: candidate.selectable_dice_types.length,
    is_fast_action: candidate.is_fast_action ? 1 : 0,
    is_valid: candidate.is_valid ? 1 : 0,
    is_model_selectable: candidate.is_model_selectable ? 1 : 0,
    is_fallback_only: candidate.is_fallback_only ? 1 : 0,
    validity_code: candidate.validity_code ?? 0,
    // P2-3: temporal numeric
    temporal_prereq_satisfied: candidate.temporal_prereq_satisfied == null ? -1 : (candidate.temporal_prereq_satisfied ? 1 : 0),
  }

  // Flatten meta_effect_slots
  for (const [key, value] of Object.entries(candidate.meta_effect_slots ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[`meta_effect_slots.${key}`] = value
    }
  }

  // Flatten synergy_slots
  for (const [key, value] of Object.entries(candidate.synergy_slots ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[`synergy_slots.${key}`] = value
    }
  }

  return result
}

// ── Observation-context feature extraction (P0: game-state-dependent) ──

/** Character definition_id → element type mapping.
 *  Element codes: 0=OMNI, 1=Cryo, 2=Hydro, 3=Electro, 4=Dendro, 5=Geo, 6=Anemo, 7=Pyro */
const CHAR_ELEMENT_MAP: Record<number, number> = {
  // Cryo
  1101: 1, 1102: 1, 1103: 1, 1104: 1, 1105: 1, 1106: 1, 1108: 1, 1109: 1, 1110: 1, 1111: 1, 1112: 1,
  // Hydro
  1201: 2, 1202: 2, 1203: 2, 1204: 2, 1205: 2, 1206: 2, 1207: 2, 1211: 2, 1214: 2, 1215: 2,
  // Electro
  1401: 3, 1402: 3, 1403: 3, 1404: 3, 1405: 3, 1406: 3, 1407: 3, 1408: 3, 1411: 3, 1412: 3, 1421: 3, 1425: 3,
  // Dendro
  1701: 4, 1702: 4, 1703: 4, 1705: 4,
  // Geo
  1601: 5, 1602: 5, 1603: 5, 1604: 5, 1605: 5, 1607: 5, 1611: 5,
  // Anemo
  1501: 6, 1502: 6, 1503: 6, 1504: 6, 1505: 6, 1507: 6, 1508: 6, 1510: 6, 1511: 6, 1512: 6, 1521: 6,
  // Pyro
  1301: 7, 1302: 7, 1303: 7, 1304: 7, 1305: 7, 1306: 7, 1307: 7, 1308: 7, 1310: 7, 1311: 7, 1312: 7, 1314: 7, 1316: 7, 1321: 7,
}

/** Predict reaction between skill element and target aura.
 *  Returns { willReact, bonus (+0/+1/+2), reactionType } */
function predictReaction(
  skillElement: number,
  targetAura: number,
): { willReact: boolean; bonus: number } {
  const AMPLIFYING: Record<string, true> = {
    [`${7},${2}`]: true,  // Pyro on Cryo → Melt
    [`${2},${7}`]: true,  // Cryo on Pyro → Melt
    [`${7},${6}`]: true,  // Pyro on Hydro → Vaporize
    [`${6},${7}`]: true,  // Hydro on Pyro → Vaporize
  }
  const key = `${skillElement},${targetAura}`
  const isAmplifying = AMPLIFYING[key] ?? false
  if (!isAmplifying) {
    // Check if any reaction would trigger (non-amplifying)
    const ALL_REACTIONS: Record<string, true> = {
      ...AMPLIFYING,
      [`${7},${3}`]: true, [`${3},${7}`]: true,  // Overloaded
      [`${2},${3}`]: true, [`${3},${2}`]: true,  // Superconduct
      [`${2},${6}`]: true, [`${6},${2}`]: true,  // Frozen
      [`${6},${3}`]: true, [`${3},${6}`]: true,  // Electro-Charged
      [`${1},${2}`]: true, [`${1},${3}`]: true, [`${1},${6}`]: true, [`${1},${7}`]: true,  // Swirl
      [`${5},${2}`]: true, [`${5},${3}`]: true, [`${5},${6}`]: true, [`${5},${7}`]: true,  // Crystallize
      [`${7},${4}`]: true, [`${4},${7}`]: true,  // Burning
      [`${6},${4}`]: true, [`${4},${6}`]: true,  // Bloom
      [`${3},${4}`]: true, [`${4},${3}`]: true,  // Quicken
    }
    if (!ALL_REACTIONS[key]) return { willReact: false, bonus: 0 }
    return { willReact: true, bonus: 0 }
  }
  return { willReact: true, bonus: 2 }
}

function findActiveChar(characters: readonly CharacterObservationV1[]): CharacterObservationV1 | undefined {
  return characters.find((c) => c.is_active)
}

function extractObservationContextSlots(
  observation: ObservationV1,
  candidate: ActionCandidateV1,
): Record<string, number> {
  const slots: Record<string, number> = {}

  const selfActive = findActiveChar(observation.self.characters)
  const oppActive = findActiveChar(observation.opponent.characters)

  // ── burst_energy_ratio: isBurst ? (energy / maxEnergy) : 0 ──
  const isBurst = candidate.static_effect_tags?.includes("burst_enable") ?? false
  if (selfActive && isBurst) {
    const maxEnergy = selfActive.max_energy || 3
    slots["burst_energy_ratio"] = maxEnergy > 0 ? selfActive.energy / maxEnergy : 0
  } else {
    slots["burst_energy_ratio"] = 0
  }

  // ── reaction_is_amplifying and lethal_bonus ──
  if (oppActive && selfActive) {
    const selfElement = CHAR_ELEMENT_MAP[selfActive.definition_id]
    const oppAura = oppActive.aura
    let reactionBonus = 0
    if (selfElement != null && oppAura != null) {
      const reaction = predictReaction(selfElement, oppAura)
      slots["reaction_is_amplifying"] = reaction.bonus >= 2 ? 1 : 0
      reactionBonus = reaction.bonus
    } else {
      slots["reaction_is_amplifying"] = 0
    }

    // ── lethal_bonus: can this action kill the active opponent? ──
    const dmgEstimate = candidate.meta_effect_slots?.damage_estimate ?? 0
    const totalDmg = dmgEstimate + reactionBonus
    slots["lethal_bonus"] = (totalDmg > 0 && totalDmg >= oppActive.health) ? 1 : 0
  } else {
    slots["reaction_is_amplifying"] = 0
    slots["lethal_bonus"] = 0
  }

  return slots
}

// ── Numeric weight stats ──

function updateNumericWeightStats(
  stats: Map<string, NumericWeightStats>,
  path: string,
  value: number,
  score: number,
): void {
  const entry = stats.get(path) ?? {
    count: 0,
    sumValue: 0,
    sumScore: 0,
    sumValueSq: 0,
    sumValueScore: 0,
  }
  entry.count += 1
  entry.sumValue += value
  entry.sumScore += score
  entry.sumValueSq += value * value
  entry.sumValueScore += value * score
  stats.set(path, entry)
}

// ── Finalize ──

export function finalizeToArtifact(
  stats: StreamingRankerStats,
  options: StreamingRankerOptions = {},
): SlotLinearRankerArtifact {
  const topTags = options.topTagCount ?? 32
  const topSlots = options.topCandidateNumericSlotCount ?? 24

  return {
    artifact_type: "slot_linear_ranker.v1",
    artifact_version: options.artifactVersion ?? "streaming",
    created_at: new Date().toISOString(),
    compatibility: null,
    config: {
      action_case_bias: finalizeActionCaseBias(stats.actionCaseStats),
      candidate_tag_bias: finalizeTagBias(stats.tagStats, topTags),
      candidate_numeric_slot_weights: finalizeNumericWeights(stats.numericSlotStats, topSlots),
      metadata: {
        dataset_id: `streaming__${stats.totalQueries}`,
        query_count: stats.totalQueries,
      },
    },
  }
}

function finalizeActionCaseBias(stats: Map<string, CountTotal>): SlotLinearWeightMap {
  const result: SlotLinearWeightMap = {}
  for (const [key, value] of stats) {
    result[key] = value.count > 0 ? value.total / value.count : 0
  }
  return result
}

function finalizeTagBias(
  stats: Map<string, CountTotal>,
  topK: number,
): SlotLinearWeightMap {
  return [...stats.entries()]
    .map(([key, value]) => ({
      key,
      avg: value.count > 0 ? value.total / value.count : 0,
      count: value.count,
    }))
    .sort((a, b) => {
      const absDiff = Math.abs(b.avg) - Math.abs(a.avg)
      if (absDiff !== 0) return absDiff
      return b.count - a.count
    })
    .slice(0, Math.max(0, topK))
    .reduce<SlotLinearWeightMap>((acc, item) => {
      acc[item.key] = item.avg
      return acc
    }, {})
}

function finalizeNumericWeights(
  stats: Map<string, NumericWeightStats>,
  topK: number,
): SlotLinearWeightMap {
  return [...stats.entries()]
    .map(([path, stat]) => {
      const meanValue = stat.sumValue / stat.count
      const meanScore = stat.sumScore / stat.count
      const variance = stat.sumValueSq / stat.count - meanValue * meanValue
      if (variance <= 0) return null
      const covariance = stat.sumValueScore / stat.count - meanValue * meanScore
      const weight = covariance / variance
      if (!Number.isFinite(weight) || weight === 0) return null
      return { path, weight, count: stat.count }
    })
    .filter((item): item is { path: string; weight: number; count: number } => item != null)
    .sort((a, b) => {
      const absDiff = Math.abs(b.weight) - Math.abs(a.weight)
      if (absDiff !== 0) return absDiff
      return b.count - a.count
    })
    .slice(0, Math.max(0, topK))
    .reduce<SlotLinearWeightMap>((acc, item) => {
      acc[item.path] = item.weight
      return acc
    }, {})
}
