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

import type {
  BenchmarkCliConfig,
  BenchmarkCliDirectMatchup,
  BenchmarkCliMatchup,
} from "../../evaluation/benchmark/cli-config.js"
import type { SelfPlayCollectionResult } from "./self-play-collector.js"

export interface SelfPlayTopupStrategy {
  minSkipRatio?: number
  minSkippedSamples?: number
  healthySkipRatioMax?: number
  targetInsertedPerGame?: number
  targetInsertedPerGamePercentile?: number
  minInsertedPerGameFloor?: number
  maxExtraGamesPerMatchup?: number
  /**
   * Per-matchup uncertainty weights from ranker disagreement (0-1).
   * Higher = model disagrees more with itself = more data needed.
   * Blended with the skip-ratio signal (default blend: 30% uncertainty, 70% skip-ratio).
   */
  uncertaintyWeights?: Map<string, number>
  /**
   * Fraction of top-up signal contributed by uncertainty (0-1).
   * Default 0.3 means 30% uncertainty signal, 70% skip-ratio signal.
   */
  uncertaintyTopupFraction?: number
  /**
   * Per-matchup diversity weights from feature-space coverage analysis (0-1).
   * Higher = this matchup covers underrepresented feature regions.
   * Blended with other signals (default blend: 20% diversity).
   */
  diversityWeights?: Map<string, number>
  /**
   * Fraction of top-up signal contributed by diversity (0-1).
   * Default 0.2 means 20% diversity signal.
   */
  diversityTopupFraction?: number
}

export interface ResolvedSelfPlayTopupStrategy {
  minSkipRatio: number
  minSkippedSamples: number
  healthySkipRatioMax: number
  targetInsertedPerGamePercentile: number
  minInsertedPerGameFloor: number
  maxExtraGamesPerMatchup: number
  targetInsertedPerGame?: number
  uncertaintyTopupFraction: number
  diversityTopupFraction: number
}

export interface SelfPlayTopupMatchupPlan {
  matchupId: string
  currentGames: number
  currentInsertedSamples: number
  currentSkippedSamples: number
  insertedPerGame: number
  skipRatio: number
  targetInsertedSamples: number
  estimatedExtraGames: number
  estimatedInsertedSamplesAfterTopup: number
}

export interface SelfPlayTopupPlan {
  strategy: ResolvedSelfPlayTopupStrategy & {
    resolvedTargetInsertedPerGame: number
  }
  source: {
    totalGames: number
    insertedSamples: number
    skippedSamples: number
  }
  healthyReferenceMatchups: string[]
  matchups: SelfPlayTopupMatchupPlan[]
  totalExtraGames: number
  benchmarkConfig: BenchmarkCliConfig
}

const DEFAULT_STRATEGY: ResolvedSelfPlayTopupStrategy = {
  minSkipRatio: 0.1,
  minSkippedSamples: 100,
  healthySkipRatioMax: 0.05,
  targetInsertedPerGamePercentile: 0.5,
  minInsertedPerGameFloor: 1,
  maxExtraGamesPerMatchup: 200,
  uncertaintyTopupFraction: 0.3,
  diversityTopupFraction: 0.2,
}

export function buildSelfPlayTopupPlan(args: {
  benchmarkConfig: BenchmarkCliConfig
  result: SelfPlayCollectionResult
  strategy?: SelfPlayTopupStrategy
}): SelfPlayTopupPlan {
  const strategy = resolveStrategy(args.strategy)
  const directMatchups = new Map<string, BenchmarkCliDirectMatchup>()
  for (const matchup of args.benchmarkConfig.matchups) {
    if ("priorMatrix" in matchup || "priorMatrixBatch" in matchup) {
      throw new Error("Self-play top-up only supports direct benchmark matchups")
    }
    directMatchups.set(matchup.id, matchup)
  }

  const resultStats = args.result.matchups
    .map((matchup) => {
      const direct = directMatchups.get(matchup.matchupId)
      if (!direct) {
        return undefined
      }
      const skipRatio =
        matchup.insertedSamples + matchup.skippedSamples > 0
          ? matchup.skippedSamples / (matchup.insertedSamples + matchup.skippedSamples)
          : 0
      return {
        direct,
        result: matchup,
        insertedPerGame:
          matchup.games > 0 ? matchup.insertedSamples / matchup.games : 0,
        skipRatio,
      }
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value))

  const healthy = resultStats.filter(
    ({ insertedPerGame, skipRatio }) =>
      insertedPerGame > 0 && skipRatio <= strategy.healthySkipRatioMax,
  )
  const healthyReferenceMatchups = healthy.map(({ result }) => result.matchupId)
  const referenceValues = healthy.map(({ insertedPerGame }) => insertedPerGame)
  const resolvedTargetInsertedPerGame =
    strategy.targetInsertedPerGame ??
    percentile(referenceValues, strategy.targetInsertedPerGamePercentile) ??
    percentile(
      resultStats
        .map(({ insertedPerGame }) => insertedPerGame)
        .filter((value) => value > 0),
      0.5,
    ) ??
    strategy.minInsertedPerGameFloor

  const plans: SelfPlayTopupMatchupPlan[] = []
  const topupMatchups: BenchmarkCliMatchup[] = []

  for (const stat of resultStats) {
    const targetInsertedSamples = Math.ceil(
      resolvedTargetInsertedPerGame * stat.result.games,
    )
    if (
      stat.skipRatio < strategy.minSkipRatio ||
      stat.result.skippedSamples < strategy.minSkippedSamples ||
      stat.result.insertedSamples >= targetInsertedSamples
    ) {
      continue
    }

    let estimatedExtraGames = Math.min(
      strategy.maxExtraGamesPerMatchup,
      Math.max(
        1,
        Math.ceil(
          (targetInsertedSamples - stat.result.insertedSamples) /
            Math.max(stat.insertedPerGame, strategy.minInsertedPerGameFloor),
        ),
      ),
    )

    // Blend in uncertainty signal: high disagreement → more games
    const uncertaintyWeight = args.strategy?.uncertaintyWeights?.get(stat.result.matchupId) ?? 0
    const uncertaintyMultiplier = 1 + uncertaintyWeight * strategy.uncertaintyTopupFraction

    // Blend in diversity signal: underrepresented matchups → more games
    const diversityWeight = args.strategy?.diversityWeights?.get(stat.result.matchupId) ?? 0
    const diversityMultiplier = 1 + diversityWeight * strategy.diversityTopupFraction

    estimatedExtraGames = Math.min(
      strategy.maxExtraGamesPerMatchup,
      Math.ceil(estimatedExtraGames * uncertaintyMultiplier * diversityMultiplier),
    )
    const estimatedInsertedSamplesAfterTopup =
      stat.result.insertedSamples + estimatedExtraGames * stat.insertedPerGame

    plans.push({
      matchupId: stat.result.matchupId,
      currentGames: stat.result.games,
      currentInsertedSamples: stat.result.insertedSamples,
      currentSkippedSamples: stat.result.skippedSamples,
      insertedPerGame: stat.insertedPerGame,
      skipRatio: stat.skipRatio,
      targetInsertedSamples,
      estimatedExtraGames,
      estimatedInsertedSamplesAfterTopup,
    })
    topupMatchups.push({
      ...stat.direct,
      games: estimatedExtraGames,
    })
  }

  plans.sort((left, right) => right.estimatedExtraGames - left.estimatedExtraGames)

  return {
    strategy: {
      ...strategy,
      resolvedTargetInsertedPerGame,
    },
    source: {
      totalGames: args.result.totalGames,
      insertedSamples: args.result.insertedSamples,
      skippedSamples: args.result.skippedSamples,
    },
    healthyReferenceMatchups,
    matchups: plans,
    totalExtraGames: plans.reduce(
      (sum, matchup) => sum + matchup.estimatedExtraGames,
      0,
    ),
    benchmarkConfig: {
      version: args.benchmarkConfig.version,
      matchups: topupMatchups,
    },
  }
}

function resolveStrategy(
  strategy: SelfPlayTopupStrategy | undefined,
): ResolvedSelfPlayTopupStrategy {
  return {
    minSkipRatio: strategy?.minSkipRatio ?? DEFAULT_STRATEGY.minSkipRatio,
    minSkippedSamples: strategy?.minSkippedSamples ?? DEFAULT_STRATEGY.minSkippedSamples,
    healthySkipRatioMax:
      strategy?.healthySkipRatioMax ?? DEFAULT_STRATEGY.healthySkipRatioMax,
    targetInsertedPerGame:
      strategy?.targetInsertedPerGame ?? DEFAULT_STRATEGY.targetInsertedPerGame,
    targetInsertedPerGamePercentile:
      strategy?.targetInsertedPerGamePercentile ??
      DEFAULT_STRATEGY.targetInsertedPerGamePercentile,
    minInsertedPerGameFloor:
      strategy?.minInsertedPerGameFloor ?? DEFAULT_STRATEGY.minInsertedPerGameFloor,
    maxExtraGamesPerMatchup:
      strategy?.maxExtraGamesPerMatchup ?? DEFAULT_STRATEGY.maxExtraGamesPerMatchup,
    uncertaintyTopupFraction:
      strategy?.uncertaintyTopupFraction ?? DEFAULT_STRATEGY.uncertaintyTopupFraction,
    diversityTopupFraction:
      strategy?.diversityTopupFraction ?? DEFAULT_STRATEGY.diversityTopupFraction,
  }
}

function percentile(values: number[], percentileValue: number): number | undefined {
  if (values.length === 0) {
    return undefined
  }
  const sorted = [...values].sort((left, right) => left - right)
  const bounded = Math.min(1, Math.max(0, percentileValue))
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * bounded)),
  )
  return sorted[index]
}
