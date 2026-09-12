// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * P3-1 跨代聚合（机械层）：读各代 run 目录的 summary.json + harness.json，
 * 出 trend.json（每代一行：thenMiss/coverage/fallback/winRate/avgRounds 五指标
 * + issueHistogram + counters）与 trend.md（markdown 表格，渲染范式同
 * scripts/ops/render-game-log.ts）。只读机械层：无 LLM、无语义归因。
 *
 * 用法（gi-agent 包目录内）：
 *   gnx scripts/ops/aggregate-generations.ts <runRoot1> <runRoot2> ... --out <trend.json>
 *   （trend.md 落同目录；各代行序 = 命令行给定顺序，调用方控制代际顺序）
 *
 * 输入约定：
 * - summary.json：batch-runner 产物（winRate/avgRounds/avgCoverage/fallbackRate/
 *   perRuleThenMiss/perGame）；缺失即报错退出（无指标可聚合）。
 * - harness.json：agent-loop sidecar。探测顺序 harness.json → reflect.harness.json →
 *   目录内唯一 *.harness.json（portfolio 代是 reflect.harness.json，author/reflect
 *   legacy 是 <out>.harness.json）；缺失或为旧 schema（无 issueHistogram/counters，
 *   2026-09-05 前产物，整合稿 §3-6 口径断层）时按 0 处理并在 trend.json 标注
 *   harnessSchema: "legacy" | "none"。
 *
 * 指标口径（与 docs/oracle-free-harness-metrics.md 一致）：
 * - thenMiss = Σ perRuleThenMiss 各规则计数（死规则探针总量）
 * - coverage = avgCoverage；fallback = fallbackRate（全方法口径）；winRate / avgRounds 直读
 * - issueHistogram / counters 直读 harness sidecar（P0-4 schema；cardFace/cardFaceFixed
 *   为 2026-09-08 卡面校核增量，旧产物缺字段按 0 计）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"

interface HarnessJson {
  issueHistogram?: { deadRule?: number; format?: number; closedSet?: number; lint?: number; cardFace?: number; patchRejected?: number }
  counters?: { lintFindings?: number; droppedAttempts?: number; totalAttempts?: number; cardFaceFixed?: number }
  [key: string]: unknown
}

/** P0-4 后的 issueHistogram / counters 形状（旧产物缺字段按 0 补齐；cardFace/cardFaceFixed 为 2026-09-08 增量） */
interface IssueHistogram {
  deadRule: number
  format: number
  closedSet: number
  lint: number
  cardFace: number
  patchRejected: number
}

interface Counters {
  lintFindings: number
  droppedAttempts: number
  totalAttempts: number
  cardFaceFixed: number
}

interface GenerationRow {
  /** 代标识 = run 目录 basename（如 metric-r1 / r0-evidence-vs-hongniu） */
  generation: string
  dir: string
  summaryFile: string
  /** 实际采用的 harness sidecar 文件名；null = 目录内无 harness 产物 */
  harnessFile: string | null
  /** "p04" = 含 issueHistogram/counters 的新 schema；"legacy" = 旧 schema；"none" = 无文件 */
  harnessSchema: "p04" | "legacy" | "none"
  games: number
  wins: number
  losses: number
  draws: number
  winRate: number
  avgRounds: number
  coverage: number
  fallback: number
  thenMiss: number
  perRuleThenMiss: Record<string, number>
  issueHistogram: IssueHistogram
  counters: Counters
}

interface TrendJson {
  generatedAt: string
  /** 命令行给定的各代 run 根目录（原序） */
  sources: string[]
  generations: GenerationRow[]
}

function zeroHistogram(): IssueHistogram {
  return { deadRule: 0, format: 0, closedSet: 0, lint: 0, cardFace: 0, patchRejected: 0 }
}

function zeroCounters(): Counters {
  return { lintFindings: 0, droppedAttempts: 0, totalAttempts: 0, cardFaceFixed: 0 }
}

function parseArgs(argv: string[]): { runDirs: string[]; out: string } {
  const positional: string[] = []
  let out = ""
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") out = argv[++i] ?? ""
    else if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`)
    else positional.push(a)
  }
  if (positional.length < 1 || !out) {
    throw new Error("Usage: aggregate-generations.ts <runRoot1> <runRoot2> ... --out <trend.json>")
  }
  return { runDirs: positional, out }
}

/** harness sidecar 探测：harness.json → reflect.harness.json → 唯一 *.harness.json */
function findHarnessFile(dir: string): string | null {
  for (const name of ["harness.json", "reflect.harness.json"]) {
    if (existsSync(join(dir, name))) return name
  }
  const matches = readdirSync(dir).filter((n) => n.endsWith(".harness.json")).sort()
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.warn(`[warn] ${dir} 内有 ${matches.length} 个 *.harness.json，采用 ${matches[0]}（其余忽略）`)
    return matches[0]
  }
  return null
}

function readSummary(dir: string): { summary: Record<string, unknown>; file: string } {
  const file = join(dir, "summary.json")
  if (!existsSync(file)) {
    console.error(`[fail] ${dir} 缺 summary.json（batch-runner 产物）——无指标可聚合`)
    process.exit(1)
  }
  return { summary: JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>, file }
}

function readHarness(dir: string): { harness: HarnessJson | null; file: string | null; schema: "p04" | "legacy" | "none" } {
  const name = findHarnessFile(dir)
  if (name === null) return { harness: null, file: null, schema: "none" }
  const harness = JSON.parse(readFileSync(join(dir, name), "utf-8")) as HarnessJson
  const schema = harness.issueHistogram !== undefined || harness.counters !== undefined ? "p04" : "legacy"
  if (schema === "legacy") {
    console.warn(`[warn] ${join(dir, name)} 为旧 schema（无 issueHistogram/counters）——直方图/counters 按 0 计（2026-09-05 前产物）`)
  }
  return { harness, file: name, schema }
}

function sumValues(record: unknown): number {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 0
  return Object.values(record as Record<string, unknown>).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0)
}

function numberOf(summary: Record<string, unknown>, key: string): number {
  const v = summary[key]
  return typeof v === "number" ? v : 0
}

function buildRow(dir: string): GenerationRow {
  const { summary, file: summaryFile } = readSummary(dir)
  const { harness, file: harnessFile, schema } = readHarness(dir)
  const perRuleThenMiss: Record<string, number> = {}
  const rawThenMiss = summary.perRuleThenMiss
  if (rawThenMiss && typeof rawThenMiss === "object" && !Array.isArray(rawThenMiss)) {
    for (const [k, v] of Object.entries(rawThenMiss as Record<string, unknown>)) {
      if (typeof v === "number") perRuleThenMiss[k] = v
    }
  }
  return {
    generation: dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir,
    dir,
    summaryFile,
    harnessFile,
    harnessSchema: schema,
    games: numberOf(summary, "games"),
    wins: numberOf(summary, "wins"),
    losses: numberOf(summary, "losses"),
    draws: numberOf(summary, "draws"),
    winRate: numberOf(summary, "winRate"),
    avgRounds: numberOf(summary, "avgRounds"),
    coverage: numberOf(summary, "avgCoverage"),
    fallback: numberOf(summary, "fallbackRate"),
    thenMiss: sumValues(perRuleThenMiss),
    perRuleThenMiss,
    issueHistogram: { ...zeroHistogram(), ...(harness?.issueHistogram ?? {}) },
    counters: { ...zeroCounters(), ...(harness?.counters ?? {}) },
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

function trendMarkdown(trend: TrendJson): string {
  const out: string[] = []
  out.push(`# 跨代趋势（机械层聚合，P3-1）`)
  out.push("")
  out.push(`- generatedAt: ${trend.generatedAt}`)
  out.push(`- sources: ${trend.sources.join(", ")}`)
  out.push(`- 口径：coverage/fallback = batch summary 全方法口径；thenMiss = Σ perRuleThenMiss；issueHistogram/counters 来自 harness sidecar（P0-4 schema，legacy 产物按 0 计）`)
  out.push("")
  out.push("| generation | N | winRate | avgRounds | coverage | fallback | thenMiss | deadRule | format | closedSet | lint | cardFace | patchRejected | lintFindings | cardFaceFixed | dropped | attempts | harness |")
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|")
  for (const g of trend.generations) {
    out.push(
      `| ${g.generation} | ${g.games} | ${pct(g.winRate)} | ${g.avgRounds.toFixed(1)} | ${pct(g.coverage)} | ${pct(g.fallback)} | ${g.thenMiss}`
      + ` | ${g.issueHistogram.deadRule} | ${g.issueHistogram.format} | ${g.issueHistogram.closedSet} | ${g.issueHistogram.lint} | ${g.issueHistogram.cardFace} | ${g.issueHistogram.patchRejected}`
      + ` | ${g.counters.lintFindings} | ${g.counters.cardFaceFixed} | ${g.counters.droppedAttempts} | ${g.counters.totalAttempts} | ${g.harnessSchema} |`,
    )
  }
  out.push("")
  return out.join("\n")
}

function main(): void {
  const { runDirs, out } = parseArgs(process.argv.slice(2))
  const outPath = resolve(out)
  const rows = runDirs.map((d) => buildRow(resolve(d)))
  const trend: TrendJson = {
    generatedAt: new Date().toISOString(),
    sources: runDirs.map((d) => resolve(d)),
    generations: rows,
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(trend, null, 2)}\n`, "utf-8")
  const mdPath = outPath.replace(/\.json$/, ".md")
  writeFileSync(mdPath, trendMarkdown(trend), "utf-8")
  console.error(`[aggregate-generations] ${rows.length} 代 → ${outPath} + ${mdPath}`)
}

main()
