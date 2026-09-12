// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import type { GameState } from "@gi-tcg/core";
import { DiceType, type ReadonlyDiceRequirement } from "@gi-tcg/typings";
import type { DiceFeasibility, HandDependency } from "../search/types.js";

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

export class FeasibilityEstimator {
  estimateDiceFeasibility(
    requiredCost: ReadonlyDiceRequirement,
    currentDice: readonly DiceType[],
    sampleCount: number = 500,
  ): DiceFeasibility {
    if (canPayCost(requiredCost, currentDice)) {
      return {
        sampleCount: 1,
        feasibleCount: 1,
        feasibilityRate: 1,
        avgDiceDeficit: 0,
      };
    }

    let feasible = 0;
    let totalDeficit = 0;
    for (let i = 0; i < sampleCount; i++) {
      const rolled = rollRandomDice(8);
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
        sampleCount - feasible > 0 ? totalDeficit / (sampleCount - feasible) : 0,
    };
  }

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

    const remainingInPile = notInHand.filter((id) => pileDefIds.includes(id)).length;
    const expectedTurns = notInHand.length > 0 ? Math.ceil(notInHand.length / 2) : 0;

    return {
      requiredCardDefIds: requiredDefIds,
      inHandNow: inHand,
      notInHand,
      remainingInPile,
      expectedTurnToComplete: expectedTurns,
      isGuaranteedThisTurn: notInHand.length === 0,
    };
  }
}

function rollRandomDice(count: number): DiceType[] {
  const result: DiceType[] = [];
  for (let i = 0; i < count; i++) {
    result.push(ELEMENT_DICE[Math.floor(Math.random() * ELEMENT_DICE.length)]);
  }
  return result;
}

function canPayCost(cost: ReadonlyDiceRequirement, dice: readonly DiceType[]): boolean {
  const available = new Map<DiceType, number>();
  for (const d of dice) {
    available.set(d, (available.get(d) ?? 0) + 1);
  }

  let omniRemain = available.get(DiceType.Omni) ?? 0;
  for (const [type, needed] of cost) {
    if (type === DiceType.Energy || type === DiceType.Legend) continue;
    if (type === DiceType.Void) continue;
    const have = available.get(type as DiceType) ?? 0;
    const deficit = Math.max(0, needed - have);
    omniRemain -= deficit;
    if (omniRemain < 0) return false;
  }

  const voidCost = cost.get(DiceType.Void) ?? 0;
  if (voidCost > 0) {
    let totalRemaining = 0;
    for (const [type, count] of available) {
      if (type === DiceType.Energy || type === DiceType.Legend) continue;
      totalRemaining += count;
    }
    if (totalRemaining < voidCost) return false;
  }

  return true;
}

function computeDiceDeficit(
  cost: ReadonlyDiceRequirement,
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
