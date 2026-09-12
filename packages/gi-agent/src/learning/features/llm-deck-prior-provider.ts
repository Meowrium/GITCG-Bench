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
 * LlmDeckPriorProvider — LLM-enhanced deck prior provider.
 *
 * Wraps DeckPriorProvider and optionally enriches prior features with
 * LLM analysis from a pre-computed cache directory.
 *
 * Usage:
 *   1. Pre-compute LLM analysis: pnpm exec gnx precompute-llm-analysis.ts benchmark.json
 *   2. Training picks up the cache automatically when LLM_CACHE_DIR is set
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  DeckAnalysis,
  MatchupAnalysis,
} from "../../../../llm-deck-analyzer/src/types"
import {
  DeckPriorProvider,
} from "./deck-prior-provider"
import type { PolicyDeckPriorContext, DeckPriorFeatureVector } from "../../runtime/policy/prior-types"

export interface LlmDeckPriorProviderOptions {
  /** Path to the LLM analysis cache directory (default: no LLM enhancement). */
  llmCacheDir?: string
  /** Weight of LLM strength score vs heuristic (0-1, default 0.5). */
  llmBlendWeight?: number
}

export class LlmDeckPriorProvider extends DeckPriorProvider {
  private readonly llmCacheDir?: string
  private readonly llmBlendWeight: number

  constructor(options: LlmDeckPriorProviderOptions = {}) {
    super()
    this.llmCacheDir = options.llmCacheDir
    this.llmBlendWeight = options.llmBlendWeight ?? 0.5
  }

  override async getPolicyContext(
    selfDeckCode: string,
    opponentDeckCode: string,
  ): Promise<PolicyDeckPriorContext> {
    // Always compute the base (heuristic) context
    const baseContext = await super.getPolicyContext(selfDeckCode, opponentDeckCode)

    if (!this.llmCacheDir) {
      return baseContext
    }

    // Try to load LLM-enhanced analysis from cache
    try {
      const llmDeckA = this.loadCachedDeckAnalysis(selfDeckCode)
      const llmDeckB = this.loadCachedDeckAnalysis(opponentDeckCode)
      const llmMatchup = this.loadCachedMatchupAnalysis(selfDeckCode, opponentDeckCode)

      if (!llmDeckA && !llmDeckB && !llmMatchup) {
        return baseContext // No LLM cache available
      }

      // Blend LLM analysis into prior features
      const enhancedPrior = this.blendPriorFeatures(
        baseContext.priorFeatures,
        llmDeckA,
        llmDeckB,
        llmMatchup,
      )

      return {
        selfDeckCode,
        opponentDeckCode,
        priorFeatures: enhancedPrior,
      }
    } catch {
      return baseContext // Silent fallback on any LLM cache error
    }
  }

  private loadCachedDeckAnalysis(deckCode: string): DeckAnalysis | null {
    if (!this.llmCacheDir) return null

    // Try to find the cache file — the cache key uses sanitized deckCode + optional name
    const dir = this.llmCacheDir
    if (!existsSync(dir)) return null

    // The cache file is named: deck_<sanitized deckCode>__.json or deck_<sanitized deckCode>_<name>.json
    // Use the fact that all deck codes start with a common pattern
    try {
      // Simpler approach: try reading directly by constructing the key
      const safeCode = deckCode.replaceAll(/[^a-zA-Z0-9一-鿿\-_=+]/g, "_").slice(0, 200)
      // Try both with and without trailing double underscore (no name)
      const possiblePaths = [
        join(dir, `deck_${safeCode}__.json`),
        join(dir, `deck_${safeCode}_from_.json`),
        // Also try glob-like: any file starting with deck_<safeCode>
      ]

      for (const path of possiblePaths) {
        if (existsSync(path)) {
          return JSON.parse(readFileSync(path, "utf-8")) as DeckAnalysis
        }
      }

      // Fallback: scan directory for matching prefix
      const { readdirSync } = require("node:fs") as typeof import("node:fs")
      const files = readdirSync(dir) as string[]
      const match = files.find((f) => f.startsWith(`deck_${safeCode}`))
      if (match) {
        return JSON.parse(readFileSync(join(dir, match), "utf-8")) as DeckAnalysis
      }
    } catch {
      // ignore
    }

    return null
  }

  private loadCachedMatchupAnalysis(
    deckA: string,
    deckB: string,
  ): MatchupAnalysis | null {
    if (!this.llmCacheDir) return null

    const dir = this.llmCacheDir
    if (!existsSync(dir)) return null

    const safeA = deckA.replaceAll(/[^a-zA-Z0-9一-鿿\-_=+]/g, "_").slice(0, 200)
    const safeB = deckB.replaceAll(/[^a-zA-Z0-9一-鿿\-_=+]/g, "_").slice(0, 200)

    try {
      // Matchup files are named: matchup_<safeA>__<safeB>.json
      const possiblePaths = [
        join(dir, `matchup_${safeA}__${safeB}.json`),
        join(dir, `matchup_${safeB}__${safeA}.json`),
      ]
      for (const path of possiblePaths) {
        if (existsSync(path)) {
          return JSON.parse(readFileSync(path, "utf-8")) as MatchupAnalysis
        }
      }
    } catch {
      // ignore
    }

    return null
  }

  /**
   * Blend LLM analysis into the heuristic prior feature vector.
   *
   * Uses LLM's structured planProfile (archetype + 5-dim tempo breakdown)
   * to directly set the corresponding DeckPriorFeatureVector fields.
   * Falls back to heuristic values when LLM analysis is unavailable.
   */
  private blendPriorFeatures(
    base: DeckPriorFeatureVector,
    llmDeckA: DeckAnalysis | null,
    llmDeckB: DeckAnalysis | null,
    llmMatchup: MatchupAnalysis | null,
  ): DeckPriorFeatureVector {
    const w = this.llmBlendWeight
    const result = { ...base }

    // Directly map LLM planProfile → DeckPriorFeatureVector fields
    const applyProfile = (
      target: Record<string, number>,
      prefix: string,
      profile: DeckAnalysis["planProfile"],
    ) => {
      if (!profile) return
      const fields: [string, keyof typeof profile][] = [
        ["SetupSpeed", "setupSpeed"],
        ["TempoPush", "tempoPush"],
        ["LongGameValue", "longGameValue"],
        ["DefensiveStability", "defensiveStability"],
        ["FinisherDensity", "finisherDensity"],
      ]
      for (const [featKey, profKey] of fields) {
        const llmVal = profile[profKey]
        if (llmVal != null) {
          const fullKey = `${prefix}Deck${featKey}`
          const heuristicVal = (target as any)[fullKey] ?? 0.5
          ;(target as any)[fullKey] = (1 - w) * heuristicVal + w * llmVal
        }
      }
    }

    if (llmDeckA?.planProfile) {
      applyProfile(result, "self", llmDeckA.planProfile)
    }
    if (llmDeckB?.planProfile) {
      applyProfile(result, "opponent", llmDeckB.planProfile)
    }

    // Map LLM archetype → route/archetype labels
    if (llmDeckA?.archetype) {
      result.selfRouteReaction = llmDeckA.archetype === "combo" || llmDeckA.archetype === "tempo" ? 1 : result.selfRouteReaction
      result.selfRouteCarry = llmDeckA.archetype === "aggro" || llmDeckA.archetype === "combo" ? 1 : result.selfRouteCarry
      result.selfRouteResource = llmDeckA.archetype === "support_engine" || llmDeckA.archetype === "control" ? 1 : result.selfRouteResource
      result.selfArchetypeSupportEngine = llmDeckA.archetype === "support_engine" ? 1 : result.selfArchetypeSupportEngine
    }
    if (llmDeckB?.archetype) {
      result.opponentRouteReaction = llmDeckB.archetype === "combo" || llmDeckB.archetype === "tempo" ? 1 : result.opponentRouteReaction
      result.opponentRouteCarry = llmDeckB.archetype === "aggro" || llmDeckB.archetype === "combo" ? 1 : result.opponentRouteCarry
      result.opponentRouteResource = llmDeckB.archetype === "support_engine" || llmDeckB.archetype === "control" ? 1 : result.opponentRouteResource
      result.opponentArchetypeSupportEngine = llmDeckB.archetype === "support_engine" ? 1 : result.opponentArchetypeSupportEngine
    }

    // Matchup analysis: use LLM advantage for delta features
    if (llmMatchup) {
      const winRateSignal = (llmMatchup.predictedWinRates.deckA - 0.5) * 2 // [-1, 1]
      result.matchupSetupSpeedDelta =
        (1 - w) * base.matchupSetupSpeedDelta + w * winRateSignal * 0.5
      result.matchupLongGameValueDelta =
        (1 - w) * base.matchupLongGameValueDelta + w * winRateSignal * 0.4
      result.matchupFinisherDensityDelta =
        (1 - w) * base.matchupFinisherDensityDelta + w * winRateSignal * 0.3

      const llmAdvantageA = llmMatchup.advantage.deckA / 10
      result.matchupPunishGreedySetupDelta =
        (1 - w) * base.matchupPunishGreedySetupDelta + w * llmAdvantageA * 0.3
      result.matchupDependencyPunishScore =
        (1 - w) * base.matchupDependencyPunishScore + w * Math.abs(llmAdvantageA) * 0.2
    }

    return result
  }
}
