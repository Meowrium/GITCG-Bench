// Copyright (C) 2026 Piovium Labs
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

/**
 * V30 Stage 3.C — StateExporter.
 *
 * Builds a `StateObservation` from the public game state visible at a single
 * decision point. Designed to run inside `RecordingPolicyPlayerIO` after the
 * latest `Notification` has arrived: it has access to the same redacted view
 * the policy uses to choose, so no hidden information leaks through.
 */

import type { Notification } from "@gi-tcg/typings"
import type { Action as RpcAction } from "@gi-tcg/typings"
import {
  flattenPreviewVector,
  PREVIEW_VECTOR_SCALAR_DIM,
  extractPreviewVector,
} from "../fingerprint/preview-vector.js"
import { getSkillFingerprint } from "../../knowledge/character-skill-fingerprints.js"
import {
  STATE_OBSERVATION_SCHEMA_VERSION,
  type ActionObservation,
  type CharacterObservation,
  type EntityObservation,
  type HandCardObservation,
  type SideObservation,
  type StateObservation,
} from "./state-observation.js"

/** Number of `DiceType` values we bucket into `dice_counts`. */
const DICE_TYPE_BUCKETS = 9

/** Number of cost requirement types (`DiceRequirementType`). */
const COST_REQ_TYPES = 11

export interface ExportStateObservationInput {
  notificationState: NonNullable<Notification["state"]>
  perspective: 0 | 1
  /**
   * The full validated action slate from the engine. The exporter records
   * one `ActionObservation` per entry so the encoder can score each candidate
   * jointly with the state.
   */
  validActions: ReadonlyArray<{ action: RpcAction; index: number }>
  /** Engine-reported game id for grouping samples by trajectory. */
  gameId: string
  /** Index of this observation within the perspective's trajectory. */
  sampleIndex: number
  /**
   * V31 F6 / D7 (schema v3): which side acted first at start of round 1
   * (coin flip). Required so `SideObservation.is_first_player` carries the
   * only asymmetric signal available in pure mirror matchups. Callers must
   * latch `currentTurn` at the first action decision and pass it for every
   * subsequent export within the same game. Defaults to `perspective` (i.e.
   * "self is first") if omitted, but a `console.warn` flags the legacy path.
   */
  firstPlayer?: 0 | 1
}

export interface ExportStateObservationResult {
  observation: StateObservation
  /** Lookup: candidate_id (string index) → observation index. */
  candidateIndexById: Map<string, number>
}

export class StateExporter {
  static export(input: ExportStateObservationInput): ExportStateObservationResult {
    const { notificationState, perspective, validActions, gameId, sampleIndex, firstPlayer } =
      input

    const selfPlayer = notificationState.player[perspective]
    const oppPlayer = notificationState.player[1 - perspective as 0 | 1]

    // V31 F6 / D7: derive is_first_player flags per side. When the caller did
    // not provide `firstPlayer` (legacy code path), fall back to assuming the
    // perspective is first — strictly wrong but bit-compatible with schema v2
    // consumers that ignored the field entirely.
    const fp: 0 | 1 = firstPlayer ?? perspective
    const selfIsFirst = fp === perspective
    const oppIsFirst = fp !== perspective

    const self = exportSide(selfPlayer, perspective, false, selfIsFirst)
    const opponent = exportSide(oppPlayer, (1 - perspective) as 0 | 1, true, oppIsFirst)

    const selfIds = collectIds(selfPlayer)
    const oppIds = collectIds(oppPlayer)

    const candidate_actions: ActionObservation[] = []
    const candidateIndexById = new Map<string, number>()
    for (let k = 0; k < validActions.length; k++) {
      const { action, index } = validActions[k]
      const observation = exportAction(action, index, perspective, selfIds, oppIds)
      candidateIndexById.set(observation.candidate_id, candidate_actions.length)
      candidate_actions.push(observation)
    }

    const observation: StateObservation = {
      meta: {
        schema_version: STATE_OBSERVATION_SCHEMA_VERSION,
        game_id: gameId,
        sample_index: sampleIndex,
        perspective,
        round: notificationState.roundNumber ?? 0,
        turn: notificationState.currentTurn ?? 0,
        phase: phaseToString(notificationState.phase),
        opponent_declared_end: !!oppPlayer?.declaredEnd,
      },
      self,
      opponent,
      candidate_actions,
      selected_action_index: null,
    }

    return { observation, candidateIndexById }
  }
}

function exportSide(
  player: NonNullable<Notification["state"]>["player"][number] | undefined,
  side: 0 | 1,
  hideHand: boolean,
  isFirstPlayer: boolean,
): SideObservation {
  if (!player) {
    return {
      side,
      declared_end: false,
      legend_used: false,
      characters: [],
      summons: [],
      supports: [],
      combat_statuses: [],
      hand: [],
      hand_size: 0,
      pile_size: 0,
      dice_counts: new Array(DICE_TYPE_BUCKETS).fill(0),
      active_definition_id: 0,
      active_element: 0,
      is_first_player: isFirstPlayer,
    }
  }

  const characters: CharacterObservation[] = (player.character ?? []).map((ch) => ({
    entity_id: ch.id ?? 0,
    definition_id: ch.definitionId ?? 0,
    is_active: false, // patched below
    defeated: !!ch.defeated,
    health: ch.health ?? 0,
    max_health: ch.maxHealth ?? 0,
    energy: ch.energy ?? 0,
    max_energy: ch.maxEnergy ?? 0,
    aura: typeof ch.aura === "number" ? ch.aura : 0,
    attached_definition_ids: (ch.entity ?? []).map((e: any) => e?.definitionId ?? 0).filter((x: number) => x > 0),
    immune_remaining: extractImmuneRemaining(ch),
    skill_fingerprint: getSkillFingerprint(ch.definitionId ?? 0),
  }))
  // active character: first non-defeated
  const activeIndex = characters.findIndex((c) => !c.defeated)
  if (activeIndex >= 0) {
    characters[activeIndex].is_active = true
  }
  const activeChar = activeIndex >= 0 ? characters[activeIndex] : null
  const active_definition_id = activeChar?.definition_id ?? 0
  const active_element = characterElementFromDefinitionId(active_definition_id)

  const summons: EntityObservation[] = (player.summon ?? []).map(extractEntity)
  const supports: EntityObservation[] = (player.support ?? []).map(extractEntity)
  const combat_statuses: EntityObservation[] = (player.combatStatus ?? []).map(extractEntity)

  const hand: HandCardObservation[] = []
  if (!hideHand) {
    for (const c of player.handCard ?? []) {
      const definitionId = c?.definitionId ?? 0
      if (definitionId > 0) hand.push({ definition_id: definitionId })
    }
  }
  const hand_size = (player.handCard ?? []).length
  const pile_size = (player.pileCard ?? []).length

  const dice_counts = new Array(DICE_TYPE_BUCKETS).fill(0)
  for (const d of player.dice ?? []) {
    if (typeof d === "number" && d >= 0 && d < DICE_TYPE_BUCKETS) {
      dice_counts[d]++
    }
  }

  return {
    side,
    declared_end: !!player.declaredEnd,
    legend_used: !!player.legendUsed,
    characters,
    summons,
    supports,
    combat_statuses,
    hand,
    hand_size,
    pile_size,
    dice_counts,
    active_definition_id,
    active_element,
    is_first_player: isFirstPlayer,
  }
}

/**
 * V31 F3: character element (DiceType numeric) from the stable character
 * definition_id convention (1<E>xx where E: 1=cryo,2=hydro,3=pyro,4=electro,
 * 5=anemo,6=geo,7=dendro). DiceType numeric matches: Cryo=1..Dendro=7.
 * Returns 0 when the id does not follow the convention.
 */
function characterElementFromDefinitionId(defId: number): number {
  if (defId < 1000) return 0
  const elementDigit = Math.floor(defId / 100) % 10
  return elementDigit >= 1 && elementDigit <= 7 ? elementDigit : 0
}

/**
 * V31 F5: best-effort extraction of remaining "immune to defeat" charges from a
 * character's attached entities. Engine surfaces immunity as a status entity;
 * we count entities exposing a recognisable immune marker. Returns 0 when none
 * detected. Refined once engine preview exposes `_immuneInfo` (framework §0.1.3).
 */
function extractImmuneRemaining(ch: any): number {
  let total = 0
  for (const e of ch?.entity ?? []) {
    const tags: string[] = Array.isArray(e?.tags) ? e.tags : []
    const looksImmune =
      tags.some((t) => typeof t === "string" && t.toLowerCase().includes("immune")) ||
      e?.immune === true
    if (looksImmune) {
      total += typeof e?.usage === "number" ? e.usage : 1
    }
  }
  return total
}

function extractEntity(e: any): EntityObservation {
  // EntityState is a generic struct; we surface usage when present.
  const usage =
    typeof e?.usage === "number"
      ? e.usage
      : typeof e?.variableValue === "number"
        ? e.variableValue
        : null
  return {
    entity_id: e?.id ?? 0,
    definition_id: e?.definitionId ?? 0,
    usage,
    has_usage_per_round: !!e?.hasUsagePerRound,
    primary_var: typeof e?.variableValue === "number" ? e.variableValue : null,
  }
}

function exportAction(
  action: RpcAction,
  index: number,
  perspective: 0 | 1,
  selfIds: ReadonlySet<number>,
  oppIds: ReadonlySet<number>,
): ActionObservation {
  const inner = action.action
  let action_case = "unknown"
  let primary_definition_id = 0
  let target_ids: number[] = []
  let tuning_target: number | null = null
  let changes_active = false
  if (inner) {
    action_case = inner.$case
    switch (inner.$case) {
      case "useSkill": {
        const v = inner.value
        primary_definition_id = v.skillDefinitionId
        target_ids = [...(v.targetIds ?? [])]
        break
      }
      case "playCard": {
        const v = inner.value
        primary_definition_id = v.cardDefinitionId
        target_ids = [...(v.targetIds ?? [])]
        break
      }
      case "switchActive": {
        const v = inner.value
        primary_definition_id = v.characterDefinitionId
        target_ids = v.characterId ? [v.characterId] : []
        changes_active = true
        break
      }
      case "elementalTuning": {
        // V31 F3: capture the tuning target element (DiceType). The被调和 card
        // id has no dedicated field on the wire; targetDice is the decision-
        // relevant axis (framework §1.4.2 / Q6).
        const v = inner.value
        primary_definition_id = 0
        tuning_target = typeof v.targetDice === "number" ? v.targetDice : null
        break
      }
      case "declareEnd":
        primary_definition_id = 0
        break
    }
  }

  const cost_by_type = new Array(COST_REQ_TYPES).fill(0)
  for (const c of action.requiredCost ?? []) {
    if (typeof c.type === "number" && c.type >= 0 && c.type < COST_REQ_TYPES) {
      cost_by_type[c.type] += c.count ?? 0
    }
  }
  // ALIGNED=8, ENERGY=9, LEGEND=10. dice_total ≈ everything except ENERGY/LEGEND.
  let cost_total_dice = 0
  for (let i = 0; i < COST_REQ_TYPES; i++) {
    if (i === 9 /* ENERGY */ || i === 10 /* LEGEND */) continue
    cost_total_dice += cost_by_type[i]
  }
  const cost_energy = cost_by_type[9] ?? 0
  // V31 F3: LEGEND (秘传) is a once-per-game resource axis (framework §0.3.3 / Q7).
  const consumes_legend = (cost_by_type[10] ?? 0) > 0

  let preview_vector: number[] | null = null
  if (action.preview && action.preview.length > 0) {
    try {
      const pv = extractPreviewVector(action.preview, {
        perspective,
        selfIds,
        opponentIds: oppIds,
      })
      preview_vector = flattenPreviewVector(pv)
    } catch {
      preview_vector = null
    }
  }
  // Defensive: ensure exactly PREVIEW_VECTOR_SCALAR_DIM
  if (preview_vector !== null && preview_vector.length !== PREVIEW_VECTOR_SCALAR_DIM) {
    if (preview_vector.length < PREVIEW_VECTOR_SCALAR_DIM) {
      while (preview_vector.length < PREVIEW_VECTOR_SCALAR_DIM) preview_vector.push(0)
    } else {
      preview_vector = preview_vector.slice(0, PREVIEW_VECTOR_SCALAR_DIM)
    }
  }

  return {
    candidate_id: String(index),
    action_case,
    primary_definition_id,
    cost_by_type,
    cost_total_dice,
    cost_energy,
    is_fast: !!action.isFast,
    target_ids,
    preview_vector,
    tuning_target,
    consumes_legend,
    changes_active,
  }
}

function collectIds(
  player: NonNullable<Notification["state"]>["player"][number] | undefined,
): Set<number> {
  const ids = new Set<number>()
  if (!player) return ids
  for (const ch of player.character ?? []) if (typeof ch.id === "number") ids.add(ch.id)
  for (const s of player.summon ?? []) if (typeof s.id === "number") ids.add(s.id)
  for (const s of player.support ?? []) if (typeof s.id === "number") ids.add(s.id)
  for (const s of player.combatStatus ?? []) if (typeof s.id === "number") ids.add(s.id)
  return ids
}

function phaseToString(phase: number | undefined): string {
  // PbPhaseType numeric → coarse label. We keep the raw number as a fallback.
  const map: Record<number, string> = {
    0: "init_hands",
    1: "init_active",
    2: "roll",
    3: "action",
    4: "end",
    5: "game_end",
  }
  if (phase == null) return "unknown"
  return map[phase] ?? `phase_${phase}`
}
