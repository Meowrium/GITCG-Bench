// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * EnergyTrackerPlugin — tracks character energy across actions.
 *
 * Rules (game engine, not in data files):
 *   1. Normal attack: +1 energy (unless already at max)
 *   2. Elemental skill: +1 energy (unless .noEnergy() is specified — not detectable statically)
 *   3. Burst: consumes costEnergy(N) energy, then +0 (burst itself doesn't gain energy)
 *   4. Passive/technique skills: no energy change
 *   5. Cards like Starsigns (332008): +1 energy (handled when card effects are implemented)
 */

import type {
  TurnState,
  ParsedAction,
  ValidationResult,
  TurnStateDelta,
  TurnMetrics,
} from "../core/types.js";
import type { DeckAnalysisPlugin } from "./plugin-interface.js";

export class EnergyTrackerPlugin implements DeckAnalysisPlugin {
  readonly name = "EnergyTracker";

  validate(_action: ParsedAction, state: TurnState): ValidationResult {
    // Energy validation is done in DiceEconomyPlugin (cost.energy check)
    // This plugin only tracks energy changes
    return { valid: true };
  }

  apply(action: ParsedAction, state: TurnState): TurnStateDelta {
    let energyGained = 0;
    let energySpent = 0;

    switch (action.type) {
      case "useSkill": {
        // Energy spent is already tracked by DiceEconomyPlugin
        energySpent = action.cost.energy;

        // Energy gained depends on skill type
        // Heuristic: any non-burst skill with non-zero total dice cost gains 1 energy
        // This handles normal attacks (1+2), E skills (3+0), and triggered skills
        const totalNonEnergyCost = 
          action.cost.colored.reduce((s, c) => s + c.count, 0) + 
          action.cost.void + action.cost.same;
        
        if (action.cost.energy > 0) {
          // Burst: consumes energy, gains 0
        } else if (totalNonEnergyCost > 0 || action.cost.energy === 0) {
          // Normal/E skill: gains 1 energy (engine rule)
          // Also triggered skills (cost=0 but still useSkill type)
          energyGained = 1;
        }
        break;
      }
      case "playCard":
        // Some cards grant energy (e.g. Starsigns) — not yet implemented
        break;
      case "switchActive":
      case "declareEnd":
      case "elementalTuning":
        // No energy change
        break;
    }

    // Apply energy changes (capped at max)
    const maxE = state.activeChar.maxEnergy;
    state.activeChar.energy = Math.max(0, Math.min(maxE, state.activeChar.energy + energyGained - energySpent));

    return {
      diceSpent: { cryo: 0, hydro: 0, pyro: 0, electro: 0, anemo: 0, geo: 0, dendro: 0, omni: 0 },
      energyGained,
      energySpent,
      damageDealt: [],
      selfDamage: 0,
      newAuras: [],
      summonCreated: false,
    };
  }

  observeTurn(_state: TurnState, actions: ParsedAction[]): TurnMetrics {
    let totalEnergyGained = 0;
    for (const a of actions) {
      if (a.type === "useSkill" && a.cost.energy === 0) {
        totalEnergyGained += 1; // approximation: non-burst skills gain 1
      }
    }
    return {
      totalDiceSpent: 0,
      totalDamageDealt: 0,
      totalEnergyGained,
      actionCount: actions.length,
    };
  }
}

/**
 * Compute how many rounds it takes for a character to reach burst energy.
 * Assume 1 normal attack per round (generous estimate).
 */
export function roundsToBurst(maxEnergy: number): number {
  // Burst costs maxEnergy. Each normal/E gives 1 energy.
  // Ideal: 1 attack per round → maxEnergy rounds
  return maxEnergy;
}
