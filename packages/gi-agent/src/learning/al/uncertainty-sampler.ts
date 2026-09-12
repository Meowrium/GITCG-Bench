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

/**
 * Uncertainty-Based Active Sampling via ranker disagreement (Query-by-Committee).
 *
 * Compares two ranker outputs (e.g. SlotLinearRanker vs GBDT ranker) to identify
 * decision points where the models disagree, indicating epistemic uncertainty.
 * These high-disagreement samples are prioritized for additional data collection.
 */

/** Represents the disagreement between two rankings for a single query group. */
export interface RankingDisagreementResult {
  queryId: string
  matchupId: string
  /** 0 = identical rankings, 1 = completely different. Based on top-1 match + Kendall tau. */
  disagreement: number
  /** Whether both rankers agree on the top-1 candidate. */
  top1Match: boolean
}

/** A ranked action with candidate ID and score. */
export interface RankedAction {
  candidateId: string
  score: number
}

/**
 * Compute disagreement between two ranked lists.
 *
 * Uses a blended metric:
 *  - Top-1 disagreement: 0.6 weight (binary — disagree = 1, agree = 0)
 *  - Normalized Kendall tau distance: 0.4 weight (continuous 0-1)
 *
 * Returns 0 for identical rankings, 1 for completely opposite.
 */
export function computeRankingDisagreement(
  rankingA: readonly RankedAction[],
  rankingB: readonly RankedAction[],
): number {
  if (rankingA.length === 0 || rankingB.length === 0) return 0

  // Top-1 match
  const top1Match = rankingA[0].candidateId === rankingB[0].candidateId

  // Kendall tau distance on common candidates
  const idsA = new Map(rankingA.map((r, i) => [r.candidateId, i]))
  const idsB = new Map(rankingB.map((r, i) => [r.candidateId, i]))
  const commonIds = [...idsA.keys()].filter((id) => idsB.has(id))

  let tauDistance = 0
  if (commonIds.length > 1) {
    let discordant = 0
    let totalPairs = 0
    for (let i = 0; i < commonIds.length; i++) {
      for (let j = i + 1; j < commonIds.length; j++) {
        const aOrder = idsA.get(commonIds[i])! - idsA.get(commonIds[j])!
        const bOrder = idsB.get(commonIds[i])! - idsB.get(commonIds[j])!
        if (Math.sign(aOrder) !== Math.sign(bOrder)) {
          discordant++
        }
        totalPairs++
      }
    }
    tauDistance = totalPairs > 0 ? discordant / totalPairs : 0
  } else if (commonIds.length === 0) {
    tauDistance = 1
  }

  const top1Weight = 0.6
  const tauWeight = 0.4
  return top1Weight * (top1Match ? 0 : 1) + tauWeight * tauDistance
}

/**
 * Build per-matchup uncertainty weights from disagreement results.
 *
 * Returns a map of matchupId → uncertainty weight (0-1 scale).
 * Higher weight = higher model disagreement = more data needed.
 * Normalized so that the matchup with most disagreement gets weight 1.0.
 */
export function buildUncertaintyTopupWeights(
  disagreements: readonly RankingDisagreementResult[],
): Map<string, number> {
  const matchupDisagreement = new Map<string, number[]>()
  for (const d of disagreements) {
    if (!matchupDisagreement.has(d.matchupId)) {
      matchupDisagreement.set(d.matchupId, [])
    }
    matchupDisagreement.get(d.matchupId)!.push(d.disagreement)
  }

  const matchupMean = new Map<string, number>()
  let maxMean = 0
  for (const [matchupId, values] of matchupDisagreement) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    matchupMean.set(matchupId, mean)
    if (mean > maxMean) maxMean = mean
  }

  const weights = new Map<string, number>()
  for (const [matchupId, mean] of matchupMean) {
    weights.set(matchupId, maxMean > 0 ? mean / maxMean : 0)
  }
  return weights
}
