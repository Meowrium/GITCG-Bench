// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * DamageCalculatorPlugin — computes damage for skill actions with reactions and equipment.
 *
 * Damage formula:
 *   total = baseDamage + equipmentBonus + statusBonus + reactionBonus + conditionalBonus
 *
 * Conditional bonuses (like 完场喝彩's "+2 vs Pyro aura, once per round") are modeled as
 * active effects on the character state. Plugins mutating state can add/remove these.
 *
 * Aura tracking: after a skill deals elemental damage, the target's aura is updated
 * according to the reaction table.
 */

import type {
  TurnState,
  ParsedAction,
  ValidationResult,
  TurnStateDelta,
  TurnMetrics,
  SkillCost,
  ElementType,
} from "../core/types.js";
import { damageTypeToElement } from "../core/types.js";
import type { DeckAnalysisPlugin } from "./plugin-interface.js";
import type { SkillData, CharacterData } from "../core/types.js";
import { computeReaction } from "../data/reaction-table.js";
import type { Aura } from "../data/reaction-table.js";

// ── Bonus Sources ─────────────────────────────────────────────

/** Equipment/talent cards that provide flat damage bonuses */
export interface DamageBonus {
  source: string;           // "王下近侍", "完场喝彩", etc.
  amount: number;           // flat damage added
  condition?: string;       // "target.aura === pyro", etc.
  usagePerRound?: number;   // max uses per round
  usedThisRound?: number;   // tracker
}

// ── Plugin ────────────────────────────────────────────────────

export class DamageCalculatorPlugin implements DeckAnalysisPlugin {
  readonly name = "DamageCalculator";

  /** Active damage bonuses (set externally by TurnSimulator or other plugins) */
  bonuses: DamageBonus[] = [];

  /** Character skill data lookup (set externally) */
  private skillMap: Map<number, SkillData> = new Map();

  /** Character data lookup */
  private charMap: Map<number, CharacterData> = new Map();

  constructor(characters?: CharacterData[]) {
    if (characters) {
      for (const c of characters) {
        this.charMap.set(c.definitionId, c);
        for (const s of c.skills) {
          this.skillMap.set(s.definitionId, s);
        }
      }
    }
  }

  /** Register a damage bonus (e.g., from equipment) */
  addBonus(bonus: DamageBonus): void {
    bonus.usedThisRound = 0;
    this.bonuses.push(bonus);
  }

  /** Reset per-round usage counters */
  resetRound(): void {
    for (const b of this.bonuses) {
      b.usedThisRound = 0;
    }
  }

  validate(_action: ParsedAction, _state: TurnState): ValidationResult {
    return { valid: true };
  }

  apply(action: ParsedAction, state: TurnState): TurnStateDelta {
    const delta: TurnStateDelta = {
      diceSpent: { cryo: 0, hydro: 0, pyro: 0, electro: 0, anemo: 0, geo: 0, dendro: 0, omni: 0 },
      energyGained: 0,
      energySpent: 0,
      damageDealt: [],
      selfDamage: 0,
      newAuras: [],
      summonCreated: false,
    };

    if (action.type !== "useSkill" || !action.skillId) return delta;

    const skill = this.skillMap.get(action.skillId);
    if (!skill) return delta;

    // For each damage entry in the skill
    for (const dmg of skill.damage) {
      const element = damageTypeToElement(dmg.type);
      const baseAmount = dmg.amount;

      // Self-damage (piercing to self)
      if (dmg.type === "Piercing" && element === "piercing") {
        delta.selfDamage += baseAmount;
        continue;
      }

      // Pick primary target (active opponent, index 0)
      const target = state.opponents[0];
      if (!target || !target.alive) continue;

      // ── Reaction ──
      const targetAura: Aura = target.aura ?? "none";
      const reactionResult = computeReaction(targetAura, element as ElementType);

      // ── Equipment/Status Bonuses ──
      let equipBonus = 0;
      for (const b of this.bonuses) {
        // Check usage limit
        if (b.usagePerRound && (b.usedThisRound ?? 0) >= b.usagePerRound) continue;

        // Check condition (simple string matching for now)
        let conditionMet = true;
        if (b.condition) {
          if (b.condition === "target.aura === pyro") {
            conditionMet = targetAura === "pyro";
          }
          // More conditions can be added
        }

        if (conditionMet) {
          equipBonus += b.amount;
          b.usedThisRound = (b.usedThisRound ?? 0) + 1;
        }
      }

      const totalDamage = baseAmount + reactionResult.damageBonus + equipBonus;

      // Apply damage
      target.hp -= totalDamage;
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
      }

      // Update aura (unless aura is preserved, e.g. Electro-Charged)
      if (!reactionResult.auraPreserved) {
        target.aura = reactionResult.newAura === "none" ? null : (reactionResult.newAura as ElementType);
      }

      delta.damageDealt.push({
        targetIndex: 0,
        amount: totalDamage,
        type: `${dmg.type}${reactionResult.reaction ? `+${reactionResult.reaction}` : ""}`,
      });
      delta.newAuras.push({ targetIndex: 0, aura: target.aura });
    }

    return delta;
  }

  observeTurn(_state: TurnState, actions: ParsedAction[]): TurnMetrics {
    let totalDamage = 0;
    for (const a of actions) {
      // Damage is computed during apply, not re-computed here
    }
    return {
      totalDiceSpent: 0,
      totalDamageDealt: totalDamage,
      totalEnergyGained: 0,
      actionCount: actions.length,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Compute max single-target damage for a skill, assuming ideal conditions
 * (target has optimal aura for max reaction, all bonuses active).
 */
export function maxSkillDamage(skill: SkillData, charElement: ElementType): number {
  let total = 0;
  for (const dmg of skill.damage) {
    const element = damageTypeToElement(dmg.type);
    if (element === "physical" || element === "piercing") {
      total += dmg.amount;
      continue;
    }
    // Max reaction: Melt or Vaporize (+2) if possible, else best available
    // For simplicity, assume +2 if Pyro/Hydro/Cryo (can Melt/Vape), else +1
    const maxReactionBonus =
      (element === "pyro" || element === "hydro" || element === "cryo") ? 2 : 1;
    total += dmg.amount + maxReactionBonus;
  }
  return total;
}
