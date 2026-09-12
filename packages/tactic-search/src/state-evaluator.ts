// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import type { GameState } from "@gi-tcg/core";
import {
  type ExposedMutation,
  Reaction,
  DiceType,
  PbReactionType,
  PbResetDiceReason,
  PbHealKind,
  DamageType,
  PbModifyDirection,
} from "@gi-tcg/typings";
import type { StateDelta, DiceFeasibility, HandDependency } from "./types";

/**
 * Layer 2: State Evaluator
 *
 * Converts simulation mutations into multi-dimensional StateDelta vectors
 * and produces nonlinear composite scores.
 */
export class StateEvaluator {
  /** Weights for each dimension — start uniform, tune via self-play later */
  private weights: EvalWeights;

  constructor(weights?: Partial<EvalWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Extract a StateDelta from a set of ExposedMutations.
   */
  extractDelta(
    mutations: readonly ExposedMutation[],
    perspective: 0 | 1,
    actionIsFast: boolean,
  ): StateDelta {
    const delta: StateDelta = {
      damageDealt: 0,
      reactions: [],
      defeatedCount: 0,
      diceSpent: 0,
      diceGained: 0,
      cardsDrawn: 0,
      energyDelta: 0,
      entitiesCreated: 0,
      entitiesRemoved: 0,
      turnsConsumed: actionIsFast ? 0 : 1,
      opponentWindowsGiven: actionIsFast ? 0 : 1,
      myActiveChanged: false,
      oppActiveForced: false,
      healingDone: 0,
      myHealthLost: 0,
      diceFeasibility: 1.0,
      handDependencyTurns: 0,
    };

    const opp = (perspective === 0 ? 1 : 0) as 0 | 1;

    for (const em of mutations) {
      switch (em.$case) {
        case "damage": {
          const dm = em as DamageMutation;
          if (dm.damageType === DamageType.Heal) {
            // Heal from perspective player
            delta.healingDone += dm.value;
          } else {
            // Check if dealing damage to opponent or self
            // We can't directly determine "who" from damageEM, but we can infer:
            // If health decreased (newHealth < oldHealth), it's damage to a target.
            // We track by whether source/target is ours or opponent's.
            delta.damageDealt += dm.value;

            // Detect reactions
            if (
              dm.reactionType !== undefined &&
              dm.reactionType !== PbReactionType.UNSPECIFIED
            ) {
              const reaction = pbReactionToReaction(dm.reactionType);
              if (reaction !== undefined) {
                delta.reactions.push(reaction);
              }
            }

            // Detect defeats
            if (dm.causeDefeated) {
              delta.defeatedCount++;
            }
          }
          break;
        }
        case "modifyEntityVar": {
          const mv = em as ModifyEntityVarMutation;
          if (mv.variableName === "energy") {
            if (mv.direction === PbModifyDirection.INCREASE) {
              delta.energyDelta += mv.variableValue;
            } else if (mv.direction === PbModifyDirection.DECREASE) {
              delta.energyDelta -= mv.variableValue;
            }
          }
          if (mv.variableName === "health") {
            if (mv.direction === PbModifyDirection.DECREASE) {
              // Could be our HP loss — tracked via damage mutations above
              delta.myHealthLost += 0; // separate tracking if needed
            }
          }
          break;
        }
        case "createEntity": {
          delta.entitiesCreated++;
          break;
        }
        case "removeEntity": {
          delta.entitiesRemoved++;
          break;
        }
        case "switchActive": {
          const sw = em as SwitchActiveMutation;
          if (sw.who === perspective) {
            delta.myActiveChanged = true;
          } else {
            delta.oppActiveForced = true;
          }
          break;
        }
        case "resetDice": {
          const rd = em as ResetDiceMutation;
          if (rd.who === perspective) {
            if (rd.reason === PbResetDiceReason.CONSUME) {
              // Dice consumed
              // Count is tracked from cost, not here
            } else if (
              rd.reason === PbResetDiceReason.GENERATE ||
              rd.reason === PbResetDiceReason.CONVERT
            ) {
              delta.diceGained++;
            }
          }
          break;
        }
        case "moveEntity": {
          const me = em as MoveEntityMutation;
          // Cards drawn from pile to hand
          if (me.toWhere === 1 /* HAND */) {
            delta.cardsDrawn++;
          }
          break;
        }
      }
    }

    return delta;
  }

  /**
   * Compute composite score from a StateDelta using nonlinear mapping.
   */
  score(delta: StateDelta, context?: ScoreContext): number {
    const w = this.weights;
    let total = 0;

    // Damage: base + kill bonus
    const damageScore =
      delta.damageDealt * w.damageBase +
      delta.defeatedCount * w.killBonus;
    total += damageScore;

    // Kill-line bonus: nonlinear boost when opponent is near death
    if (context?.oppActiveHealth !== undefined) {
      const remainingHp = context.oppActiveHealth - delta.damageDealt;
      if (remainingHp <= 0 && delta.damageDealt > 0) {
        total += w.killLineBonus;
      }
    }

    // Reactions bonus
    total += delta.reactions.length * w.reactionBonus;

    // Resource: dice efficiency
    const netDice = delta.diceSpent - delta.diceGained;
    if (netDice > 0) {
      total -= netDice * w.diceCostPenalty;
    } else {
      total += Math.abs(netDice) * w.diceGainBonus;
    }

    // Energy
    total += delta.energyDelta * w.energyValue;

    // Entities
    total += delta.entitiesCreated * w.entityCreatedValue;
    total -= delta.entitiesRemoved * w.entityRemovedValue;

    // Cards drawn
    total += delta.cardsDrawn * w.cardDrawnValue;

    // Tempo: combat actions cost
    total -= delta.turnsConsumed * w.turnCostPenalty;
    total -= delta.opponentWindowsGiven * w.oppWindowPenalty;

    // Defense
    total += delta.healingDone * w.healingValue;
    total -= delta.myHealthLost * w.selfDamagePenalty;

    // Forced switch bonus
    if (delta.oppActiveForced) {
      total += w.forcedSwitchBonus;
    }

    // Feasibility discount
    const feasAlpha = context?.feasibilityAlpha ?? 1.0;
    total *= Math.pow(delta.diceFeasibility, feasAlpha);

    // Hand dependency discount
    if (delta.handDependencyTurns > 0) {
      const beta = context?.handDepBeta ?? 0.7;
      total *= Math.pow(beta, delta.handDependencyTurns);
    }

    return total;
  }

  /**
   * Estimate dice feasibility for a cost requirement via Monte Carlo.
   */
  estimateDiceFeasibility(
    requiredCost: ReadonlyMap<number, number>,
    currentDice: readonly DiceType[],
    sampleCount: number = 500,
  ): DiceFeasibility {
    // For current turn (dice known), check directly
    if (canPayCost(requiredCost, currentDice)) {
      return {
        sampleCount: 1,
        feasibleCount: 1,
        feasibilityRate: 1.0,
        avgDiceDeficit: 0,
      };
    }

    // Otherwise: Monte Carlo sampling for next turn's dice
    let feasible = 0;
    let totalDeficit = 0;
    const diceCount = 8; // default dice per turn

    for (let i = 0; i < sampleCount; i++) {
      const rolled = rollRandomDice(diceCount);
      if (canPayCost(requiredCost, rolled)) {
        feasible++;
      } else {
        totalDeficit += computeDiceDeficit(requiredCost, rolled);
      }
    }

    return {
      sampleCount,
      feasibleCount: feasible,
      feasibilityRate: feasible / sampleCount,
      avgDiceDeficit:
        sampleCount - feasible > 0
          ? totalDeficit / (sampleCount - feasible)
          : 0,
    };
  }

  /**
   * Track hand dependency for a set of required cards.
   */
  evaluateHandDependency(
    requiredDefIds: readonly number[],
    state: GameState,
    who: 0 | 1,
  ): HandDependency {
    const player = state.players[who];
    const handDefIds = player.hands.map((h) => h.definition.id);
    const pileDefIds = player.pile.map((p) => p.definition.id);

    const inHand: number[] = [];
    const notInHand: number[] = [];

    for (const id of requiredDefIds) {
      if (handDefIds.includes(id)) {
        inHand.push(id);
      } else {
        notInHand.push(id);
      }
    }

    const remainingInPile = notInHand.filter((id) =>
      pileDefIds.includes(id),
    ).length;

    // Expected turns = ceil(notInHand.length / 2) assuming 2 draws per turn
    const needed = notInHand.length;
    const expectedTurns = needed > 0 ? Math.ceil(needed / 2) : 0;

    return {
      requiredCardDefIds: requiredDefIds,
      inHandNow: inHand,
      notInHand,
      remainingInPile,
      expectedTurnToComplete: expectedTurns,
      isGuaranteedThisTurn: notInHand.length === 0,
    };
  }

  /** Update weights (for self-play calibration). */
  setWeights(weights: Partial<EvalWeights>) {
    this.weights = { ...this.weights, ...weights };
  }

  getWeights(): Readonly<EvalWeights> {
    return { ...this.weights };
  }
}

// ─── Weight Configuration ───

export interface EvalWeights {
  damageBase: number;
  killBonus: number;
  killLineBonus: number;
  reactionBonus: number;
  diceCostPenalty: number;
  diceGainBonus: number;
  energyValue: number;
  entityCreatedValue: number;
  entityRemovedValue: number;
  cardDrawnValue: number;
  turnCostPenalty: number;
  oppWindowPenalty: number;
  healingValue: number;
  selfDamagePenalty: number;
  forcedSwitchBonus: number;
}

export interface ScoreContext {
  /** Backward compatibility for older callers/tests; currently unused in scoring. */
  perspective?: 0 | 1;
  /** Backward compatibility for older callers/tests; currently unused in scoring. */
  isFast?: boolean;
  /** Opponent active character's current HP */
  oppActiveHealth?: number;
  /** Feasibility alpha: <1 risk-loving, >1 conservative */
  feasibilityAlpha?: number;
  /** Hand dependency beta: discount per turn of waiting */
  handDepBeta?: number;
}

/** Uniform initial weights — no prior bias */
export const DEFAULT_WEIGHTS: EvalWeights = {
  damageBase: 2.0,
  killBonus: 15.0,
  killLineBonus: 10.0,
  reactionBonus: 3.0,
  diceCostPenalty: 1.5,
  diceGainBonus: 2.0,
  energyValue: 2.5,
  entityCreatedValue: 2.0,
  entityRemovedValue: 1.0,
  cardDrawnValue: 1.5,
  turnCostPenalty: 3.0,
  oppWindowPenalty: 1.0,
  healingValue: 0.8,
  selfDamagePenalty: 1.0,
  forcedSwitchBonus: 4.0,
};

// ─── Dice Utilities ───

const ELEMENT_DICE = [
  DiceType.Cryo,
  DiceType.Hydro,
  DiceType.Pyro,
  DiceType.Electro,
  DiceType.Anemo,
  DiceType.Geo,
  DiceType.Dendro,
  DiceType.Omni,
] as const;

function rollRandomDice(count: number): DiceType[] {
  const result: DiceType[] = [];
  for (let i = 0; i < count; i++) {
    result.push(ELEMENT_DICE[Math.floor(Math.random() * ELEMENT_DICE.length)]);
  }
  return result;
}

function canPayCost(
  cost: ReadonlyMap<number, number>,
  dice: readonly DiceType[],
): boolean {
  const available = new Map<DiceType, number>();
  for (const d of dice) {
    available.set(d, (available.get(d) ?? 0) + 1);
  }

  let omniRemain = available.get(DiceType.Omni) ?? 0;

  for (const [type, needed] of cost) {
    if (type === DiceType.Energy || type === DiceType.Legend) continue;
    if (type === DiceType.Void) continue; // Void handled last

    const have = available.get(type as DiceType) ?? 0;
    const deficit = Math.max(0, needed - have);
    omniRemain -= deficit;
    if (omniRemain < 0) return false;
  }

  // Void cost: any dice type
  const voidCost = cost.get(DiceType.Void) ?? 0;
  if (voidCost > 0) {
    let totalRemaining = 0;
    for (const [type, count] of available) {
      if (type === DiceType.Energy || type === DiceType.Legend) continue;
      totalRemaining += count;
    }
    // Account for already-consumed specific dice (rough check)
    if (totalRemaining < voidCost) return false;
  }

  return true;
}

function computeDiceDeficit(
  cost: ReadonlyMap<number, number>,
  dice: readonly DiceType[],
): number {
  let deficit = 0;
  const available = new Map<DiceType, number>();
  for (const d of dice) {
    available.set(d, (available.get(d) ?? 0) + 1);
  }

  for (const [type, needed] of cost) {
    if (type === DiceType.Energy || type === DiceType.Legend) continue;
    const have = available.get(type as DiceType) ?? 0;
    deficit += Math.max(0, needed - have);
  }

  return deficit;
}

// ─── Mutation Type Guards ───

interface DamageMutation {
  readonly $case: "damage";
  readonly damageType: number;
  readonly sourceId: number;
  readonly sourceDefinitionId: number;
  readonly value: number;
  readonly targetId: number;
  readonly targetDefinitionId: number;
  readonly isSkillMainDamage: boolean;
  readonly reactionType: number;
  readonly causeDefeated: boolean;
  readonly oldHealth: number;
  readonly newHealth: number;
}

interface ModifyEntityVarMutation {
  readonly $case: "modifyEntityVar";
  readonly entityId: number;
  readonly entityDefinitionId: number;
  readonly variableName: string;
  readonly variableValue: number;
  readonly direction: number;
}

interface SwitchActiveMutation {
  readonly $case: "switchActive";
  readonly who: number;
}

interface ResetDiceMutation {
  readonly $case: "resetDice";
  readonly who: number;
  readonly dice: readonly number[];
  readonly reason: number;
}

interface MoveEntityMutation {
  readonly $case: "moveEntity";
  readonly fromWho: number;
  readonly fromWhere: number;
  readonly toWho: number;
  readonly toWhere: number;
}

// ─── Reaction Type Mapping ───

function pbReactionToReaction(
  pbReaction: number,
): Reaction | undefined {
  const map: Record<number, Reaction> = {
    [PbReactionType.MELT]: Reaction.Melt,
    [PbReactionType.VAPORIZE]: Reaction.Vaporize,
    [PbReactionType.OVERLOADED]: Reaction.Overloaded,
    [PbReactionType.SUPERCONDUCT]: Reaction.Superconduct,
    [PbReactionType.ELECTRO_CHARGED]: Reaction.ElectroCharged,
    [PbReactionType.FROZEN]: Reaction.Frozen,
    [PbReactionType.SWIRL_CRYO]: Reaction.SwirlCryo,
    [PbReactionType.SWIRL_HYDRO]: Reaction.SwirlHydro,
    [PbReactionType.SWIRL_PYRO]: Reaction.SwirlPyro,
    [PbReactionType.SWIRL_ELECTRO]: Reaction.SwirlElectro,
    [PbReactionType.CRYSTALLIZE_CRYO]: Reaction.CrystallizeCryo,
    [PbReactionType.CRYSTALLIZE_HYDRO]: Reaction.CrystallizeHydro,
    [PbReactionType.CRYSTALLIZE_PYRO]: Reaction.CrystallizePyro,
    [PbReactionType.CRYSTALLIZE_ELECTRO]: Reaction.CrystallizeElectro,
    [PbReactionType.BURNING]: Reaction.Burning,
    [PbReactionType.BLOOM]: Reaction.Bloom,
    [PbReactionType.QUICKEN]: Reaction.Quicken,
  };
  return map[pbReaction];
}
