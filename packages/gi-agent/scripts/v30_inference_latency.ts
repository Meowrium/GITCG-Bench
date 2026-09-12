/**
 * V30 §5.6 第 5 项 — Encoder runtime inference latency benchmark.
 *
 * Loads a trained encoder weights bundle and a small set of real
 * StateObservation records (from the test split) and measures the wall
 * time for `predictor.predict(...)` per record. V30 acceptance threshold
 * is < 10 ms / decision point on CPU.
 *
 * Reports:
 *   - n samples measured
 *   - mean / p50 / p95 / p99 / max latency in ms
 *   - throughput (decisions/s)
 *   - candidate count distribution (latency scales with K)
 *
 * Usage:
 *   pnpm exec gnx scripts/v30_inference_latency.ts \
 *     [--weights examples/output/v30-stage3-2k/encoder-weights.json] \
 *     [--val examples/output/v30-stage3-2k/dataset/test.ndjson] \
 *     [--n 500] \
 *     [--report examples/output/v30-stage3-2k/latency-report.json]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { V30NeuralPredictor } from "../src/learning/encoder/neural-predictor.js"
import type { StateObservationRecord } from "../src/learning/encoder/state-observation.js"

interface Args {
  weights: string
  val: string
  n: number
  report?: string
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = {
    weights: "examples/output/v30-stage3-2k/encoder-weights.json",
    val: "examples/output/v30-stage3-2k/dataset/test.ndjson",
    n: 500,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--weights") a.weights = argv[++i]
    else if (argv[i] === "--val") a.val = argv[++i]
    else if (argv[i] === "--n") a.n = Number(argv[++i] ?? "500")
    else if (argv[i] === "--report") a.report = argv[++i]
  }
  return a
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  return sorted[idx]
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const weightsPath = resolve(args.weights)
  const valPath = resolve(args.val)
  const n = args.n

  console.log(`[latency] weights : ${weightsPath}`)
  console.log(`[latency] val     : ${valPath}`)
  console.log(`[latency] n       : ${n}`)

  const t0 = performance.now()
  const predictor = V30NeuralPredictor.fromFile(weightsPath)
  const loadMs = performance.now() - t0
  console.log(`[latency] load weights: ${loadMs.toFixed(1)} ms`)

  const lines = readFileSync(valPath, "utf8").trim().split("\n")
  if (lines.length === 0) {
    throw new Error("val ndjson is empty")
  }
  const records: StateObservationRecord[] = lines
    .slice(0, Math.min(n, lines.length))
    .map((l) => JSON.parse(l) as StateObservationRecord)
  console.log(`[latency] loaded ${records.length} records`)

  // Warm-up (JIT / cache) — discard first 10
  for (let i = 0; i < Math.min(10, records.length); i++) {
    predictor.predict({ observation: records[i].observation })
  }

  const latencies: number[] = []
  const candidateCounts: number[] = []
  let total = 0
  for (const r of records) {
    const t = performance.now()
    const out = predictor.predict({ observation: r.observation })
    const dt = performance.now() - t
    latencies.push(dt)
    candidateCounts.push(out.candidateIds.length)
    total += dt
  }

  const sorted = [...latencies].sort((a, b) => a - b)
  const stats = {
    n: latencies.length,
    mean: total / latencies.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    throughput_per_s: 1000 / (total / latencies.length),
    candidates_mean: candidateCounts.reduce((a, b) => a + b, 0) / candidateCounts.length,
    candidates_max: Math.max(...candidateCounts),
  }

  console.log("\n──────── Inference latency (ms) ────────")
  console.log(`  mean     : ${stats.mean.toFixed(3)}`)
  console.log(`  p50      : ${stats.p50.toFixed(3)}`)
  console.log(`  p95      : ${stats.p95.toFixed(3)}`)
  console.log(`  p99      : ${stats.p99.toFixed(3)}`)
  console.log(`  max      : ${stats.max.toFixed(3)}`)
  console.log(`  min      : ${stats.min.toFixed(3)}`)
  console.log(`  throughput: ${stats.throughput_per_s.toFixed(0)} decisions/s`)
  console.log(`  candidates: mean=${stats.candidates_mean.toFixed(1)} max=${stats.candidates_max}`)

  const threshold = 10.0
  const passed = stats.p95 < threshold
  console.log(
    `\nV30 §5.6 latency target: p95 < ${threshold} ms → p95=${stats.p95.toFixed(2)} ${passed ? "✓ PASSED" : "✗ FAILED"}`,
  )

  if (args.report) {
    const reportPath = resolve(args.report)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          weights: weightsPath,
          val: valPath,
          load_ms: loadMs,
          stats,
          threshold_ms: threshold,
          passed,
        },
        null,
        2,
      ),
    )
    console.log(`\n[latency] report saved to ${reportPath}`)
  }
}

main()
