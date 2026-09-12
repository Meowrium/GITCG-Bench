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
  policyKind: "baseline" | "evaluator"
  weightsPath: string
  endTurnPenalty: number
  learnedScoreScale: number
  priorMode: string
  includeMirrors: number
  includeReverse: number
  benchmarkGames: number
  branchSampleCount: number
  branchMinLegalActions: number
  branchMaxBranches: number
  branchContinuationGames: number
  benchmarkConfigPath: string
  matchupManifestPath: string
  branchConfigDir: string
  replaySamplesDir: string
  branchEvalOutputDir: string
  pipelineOutputDir: string
}

const trioDeckPath = settings.trioDeckPath
const benchmarkConfigPath = settings.benchmarkConfigPath
const matchupManifestPath = settings.matchupManifestPath
const branchConfigDir = settings.branchConfigDir
const replaySamplesDir = settings.replaySamplesDir
const branchEvalOutputDir = settings.branchEvalOutputDir
const pipelineOutputDir = settings.pipelineOutputDir

mkdirSync(branchConfigDir, { recursive: true })
mkdirSync(branchEvalOutputDir, { recursive: true })
mkdirSync(pipelineOutputDir, { recursive: true })

const includeMirrors = settings.includeMirrors === 1
const includeReverse = settings.includeReverse === 1
const benchmarkGames = settings.benchmarkGames
const policyKind = settings.policyKind
const weightsPath = settings.weightsPath
const endTurnPenalty = settings.endTurnPenalty
const learnedScoreScale = settings.learnedScoreScale
const priorMode = settings.priorMode
const branchSampleCount = settings.branchSampleCount
const branchMinLegalActions = settings.branchMinLegalActions
const branchMaxBranches = settings.branchMaxBranches
const branchContinuationGames = settings.branchContinuationGames

interface TrioDeckEntry {
  ordinal: string
  id: string
  deckCode: string
}

const decks = readFileSync(trioDeckPath, "utf8")
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

if (decks.length !== 3) {
  throw new Error(`Expected 3 decks in trio_deck.txt, got ${decks.length}`)
}

function buildPolicyConfig(sideLabel: string) {
  if (policyKind === "baseline") {
    return {
      name: `baseline-${sideLabel}`,
      kind: "baseline",
      options: {
        endTurnPenalty,
      },
    }
  }

  return {
    name: `evaluator-${sideLabel}`,
    kind: "evaluator",
    weightsPath,
    options: {
      learnedScoreScale,
      priorMode,
    },
  }
}

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
    matchups.push({
      id: matchupId,
      deck0,
      deck1,
    })
    if (includeReverse && !same) {
      matchups.push({
        id: `${deck1.id}-vs-${deck0.id}`,
        deck0: deck1,
        deck1: deck0,
      })
    }
  }
}

const benchmarkConfig = {
  version: "v6.3.0",
  matchups: matchups.map((matchup) => ({
    id: matchup.id,
    deck0Name: matchup.deck0.id,
    deck1Name: matchup.deck1.id,
    deck0: matchup.deck0.deckCode,
    deck1: matchup.deck1.deckCode,
    games: benchmarkGames,
    sideA: buildPolicyConfig("a"),
    sideB: buildPolicyConfig("b"),
  })),
}

writeFileSync(benchmarkConfigPath, `${JSON.stringify(benchmarkConfig, null, 2)}\n`, "utf8")

const manifestLines = [
  [
    "matchup_id",
    "branch_config_path",
    "branch_output_path",
    "dataset_output_path",
    "artifact_output_path",
    "evaluation_output_path",
  ].join("\t"),
]

for (const matchup of matchups) {
  const branchConfigPath = `${branchConfigDir}/${matchup.id}.json`
  const branchOutputPath = `${branchEvalOutputDir}/${matchup.id}.json`
  const datasetOutputPath = `${pipelineOutputDir}/${matchup.id}.dataset.json`
  const artifactOutputPath = `${pipelineOutputDir}/${matchup.id}.artifact.json`
  const evaluationOutputPath = `${pipelineOutputDir}/${matchup.id}.evaluation.json`

  const branchConfig = {
    benchmarkPath: benchmarkConfigPath,
    matchupId: matchup.id,
    replayDir: `${replaySamplesDir}/${matchup.id}`,
    sampleCount: branchSampleCount,
    minLegalActions: branchMinLegalActions,
    maxBranchesPerPoint: branchMaxBranches,
    continuationGamesPerBranch: branchContinuationGames,
    outputPath: branchOutputPath,
  }

  writeFileSync(branchConfigPath, `${JSON.stringify(branchConfig, null, 2)}\n`, "utf8")
  manifestLines.push([
    matchup.id,
    branchConfigPath,
    branchOutputPath,
    datasetOutputPath,
    artifactOutputPath,
    evaluationOutputPath,
  ].join("\t"))
}

writeFileSync(matchupManifestPath, `${manifestLines.join("\n")}\n`, "utf8")
