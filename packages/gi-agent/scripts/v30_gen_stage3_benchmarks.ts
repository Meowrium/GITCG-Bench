/**
 * V30 Stage 3 — Generate benchmark configs from the 8 canonical decks.
 *
 * Produces an 8×8 ordered round-robin (64 matchups including 8 mirrors), so
 * the encoder sees diverse trajectories instead of repeating one mirror over
 * and over. Total games per profile:
 *   - smoke (32 games / pair) → 2048 games total
 *   - full  (80 games / pair) → 5120 games total
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const DECKS = [
  { name: "水八", id: "shuiba",  code: "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA" },
  { name: "神宵", id: "shenxiao",code: "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA" },
  { name: "水凝", id: "shuining",code: "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA" },
  { name: "雷鹤", id: "leihe",   code: "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA" },
  { name: "雷狼", id: "leilang", code: "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA" },
  { name: "莫优", id: "moyou",   code: "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA" },
  { name: "红牛", id: "hongniu", code: "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA" },
  { name: "水债", id: "shuizhai",code: "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA" },
] as const

interface Profile {
  fileName: string
  gamesPerPair: number
  doc: string
}

const PROFILES: Profile[] = [
  {
    fileName: "benchmark.v30-stage3-2k.json",
    gamesPerPair: 32,
    doc: "V30 Stage 3 SMOKE — 8x8 round-robin × 32 games = 2048 games. ~1.5h on Win native, ~160k samples. Use to diagnose overfitting before committing to 5k.",
  },
  {
    fileName: "benchmark.v30-stage3-5k.json",
    gamesPerPair: 80,
    doc: "V30 Stage 3 FULL — 8x8 round-robin × 80 games = 5120 games. ~4h on Win native, ~400k samples. KPI-B target sample size per V30 §20.6.",
  },
]

function buildBenchmark(profile: Profile): unknown {
  const matchups: unknown[] = []
  for (let i = 0; i < DECKS.length; i++) {
    for (let j = 0; j < DECKS.length; j++) {
      const a = DECKS[i]
      const b = DECKS[j]
      const id = i === j ? `${a.id}-mirror` : `${a.id}-vs-${b.id}`
      matchups.push({
        id,
        deck0Name: a.name,
        deck1Name: b.name,
        deck0: a.code,
        deck1: b.code,
        games: profile.gamesPerPair,
        sideA: { name: "baseline-a", kind: "baseline", options: { endTurnPenalty: 5 } },
        sideB: { name: "baseline-b", kind: "baseline", options: { endTurnPenalty: 5 } },
      })
    }
  }
  return {
    _doc: profile.doc,
    version: "v6.3.0",
    matchups,
  }
}

const outDir = resolve(import.meta.dirname, "..", "examples", "configs")
mkdirSync(outDir, { recursive: true })

for (const p of PROFILES) {
  const path = resolve(outDir, p.fileName)
  const data = buildBenchmark(p)
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8")
  console.log(`wrote ${path}`)
}
