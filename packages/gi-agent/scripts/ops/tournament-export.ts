// Copyright (C) 2026 Piovium Labs
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
 * tournament-export — battles summary → tree-bench results 双视角（impl-spec-1 §4.4）。
 * 纯函数（可单测）；文件写出由 model-tournament 的 export 子命令承担。
 *
 * winner 映射（关键）：引擎 perGame.winner 是玩家位 0|1|null；plan 侧选手 = p1；
 * 相对胜负按 perGame.planSide 换算——winner === planSide → "p1"（plan 侧胜）、
 * winner 另一位 → "p2"、null → "draw"。tree-bench parseGameResult 对其他值 fail-fast。
 *
 * results 视角：
 * - by-model：p1/p2 = `<model>@r<n>`（选手 id）；
 * - by-model-deck：p1/p2 = `<model>@<env>/<di>@r<n>`（卡组级 id）；
 * - mirror-only 变体：同一批对局过滤 di === dj。
 */

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { parsePairDir, parseCellDir, parsePlayerId } from "./tournament-config.js"

export interface ResultRow {
  p1: string
  p2: string
  winner: "p1" | "p2" | "draw"
  period: number
}

export interface ResultsViews {
  byModel: ResultRow[]
  byModelDeck: ResultRow[]
  byModelMirror: ResultRow[]
  byModelDeckMirror: ResultRow[]
}

/** 引擎玩家位 → 相对 p1（= plan 侧选手）的胜负 */
export function mapWinner(winner: 0 | 1 | null, planSide: 0 | 1): "p1" | "p2" | "draw" {
  if (winner === null) return "draw"
  return winner === planSide ? "p1" : "p2"
}

/** 扫描 battles 目录树 → 双视角 results 行（p1===p2 抛错——同选手对局不合法） */
export async function collectResults(battlesRoot: string, knownEnvLabels: ReadonlyArray<string>): Promise<ResultsViews> {
  const byModel: ResultRow[] = []
  const byModelDeck: ResultRow[] = []
  const byModelMirror: ResultRow[] = []
  const byModelDeckMirror: ResultRow[] = []
  let pairNames: string[] = []
  try {
    pairNames = (await readdir(battlesRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { byModel, byModelDeck, byModelMirror, byModelDeckMirror }
  }
  for (const pairName of pairNames) {
    const pair = parsePairDir(pairName)
    if (!pair) continue
    const planP = parsePlayerId(pair.planPlayerId)
    const oppP = parsePlayerId(pair.oppPlayerId)
    if (!planP || !oppP) continue
    const envRoot = join(battlesRoot, pairName)
    let envLabels: string[] = []
    try {
      envLabels = (await readdir(envRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const envLabel of envLabels) {
      if (!knownEnvLabels.includes(envLabel)) continue
      let cellNames: string[] = []
      try {
        cellNames = (await readdir(join(envRoot, envLabel), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        continue
      }
      for (const cellName of cellNames) {
        const cell = parseCellDir(cellName)
        if (!cell) continue
        const summaryPath = join(envRoot, envLabel, cellName, "summary.json")
        if (!existsSync(summaryPath)) continue
        const summary = JSON.parse(await readFile(summaryPath, "utf-8")) as {
          perGame?: Array<{ seed: number; planSide: 0 | 1; winner: 0 | 1 | null }>
        }
        for (const g of summary.perGame ?? []) {
          const winner = mapWinner(g.winner, g.planSide)
          if (pair.planPlayerId === pair.oppPlayerId) {
            throw new Error(`export：p1===p2（${pair.planPlayerId}，${pairName}/${envLabel}/${cellName}）——同选手对局不合法`)
          }
          byModel.push({ p1: pair.planPlayerId, p2: pair.oppPlayerId, winner, period: planP.round })
          const p1Deck = `${planP.model}@${envLabel}/${cell.di}@r${planP.round}`
          const p2Deck = `${oppP.model}@${envLabel}/${cell.dj}@r${oppP.round}`
          if (p1Deck === p2Deck) {
            throw new Error(`export：卡组级 p1===p2（${p1Deck}，${pairName}/${envLabel}/${cellName}）——不合法`)
          }
          byModelDeck.push({ p1: p1Deck, p2: p2Deck, winner, period: planP.round })
          if (cell.di === cell.dj) {
            byModelMirror.push({ p1: pair.planPlayerId, p2: pair.oppPlayerId, winner, period: planP.round })
            byModelDeckMirror.push({ p1: p1Deck, p2: p2Deck, winner, period: planP.round })
          }
        }
      }
    }
  }
  return { byModel, byModelDeck, byModelMirror, byModelDeckMirror }
}
