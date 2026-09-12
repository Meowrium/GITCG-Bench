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
 * tree-bench 分析 CLI:一次锦标赛结束后,输出 Glicko-2 榜 + ratings-history + heatmap + spinning-top 诊断。
 *
 * 用法(在 packages/benchmark 下):
 *   pnpm analyze --input <results.json> [--out <dir>] [--bootstrap 200] [--dense-subset <minGamesPerPair>]
 *   pnpm analyze:demo          # 用内置合成数据(循环组 + 尖塔)演示
 *
 * 输入 JSON:见 ../results.ts 的文档。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { applyRatingPeriod, newRatedAgent, rankedAgents, type RatedAgent } from "../glicko2"
import { renderHeatmapSvg } from "../heatmap"
import type { GameResult } from "../results"
import { buildPairCounts, buildWinProbMatrix, collectAgentIds, collectPairs, parseGameResult } from "../results"
import { bootstrapSpinTop, mulberry32, spinningTopReport } from "../spin-top"

interface CliArgs {
  input?: string
  demo: boolean
  out: string
  bootstrap: number
  eps: number
  rawEdges: boolean
  seed: number
  /** 稠密子锦标赛过滤:每对至少对局数(0 = 不过滤) */
  denseSubset: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { demo: false, out: "", bootstrap: 200, eps: 0, rawEdges: false, seed: 42, denseSubset: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case "--input":
        args.input = argv[++i]
        break
      case "--demo":
        args.demo = true
        break
      case "--out":
        args.out = argv[++i] ?? ""
        break
      case "--bootstrap":
        args.bootstrap = Number(argv[++i] ?? 0)
        break
      case "--eps":
        args.eps = Number(argv[++i] ?? 0)
        break
      case "--raw-edges":
        args.rawEdges = true
        break
      case "--seed":
        args.seed = Number(argv[++i] ?? 42)
        break
      case "--dense-subset":
        args.denseSubset = Number(argv[++i] ?? 0)
        break
      case "--help":
      case "-h":
        console.log(
          "用法: gnx tree-bench/src/cli/analyze.ts [--input <json>|--demo] " +
            "[--out <dir>] [--bootstrap <n>] [--eps <x>] [--raw-edges] [--seed <n>] " +
            "[--dense-subset <minGamesPerPair>]",
        )
        process.exit(0)
      default:
        throw new Error(`未知参数: ${a}`)
    }
  }
  if (!Number.isInteger(args.denseSubset) || args.denseSubset < 0) {
    throw new Error("--dense-subset 必须是 ≥0 的整数(每对最少对局数,0 = 不过滤)")
  }
  if (!args.input && !args.demo) {
    throw new Error("需要 --input <json> 或 --demo")
  }
  args.out = args.out || join(import.meta.dirname, "..", "..", "out")
  return args
}

/**
 * 内置合成数据:3 个循环选手(0.72 克制环)+ 2 个传递尖塔选手
 * (D 压循环组 0.80;E 压 D 0.66、小压循环组 0.70),每对 80 局,含少量平局。
 * 梯度刻意留得够大,让 Wilson 95% 判边在 80 局/对下稳定还原真实结构。
 */
function generateDemoResults(seed: number, gamesPerPair = 80): GameResult[] {
  const agents = ["循环A", "循环B", "循环C", "尖塔D", "尖塔E"]
  const prob = new Map<string, number>()
  const set = (i: number, j: number, v: number): void => {
    prob.set(`${i}>${j}`, v)
    prob.set(`${j}>${i}`, 1 - v)
  }
  set(0, 1, 0.72)
  set(1, 2, 0.72)
  set(2, 0, 0.72) // 循环组
  for (let i = 0; i < 3; i++) set(3, i, 0.8) // D 压循环组
  set(4, 3, 0.66) // E 压 D
  for (let i = 0; i < 3; i++) set(4, i, 0.7) // E 小压循环组

  const rng = mulberry32(seed)
  const out: GameResult[] = []
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const w = prob.get(`${i}>${j}`)!
      for (let k = 0; k < gamesPerPair; k++) {
        const r = rng()
        const winner = r < w ? "p1" : r < w + 0.06 ? "draw" : "p2"
        out.push({ p1: agents[i]!, p2: agents[j]!, winner, period: Math.floor(k / 5) })
      }
    }
  }
  return out
}

function fmt(x: number, digits = 0): string {
  return x.toFixed(digits)
}

/**
 * 稠密子锦标赛筛选:返回最大子集,使得子集内每一对选手的对局数都 ≥ threshold。
 * 贪心策略:只要还存在未达标的选手对,就剔除「达标连接数最少」的选手
 * (平局时取序号更小者,保证确定性);只剩 1 人时终止。
 */
function denseSubsetIds(ids: string[], counts: number[][], threshold: number): string[] {
  if (threshold <= 0) return ids
  const kept = new Set<number>(ids.map((_, i) => i))
  while (kept.size > 1) {
    let worst = -1
    let worstQ = Number.POSITIVE_INFINITY
    for (const i of kept) {
      let q = 0
      for (const j of kept) {
        if (j !== i && counts[i]![j]! >= threshold) q += 1
      }
      if (q < worstQ) {
        worstQ = q
        worst = i
      }
    }
    if (worstQ >= kept.size - 1) break // 子集内全部选手对都达标
    kept.delete(worst!)
  }
  return ids.filter((_, i) => kept.has(i))
}

function printGlicko(agents: RatedAgent[]): void {
  const w = Math.max(8, ...agents.map((a) => a.id.length))
  console.log("  " + "Agent".padEnd(w) + "  Rating  ±RD    σ    W   L   D")
  console.log("  " + "-".repeat(w + 38))
  for (const a of agents) {
    console.log(
      `  ${a.id.padEnd(w)}  ${fmt(a.player.mu, 0).padStart(6)}  ${fmt(a.player.phi, 0).padStart(5)}  ` +
        `${fmt(a.player.sigma, 3).padStart(5)}  ${String(a.wins).padStart(3)}  ${String(a.losses).padStart(3)}  ` +
        `${String(a.draws).padStart(3)}`,
    )
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const results = args.demo ? generateDemoResults(args.seed) : loadResults(args.input!)

  if (results.length === 0) {
    throw new Error("没有可用的对局记录")
  }
  const agentIds = collectAgentIds(results)

  // ---------- 1. Glicko-2 ----------
  const agents = new Map<string, RatedAgent>()
  for (const id of agentIds) agents.set(id, newRatedAgent(id))
  const periods = new Map<number, GameResult[]>()
  for (const g of results) {
    const p = g.period ?? 0
    let list = periods.get(p)
    if (!list) {
      list = []
      periods.set(p, list)
    }
    list.push(g)
  }
  /** 每期更新后的全体已进池选手状态(本期更新后语义,末态与 ratings.json 一致) */
  const history: Array<{
    period: number
    players: Array<{ id: string; mu: number; phi: number; sigma: number }>
  }> = []
  // 已进池选手(至少打过一局);未进池者不出现在该期及之前的历史记录中
  const joined = new Set<string>()
  for (const p of [...periods.keys()].sort((a, b) => a - b)) {
    const games = periods.get(p)!
    for (const g of games) {
      joined.add(g.p1)
      joined.add(g.p2)
    }
    applyRatingPeriod(agents, games)
    history.push({
      period: p,
      players: [...agents.values()]
        .filter((a) => joined.has(a.id))
        .map((a) => ({ id: a.id, mu: a.player.mu, phi: a.player.phi, sigma: a.player.sigma })),
    })
  }
  const ranked = rankedAgents(agents)
  // 统一顺序:Glicko 榜序(heatmap/spin-top 的行列都按此排序)
  const orderedIds = ranked.map((a) => a.id)

  // ---------- 2. 胜率矩阵 + heatmap ----------
  const A = buildWinProbMatrix(orderedIds, results)
  const counts = buildPairCounts(orderedIds, results)
  const pairs = [...collectPairs(results).values()].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  // coverage:实交手对数 / 总对数(计算层对无对局格仍填 0.5,呈现层以 gamesMatrix===0 区分)
  const nAll = orderedIds.length
  const pairsTotal = (nAll * (nAll - 1)) / 2
  let pairsPlayed = 0
  for (let i = 0; i < nAll; i++) {
    for (let j = i + 1; j < nAll; j++) {
      if (counts[i]![j]! > 0) pairsPlayed += 1
    }
  }
  const coverage = { pairsTotal, pairsPlayed, ratio: pairsTotal > 0 ? pairsPlayed / pairsTotal : 0 }

  // ---------- 3. Spinning-top ----------
  // 稀疏池下,分解只在稠密子锦标赛上做:保留"与其余入选选手每对都 ≥ threshold 局"
  // 的最大子集(贪心:反复剔除具备未达标对、且达标连接数最少的选手)。
  let spinIds = orderedIds
  let spinA = A
  let spinCounts: number[][] | undefined = counts
  let spinResults = results
  let usedSubset: { threshold: number; players: string[] } | undefined
  if (args.denseSubset > 0) {
    spinIds = denseSubsetIds(orderedIds, counts, args.denseSubset)
    const indexOf = new Map(orderedIds.map((id, i) => [id, i]))
    const inSubset = new Set(spinIds)
    spinA = spinIds.map((id) => {
      const i = indexOf.get(id)!
      return spinIds.map((id2) => A[i]![indexOf.get(id2)!]!)
    })
    spinCounts = spinIds.map((id) => {
      const i = indexOf.get(id)!
      return spinIds.map((id2) => counts[i]![indexOf.get(id2)!]!)
    })
    spinResults = results.filter((g) => inSubset.has(g.p1) && inSubset.has(g.p2))
    usedSubset = { threshold: args.denseSubset, players: spinIds }
  }
  const report = spinningTopReport(spinIds, spinA, {
    eps: args.eps,
    // 默认用 Wilson 95% 单侧检验判边(噪声鲁棒);--raw-edges 退化为裸 >0.5+eps
    counts: args.rawEdges ? undefined : spinCounts,
  })
  const boot = args.bootstrap > 0 ? bootstrapSpinTop(spinResults, spinIds, args.bootstrap, args.seed) : null

  // ---------- 输出 ----------
  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, "ratings.json"), JSON.stringify({
    agents: Object.fromEntries(ranked.map((a) => [a.id, { ...a.player, wins: a.wins, losses: a.losses, draws: a.draws }])),
    periods: periods.size,
    nGames: results.length,
  }, null, 2))
  writeFileSync(join(args.out, "ratings-history.json"), JSON.stringify({ periods: history }, null, 2))
  writeFileSync(join(args.out, "heatmap.svg"), renderHeatmapSvg(orderedIds, A, { title: "配对胜率 (冷色=行更强)" }))
  writeFileSync(join(args.out, "heatmap.json"), JSON.stringify({ agents: orderedIds, winProbMatrix: A, gamesMatrix: counts, coverage, pairs }, null, 2))
  writeFileSync(join(args.out, "spin-top.json"), JSON.stringify(usedSubset ? { usedSubset, report, bootstrap: boot } : { report, bootstrap: boot }, null, 2))

  const src = args.demo ? "合成演示数据" : args.input
  console.log(`\n==== tree-bench 分析(${src}, ${results.length} 局, ${agentIds.length} 名选手, ${periods.size} 个 rating period) ====`)
  console.log(
    `  coverage: ${coverage.pairsPlayed}/${coverage.pairsTotal} 对交手(${fmt(coverage.ratio * 100, 1)}%)` +
      (args.denseSubset > 0 ? `  |  稠密子集: ${spinIds.length}/${orderedIds.length} 名选手(每对 ≥ ${args.denseSubset} 局)` : ""),
  )
  console.log("\n-- Glicko-2 排行榜 --")
  printGlicko(ranked)

  const dec = report.decomposition
  console.log("\n-- Spinning-top 诊断 --")
  console.log(`  传递占比 ${fmt(dec.transitiveShare * 100, 1)}%  |  循环占比 ${fmt(dec.cyclicShare * 100, 1)}%`)
  if (boot) {
    console.log(
      `  传递占比 bootstrap 95% 区间: [${fmt(boot.transitiveShareCI[0] * 100, 1)}%, ${fmt(boot.transitiveShareCI[1] * 100, 1)}%]`,
    )
  }
  console.log(`  尖塔(可信排序):${report.spire.length > 0 ? " " + report.spire.join(" > ") : " (无,顶部即循环团块)"}`)
  if (report.cyclicClusters.length > 0) {
    console.log(`  循环团块(内部不可排序): ${report.cyclicClusters.map((c) => `{${c.join(", ")}}`).join("  ")}`)
  } else {
    console.log("  循环团块: 无(榜单整体可信)")
  }
  console.log("\n-- Nash averaging(面对均衡混合对手的期望胜率) --")
  const w2 = Math.max(8, ...spinIds.map((id) => id.length))
  for (let i = 0; i < spinIds.length; i++) {
    const ci = boot ? `  [${fmt(boot.strengthCI[i]![0] * 100, 1)}%, ${fmt(boot.strengthCI[i]![1] * 100, 1)}%]` : ""
    console.log(
      `  ${spinIds[i]!.padEnd(w2)}  Nash=${fmt(report.nash.ratings[i]! * 100, 1).padStart(5)}%  ` +
        `v=${fmt(dec.strength[i]! * 100, 1).padStart(6)}%${ci}`,
    )
  }
  console.log("\n输出目录:", args.out)
}

function loadResults(path: string): GameResult[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(raw)) {
    throw new Error(`输入文件 ${path} 应为对局数组`)
  }
  return raw.map((r, i) => parseGameResult(r, i))
}

main()
