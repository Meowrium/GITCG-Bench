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
 * one-shot 计划批量对局核心（可复用；CLI 在 cli/run-plan-batch.ts）。
 *
 * 每局落盘 game-NNNN/plan_trace.json（主计划）+ game_state_log.json（双方均为
 * 计划时对手的 trace 记为 plan_trace.side1.json）；run 根目录归档计划文件并写
 * summary.json（主计划统计）与 summary.side1.json（对手计划统计，存在时）。
 * 并发经工作池实现；每局 seed = seedBase + i。
 *
 * alternateFirstPlayer：引擎先手固定为玩家 0（stepRound 只递增回合数，
 * currentTurn 只在 switchTurn 翻转）。开启后奇数局交换两侧执舵位，
 * 消除"主计划永远先手"的系统性偏差；每局实际执舵侧记录在 perGame.planSide，
 * trace 文件内部的 side 字段始终是实际执舵侧。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CURRENT_VERSION, type DeckConfig, type GameData, type PlayerIO, type Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { SandboxRunner } from "../../sandbox/runner.js"
import { PolicyPlayerIO } from "../io/policy-player-io.js"
import { BaselinePolicy } from "../policy/baseline-policy.js"
import { PlanPlayerIO } from "./plan-player-io.js"
import { cardCountMapOf } from "./fields.js"
import { validateGamePlan, normalizePlanNumericFields } from "./validate.js"
import { routeSingle, type PortfolioRouting, type ResolvedPortfolio } from "./portfolio.js"
import type { GamePlanV1 } from "./game-plan-v1.js"
import type { PlanTraceFile } from "./trace.js"
import { parseGameVersion } from "./version.js"

export interface PlanBatchConfig {
  /** side 0 执舵的计划（alternateFirstPlayer 开启时奇数局执舵 side 1）；portfolio 模式下 = general 计划 */
  plan: GamePlanV1
  /**
   * 两层组合模式（General+Single portfolio，D1=A）：设置后 plan 字段 =
   * portfolio.general；run 级路由一次——对手 deckCode 命中 singles → 组合链
   * （Single 前置），未命中 → General-only；trace meta 记 routing 与 portfolioId
   */
  portfolio?: ResolvedPortfolio
  /**
   * 主计划文件路径（CLI 载入的 config.planFile）。用于把主计划的旁档随计划归档：
   * `<planFile>.anchor-assertions.json` → `plan.side0.anchor-assertions.json`、
   * `<planFile>.alternates.json` → `plan.side0.alternates.json`（存在才拷，缺失静默跳过）。
   * portfolio 模式无单文件主计划，不设置。
   */
  planFilePath?: string
  /**
   * 对局数据版本（缺省 CURRENT_VERSION）。调用方（CLI 层）把
   * config.gameVersion ?? plan/portfolio 声明的版本 ?? CURRENT_VERSION 的
   * 解析结果写入本字段；它同时驱动开局 versionBehavior（机制行为与数据同版本）、
   * state log 的 gv 标签与 trace/summary 的 gameVersion 记录。
   */
  gameVersion?: Version
  opponent:
    | { type: "baseline" }
    | { type: "mirror" }
    | { type: "plan"; plan: GamePlanV1 }
  opponentDeckCode: string
  games: number
  seedBase: number
  outDir: string
  /** 奇数局交换两侧执舵位，消除先手偏差（默认 false，与旧数据可比） */
  alternateFirstPlayer?: boolean
  /** 并发对局数（默认 1；引擎对局为内存计算，4 并发实测安全） */
  concurrency?: number
  onGameDone?: (line: string) => void
  /**
   * trace 签名模式（默认 "full"，逐字节不变）：lean = plan_trace.json /
   * plan_trace.side1.json 条目不内嵌整份 stateSignature（改 16 hex 短哈希指针，
   * trace.ts sigHashOf），单局 trace 从 ~0.7MB 降到 <30KB；消费侧经
   * sig-backfill.ts 从同局 game_state_log.json 反查回填（organize-export / reflect
   * / eval 均已适配）。锦标赛编排层显式 opt-in（impl-spec-1 件 1）。
   */
  traceSignatures?: "full" | "lean"
}

export interface PlanBatchSummary {
  planId: string
  /** 对局数据版本（与每局 state log 的 gv、plan_trace.gameVersion 一致） */
  gameVersion: Version
  games: number
  seedBase: number
  alternateFirstPlayer: boolean
  wins: number
  losses: number
  draws: number
  winRate: number
  avgRounds: number
  avgCoverage: number
  fallbackRate: number
  perRuleHits: Record<string, number>
  perRuleThenMiss: Record<string, number>
  perGame: Array<{
    gameDir: string
    seed: number
    /** 本局该计划实际执舵侧（交替开启时奇数局为 1） */
    planSide: 0 | 1
    winner: 0 | 1 | null
    rounds: number
    coverage: number
    ruleMatched: number
    fallback: number
    total: number
  }>
}

export interface ResolveBatchVersionOptions {
  /** --force / config.force：版本来源冲突时放行（不抛错；nn 模式仍以 v6.3.0 为准） */
  force?: boolean
  /** opponent.type === "nn"：计划来源被 NN 词表边界锁 v6.3.0，冲突消息说明该限制 */
  nn?: boolean
}

export interface ResolvedBatchVersion {
  /** 最终生效的数据版本 */
  gameVersion: Version
  warnings: string[]
}

/**
 * 批量对局数据版本解析（V0 钉扎）。解析序：config ?? plan ?? CURRENT_VERSION。
 * - config 与 plan 都显式设置且不同 → 抛错（版本错配 fail-fast）；force 放行
 *   降级为 warning 并以 config 为准；plan 未声明时以 config 为准（不算错配）。
 * - NN 对手（opts.nn）：忽略 plan 声明、锁定 v6.3.0（词表边界）；config 给了
 *   别的值按错配处理，force 放行后仍强制 v6.3.0（NN 无法用其他版本词表）。
 * - portfolio 模式的 plan 来源 = 各层共同版本（portfolio.ts 校验后注入），
 *   本函数不感知 portfolio 内部结构。
 */
export function resolveBatchGameVersion(
  configGameVersion: Version | undefined,
  planGameVersion: Version | undefined,
  opts: ResolveBatchVersionOptions = {},
): ResolvedBatchVersion {
  const warnings: string[] = []
  if (opts.nn) {
    if (configGameVersion !== undefined && configGameVersion !== "v6.3.0") {
      const message = `config.gameVersion=${configGameVersion} 与 NN 对手词表锁定的 v6.3.0 不兼容（NN 只支持 v6.3.0 词表）`
      if (!opts.force) {
        throw new Error(`${message}；请将 config.gameVersion 改为 "v6.3.0"，或加 --force / config.force=true 放行`)
      }
      warnings.push(`${message}；--force 放行，实际仍强制使用 v6.3.0`)
    }
    return { gameVersion: "v6.3.0", warnings }
  }
  if (
    configGameVersion !== undefined
    && planGameVersion !== undefined
    && configGameVersion !== planGameVersion
  ) {
    const message = `config.gameVersion=${configGameVersion} 与 plan.context.gameVersion=${planGameVersion} 冲突（计划按 ${planGameVersion} 起草/校验，可能含对应版本词表）`
    if (!opts.force) {
      throw new Error(`${message}；请统一版本，或加 --force / config.force=true 以 config 为准放行`)
    }
    warnings.push(`${message}；--force 放行，实际使用 config 的 ${configGameVersion}`)
  }
  return { gameVersion: configGameVersion ?? planGameVersion ?? CURRENT_VERSION, warnings }
}

export async function runPlanBatch(config: PlanBatchConfig, data?: GameData): Promise<PlanBatchSummary> {
  const gameVersion = config.gameVersion ?? CURRENT_VERSION
  const gameData = data ?? getData(gameVersion)
  const opponentPlan = config.opponent.type === "plan"
    ? config.opponent.plan
    : config.opponent.type === "mirror"
      ? config.plan
      : null
  return runBatchImpl(config, opponentPlan, gameData, gameVersion)
}

function decodeDeckOf(plan: GamePlanV1): DeckConfig {
  return DEFAULT_ASSETS_MANAGER.decode(plan.context.deckCode) as DeckConfig
}

/** 加载计划文件：数值规范化 + 完整校验（含对手牌表语义检查），不合法则抛错。
 * 计划声明 context.gameVersion 时用该版本数据做存在性校验（V1：旧版本没有的
 * 角色/卡 → 校验失败）；版本串非法（不在 VERSIONS）→ 抛错列出可用版本。 */
export async function loadPlanWithValidation(path: string): Promise<GamePlanV1> {
  const plan = normalizePlanNumericFields(JSON.parse(await readFile(path, "utf-8")) as GamePlanV1)
  const deck = decodeDeckOf(plan)
  const opp = plan.context.opponent
  const opponentDeck = opp.kind === "mirror" ? deck
    : opp.kind === "known_deck"
      ? (DEFAULT_ASSETS_MANAGER.decode(opp.deckCode) as DeckConfig)
      : undefined
  const declaredVersion = parseGameVersion(plan.context.gameVersion)
  const data = declaredVersion === undefined ? undefined : getData(declaredVersion)
  const validation = validateGamePlan(plan, {
    deck,
    opponentDeck,
    ...(data !== undefined ? { data } : {}),
  })
  if (!validation.ok) {
    const detail = validation.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")
    throw new Error(`plan ${path} is INVALID:\n${detail}`)
  }
  return plan
}

/** 推导对手牌表分享码：显式 > mirror/known_deck；unknown_deck 必须显式给出 */
export function resolveOpponentDeckCode(plan: GamePlanV1, explicit?: string): string {
  if (explicit) return explicit
  const opp = plan.context.opponent
  if (opp.kind === "mirror") return plan.context.deckCode
  if (opp.kind === "known_deck") return opp.deckCode
  throw new Error("opponent.kind = unknown_deck 时必须显式提供 opponentDeckCode")
}

/**
 * 起草-执行对手一致性断言：known_deck/mirror 计划的威胁模型与防御包都按
 * plan.context.opponent 的牌表起草，批跑对手牌表若与起草假设不一致，
 * 这部分规则整体错配（round23 两侧计划均按雷鹤起草、实际打红牛镜像，防守包全失效）。
 * 默认 fail-fast；legacy 复现用 --allow-opponent-mismatch 跳过。
 */
export function assertOpponentAlignment(plan: GamePlanV1, actualOppDeckCode: string): void {
  const opp = plan.context.opponent
  if (opp.kind === "unknown_deck") return
  const assumed = opp.kind === "mirror" ? plan.context.deckCode : opp.deckCode
  if (assumed !== actualOppDeckCode) {
    throw new Error(
      `对手错位：计划按 ${opp.kind}（${assumed}）起草，但批跑对手牌表是 ${actualOppDeckCode}。`
      + `请以与执行一致的对手重新起草，或在 legacy 复现时加 --allow-opponent-mismatch`,
    )
  }
}

/** 单计划跨局聚合（主计划与对手计划各一份） */
interface SideAccumulator {
  wins: number
  losses: number
  draws: number
  roundsSum: number
  coverageSum: number
  ruleMatched: number
  fallback: number
  total: number
  perRuleHits: Record<string, number>
  perRuleThenMiss: Record<string, number>
  perGame: PlanBatchSummary["perGame"]
}

function newAccumulator(): SideAccumulator {
  return {
    wins: 0, losses: 0, draws: 0, roundsSum: 0, coverageSum: 0,
    ruleMatched: 0, fallback: 0, total: 0,
    perRuleHits: {}, perRuleThenMiss: {}, perGame: [],
  }
}

function accumulate(acc: SideAccumulator, trace: PlanTraceFile, gameDir: string, seed: number, planSide: 0 | 1, winner: 0 | 1 | null): void {
  if (winner === planSide) acc.wins++
  else if (winner === null) acc.draws++
  else acc.losses++
  acc.roundsSum += trace.summary.rounds
  acc.coverageSum += trace.summary.coverage
  acc.ruleMatched += trace.summary.decisionCounts.ruleMatched
  acc.fallback += trace.summary.decisionCounts.fallback
  acc.total += trace.summary.decisionCounts.total
  for (const [k, v] of Object.entries(trace.summary.perRuleHits)) {
    acc.perRuleHits[k] = (acc.perRuleHits[k] ?? 0) + v
  }
  for (const [k, v] of Object.entries(trace.summary.perRuleThenMiss ?? {})) {
    acc.perRuleThenMiss[k] = (acc.perRuleThenMiss[k] ?? 0) + v
  }
  acc.perGame.push({
    gameDir,
    seed,
    planSide,
    winner,
    rounds: trace.summary.rounds,
    coverage: trace.summary.coverage,
    ruleMatched: trace.summary.decisionCounts.ruleMatched,
    fallback: trace.summary.decisionCounts.fallback,
    total: trace.summary.decisionCounts.total,
  })
}

function finalizeSummary(planId: string, config: PlanBatchConfig, acc: SideAccumulator, gameVersion: Version): PlanBatchSummary {
  const n = Math.max(1, config.games)
  return {
    planId,
    gameVersion,
    games: config.games,
    seedBase: config.seedBase,
    alternateFirstPlayer: config.alternateFirstPlayer === true,
    wins: acc.wins,
    losses: acc.losses,
    draws: acc.draws,
    winRate: acc.wins / n,
    avgRounds: acc.roundsSum / n,
    avgCoverage: acc.coverageSum / n,
    fallbackRate: acc.total > 0 ? acc.fallback / acc.total : 0,
    perRuleHits: acc.perRuleHits,
    perRuleThenMiss: acc.perRuleThenMiss,
    perGame: [...acc.perGame].sort((a, b) => a.gameDir.localeCompare(b.gameDir)),
  }
}

async function runBatchImpl(
  config: PlanBatchConfig,
  opponentPlan: GamePlanV1 | null,
  data: GameData,
  gameVersion: Version,
): Promise<PlanBatchSummary> {
  const { plan } = config
  const planDeck = decodeDeckOf(plan)
  const oppDeck = DEFAULT_ASSETS_MANAGER.decode(config.opponentDeckCode) as DeckConfig
  // 明牌表赛制：双方牌表互为先验信息（opp.hand.hasCardP.* 的 k 来源）。
  // 按本局实际使用的牌表注入，与对手类型无关——对手就是拿这副牌在打。
  const planDeckCards = cardCountMapOf(planDeck.cards)
  const oppDeckCards = cardCountMapOf(oppDeck.cards)
  // 惯例：decks[side] 即该侧牌表。交替局交换两者。
  const decksBySide: [DeckConfig, DeckConfig] = [planDeck, oppDeck]
  // 组合模式：路由在 run 级解析一次（路由粒度契约）；命中 single 时防御性
  // 断言其绑定与本 run 实际对手一致（routeSingle 已按 deckCode 匹配）
  const routed = config.portfolio ? routeSingle(config.portfolio, config.opponentDeckCode) : null
  if (routed) assertOpponentAlignment(routed.plan, config.opponentDeckCode)
  const routing: PortfolioRouting | undefined = config.portfolio
    ? routed
      ? `single:${routed.label}`
      : "general-only"
    : undefined
  const opponentLabel = config.opponent.type === "baseline"
    ? "baseline"
    : `${config.opponent.type}:${opponentPlan?.planId ?? "?"}`

  await mkdir(config.outDir, { recursive: true })
  // 归档本臂使用的计划文件，保证 run 目录自包含（reflect/oracle/消融可溯源）。
  // 命名按"计划身份"（side0 = 主计划）而非实际执舵侧——执舵侧见 perGame.planSide 与 trace.side。
  await writeFile(join(config.outDir, "plan.side0.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf-8")
  // 旁档随主计划归档（存在则原样拷贝，供 reflect 重算/换轴；旧产物无旁档 → 静默跳过）
  if (config.planFilePath !== undefined) {
    const archiveSidecar = async (suffix: string, name: string): Promise<void> => {
      try {
        await writeFile(join(config.outDir, name), await readFile(`${config.planFilePath}.${suffix}`, "utf-8"), "utf-8")
      } catch { /* 旁档不存在：静默跳过 */ }
    }
    // 锚点断言旁档（--anchor）：reflect 按计划版本重算并注入「锚点断言校核」段
    await archiveSidecar("anchor-assertions.json", "plan.side0.anchor-assertions.json")
    // 多候选旁档（--candidates）：reflect「替代路线参考」段与 switch_route 换轴素材
    await archiveSidecar("alternates.json", "plan.side0.alternates.json")
  }
  if (config.portfolio && routing) {
    // 组合模式：另归档 portfolio 快照（manifest 字段 + 解析后 planId 清单 + 本 run routing）；
    // plan.side0.json 继续写 general 计划（旧工具链可读）
    const p = config.portfolio
    const archive = {
      ...p.manifest,
      portfolioId: p.portfolioId,
      resolved: {
        generalId: p.generalId,
        singles: Object.fromEntries(
          p.singles.map((s) => [s.label, { opponentDeckCode: s.opponentDeckCode, planId: s.planId }]),
        ),
      },
      routing,
    }
    await writeFile(join(config.outDir, "portfolio.side0.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf-8")
  }
  if (opponentPlan && opponentPlan !== plan) {
    await writeFile(join(config.outDir, "plan.side1.json"), `${JSON.stringify(opponentPlan, null, 2)}\n`, "utf-8")
  }

  const runner = new SandboxRunner()
  const planAcc = newAccumulator()
  const oppAcc = newAccumulator()

  const runGame = async (i: number) => {
    const seed = config.seedBase + i
    // 先手固定为玩家 0：交替局让主计划执舵 side 1
    const planSide: 0 | 1 = config.alternateFirstPlayer === true && i % 2 === 1 ? 1 : 0
    const planIo = new PlanPlayerIO({
      side: planSide,
      plan,
      // 组合模式：路由命中 single → 组合链（Single 前置 + General 兜底）
      ...(routed ? { single: { plan: routed.plan, label: routed.label } } : {}),
      // 任务 0 口径：portfolio 模式恒层化——general-only 路由的条目也带
      // layer="general"（键 general:*），D6 跨组计数才能归并同一条 general 规则
      layered: config.portfolio !== undefined,
      gameData: data,
      opponentDeckCards: oppDeckCards,
      ...(config.traceSignatures === "lean" ? { traceSignatures: "lean" as const } : {}),
      trace: {
        planId: plan.planId,
        parentPlanId: plan.parentPlanId,
        side: planSide,
        opponentPolicy: opponentLabel,
        seed,
        deckCodes: planSide === 0
          ? [plan.context.deckCode, config.opponentDeckCode]
          : [config.opponentDeckCode, plan.context.deckCode],
        ...(routing !== undefined ? { routing } : {}),
        ...(config.portfolio ? { portfolioId: config.portfolio.portfolioId } : {}),
        gameVersion,
        ...(config.traceSignatures === "lean" ? { traceSignatures: "lean" as const } : {}),
      },
    })
    let opponentIo: PlayerIO
    let opponentPlanIo: PlanPlayerIO | null = null
    if (opponentPlan) {
      const oppSide = (1 - planSide) as 0 | 1
      opponentPlanIo = new PlanPlayerIO({
        side: oppSide,
        plan: opponentPlan,
        gameData: data,
        opponentDeckCards: planDeckCards,
        ...(config.traceSignatures === "lean" ? { traceSignatures: "lean" as const } : {}),
        trace: {
          planId: opponentPlan.planId,
          parentPlanId: opponentPlan.parentPlanId,
          side: oppSide,
          opponentPolicy: `plan:${plan.planId}`,
          seed,
          deckCodes: [plan.context.deckCode, config.opponentDeckCode],
          gameVersion,
          ...(config.traceSignatures === "lean" ? { traceSignatures: "lean" as const } : {}),
        },
      })
      opponentIo = opponentPlanIo
    } else {
      opponentIo = new PolicyPlayerIO({
        side: (1 - planSide) as 0 | 1,
        policy: new BaselinePolicy(),
        searchOptions: { enabled: false },
      })
    }
    const ios: [PlayerIO, PlayerIO] = planSide === 0 ? [planIo, opponentIo] : [opponentIo, planIo]
    const gameDecks: [DeckConfig, DeckConfig] = planSide === 0 ? decksBySide : [decksBySide[1], decksBySide[0]]

    const gameDirName = `game-${String(i + 1).padStart(4, "0")}`
    const gameDir = join(config.outDir, gameDirName)
    await mkdir(gameDir, { recursive: true })

    const result = await runner.runOne(gameDecks, data, ios, {
      captureReplay: true,
      seed,
      // 数据版本与机制行为同源：state log 的 gv 标签 = 开局 versionBehavior = 实际数据版本
      replayVersion: gameVersion,
      versionBehavior: gameVersion,
    })

    const trace = planIo.getTraceFile()
    await writeFile(join(gameDir, "plan_trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf-8")
    if (result.replayLogJson) {
      await writeFile(join(gameDir, "game_state_log.json"), `${JSON.stringify(result.replayLogJson)}\n`, "utf-8")
    }
    if (opponentPlanIo) {
      await writeFile(join(gameDir, "plan_trace.side1.json"), `${JSON.stringify(opponentPlanIo.getTraceFile(), null, 2)}\n`, "utf-8")
    }

    const winner = result.winner
    accumulate(planAcc, trace, gameDirName, seed, planSide, winner)
    if (opponentPlanIo) {
      accumulate(oppAcc, opponentPlanIo.getTraceFile(), gameDirName, seed, (1 - planSide) as 0 | 1, winner)
    }
    const { decisionCounts, coverage } = trace.summary
    config.onGameDone?.(
      `[${i + 1}/${config.games}] seed=${seed} planSide=${planSide} winner=${winner ?? "draw"} rounds=${result.rounds} ` +
      `coverage=${(coverage * 100).toFixed(1)}% (${decisionCounts.ruleMatched}/${decisionCounts.total}) ${result.elapsedMs}ms`,
    )
  }

  // 并发工作池：每局 IO 独立创建，seed 固定，无共享可变状态
  const concurrency = Math.max(1, config.concurrency ?? 1)
  let nextGame = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, config.games) }, async () => {
      while (nextGame < config.games) {
        const i = nextGame++
        await runGame(i)
      }
    }),
  )

  const summary = finalizeSummary(plan.planId, config, planAcc, gameVersion)
  await writeFile(join(config.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf-8")
  // 对手计划统计（reflect --side 1 按侧读取；含镜像局——镜像局双侧同一计划分开统计）
  if (opponentPlan) {
    const oppSummary = finalizeSummary(opponentPlan.planId, config, oppAcc, gameVersion)
    await writeFile(join(config.outDir, "summary.side1.json"), `${JSON.stringify(oppSummary, null, 2)}\n`, "utf-8")
  }
  return summary
}
