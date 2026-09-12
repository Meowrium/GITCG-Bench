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

import { z } from "zod"

export const DeckAnalysisSchema = z.object({
  deckCode: z.string(),
  deckName: z.string().optional(),
  characters: z.array(z.string()),
  strength: z.number().min(0).max(10),
  archetype: z.string().optional(),
  planProfile: z.object({
    setupSpeed: z.number().min(0).max(1).optional(),
    tempoPush: z.number().min(0).max(1).optional(),
    longGameValue: z.number().min(0).max(1).optional(),
    defensiveStability: z.number().min(0).max(1).optional(),
    finisherDensity: z.number().min(0).max(1).optional(),
  }).optional(),
  winCondition: z.string(),
  gamePlan: z.object({
    earlyGame: z.string(),
    midGame: z.string(),
    lateGame: z.string(),
  }),
  keyCards: z.array(z.object({
    name: z.string(),
    importance: z.number().min(0).max(10),
    usage: z.string(),
  })).transform((cards) => {
    const seen = new Set<string>()
    return cards.filter((c) => {
      if (seen.has(c.name)) return false
      seen.add(c.name)
      return true
    })
  }),
  commonLines: z.array(z.object({
    sequence: z.array(z.string()),
    description: z.string(),
    winRateImpact: z.number().min(0).max(1).optional(),
  })),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  matchupNotes: z.record(z.string(), z.string()).optional(),
})

export type DeckAnalysis = z.infer<typeof DeckAnalysisSchema>

export const MatchupAnalysisSchema = z.object({
  deckA: z.string(),
  deckB: z.string(),
  advantage: z.object({
    deckA: z.number().min(-10).max(10),
    deckB: z.number().min(-10).max(10),
    reason: z.string(),
  }),
  keyInteractions: z.array(z.object({
    cardA: z.string(),
    cardB: z.string(),
    impact: z.string(),
  })),
  strategy: z.object({
    deckAPlaying: z.string(),
    deckBPlaying: z.string(),
  }),
  predictedWinRates: z.object({
    deckA: z.number().min(0).max(1),
    deckB: z.number().min(0).max(1),
  }).refine((value) => Math.abs(value.deckA + value.deckB - 1) < 0.05, {
    message: "predictedWinRates must sum to 1",
  }),
})

export type MatchupAnalysis = z.infer<typeof MatchupAnalysisSchema>

export interface DeckFeatureVector {
  deckCode: string
  strength: number
  winConditionEncoded: number
  keyCardCount: number
  commonLineCount: number
  averageCardImportance: number
  earlyGameScore: number
  midGameScore: number
  lateGameScore: number
  strengthScore: number
  weaknessCount: number
}

export interface MatchupFeatureVector {
  deckA: string
  deckB: string
  advantageA: number
  predictedWinRateA: number
  keyInteractionCount: number
}
