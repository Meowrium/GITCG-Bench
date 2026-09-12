// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { FeatureExtractor } from "../../learning/scoring/feature-extractor.js";
import { LogisticCalibrator, type CalibratedWeights } from "../../learning/scoring/logistic-reg.js";
import {
  FeatureExtension,
  type FeatureExtensionInput,
} from "../../learning/scoring/feature-extension.js";
import type { FingerprintLake } from "../../learning/fingerprint/fingerprint-lake.js";
import {
  extractPreviewVector,
  type PreviewMutationVector,
} from "../../learning/fingerprint/preview-vector.js";
import type { PreviewData } from "@gi-tcg/typings";
import { scoreDeckPriorFeatures } from "../../learning/features/deck-prior-flattener.js";
import { scoreDeckActionPrior, type DeckActionPriorConfig, DEFAULT_DECK_ACTION_PRIOR_CONFIG } from "./deck-action-prior.js";
import { BaselinePolicy, type BaselinePolicyOptions, type HeuristicProfile } from "./baseline-policy.js";
import type {
  PolicyCandidateAction,
  PolicyDecisionContext,
  PolicyDecision,
  PolicyTurnDigest,
  RankedPolicyCandidate,
} from "./types.js";
import type { PolicyDeckPriorContext, PolicyPriorMode } from "./prior-types.js";
import { generateTurnPlan, computeDiceReservation } from "./character-value-evaluator.js";
import { matchReactionChainTemplates } from "./reaction-chain-templates.js";
import { matchAnyPattern } from "../plan/pattern-matcher.js";

export interface EvaluatorPolicyOptions extends BaselinePolicyOptions {
  learnedScoreScale?: number;
  priorMode?: PolicyPriorMode;
  priorScoreScale?: number;
  priorContext?: PolicyDeckPriorContext;
  /** V30 Stage 2.B — FingerprintLake for action embedding lookup. Optional. */
  fingerprintLake?: FingerprintLake | null;
  /**
   * V30 Stage 2.B — Set true to enable PreviewMutationVector + Fingerprint
   * extension feature channel during scoring. Defaults to auto-detect:
   * if the loaded weights contain extension coefficients, extension is
   * applied; otherwise a no-op (zero contribution).
   */
  enableFeatureExtension?: boolean;
}

const DEFAULT_LEARNED_SCORE_SCALE = 10;
const DEFAULT_PRIOR_SCORE_SCALE = 3;

export class EvaluatorPolicy extends BaselinePolicy {
  private readonly featureExtractor = new FeatureExtractor();
  private readonly calibrator: LogisticCalibrator;
  private readonly learnedScoreScale: number;
  private readonly priorMode: PolicyPriorMode;
  private readonly priorScoreScale: number;
  private readonly priorContext?: PolicyDeckPriorContext;
  private readonly fingerprintLake: FingerprintLake | null;
  private readonly featureExtensionEnabled: boolean;

  constructor(
    weights: CalibratedWeights,
    options: EvaluatorPolicyOptions = {},
  ) {
    super(options);
    this.calibrator = LogisticCalibrator.fromJSON(weights);
    this.learnedScoreScale = options.learnedScoreScale ?? DEFAULT_LEARNED_SCORE_SCALE;
    this.priorMode = options.priorMode ?? "none";
    this.priorScoreScale = options.priorScoreScale ?? DEFAULT_PRIOR_SCORE_SCALE;
    this.priorContext = options.priorContext;
    this.fingerprintLake = options.fingerprintLake ?? null;
    // Auto-detect: enable extension only when weights contain extension coefs
    // OR explicitly forced via options.
    this.featureExtensionEnabled =
      options.enableFeatureExtension ?? this.calibrator.hasExtensionCoefficients();
  }

  override choose(digest: PolicyTurnDigest, context?: PolicyDecisionContext): PolicyDecision {
    const profile = this.resolveProfile(context?.macroPlanState?.plan ?? null, context?.observation ?? null);

    // Generate turn plan and dice reservation at round start (same as baseline)
    let turnPlan = context?.turnPlan ?? null;
    let diceReservation = context?.diceReservation ?? null;
    if (context?.observation && context.observation.point.action_count_in_round === 0) {
      const reactionChainMatches = matchReactionChainTemplates(context.observation);
      turnPlan = generateTurnPlan(context.observation, context.macroPlanState?.plan ?? null, reactionChainMatches);
      diceReservation = computeDiceReservation(context.observation, turnPlan);
    }

    const updatedContext: PolicyDecisionContext | undefined = context
      ? { ...context, turnPlan, diceReservation }
      : undefined;

    // Apply ban list (SPL filtering)
    const banList = updatedContext?.actionBanList;
    const preFiltered = updatedContext?.splPreFiltered;

    const ranked = digest.candidate_actions
      .filter((candidate) => candidate.is_valid !== false)
      .filter((candidate) => {
        if (preFiltered) return true
        if (!banList || banList.length === 0) return true
        return !matchAnyPattern(banList, candidate)
      })
      .map((candidate) => {
        const scored = this.rankWithEvaluator(digest, candidate, updatedContext, profile);
        // UCB exploration bonus (same as baseline)
        if (this.options.explorationStrategy === "ucb" && this.totalActionCount > 0) {
          const bucket = candidate.action_case ?? "unknown"
          const visitCount = this.actionVisitCounts.get(bucket) ?? 0
          const ucbBonus = this.options.ucbC * Math.sqrt(
            Math.log(this.totalActionCount + 1) / (visitCount + 1),
          )
          return { ...scored, finalScore: scored.finalScore + ucbBonus }
        }
        return scored
      })
      .sort((a, b) => b.finalScore - a.finalScore);

    const selected = this.selectAction(ranked);

    // Update UCB visit counts
    if (selected) {
      this.totalActionCount++
      const bucket = selected.actionCase ?? "unknown"
      this.actionVisitCounts.set(bucket, (this.actionVisitCounts.get(bucket) ?? 0) + 1)
    }

    return {
      selectedCandidateId: selected?.candidateId ?? null,
      ranked,
    };
  }

  private rankWithEvaluator(
    digest: PolicyTurnDigest,
    candidate: PolicyCandidateAction,
    updatedContext?: PolicyDecisionContext,
    profile?: HeuristicProfile,
  ): RankedPolicyCandidate {
    const baseline = this.rankCandidate(digest, candidate, profile, updatedContext);
    const features = this.featureExtractor.extract(digest, candidate);
    const useThompson = this.options.explorationStrategy === "thompson";

    // V30 Stage 2.B — Build extension array if enabled. Extension is the
    // concatenation of PreviewMutationVector and Fingerprint flat features
    // for this candidate. The calibrator silently ignores it when weights
    // lack extension coefficients (backward-compat).
    let extensionArr: number[] | null = null;
    if (this.featureExtensionEnabled) {
      extensionArr = this.buildExtensionArray(digest, candidate);
    }

    const learnedScore = useThompson
      ? this.calibrator.predictThompsonWithExtension(features, extensionArr)
      : this.calibrator.predictWithExtension(features, extensionArr);
    const learnedContribution = learnedScore * this.learnedScoreScale;

    // V26 P0-1: Action-conditional deck prior (per-candidate, not side-level constant)
    const priorContribution = this.computeActionPrior(candidate, digest.round);

    return {
      ...baseline,
      learnedScore,
      finalScore: baseline.heuristicScore + learnedContribution + priorContribution,
      reasons: [
        ...baseline.reasons,
        `learned=+${learnedContribution.toFixed(2)}(${learnedScore.toFixed(3)})${useThompson ? " [thompson]" : ""}${extensionArr ? " [+ext]" : ""}`,
        ...(priorContribution !== 0
          ? [`prior=+${priorContribution.toFixed(2)}`]
          : []),
      ],
    };
  }

  /**
   * V30 Stage 2.B — Build the FeatureExtension array for one candidate.
   *
   * Pulls `preview_data` (PreviewData[] from the engine ActionPreviewer) and
   * `skill_definition_id` / `card_definition_id` from the candidate, then
   * delegates to FeatureExtension.extract. Returns a flat number array
   * suitable for `predictWithExtension`.
   */
  private buildExtensionArray(
    digest: PolicyTurnDigest,
    candidate: PolicyCandidateAction,
  ): number[] {
    const previewData = candidate.preview_data as readonly PreviewData[] | null | undefined;
    let previewVector: PreviewMutationVector | null = null;
    if (previewData && previewData.length > 0) {
      // Build self/opponent ID sets from the digest summaries. These are
      // already enumerated as part of digest construction; here we pull what
      // we need without re-querying the engine state.
      const selfIds = collectIds(digest.self_summary);
      const oppIds = collectIds(digest.opponent_summary);
      previewVector = extractPreviewVector(previewData, {
        perspective: 0, // perspective is encoded by `selfIds` content, not the literal
        selfIds,
        opponentIds: oppIds,
      });
    }

    // Pick the primary action target id for fingerprint lookup. For useSkill
    // we use skill_definition_id (e.g. 11014 = Ganyu burst); for playCard we
    // use card_definition_id; for switchActive / declareEnd / tuning we leave
    // it null so fingerprint dims are zeroed.
    const skillId = candidate.skill_definition_id;
    const cardId = candidate.card_definition_id;
    const primaryDefinitionId =
      typeof skillId === "number"
        ? skillId
        : typeof cardId === "number"
          ? cardId
          : null;

    const input: FeatureExtensionInput = {
      previewVector,
      primaryDefinitionId,
      lake: this.fingerprintLake,
    };
    const ext = FeatureExtension.extract(input);
    return FeatureExtension.toArray(ext);
  }

  private computeActionPrior(
    candidate: PolicyCandidateAction,
    round: number,
  ): number {
    if (this.priorMode === "none" || !this.priorContext) {
      return 0;
    }
    const result = scoreDeckActionPrior(
      this.priorContext.priorFeatures,
      candidate,
      round,
    );
    return result.score * this.priorScoreScale;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all entity IDs from a side summary (characters + supports + summons
 * + statuses) into a Set, for PreviewMutationVector damage-target attribution.
 *
 * The summary structure is loosely typed (Record<string, unknown>) because it
 * comes from the wire-level digest. We probe a few well-known shapes and
 * gracefully fall back to an empty set when the structure is unfamiliar.
 */
function collectIds(summary: Record<string, unknown>): Set<number> {
  const ids = new Set<number>();
  collectIdsInto(ids, (summary as Record<string, unknown>).characters);
  collectIdsInto(ids, (summary as Record<string, unknown>).supports);
  collectIdsInto(ids, (summary as Record<string, unknown>).summons);
  collectIdsInto(ids, (summary as Record<string, unknown>).statuses);
  collectIdsInto(ids, (summary as Record<string, unknown>).combat_statuses);
  return ids;
}

function collectIdsInto(target: Set<number>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (item == null) continue;
    if (typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const id = rec.id ?? rec.character_id ?? rec.entity_id;
      if (typeof id === "number") target.add(id);
    }
  }
}
