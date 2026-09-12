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
 * plan:batch — one-shot 计划的批量对局 CLI（核心逻辑在 ../batch-runner.ts）。
 *
 * 用法：pnpm run plan:batch -- <config.json>
 *
 * config:
 * {
 *   "planFile": "path/to/plan.json",          // side 0 执舵的计划
 *   "portfolio": "path/to/portfolio.json",    // 与 planFile 互斥：两层组合模式（General+Single，
 *                                             //   按 opponentDeckCode 路由 single，未命中走 general）
 *   "opponent": { "type": "baseline" }         // | {"type":"mirror"} | {"type":"plan","planFile":"..."}
 *   "opponentDeckCode": "...",                 // 可选；mirror/known_deck 可自动推导（portfolio 的
 *                                             //   general 为 unknown_deck，必须显式给出）
 *   "games": 10,
 *   "seedBase": 1000,                          // 第 i 局 seed = seedBase + i
 *   "alternateFirstPlayer": true,              // 可选；奇数局交换执舵侧，消除先手偏差
 *   "concurrency": 4,                          // 可选，默认 1
 *   "outDir": "output/plan-bench/run-xxx",
 *   "traceSignatures": "lean",                 // 可选（默认 "full"）；lean = trace 不内嵌整份
 *                                              //   stateSignature（短哈希指针，消费侧从 state log 反查）
 * }
 */

import { readFile } from "node:fs/promises"
import { type Version } from "@gi-tcg/core"
import {
  assertOpponentAlignment,
  loadPlanWithValidation,
  resolveBatchGameVersion,
  resolveOpponentDeckCode,
  runPlanBatch,
  type PlanBatchConfig,
} from "../batch-runner.js"
import { loadPortfolioWithValidation, type ResolvedPortfolio } from "../portfolio.js"
import type { GamePlanV1 } from "../game-plan-v1.js"

interface PlanBatchCliConfig {
  /** side 0 执舵的计划文件；与 portfolio 互斥 */
  planFile?: string
  /** portfolio.json 路径（两层组合模式）；与 planFile 互斥 */
  portfolio?: string
  opponent:
    | { type: "baseline" }
    | { type: "mirror" }
    | { type: "plan"; planFile: string }
  opponentDeckCode?: string
  games: number
  seedBase: number
  alternateFirstPlayer?: boolean
  outDir: string
  concurrency?: number
  /**
   * 对局数据版本（如 "v6.3.0"）。默认 CURRENT_VERSION：需要被固定词表的基线
   * 回算的 baseline/plan 对局应显式钉版本。
   */
  gameVersion?: string
  /**
   * 版本错配时放行（等价于命令行 --force）：config.gameVersion 与
   * plan.context.gameVersion 冲突时以 config 为准并降级为 warning。
   */
  force?: boolean
  /**
   * trace 签名模式（默认 "full"）：lean = trace 条目不内嵌整份 stateSignature
   * （改 16 hex 短哈希指针，单局 trace ~0.7MB → <30KB），消费侧经 sig-backfill.ts
   * 从同局 game_state_log.json 反查回填。缺省 full = 既有产物逐字节不变。
   */
  traceSignatures?: "full" | "lean"
}

async function main() {
  const configPath = process.argv.slice(2).filter((a) => a !== "--")[0]
  if (!configPath) {
    console.error("usage: pnpm run plan:batch -- <config.json> [--allow-opponent-mismatch]")
    process.exit(1)
  }
  const config = JSON.parse(await readFile(configPath, "utf-8")) as PlanBatchCliConfig
  // traceSignatures 封闭校验（缺省 full；非法值 fail-fast 而非静默按 full 跑）
  if (config.traceSignatures !== undefined && config.traceSignatures !== "full" && config.traceSignatures !== "lean") {
    console.error(`config.traceSignatures 非法：${JSON.stringify(config.traceSignatures)}（可选 "full" | "lean"，缺省 "full"）`)
    process.exit(1)
  }

  // planFile 与 portfolio 互斥（portfolio 模式下主计划 = general）
  const planFile = config.planFile
  const portfolioPath = config.portfolio
  if ((planFile !== undefined) === (portfolioPath !== undefined)) {
    console.error('config 需且只需提供 "planFile" 或 "portfolio" 之一（互斥）')
    process.exit(1)
  }
  let plan: GamePlanV1
  let portfolio: ResolvedPortfolio | undefined
  // 版本错配 fail-fast 的放行开关（--force 或 config.force=true）
  const force = config.force === true || process.argv.includes("--force")
  if (portfolioPath !== undefined) {
    const loaded = await loadPortfolioWithValidation(portfolioPath, { force })
    portfolio = loaded.portfolio
    plan = portfolio.general
    for (const w of loaded.warnings) console.warn(`[portfolio warn] ${w}`)
    console.log(
      `[portfolio] id=${portfolio.portfolioId} general=${portfolio.generalId} ` +
      `singles=[${portfolio.singles.map((s) => `${s.label}:${s.planId}`).join(", ") || "（空）"}]`,
    )
  } else {
    // 互斥检查已保证 planFile 存在
    plan = await loadPlanWithValidation(planFile as string)
  }
  const opponent: PlanBatchConfig["opponent"] = config.opponent.type === "plan"
    ? { type: "plan", plan: await loadPlanWithValidation(config.opponent.planFile) }
    : config.opponent

  // opponent 为计划时，其牌表以该计划自身的 context.deckCode 为准
  // （--unknown 起草的计划没有已知对手，从主计划的 context.opponent 推导不出对手牌表）
  const explicitOppDeck = config.opponentDeckCode
    ?? (opponent.type === "plan" ? opponent.plan.context.deckCode : undefined)
  const oppDeckCode = resolveOpponentDeckCode(plan, explicitOppDeck)

  // 起草-执行对手一致性（对手错位会让按对手起草的防御/威胁包整体失效）；legacy 复现可跳过
  if (!process.argv.includes("--allow-opponent-mismatch")) {
    assertOpponentAlignment(plan, oppDeckCode)
  }

  // 数据版本钉扎（V0）：解析序 config.gameVersion ?? plan/portfolio 声明 ?? CURRENT_VERSION。
  // 错配默认 fail-fast；--force / config.force=true 放行（降级 warning）。
  // portfolio 模式的 plan 来源 = 各层共同版本（portfolio.ts 校验后注入 commonGameVersion）。
  const planGameVersion: Version | undefined = portfolio
    ? portfolio.commonGameVersion
    : (plan.context.gameVersion as Version | undefined)
  const { gameVersion, warnings: versionWarnings } = resolveBatchGameVersion(
    config.gameVersion as Version | undefined,
    planGameVersion,
    { force },
  )
  for (const w of versionWarnings) console.warn(`[version warn] ${w}`)
  console.log(
    `[version] gameVersion=${gameVersion}（config.gameVersion=${config.gameVersion ?? "未设置"}）`,
  )

  const summary = await runPlanBatch({
    plan,
    portfolio,
    ...(planFile !== undefined ? { planFilePath: planFile } : {}),
    opponent,
    opponentDeckCode: oppDeckCode,
    games: config.games,
    seedBase: config.seedBase,
    alternateFirstPlayer: config.alternateFirstPlayer,
    outDir: config.outDir,
    concurrency: config.concurrency,
    gameVersion,
    ...(config.traceSignatures !== undefined ? { traceSignatures: config.traceSignatures } : {}),
    onGameDone: (line) => console.log(line),
  })
  console.log(
    `\ndone: ${summary.wins}W/${summary.losses}L/${summary.draws}D ` +
    `winRate=${(summary.winRate * 100).toFixed(1)}% avgRounds=${summary.avgRounds.toFixed(1)} ` +
    `avgCoverage=${(summary.avgCoverage * 100).toFixed(1)}% fallbackRate=${(summary.fallbackRate * 100).toFixed(1)}%`,
  )
}

await main()
