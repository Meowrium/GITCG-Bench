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

import { expect, test } from "vitest"
import { DeckAnalyzer, decodeDeck } from "../src/index"

const DECK_A = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"
const DECK_B = "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"

test("decodeDeck returns character and card names", () => {
  const deck = decodeDeck(DECK_A)

  expect(deck.characters.length).toBe(3)
  expect(deck.cards.length).toBe(30)
  expect(deck.characters[0]).toBeString()
  expect(deck.cards[0]).toBeString()
})

test("analyzeDeck returns heuristic baseline analysis", async () => {
  const analyzer = new DeckAnalyzer()
  const result = await analyzer.analyzeDeck(DECK_A, "sample")

  expect(result.deckCode).toBe(DECK_A)
  expect(result.deckName).toBe("sample")
  expect(result.characters.length).toBe(3)
  expect(result.keyCards.length).toBeGreaterThan(0)
  expect(result.commonLines.length).toBeGreaterThan(0)
  expect(result.strength).toBeGreaterThanOrEqual(0)
  expect(result.strength).toBeLessThanOrEqual(10)
})

test("analyzeMatchup returns normalized win rates", async () => {
  const analyzer = new DeckAnalyzer()
  const result = await analyzer.analyzeMatchup(DECK_A, DECK_B)

  expect(result.deckA).toBe(DECK_A)
  expect(result.deckB).toBe(DECK_B)
  expect(result.predictedWinRates.deckA + result.predictedWinRates.deckB).toBeCloseTo(1, 5)
  expect(result.keyInteractions.length).toBeGreaterThan(0)
})
