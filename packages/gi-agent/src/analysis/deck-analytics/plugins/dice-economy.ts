// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * DiceEconomyPlugin — validates and executes dice payment for actions.
 *
 * Rules (from game engine, verified against packages/data/src/):
 *   1. Colored cost (costPyro(3)): must pay with matching dice OR omni
 *   2. Void cost (costVoid(2)): any element dice OR omni
 *   3. Same cost (costSame(3)): N dice all of the SAME element, omni OK
 *   4. Omni dice are precious — consume specific dice first, omni last
 *   5. Switch always costs 1 void die
 */

import type {
  DicePool,
  SkillCost,
  ElementType,
  ColoredCost,
  TurnState,
  ParsedAction,
  ValidationResult,
  TurnStateDelta,
  TurnMetrics,
} from "../core/types.js";
import {
  emptyDicePool,
  totalDice,
  subtractDice,
  ALL_ELEMENTS,
} from "../core/types.js";
import type { DeckAnalysisPlugin } from "./plugin-interface.js";

// ── Can Afford Check (non-mutating) ───────────────────────────

/**
 * Check if a DicePool can afford a SkillCost.
 * Returns the dice that would be consumed (for deduction).
 */
export function canAfford(pool: DicePool, cost: SkillCost): { affordable: boolean; consumed: DicePool } {
  const remaining = { ...pool };
  const consumed = emptyDicePool();

  // Phase 1: Colored costs — use matching dice first, omni as fallback
  for (const cc of cost.colored) {
    let need = cc.count;
    const key = cc.element;

    // Use matching dice
    const matchAvail = Math.min(need, remaining[key]);
    need -= matchAvail;
    remaining[key] -= matchAvail;
    consumed[key] += matchAvail;

    // Use omni for remainder
    const omniAvail = Math.min(need, remaining.omni);
    need -= omniAvail;
    remaining.omni -= omniAvail;
    consumed.omni += omniAvail;

    if (need > 0) return { affordable: false, consumed };
  }

  // Phase 2: Same-element cost — pick the element with most dice, supplement with omni
  if (cost.same > 0) {
    let need = cost.same;

    // Find element with most available dice (including void-like usage)
    let bestEl: ElementType = "pyro";
    let bestCount = 0;
    for (const el of ALL_ELEMENTS) {
      if (remaining[el] > bestCount) {
        bestCount = remaining[el];
        bestEl = el;
      }
    }

    // Use that element's dice
    const matchAvail = Math.min(need, remaining[bestEl]);
    need -= matchAvail;
    remaining[bestEl] -= matchAvail;
    consumed[bestEl] += matchAvail;

    // Use omni for remainder
    const omniAvail = Math.min(need, remaining.omni);
    need -= omniAvail;
    remaining.omni -= omniAvail;
    consumed.omni += omniAvail;

    if (need > 0) return { affordable: false, consumed };
  }

  // Phase 3: Void cost — use any dice, omni last
  if (cost.void > 0) {
    let need = cost.void;

    // Use specific dice first (any element)
    for (const el of ALL_ELEMENTS) {
      if (need <= 0) break;
      const avail = Math.min(need, remaining[el]);
      need -= avail;
      remaining[el] -= avail;
      consumed[el] += avail;
    }

    // Use omni as last resort
    const omniAvail = Math.min(need, remaining.omni);
    need -= omniAvail;
    remaining.omni -= omniAvail;
    consumed.omni += omniAvail;

    if (need > 0) return { affordable: false, consumed };
  }

  return { affordable: true, consumed };
}

// ── DiceEconomyPlugin ─────────────────────────────────────────

export class DiceEconomyPlugin implements DeckAnalysisPlugin {
  readonly name = "DiceEconomy";

  /** Pre-compute the cost for an action from TurnState context */
  resolveCost(action: ParsedAction, _state: TurnState): SkillCost {
    // Action cost is already pre-computed in ParsedAction
    return action.cost;
  }

  validate(action: ParsedAction, state: TurnState): ValidationResult {
    const cost = this.resolveCost(action, state);

    // Energy check (separate from dice, but validate here for now)
    if (cost.energy > 0 && state.activeChar.energy < cost.energy) {
      return {
        valid: false,
        reason: `Need ${cost.energy} energy, have ${state.activeChar.energy}`,
      };
    }

    const { affordable } = canAfford(state.dice, cost);
    if (!affordable) {
      return {
        valid: false,
        reason: `Cannot afford cost: colored=[${cost.colored.map(c => `${c.element}:${c.count}`)}] void=${cost.void} same=${cost.same} energy=${cost.energy}, dice=${totalDice(state.dice)}`,
      };
    }

    return { valid: true };
  }

  apply(action: ParsedAction, state: TurnState): TurnStateDelta {
    const cost = this.resolveCost(action, state);
    const { consumed } = canAfford(state.dice, cost);

    // Deduct dice
    subtractDice(state.dice, consumed);

    // Deduct energy
    const energySpent = cost.energy;
    state.activeChar.energy = Math.max(0, state.activeChar.energy - energySpent);

    return {
      diceSpent: consumed,
      energyGained: 0,
      energySpent,
      damageDealt: [],
      selfDamage: 0,
      newAuras: [],
      summonCreated: false,
    };
  }

  observeTurn(_state: TurnState, _actions: ParsedAction[]): TurnMetrics {
    // No turn-level metrics for dice economy alone
    return {
      totalDiceSpent: 0,
      totalDamageDealt: 0,
      totalEnergyGained: 0,
      actionCount: _actions.length,
    };
  }
}

// ── Action Cost Builders ──────────────────────────────────────

/**
 * Build a SkillCost from character SkillData.
 * Converts the character's cost definition into the canonical format.
 */
export function buildSkillActionCost(skill: { cost: SkillCost }): SkillCost {
  return { ...skill.cost };
}

/** Build a switch action cost: always 1 void die */
export const SWITCH_COST: SkillCost = {
  colored: [],
  void: 1,
  same: 0,
  energy: 0,
};

/** Build an elemental tuning cost: 1 void die + discard 1 card */
export const TUNING_COST: SkillCost = {
  colored: [],
  void: 1,
  same: 0,
  energy: 0,
};
