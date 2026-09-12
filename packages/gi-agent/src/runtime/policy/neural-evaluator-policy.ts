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
 * V30 Stage 3.G — NeuralEvaluatorPolicy.
 *
 * Augments `EvaluatorPolicy` (logistic-regression GBDT-equivalent baseline)
 * with the V30 neural encoder: for every candidate the encoder produces a
 * Q(s, a) logit; we mix it with the existing learned + heuristic score:
 *
 *     final = baseline.finalScore
 *           + alpha * (neural_q - mean_neural_q) * neuralScale
 *
 * `alpha` ∈ [0, 1] starts low (0.3) and can be ramped via configuration. At
 * `alpha=0` the policy behaves identically to `EvaluatorPolicy`, ensuring
 * trivial rollback (V30 §5.5 design: AlphaZero-style co-existence).
 *
 * This policy never owns the engine; it consumes the visible
 * `Notification["state"]` via a side-channel (`setLatestNotification`).
 * `RecordingPolicyPlayerIO` already captures this and can pass it through
 * (see V30 §5.3).
 */

import type { Notification } from "@gi-tcg/typings"
import { EvaluatorPolicy, type EvaluatorPolicyOptions } from "./evaluator-policy.js"
import type {
  PolicyDecision,
  PolicyDecisionContext,
  PolicyTurnDigest,
  RankedPolicyCandidate,
} from "./types.js"
import { StateExporter } from "../../learning/encoder/state-exporter.js"
import { V30NeuralPredictor } from "../../learning/encoder/neural-predictor.js"
import type { CalibratedWeights } from "../../learning/scoring/logistic-reg.js"
import {
  confidenceGatedAlpha,
  type ConfidenceGateConfig,
} from "./knowledge-source.js"

export interface NeuralEvaluatorPolicyOptions extends EvaluatorPolicyOptions {
  /** Path to encoder weights JSON (output of `gitcg_ml.train_v30_encoder`). */
  encoderWeightsPath?: string
  /** Pre-loaded predictor instead of a path (for tests). */
  encoderPredictor?: V30NeuralPredictor | null
  /**
   * Mix coefficient α ∈ [0, 1]. Default 0.3 — empirically optimal per the
   * V30 §22 α-sweep (448-game bidirectional benchmark): WR vs baseline is an
   * inverted-U with peak at α=0.3 (51.8% WR, +3.4pp over baseline). α=0.1 is
   * too weak (signal drowned by baseline finalScore ~10-50), α=0.5×scale8 is
   * too strong (encoder overrides validated heuristics → -1.5pp).
   */
  neuralAlpha?: number
  /** Score multiplier for the sigmoid-normalized (winProb − mean winProb)
   * contribution. Default 4.0; with α=0.3 this bounds the neural delta to
   * ±0.6 final-score points (V30 §22 optimal). */
  neuralScoreScale?: number
  /** Side this instance is playing (0 or 1). Required for state observation perspective. */
  side: 0 | 1
  /**
   * V31 F7 (P4): when set, α is gated by the S3 model's confidence for the
   * current matchup instead of being a fixed constant. Pass the accumulated
   * self-play sample count for this matchup (or a running estimate); α then
   * ramps from `minAlpha` (S3 only breaks ties) toward `maxAlpha` (S3 leads)
   * as data accrues. Encodes the bootstrap→decision transition: data-sparse
   * matchups defer to S1/S2 priors, data-rich matchups trust learned S3.
   */
  confidenceGate?: ConfidenceGateConfig
  /** Matchup sample count feeding {@link confidenceGate}. Ignored if no gate. */
  matchupSampleCount?: number | null
}

export class NeuralEvaluatorPolicy extends EvaluatorPolicy {
  private readonly predictor: V30NeuralPredictor | null
  private readonly alpha: number
  private readonly scoreScale: number
  private readonly side: 0 | 1
  private latestNotificationState?: Notification["state"]
  private observationCounter = 0
  /**
   * V31 F6 / D7 (schema v3) — first-mover latched from the engine on the
   * earliest action-phase notification of round 1. Carried into every
   * `StateExporter.export` so encoder input matches the training-time layout.
   */
  private firstPlayer: 0 | 1 | null = null

  constructor(weights: CalibratedWeights, options: NeuralEvaluatorPolicyOptions) {
    super(weights, options)
    // V31 F7: confidence-gated α (P4). When a confidenceGate is supplied, α is
    // derived from the matchup's S3 sample count so a confident model leads and
    // a data-sparse one merely breaks ties. Otherwise fall back to the fixed
    // neuralAlpha (default 0.3, the V30 §22 inverted-U peak).
    if (options.confidenceGate) {
      this.alpha = confidenceGatedAlpha(
        options.matchupSampleCount,
        options.confidenceGate,
      )
    } else {
      this.alpha = clamp01(options.neuralAlpha ?? 0.3)
    }
    this.scoreScale = options.neuralScoreScale ?? 4.0
    this.side = options.side
    if (options.encoderPredictor) {
      this.predictor = options.encoderPredictor
    } else if (options.encoderWeightsPath) {
      try {
        this.predictor = V30NeuralPredictor.fromFile(options.encoderWeightsPath)
      } catch (err) {
        console.warn(
          `[NeuralEvaluatorPolicy] Failed to load encoder weights: ${err instanceof Error ? err.message : String(err)}; falling back to logistic only.`,
        )
        this.predictor = null
      }
    } else {
      this.predictor = null
    }
  }

  /** Updated by `RecordingPolicyPlayerIO`-equivalent shim before `choose`. */
  setLatestNotification(state: Notification["state"]): void {
    this.latestNotificationState = state
    // V31 F6 / D7: latch first-mover at earliest action-phase view (round 1).
    if (
      this.firstPlayer === null &&
      state?.phase === 3 &&
      (state.roundNumber ?? 0) <= 1 &&
      typeof state.currentTurn === "number"
    ) {
      this.firstPlayer = (state.currentTurn & 1) as 0 | 1
    }
  }

  override choose(digest: PolicyTurnDigest, context?: PolicyDecisionContext): PolicyDecision {
    const baseDecision = super.choose(digest, context)
    if (!this.predictor || this.alpha <= 0 || !this.latestNotificationState) {
      return baseDecision
    }

    // Build StateObservation for the encoder. The candidate slate as seen by
    // the digest is what we score; we ignore action.preview here because the
    // exporter rebuilds preview vectors directly from raw PreviewData when it
    // sees them — but at this layer we only have the digest's candidates. We
    // synthesise a minimal `validActions` array compatible with StateExporter.
    const validActions = digest.candidate_actions
      .map((c) => ({
        index: parseCandidateIndex(c.candidate_id),
        action: synthesisActionFromCandidate(c),
      }))
      .filter((va) => va.index >= 0)
    const exported = StateExporter.export({
      notificationState: this.latestNotificationState,
      perspective: this.side,
      validActions,
      gameId: "runtime",
      sampleIndex: this.observationCounter++,
      firstPlayer: this.firstPlayer ?? this.side,
    })

    let pred
    try {
      pred = this.predictor.predict({ observation: exported.observation })
    } catch (err) {
      console.warn(
        `[NeuralEvaluatorPolicy] Predictor failed: ${err instanceof Error ? err.message : String(err)}; using baseline only.`,
      )
      return baseDecision
    }
    const qById = new Map<string, number>()
    for (let i = 0; i < pred.candidateIds.length; i++) {
      // V30 Stage 3 — sigmoid-normalize encoder Q (logit-space) to win-prob
      // ∈ (0, 1) before mixing. Empirically the raw Q can have stddev > 1
      // across candidates; multiplying by scoreScale × alpha then made the
      // neural delta dominate the baseline finalScore (see §22 alpha-mix
      // benchmark, neural-α0.5 mean WR 39.84%). Sigmoid bounds delta to
      // [-0.5, +0.5], making `scoreScale` a directly interpretable
      // "max final-score points the encoder can shift a candidate".
      const winProb = 1 / (1 + Math.exp(-pred.q[i]))
      qById.set(pred.candidateIds[i], winProb)
    }
    let qSum = 0
    let qCount = 0
    for (const r of baseDecision.ranked) {
      const q = qById.get(r.candidateId)
      if (q !== undefined && Number.isFinite(q)) {
        qSum += q
        qCount++
      }
    }
    if (qCount === 0) return baseDecision
    const qMean = qSum / qCount

    const reranked: RankedPolicyCandidate[] = baseDecision.ranked
      .map((r) => {
        const q = qById.get(r.candidateId)
        if (q === undefined || !Number.isFinite(q)) return r
        const delta = (q - qMean) * this.scoreScale * this.alpha
        return {
          ...r,
          finalScore: r.finalScore + delta,
          reasons: [
            ...r.reasons,
            `neural=+${delta.toFixed(3)}(p=${q.toFixed(3)},alpha=${this.alpha.toFixed(2)})`,
          ],
        }
      })
      .sort((a, b) => b.finalScore - a.finalScore)

    return {
      ...baseDecision,
      ranked: reranked,
      selectedCandidateId: reranked[0]?.candidateId ?? null,
    }
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function parseCandidateIndex(id: string | undefined): number {
  if (!id) return -1
  const n = Number(id)
  return Number.isFinite(n) ? n : -1
}

/**
 * Synthesise a minimal `Action` shape from a `PolicyCandidateAction` so the
 * StateExporter can build an `ActionObservation`. We only need
 * `action.action.$case`, `requiredCost`, and `preview` to be populated — the
 * StateExporter handles missing fields gracefully.
 */
function synthesisActionFromCandidate(c: import("./types.js").PolicyCandidateAction): import("@gi-tcg/typings").Action {
  const actionCase = String(c.action_case ?? "unknown")
  const previewData = (c as { preview_data?: import("@gi-tcg/typings").PreviewData[] }).preview_data
  const skillDefId = typeof c.skill_definition_id === "number" ? c.skill_definition_id : 0
  const cardDefId = typeof c.card_definition_id === "number" ? c.card_definition_id : 0
  let action: import("@gi-tcg/typings").Action["action"]
  switch (actionCase) {
    case "useSkill":
      action = {
        $case: "useSkill",
        value: {
          skillDefinitionId: skillDefId,
          targetIds: Array.isArray(c.target_ids) ? c.target_ids : [],
        },
      }
      break
    case "playCard":
      action = {
        $case: "playCard",
        value: {
          cardId: 0,
          cardDefinitionId: cardDefId,
          targetIds: Array.isArray(c.target_ids) ? c.target_ids : [],
          willBeEffectless: false,
        },
      }
      break
    case "switchActive":
      action = {
        $case: "switchActive",
        value: {
          characterId: 0,
          characterDefinitionId: cardDefId || skillDefId || 0,
        },
      }
      break
    case "elementalTuning":
      action = {
        $case: "elementalTuning",
        value: { removedCardId: 0, targetDice: 0 },
      }
      break
    case "declareEnd":
    default:
      action = { $case: "declareEnd", value: {} }
      break
  }
  return {
    action,
    preview: previewData ?? [],
    requiredCost: [],
    autoSelectedDice: [],
    validity: 1, // VALID
    isFast: false,
  } as import("@gi-tcg/typings").Action
}
