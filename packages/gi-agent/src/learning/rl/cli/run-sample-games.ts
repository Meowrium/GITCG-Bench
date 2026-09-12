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
 * Sample games from self-play RL captures and produce human-readable summaries.
 *
 * Usage:
 *   cd packages/gi-agent
 *   pnpm exec gnx src/learning/rl/cli/run-sample-games.ts <rl-dir> [options]
 *
 * Options:
 *   --sample <N>           Number of games to sample per matchup (default: 2)
 *   --output <file>        Write summary to file (default: stdout)
 *   --export-dir <dir>     Copy sampled .rl.json files to this directory
 *   --matchup <id>         Only sample from this matchup (can repeat)
 *   --verbose              Include full decision-point details
 */

import { parseArgs } from "node:util"
import { readdir, readFile, mkdir, copyFile } from "node:fs/promises"
import { join, resolve, basename } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "../../../../../assets-manager/src/index"
import type {
  SelfPlayRlGameCaptureV1,
  ObservationV1,
  DecisionPointV1,
  DecisionPointLogV1,
  ActionCandidateV1,
  CharacterObservationV1,
} from "@gi-tcg/ml/contracts"

// ======================== Formatters ========================

function charName(defId: number): string {
  return DEFAULT_ASSETS_MANAGER.getNameSync(defId) ?? `#${defId}`
}

function cardName(defId: number | null | undefined): string {
  if (defId == null) return "?"
  return DEFAULT_ASSETS_MANAGER.getNameSync(defId) ?? `#${defId}`
}

function formatWinner(winner: 0 | 1 | null): string {
  if (winner === 0) return "Player 0 (先手)"
  if (winner === 1) return "Player 1 (后手)"
  return "平局"
}

function formatHp(chars: CharacterObservationV1[]): string {
  return chars
    .map((c) => {
      const name = charName(c.definition_id)
      const active = c.is_active ? "*" : ""
      const alive = c.alive ? `${c.health}/${c.max_health}` : "KO"
      const energy = `E${c.energy}/${c.max_energy}`
      return `${active}${name}(${alive},${energy})`
    })
    .join(" ")
}

function formatDice(dice: { total_count: number; omni_count: number }): string {
  return `${dice.total_count}骰(${dice.omni_count}万能)`
}

function formatAction(candidate: ActionCandidateV1): string {
  const src = candidate.source_ref?.definition_id
    ? cardName(candidate.source_ref.definition_id)
    : null
  const tgt = candidate.target_ref?.definition_id
    ? cardName(candidate.target_ref.definition_id)
    : null

  let desc = candidate.action_case
  if (src) desc += ` [${src}]`
  if (tgt) desc += ` → ${tgt}`
  if (candidate.is_fast_action) desc += " (快速)"
  return desc
}

// ======================== Game Summary ========================

interface GameSummary {
  file: string
  matchupId: string
  gameId: string
  winner: 0 | 1 | null
  totalDecisions: [number, number]
  totalRounds: number
  characters: [string[], string[]]
  finalHp: [string, string]
  keyMoments: string[]
}

function summarizeGame(
  capture: SelfPlayRlGameCaptureV1,
  file: string,
  verbose: boolean,
): GameSummary {
  const [side0, side1] = capture.sides

  // Extract characters from first observation
  const firstObs0 = side0.observations[0]
  const firstObs1 = side1.observations[0]

  const chars0 = firstObs0
    ? firstObs0.self.characters.map((c) => charName(c.definition_id))
    : []
  const chars1 = firstObs1
    ? firstObs1.self.characters.map((c) => charName(c.definition_id))
    : []

  // Get max round number
  const allObs = [...side0.observations, ...side1.observations]
  const maxRound = Math.max(0, ...allObs.map((o) => o.point.round_number))

  // Get final board state from last observation
  const lastObs0 = side0.observations[side0.observations.length - 1]
  const lastObs1 = side1.observations[side1.observations.length - 1]

  const finalHp0 = lastObs0 ? formatHp(lastObs0.self.characters) : "N/A"
  const finalHp1 = lastObs1 ? formatHp(lastObs1.self.characters) : "N/A"

  // Extract key moments
  const keyMoments: string[] = []

  // Find KO events by scanning observations for health transitions
  for (const side of [side0, side1]) {
    const logs = side.decision_logs
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i]
      const obs = side.observations[Math.min(i, side.observations.length - 1)]
      if (!obs) continue

      // Check for choose_active (usually after KO)
      const dp = side.decision_points[i]
      if (dp?.pending_method === "chooseActive") {
        keyMoments.push(
          `R${obs.point.round_number} P${side.side}: 角色被击倒，需要切人`,
        )
      }

      // Track interesting high-score decisions in verbose mode
      if (verbose && log.candidate_scores.length > 0) {
        const maxScore = Math.max(...log.candidate_scores)
        const minScore = Math.min(...log.candidate_scores)
        if (maxScore - minScore > 5 && dp) {
          const selectedIdx = dp.candidates.findIndex(
            (c) => c.candidate_id === log.selected_candidate_id,
          )
          const selectedCandidate = dp.candidates[selectedIdx]
          if (selectedCandidate) {
            keyMoments.push(
              `R${obs.point.round_number} P${side.side}: ${formatAction(selectedCandidate)} (分差=${(maxScore - minScore).toFixed(1)})`,
            )
          }
        }
      }
    }
  }

  // Detect round-by-round action summary
  if (verbose) {
    for (let round = 1; round <= Math.min(maxRound, 3); round++) {
      for (const side of [side0, side1]) {
        const roundActions: string[] = []
        for (let i = 0; i < side.decision_points.length; i++) {
          const dp = side.decision_points[i]
          const obs =
            side.observations[Math.min(i, side.observations.length - 1)]
          if (!obs || obs.point.round_number !== round) continue
          if (dp.pending_method !== "action") continue

          const log = side.decision_logs[i]
          if (!log?.selected_candidate_id) continue
          const candidate = dp.candidates.find(
            (c) => c.candidate_id === log.selected_candidate_id,
          )
          if (candidate) {
            roundActions.push(formatAction(candidate))
          }
        }
        if (roundActions.length > 0) {
          keyMoments.push(
            `R${round} P${side.side}: ${roundActions.join(", ")}`,
          )
        }
      }
    }
  }

  return {
    file,
    matchupId: capture.matchup_id,
    gameId: capture.game_id,
    winner: capture.winner,
    totalDecisions: [side0.decision_points.length, side1.decision_points.length],
    totalRounds: maxRound,
    characters: [chars0, chars1],
    finalHp: [finalHp0, finalHp1],
    keyMoments,
  }
}

// ======================== Render ========================

function renderSummary(summary: GameSummary): string {
  const lines: string[] = []
  lines.push(`## ${summary.matchupId} — ${basename(summary.file)}`)
  lines.push("")
  lines.push(`- **胜者**: ${formatWinner(summary.winner)}`)
  lines.push(`- **回合数**: ${summary.totalRounds}`)
  lines.push(
    `- **决策点**: P0=${summary.totalDecisions[0]}, P1=${summary.totalDecisions[1]}`,
  )
  lines.push(`- **P0 阵容**: ${summary.characters[0].join(", ")}`)
  lines.push(`- **P1 阵容**: ${summary.characters[1].join(", ")}`)
  lines.push(`- **终局 P0**: ${summary.finalHp[0]}`)
  lines.push(`- **终局 P1**: ${summary.finalHp[1]}`)

  if (summary.keyMoments.length > 0) {
    lines.push("")
    lines.push("**关键时刻:**")
    for (const moment of summary.keyMoments.slice(0, 20)) {
      lines.push(`  - ${moment}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

function renderOverview(summaries: GameSummary[]): string {
  const lines: string[] = []
  lines.push("# 自对弈抽样摘要")
  lines.push("")
  lines.push(`共抽样 ${summaries.length} 局`)
  lines.push("")

  // Group by matchup
  const byMatchup = new Map<string, GameSummary[]>()
  for (const s of summaries) {
    const arr = byMatchup.get(s.matchupId) ?? []
    arr.push(s)
    byMatchup.set(s.matchupId, arr)
  }

  // Overview table
  lines.push("| 对局 | 抽样数 | P0胜 | P1胜 | 平均回合 |")
  lines.push("|------|--------|------|------|----------|")
  for (const [matchup, games] of byMatchup) {
    const p0w = games.filter((g) => g.winner === 0).length
    const p1w = games.filter((g) => g.winner === 1).length
    const avgRounds = (
      games.reduce((s, g) => s + g.totalRounds, 0) / games.length
    ).toFixed(1)
    lines.push(`| ${matchup} | ${games.length} | ${p0w} | ${p1w} | ${avgRounds} |`)
  }
  lines.push("")

  // Detailed per-game
  for (const s of summaries) {
    lines.push(renderSummary(s))
  }

  return lines.join("\n")
}

// ======================== Main ========================

async function listRlFiles(rlDir: string): Promise<Map<string, string[]>> {
  const matchups = new Map<string, string[]>()
  const entries = await readdir(rlDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const matchupDir = join(rlDir, entry.name)
    const files = await readdir(matchupDir)
    const rlFiles = files
      .filter((f) => f.endsWith(".rl.json"))
      .sort()
      .map((f) => join(matchupDir, f))
    if (rlFiles.length > 0) {
      matchups.set(entry.name, rlFiles)
    }
  }
  return matchups
}

function sampleN<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return [...arr]
  const copy = [...arr]
  const result: T[] = []
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length)
    result.push(copy[idx])
    copy.splice(idx, 1)
  }
  return result
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      sample: { type: "string", default: "2" },
      output: { type: "string", default: "" },
      "export-dir": { type: "string", default: "" },
      matchup: { type: "string", multiple: true },
      verbose: { type: "boolean", default: false },
    },
    strict: false,
    allowPositionals: true,
  })

  const rlDir = positionals[0]
  if (!rlDir) {
    console.error(
      "Usage: pnpm exec gnx src/learning/rl/cli/run-sample-games.ts <rl-dir> [--sample N] [--output file] [--export-dir dir] [--matchup id] [--verbose]",
    )
    process.exit(1)
  }

  const sampleCount = Number(values.sample ?? 2)
  const outputFile = values.output as string
  const exportDir = values["export-dir"] as string
  const matchupFilter = values.matchup as string[] | undefined
  const verbose = values.verbose as boolean

  console.error(`Scanning ${resolve(rlDir)}...`)
  const allFiles = await listRlFiles(resolve(rlDir))

  if (matchupFilter && matchupFilter.length > 0) {
    for (const key of [...allFiles.keys()]) {
      if (!matchupFilter.includes(key)) allFiles.delete(key)
    }
  }

  console.error(
    `Found ${allFiles.size} matchups, ${[...allFiles.values()].reduce((s, a) => s + a.length, 0)} games total`,
  )

  const summaries: GameSummary[] = []
  const sampledPaths: string[] = []

  for (const [matchupId, files] of allFiles) {
    const sampled = sampleN(files, sampleCount)
    console.error(
      `  ${matchupId}: ${files.length} games, sampling ${sampled.length}`,
    )

    for (const filePath of sampled) {
      try {
        const raw = await readFile(filePath, "utf8")
        const capture = JSON.parse(raw) as SelfPlayRlGameCaptureV1
        const summary = summarizeGame(capture, filePath, verbose)
        summaries.push(summary)
        sampledPaths.push(filePath)
      } catch (e) {
        console.error(`  Warning: failed to parse ${filePath}: ${e}`)
      }
    }
  }

  const report = renderOverview(summaries)

  if (outputFile) {
    const { writeFile: wf } = await import("node:fs/promises")
    await wf(resolve(outputFile), report, "utf8")
    console.error(`Report written to ${outputFile}`)
  } else {
    console.log(report)
  }

  if (exportDir) {
    await mkdir(resolve(exportDir), { recursive: true })
    for (const src of sampledPaths) {
      const dest = join(resolve(exportDir), basename(src))
      await copyFile(src, dest)
    }
    console.error(
      `Exported ${sampledPaths.length} .rl.json files to ${exportDir}`,
    )
  }
}

main().catch((e) => {
  console.error("run-sample-games fatal:", e)
  process.exit(1)
})
