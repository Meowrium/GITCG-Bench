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
 * tournament-evidence — own-generations 证据适配器（impl-spec-1 §5）。
 *
 * 输入：battles 下 X@(r-1) 持 di 参与的全部 cell 目录（plan 侧与 opponent 侧双向，
 * 含跨模型批与链批）+ X 的当代（r-1）portfolio manifest。
 * 输出：plan:reflect --run-dir 可读的证据组目录（每组 = 一个对手 deck dj 的一个目录，
 * 目录名 vs-<dj>；组 label = basename，即 reflect 统计文本里的"对手组"名）。
 *
 * 与 run-plan-reflect 组装载契约逐字段兼容（run-plan-reflect.ts:335-407 +
 * reflect-portfolio.ts readPortfolioRunArchive/assertPortfolioGroupIds）：
 *   plan.side0.json      = X 当代 portfolio 的 general 计划（--side 0 读）
 *   portfolio.side0.json = manifest + 解析后 planId 清单 + 本组 routing（portfolioId
 *                          断言：与 reflect --portfolio 的 manifest 重算值一致）
 *   summary.json         = X 视角汇总——X 为 plan 侧的批取 summary.json，X 为
 *                          opponent 侧的批取 summary.side1.json（两者本就是各侧
 *                          口径，无需反转），多批按局数加权合并；gameVersion 恒写
 *                          环境版本（reflect checkRunDirVersions 断言消费）
 *   game-<seed>/plan_trace.json = X 视角 trace——opponent 侧批由 plan_trace.side1.json
 *                          翻转而来，deckCodes 由角色序（batch-runner.ts:430 恒
 *                          [主计划牌, 对手牌]）规范化为位置序（与 side0 trace 的
 *                          batch-runner.ts:391 约定一致），保证
 *                          resolveGroupSingleLabel 对两种来源都路由正确
 *   game-<seed>/game_state_log.json = 源局有则拷（battle 侧抽样后幸存的局）
 *
 * 断言（fail-fast）：manifest 经 loadPortfolioWithValidation；贡献批 summary 的
 * gameVersion 必须等于环境版本；组内 seed 不冲突；组装后 portfolioId/planId 复核。
 * 幂等：组目录存在且校验通过 + 来源指纹一致则跳过（原样复制走三级 fallback：
 * symlink → hardlink → copyFile——Windows 无符号链接特权时自动落硬链接，跨卷再落拷贝）。
 */

import { readdir, readFile, writeFile, mkdir, rm, symlink, link, copyFile, access, stat, lstat } from "node:fs/promises"
import { join, relative } from "node:path"
import type { Version } from "@gi-tcg/core"
import type { PlanBatchSummary } from "../../src/runtime/plan-oneshot/batch-runner.js"
import {
  loadPortfolioWithValidation,
  routeSingle,
  type ResolvedPortfolio,
} from "../../src/runtime/plan-oneshot/portfolio.js"
import { parsePairDir, parseCellDir, parsePlayerId } from "./tournament-config.js"

export interface EvidenceGroupResult {
  /** 组目录（abs）——reflect --run-dir 的一个条目 */
  dir: string
  /** 对手 deck 索引（dj） */
  opponentDeckIndex: number
  gameCount: number
  /** true = 已存在且校验通过，本次跳过重建 */
  skipped: boolean
}

export interface EvidenceBuildResult {
  groups: EvidenceGroupResult[]
  totalGames: number
}

export interface BuildEvidenceOptions {
  /** outRoot（abs） */
  outRoot: string
  envLabel: string
  /** 环境版本（贡献批 summary.gameVersion 断言 + 产物 gameVersion 字段） */
  gameVersion: Version
  /** 环境 decks 分享码数组（索引 = di/dj；routing 解析用） */
  deckCodes: string[]
  /** 本方模型 X */
  model: string
  /** 本方 deck 索引 di */
  holdIndex: number
  /** 目标代数 r：证据取自 r-1 轮 X@(r-1) 参与的全部对局 */
  round: number
  /** X 当代（r-1）portfolio manifest（abs） */
  manifestPath: string
}

// ── 收集期结构 ───────────────────────────────────────────────────────────

/** PlanBatchSummary + 收集期标注（X 视角 trace 文件名；__xSide 不落盘） */
type XBatchSummary = PlanBatchSummary & { __xSide: "plan_trace.json" | "plan_trace.side1.json" }

interface XViewBatch {
  /** 批目录（abs） */
  dir: string
  /** 相对 outRoot（指纹用） */
  relDir: string
  summary: XBatchSummary
  /** 对手 deck 索引（dj） */
  opponentDeckIndex: number
}

interface XViewGame {
  seed: number
  /** evidence 局目录名（组内按 seed 唯一） */
  evidenceGameDir: string
  /** 源 trace 文件名（plan 侧批 = plan_trace.json；opponent 侧批 = plan_trace.side1.json） */
  sourceTraceName: "plan_trace.json" | "plan_trace.side1.json"
  sourceBatchDir: string
  sourceGameDir: string
  /** 是否需要 deckCodes 位置序规范化（opponent 侧批翻转时） */
  needsDeckCodeNormalization: boolean
  /** 源批 seedBase（renameMap 键的一部分：跨批 game-NNNN 会撞名） */
  sourceSeedBase: number
  perGame: PlanBatchSummary["perGame"][number]
}

interface EvidenceFingerprint {
  portfolioId: string
  generalPlanId: string
  /** 贡献批（相对 outRoot）+ 各自局数；来源变化 → 重建 */
  sources: Array<{ relDir: string; games: number }>
  totalGames: number
}

// ── 主入口 ───────────────────────────────────────────────────────────────

export async function buildEvidenceGroups(opts: BuildEvidenceOptions): Promise<EvidenceBuildResult> {
  const { outRoot, envLabel, gameVersion, deckCodes, model, holdIndex, round } = opts
  const prevRound = round - 1
  if (prevRound < 0) throw new Error(`evidence：round 必须 ≥1（实为 ${round}；r0 无证据对局）`)

  // manifest 装载 + G8 校验（fail-fast 抛错由调用方处理）
  const { portfolio: loaded, warnings } = await loadPortfolioWithValidation(opts.manifestPath)
  for (const w of warnings) console.warn(`[evidence][portfolio warn] ${w}`)

  // 扫描 battles：收集 X@(r-1) 持 di 参与的全部批（双向）
  const batches = await collectXBatches(opts)
  if (batches.length === 0) {
    return { groups: [], totalGames: 0 }
  }

  // 按对手 deck dj 分组；局按 seed 定 evidence 目录名（组内唯一性断言）
  const groupGames = new Map<number, Map<number, XViewGame>>() // dj → seed → game
  const groupSources = new Map<number, XViewBatch[]>()
  for (const batch of batches) {
    const dj = batch.opponentDeckIndex
    let bySeed = groupGames.get(dj)
    if (!bySeed) groupGames.set(dj, (bySeed = new Map()))
    for (const g of batch.summary.perGame) {
      if (bySeed.has(g.seed)) {
        throw new Error(`evidence：seed 冲突（dj=${dj} seed=${g.seed}，来自 ${batch.relDir}）——seed 派生应保证唯一，请检查`)
      }
      bySeed.set(g.seed, {
        seed: g.seed,
        evidenceGameDir: `game-${g.seed}`,
        sourceTraceName: batch.summary.__xSide,
        sourceBatchDir: batch.dir,
        sourceGameDir: g.gameDir,
        needsDeckCodeNormalization: batch.summary.__xSide === "plan_trace.side1.json",
        sourceSeedBase: batch.summary.seedBase,
        perGame: g,
      })
    }
    const list = groupSources.get(dj) ?? []
    list.push(batch)
    groupSources.set(dj, list)
  }

  // 逐组组装
  const evidenceRoot = join(outRoot, "evidence", model, envLabel, String(holdIndex), `r${round}`)
  const groups: EvidenceGroupResult[] = []
  let totalGames = 0
  const djSorted = [...groupGames.keys()].sort((a, b) => a - b)
  for (const dj of djSorted) {
    const games = [...groupGames.get(dj)!.values()].sort((a, b) => a.seed - b.seed)
    const sources = groupSources.get(dj)!
    const groupDir = join(evidenceRoot, `vs-${dj}`)
    const fingerprint = fingerprintOf(loaded, sources, games.length)
    if (await groupUpToDate(groupDir, fingerprint, loaded, gameVersion)) {
      groups.push({ dir: groupDir, opponentDeckIndex: dj, gameCount: games.length, skipped: true })
      totalGames += games.length
      continue
    }
    await rm(groupDir, { recursive: true, force: true })
    await mkdir(groupDir, { recursive: true })

    // plan.side0.json = X 当代 portfolio 的 general 计划
    await writeFile(join(groupDir, "plan.side0.json"), `${JSON.stringify(loaded.general, null, 2)}\n`, "utf-8")
    // portfolio.side0.json = manifest + 解析后 planId 清单 + 本组 routing（X 为 side0）
    const djCode = deckCodes[dj]
    if (!djCode) throw new Error(`evidence：deckCodes[${dj}] 不存在`)
    const routed = routeSingle(loaded, djCode)
    const archive = {
      ...loaded.manifest,
      portfolioId: loaded.portfolioId,
      resolved: {
        generalId: loaded.generalId,
        singles: Object.fromEntries(
          loaded.singles.map((s) => [s.label, { opponentDeckCode: s.opponentDeckCode, planId: s.planId }]),
        ),
      },
      routing: routed ? (`single:${routed.label}` as const) : ("general-only" as const),
    }
    await writeFile(join(groupDir, "portfolio.side0.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf-8")
    // 逐局 trace 翻转/拷贝 + state log 有则拷
    const renameMap = new Map<string, string>()
    for (const g of games) {
      renameMap.set(`${g.sourceSeedBase}|${g.sourceGameDir}`, g.evidenceGameDir)
      const dstDir = join(groupDir, g.evidenceGameDir)
      await mkdir(dstDir, { recursive: true })
      const srcTracePath = join(g.sourceBatchDir, g.sourceGameDir, g.sourceTraceName)
      const dstTracePath = join(dstDir, "plan_trace.json")
      if (g.needsDeckCodeNormalization) {
        const trace = JSON.parse(await readFile(srcTracePath, "utf-8")) as { deckCodes?: [string, string] | null; side?: number }
        await writeFile(dstTracePath, `${JSON.stringify(normalizeDeckCodes(trace), null, 2)}\n`, "utf-8")
      } else {
        await linkOrCopy(srcTracePath, dstTracePath)
      }
      const srcLogPath = join(g.sourceBatchDir, g.sourceGameDir, "game_state_log.json")
      if (await exists(srcLogPath)) {
        await linkOrCopy(srcLogPath, join(dstDir, "game_state_log.json"))
      } else {
        // lean trace（traceSignatures="lean"）的签名反查依赖同局 state log：
        // 缺失（跨模型批 state log 抽样删除）时如实告警——该局局面摘要将降级"(无 state)"
        try {
          const t = JSON.parse(await readFile(join(dstDir, "plan_trace.json"), "utf-8")) as { traceSignatures?: string }
          if (t.traceSignatures === "lean") {
            console.warn(`[evidence] warn: ${groupDir}/${g.evidenceGameDir} 为 lean trace 但源批缺 game_state_log.json（state log 抽样删除？）——签名不可反查，reflect/organizer 局面摘要降级"(无 state)"`)
          }
        } catch { /* trace 读取失败由组装后自检兜住 */ }
      }
    }
    // summary.json = X 视角合并汇总（perGame.gameDir 对齐 evidence 目录名）
    const merged = mergeXViewSummaries(sources.map((b) => b.summary), gameVersion, renameMap)
    await writeFile(join(groupDir, "summary.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf-8")
    // 来源指纹（幂等新鲜度判定）
    await writeFile(join(groupDir, "evidence.fingerprint.json"), `${JSON.stringify(fingerprint, null, 2)}\n`, "utf-8")

    // 组装后断言（fail-fast）：portfolioId/planId 一致 + 逐局 trace 存在
    const archiveCheck = JSON.parse(await readFile(join(groupDir, "portfolio.side0.json"), "utf-8")) as { portfolioId?: string }
    const planCheck = JSON.parse(await readFile(join(groupDir, "plan.side0.json"), "utf-8")) as { planId?: string }
    if (archiveCheck.portfolioId !== loaded.portfolioId || planCheck.planId !== loaded.general.planId) {
      throw new Error(`evidence：组装后自检失败（${groupDir}）——portfolioId/planId 与 manifest 不一致`)
    }
    for (const g of games) {
      await access(join(groupDir, g.evidenceGameDir, "plan_trace.json"))
    }
    groups.push({ dir: groupDir, opponentDeckIndex: dj, gameCount: games.length, skipped: false })
    totalGames += games.length
  }
  return { groups, totalGames }
}

// ── 批收集 ───────────────────────────────────────────────────────────────

async function collectXBatches(opts: BuildEvidenceOptions): Promise<XViewBatch[]> {
  const { outRoot, envLabel, gameVersion, model, holdIndex } = opts
  const prevRound = opts.round - 1
  const battlesRoot = join(outRoot, "battles")
  const result: XViewBatch[] = []
  let pairNames: string[] = []
  try {
    pairNames = (await readdir(battlesRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return result
  }
  for (const pairName of pairNames) {
    const pair = parsePairDir(pairName)
    if (!pair) continue
    const envRoot = join(battlesRoot, pairName, envLabel)
    let cellNames: string[] = []
    try {
      cellNames = (await readdir(envRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const cellName of cellNames) {
      const cell = parseCellDir(cellName)
      if (!cell) continue
      const planP = parsePlayerId(pair.planPlayerId)
      const oppP = parsePlayerId(pair.oppPlayerId)
      if (!planP || !oppP) continue
      // X 视角判定：plan 侧持 di（读 side0 口径）或 opponent 侧持 di（读 side1 口径）
      let xSide: "plan_trace.json" | "plan_trace.side1.json" | null = null
      let opponentDeckIndex: number | null = null
      if (planP.model === model && planP.round === prevRound && cell.di === holdIndex) {
        xSide = "plan_trace.json"
        opponentDeckIndex = cell.dj
      } else if (oppP.model === model && oppP.round === prevRound && cell.dj === holdIndex) {
        xSide = "plan_trace.side1.json"
        opponentDeckIndex = cell.di
      }
      if (xSide === null || opponentDeckIndex === null) continue
      const batchDir = join(envRoot, cellName)
      // 批完整性判定按 X 视角 summary（plan 侧批恒有 summary.json；opponent 侧批恒有
      // summary.side1.json——batch-runner 两侧 summary 同步写，缺一即批未完成）
      if (!(await exists(join(batchDir, xSide === "plan_trace.json" ? "summary.json" : "summary.side1.json")))) continue

      const summaryName = xSide === "plan_trace.json" ? "summary.json" : "summary.side1.json"
      const summary = JSON.parse(await readFile(join(batchDir, summaryName), "utf-8")) as XBatchSummary
      if (summary.gameVersion === undefined) {
        throw new Error(`evidence：贡献批 ${batchDir} 的 ${summaryName} 未标注 gameVersion（旧产物）——版本钉扎 fail-fast`)
      }
      if (summary.gameVersion !== gameVersion) {
        throw new Error(
          `evidence：贡献批 ${batchDir} 版本 ${summary.gameVersion} 与环境版本 ${gameVersion} 不一致——版本钉扎 fail-fast`,
        )
      }
      summary.__xSide = xSide
      result.push({ dir: batchDir, relDir: relative(outRoot, batchDir), summary, opponentDeckIndex })
    }
  }
  return result
}

// ── 视角翻转辅助 ─────────────────────────────────────────────────────────

/**
 * deckCodes 位置序规范化（opponent 侧批翻转时）：side1 trace 的 deckCodes 恒为
 * 角色序 [主计划牌, 对手牌]（batch-runner.ts:430，不随执舵位换序），而 side0 trace
 * 为位置序（codes[position] = 该位玩家的牌，batch-runner.ts:391）。翻转拷贝后
 * trace.side = X 的实际执舵位，规范化为位置序使 resolveGroupSingleLabel 的
 * codes[1 - trace.side] = 对手牌对两种来源都成立。
 */
function normalizeDeckCodes(trace: { deckCodes?: [string, string] | null; side?: number }): typeof trace {
  const codes = trace.deckCodes
  if (!codes || codes.length !== 2) return trace
  const p = trace.side === 1 ? 1 : 0
  // 角色序：codes[0] = 主计划（对手 Y）牌，codes[1] = 对手位（X 自己）牌
  const yDeck = codes[0]!
  const xDeck = codes[1]!
  const ordered: [string, string] = p === 0 ? [xDeck, yDeck] : [yDeck, xDeck]
  return { ...trace, deckCodes: ordered }
}

/** X 视角多批合并汇总（summary 字段按局数加权/求和，与 batch-runner 聚合口径一致） */
function mergeXViewSummaries(
  parts: Array<PlanBatchSummary>,
  gameVersion: Version,
  renameMap: Map<string, string>,
): Record<string, unknown> {
  let games = 0
  let wins = 0
  let losses = 0
  let draws = 0
  let roundsSum = 0
  let coverageSum = 0
  let fallback = 0
  let total = 0
  const perRuleHits: Record<string, number> = {}
  const perRuleThenMiss: Record<string, number> = {}
  const perGame: PlanBatchSummary["perGame"] = []
  for (const s of parts) {
    games += s.games
    wins += s.wins
    losses += s.losses
    draws += s.draws
    roundsSum += s.avgRounds * s.games
    coverageSum += s.avgCoverage * s.games
    for (const g of s.perGame) {
      fallback += g.fallback
      total += g.total
      const renamed = renameMap.get(`${s.seedBase}|${g.gameDir}`) ?? g.gameDir
      perGame.push({ ...g, gameDir: renamed })
    }
    for (const [k, v] of Object.entries(s.perRuleHits)) perRuleHits[k] = (perRuleHits[k] ?? 0) + v
    for (const [k, v] of Object.entries(s.perRuleThenMiss ?? {})) perRuleThenMiss[k] = (perRuleThenMiss[k] ?? 0) + v
  }
  perGame.sort((a, b) => a.gameDir.localeCompare(b.gameDir))
  return {
    gameVersion,
    games,
    wins,
    losses,
    draws,
    winRate: games > 0 ? wins / games : 0,
    avgRounds: games > 0 ? roundsSum / games : 0,
    avgCoverage: games > 0 ? coverageSum / games : 0,
    fallbackRate: total > 0 ? fallback / total : 0,
    perRuleHits,
    perRuleThenMiss,
    perGame,
  }
}

// ── 幂等与指纹 ───────────────────────────────────────────────────────────

function fingerprintOf(loaded: ResolvedPortfolio, sources: XViewBatch[], totalGames: number): EvidenceFingerprint {
  return {
    portfolioId: loaded.portfolioId,
    generalPlanId: loaded.general.planId,
    sources: sources
      .map((b) => ({ relDir: b.relDir, games: b.summary.games }))
      .sort((a, b) => a.relDir.localeCompare(b.relDir)),
    totalGames,
  }
}

/** 组目录是否已存在且校验通过 + 指纹一致（通过则跳过重建） */
async function groupUpToDate(
  groupDir: string,
  fingerprint: EvidenceFingerprint,
  loaded: ResolvedPortfolio,
  gameVersion: Version,
): Promise<boolean> {
  try {
    const fp = JSON.parse(await readFile(join(groupDir, "evidence.fingerprint.json"), "utf-8")) as EvidenceFingerprint
    if (JSON.stringify(fp) !== JSON.stringify(fingerprint)) return false
    const archive = JSON.parse(await readFile(join(groupDir, "portfolio.side0.json"), "utf-8")) as { portfolioId?: string }
    if (archive.portfolioId !== loaded.portfolioId) return false
    const plan = JSON.parse(await readFile(join(groupDir, "plan.side0.json"), "utf-8")) as { planId?: string }
    if (plan.planId !== loaded.general.planId) return false
    const summary = JSON.parse(await readFile(join(groupDir, "summary.json"), "utf-8")) as { gameVersion?: string }
    if (summary.gameVersion !== gameVersion) return false
    const entries = await readdir(groupDir, { withFileTypes: true })
    const gameDirs = entries.filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    if (gameDirs.length === 0) return false
    for (const g of gameDirs) await access(join(groupDir, g.name, "plan_trace.json"))
    return true
  } catch {
    return false
  }
}

// ── 文件系统辅助 ─────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 原样复制的三级 fallback：symlink → hardlink（fs.link，同卷免特权）→ copyFile。
 * 仅用于**字节原样**复制（plan 侧直拷 trace、state log）；视角翻转的拷贝（内容被
 * 改写）必须走真拷贝（writeFile），绝不进本函数。
 *
 * 硬链接安全性（impl-spec-1 件 2）：evidence 组装后组内 trace / state log 只读
 * （reflect / organize-export 只读消费），组内无就地改写——本文件的重Build走
 * rm + 重建（unlink 只摘除组内目录项，源批文件不受影响）；battle 侧事后删除
 * state log（sampleStateLogs 抽样）同样只摘源目录项，组内副本内容保持完整。
 * 相比 copyFile 免去 ~0.4MB/局 的磁盘与时间开销，且源被清理后内容仍可达。
 */
export async function linkOrCopy(src: string, dst: string): Promise<void> {
  try {
    await symlink(src, dst, "file")
    return
  } catch {
    // Windows 无符号链接特权等场景 → 落到硬链接
  }
  try {
    await link(src, dst)
    return
  } catch {
    // 跨卷（EXDEV）等场景 → 落到真拷贝
  }
  await copyFile(src, dst)
}

/**
 * 硬链接判定：dst 不是符号链接（lstat），且与 src 共享同一 inode（dev+ino 相等）。
 * 注意不可用 nlink 判定——Windows（libuv）对硬链接的 nlink 可能恒报 1；
 * stat 会穿透符号链接，必须先 lstat 排除。
 */
export async function isHardlinkOf(src: string, dst: string): Promise<boolean> {
  try {
    const lst = await lstat(dst)
    if (lst.isSymbolicLink()) return false
    const [a, b] = await Promise.all([stat(src), stat(dst)])
    return a.ino === b.ino && a.dev === b.dev
  } catch {
    return false
  }
}
