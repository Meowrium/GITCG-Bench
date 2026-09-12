// Copyright (C) 2024-2025 Nous Research
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * TurnSimulator — orchestrates plugins over a sequence of actions.
 *
 * Execution model:
 *   1. For each action in sequence:
 *      a. Validate across all plugins (fail-fast)
 *      b. Apply across all plugins (mutate state, collect deltas)
 *   2. After all actions, call observeTurn on each plugin
 *
 * Plugins are called in registration order.
 */

import type {
  TurnState,
  ParsedAction,
  TurnStateDelta,
  TurnMetrics,
  CharacterState,
  OpponentState,
  CharacterData,
  DicePool,
  ElementType,
} from "../core/types.js";
import { emptyDicePool, totalDice } from "../core/types.js";
import type { DeckAnalysisPlugin } from "../plugins/plugin-interface.js";
import type { DamageCalculatorPlugin } from "../plugins/damage-calculator.js";

// ── Simulation Result ─────────────────────────────────────────

export interface SimulationResult {
  /** Whether all actions were valid */
  feasible: boolean;
  /** First validation error, if any */
  error?: string;
  /** Final state after all actions */
  finalState: TurnState;
  /** Aggregated deltas across all actions */
  totalDelta: TurnStateDelta;
  /** Turn-level metrics from plugins */
  metrics: TurnMetrics;
  /** Per-action breakdown */
  steps: StepResult[];
}

export interface StepResult {
  action: ParsedAction;
  valid: boolean;
  delta: TurnStateDelta;
}

// ── Simulator ─────────────────────────────────────────────────

export class TurnSimulator {
  private plugins: DeckAnalysisPlugin[] = [];

  register(plugin: DeckAnalysisPlugin): void {
    this.plugins.push(plugin);
  }

  /** Get a registered plugin by name */
  getPlugin<T extends DeckAnalysisPlugin>(name: string): T | undefined {
    return this.plugins.find((p) => p.name === name) as T | undefined;
  }

  /**
   * Simulate a sequence of actions against an initial TurnState.
   * State is NOT mutated — a clone is used.
   */
  simulate(initialState: TurnState, actions: ParsedAction[]): SimulationResult {
    // Clone state
    const state = cloneState(initialState);

    // Reset per-round state on damage calculator
    const dmgPlugin = this.getPlugin<DamageCalculatorPlugin>("DamageCalculator");
    if (dmgPlugin) dmgPlugin.resetRound();

    const steps: StepResult[] = [];
    const totalDelta: TurnStateDelta = {
      diceSpent: emptyDicePool(),
      energyGained: 0,
      energySpent: 0,
      damageDealt: [],
      selfDamage: 0,
      newAuras: [],
      summonCreated: false,
    };

    for (const action of actions) {
      // Validate across all plugins
      for (const plugin of this.plugins) {
        const result = plugin.validate(action, state);
        if (!result.valid) {
          return {
            feasible: false,
            error: `[${plugin.name}] ${result.reason}`,
            finalState: state,
            totalDelta,
            metrics: { totalDiceSpent: 0, totalDamageDealt: 0, totalEnergyGained: 0, actionCount: steps.length },
            steps,
          };
        }
      }

      // Apply across all plugins
      const stepDelta: TurnStateDelta = {
        diceSpent: emptyDicePool(),
        energyGained: 0,
        energySpent: 0,
        damageDealt: [],
        selfDamage: 0,
        newAuras: [],
        summonCreated: false,
      };

      for (const plugin of this.plugins) {
        const d = plugin.apply(action, state);
        mergeDelta(stepDelta, d);
      }

      steps.push({ action, valid: true, delta: stepDelta });
      mergeDelta(totalDelta, stepDelta);
    }

    // Observe turn
    const metrics = this.observeTurn(state, actions);

    return {
      feasible: true,
      finalState: state,
      totalDelta,
      metrics,
      steps,
    };
  }

  private observeTurn(state: TurnState, actions: ParsedAction[]): TurnMetrics {
    const metrics: TurnMetrics = {
      totalDiceSpent: 0,
      totalDamageDealt: 0,
      totalEnergyGained: 0,
      actionCount: actions.length,
    };
    for (const plugin of this.plugins) {
      const m = plugin.observeTurn(state, actions);
      metrics.totalDiceSpent += m.totalDiceSpent;
      metrics.totalDamageDealt += m.totalDamageDealt;
      metrics.totalEnergyGained += m.totalEnergyGained;
    }
    return metrics;
  }
}

// ── State Helpers ─────────────────────────────────────────────

function cloneState(s: TurnState): TurnState {
  return {
    round: s.round,
    dice: { ...s.dice },
    activeChar: { ...s.activeChar, equipment: [...s.activeChar.equipment], statuses: [...s.activeChar.statuses] },
    bench: s.bench.map((c) => ({ ...c, equipment: [...c.equipment], statuses: [...c.statuses] })),
    hand: s.hand.map((c) => ({ ...c })),
    opponents: s.opponents.map((o) => ({ ...o })),
  };
}

function mergeDelta(target: TurnStateDelta, source: TurnStateDelta): void {
  target.diceSpent.cryo += source.diceSpent.cryo;
  target.diceSpent.hydro += source.diceSpent.hydro;
  target.diceSpent.pyro += source.diceSpent.pyro;
  target.diceSpent.electro += source.diceSpent.electro;
  target.diceSpent.anemo += source.diceSpent.anemo;
  target.diceSpent.geo += source.diceSpent.geo;
  target.diceSpent.dendro += source.diceSpent.dendro;
  target.diceSpent.omni += source.diceSpent.omni;
  target.energyGained += source.energyGained;
  target.energySpent += source.energySpent;
  target.damageDealt.push(...source.damageDealt);
  target.selfDamage += source.selfDamage;
  target.newAuras.push(...source.newAuras);
  if (source.summonCreated) target.summonCreated = true;
}

// ── State Builders ────────────────────────────────────────────

/**
 * Create a CharacterState from CharacterData.
 */
export function createCharacterState(data: CharacterData): CharacterState {
  return {
    definitionId: data.definitionId,
    name: data.name,
    element: data.element,
    hp: data.health,
    maxHp: data.health,
    energy: 0,
    maxEnergy: data.maxEnergy,
    alive: true,
    equipment: [],
    statuses: [],
  };
}

/**
 * Create an OpponentState with given HP and optional aura.
 */
export function createOpponent(hp: number, aura: ElementType | null = null): OpponentState {
  return {
    definitionId: 0, // unknown opponent
    hp,
    maxHp: hp,
    aura,
    alive: true,
  };
}

/**
 * Create an initial TurnState for a deck.
 */
export function createTurnState(
  round: number,
  activeChar: CharacterData,
  bench: CharacterData[],
  dice: DicePool,
  opponentHp: number,
): TurnState {
  return {
    round,
    dice: { ...dice },
    activeChar: createCharacterState(activeChar),
    bench: bench.map(createCharacterState),
    hand: [],
    opponents: [createOpponent(opponentHp)],
  };
}
