/**
 * ResourceWeightCalculator — dynamic resource valuation based on game state.
 *
 * Replaces the static policyMultiplier with context-sensitive weights that
 * account for dice scarcity, omni premium, hand card pressure, and game phase.
 */

import { safeNumber, containsLabel } from "./scoring-utils";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ResourceContext {
  diceCount: number;
  omniCount: number;
  cardsInHand: number;
  round: number;
  resourcePolicy: "strict" | "balanced" | "aggressive";
}

export interface ResourceWeights {
  diceWeight: number;
  omniPremium: number;
  cardWeight: number;
  phaseMultiplier: number;
  policyMultiplier: number;
}

export interface ResourcePenaltyBreakdown {
  baseCostPenalty: number;
  omniPressurePenalty: number;
  cardWastePenalty: number;
  total: number;
}

// ── Calculator ───────────────────────────────────────────────────────────────

export class ResourceWeightCalculator {
  /**
   * Compute dynamic resource weights from current game state.
   */
  computeWeights(ctx: ResourceContext): ResourceWeights {
    // Dice scarcity: fewer dice → higher cost weight
    const diceWeight = 1 + Math.max(0, (6 - ctx.diceCount) * 0.2);

    // Omni premium: scarce omni → higher value
    const omniPremium = ctx.omniCount <= 1 ? 2.0 : 1.0;

    // Hand card scarcity
    const cardWeight = ctx.cardsInHand <= 2 ? 1.5 : 1.0;

    // Game phase modifier
    let phaseMultiplier: number;
    if (ctx.round <= 2) {
      phaseMultiplier = 1.2; // Early: conserve resources
    } else if (ctx.round >= 6) {
      phaseMultiplier = 0.85; // Late: spend aggressively
    } else {
      phaseMultiplier = 1.0; // Mid: standard
    }

    // Policy modifier
    let policyMultiplier: number;
    if (ctx.resourcePolicy === "strict") {
      policyMultiplier = 1.6;
    } else if (ctx.resourcePolicy === "aggressive") {
      policyMultiplier = 0.8;
    } else {
      policyMultiplier = 1.2;
    }

    return { diceWeight, omniPremium, cardWeight, phaseMultiplier, policyMultiplier };
  }

  /**
   * Compute the full resource penalty for a candidate action.
   *
   * Uses an efficiency-ratio approach: high-gain actions are penalised less
   * for the same absolute cost, preventing core skills from being suppressed
   * by zero-cost filler cards.
   *
   * @param candidate   - candidate action record from the digest
   * @param ctx         - resource context (dice, omni, hand, round, policy)
   * @param localGain   - pre-computed localGain for the candidate (default 0)
   * @param futurePotential - pre-computed futurePotential for the candidate (default 0)
   */
  evaluate(
    candidate: Record<string, unknown>,
    ctx: ResourceContext,
    localGain: number = 0,
    futurePotential: number = 0,
  ): ResourcePenaltyBreakdown {
    const weights = this.computeWeights(ctx);
    const totalCost = this.extractTotalCost(candidate);
    const actionCase = String(candidate.action_case ?? "unknown");
    const searchable = this.buildSearchable(candidate);

    // Raw linear cost penalty
    const rawPenalty = totalCost * weights.policyMultiplier * weights.phaseMultiplier * weights.diceWeight;

    // Efficiency-ratio damping: if the action has high expected gain, the
    // resource penalty is reduced proportionally so that core skills are
    // not overwhelmed by zero-cost filler cards.
    const effectiveGain = Math.max(localGain + futurePotential, 0.1);
    const efficiencyRatio = rawPenalty / effectiveGain;
    const baseCostPenalty = efficiencyRatio > 2.0
      ? rawPenalty                                       // very poor efficiency → full penalty
      : rawPenalty * Math.min(1, efficiencyRatio / 2.0); // reasonable efficiency → damped

    // Omni pressure: scarce omni under strict policy with moderate cost.
    // Suppressed in early rounds (≤2) where omni=0 is the normal starting state.
    const omniPressurePenalty =
      ctx.resourcePolicy === "strict" &&
      ctx.omniCount <= 1 &&
      ctx.round > 2 &&
      totalCost >= 2
        ? 2 * weights.omniPremium
        : 0;

    // Card waste: playing an effectless card
    const cardWastePenalty =
      actionCase === "playCard" &&
      containsLabel(searchable, ["effectless", "no_effect"])
        ? 2 * weights.cardWeight
        : 0;

    const total = baseCostPenalty + omniPressurePenalty + cardWastePenalty;

    return { baseCostPenalty, omniPressurePenalty, cardWastePenalty, total };
  }

  private extractTotalCost(candidate: Record<string, unknown>): number {
    const requiredCost = (candidate.cost as any)?.required_cost;
    if (!Array.isArray(requiredCost)) return 0;
    return requiredCost.reduce(
      (sum: number, entry: unknown) =>
        sum + (typeof (entry as any)?.count === "number" ? (entry as any).count : 1),
      0,
    );
  }

  private buildSearchable(candidate: Record<string, unknown>): string {
    const actionCase = String(candidate.action_case ?? "unknown");
    const tags = Array.isArray(candidate.tags)
      ? (candidate.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const notes = Array.isArray(candidate.notes)
      ? (candidate.notes as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
    return [actionCase, ...tags, ...notes].join(" ");
  }
}
