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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const settingsPath = process.argv[2]
if (!settingsPath) {
  throw new Error("settings path is required")
}

const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
  trioDeckPath: string
  rankerArtifactPath: string
  conceptModelPath: string
  includeMirrors: number
  includeReverse: number
  matchupFilterRegex: string
  benchmarkGames: number
  benchmarkConfigPath: string
  replaySamplesDir: string
  endTurnPenalty: number
  useBaselineTieBreaker: number
}

interface TrioDeckEntry {
  ordinal: string
  id: string
  deckCode: string
}

const decks = readFileSync(settings.trioDeckPath, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => {
    const match = line.match(/^(\d+)\s+(\S+)\s+(\S+)$/)
    if (!match) {
      throw new Error(`Invalid trio deck line: ${line}`)
    }
    return {
      ordinal: match[1]!,
      id: match[2]!,
      deckCode: match[3]!,
    } satisfies TrioDeckEntry
  })

const matcher = new RegExp(settings.matchupFilterRegex)
const includeMirrors = settings.includeMirrors === 1
const includeReverse = settings.includeReverse === 1

const matchups: Array<{
  id: string
  deck0: TrioDeckEntry
  deck1: TrioDeckEntry
}> = []

for (let i = 0; i < decks.length; i += 1) {
  const deck0 = decks[i]!
  const start = includeMirrors ? i : i + 1
  for (let j = start; j < decks.length; j += 1) {
    const deck1 = decks[j]!
    const same = i === j
    const matchupId = same
      ? `${deck0.id}-mirror`
      : `${deck0.id}-vs-${deck1.id}`
    if (matcher.test(matchupId)) {
      matchups.push({ id: matchupId, deck0, deck1 })
    }
    if (includeReverse && !same) {
      const reverseId = `${deck1.id}-vs-${deck0.id}`
      if (matcher.test(reverseId)) {
        matchups.push({ id: reverseId, deck0: deck1, deck1: deck0 })
      }
    }
  }
}

mkdirSync(settings.replaySamplesDir, { recursive: true })

const benchmarkConfig = {
  version: "v6.3.0",
  matchups: matchups.flatMap((matchup) => [
    {
      id: `${matchup.id}::A-baseline::B-gi-ml`,
      deck0Name: matchup.deck0.id,
      deck1Name: matchup.deck1.id,
      deck0: matchup.deck0.deckCode,
      deck1: matchup.deck1.deckCode,
      games: settings.benchmarkGames,
      sideA: {
        name: "baseline-a",
        kind: "baseline",
        options: {
          endTurnPenalty: settings.endTurnPenalty,
        },
      },
      sideB: {
        name: "gi-ml-b",
        kind: "gi-ml-runtime",
        rankerArtifactPath: settings.rankerArtifactPath,
        conceptModelPath: settings.conceptModelPath,
        options: {
          endTurnPenalty: settings.endTurnPenalty,
          useBaselineTieBreaker: settings.useBaselineTieBreaker === 1,
        },
      },
    },
    {
      id: `${matchup.id}::A-gi-ml::B-baseline`,
      deck0Name: matchup.deck0.id,
      deck1Name: matchup.deck1.id,
      deck0: matchup.deck0.deckCode,
      deck1: matchup.deck1.deckCode,
      games: settings.benchmarkGames,
      sideA: {
        name: "gi-ml-a",
        kind: "gi-ml-runtime",
        rankerArtifactPath: settings.rankerArtifactPath,
        conceptModelPath: settings.conceptModelPath,
        options: {
          endTurnPenalty: settings.endTurnPenalty,
          useBaselineTieBreaker: settings.useBaselineTieBreaker === 1,
        },
      },
      sideB: {
        name: "baseline-b",
        kind: "baseline",
        options: {
          endTurnPenalty: settings.endTurnPenalty,
        },
      },
    },
  ]),
}

writeFileSync(settings.benchmarkConfigPath, `${JSON.stringify(benchmarkConfig, null, 2)}\n`, "utf8")
