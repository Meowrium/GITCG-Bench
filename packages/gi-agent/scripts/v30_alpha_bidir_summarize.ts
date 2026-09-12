/**
 * V30 §22 — Bidirectional alpha-mix benchmark result analyzer.
 *
 * Reads the JSON written between ===RESULT_START===/===RESULT_END=== of a
 * bidirectional alpha-mix benchmark, then folds matchups in pairs:
 *   <deck>-mirror-neuralP0:  WR(neural) = winRateP0
 *   <deck>-mirror-neuralP1:  WR(neural) = 1 - winRateP0
 * giving a per-deck "neural side WR" averaged over both directions.
 *
 * Compares to a paired baseline noise floor file (same deck list, baseline
 * vs baseline). For mirror baseline noise, "neural" doesn't apply — instead
 * we report WR(P0) directly as the structural P0 advantage of that deck.
 *
 * Usage:
 *   pnpm exec gnx scripts/v30_alpha_bidir_summarize.ts \
 *     --alpha <alpha-mix-result.json> [--noise <baseline-noise-result.json>] \
 *     [--report <out.json>]
 *
 * The result JSON is what the benchmark CLI prints — pass it raw or saved
 * to a file. Easiest: redirect stdout from `pnpm run benchmark`.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"

interface MatchupResult {
  matchupId: string
  sideAName: string
  sideBName: string
  total: number
  winsP0: number
  winsP1: number
  draws: number
  winRateP0: number
  avgRounds: number
  avgElapsedMs: number
}

interface BenchmarkResult {
  generatedAt: string
  version: string
  summary: {
    totalMatchups: number
    totalGames: number
    meanWinRateA: number
    meanRounds: number
    meanElapsedMs: number
  }
  matchups: MatchupResult[]
}

function extractResult(text: string): BenchmarkResult {
  const start = text.indexOf("===RESULT_START===")
  const end = text.indexOf("===RESULT_END===")
  if (start < 0 || end < 0) {
    // Try parsing as raw JSON
    return JSON.parse(text) as BenchmarkResult
  }
  const jsonStr = text.slice(start + "===RESULT_START===".length, end).trim()
  return JSON.parse(jsonStr) as BenchmarkResult
}

/**
 * Read a benchmark stdout log robustly across encodings. PowerShell `>`
 * redirection writes UTF-16LE with a BOM, while bash / pnpm write UTF-8.
 * We sniff the BOM and decode accordingly, then strip any leading command
 * echo lines (`$ gnx ...`) so only the RESULT block matters.
 */
function readLogFile(path: string): string {
  const buf = readFileSync(path)
  // UTF-16LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString("utf16le").replace(/^\uFEFF/, "")
  }
  // UTF-16BE BOM: FE FF
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no native utf16be; swap byte order then decode as utf16le.
    const swapped = Buffer.alloc(buf.length)
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1]
      swapped[i + 1] = buf[i]
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "")
  }
  // UTF-8 BOM: EF BB BF
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8")
  }
  return buf.toString("utf8")
}

interface DeckSummary {
  deckId: string
  neural_p0_wr: number  // neural plays sideA (P0)
  neural_p1_wr: number  // neural plays sideB (P1)
  neural_combined_wr: number
  draws_p0: number
  draws_p1: number
  rounds_p0: number
  rounds_p1: number
  games_per_side: number
}

function summarizeAlphaMix(r: BenchmarkResult): DeckSummary[] {
  const byDeck = new Map<string, { p0?: MatchupResult; p1?: MatchupResult }>()
  for (const m of r.matchups) {
    const match = m.matchupId.match(/^(.+)-mirror-neural(P0|P1)$/)
    if (!match) continue
    const deckId = match[1]
    const slot = byDeck.get(deckId) ?? {}
    if (match[2] === "P0") slot.p0 = m
    else slot.p1 = m
    byDeck.set(deckId, slot)
  }
  const out: DeckSummary[] = []
  for (const [deckId, { p0, p1 }] of byDeck) {
    if (!p0 || !p1) continue
    const neuralP0wr = p0.winRateP0
    const neuralP1wr = 1 - p1.winRateP0
    const totalWins = p0.winsP0 + p1.winsP1
    const totalDecided = (p0.total - p0.draws) + (p1.total - p1.draws)
    const combinedWr = totalDecided > 0 ? totalWins / totalDecided : NaN
    out.push({
      deckId,
      neural_p0_wr: neuralP0wr,
      neural_p1_wr: neuralP1wr,
      neural_combined_wr: combinedWr,
      draws_p0: p0.draws,
      draws_p1: p1.draws,
      rounds_p0: p0.avgRounds,
      rounds_p1: p1.avgRounds,
      games_per_side: p0.total,
    })
  }
  return out
}

interface NoiseSummary {
  deckId: string
  p0_wr: number  // structural P0 advantage of this deck
  draws: number
  rounds: number
  games: number
}

function summarizeNoise(r: BenchmarkResult): NoiseSummary[] {
  const out: NoiseSummary[] = []
  for (const m of r.matchups) {
    const match = m.matchupId.match(/^(.+)-mirror$/)
    if (!match) continue
    out.push({
      deckId: match[1],
      p0_wr: m.winRateP0,
      draws: m.draws,
      rounds: m.avgRounds,
      games: m.total,
    })
  }
  return out
}

function bin(p: number, n: number): { lo: number; hi: number } {
  // Wilson 95% CI for binomial proportion
  const z = 1.96
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { lo: center - half, hi: center + half }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length)
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "  -  "
}

function parseArgs(argv: string[]): { alpha: string; noise?: string; report?: string } {
  const out: { alpha?: string; noise?: string; report?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--alpha" && argv[i + 1]) {
      out.alpha = argv[++i]
    } else if (argv[i] === "--noise" && argv[i + 1]) {
      out.noise = argv[++i]
    } else if (argv[i] === "--report" && argv[i + 1]) {
      out.report = argv[++i]
    }
  }
  if (!out.alpha) {
    throw new Error(
      "Usage: pnpm exec gnx scripts/v30_alpha_bidir_summarize.ts --alpha <result.json> [--noise <noise.json>] [--report <out.json>]",
    )
  }
  return { alpha: out.alpha, noise: out.noise, report: out.report }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const alphaText = readLogFile(resolve(args.alpha))
  const alphaResult = extractResult(alphaText)
  const decks = summarizeAlphaMix(alphaResult)

  let noiseDecks: NoiseSummary[] | null = null
  if (args.noise) {
    const noiseText = readLogFile(resolve(args.noise))
    const noiseResult = extractResult(noiseText)
    noiseDecks = summarizeNoise(noiseResult)
  }
  const noiseByDeck = new Map((noiseDecks ?? []).map((d) => [d.deckId, d]))

  console.log("\n──────── V30 §22 alpha-mix bidirectional summary ────────")
  console.log(
    `${pad("deck", 10)} ${pad("nP0 WR", 8)} ${pad("nP1 WR", 8)} ${pad("combined", 12)} ${pad("baseline P0", 12)} ${pad("draws", 8)} ${pad("rounds", 12)}`,
  )
  let neuralWeightedWins = 0
  let neuralWeightedTotal = 0
  for (const d of decks) {
    const n = d.games_per_side
    const ci = bin(d.neural_combined_wr, 2 * n)
    const baseline = noiseByDeck.get(d.deckId)
    const baselineStr = baseline ? `${pct(baseline.p0_wr)}` : "  -  "
    const drawsStr = `${d.draws_p0}/${d.draws_p1}`
    const roundsStr = `${d.rounds_p0.toFixed(1)}/${d.rounds_p1.toFixed(1)}`
    const combinedStr = `${pct(d.neural_combined_wr)} ±${((ci.hi - ci.lo) * 50).toFixed(1)}`
    console.log(
      `${pad(d.deckId, 10)} ${pad(pct(d.neural_p0_wr), 8)} ${pad(pct(d.neural_p1_wr), 8)} ${pad(combinedStr, 12)} ${pad(baselineStr, 12)} ${pad(drawsStr, 8)} ${pad(roundsStr, 12)}`,
    )
    const decided = (1 - d.draws_p0 / n) * n + (1 - d.draws_p1 / n) * n
    neuralWeightedWins += d.neural_combined_wr * decided
    neuralWeightedTotal += decided
  }
  const meanWr = neuralWeightedTotal > 0 ? neuralWeightedWins / neuralWeightedTotal : NaN
  const totalCi = bin(meanWr, neuralWeightedTotal)
  console.log(`\nOverall neural WR: ${pct(meanWr)} (95% CI: ${pct(totalCi.lo)} – ${pct(totalCi.hi)}, n_decided=${neuralWeightedTotal.toFixed(0)})`)

  // Verdict
  const passNorm = meanWr >= 0.5
  // Only average baseline P0 over decks that ALSO appear in the alpha file,
  // so excluded decks (e.g. 水凝, which has a baseline-policy stalemate) don't
  // skew the comparison.
  const alphaDeckIds = new Set(decks.map((d) => d.deckId))
  const matchedNoise = (noiseDecks ?? []).filter((d) => alphaDeckIds.has(d.deckId))
  const baseMean =
    matchedNoise.length > 0
      ? matchedNoise.reduce((a, b) => a + b.p0_wr, 0) / matchedNoise.length
      : NaN
  const passVsBaseline = noiseDecks !== null ? meanWr >= baseMean : null
  console.log("\nKPI-D check (V30 §5.6 alpha-mix WR ≥ baseline):")
  console.log(`  vs 50%             : ${meanWr.toFixed(4)} ${passNorm ? "✓" : "✗"}`)
  if (passVsBaseline !== null) {
    console.log(
      `  vs baseline P0 mean: ${meanWr.toFixed(4)} vs ${baseMean.toFixed(4)} ` +
        `(${matchedNoise.length} matched decks) ${passVsBaseline ? "✓" : "✗"}`,
    )
  }

  if (args.report) {
    const reportPath = resolve(args.report)
    mkdirSync(dirname(reportPath), { recursive: true })
    const obj = {
      alpha_result_path: resolve(args.alpha),
      noise_result_path: args.noise ? resolve(args.noise) : null,
      mean_neural_wr: meanWr,
      mean_neural_wr_ci95: totalCi,
      n_decided: neuralWeightedTotal,
      per_deck: decks.map((d) => ({
        ...d,
        baseline_p0_wr: noiseByDeck.get(d.deckId)?.p0_wr ?? null,
      })),
      noise_floor: noiseDecks,
    }
    writeFileSync(reportPath, JSON.stringify(obj, null, 2))
    console.log(`\nreport saved → ${reportPath}`)
  }
}

main()
