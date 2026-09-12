/**
 * RiskEvaluator — multi-dimensional risk assessment for candidates.
 *
 * Replaces the inline riskPenalty calculation in FragmentResolver with a
 * richer model evaluating four risk dimensions:
 *
 *   1. character_survival — self active character HP exposure
 *   2. opponent_burst     — opponent energy/burst readiness
 *   3. board_control      — board state disadvantage indicators
 *   4. cost_efficiency    — high cost relative to low expected gain
 *
 * Each dimension produces a non-negative penalty; their sum is the total
 * riskPenalty fed into the resolver's score formula.
 */

import { safeNumber, containsLabel } from "./scoring-utils";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CharacterSummary {
  id: number;
  hp: number;
  max_hp: number;
  energy: number;
  max_energy: number;
  alive: boolean;
}

export interface RiskContext {
  selfSummary: {
    active_character_id: unknown;
    characters?: CharacterSummary[];
  };
  opponentSummary: {
    active_character_id: unknown;
    characters?: CharacterSummary[];
  };
  resourceSummary: {
    dice_count?: number;
    omni_count?: number;
  };
  round: number;
}

export interface RiskBreakdown {
  characterSurvival: number;
  opponentBurst: number;
  boardControl: number;
  costEfficiency: number;
  total: number;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

export class RiskEvaluator {
  /**
   * Compute the multi-dimensional risk penalty for a single candidate.
   *
   * @param candidate  - The candidate_action record from the digest
   * @param ctx        - Digest summary context
   * @param localGain  - Already-computed localGain for cost-efficiency check
   * @returns RiskBreakdown with per-dimension scores and total
   */
  evaluate(
    candidate: Record<string, unknown>,
    ctx: RiskContext,
    localGain: number,
  ): RiskBreakdown {
    const characterSurvival = this.evaluateCharacterSurvival(candidate, ctx);
    const opponentBurst = this.evaluateOpponentBurst(candidate, ctx);
    const boardControl = this.evaluateBoardControl(candidate, ctx);
    const costEfficiency = this.evaluateCostEfficiency(candidate, localGain);
    const total = characterSurvival + opponentBurst + boardControl + costEfficiency;

    return { characterSurvival, opponentBurst, boardControl, costEfficiency, total };
  }

  // ── Dimension 1: Character Survival ─────────────────────────────────────

  private evaluateCharacterSurvival(
    candidate: Record<string, unknown>,
    ctx: RiskContext,
  ): number {
    let penalty = 0;

    // Base survival_risk from CandidateEnricher (HP-based)
    penalty += Math.max(0, safeNumber(candidate.survival_risk));

    // Active character low-HP amplifier
    const selfChars = ctx.selfSummary.characters ?? [];
    const activeId = ctx.selfSummary.active_character_id;
    const activeChar = selfChars.find((ch) => ch.id === activeId);
    if (activeChar && activeChar.max_hp > 0) {
      const hpRatio = activeChar.hp / activeChar.max_hp;
      // If active character is at critical HP and we're *not* switching
      // away, add risk for staying exposed
      const actionCase = String(candidate.action_case ?? "");
      if (hpRatio <= 0.2 && actionCase !== "switchActive") {
        penalty += 2;
      }
    }

    // Team health: if multiple characters are low, increased overall risk
    const aliveChars = selfChars.filter((ch) => ch.alive);
    const criticalCount = aliveChars.filter(
      (ch) => ch.max_hp > 0 && ch.hp / ch.max_hp <= 0.3,
    ).length;
    if (criticalCount >= 2) {
      penalty += 1;
    }

    // Tag-based risk
    const searchable = this.buildSearchable(candidate);
    if (containsLabel(searchable, ["expose_core", "break_combo", "hp_risk"])) {
      penalty += 3;
    }

    return penalty;
  }

  // ── Dimension 2: Opponent Burst Threat ──────────────────────────────────

  private evaluateOpponentBurst(
    candidate: Record<string, unknown>,
    ctx: RiskContext,
  ): number {
    let penalty = 0;

    const opponentChars = ctx.opponentSummary.characters ?? [];
    const opponentActiveId = ctx.opponentSummary.active_character_id;
    const opponentActive = opponentChars.find((ch) => ch.id === opponentActiveId);

    // Opponent active character is burst-ready (energy full)
    if (
      opponentActive &&
      opponentActive.max_energy > 0 &&
      opponentActive.energy >= opponentActive.max_energy
    ) {
      penalty += 2;

      // If we're declaring end when opponent has burst ready, extra risk
      const actionCase = String(candidate.action_case ?? "");
      if (actionCase === "declareEnd") {
        penalty += 1;
      }
    }

    // Opponent has multiple characters near burst
    const nearBurstCount = opponentChars.filter(
      (ch) =>
        ch.alive &&
        ch.max_energy > 0 &&
        ch.max_energy - ch.energy <= 1,
    ).length;
    if (nearBurstCount >= 2) {
      penalty += 1;
    }

    return penalty;
  }

  // ── Dimension 3: Board Control ──────────────────────────────────────────

  private evaluateBoardControl(
    candidate: Record<string, unknown>,
    ctx: RiskContext,
  ): number {
    let penalty = 0;

    // Check opponent alive character count vs self
    const selfAlive = (ctx.selfSummary.characters ?? []).filter((ch) => ch.alive).length;
    const opponentAlive = (ctx.opponentSummary.characters ?? []).filter((ch) => ch.alive).length;

    // Character disadvantage
    if (opponentAlive > selfAlive) {
      penalty += 1;
    }

    // Late-game risk amplifier: in later rounds, risks compound
    if (ctx.round >= 5 && selfAlive <= 1) {
      penalty += 1;
    }

    // Dice resource scarcity: acting with very few dice left
    const diceCount = safeNumber(ctx.resourceSummary.dice_count);
    if (diceCount <= 2 && diceCount > 0) {
      const actionCase = String(candidate.action_case ?? "");
      // Using a costly action when nearly out of dice
      if (actionCase === "useSkill" || actionCase === "playCard") {
        penalty += 1;
      }
    }

    return penalty;
  }

  // ── Dimension 4: Cost Efficiency ────────────────────────────────────────

  private evaluateCostEfficiency(
    candidate: Record<string, unknown>,
    localGain: number,
  ): number {
    let penalty = 0;

    const requiredCost = (candidate.cost as any)?.required_cost;
    const totalCost = Array.isArray(requiredCost)
      ? requiredCost.reduce(
          (sum: number, entry: unknown) =>
            sum + (typeof (entry as any)?.count === "number" ? (entry as any).count : 1),
          0,
        )
      : 0;

    // High cost, low gain
    if (totalCost >= 3 && localGain <= 1) {
      penalty += 3;
    } else if (totalCost >= 4 && localGain <= 3) {
      penalty += 1;
    }

    return penalty;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

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
