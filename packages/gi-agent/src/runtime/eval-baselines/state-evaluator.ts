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
import type { ExposedMutation, ReadonlyDiceRequirement } from "@gi-tcg/typings";
import type { DiceType } from "@gi-tcg/typings";
import type { DiceFeasibility, HandDependency, StateDelta } from "../search/types.js";
import {
  DeltaExtractor,
} from "./delta-extractor.js";
import {
  DEFAULT_WEIGHTS,
  HeuristicScorer,
  type EvalWeights,
  type ScoreContext,
} from "./heuristic-scorer.js";
import { FeasibilityEstimator } from "./feasibility-estimator.js";

export class StateEvaluator {
  private readonly deltaExtractor: DeltaExtractor;
  private readonly heuristicScorer: HeuristicScorer;
  private readonly feasibilityEstimator: FeasibilityEstimator;

  constructor(weights?: Partial<EvalWeights>) {
    this.deltaExtractor = new DeltaExtractor();
    this.heuristicScorer = new HeuristicScorer(weights);
    this.feasibilityEstimator = new FeasibilityEstimator();
  }

  extractDelta(
    mutations: readonly ExposedMutation[],
    perspective: 0 | 1,
    actionIsFast: boolean,
  ): StateDelta {
    return this.deltaExtractor.extract(mutations, perspective, actionIsFast);
  }

  score(delta: StateDelta, context?: ScoreContext): number {
    return this.heuristicScorer.score(delta, context);
  }

  estimateDiceFeasibility(
    requiredCost: ReadonlyDiceRequirement,
    currentDice: readonly DiceType[],
    sampleCount: number = 500,
  ): DiceFeasibility {
    return this.feasibilityEstimator.estimateDiceFeasibility(
      requiredCost,
      currentDice,
      sampleCount,
    );
  }

  evaluateHandDependency(
    requiredDefIds: readonly number[],
    state: GameState,
    who: 0 | 1,
  ): HandDependency {
    return this.feasibilityEstimator.evaluateHandDependency(
      requiredDefIds,
      state,
      who,
    );
  }

  setWeights(weights: Partial<EvalWeights>) {
    this.heuristicScorer.setWeights(weights);
  }

  getWeights(): Readonly<EvalWeights> {
    return this.heuristicScorer.getWeights();
  }
}

export { DEFAULT_WEIGHTS };
export type { EvalWeights, ScoreContext };
