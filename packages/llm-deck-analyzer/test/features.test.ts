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
import {
  DeckFeaturesV2Schema,
  MatchupFeaturesV2Schema,
  extractDeckFeaturesV2,
  extractMatchupFeaturesV2,
} from "../src/index"

const DECK_A = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"
const DECK_B = "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA"

test("extractDeckFeaturesV2 returns schema-valid layered features", async () => {
  const features = await extractDeckFeaturesV2(DECK_A)
  const parsed = DeckFeaturesV2Schema.parse(features)

  expect(parsed.version).toBe("v2")
  expect(parsed.dense.characterCount).toBe(3)
  expect(parsed.sparse.length).toBeGreaterThan(20)
  expect(parsed.actionCards.functionTags.length).toBeGreaterThan(0)
  expect(parsed.graph.nodes.length).toBeGreaterThan(0)
  expect(parsed.graph.edges.length).toBeGreaterThan(0)
})

test("extractMatchupFeaturesV2 returns schema-valid cross features", async () => {
  const features = await extractMatchupFeaturesV2(DECK_A, DECK_B)
  const parsed = MatchupFeaturesV2Schema.parse(features)

  expect(parsed.version).toBe("v2")
  expect(parsed.sparse.length).toBeGreaterThan(10)
  expect(parsed.labels.routeConflicts.length).toBeGreaterThan(0)
  expect(parsed.graph.nodes.length).toBeGreaterThan(0)
  expect(parsed.graph.edges.length).toBeGreaterThan(0)
  expect(parsed.diagnostics.coverage.matchupCrossCoverage).toBeGreaterThan(0)
})
