/**
 * V30 §22 — Generate bidirectional alpha-mix benchmarks.
 *
 * For each of 8 canonical decks (mirror only — same deck on both sides),
 * generates TWO matchups so we test both sides:
 *   - <deck>-mirror-A: neural on sideA (P0), baseline on sideB (P1)
 *   - <deck>-mirror-B: baseline on sideA (P0), neural on sideB (P1)
 *
 * This isolates side-of-table bias from the encoder's effect: WR(neural)
 * across 8 decks × 2 sides should converge to a single number with much
 * smaller variance than a single side.
 *
 * Also generates a baseline-vs-baseline noise floor benchmark with the
 * same per-pair game count.
 *
 * Profiles:
 *   small:  32 games / matchup → alpha-mix 512 games, baseline 256
 *   medium: 64 games / matchup → alpha-mix 1024 games, baseline 512
 *
 * Usage:
 *   pnpm exec gnx scripts/v30_gen_alpha_benchmarks.ts <alpha> <profile>
 *   e.g. pnpm exec gnx scripts/v30_gen_alpha_benchmarks.ts 0.1 small
 *
 * Outputs:
 *   examples/configs/benchmark.v30-stage3-alpha<α>-bidir-<profile>.json
 *   examples/configs/benchmark.v30-stage3-baseline-noise-<profile>.json
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const DECKS = [
  { name: "水八", id: "shuiba",  code: "A0BQ9CEPA1Bw9ZUPCWCw+MIPDIBg/cYQDCGQCskQDaEQC9EQDbEgDt0QD+EQD/IQD/AA" },
  { name: "神宵", id: "shenxiao",code: "AABQ7xUOAPBw9JcPCUBw9b0PDFCg9soQDTFgA9YQDbGQC9kQDcGwDN8QDeHwEOARDgAA" },
  // 水凝 (shuining) excluded — baseline-vs-baseline mirror produces ~73% draws
  // (47/64 in V30 §22 noise floor), an intrinsic baseline-policy stalemate
  // that masks the encoder's contribution. Re-include after baseline policy
  // declareEnd handling fixed.
  // { name: "水凝", id: "shuining",code: "ABDQ4SoOACCQ4noPB0Cg9J0PCWDQ+cIPDNAg/sYQDKFgC8kQDLGQDtEQDeEQD9oQDvAA" },
  { name: "雷鹤", id: "leihe",   code: "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA" },
  { name: "雷狼", id: "leilang", code: "AbDg5QQOAVCw5pcPCUBw9MIPDFAg9sYQDCFgA8kQDDGQDMoQDMGgDdEQDdEQENYRDQAA" },
  { name: "莫优", id: "moyou",   code: "AhCQ3QsPACBg9IYPCUBw9ZgPCVCA9r0PDGAg+cIPDJFgAskQDKGQC8oQDLGgDNEQDcAA" },
  { name: "红牛", id: "hongniu", code: "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA" },
  { name: "水债", id: "shuizhai",code: "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA" },
] as const

const PROFILES = {
  small:  32,
  medium: 64,
  large:  128,
} as const

interface Args {
  alpha: number
  profile: keyof typeof PROFILES
  scoreScale: number
}

function parseArgs(argv: string[]): Args {
  const alpha = Number(argv[0] ?? "0.1")
  const profile = (argv[1] ?? "small") as keyof typeof PROFILES
  const scoreScale = Number(argv[2] ?? "4")
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
    throw new Error(`Invalid alpha: ${alpha}`)
  }
  if (!(profile in PROFILES)) {
    throw new Error(`Invalid profile '${profile}'. Use: small | medium | large`)
  }
  if (!Number.isFinite(scoreScale) || scoreScale <= 0) {
    throw new Error(`Invalid scoreScale: ${scoreScale}`)
  }
  return { alpha, profile, scoreScale }
}

function generateAlphaMixConfig(alpha: number, gamesPerMatchup: number, scoreScale: number): unknown {
  const matchups: unknown[] = []
  const neuralCfg = (label: string) => ({
    name: `neural-α${alpha}-s${scoreScale}`,
    kind: "neural-evaluator",
    weightsPath: "../output/v30-kpib/weights.ext.json",
    encoderWeightsPath: "../output/v30-stage3-2k/encoder-weights.json",
    neuralAlpha: alpha,
    neuralScoreScale: scoreScale,
    options: { explorationStrategy: "off", endTurnPenalty: 5 },
  })
  const baselineCfg = {
    name: "baseline",
    kind: "baseline",
    options: { endTurnPenalty: 5 },
  }
  for (const d of DECKS) {
    // Direction A: neural sideA (P0)
    matchups.push({
      id: `${d.id}-mirror-neuralP0`,
      deck0Name: d.name,
      deck1Name: d.name,
      deck0: d.code,
      deck1: d.code,
      games: gamesPerMatchup,
      sideA: neuralCfg(`${d.id}-A`),
      sideB: baselineCfg,
    })
    // Direction B: neural sideB (P1)
    matchups.push({
      id: `${d.id}-mirror-neuralP1`,
      deck0Name: d.name,
      deck1Name: d.name,
      deck0: d.code,
      deck1: d.code,
      games: gamesPerMatchup,
      sideA: baselineCfg,
      sideB: neuralCfg(`${d.id}-B`),
    })
  }
  const totalGames = matchups.length * gamesPerMatchup
  return {
    _doc: `V30 §22 alpha-mix bidirectional. α=${alpha}. ${matchups.length} matchups × ${gamesPerMatchup} games = ${totalGames} games. Mirror only; neural plays both P0 and P1 sides.`,
    version: "v6.3.0",
    matchups,
  }
}

function generateBaselineNoiseConfig(gamesPerMatchup: number): unknown {
  const matchups: unknown[] = []
  for (const d of DECKS) {
    matchups.push({
      id: `${d.id}-mirror`,
      deck0Name: d.name,
      deck1Name: d.name,
      deck0: d.code,
      deck1: d.code,
      games: gamesPerMatchup,
      sideA: { name: "baseline-a", kind: "baseline", options: { endTurnPenalty: 5 } },
      sideB: { name: "baseline-b", kind: "baseline", options: { endTurnPenalty: 5 } },
    })
  }
  const totalGames = matchups.length * gamesPerMatchup
  return {
    _doc: `V30 §22 baseline noise floor. ${matchups.length} matchups × ${gamesPerMatchup} games = ${totalGames} games. Mirror only; baseline both sides.`,
    version: "v6.3.0",
    matchups,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const games = PROFILES[args.profile]
  const outDir = resolve(import.meta.dirname, "..", "examples", "configs")
  mkdirSync(outDir, { recursive: true })

  const scaleSuffix = args.scoreScale === 4 ? "" : `-s${args.scoreScale}`
  const alphaPath = resolve(
    outDir,
    `benchmark.v30-stage3-alpha${args.alpha}${scaleSuffix}-bidir-${args.profile}.json`,
  )
  const noisePath = resolve(
    outDir,
    `benchmark.v30-stage3-baseline-noise-${args.profile}.json`,
  )

  writeFileSync(
    alphaPath,
    `${JSON.stringify(generateAlphaMixConfig(args.alpha, games, args.scoreScale), null, 2)}\n`,
    "utf8",
  )
  writeFileSync(
    noisePath,
    `${JSON.stringify(generateBaselineNoiseConfig(games), null, 2)}\n`,
    "utf8",
  )

  const nDecks = DECKS.length
  const totalAlpha = nDecks * 2 * games
  const totalBaseline = nDecks * games
  console.log(`wrote ${alphaPath}`)
  console.log(`wrote ${noisePath}`)
  console.log(`\nDecks: ${nDecks}, alpha=${args.alpha}, scoreScale=${args.scoreScale}`)
  console.log(`Total games:`)
  console.log(`  alpha-mix bidir : ${totalAlpha} games`)
  console.log(`  baseline noise  : ${totalBaseline} games`)
  console.log(`\nEstimated runtime (Win native, ~25s/game neural, ~2s/game baseline):`)
  console.log(`  alpha-mix (serial)     : ~${Math.round((totalAlpha * 25) / 60)} min`)
  console.log(`  alpha-mix (--concurrency 4): ~${Math.round((totalAlpha * 25) / 60 / 4)} min`)
  console.log(`  baseline noise         : ~${Math.round((totalBaseline * 2) / 60)} min`)
}

main()
