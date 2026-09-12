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
 * organizer 证据导出器核心（WP4 件 1；CLI 薄封装在 run-plan-organize-export.ts）。
 *
 * 读一个 plan:batch run 目录，产出 evidencePack（organizer 三任务的信息源，B 案
 * 2026-09-03-llm-evidence-organizer-eval.md §3/§4-5）：
 *  1. fullDigest.txt        放宽口径逐局决策证据（含 opening 类决策点；
 *                           上限独立参数化——不复用 reflect 的 3/局、8/run、420 行预算）
 *  2. stateSignatures.jsonl 每决策点整条 stateSignature（不抽摘要）
 *  3. draw-sequence.md      各局 initialPile/pile 差分重建的抽牌序列（读取端计算）
 *  4. outliers.json         perGame 离群标注（coverage < 中位数-2σ、rounds > P95）
 *                           + run 级机械聚合（perRuleHits / perMethod / declareEnd）
 *  5. side1/                对手侧 trace + summary 包（plan-vs-plan run 才有）
 * 另附 plan.side0.json（mentions 任务的第一手来源）与 manifest.json（pack 自述）。
 *
 * 口径纪律：
 * - oracle-free：复用 modules.ts serve 文本化器时 ctx.evidence = "engine-only"
 *   （eval 读取分支整体门控），organizer 证据不碰 oracle/NN（B 案 §2 禁用表）。
 * - 单局不截断：total 预算超限时按整局省略（保持单局完整性），附省略清单。
 * - 隔离红线：本模块只读 runDir、只写 outDir；organizer 产物不回流 reflect。
 */

import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { GameStateLogEntry } from "@gi-tcg/core"
import { loadAlignedGameInput, type AlignedGameInput } from "../../../evaluation/plan-eval/eval-game.js"
import type { PlanBatchSummary } from "../batch-runner.js"
import { formatRuleKey } from "../rule-key.js"
import { backfillTraceSignatures } from "../sig-backfill.js"
import type { PlanTraceEntry, PlanTraceFile } from "../trace.js"
import { compactStateDigest, formatChosen, formatThreat } from "./evidence-extract.js"
import { createModuleResolver } from "./modules.js"

/** fullDigest 总行数上限初值（P1-3 人工校准后改终值，WP4 规格 §2） */
export const DEFAULT_MAX_LINES = 2000
/** fullDigest 总字符上限初值 */
export const DEFAULT_MAX_CHARS = 200_000

export interface OrganizeExportOptions {
  /** plan:batch run 目录（game-NNNN/* + summary.json） */
  runDir: string
  /** evidencePack 输出目录 */
  outDir: string
  /** 局选择：all（默认）/ 前 N 局 / outliers（离群局） */
  games?: "all" | number | "outliers"
  maxLines?: number
  maxChars?: number
}

export interface EvidencePackResult {
  packDir: string
  /** 写出的文件（pack 相对路径，即引用白名单的实际子集） */
  files: string[]
  gamesAll: string[]
  gamesSelected: string[]
  omittedGames: string[]
  side1Present: boolean
  alignmentWarnings: string[]
  outliers: OutlierThresholds
  fullDigest: { lines: number; chars: number }
}

// ── 离群标注 ─────────────────────────────────────────────────────────

export interface OutlierThresholds {
  coverageMedian: number
  coverageStd: number
  coverageLower: number
  roundsP95: number
}

export type PerGameRow = PlanBatchSummary["perGame"][number] & {
  /** 离群标记：coverage 塌落 / rounds 异常 */
  flags: string[]
}

/** 线性插值百分位（numpy default 口径） */
export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const idx = (sortedValues.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedValues[lo]!
  return sortedValues[lo]! + (sortedValues[hi]! - sortedValues[lo]!) * (idx - lo)
}

/** perGame 离群计算（WP4 规格 §2：coverage < 中位数-2σ、rounds > P95） */
export function computeOutliers(perGame: PlanBatchSummary["perGame"]): {
  thresholds: OutlierThresholds
  rows: PerGameRow[]
  outlierGames: string[]
} {
  const coverages = perGame.map((g) => g.coverage).sort((a, b) => a - b)
  const rounds = perGame.map((g) => g.rounds).sort((a, b) => a - b)
  const n = coverages.length
  const mean = n > 0 ? coverages.reduce((s, v) => s + v, 0) / n : 0
  const std = n > 0 ? Math.sqrt(coverages.reduce((s, v) => s + (v - mean) ** 2, 0) / n) : 0
  const coverageMedian = percentile(coverages, 0.5)
  const roundsP95 = percentile(rounds, 0.95)
  const coverageLower = coverageMedian - 2 * std
  const rows = perGame.map((g) => {
    const flags: string[] = []
    if (n > 0 && g.coverage < coverageLower) flags.push("coverageCollapse")
    if (n > 0 && g.rounds > roundsP95) flags.push("roundsSpike")
    return { ...g, flags }
  })
  return {
    thresholds: { coverageMedian, coverageStd: std, coverageLower, roundsP95 },
    rows,
    outlierGames: rows.filter((r) => r.flags.length > 0).map((r) => r.gameDir),
  }
}

// ── 抽牌序列重建（initialPile/pile 差分）────────────────────────────

export interface DrawEvent {
  /** state log 条目下标（0 = 开局态） */
  logIndex: number
  round: number
  turn: number
  phase: string
  /** draw = 离堆且进入手牌；leave = 离堆但未进手（移出游戏等）；return = 回到牌堆 */
  kind: "draw" | "leave" | "return"
  defId: number
  entityId: number
}

export interface PlayerDrawSequence {
  /** 开局牌堆张数 */
  initialCount: number
  /** 开局牌堆构成（defId → 张数，按 defId 升序） */
  initialComposition: Array<{ defId: number; count: number }>
  events: DrawEvent[]
  drawn: number
  left: number
  returned: number
  finalPileCount: number
}

interface PileSnapshot {
  pileIds: number[]
  handIds: Set<number>
  round: number
  turn: number
  phase: string
}

function pileSnapshotOf(entry: GameStateLogEntry, who: number): PileSnapshot {
  const p = entry.state.players[who]
  return {
    pileIds: (p?.pile ?? []).map((e) => e.id),
    handIds: new Set((p?.hands ?? []).map((e) => e.id)),
    round: entry.state.roundNumber ?? 0,
    turn: entry.state.currentTurn ?? 0,
    phase: String(entry.state.phase ?? "?"),
  }
}

/**
 * 单玩家抽牌序列：逐条 state log 差分 pile（entity id 集合）。
 * 离堆实体按"是否出现在当前手牌"二分为 draw / leave；进堆实体记 return。
 * 与 `e` mutation 流无关——旧 run（e 恒空）同样可重建（B 案 §6-8 兼容分支）。
 */
export function reconstructDrawSequence(stateLog: GameStateLogEntry[], who: number): PlayerDrawSequence {
  const defIdOf = new Map<number, number>()
  const snapshots = stateLog.map((entry) => pileSnapshotOf(entry, who))
  for (const entry of stateLog) {
    const p = entry.state.players[who]
    for (const e of [...(p?.pile ?? []), ...(p?.hands ?? [])]) {
      defIdOf.set(e.id, e.definition?.id ?? 0)
    }
  }
  const initialPile = stateLog[0]?.state.players[who]?.pile ?? []
  const compositionCounts = new Map<number, number>()
  for (const e of initialPile) {
    const defId = e.definition?.id ?? 0
    compositionCounts.set(defId, (compositionCounts.get(defId) ?? 0) + 1)
  }
  const events: DrawEvent[] = []
  for (let k = 1; k < snapshots.length; k++) {
    const prev = snapshots[k - 1]!
    const cur = snapshots[k]!
    const curSet = new Set(cur.pileIds)
    const prevSet = new Set(prev.pileIds)
    for (const id of prev.pileIds.filter((id) => !curSet.has(id))) {
      events.push({
        logIndex: k,
        round: cur.round,
        turn: cur.turn,
        phase: cur.phase,
        kind: cur.handIds.has(id) ? "draw" : "leave",
        defId: defIdOf.get(id) ?? 0,
        entityId: id,
      })
    }
    for (const id of cur.pileIds.filter((id) => !prevSet.has(id))) {
      events.push({ logIndex: k, round: cur.round, turn: cur.turn, phase: cur.phase, kind: "return", defId: defIdOf.get(id) ?? 0, entityId: id })
    }
  }
  const drawn = events.filter((e) => e.kind === "draw").length
  const left = events.filter((e) => e.kind === "leave").length
  const returned = events.filter((e) => e.kind === "return").length
  const last = snapshots[snapshots.length - 1]
  return {
    initialCount: initialPile.length,
    initialComposition: [...compositionCounts.entries()]
      .map(([defId, count]) => ({ defId, count }))
      .sort((a, b) => a.defId - b.defId),
    events,
    drawn,
    left,
    returned,
    finalPileCount: last?.pileIds.length ?? initialPile.length,
  }
}

// ── 行渲染 helpers ───────────────────────────────────────────────────

function ruleKeyOf(e: PlanTraceEntry): string | null {
  if (!e.matchedRule) return null
  return formatRuleKey({
    scope: e.matchedRule.scope,
    priority: e.matchedRule.priority,
    phaseId: e.phaseId,
    layer: e.matchedRule.layer,
    layerLabel: e.matchedRule.layerLabel,
  })
}

function nameOf(defId: number | undefined): string {
  if (defId === undefined) return "?"
  return DEFAULT_ASSETS_MANAGER.getNameSync(defId) ?? String(defId)
}

function isAnomalyEntry(e: PlanTraceEntry): boolean {
  if (e.method !== "action") return false
  return e.fallbackUsed || (e.thenMiss?.length ?? 0) > 0 || e.chosen?.actionCase === "declareEnd"
}

/** 非 action（opening 类等）决策点 → fullDigest 行（签名脱敏——整条在 stateSignatures.jsonl） */
function renderNonActionEntry(game: string, e: PlanTraceEntry, side: 0 | 1): string[] {
  const digest = e.stateSignature ? compactStateDigest(e.stateSignature, side) : "(无 state)"
  const rule = ruleKeyOf(e) ?? (e.fallbackUsed ? `<fallback${e.fallbackPolicy ? `:${e.fallbackPolicy}` : ""}>` : "-")
  const extras = [
    e.candidateCount !== undefined ? `候选${e.candidateCount}` : "",
    (e.thenMiss ?? []).length > 0 ? `thenMiss:${e.thenMiss!.join("+")}` : "",
    e.notes.length > 0 ? `notes:${e.notes.join("；")}` : "",
  ].filter(Boolean).join(" | ")
  const entryJson = JSON.stringify({
    ...e,
    stateSignature: `<已省略，整条见 stateSignatures.jsonl seq=${e.seq}>`,
  })
  return [
    `[${game} seq${e.seq} t${e.turn}] ${digest} | ${e.method} | ${rule} | 选 ${formatChosen(e.chosen)}${formatThreat(e.threat)}${extras ? ` | ${extras}` : ""}`,
    `  trace: ${entryJson}`,
  ]
}

// ── 主流程 ───────────────────────────────────────────────────────────

interface GameBundle {
  game: string
  dir: string
  trace: PlanTraceFile | null
  aligned: AlignedGameInput | null
  /** 对齐/读取警告（进 manifest，organizer 知道哪些点对不齐） */
  warnings: string[]
}

async function listGameDirs(runDir: string): Promise<string[]> {
  return (await readdir(runDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    .map((e) => e.name)
    .sort()
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T
  } catch {
    return null
  }
}

/** run 级 perMethod / declareEnd 聚合（从全部 side0 trace 汇总；summary.json 无此二项） */
function aggregateTraces(traces: PlanTraceFile[]): {
  perMethod: Record<string, { total: number; ruleMatched: number; fallback: number }>
  declareEnds: number
  totalPoints: number
} {
  const perMethod: Record<string, { total: number; ruleMatched: number; fallback: number }> = {}
  let declareEnds = 0
  let totalPoints = 0
  for (const trace of traces) {
    for (const [method, bucket] of Object.entries(trace.summary.perMethod ?? {})) {
      const agg = (perMethod[method] ??= { total: 0, ruleMatched: 0, fallback: 0 })
      agg.total += bucket.total
      agg.ruleMatched += bucket.ruleMatched
      agg.fallback += bucket.fallback
    }
    for (const e of trace.entries) {
      if (e.method !== "action") continue
      totalPoints++
      if (e.chosen?.actionCase === "declareEnd") declareEnds++
    }
  }
  return { perMethod, declareEnds, totalPoints }
}

export async function buildEvidencePack(opts: OrganizeExportOptions): Promise<EvidencePackResult> {
  const runDir = resolve(opts.runDir)
  const packDir = resolve(opts.outDir)
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
  const gamesOpt = opts.games ?? "all"

  await DEFAULT_ASSETS_MANAGER.prepareForSync()

  const summary = await readJson<PlanBatchSummary>(join(runDir, "summary.json"))
  if (!summary) throw new Error(`run 目录缺 summary.json（不是 plan:batch 产物？）: ${runDir}`)
  const side1Summary = await readJson<PlanBatchSummary>(join(runDir, "summary.side1.json"))

  const gamesAll = await listGameDirs(runDir)
  if (gamesAll.length === 0) throw new Error(`run 目录无 game-* 子目录: ${runDir}`)

  // 全部局的 side0 trace（离群聚合 + fullDigest 共用）
  const bundlesAll = new Map<string, GameBundle>()
  for (const game of gamesAll) {
    const dir = join(runDir, game)
    const trace = await readJson<PlanTraceFile>(join(dir, "plan_trace.json"))
    bundlesAll.set(game, { game, dir, trace, aligned: null, warnings: [] })
  }
  const tracesAll = [...bundlesAll.values()].filter((b) => b.trace !== null).map((b) => b.trace!)

  const { thresholds, rows, outlierGames } = computeOutliers(summary.perGame)

  // 局选择
  let selected: string[]
  if (gamesOpt === "all") selected = [...gamesAll]
  else if (gamesOpt === "outliers") selected = gamesAll.filter((g) => outlierGames.includes(g))
  else {
    const n = Number(gamesOpt)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--games 需为 all | 正整数 | outliers，得到: ${String(opts.games)}`)
    selected = gamesAll.slice(0, n)
  }

  // 选中局的整条对齐底座（loadAlignedGameInput：trace ↔ state log 签名对齐，oracle 无关）
  const bundles = new Map<string, GameBundle>()
  for (const game of selected) {
    const base = bundlesAll.get(game)!
    // lean trace：整条签名从同局 state log 反查回填（full trace 恒 no-op）——
    // stateSignatures.jsonl / fullDigest 行内 digest 与 full 模式产物形状一致
    if (base.trace) await backfillTraceSignatures(base.dir, base.trace)
    const aligned = await loadAlignedGameInput(base.dir).catch((e: unknown) => {
      base.warnings.push(`loadAlignedGameInput 失败: ${e instanceof Error ? e.message : String(e)}`)
      return null
    })
    if (aligned) {
      base.aligned = aligned
      base.warnings.push(...aligned.warnings)
    }
    bundles.set(game, base)
  }

  await mkdir(packDir, { recursive: true })
  const files: string[] = []
  const write = async (name: string, content: string): Promise<void> => {
    await writeFile(join(packDir, name), content, "utf-8")
    files.push(name)
  }

  // ④ outliers.json（含 run 级机械聚合，organizer 免口算）
  const side0Agg = aggregateTraces(tracesAll)
  const side1Traces: PlanTraceFile[] = []
  for (const game of gamesAll) {
    const t = await readJson<PlanTraceFile>(join(runDir, game, "plan_trace.side1.json"))
    if (t) side1Traces.push(t)
  }
  const side1Present = side1Summary !== null && side1Traces.length > 0
  const outliersDoc = {
    schema: "OrganizeOutliersV1",
    runDir,
    generatedAt: new Date().toISOString(),
    rule: "离群 = coverage < median-2σ 或 rounds > P95（population σ、线性插值百分位）",
    thresholds,
    outlierGames,
    perGame: rows,
    runAggregates: {
      planId: summary.planId,
      gameVersion: summary.gameVersion,
      games: summary.games,
      seedBase: summary.seedBase,
      wins: summary.wins,
      losses: summary.losses,
      draws: summary.draws,
      winRate: summary.winRate,
      avgRounds: summary.avgRounds,
      avgCoverage: summary.avgCoverage,
      fallbackRate: summary.fallbackRate,
      perRuleHits: summary.perRuleHits,
      perRuleThenMiss: summary.perRuleThenMiss,
      perMethod: side0Agg.perMethod,
      declareEnd: { count: side0Agg.declareEnds, total: side0Agg.totalPoints },
    },
    side1: side1Present
      ? {
          planId: side1Summary!.planId,
          winRate: side1Summary!.winRate,
          avgRounds: side1Summary!.avgRounds,
          avgCoverage: side1Summary!.avgCoverage,
          fallbackRate: side1Summary!.fallbackRate,
          perRuleHits: side1Summary!.perRuleHits,
          perRuleThenMiss: side1Summary!.perRuleThenMiss,
          perMethod: aggregateTraces(side1Traces).perMethod,
        }
      : null,
  }
  await write("outliers.json", `${JSON.stringify(outliersDoc, null, 2)}\n`)

  // ⑤ side1/ 对手侧包（原样拷贝；非 plan-vs-plan run 无此件）
  if (side1Present) {
    await copyFile(join(runDir, "summary.side1.json"), join(packDir, "side1", "summary.side1.json"))
      .catch(async () => {
        await mkdir(join(packDir, "side1"), { recursive: true })
        await copyFile(join(runDir, "summary.side1.json"), join(packDir, "side1", "summary.side1.json"))
      })
    files.push("side1/summary.side1.json")
    for (const game of gamesAll) {
      const src = join(runDir, game, "plan_trace.side1.json")
      try {
        await readFile(src, "utf-8")
      } catch {
        continue
      }
      await mkdir(join(packDir, "side1", game), { recursive: true })
      await copyFile(src, join(packDir, "side1", game, "plan_trace.side1.json"))
      files.push(`side1/${game}/plan_trace.side1.json`)
    }
  }

  // 附：plan.side0.json（mentions 任务第一手来源；batch-runner 已在 run 目录归档）
  try {
    await copyFile(join(runDir, "plan.side0.json"), join(packDir, "plan.side0.json"))
    files.push("plan.side0.json")
  } catch {
    // 旧 run 未归档计划：mentions 任务信息源缺口，manifest 里标注
  }

  // ③ draw-sequence.md
  await write("draw-sequence.md", renderDrawSequenceMarkdown(runDir, selected, bundles, summary))

  // ② stateSignatures.jsonl（side0，每决策点整条签名）
  const sigLines: string[] = []
  for (const game of selected) {
    const trace = bundles.get(game)!.trace
    if (!trace) continue
    for (const e of trace.entries) {
      let sig: unknown = e.stateSignature
      try {
        if (typeof sig === "string") sig = JSON.parse(sig)
      } catch { /* 非法签名保留原串 */ }
      sigLines.push(JSON.stringify({
        game,
        side: trace.side,
        seq: e.seq,
        method: e.method,
        round: e.round,
        turn: e.turn,
        phaseId: e.phaseId,
        candidateCount: e.candidateCount,
        matchedRuleKey: ruleKeyOf(e),
        fallbackUsed: e.fallbackUsed,
        fallbackPolicy: e.fallbackPolicy,
        thenMiss: e.thenMiss,
        stateSignature: sig,
      }))
    }
  }
  await write("stateSignatures.jsonl", sigLines.length > 0 ? `${sigLines.join("\n")}\n` : "")

  // ① fullDigest.txt（复用 modules serve 文本化器，截断放宽 + engine-only 门控）
  const digest = await renderFullDigest(runDir, selected, bundles, summary, thresholds, outlierGames, { maxLines, maxChars })
  await write("fullDigest.txt", digest.text)

  // manifest（pack 自述；organize-run.ts 据此校验 pack）
  const manifest = {
    schema: "EvidencePackV1",
    runDir,
    generatedAt: new Date().toISOString(),
    side: 0,
    oracleFree: true,
    limits: { maxLines, maxChars, perGameTruncation: false },
    gamesAll,
    gamesSelected: selected,
    omittedGames: digest.omittedGames,
    side1Present,
    planCopied: files.includes("plan.side0.json"),
    alignmentWarnings: Object.fromEntries(selected.map((g) => [g, bundles.get(g)!.warnings])),
    files,
    serving: {
      gameSummary: "modules.ts game_summary（evidence=engine-only，eval 门控；截断上限放宽至 maxChars）",
      decisionDetail: "modules.ts decision_detail（fallback / thenMiss / declareEnd 点全量，无预算）",
    },
  }
  await write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    packDir,
    files,
    gamesAll,
    gamesSelected: selected,
    omittedGames: digest.omittedGames,
    side1Present,
    alignmentWarnings: selected.flatMap((g) => bundles.get(g)!.warnings),
    outliers: thresholds,
    fullDigest: digest,
  }
}

// ── draw-sequence.md 渲染 ────────────────────────────────────────────

function renderDrawSequenceMarkdown(
  runDir: string,
  games: string[],
  bundles: Map<string, GameBundle>,
  summary: PlanBatchSummary,
): string {
  const lines: string[] = [
    `# draw-sequence — 抽牌序列重建（initialPile/pile 差分，读取端计算）`,
    ``,
    `- runDir: ${runDir}`,
    `- planId: ${summary.planId}`,
    `- 口径：逐 state log 条目差分玩家牌堆（entity id）；离堆且进手 = 抽出；离堆但任一暂停点手牌均未见 = 离堆（两条日志间抽到即打出/检索，或移出游戏）；进堆 = 回洗。旧 run（无 e mutations）同样适用。`,
    `- 视角：P0/P1 为物理玩家位（trace.deckCodes 顺序）；执舵侧见 perGame.planSide。`,
    ``,
  ]
  for (const game of games) {
    const bundle = bundles.get(game)!
    const per = summary.perGame.find((g) => g.gameDir === game)
    lines.push(`## ${game}（seed=${per?.seed ?? "?"}｜winner=${per?.winner ?? "?"}｜执舵 planSide=${per?.planSide ?? "?"}）`)
    if (!bundle.aligned) {
      lines.push(``, `（state log 不可用：${bundle.warnings[0] ?? "未知原因"}）`, ``)
      continue
    }
    const stateLog = bundle.aligned.stateLog
    const deckCodes = bundle.trace?.deckCodes ?? null
    for (const who of [0, 1] as const) {
      const seq = reconstructDrawSequence(stateLog, who)
      const deck = deckCodes?.[who] ?? "?"
      lines.push(``, `### P${who}（deck ${deck.slice(0, 12)}…｜初始 ${seq.initialCount} 张）`)
      lines.push(`- 初始构成：${seq.initialComposition.map((c) => `${nameOf(c.defId)}(${c.defId})×${c.count}`).join("、") || "（空）"}`)
      if (seq.events.length === 0) lines.push(`- （无抽牌事件）`)
      for (const ev of seq.events) {
        const label = ev.kind === "draw" ? "抽" : ev.kind === "leave" ? "离堆(未见于手牌)" : "回洗"
        lines.push(`- log#${ev.logIndex} r${ev.round} t${ev.turn} phase=${ev.phase} ${label} ${nameOf(ev.defId)}(${ev.defId}) [entity ${ev.entityId}]`)
      }
      lines.push(`- 结算：初始 ${seq.initialCount} ｜ 抽出 ${seq.drawn} ｜ 离堆 ${seq.left} ｜ 回洗 ${seq.returned} ｜ 牌堆剩 ${seq.finalPileCount}`)
    }
    lines.push(``)
  }
  return `${lines.join("\n")}\n`
}

// ── fullDigest.txt 渲染 ──────────────────────────────────────────────

export interface FullDigestRender {
  text: string
  lines: number
  chars: number
  omittedGames: string[]
}

async function renderFullDigest(
  runDir: string,
  games: string[],
  bundles: Map<string, GameBundle>,
  summary: PlanBatchSummary,
  thresholds: OutlierThresholds,
  outlierGames: string[],
  limits: { maxLines: number; maxChars: number },
): Promise<FullDigestRender> {
  const side = 0
  // 复用 modules.ts serve 文本化器：game_summary（逐 action 决策行）+ decision_detail
  // （异常点原文级钻取）。截断上限放宽至 maxChars（reflect 路径不传保持 4000 不变）；
  // evidence=engine-only = eval 读取分支整体门控（organizer 不碰 oracle）。
  const resolver = createModuleResolver(
    "reflect",
    { runDir, side, evidence: "engine-only", sigRedact: true },
    { maxModuleChars: limits.maxChars },
  )
  const requests: Array<{ kind: string; id: string }> = []
  for (const game of games) {
    const trace = bundles.get(game)?.trace
    if (!trace) continue
    requests.push({ kind: "game_summary", id: game })
    for (const e of trace.entries) {
      if (isAnomalyEntry(e)) requests.push({ kind: "decision_detail", id: `${game}:${e.seq}` })
    }
  }
  const served = await resolver(requests)
  const servedByKey = new Map(served.map((s) => [s.key, s.content]))

  const agg = aggregateTraces([...bundles.values()].filter((b) => b.trace).map((b) => b.trace!))
  const header = [
    `# fullDigest — 放宽口径逐局决策证据（organizer evidencePack；side 0 视角）`,
    ``,
    `- runDir: ${runDir}`,
    `- planId: ${summary.planId} ｜ gameVersion: ${summary.gameVersion} ｜ games: ${summary.games} ｜ seedBase: ${summary.seedBase}`,
    `- 战绩: ${summary.wins}W/${summary.losses}L/${summary.draws}D ｜ winRate ${(summary.winRate * 100).toFixed(1)}% ｜ avgRounds ${summary.avgRounds.toFixed(1)} ｜ avgCoverage ${(summary.avgCoverage * 100).toFixed(1)}% ｜ fallbackRate ${(summary.fallbackRate * 100).toFixed(1)}%`,
    `- declareEnd 决策 ${agg.declareEnds}/${agg.totalPoints}（${agg.totalPoints > 0 ? ((agg.declareEnds / agg.totalPoints) * 100).toFixed(1) : "0.0"}%）——misalign 锚点（龟缩化代际信号）`,
    `- 口径：单局不截断；总行上限 ${limits.maxLines}；总字符上限 ${limits.maxChars}；opening 类决策点（chooseActive/switchHands/rerollDice）全量收录（reflect digest 不覆盖块）`,
    `- 文本化器：modules.ts game_summary / decision_detail（evidence=engine-only，不读任何 oracle 产物；截断上限放宽至 ${limits.maxChars} 字符；行内 stateSignature 脱敏——整条在 stateSignatures.jsonl）`,
    `- 离群阈值：coverage < ${(thresholds.coverageLower * 100).toFixed(1)}%（中位数 ${(thresholds.coverageMedian * 100).toFixed(1)}% - 2σ[${thresholds.coverageStd.toFixed(4)}]）或 rounds > ${thresholds.roundsP95.toFixed(1)}（P95）`,
    `- 离群局：${outlierGames.length > 0 ? outlierGames.join(", ") : "（无）"}`,
    ``,
  ]

  const blocks: string[] = []
  const omittedGames: string[] = []
  let lines = header.length
  let chars = header.join("\n").length

  for (const game of games) {
    const bundle = bundles.get(game)!
    const trace = bundle.trace
    if (!trace) {
      omittedGames.push(game)
      continue
    }
    const per = summary.perGame.find((g) => g.gameDir === game)
    const outlierFlags = outlierGames.includes(game) ? " ｜ ⚠离群" : ""
    const nonAction = trace.entries.filter((e) => e.method !== "action")
    const anomalies = trace.entries.filter((e) => isAnomalyEntry(e))
    const blockLines: string[] = []
    blockLines.push(`## ${game} ｜ 结果 ${trace.summary.result} ｜ rounds ${trace.summary.rounds} ｜ seed ${per?.seed ?? "?"} ｜ 执舵 planSide ${per?.planSide ?? "?"}${outlierFlags}`)
    blockLines.push(`### 非 action 决策点（${nonAction.length} 条；含 opening 类，game_summary 不覆盖块）`)
    if (nonAction.length === 0) blockLines.push(`（无）`)
    for (const e of nonAction) blockLines.push(...renderNonActionEntry(game, e, side))
    blockLines.push(``, `### action 决策点（${trace.summary.decisionCounts.total} 条；规则命中 ${trace.summary.decisionCounts.ruleMatched} / fallback ${trace.summary.decisionCounts.fallback}；coverage ${(trace.summary.coverage * 100).toFixed(1)}%）`)
    const gs = servedByKey.get(`game_summary:${game}`)
    if (gs !== undefined) {
      const idx = gs.indexOf("逐决策点：")
      blockLines.push(idx >= 0 ? gs.slice(idx) : gs)
    } else {
      blockLines.push(`（game_summary 文本化不可用）`)
    }
    blockLines.push(``, `### 异常点 decision_detail（${anomalies.length} 条：fallback / thenMiss / declareEnd；无预算全量）`)
    if (anomalies.length === 0) blockLines.push(`（无异常点）`)
    for (const e of anomalies) {
      const content = servedByKey.get(`decision_detail:${game}:${e.seq}`)
      blockLines.push(content ?? `（decision_detail ${game}:${e.seq} 不可用）`, ``)
    }
    blockLines.push(``)
    const text = blockLines.join("\n")
    const textLines = blockLines.length
    // 预算纪律：单局绝不截断；放不下的整局省略（保持单局完整性）
    if (lines + textLines > limits.maxLines || chars + text.length > limits.maxChars) {
      omittedGames.push(game)
      continue
    }
    blocks.push(text)
    lines += textLines
    chars += text.length
  }

  const tail = omittedGames.length > 0
    ? [``, `# …（因总上限省略 ${omittedGames.length} 局：${omittedGames.join(", ")}；其余局的证据见 stateSignatures.jsonl / side1 包）`, ``]
    : [``]
  const text = [...header, ...blocks, ...tail].join("\n")
  return { text, lines: text.split("\n").length, chars: text.length, omittedGames }
}

/** pack 相对路径白名单（organize-run.ts 引用校验同源；manifest.files 为实际子集） */
export function evidenceFileWhitelist(side1Present: boolean): string[] {
  const base = ["fullDigest.txt", "stateSignatures.jsonl", "draw-sequence.md", "outliers.json", "plan.side0.json", "manifest.json"]
  return side1Present ? [...base, "side1/summary.side1.json", "side1/game-*/plan_trace.side1.json"] : base
}
