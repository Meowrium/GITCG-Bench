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

import type { StateDelta } from "../search/types.js";

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
  perspective?: 0 | 1;
  isFast?: boolean;
  oppActiveHealth?: number;
  feasibilityAlpha?: number;
  handDepBeta?: number;
}

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

export class HeuristicScorer {
  private weights: EvalWeights;

  constructor(weights?: Partial<EvalWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(delta: StateDelta, context?: ScoreContext): number {
    const w = this.weights;
    let total = 0;

    total += delta.damageDealt * w.damageBase + delta.defeatedCount * w.killBonus;

    if (context?.oppActiveHealth !== undefined) {
      const remainingHp = context.oppActiveHealth - delta.damageDealt;
      if (remainingHp <= 0 && delta.damageDealt > 0) {
        total += w.killLineBonus;
      }
    }

    total += delta.reactions.length * w.reactionBonus;

    const netDice = delta.diceSpent - delta.diceGained;
    if (netDice > 0) {
      total -= netDice * w.diceCostPenalty;
    } else {
      total += Math.abs(netDice) * w.diceGainBonus;
    }

    total += delta.energyDelta * w.energyValue;
    total += delta.entitiesCreated * w.entityCreatedValue;
    total -= delta.entitiesRemoved * w.entityRemovedValue;
    total += delta.cardsDrawn * w.cardDrawnValue;
    total -= delta.turnsConsumed * w.turnCostPenalty;
    total -= delta.opponentWindowsGiven * w.oppWindowPenalty;
    total += delta.healingDone * w.healingValue;
    total -= delta.myHealthLost * w.selfDamagePenalty;

    if (delta.oppActiveForced) {
      total += w.forcedSwitchBonus;
    }

    const feasAlpha = context?.feasibilityAlpha ?? 1.0;
    total *= Math.pow(delta.diceFeasibility, feasAlpha);

    if (delta.handDependencyTurns > 0) {
      const beta = context?.handDepBeta ?? 0.7;
      total *= Math.pow(beta, delta.handDependencyTurns);
    }

    return total;
  }

  setWeights(weights: Partial<EvalWeights>) {
    this.weights = { ...this.weights, ...weights };
  }

  getWeights(): Readonly<EvalWeights> {
    return { ...this.weights };
  }
}
