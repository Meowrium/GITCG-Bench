/**
 * StrategyMatcher — Structured label matching with synonym soft-match support.
 *
 * Three-tier matching hierarchy:
 *   1. Exact match on standard labels     → full weight (×1.0)
 *   2. Synonym soft match via mapping table → weight ×0.8
 *   3. Substring fallback (existing logic)  → weight ×0.5
 *
 * This replaces the inline strategyMatch calculation in FragmentResolver,
 * improving stability when LLM outputs vary between Chinese/English and
 * free-text descriptions vs standard labels.
 */

import { normalizeLabel, containsLabel } from "./scoring-utils";
import { ALL_STANDARD_LABELS, SYNONYM_MAP } from "./label-taxonomy";

// ── Match result types ──────────────────────────────────────────────────────

export type MatchTier = "exact" | "synonym" | "substring" | "none";

export interface MatchResult {
  matched: boolean;
  tier: MatchTier;
  /** Weight multiplier: exact=1.0, synonym=0.8, substring=0.5, none=0 */
  weight: number;
  /** The resolved standard label (if matched) */
  resolvedLabel?: string;
}

export interface StrategyMatchBreakdown {
  intentScore: number;
  mustDoScore: number;
  avoidScore: number;
  preferenceScore: number;
  profileScore: number;
  total: number;
}

// ── Tier weights ────────────────────────────────────────────────────────────

const TIER_WEIGHTS: Record<MatchTier, number> = {
  exact: 1.0,
  synonym: 0.8,
  substring: 0.5,
  none: 0,
};

// ── StrategyMatcher ─────────────────────────────────────────────────────────

export class StrategyMatcher {
  /**
   * Try to resolve a free-text label to a standard label.
   * Returns the standard label if found, or the original text otherwise.
   */
  resolveLabel(text: string): string {
    const normalized = normalizeLabel(text);

    // Already a standard label
    if (ALL_STANDARD_LABELS.has(normalized)) {
      return normalized;
    }

    // Synonym lookup
    const mapped = SYNONYM_MAP.get(normalized);
    if (mapped) {
      return mapped;
    }

    return normalized;
  }

  /**
   * Tokenize a fragment term into individual matchable tokens.
   * Splits on common Chinese/English delimiters: punctuation, spaces, parentheses, quotes, etc.
   * Filters out very short fragments (length < 2) to avoid false positives.
   */
  private tokenize(text: string): string[] {
    return text
      .split(/[，。、；：！？\s,;:!?()（）""''「」【】\[\]/\\|·—_=]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
  }

  /**
   * Match a single fragment term (intent/must_do/avoid/preference) against
   * the candidate's searchable text. Returns the match tier and weight.
   *
   * If the whole-phrase match fails, the term is tokenized and each token
   * is independently resolved through SYNONYM_MAP. The best-tier token
   * match wins.
   *
   * As a final fallback, if the fragment term contains an action_case keyword
   * (e.g. "useSkill", "playCard") that appears in the candidate's searchable
   * text, it counts as a synonym-tier match.
   */
  matchTerm(fragmentTerm: string, candidateSearchable: string): MatchResult {
    const normalizedTerm = normalizeLabel(fragmentTerm);
    if (normalizedTerm.length === 0) {
      return { matched: false, tier: "none", weight: 0 };
    }
    const normalizedCandidate = normalizeLabel(candidateSearchable);

    // Tier 1: Resolve the whole fragment term and check if the resolved standard label
    // appears as a whole word/label in the candidate tags
    const resolvedTerm = this.resolveLabel(fragmentTerm);

    if (normalizedCandidate.includes(resolvedTerm)) {
      let tier: MatchTier;
      if (ALL_STANDARD_LABELS.has(normalizedTerm)) {
        tier = "exact";
      } else if (resolvedTerm !== normalizedTerm) {
        tier = "synonym";
      } else {
        tier = "substring";
      }
      return {
        matched: true,
        tier,
        weight: TIER_WEIGHTS[tier],
        resolvedLabel: resolvedTerm,
      };
    }

    // Tier 2: Substring fallback for the whole term
    if (normalizedCandidate.includes(normalizedTerm)) {
      return {
        matched: true,
        tier: "substring",
        weight: TIER_WEIGHTS.substring,
        resolvedLabel: normalizedTerm,
      };
    }

    // Tier 3: Tokenized matching — split the long phrase into individual
    // tokens and try each one through the synonym resolution pipeline.
    // This is the key fix for Chinese long-sentence intents like
    // "选择战技动作（useSkill，skill_def_id=14082）" → tokens include "战技", "useSkill", etc.
    const tokens = this.tokenize(fragmentTerm);
    let bestResult: MatchResult = { matched: false, tier: "none", weight: 0 };

    for (const token of tokens) {
      const resolvedToken = this.resolveLabel(token);
      const normalizedToken = normalizeLabel(token);

      if (normalizedCandidate.includes(resolvedToken)) {
        let tier: MatchTier;
        if (ALL_STANDARD_LABELS.has(normalizedToken)) {
          tier = "exact";
        } else if (resolvedToken !== normalizedToken) {
          tier = "synonym";
        } else {
          tier = "substring";
        }
        const weight = TIER_WEIGHTS[tier];
        if (weight > bestResult.weight) {
          bestResult = { matched: true, tier, weight, resolvedLabel: resolvedToken };
        }
        // Early exit on exact match — can't do better
        if (tier === "exact") break;
      } else if (normalizedCandidate.includes(normalizedToken) && TIER_WEIGHTS.substring > bestResult.weight) {
        bestResult = {
          matched: true,
          tier: "substring",
          weight: TIER_WEIGHTS.substring,
          resolvedLabel: normalizedToken,
        };
      }
    }

    // Tier 4: action_case direct matching — if the fragment contains a
    // known action_case identifier (useSkill, playCard, switchActive, etc.)
    // and the candidate's searchable text starts with the same action_case,
    // treat it as a synonym-level match. This handles cases where the LLM
    // writes "use useSkill" or "选择战技动作(useSkill)" and the candidate
    // searchable begins with "useSkill ...".
    if (!bestResult.matched) {
      const actionCaseKeywords = [
        "useskill", "playcard", "switchactive", "chooseactive",
        "declareend", "elementaltuning", "rerolldice", "switchhands",
      ];
      for (const kw of actionCaseKeywords) {
        if (normalizedTerm.includes(kw) && normalizedCandidate.includes(kw)) {
          bestResult = {
            matched: true,
            tier: "synonym",
            weight: TIER_WEIGHTS.synonym,
            resolvedLabel: kw,
          };
          break;
        }
      }
    }

    return bestResult;
  }

  /**
   * Compute the full strategyMatch score for a candidate against a fragment.
   * Drop-in replacement for the inline strategyMatch calculation in FragmentResolver.
   */
  computeStrategyMatch(
    candidateSearchable: string,
    fragment: {
      intent: string;
      must_do: string[];
      avoid: string[];
      preference_order: string[];
    },
    profileKeywords: string[],
  ): StrategyMatchBreakdown {
    // ── Intent match (base weight: 8) ────────────────────────
    let intentScore = 0;
    const intentMatch = this.matchTerm(fragment.intent, candidateSearchable);
    if (intentMatch.matched) {
      intentScore = 8 * intentMatch.weight;
    }

    // ── Must-do match (base weight: 6 each) ──────────────────
    let mustDoScore = 0;
    for (const mustDo of fragment.must_do) {
      const match = this.matchTerm(mustDo, candidateSearchable);
      if (match.matched) {
        mustDoScore += 6 * match.weight;
      }
    }

    // ── Avoid penalty (base weight: 8 each) ──────────────────
    let avoidScore = 0;
    for (const avoid of fragment.avoid) {
      const match = this.matchTerm(avoid, candidateSearchable);
      if (match.matched) {
        avoidScore += 8 * match.weight;
      }
    }

    // ── Preference order (base weight: 5..1 descending) ──────
    let preferenceScore = 0;
    for (let i = 0; i < fragment.preference_order.length; i++) {
      const match = this.matchTerm(
        fragment.preference_order[i],
        candidateSearchable,
      );
      if (match.matched) {
        const baseWeight = Math.max(1, 5 - i);
        preferenceScore += baseWeight * match.weight;
        break; // Only first matched preference counts
      }
    }

    // ── Profile keywords (base weight: 1) ────────────────────
    let profileScore = 0;
    if (containsLabel(candidateSearchable, profileKeywords)) {
      profileScore = 1;
    }

    const total =
      intentScore + mustDoScore - avoidScore + preferenceScore + profileScore;

    return {
      intentScore,
      mustDoScore,
      avoidScore,
      preferenceScore,
      profileScore,
      total,
    };
  }
}
