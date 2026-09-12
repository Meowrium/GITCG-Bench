// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * OpeningAnalyzerPlugin — evaluates which character should start (be the active opener).
 *
 * Strategy: For each character, simulate R1 with ideal dice (8 of the character's element).
 * Compute damage dealt, energy gained, and cards that can be played.
 * Rank characters by a composite score.
 */

import type {
  CharacterData, SkillData, DicePool, TurnState, DeckModel,
  ParsedAction, SkillCost, ElementType,
} from "../core/types.js";
import { emptyDicePool, ALL_ELEMENTS } from "../core/types.js";
import type { DeckAnalysisPlugin } from "./plugin-interface.js";

// ── Types ────────────────────────────────────────────────────

export interface OpeningAnalysis {
  characterId: number;
  characterName: string;
  element: ElementType;
  /** Total damage dealt to opponent in R1 (with ideal dice) */
  r1Damage: number;
  /** Energy gained by this character in R1 */
  energyGained: number;
  /** Skills usable in R1 with 8 matching dice */
  skillsUsed: { id: number; name: string; type: string; damage: number }[];
  /** Cards playable alongside skills in R1 */
  cardsPlayable: number;
  /** Composite score (higher = better opener) */
  score: number;
  /** Reason for the score */
  reason: string;
}

// ── Helpers ──────────────────────────────────────────────────

function diceForElement(el: ElementType, count: number): DicePool {
  const pool = emptyDicePool();
  pool[el] = count;
  return pool;
}

function totalCostDice(cost: SkillCost): number {
  let sum = cost.void + cost.same;
  for (const c of cost.colored) sum += c.count;
  return sum;
}

// ── Plugin ───────────────────────────────────────────────────

export class OpeningAnalyzerPlugin implements DeckAnalysisPlugin {
  readonly name = "OpeningAnalyzer";
  private model: DeckModel;

  constructor(model: DeckModel) {
    this.model = model;
  }

  validate(): { valid: boolean; reason?: string } {
    return { valid: true }; // always valid (analysis-only plugin)
  }

  apply(): import("../core/types.js").TurnStateDelta {
    return { diceSpent: emptyDicePool(), energyGained: 0, energySpent: 0, damageDealt: [], selfDamage: 0, newAuras: [], summonCreated: false };
  }

  observeTurn(): import("../core/types.js").TurnMetrics {
    return { totalDiceSpent: 0, totalDamageDealt: 0, totalEnergyGained: 0, actionCount: 0 };
  }

  /**
   * Analyze all characters as potential openers and return ranked results.
   */
  analyze(): OpeningAnalysis[] {
    const results: OpeningAnalysis[] = [];

    for (const char of this.model.characters) {
      const analysis = this.analyzeCharacter(char);
      results.push(analysis);
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Analyze a single character as R1 opener.
   */
  private analyzeCharacter(char: CharacterData): OpeningAnalysis {
    // Get non-passive skills
    const activeSkills = char.skills.filter((s) => s.type !== "passive" && s.type !== "technique");

    // Simulate with 8 dice of this character's element
    const dice = diceForElement(char.element, 8);
    let remainingDice = 8;
    const skillsUsed: OpeningAnalysis["skillsUsed"] = [];
    let totalDamage = 0;
    let energyGained = 0;

    // Greedy: use skills in order of damage efficiency (damage per die)
    const sorted = [...activeSkills].sort((a, b) => {
      const aDmg = a.damage.reduce((s, d) => s + d.amount, 0);
      const bDmg = b.damage.reduce((s, d) => s + d.amount, 0);
      const aCost = totalCostDice(a.cost);
      const bCost = totalCostDice(b.cost);
      if (aCost === 0) return 1;
      if (bCost === 0) return -1;
      return (bDmg / bCost) - (aDmg / aCost);
    });

    for (const skill of sorted) {
      const diceCost = totalCostDice(skill.cost);

      // Skip bursts (require energy we don't have in R1)
      if (skill.cost.energy > 0) continue;

      // Can we afford this skill?
      if (diceCost > remainingDice) continue;

      // Check colored costs against our dice pool (all same element)
      let canAfford = true;
      for (const cc of skill.cost.colored) {
        if (cc.element !== char.element) {
          // Need a different element — skip (ideal dice only gives one element)
          // In practice, you'd have omni or mixed dice. For now, be conservative.
          // Only skip if the cost requires a completely different element
          if (diceCost > remainingDice) {
            canAfford = false;
            break;
          }
        }
      }
      if (!canAfford) continue;

      // Use this skill
      remainingDice -= diceCost;

      const skillDmg = skill.damage.reduce((s, d) => s + d.amount, 0);
      totalDamage += skillDmg;

      // Energy: +1 for normal/E skills
      if (skill.type === "normal" || skill.type === "elemental") {
        energyGained += 1;
      }

      skillsUsed.push({
        id: skill.definitionId,
        name: skill.name,
        type: skill.type,
        damage: skillDmg,
      });
    }

    // Score: damage * 2 + energy * 1 — simple heuristic
    const score = totalDamage * 2 + energyGained * 1;

    return {
      characterId: char.definitionId,
      characterName: char.name,
      element: char.element,
      r1Damage: totalDamage,
      energyGained,
      skillsUsed,
      cardsPlayable: 0, // TODO: card analysis
      score,
      reason: this.buildReason(skillsUsed, totalDamage, energyGained),
    };
  }

  private buildReason(
    skills: OpeningAnalysis["skillsUsed"],
    damage: number,
    energy: number,
  ): string {
    if (skills.length === 0) return "No usable skills in R1 (no matching dice?)";
    const skillNames = skills.map((s) => s.name).join("→");
    return `${skillNames}: ${damage} dmg, +${energy} energy`;
  }
}

/**
 * Quick function: analyze opening choices for a deck.
 */
export function analyzeOpenings(model: DeckModel): OpeningAnalysis[] {
  const plugin = new OpeningAnalyzerPlugin(model);
  return plugin.analyze();
}
