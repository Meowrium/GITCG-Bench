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

import {
  DamageType,
  PbModifyDirection,
  PbReactionType,
  PbResetDiceReason,
  type ExposedMutation,
  type Reaction,
} from "@gi-tcg/typings";
import type { StateDelta } from "../search/types.js";

export class DeltaExtractor {
  extract(
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

    for (const em of mutations) {
      switch (em.$case) {
        case "damage": {
          if (em.damageType === DamageType.Heal) {
            delta.healingDone += em.value;
          } else {
            delta.damageDealt += em.value;
            if (
              em.reactionType !== undefined &&
              em.reactionType !== PbReactionType.UNSPECIFIED
            ) {
              const reaction = pbReactionToReaction(em.reactionType);
              if (reaction !== undefined) {
                delta.reactions.push(reaction);
              }
            }
            if (em.causeDefeated) {
              delta.defeatedCount++;
            }
          }
          break;
        }
        case "modifyEntityVar":
          if (em.variableName === "energy") {
            if (em.direction === PbModifyDirection.INCREASE) {
              delta.energyDelta += em.variableValue;
            } else if (em.direction === PbModifyDirection.DECREASE) {
              delta.energyDelta -= em.variableValue;
            }
          }
          break;
        case "createEntity":
          delta.entitiesCreated++;
          break;
        case "removeEntity":
          delta.entitiesRemoved++;
          break;
        case "switchActive":
          if (em.who === perspective) {
            delta.myActiveChanged = true;
          } else {
            delta.oppActiveForced = true;
          }
          break;
        case "resetDice":
          if (
            em.who === perspective &&
            (em.reason === PbResetDiceReason.GENERATE ||
              em.reason === PbResetDiceReason.CONVERT)
          ) {
            delta.diceGained++;
          }
          break;
        case "moveEntity":
          if (em.toWhere === 1) {
            delta.cardsDrawn++;
          }
          break;
        default:
          break;
      }
    }

    return delta;
  }
}

function pbReactionToReaction(pbReaction: number): Reaction | undefined {
  const map: Record<number, Reaction> = {
    [PbReactionType.MELT]: 101,
    [PbReactionType.VAPORIZE]: 102,
    [PbReactionType.OVERLOADED]: 103,
    [PbReactionType.SUPERCONDUCT]: 104,
    [PbReactionType.ELECTRO_CHARGED]: 105,
    [PbReactionType.FROZEN]: 106,
    [PbReactionType.SWIRL_CRYO]: 107,
    [PbReactionType.SWIRL_HYDRO]: 108,
    [PbReactionType.SWIRL_PYRO]: 109,
    [PbReactionType.SWIRL_ELECTRO]: 110,
    [PbReactionType.CRYSTALLIZE_CRYO]: 111,
    [PbReactionType.CRYSTALLIZE_HYDRO]: 112,
    [PbReactionType.CRYSTALLIZE_PYRO]: 113,
    [PbReactionType.CRYSTALLIZE_ELECTRO]: 114,
    [PbReactionType.BURNING]: 115,
    [PbReactionType.BLOOM]: 116,
    [PbReactionType.QUICKEN]: 117,
  };
  return map[pbReaction];
}
