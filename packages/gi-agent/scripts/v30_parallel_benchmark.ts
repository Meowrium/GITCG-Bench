/**
 * V30 §22 — Process-level parallel benchmark runner.
 *
 * The built-in `--concurrency N` (worker_threads) is broken under gnx because
 * tsx's `.js`→`.ts` resolution hook does not propagate into worker threads
 * (ERR_MODULE_NOT_FOUND on sibling `.js` imports). This wrapper sidesteps that
 * by sharding the matchups across N *child processes*, each a full `gnx`
 * invocation (which has working TS support), then merging their RESULT blocks.
 *
 * Usage:
 *   pnpm exec gnx scripts/v30_parallel_benchmark.ts <config.json> <out.json> [--workers 4]
 *
 * Output: writes a merged benchmark RESULT JSON to <out.json> AND prints the
 * standard ===RESULT_START===/===RESULT_END=== block so the existing
 * summarize scripts can consume it.
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

interface Matchup {
  id: string
  [key: string]: unknown
}
interface BenchmarkConfig {
  version?: string
  matchups: Matchup[]
  [key: string]: unknown
}
interface MatchupResult {
  matchupId: string
  [key: string]: unknown
}
interface BenchmarkResult {
  generatedAt?: string
  version?: string
  summary?: unknown
  matchups: MatchupResult[]
  priorMatrix?: unknown[]
}

interface Args {
  config: string
  out: string
  workers: number
}

function parseArgs(argv: string[]): Args {
  const pos: string[] = []
  let workers = 4
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workers") workers = Number(argv[++i] ?? "4")
    else pos.push(argv[i])
  }
  if (pos.length < 2) {
    throw new Error(
      "Usage: v30_parallel_benchmark.ts <config.json> <out.json> [--workers N]",
    )
  }
  return { config: pos[0], out: pos[1], workers }
}

function extractResult(text: string): BenchmarkResult {
  const start = text.indexOf("===RESULT_START===")
  const end = text.indexOf("===RESULT_END===")
  if (start < 0 || end < 0) {
    throw new Error("child output missing RESULT block:\n" + text.slice(-2000))
  }
  return JSON.parse(text.slice(start + "===RESULT_START===".length, end).trim())
}

function shard<T>(items: T[], n: number): T[][] {
  const out: T[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < items.length; i++) out[i % n].push(items[i])
  return out.filter((s) => s.length > 0)
}

function runChild(configPath: string): Promise<BenchmarkResult> {
  return new Promise((resolveP, rejectP) => {
    // Invoke the same benchmark CLI via pnpm, single-process (concurrency 1).
    const child = spawn(
      "pnpm",
      ["run", "benchmark", configPath],
      { shell: true, cwd: process.cwd() },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })
    child.on("error", rejectP)
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectP(new Error(`child exited ${code}\n${stderr.slice(-2000)}`))
        return
      }
      try {
        resolveP(extractResult(stdout))
      } catch (err) {
        rejectP(err as Error)
      }
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = resolve(args.config)
  const config = JSON.parse(readFileSync(configPath, "utf8")) as BenchmarkConfig
  const baseDir = dirname(configPath)

  const workerCount = Math.max(1, Math.min(args.workers, config.matchups.length))
  const shards = shard(config.matchups, workerCount)
  console.error(`[parallel-bench] ${config.matchups.length} matchups → ${shards.length} processes`)

  // Write shard configs into a temp dir that is a SIBLING of the original
  // config so all relative paths (weightsPath, encoderWeightsPath, deck codes)
  // resolve identically. We place them in baseDir with a unique prefix.
  const tmpPrefix = `._v30par_${Date.now()}_`
  const shardPaths: string[] = []
  shards.forEach((matchups, i) => {
    const p = join(baseDir, `${tmpPrefix}${i}.json`)
    writeFileSync(p, JSON.stringify({ ...config, matchups }, null, 2))
    shardPaths.push(p)
  })

  const t0 = Date.now()
  let results: BenchmarkResult[]
  try {
    results = await Promise.all(shardPaths.map((p) => runChild(p)))
  } finally {
    for (const p of shardPaths) {
      try { rmSync(p) } catch { /* ignore */ }
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  // Merge
  const mergedMatchups = results.flatMap((r) => r.matchups)
  const totalGames = mergedMatchups.reduce(
    (s, m) => s + (typeof m.total === "number" ? m.total : 0),
    0,
  )
  const meanWinRateA =
    mergedMatchups.reduce(
      (s, m) => s + (typeof m.winRateP0 === "number" ? m.winRateP0 : 0),
      0,
    ) / Math.max(1, mergedMatchups.length)
  const merged: BenchmarkResult = {
    generatedAt: new Date().toISOString(),
    version: config.version,
    summary: {
      totalMatchups: mergedMatchups.length,
      totalGames,
      meanWinRateA,
    },
    matchups: mergedMatchups,
    priorMatrix: [],
  }

  const outPath = resolve(args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(merged, null, 2))

  console.error(`[parallel-bench] done in ${elapsed}s, ${mergedMatchups.length} matchups, ${totalGames} games`)
  console.error(`[parallel-bench] merged result → ${outPath}`)
  // Emit RESULT block for downstream summarize scripts.
  console.log("===RESULT_START===")
  console.log(JSON.stringify(merged))
  console.log("===RESULT_END===")
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
