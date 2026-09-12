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
 * V31 F7 — Knowledge-source taxonomy (P4).
 *
 * Framework principle P4 fixes the **decision-time** priority of knowledge
 * sources:
 *
 *     S3 (data-driven / learned) > S1 (deck-aware template) > S2 (meta rule)
 *
 * and the **bootstrap** priority is the reverse (S2 → S1 → S3) while S3 has no
 * data yet. This module makes that taxonomy *explicit* so that:
 *
 *  1. Every runtime scorer can be tagged with the source tier it belongs to
 *     (auditing / debugging / future routing).
 *  2. We can distinguish **safety constraints** (hard, never overridden — e.g.
 *     lethal detection, immunity, illegal-action guards) from **heuristic
 *     priors** (soft S2/S1 signals that a confident S3 model is allowed to
 *     override). This separation is the concrete anti-pattern guard against
 *     "decision-time S2 overriding learned S3" (P4 反例).
 *  3. The neural mixer (`NeuralEvaluatorPolicy`) can ramp its α toward S3 as a
 *     matchup accumulates samples, instead of forever treating S3 as a fixed
 *     tie-breaker (V30 §22.1 risk).
 *
 * This module is pure data + small pure functions — no engine access, no I/O.
 */

/** The three knowledge sources defined by P4. */
export type KnowledgeSource =
  | "S1_deck_template" // deck-aware victory path / key components (human / LLM authored)
  | "S2_meta_rule" // cross-deck heuristic ("protect carry before burst", etc.)
  | "S3_learned" // RL / GBDT / encoder learned from self-play

/**
 * Constraint class within a source. Orthogonal to KnowledgeSource:
 * - "safety": absolute. Always applied, never overridden by S3. Encodes
 *   correctness / lethality / legality (e.g. "don't pass up guaranteed lethal",
 *   "respect immunity", "don't play illegal action"). Lives mostly in S2 but is
 *   special: it is NOT a defeasible prior.
 * - "heuristic": soft prior. A confident S3 model may override it at decision
 *   time (P4: 决策时 S3 > S1 > S2).
 */
export type ConstraintClass = "safety" | "heuristic"

export interface KnowledgeSourceTag {
  source: KnowledgeSource
  constraintClass: ConstraintClass
  /** Short human note for audits. */
  note?: string
}

/**
 * Canonical mapping of well-known runtime scorer / component ids → their
 * knowledge-source tier and constraint class.
 *
 * Ids correspond to scoring-registry component ids and policy module roles.
 * Unknown ids default to S2 heuristic (see {@link knowledgeSourceFor}).
 */
export const KNOWLEDGE_SOURCE_REGISTRY: Record<string, KnowledgeSourceTag> = {
  // ── S3: learned ─────────────────────────────────────────────────────────
  gbdt_value: { source: "S3_learned", constraintClass: "heuristic", note: "GBDT value artifact" },
  gbdt_ranker: { source: "S3_learned", constraintClass: "heuristic", note: "GBDT ranker artifact" },
  q_value: { source: "S3_learned", constraintClass: "heuristic", note: "Q-value artifact" },
  evaluator_logistic: { source: "S3_learned", constraintClass: "heuristic", note: "logistic evaluator weights" },
  neural_encoder: { source: "S3_learned", constraintClass: "heuristic", note: "V30 DeepSets encoder" },

  // ── S1: deck-aware template ───────────────────────────────────────────────
  gameplan: { source: "S1_deck_template", constraintClass: "heuristic", note: "GamePlan runtime state / phase prefer tags" },
  macro_plan: { source: "S1_deck_template", constraintClass: "heuristic", note: "macro plan alignment" },
  plan_search: { source: "S1_deck_template", constraintClass: "heuristic", note: "combat-window plan guidance" },
  reaction_chain: { source: "S1_deck_template", constraintClass: "heuristic", note: "deck reaction-chain templates" },

  // ── S2: cross-deck meta rules (soft) ─────────────────────────────────────
  tempo_value: { source: "S2_meta_rule", constraintClass: "heuristic", note: "tempo / initiative heuristic" },
  temporal_opportunity: { source: "S2_meta_rule", constraintClass: "heuristic", note: "temporal portfolio heuristic" },
  strategic_value: { source: "S2_meta_rule", constraintClass: "heuristic", note: "strategic value adjustment" },
  tune_followup: { source: "S2_meta_rule", constraintClass: "heuristic", note: "elemental tuning follow-up" },

  // ── S2: SAFETY (hard, never overridden by S3) ────────────────────────────
  lethal_chain: { source: "S2_meta_rule", constraintClass: "safety", note: "guaranteed-lethal detection" },
  declare_end_constraints: { source: "S2_meta_rule", constraintClass: "safety", note: "declareEnd hard constraints (V29 HC2)" },
  immunity_guard: { source: "S2_meta_rule", constraintClass: "safety", note: "immune-to-defeat handling (V31 F5)" },
  legal_action_guard: { source: "S2_meta_rule", constraintClass: "safety", note: "illegal / effectless action guard" },
}

const DEFAULT_TAG: KnowledgeSourceTag = {
  source: "S2_meta_rule",
  constraintClass: "heuristic",
  note: "untagged (default S2 heuristic)",
}

/** Resolve the knowledge-source tag for a scorer / component id. */
export function knowledgeSourceFor(id: string): KnowledgeSourceTag {
  return KNOWLEDGE_SOURCE_REGISTRY[id] ?? DEFAULT_TAG
}

/** True if this id is an absolute safety constraint (never overridable by S3). */
export function isSafetyConstraint(id: string): boolean {
  return knowledgeSourceFor(id).constraintClass === "safety"
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence-gated α (P4: S3 takes over as it accumulates data)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfidenceGateConfig {
  /** α at zero confidence (S3 only breaks ties). Default 0.1. */
  minAlpha?: number
  /** α at full confidence (S3 leads). Default 0.6. */
  maxAlpha?: number
  /**
   * Sample count at which S3 is considered "confident enough" to reach
   * `maxAlpha`. Below this, α ramps up linearly from `minAlpha`. Default 40000
   * (≈ the V30 §16.3 信息论下限 for a single matchup to be trustworthy).
   */
  confidentSampleCount?: number
}

/**
 * Map a matchup's accumulated S3 sample count to a mixing α.
 *
 * Encodes P4's bootstrap→decision transition:
 *   - data-sparse matchup → low α → S1/S2 priors dominate (safe).
 *   - data-rich matchup   → high α → S3 leads (trust the learned model).
 *
 * Linear ramp from `minAlpha` to `maxAlpha` over [0, confidentSampleCount].
 * Returns `minAlpha` when sampleCount is null/undefined/invalid (conservative).
 */
export function confidenceGatedAlpha(
  sampleCount: number | null | undefined,
  cfg: ConfidenceGateConfig = {},
): number {
  const minAlpha = clamp01(cfg.minAlpha ?? 0.1)
  const maxAlpha = clamp01(cfg.maxAlpha ?? 0.6)
  const confidentN = Math.max(1, cfg.confidentSampleCount ?? 40000)
  if (typeof sampleCount !== "number" || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    return minAlpha
  }
  const t = Math.min(1, sampleCount / confidentN)
  const lo = Math.min(minAlpha, maxAlpha)
  const hi = Math.max(minAlpha, maxAlpha)
  return lo + (hi - lo) * t
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
