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
 * V30 Stage 3 — StateObservation schema.
 *
 * Variable-length entity-set view of the game state from a single perspective.
 * Designed as the input contract for the DeepSets / ID-embedding encoder
 * trained in `gi-ml/python` (PyTorch) and consumed by `NeuralEvaluatorPolicy`.
 *
 * Design notes
 * ------------
 * - All fields are JSON-serialisable primitives so that observations can be
 *   appended to the DataLake (`samples.state_observation` column) and replayed
 *   off-line for training without re-running the engine.
 * - We use definition_id as the embedding key (one per character / card /
 *   summon / support / status); per-instance numeric features (hp, energy,
 *   usage, …) are kept alongside the id so the encoder can fuse them.
 * - Opponent hand is *count only* (hidden information). For pile counts we
 *   record both sides because they are public.
 * - Action context is split out: the full candidate slate is encoded as a
 *   list of `ActionObservation` entries so each candidate produces a separate
 *   action-side input vector.
 *
 * Schema versioning
 * -----------------
 * Bump `STATE_OBSERVATION_SCHEMA_VERSION` whenever you change the shape in
 * a way that breaks Python training scripts. The trainer validates the
 * version stamp and refuses to mix incompatible captures.
 */

export const STATE_OBSERVATION_SCHEMA_VERSION = 4

/** ID-vocabularies. Each entity kind has its own embedding table. */
export type EntityKindKey =
  | "character"
  | "summon"
  | "support"
  | "combat_status"
  | "character_status"
  | "hand_card"

export interface CharacterObservation {
  /** Engine-side instance id (unique per game). */
  entity_id: number
  /** Definition id (embedding key). */
  definition_id: number
  /** True for the side currently in play. */
  is_active: boolean
  /** True if defeated. */
  defeated: boolean
  /** Health / max health (raw integers). */
  health: number
  max_health: number
  /** Energy / max energy. */
  energy: number
  max_energy: number
  /** AuraType numeric (see PbAuraType). 0 = none. */
  aura: number
  /** Definition ids of attached statuses + equipment. */
  attached_definition_ids: number[]
  /**
   * V31 F5 (schema v2): remaining "immune to defeat" charges on this character
   * (e.g. Zhongli shield-on-defeat, Beidou-style effects). 0 = no immunity.
   * Lets the encoder learn the structural value of breaking an immunity
   * (K_immune_break sub-class, framework §0.1.3 / §2.2.1).
   */
  immune_remaining?: number
  /**
   * V31 F9 (schema v4): precomputed 256-dim Character Skill Fingerprint
   * (static skill structure). Filled by StateExporter from the generated
   * artifact; absent for legacy observations (backfilled with zeros by
   * encoder/trainer).
   */
  skill_fingerprint?: number[]
}

export interface EntityObservation {
  entity_id: number
  definition_id: number
  /** Optional usage counter (summons / supports). */
  usage?: number | null
  /** Whether `usage` is per-round (vs total). */
  has_usage_per_round?: boolean
  /** First numeric variable, if exposed by the engine (extensible). */
  primary_var?: number | null
}

export interface HandCardObservation {
  /** Hidden for opponent (entity_id is irrelevant for embedding). */
  definition_id: number
}

export interface SideObservation {
  /** 0 or 1. Encoded as a feature so the encoder can be perspective-asymmetric. */
  side: 0 | 1
  declared_end: boolean
  legend_used: boolean
  characters: CharacterObservation[]
  summons: EntityObservation[]
  supports: EntityObservation[]
  combat_statuses: EntityObservation[]
  /** Pile / hand sizes are public, contents are not (for opponent). */
  hand: HandCardObservation[]
  hand_size: number
  pile_size: number
  /** Dice histogram by DiceType (length 9: 0=UNSPEC,1..7=elements,8=OMNI). */
  dice_counts: number[]
  /**
   * V31 F3 (schema v2): active character as a first-class "tier-0 resource".
   * The active character决定 ALIGNED 费用解锁哪些手牌 (framework §0.3.1 / Q8),
   * so we surface it explicitly rather than forcing the encoder to scan
   * `characters[].is_active`.
   */
  active_definition_id: number
  /** V31 F3: active character element (DiceType numeric, 0 if none/unknown). */
  active_element: number
  /**
   * V31 F6 / D7 (schema v3): whether this side was the first mover at the
   * start of round 1 (the coin flip). Carries the only asymmetric signal
   * available in pure mirror matchups (same deck on both sides), where
   * gen3/gen4 collapsed to symmetric Q distributions and lost 0/2 in
   * mirror brackets (see §F6.D5 / §F6.D6). Required field; collectors
   * must latch `currentTurn` at the first action observation and propagate
   * via `StateExporter.export({ ..., firstPlayer })`.
   */
  is_first_player: boolean
}

/** A single candidate action observation. */
export interface ActionObservation {
  /** Position in the engine's `action[]` array; used as `selectedCandidateId`. */
  candidate_id: string
  /** Top-level case (`useSkill` / `playCard` / `switchActive` / `elementalTuning` / `declareEnd`). */
  action_case: string
  /**
   * Primary definition id for embedding lookup.
   * - useSkill → skill definition id
   * - playCard → card definition id
   * - elementalTuning → card definition id (the card being tuned)
   * - switchActive → target character definition id
   * - declareEnd → 0
   */
  primary_definition_id: number
  /** Cost vector by DiceRequirementType (length 11). */
  cost_by_type: number[]
  /** Total dice cost (= sum of cost_by_type[0..8] + aligned). */
  cost_total_dice: number
  /** Energy cost (= cost_by_type[9]). */
  cost_energy: number
  /** Whether this is a fast / quick action. */
  is_fast: boolean
  /** Target entity ids if the action requires picking. */
  target_ids: number[]
  /**
   * Stage 2.A PreviewMutationVector flat array (length = preview vector dim).
   * Populated only when previewer was available at capture time.
   */
  preview_vector: number[] | null
  /**
   * V31 F3 (schema v2): elementalTuning target element (DiceType numeric).
   * Defaults to the active character's element; differs only when a
   * ChangeCardTuningTarget modifier is active (framework §1.4.2 / Q6).
   * null for non-tuning actions.
   */
  tuning_target?: number | null
  /**
   * V31 F3 (schema v2): whether this action consumes the once-per-game LEGEND
   * (秘传) resource (framework §0.3.3 / Q7).
   */
  consumes_legend?: boolean
  /**
   * V31 F3 (schema v2): whether executing this action changes the active
   * character (switchActive, or skills that force a switch).
   */
  changes_active?: boolean
}

export interface StateObservationMeta {
  schema_version: typeof STATE_OBSERVATION_SCHEMA_VERSION
  game_id: string
  /** Sample index within the game (monotonically increasing per side). */
  sample_index: number
  /** Side from which the observation was captured. */
  perspective: 0 | 1
  /** Round number (1-indexed). */
  round: number
  /** Engine-reported turn (cumulative). */
  turn: number
  /** Phase string (`action`, `mulligan`, …). */
  phase: string
  /** Whether the opponent has declared end-of-round. */
  opponent_declared_end: boolean
}

export interface StateObservation {
  meta: StateObservationMeta
  self: SideObservation
  opponent: SideObservation
  candidate_actions: ActionObservation[]
  /** Index into `candidate_actions` of the action that was actually taken. */
  selected_action_index: number | null
  /**
   * V31 F6 / D3 (AlphaZero flywheel) — search policy π_MCTS over
   * `candidate_actions`, captured during ISMCTS self-play (V30 §7). When
   * present, length === `candidate_actions.length` and the entries sum to ~1
   * (normalised mean visit counts). The encoder's Q-head softmax is distilled
   * against this target (policy-distillation loss) so the learned policy
   * absorbs the search's improvement — the engine of the self-play flywheel.
   *
   * Absent (null/undefined) for samples collected by plain policies (terminal
   * label only); the trainer skips the distillation term for those rows,
   * keeping legacy datasets bit-compatible.
   */
  policy_target?: number[] | null
}

/**
 * Compact serialisation envelope: training scripts read NDJSON of these.
 */
export interface StateObservationRecord {
  observation: StateObservation
  /** 1.0 = won, 0.0 = lost. Same convention as DataLake.label. */
  label: number
  /** Importance weight (role / round bonus). */
  weight: number
  /**
   * V31 F6 / D3 — search policy target pi_MCTS over `observation.candidate_actions`
   * (normalised visit counts). Mirrors `observation.policy_target`; surfaced at
   * the record level so the Python trainer's policy-distillation loss can read
   * it directly. Absent for non-self-play rows.
   */
  policy_target?: number[] | null
}
