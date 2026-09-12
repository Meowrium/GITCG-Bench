/**
 * FuturePotentialEvaluator — 2-3 step lookahead scoring.
 *
 * Evaluates future value of a candidate action across four sub-dimensions:
 *
 *   1. energyPotential    — how much closer to burst this action gets us
 *   2. reactionChainPotential — element setup for future reactions
 *   3. tempoAdvantage     — fast actions, sustained effects
 *   4. positionalValue    — switching to good/bad positions
 */

import { safeNumber, containsLabel } from "./scoring-utils";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CharacterEnergyInfo {
  id: number;
  energy: number;
  maxEnergy: number;
  alive: boolean;
}

export interface FuturePotentialContext {
  selfCharacters: CharacterEnergyInfo[];
  activeCharacterId: unknown;
  /** Tags and notes from the candidate — used for element/reaction checks */
  candidateTags: string[];
  candidateNotes: string[];
}

export interface FuturePotentialBreakdown {
  energyPotential: number;
  reactionChainPotential: number;
  tempoAdvantage: number;
  positionalValue: number;
  total: number;
}

// ── Evaluator ────────────────────────────────────────────────────────────────

export class FuturePotentialEvaluator {
  evaluate(
    candidate: Record<string, unknown>,
    ctx: FuturePotentialContext,
  ): FuturePotentialBreakdown {
    const energyPotential = this.evaluateEnergyPotential(candidate, ctx);
    const reactionChainPotential = this.evaluateReactionChain(candidate, ctx);
    const tempoAdvantage = this.evaluateTempoAdvantage(candidate, ctx);
    const positionalValue = this.evaluatePositionalValue(candidate, ctx);
    const total = energyPotential + reactionChainPotential + tempoAdvantage + positionalValue;

    return { energyPotential, reactionChainPotential, tempoAdvantage, positionalValue, total };
  }

  // ── Dimension 1: Energy Potential ─────────────────────────────────────

  private evaluateEnergyPotential(
    candidate: Record<string, unknown>,
    ctx: FuturePotentialContext,
  ): number {
    const actionCase = String(candidate.action_case ?? "");
    const searchable = [...ctx.candidateTags, ...ctx.candidateNotes].join(" ");

    // Using burst (already full energy, spending it) → high value
    if (containsLabel(searchable, ["burst"])) {
      return 5;
    }

    // Find active character
    const activeChar = ctx.selfCharacters.find((ch) => ch.id === ctx.activeCharacterId);
    if (!activeChar || activeChar.maxEnergy <= 0) return 0;

    const energyGap = activeChar.maxEnergy - activeChar.energy;

    // Action generates energy (normal attack, skill)
    const generatesEnergy =
      actionCase === "useSkill" &&
      !containsLabel(searchable, ["burst"]) &&
      (containsLabel(searchable, ["normal_attack", "skill", "energy"]) || true);
    // Most useSkill actions generate 1 energy (normal attacks and elemental skills)

    if (generatesEnergy) {
      if (energyGap === 1) {
        return 4; // Next action can be burst!
      } else if (energyGap === 2) {
        return 2; // Getting close to burst
      } else if (energyGap >= 3) {
        return 1; // Still building up
      }
    }

    return 0;
  }

  // ── Dimension 2: Reaction Chain Potential ──────────────────────────────

  private evaluateReactionChain(
    candidate: Record<string, unknown>,
    ctx: FuturePotentialContext,
  ): number {
    const searchable = [...ctx.candidateTags, ...ctx.candidateNotes].join(" ");

    // If this action already triggers a reaction, future chain potential is lower
    // (the reaction already happened)
    if (safeNumber(candidate.reaction_value) > 0) {
      return 1; // Already reacting — some residual chain value
    }

    // Check if this action applies an element (has element tags but no reaction)
    const elementTags = ["cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro"];
    const appliesElement = elementTags.some((elem) => containsLabel(searchable, [elem]));

    if (appliesElement) {
      // Element application without immediate reaction → setup for future reaction
      return 2;
    }

    // Summon creation — evaluate with duration awareness
    if (containsLabel(searchable, ["summon"])) {
      return this.evaluateSummonValue(searchable);
    }

    // Status effects that persist
    if (containsLabel(searchable, ["status", "shield"])) {
      return 1;
    }

    return 0;
  }

  // ── Summon Value Sub-evaluator ────────────────────────────────────────

  /**
   * Estimate the future value of a summon based on its duration and per-round
   * damage/effect, extracted from candidate notes or tags.
   *
   * CandidateEnricher should inject "duration=N" and "dmg_per_round=N" into
   * notes for summon-creating actions. If not present, uses conservative
   * defaults (duration=2, dmg_per_round=1).
   */
  private evaluateSummonValue(searchable: string): number {
    const durationMatch = searchable.match(/duration[=:]\s*(\d+)/i);
    const duration = durationMatch ? parseInt(durationMatch[1], 10) : 2;

    const dmgMatch = searchable.match(/dmg_per_round[=:]\s*(\d+)/i);
    const dmgPerRound = dmgMatch ? parseInt(dmgMatch[1], 10) : 1;

    // Total future value = rounds × per-round effect × discount factor
    // Capped at 8 to avoid extreme outliers
    return Math.min(8, duration * dmgPerRound * 1.5);
  }

  // ── Dimension 3: Tempo Advantage ──────────────────────────────────────

  private evaluateTempoAdvantage(
    candidate: Record<string, unknown>,
    ctx: FuturePotentialContext,
  ): number {
    const searchable = [...ctx.candidateTags, ...ctx.candidateNotes].join(" ");

    let score = 0;

    // Fast actions preserve action initiative
    if (containsLabel(searchable, ["fast"])) {
      score += 2;
    }

    // Sustained effects (summons, statuses) provide value over multiple turns
    if (containsLabel(searchable, ["summon"])) {
      // Extract duration if available for more accurate tempo scoring
      const durationMatch = searchable.match(/duration[=:]\s*(\d+)/i);
      const duration = durationMatch ? parseInt(durationMatch[1], 10) : 2;
      score += Math.min(4, duration); // 1 point per round, capped at 4
    }

    // Ending turn gives up tempo
    const actionCase = String(candidate.action_case ?? "");
    if (actionCase === "declareEnd") {
      score -= 1;
    }

    // Elemental tuning: fast + converts dice → good tempo
    if (actionCase === "elementalTuning") {
      score += 1;
    }

    return score;
  }

  // ── Dimension 4: Positional Value ─────────────────────────────────────

  private evaluatePositionalValue(
    candidate: Record<string, unknown>,
    ctx: FuturePotentialContext,
  ): number {
    const actionCase = String(candidate.action_case ?? "");
    const searchable = [...ctx.candidateTags, ...ctx.candidateNotes].join(" ");

    if (actionCase !== "switchActive" && actionCase !== "chooseActive") {
      return 0;
    }

    let score = 0;

    // Switching to a character with burst ready → positional upgrade
    if (containsLabel(searchable, ["burst_ready"])) {
      score += 2;
    }

    // Switching to a low HP character → risky position
    if (containsLabel(searchable, ["switch_to_low_hp", "low_hp"])) {
      score -= 2;
    }

    // Switching to a character near burst → building up
    if (containsLabel(searchable, ["near_burst"])) {
      score += 1;
    }

    return score;
  }
}
