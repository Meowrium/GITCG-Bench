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

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"

// ── Types ──

interface MulliganGameRecord {
  matchupId: string
  gameIndex: number
  winner: 0 | 1 | null
  decks: number[][] // [side0 chars, side1 chars]
  side0: { handDefIds: number[]; keptDefIds: number[]; replacedDefIds: number[] }
  side1: { handDefIds: number[]; keptDefIds: number[]; replacedDefIds: number[] }
}

interface CardStats {
  keepWins: number
  keepTotal: number
  keepWinrate: number
  replaceWins: number
  replaceTotal: number
  replaceWinrate: number
  /** winrate delta: keep_winrate - replace_winrate (positive = keep is better) */
  delta: number
  /** whether we have enough data to be confident */
  confident: boolean
}

interface ComboStats {
  cardIds: [number, number]
  jointKeepWins: number
  jointKeepTotal: number
  jointWinrate: number
  /** product of individual keep winrates */
  expectedProduct: number
  /** synergy: jointWinrate - expectedProduct */
  synergy: number
  confident: boolean
}

interface DeckPriors {
  deckChars: number[]
  cards: Record<number, CardStats>
  combos: ComboStats[]
}

interface MulliganPriors {
  version: 1
  /** Minimum samples required per card for confidence */
  minSamples: number
  /** How much delta must exceed 0 to flag confident */
  minDelta: number
  perDeck: Record<string, DeckPriors>
}

// ── Config ──

const MIN_KEEP_SAMPLES = 5
const MIN_REPLACE_SAMPLES = 3
const MIN_DELTA_FOR_CONFIDENCE = 0.05

// ── Helpers ──

function deckHash(chars: number[]): string {
  return [...chars].sort((a, b) => a - b).join(",")
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

function safeWinrate(wins: number, total: number): number {
  if (total === 0) return 0
  return clamp(wins / total, 0, 1)
}

// ── Accumulators ──

interface DeckAccumulator {
  deckChars: number[]
  /** per cardDefId -> { keepWins, keepTotal, replaceWins, replaceTotal } */
  cards: Record<number, { keepWins: number; keepTotal: number; replaceWins: number; replaceTotal: number }>
  /** per combo (sorted pair string) -> { jointKeepWins, jointKeepTotal } */
  combos: Record<string, { jointKeepWins: number; jointKeepTotal: number }>
}

// ── Main ──

async function computePriors(inputDir: string, outputPath: string): Promise<void> {
  const entries = await readdir(inputDir)
  const jsonFiles = entries.filter(f => f.startsWith("mulligan-") && f.endsWith(".json"))

  if (jsonFiles.length === 0) {
    console.warn(`No mulligan-*.json files found in ${inputDir}`)
    await mkdir(inputDir, { recursive: true })
    return
  }

  const decks = new Map<string, DeckAccumulator>()

  for (const file of jsonFiles) {
    const filePath = join(inputDir, file)
    let record: MulliganGameRecord
    try {
      const raw = await readFile(filePath, "utf-8")
      record = JSON.parse(raw)
    } catch (err) {
      console.warn(`Skipping invalid file: ${file} - ${(err as Error).message}`)
      continue
    }

    if (record.winner == null) continue // draw

    const sides: Array<{
      sideIdx: 0 | 1
      keptDefIds: number[]
      replacedDefIds: number[]
      deckChars: number[]
    }> = [
      { sideIdx: 0, keptDefIds: record.side0.keptDefIds, replacedDefIds: record.side0.replacedDefIds, deckChars: record.decks[0] ?? [] },
      { sideIdx: 1, keptDefIds: record.side1.keptDefIds, replacedDefIds: record.side1.replacedDefIds, deckChars: record.decks[1] ?? [] },
    ]

    for (const side of sides) {
      if (side.deckChars.length === 0) continue
      const hash = deckHash(side.deckChars)
      const won = record.winner === side.sideIdx

      let acc = decks.get(hash)
      if (!acc) {
        acc = { deckChars: side.deckChars, cards: {}, combos: {} }
        decks.set(hash, acc)
      }

      // Per-card: kept cards count as "keep" samples, replaced as "replace"
      const keptSet = new Set(side.keptDefIds)
      const allDefIds = new Set([...side.keptDefIds, ...side.replacedDefIds])

      for (const defId of allDefIds) {
        let c = acc.cards[defId]
        if (!c) {
          c = { keepWins: 0, keepTotal: 0, replaceWins: 0, replaceTotal: 0 }
          acc.cards[defId] = c
        }
        if (keptSet.has(defId)) {
          c.keepTotal += 1
          if (won) c.keepWins += 1
        } else {
          c.replaceTotal += 1
          if (won) c.replaceWins += 1
        }
      }

      // Cross-effects: for cards kept together, record joint stats
      if (side.keptDefIds.length >= 2) {
        for (let i = 0; i < side.keptDefIds.length; i++) {
          for (let j = i + 1; j < side.keptDefIds.length; j++) {
            const pair = [side.keptDefIds[i], side.keptDefIds[j]].sort((a, b) => a - b)
            const comboKey = `${pair[0]}_${pair[1]}`
            let cb = acc.combos[comboKey]
            if (!cb) {
              cb = { jointKeepWins: 0, jointKeepTotal: 0 }
              acc.combos[comboKey] = cb
            }
            cb.jointKeepTotal += 1
            if (won) cb.jointKeepWins += 1
          }
        }
      }
    }
  }

  // Convert accumulators to priors
  const perDeck: Record<string, DeckPriors> = {}
  for (const [hash, acc] of decks) {
    const cards: Record<number, CardStats> = {}
    for (const [defIdStr, c] of Object.entries(acc.cards)) {
      const defId = Number(defIdStr)
      const keepWinrate = safeWinrate(c.keepWins, c.keepTotal)
      const replaceWinrate = safeWinrate(c.replaceWins, c.replaceTotal)
      const delta = keepWinrate - replaceWinrate
      cards[defId] = {
        keepWins: c.keepWins,
        keepTotal: c.keepTotal,
        keepWinrate,
        replaceWins: c.replaceWins,
        replaceTotal: c.replaceTotal,
        replaceWinrate,
        delta,
        confident: c.keepTotal >= MIN_KEEP_SAMPLES && c.replaceTotal >= MIN_REPLACE_SAMPLES && delta >= MIN_DELTA_FOR_CONFIDENCE,
      }
    }

    // Combos: compute synergy
    const combos: ComboStats[] = []
    for (const [comboKey, cb] of Object.entries(acc.combos)) {
      const [a, b] = comboKey.split("_").map(Number) as [number, number]
      const cardA = cards[a]
      const cardB = cards[b]
      if (!cardA || !cardB) continue

      const jointWinrate = safeWinrate(cb.jointKeepWins, cb.jointKeepTotal)
      const expectedProduct = cardA.keepWinrate * cardB.keepWinrate
      const synergy = jointWinrate - expectedProduct

      combos.push({
        cardIds: [a, b],
        jointKeepWins: cb.jointKeepWins,
        jointKeepTotal: cb.jointKeepTotal,
        jointWinrate,
        expectedProduct,
        synergy,
        confident: cb.jointKeepTotal >= MIN_KEEP_SAMPLES && synergy >= MIN_DELTA_FOR_CONFIDENCE,
      })
    }

    // Sort combos by synergy descending
    combos.sort((a, b) => b.synergy - a.synergy)

    perDeck[hash] = { deckChars: acc.deckChars, cards, combos }
  }

  const priors: MulliganPriors = {
    version: 1,
    minSamples: MIN_KEEP_SAMPLES,
    minDelta: MIN_DELTA_FOR_CONFIDENCE,
    perDeck,
  }

  await mkdir(join(outputPath, ".."), { recursive: true })
  await writeFile(outputPath, JSON.stringify(priors, null, 2))
  console.log(`Mulligan priors written: ${outputPath}`)
  console.log(`  Decks: ${Object.keys(perDeck).length}`)
  console.log(`  Games: ${jsonFiles.length}`)
}

// ── CLI ──

const args = process.argv.slice(2)
const inputDir = args[0]
const outputPath = args[1] ?? join(inputDir, "mulligan-priors.json")

if (!inputDir) {
  console.error("Usage: pnpm exec gnx compute-mulligan-priors.ts <mulligan-dir> [output.json]")
  process.exit(1)
}

computePriors(inputDir, outputPath).catch((err) => {
  console.error(err)
  process.exit(1)
})
