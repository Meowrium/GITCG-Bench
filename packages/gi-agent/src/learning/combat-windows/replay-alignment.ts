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

import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import {
  CURRENT_VERSION,
  deserializeGameStateLog,
  serializeGameStateLog,
  type GameState,
} from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "../../../../assets-manager/src/index"
import {
  buildBenchmarkExecutionPlans,
  loadBenchmarkCliConfig,
} from "../../evaluation/benchmark/cli-config.js"
import { SimAdapter } from "../../runtime/adapters/sim-adapter.js"
import type { ActionInfoWithModification } from "../../runtime/adapters/internal-types.js"
import { buildPolicyTurnDigestFromGameState } from "../../runtime/policy/candidate-semantics.js"
import type {
  CanonicalCombatWindowFingerprint,
  TreeRecord,
  ReplayAlignmentSummary,
} from "./types.js"

export interface ReplayAlignmentPoint {
  matchup_id: string
  replay_file: string
  replay_entry_index: number
  replay_next_state_index: number | null
  actor: 0 | 1
  round: number
  turn: number
  self_deck_fingerprint: string
  opponent_deck_fingerprint: string
  self_active_character_definition_id: number | null
  opp_active_character_definition_id: number | null
  self_active_hp_bucket: string
  opp_active_hp_bucket: string
  self_active_energy_bucket: string
  opp_active_energy_bucket: string
  dice_bucket: string
  omni_bucket: string
  support_bucket: string
  summon_bucket: string
  cards_in_hand_bucket: string
  legal_action_count: number
  actual_action_index: number | null
  actual_action_case: string | null
  actual_action_definition_id: number | null
  actual_action_tags: string[]
}

export interface ReplayWindowAlignerOptions {
  threshold?: number
}

export class ReplayWindowAligner {
  async collectReplayPoints(args: {
    benchmarkPath: string
    matchupId: string
    replayDir: string
    minLegalActions?: number
  }): Promise<ReplayAlignmentPoint[]> {
    const benchmarkPath = resolve(args.benchmarkPath)
    const replayDir = resolve(args.replayDir)
    const loaded = await loadBenchmarkCliConfig(benchmarkPath)
    const plan = buildBenchmarkExecutionPlans(loaded.config).find((candidate) => candidate.id === args.matchupId)
    if (!plan) {
      throw new Error(`Matchup not found in benchmark config: ${args.matchupId}`)
    }

    const deck0Fingerprint = deckCodeToFingerprint(plan.deck0)
    const deck1Fingerprint = deckCodeToFingerprint(plan.deck1)
    const data = getData(loaded.version ?? CURRENT_VERSION)
    const sim = new SimAdapter(data)
    const replayFiles = (await readdir(replayDir))
      .filter((file) => file.endsWith(".json"))
      .map((file) => resolve(replayDir, file))
    const minLegalActions = args.minLegalActions ?? 1
    const points: ReplayAlignmentPoint[] = []

    for (const replayFile of replayFiles) {
      const replayJson = JSON.parse(await readFile(replayFile, "utf8")) as Parameters<typeof deserializeGameStateLog>[1]
      const entries = deserializeGameStateLog(data, replayJson)
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i]
        if (!entry?.canResume || entry.state.phase !== "action") {
          continue
        }
        const legalActions = await sim.legalActions(entry.state)
        if (legalActions.length < minLegalActions) {
          continue
        }
        const actualActionIndex = await inferActualActionIndex(
          sim,
          entry.state,
          legalActions,
          entries[findNextDistinctResumeIndex(entries, i) ?? -1]?.state ?? null,
        )
        const digest = buildPolicyTurnDigestFromGameState(
          entry.state,
          entry.state.currentTurn as 0 | 1,
          legalActions,
        )
        const actualCandidate =
          actualActionIndex != null
            ? digest.candidate_actions[actualActionIndex]
            : null
        const actor = entry.state.currentTurn as 0 | 1
        const selfFingerprint = actor === 0 ? deck0Fingerprint : deck1Fingerprint
        const opponentFingerprint = actor === 0 ? deck1Fingerprint : deck0Fingerprint
        const selfActiveState = findActiveCharacterState(entry.state, actor)
        const oppActiveState = findActiveCharacterState(entry.state, actor === 0 ? 1 : 0)
        const selfActive = findActiveCharacter(
          Number(digest.self_summary.active_character_id ?? 0),
          digest.self_summary.characters as Array<Record<string, unknown>>,
        )
        const oppActive = findActiveCharacter(
          Number(digest.opponent_summary.active_character_id ?? 0),
          digest.opponent_summary.characters as Array<Record<string, unknown>>,
        )
        points.push({
          matchup_id: args.matchupId,
          replay_file: replayFile,
          replay_entry_index: i,
          replay_next_state_index: findNextDistinctResumeIndex(entries, i),
          actor,
          round: entry.state.roundNumber,
          turn: entry.state.currentTurn,
          self_deck_fingerprint: selfFingerprint,
          opponent_deck_fingerprint: opponentFingerprint,
          self_active_character_definition_id: selfActiveState?.definition?.id ?? null,
          opp_active_character_definition_id: oppActiveState?.definition?.id ?? null,
          self_active_hp_bucket: bucketHp(Number(selfActive?.hp ?? 0)),
          opp_active_hp_bucket: bucketHp(Number(oppActive?.hp ?? 0)),
          self_active_energy_bucket: bucketEnergy(
            Number(selfActive?.energy ?? 0),
            Number(selfActive?.max_energy ?? 0),
          ),
          opp_active_energy_bucket: bucketEnergy(
            Number(oppActive?.energy ?? 0),
            Number(oppActive?.max_energy ?? 0),
          ),
          dice_bucket: bucketDice(Number(digest.resource_summary.dice_count ?? 0)),
          omni_bucket: bucketDice(Number(digest.resource_summary.omni_count ?? 0)),
          support_bucket: bucketCount(Number(digest.resource_summary.support_count ?? 0)),
          summon_bucket: bucketCount(Number(digest.resource_summary.summon_count ?? 0)),
          cards_in_hand_bucket: bucketCount(Number(digest.resource_summary.cards_in_hand ?? 0)),
          legal_action_count: legalActions.length,
          actual_action_index: actualActionIndex,
          actual_action_case:
            typeof actualCandidate?.action_case === "string" ? actualCandidate.action_case : null,
          actual_action_definition_id:
            typeof actualCandidate?.card_definition_id === "number"
              ? actualCandidate.card_definition_id
              : actualActionIndex != null
                ? actionDefinitionId(legalActions[actualActionIndex])
                : null,
          actual_action_tags: normalizeTags(actualCandidate?.tags),
        })
      }
    }
    return points
  }

  alignTreeToReplayPoints(
    tree: TreeRecord,
    points: ReplayAlignmentPoint[],
    options: ReplayWindowAlignerOptions = {},
  ): ReplayAlignmentSummary {
    const threshold = options.threshold ?? 0.6
    const firstStep = tree.source_window.steps[0]
    const firstActionCase = firstStep?.selected_candidate?.action_case ?? null
    const pointCandidates = points.filter((point) => {
      if (!tree.source_window.deck_fingerprint_self) {
        return true
      }
      return point.self_deck_fingerprint === tree.source_window.deck_fingerprint_self
    })
    let best: { point: ReplayAlignmentPoint; similarity: number; matched_fields: string[] } | null = null
    for (const point of pointCandidates) {
      const scored = scoreWindowToReplayPoint(tree, point)
      if (!best || scored.similarity > best.similarity) {
        best = { point, ...scored }
      }
    }

    if (!best || best.similarity < threshold) {
      return {
        matched: false,
        benchmark_path: null,
        matchup_id: best?.point.matchup_id ?? null,
        replay_dir: best ? dirname(best.point.replay_file) : null,
        replay_file: best?.point.replay_file ?? null,
        replay_entry_index: best?.point.replay_entry_index ?? null,
        replay_next_state_index: best?.point.replay_next_state_index ?? null,
        replay_action_index: best?.point.actual_action_index ?? null,
        replay_action_case: best?.point.actual_action_case ?? firstActionCase,
        replay_action_tags: best?.point.actual_action_tags ?? [],
        self_deck_fingerprint: best?.point.self_deck_fingerprint ?? tree.source_window.deck_fingerprint_self,
        opponent_deck_fingerprint: best?.point.opponent_deck_fingerprint ?? null,
        similarity: best?.similarity ?? 0,
        matched_fields: best?.matched_fields ?? [],
      }
    }

    return {
      matched: true,
      benchmark_path: null,
      matchup_id: best.point.matchup_id,
      replay_dir: dirname(best.point.replay_file),
      replay_file: best.point.replay_file,
      replay_entry_index: best.point.replay_entry_index,
      replay_next_state_index: best.point.replay_next_state_index,
      replay_action_index: best.point.actual_action_index,
      replay_action_case: best.point.actual_action_case,
      replay_action_tags: best.point.actual_action_tags,
      self_deck_fingerprint: best.point.self_deck_fingerprint,
      opponent_deck_fingerprint: best.point.opponent_deck_fingerprint,
      similarity: best.similarity,
      matched_fields: best.matched_fields,
    }
  }
}

export function scoreWindowToReplayPoint(
  tree: TreeRecord,
  point: ReplayAlignmentPoint,
): { similarity: number; matched_fields: string[] } {
  const matchedFields: string[] = []
  let score = 0
  let maxScore = 0

  const firstStep = tree.source_window.steps[0]
  const firstDigest = firstStep?.digest
  const firstActionCase = firstStep?.selected_candidate?.action_case ?? null
  const firstActionTags = new Set(firstStep?.selected_candidate?.tags ?? [])
  const treeFingerprint = tree.canonical_fingerprint ?? null

  maxScore += 4
  if (tree.source_window.deck_fingerprint_self && tree.source_window.deck_fingerprint_self === point.self_deck_fingerprint) {
    score += 4
    matchedFields.push("self_deck_fingerprint")
  }

  maxScore += 2
  if (tree.source_window.round === point.round) {
    score += 2
    matchedFields.push("round")
  }

  maxScore += 1
  if (tree.source_window.turn === point.turn) {
    score += 1
    matchedFields.push("turn")
  }

  maxScore += 2
  if (tree.source_window.state_fingerprint.self_active_hp_bucket === point.self_active_hp_bucket) {
    score += 2
    matchedFields.push("self_active_hp_bucket")
  }

  maxScore += 2
  if (tree.source_window.state_fingerprint.opp_active_hp_bucket === point.opp_active_hp_bucket) {
    score += 2
    matchedFields.push("opp_active_hp_bucket")
  }

  maxScore += 1
  if (tree.source_window.state_fingerprint.dice_bucket === point.dice_bucket) {
    score += 1
    matchedFields.push("dice_bucket")
  }

  maxScore += 1
  if (tree.source_window.state_fingerprint.omni_bucket === point.omni_bucket) {
    score += 1
    matchedFields.push("omni_bucket")
  }

  maxScore += 2
  if (
    treeFingerprint?.self_active_character_definition_id != null &&
    treeFingerprint.self_active_character_definition_id === point.self_active_character_definition_id
  ) {
    score += 2
    matchedFields.push("self_active_character_definition_id")
  }

  maxScore += 2
  if (
    treeFingerprint?.opp_active_character_definition_id != null &&
    treeFingerprint.opp_active_character_definition_id === point.opp_active_character_definition_id
  ) {
    score += 2
    matchedFields.push("opp_active_character_definition_id")
  }

  maxScore += 3
  if (firstActionCase && firstActionCase === point.actual_action_case) {
    score += 3
    matchedFields.push("actual_action_case")
  }

  maxScore += 2
  const tagOverlap = point.actual_action_tags.filter((tag) => firstActionTags.has(tag)).length
  if (tagOverlap > 0) {
    score += Math.min(2, tagOverlap)
    matchedFields.push("actual_action_tags")
  }

  maxScore += 1
  const legalCountDistance = Math.abs((firstDigest?.candidate_actions.length ?? 0) - point.legal_action_count)
  if (legalCountDistance <= 1) {
    score += 1
    matchedFields.push("legal_action_count")
  }

  return {
    similarity: maxScore > 0 ? score / maxScore : 0,
    matched_fields: matchedFields,
  }
}

export function buildCanonicalFingerprintFromReplayPoint(
  tree: TreeRecord,
  point: ReplayAlignmentPoint,
): CanonicalCombatWindowFingerprint {
  const firstActionTags = point.actual_action_tags.length > 0
    ? point.actual_action_tags
    : tree.source_window.steps[0]?.selected_candidate?.tags ?? []
  const fingerprint: CanonicalCombatWindowFingerprint = {
    deck_fingerprint_self: point.self_deck_fingerprint,
    deck_fingerprint_opp: point.opponent_deck_fingerprint,
    fingerprint_quality: "replay_backed",
    pending_method: tree.source_window.state_fingerprint.pending_method,
    round_bucket: `r${point.round}`,
    turn_player: point.turn,
    self_active_hp_bucket: point.self_active_hp_bucket,
    opp_active_hp_bucket: point.opp_active_hp_bucket,
    self_active_energy_bucket: point.self_active_energy_bucket,
    opp_active_energy_bucket: point.opp_active_energy_bucket,
    dice_bucket: point.dice_bucket,
    omni_bucket: point.omni_bucket,
    tags: firstActionTags,
    matchup_id: point.matchup_id,
    self_active_character_definition_id: point.self_active_character_definition_id,
    opp_active_character_definition_id: point.opp_active_character_definition_id,
    support_bucket: point.support_bucket,
    summon_bucket: point.summon_bucket,
    cards_in_hand_bucket: point.cards_in_hand_bucket,
    first_action_case: point.actual_action_case,
    first_action_definition_id: point.actual_action_definition_id,
    first_action_tags: firstActionTags,
    action_count_bucket: bucketActionCount(tree.source_window.action_count),
    canonical_key: "",
  }
  fingerprint.canonical_key = canonicalFingerprintKey(fingerprint)
  return fingerprint
}

export function canonicalFingerprintKey(fingerprint: CanonicalCombatWindowFingerprint): string {
  return [
    fingerprint.deck_fingerprint_self ?? "unknown-self",
    fingerprint.deck_fingerprint_opp ?? "unknown-opp",
    fingerprint.matchup_id ?? "unknown-matchup",
    fingerprint.round_bucket,
    `t${fingerprint.turn_player}`,
    `selfChar:${fingerprint.self_active_character_definition_id ?? 0}`,
    `oppChar:${fingerprint.opp_active_character_definition_id ?? 0}`,
    `selfHp:${fingerprint.self_active_hp_bucket}`,
    `oppHp:${fingerprint.opp_active_hp_bucket}`,
    `selfEn:${fingerprint.self_active_energy_bucket}`,
    `oppEn:${fingerprint.opp_active_energy_bucket}`,
    `dice:${fingerprint.dice_bucket}`,
    `omni:${fingerprint.omni_bucket}`,
    `sum:${fingerprint.summon_bucket}`,
    `sup:${fingerprint.support_bucket}`,
    `hand:${fingerprint.cards_in_hand_bucket}`,
    `act:${fingerprint.first_action_case ?? "unknown"}`,
    `def:${fingerprint.first_action_definition_id ?? 0}`,
    `len:${fingerprint.action_count_bucket}`,
  ].join("|")
}

async function inferActualActionIndex(
  sim: SimAdapter,
  state: GameState,
  actions: ActionInfoWithModification[],
  expectedNextState: GameState | null,
): Promise<number | null> {
  if (!expectedNextState) {
    return null
  }
  const expected = stableStateSignature(expectedNextState)
  for (let i = 0; i < actions.length; i += 1) {
    const stepped = await sim.step(state, i, actions)
    if (stableStateSignature(stepped.newState) === expected) {
      return i
    }
  }
  return null
}

function findNextDistinctResumeIndex(
  entries: ReturnType<typeof deserializeGameStateLog>,
  fromIndex: number,
): number | null {
  const currentSignature = stableStateSignature(entries[fromIndex]!.state)
  for (let i = fromIndex + 1; i < entries.length; i += 1) {
    const candidate = entries[i]
    if (!candidate?.canResume) {
      continue
    }
    if (stableStateSignature(candidate.state) !== currentSignature) {
      return i
    }
  }
  return null
}

function stableStateSignature(state: GameState): string {
  return JSON.stringify(serializeGameStateLog([{ state, canResume: true }]))
}

function deckCodeToFingerprint(deckCode: string): string {
  const decoded = DEFAULT_ASSETS_MANAGER.decode(deckCode) as { characters: number[] }
  return [...decoded.characters].sort((a, b) => a - b).join("-")
}

function findActiveCharacterState(
  state: GameState,
  who: 0 | 1,
): { definition?: { id?: number } } | null {
  const player = state.players[who] as unknown as {
    activeCharacterId: number
    characters: Array<{ id: number; definition?: { id?: number } }>
  }
  return player.characters.find((character) => character.id === player.activeCharacterId) ?? null
}

function findActiveCharacter(
  characterId: number,
  list: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return list.find((item) => Number(item.id ?? 0) === characterId) ?? list[0]
}

function normalizeTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter((item) => item.length > 0)
    : []
}

function bucketHp(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 4) return "3-4"
  if (value <= 7) return "5-7"
  return "8+"
}

function bucketDice(value: number): string {
  if (value <= 0) return "0"
  if (value <= 2) return "1-2"
  if (value <= 5) return "3-5"
  return "6+"
}

function bucketCount(value: number): string {
  if (value <= 0) return "0"
  if (value === 1) return "1"
  if (value <= 3) return "2-3"
  return "4+"
}

function bucketEnergy(value: number, maxValue: number): string {
  if (maxValue > 0 && value >= maxValue) {
    return "burst_ready"
  }
  if (value <= 0) return "0"
  return `${value}/${maxValue}`
}

function bucketActionCount(value: number): string {
  if (value <= 2) return "2"
  if (value === 3) return "3"
  return "4+"
}

function actionDefinitionId(action: ActionInfoWithModification | undefined): number | null {
  if (!action) {
    return null
  }
  switch (action.type) {
    case "useSkill":
      return action.skill.definition.id
    case "playCard":
      return action.skill.caller.definition.id
    case "switchActive":
      return action.to.definition.id
    case "elementalTuning":
      return action.card.definition.id
    case "declareEnd":
      return 0
    default:
      return null
  }
}

export function normalizeReplayFilePath(value: string): string {
  return resolve(value).replace(/\\/g, "/")
}

export function replayFileBaseName(value: string): string {
  return basename(value).toLowerCase()
}
