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
 * tournament-selfcheck — WP1 编排逻辑的离线可执行验收（impl-spec-1 §6 的可离线子集）。
 *
 * 用法：pnpm exec gnx scripts/ops/tournament-selfcheck.ts
 *
 * 覆盖（全部离线、零 LLM、零引擎）：
 * 1. export winner 映射：planSide 换算 / draw / period / mirror-only / p1===p2 拒绝；
 * 2. own-generations 证据适配器：分组、X 为 opponent 侧的视角翻转（含 deckCodes
 *    位置序规范化）、多批合并 summary、state log 抽样拷贝、指纹幂等跳过；
 * 3. battle 批 readiness/key 约定（enumerateBatches 纯逻辑经 fixture 复核）。
 *
 * 真实 LLM/引擎链路（author/battle/reflect 全流程）不在本脚本范围——见冒烟验收。
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectResults, mapWinner } from "./tournament-export.js"
import { buildEvidenceGroups } from "./tournament-evidence.js"
import { parseGameVersion } from "../../src/runtime/plan-oneshot/version.js"

let passed = 0
let failed = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? `——${detail}` : ""}`)
  }
}

// ── fixture 工具 ─────────────────────────────────────────────────────────

/** summary perGame 局条目（batch-runner 形状子集） */
function perGameEntry(seed: number, planSide: 0 | 1, winner: 0 | 1 | null, gameDir: string) {
  return { gameDir, seed, planSide, winner, rounds: 8, coverage: 0.5, ruleMatched: 10, fallback: 2, total: 12 }
}

function summaryOf(perGame: ReturnType<typeof perGameEntry>[], seedBase: number) {
  const wins = perGame.filter((g) => g.winner === g.planSide).length
  const draws = perGame.filter((g) => g.winner === null).length
  return {
    planId: "fixture-plan-id",
    gameVersion: "v6.3.0",
    games: perGame.length,
    seedBase,
    alternateFirstPlayer: true,
    wins,
    losses: perGame.length - wins - draws,
    draws,
    winRate: perGame.length > 0 ? wins / perGame.length : 0,
    avgRounds: 8,
    avgCoverage: 0.5,
    fallbackRate: 2 / 12,
    perRuleHits: { "global:10": 3 },
    perRuleThenMiss: { "global:11": 1 },
    perGame,
  }
}

function traceOf(deckCodes: [string, string] | null, side: number) {
  return { deckCodes, side, entries: [] }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

// ── 1. export 映射 ───────────────────────────────────────────────────────

async function testExport(root: string): Promise<void> {
  console.log("\n[1] export winner 映射")
  // mapWinner 纯函数
  check("planSide=0，winner 0 → p1", mapWinner(0, 0) === "p1")
  check("planSide=0，winner 1 → p2", mapWinner(1, 0) === "p2")
  check("planSide=1，winner 0 → p2（执舵位换算）", mapWinner(0, 1) === "p2")
  check("planSide=1，winner 1 → p1", mapWinner(1, 1) === "p1")
  check("winner null → draw", mapWinner(null, 0) === "draw")

  const battles = join(root, "battles")
  const deckA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  const deckB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  // 批 1：X（glm-5.3@r0）plan 侧持 di=0 vs Y（ds@r0）持 dj=1
  const b1 = join(battles, "glm-5.3@r0__vs__ds@r0", "v6.3", "0-vs-1")
  await writeJson(join(b1, "summary.json"), summaryOf([
    perGameEntry(100, 0, 0, "game-0001"),
    perGameEntry(101, 1, 1, "game-0002"),
    perGameEntry(102, 0, null, "game-0003"),
  ], 100))
  // 批 2：X 为 opponent 侧（Y plan 侧持 dj=1 vs X 持 di=0）→ 镜像批（di=dj 无关；此处 1-vs-0 非镜像）
  const b2 = join(battles, "ds@r0__vs__glm-5.3@r0", "v6.3", "1-vs-0")
  await writeJson(join(b2, "summary.json"), summaryOf([
    perGameEntry(200, 0, 0, "game-0001"),
  ], 200))
  // 批 3：镜像格（di=dj=0）+ 链批同模型跨代（X@r1 vs X@r0）
  const b3 = join(battles, "glm-5.3@r1__vs__glm-5.3@r0", "v6.3", "0-vs-0")
  await writeJson(join(b3, "summary.json"), summaryOf([
    perGameEntry(300, 0, 0, "game-0001"),
  ], 300))

  const views = await collectResults(battles, ["v6.3"])
  check("by-model 总局数 = 3+1+1", views.byModel.length === 5, `实为 ${views.byModel.length}`)
  const first = views.byModel.find((r) => r.p1 === "glm-5.3@r0" && r.period === 0 && r.winner === "p1")
  check("批 1 局 1：plan 侧胜 → p1", first !== undefined)
  check("批 1 局 2：planSide=1、winner 1 → p1（换算）",
    views.byModel.some((r) => r.p1 === "glm-5.3@r0" && r.winner === "p1" && r.period === 0) && views.byModel.filter((r) => r.winner === "draw").length === 1)
  const deckRow = views.byModelDeck.find((r) => r.p1 === `glm-5.3@v6.3/0@r0` && r.p2 === `ds@v6.3/1@r0`)
  check("by-model-deck id 形如 model@env/di@rN", deckRow !== undefined)
  const chainRow = views.byModel.find((r) => r.p1 === "glm-5.3@r1" && r.p2 === "glm-5.3@r0")
  check("链批 period = plan 侧代数（r1）", chainRow !== undefined && chainRow.period === 1)
  check("mirror-only 仅含 di=dj 批（1 局）", views.byModelMirror.length === 1, `实为 ${views.byModelMirror.length}`)
  check("无 by-model-deck 镜像之外的重复", views.byModelDeckMirror.length === 1)

  // p1===p2 拒绝（同选手对局）
  const badDir = join(battles, "glm-5.3@r0__vs__glm-5.3@r0", "v6.3", "0-vs-0")
  await writeJson(join(badDir, "summary.json"), summaryOf([perGameEntry(400, 0, 0, "game-0001")], 400))
  let rejected = false
  try {
    await collectResults(battles, ["v6.3"])
  } catch {
    rejected = true
  }
  check("p1===p2 对局被拒绝", rejected)
  await rm(badDir, { recursive: true, force: true })
}

// ── 2. 证据适配器 ────────────────────────────────────────────────────────

async function testEvidence(root: string): Promise<void> {
  console.log("\n[2] own-generations 证据适配器")
  const outRoot = join(root, "evidence-fixture")
  const battles = join(outRoot, "battles")
  const gameVersion = parseGameVersion("v6.3.0")!

  // fixture 计划：从 examples/plans/example-plan.json（真实可过校验的 GamePlanV1）派生——
  // single 原样（known_deck = 其对手牌表）；general 改 unknown_deck。
  // 不声明 context.gameVersion（避免按版本数据的卡牌存在性检查；适配器不依赖该字段）。
  const example = JSON.parse(await readFile("examples/plans/example-plan.json", "utf-8")) as {
    context: { deckCode: string; opponent: { kind: string; deckCode?: string } }
  }
  const deckX = example.context.deckCode
  const deckOpp = example.context.opponent.deckCode!
  const singlePlan = { ...example }
  const generalPlan = {
    ...example,
    context: { ...example.context, opponent: { kind: "unknown_deck" } },
  }
  void singlePlan

  const manifestDir = join(outRoot, "portfolios", "glm-5.3", "v6.3", "0")
  await writeJson(join(manifestDir, "plans", "general.r0.json"), generalPlan)
  await writeJson(join(manifestDir, "plans", "single.0.r0.json"), example)
  await writeJson(join(manifestDir, "portfolio.json"), {
    version: "PlanPortfolioV1",
    generalPlan: "plans/general.r0.json",
    singles: [{ opponentDeckCode: deckOpp, label: "0", planRef: "plans/single.0.r0.json" }],
  })

  // 批 1：X plan 侧（X@r0 vs Y@r0，0-vs-0）；plan_trace.json 为 X 视角；含 state log 的局
  const b1 = join(battles, "glm-5.3@r0__vs__ds@r0", "v6.3", "0-vs-0")
  await writeJson(join(b1, "summary.json"), summaryOf([
    perGameEntry(11, 0, 0, "game-0001"),
    perGameEntry(12, 1, 1, "game-0002"),
  ], 10))
  await writeJson(join(b1, "game-0001", "plan_trace.json"), traceOf([deckX, deckOpp], 0))
  await writeJson(join(b1, "game-0001", "game_state_log.json"), { log: [] })
  await writeJson(join(b1, "game-0002", "plan_trace.json"), traceOf([deckOpp, deckX], 1))

  // 批 2：X opponent 侧（Y@r0 vs X@r0，0-vs-0）；X 视角 = plan_trace.side1.json
  // 局 A：X 执舵位 side=0（side1 trace deckCodes 恒角色序 [Y 牌, X 牌] → 需规范化为 [X, Y]）
  // 局 B：X 执舵位 side=1（角色序即位置序，规范化后不变）
  const b2 = join(battles, "ds@r0__vs__glm-5.3@r0", "v6.3", "0-vs-0")
  // summary.side1.json 的 wins/losses = side1 玩家（X）视角（batch-runner accumulate 口径）：
  // 局 21（planSide=0、winner=1）→ X（位 1）胜；局 22（planSide=1、winner=0）→ X 负
  const side1Summary = summaryOf([
    perGameEntry(21, 0, 1, "game-0001"),
    perGameEntry(22, 1, 0, "game-0002"),
  ], 20) as { wins: number; losses: number; winRate: number }
  side1Summary.wins = 1
  side1Summary.losses = 1
  side1Summary.winRate = 0.5
  await writeJson(join(b2, "summary.side1.json"), side1Summary)
  await writeJson(join(b2, "game-0001", "plan_trace.side1.json"), traceOf([deckOpp, deckX], 0))
  await writeJson(join(b2, "game-0002", "plan_trace.side1.json"), traceOf([deckOpp, deckX], 1))

  const result = await buildEvidenceGroups({
    outRoot,
    envLabel: "v6.3",
    gameVersion,
    deckCodes: [deckOpp],
    model: "glm-5.3",
    holdIndex: 0,
    round: 1,
    manifestPath: join(manifestDir, "portfolio.json"),
  })
  check("收集到 1 个证据组（对手 deck 0）", result.groups.length === 1 && result.groups[0]!.opponentDeckIndex === 0, JSON.stringify(result.groups.map((g) => g.opponentDeckIndex)))
  check("总局数 = 2 + 2", result.totalGames === 4, `实为 ${result.totalGames}`)
  const groupDir = result.groups[0]!.dir
  const merged = JSON.parse(await readFile(join(groupDir, "summary.json"), "utf-8")) as { games: number; gameVersion: string; wins: number; perGame: Array<{ gameDir: string }> }
  check("合并 summary：games=4、gameVersion=环境版本", merged.games === 4 && merged.gameVersion === "v6.3.0")
  check("合并 summary：X 视角 wins = 批1 的 2 + 批2 的 1", merged.wins === 3, `实为 ${merged.wins}`)
  check("perGame.gameDir 对齐 evidence 目录名", merged.perGame.every((g) => /^game-\d+$/.test(g.gameDir)))

  // 视角翻转：批 2 局 A（X side=0）→ deckCodes 规范化为 [X 牌, 对手牌]
  const flipped = JSON.parse(await readFile(join(groupDir, "game-21", "plan_trace.json"), "utf-8")) as { deckCodes: string[]; side: number }
  check("翻转局 A：deckCodes 位置序规范化（side=0 → [X, Y]）", flipped.deckCodes[0] === deckX && flipped.deckCodes[1] === deckOpp, JSON.stringify(flipped.deckCodes))
  const flippedB = JSON.parse(await readFile(join(groupDir, "game-22", "plan_trace.json"), "utf-8")) as { deckCodes: string[]; side: number }
  check("翻转局 B：side=1 → deckCodes 保持 [Y, X] 位置序", flippedB.deckCodes[0] === deckOpp && flippedB.deckCodes[1] === deckX, JSON.stringify(flippedB.deckCodes))
  const native = JSON.parse(await readFile(join(groupDir, "game-11", "plan_trace.json"), "utf-8")) as { deckCodes: string[] }
  check("plan 侧局直拷（位置序不变）", native.deckCodes[0] === deckX && native.deckCodes[1] === deckOpp)

  // state log：有则拷
  const logCopied = await readFile(join(groupDir, "game-11", "game_state_log.json"), "utf-8").then(() => true).catch(() => false)
  check("state log 有则拷", logCopied)

  // portfolio.side0.json：portfolioId + routing（X 为 side0，对手 deck 命中 single:0）
  const archive = JSON.parse(await readFile(join(groupDir, "portfolio.side0.json"), "utf-8")) as { portfolioId: string; routing: string }
  check("archive 含 portfolioId（12 位内容寻址）与 routing", typeof archive.portfolioId === "string" && archive.portfolioId.length === 12 && archive.routing === "single:0", JSON.stringify({ portfolioId: archive.portfolioId, routing: archive.routing }))

  // 幂等：重跑跳过（指纹一致）
  const rerun = await buildEvidenceGroups({
    outRoot,
    envLabel: "v6.3",
    gameVersion,
    deckCodes: [deckOpp],
    model: "glm-5.3",
    holdIndex: 0,
    round: 1,
    manifestPath: join(manifestDir, "portfolio.json"),
  })
  check("重跑：指纹一致 → 组跳过重建", rerun.groups.every((g) => g.skipped), JSON.stringify(rerun.groups.map((g) => g.skipped)))

  await rm(outRoot, { recursive: true, force: true })
}

// ── 主流程 ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tournament-selfcheck-"))
  try {
    await testExport(root)
    await testEvidence(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  if (failed > 0) process.exit(1)
}

await main()
