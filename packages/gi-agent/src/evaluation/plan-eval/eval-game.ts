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
 * plan-eval 核心逻辑（可复用导出；CLI 在 cli/run-plan-eval.ts）。
 *
 * 对齐方式：trace 条目的 stateSignature（决策时刻本侧玩家视角规范化 JSON）
 * ↔ state log 暂停点 exposeState(side, state) 重算签名，精确匹配。
 * 规则归因键：phase 规则为 "phase:<phaseId>:<priority>"（避免跨阶段碰撞），
 * 其余为 "global:<priority>" / "opening:<priority>" / "<fallback>"；
 * 两层组合模式（General+Single）的条目带层前缀，如 "single:<label>:global:5"
 * （拼键统一见 runtime/plan-oneshot/rule-key.ts）。
 */

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CURRENT_VERSION,
  deserializeGameStateLog,
  exposeState,
  type GameData,
  type GameState,
  type Version,
} from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { ismctsSearch } from "../../mcts/ismcts.js"
import { planStateSignature } from "../../runtime/plan-oneshot/fields.js"
import { backfillTraceSignatures } from "../../runtime/plan-oneshot/sig-backfill.js"
import { formatRuleKey } from "../../runtime/plan-oneshot/rule-key.js"
import type { PlanTraceEntry, PlanTraceFile } from "../../runtime/plan-oneshot/trace.js"

export interface EvalConfig {
  tau: number
  determinizations: number
  simulations: number
  timeBudgetMs: number
}

/**
 * 默认 oracle 配置。弱配置（dets=4/sims=32/300ms）下 visit 分布方差极大，
 * blunderRate 噪声可达 ±25pp（实测同一局面 41.7% vs 强配置 16.7%）——
 * 2026-08-23 审计后提升至中等强度；跨轮比较时必须附配置（已随产物落盘）。
 */
export const DEFAULT_EVAL_CONFIG: EvalConfig = {
  tau: 0.1,
  determinizations: 8,
  simulations: 64,
  timeBudgetMs: 500,
}

export interface DecisionPointEval {
  seq: number
  stateLogIndex: number
  /** 决策点状态签名（消融臂配对比较用：同签名 = 同信息集） */
  stateSignature: string | null
  round: number
  turn: number
  matchedRule: string | null
  chosen: PlanTraceEntry["chosen"]
  oracleBest: string
  chosenInRoot: boolean
  chosenRank: number | null
  visitGap: number | null
  isDivergence: boolean
  isBlunder: boolean
  /** true = 计划动作在 oracle 根候选中找不到（表示对不齐），不计入 blunder 统计 */
  alignmentMiss: boolean
  oracleElapsedMs: number
  /** 以下 value 字段仅 NN oracle 口径（--oracle nn 且开启 valueDiff）产出：
      模型 value 头 tanh 输出 ∈ (-1,1)，执舵方视角；winrate = (v+1)/2 */
  /** 决策前局面的模型估值 */
  valueBefore?: number | null
  /** 行动结算后局面的模型估值（对方行动点取负；终局取 ±1/0） */
  valueAfter?: number | null
  /** valueAfter - valueBefore：本行动的直接胜率后果（tanh 空间；/2 = 胜率点） */
  valueDelta?: number | null
  /** valueAfter 的来源种类 */
  valueAfterKind?: "self" | "opponent" | "terminal" | "unavailable" | null
  /** 行动与 valueAfter 之间跨过了非 action 暂停（掷骰等 RNG），差分受污染，不进聚合 */
  valueCrossedPhaseBoundary?: boolean
  /** valueDelta < -valueTau（默认 0.1 ≈ 5pp 胜率）记为胜率崩落点 */
  isValueCrash?: boolean
  /** 该决策点的合法候选数：仅统计引擎 validity==VALID 的可执行操作（NN oracle 口径恒记录；
      引擎 rpc 请求中的 DISABLED/NO_TARGET/CONDITION_NOT_MET 等非法项不计入） */
  candidateCount?: number
  /** --dump-candidates 开启时：全部候选摘要 + NN 评分（score=null=模型未评分），按候选序；
      数组保持引擎全量（含非法项，validity 字段标注），作图按 validity==VALID 过滤 */
  candidates?: NnCandidateScore[]
}

export interface NnCandidateScore {
  actionCase: string
  skillDefId?: number
  cardDefId?: number
  targetDefId?: number
  /** 引擎对候选的合法性标注：VALID / CONDITION_NOT_MET / NO_TARGET / NO_DICE / NO_ENERGY / DISABLED */
  validity: string
  score: number | null
}

export interface GameEvalResult {
  points: DecisionPointEval[]
  metrics: {
    total: number
    /** 可比较点数（排除 alignmentMiss） */
    comparablePoints: number
    chosenInRoot: number
    divergences: number
    blunders: number
    alignmentMisses: number
    blunderRate: number
    /** 以下 value 聚合仅 NN oracle 口径产出（--oracle nn 且开启 valueDiff） */
    /** 有可用差分的决策点数（不含跨阶段边界与估值缺失） */
    valuePoints?: number
    /** 平均行动胜率后果（tanh 空间；/2 = 胜率点）；null = 无可用差分 */
    meanValueDelta?: number | null
    /** 胜率崩落点数（valueDelta < -valueTau） */
    valueCrashes?: number
    valueCrashRate?: number | null
    /** 决策前的平均模型估值 */
    meanValueBefore?: number | null
    /** 因跨阶段边界（掷骰 RNG 等）被排除出差分聚合的点数 */
    valueBoundarySkipped?: number
  }
  /** value* 字段仅 NN oracle 口径产出 */
  perRule: Record<string, {
    points: number
    blunders: number
    valueDeltaSum?: number
    valueDeltaCount?: number
    valueCrashes?: number
  }>
  warnings: string[]
}

export interface RunEvalAggregate {
  games: number
  totalPoints: number
  comparablePoints: number
  totalBlunders: number
  totalDivergences: number
  totalAlignmentMisses: number
  blunderRate: number
  /** 以下 value 聚合仅 NN oracle 口径产出 */
  totalValuePoints?: number
  meanValueDelta?: number | null
  totalValueCrashes?: number
  valueCrashRate?: number | null
  totalValueBoundarySkipped?: number
  perRule: Record<string, {
    points: number
    blunders: number
    valueDeltaSum?: number
    valueDeltaCount?: number
    valueCrashes?: number
  }>
}

/** HP 比例叶子估值（与 ismcts.test.ts 相同的 hermetic 启发式） */
function hpLeaf(state: GameState, who: 0 | 1): number {
  const me = state.players[who]
  const opp = state.players[(1 - who) as 0 | 1]
  const aliveOpp = opp.characters.filter((c) => c.variables.alive).length
  if (aliveOpp === 0) return 1
  const aliveMe = me.characters.filter((c) => c.variables.alive).length
  if (aliveMe === 0) return 0
  const sum = (p: typeof me) =>
    p.characters.reduce((s, c) => s + (c.variables.alive ? (c.variables.health ?? 0) : 0), 0)
  const total = sum(me) + sum(opp)
  return total > 0 ? sum(me) / total : 0.5
}

/** 引擎动作 → 与 trace.chosen 可比较的摘要 */
function summarizeEngineAction(a: {
  type: string
  skill?: { definition?: { id?: number } }
  to?: { definition?: { id?: number } }
}): { actionCase: string; skillDefId?: number; cardDefId?: number; targetDefId?: number } {
  switch (a.type) {
    case "useSkill":
      return { actionCase: "useSkill", skillDefId: a.skill?.definition?.id }
    case "playCard":
      // 引擎侧卡牌技能的 definition id 带小数后缀（如 311502.01），向下取整回卡牌 defId
      return { actionCase: "playCard", cardDefId: Math.floor(a.skill?.definition?.id ?? 0) }
    case "switchActive":
      return { actionCase: "switchActive", targetDefId: a.to?.definition?.id }
    default:
      return { actionCase: a.type }
  }
}

function chosenEqualsEngine(
  chosen: PlanTraceEntry["chosen"],
  engine: { actionCase: string; skillDefId?: number; cardDefId?: number; targetDefId?: number },
): boolean {
  if (!chosen) return false
  if (chosen.actionCase !== engine.actionCase) return false
  if (engine.actionCase === "useSkill") {
    return chosen.skillDefId !== undefined && chosen.skillDefId === engine.skillDefId
  }
  if (engine.actionCase === "playCard") {
    return chosen.cardDefId !== undefined && chosen.cardDefId === engine.cardDefId
  }
  if (engine.actionCase === "switchActive") {
    // 两侧的 targetDefId 均为角色 defId（trace 侧 characterDefinitionId、引擎侧
    // to.definition.id）——可比对；任一侧缺失时退化为只比类型
    if (chosen.targetDefId !== undefined && engine.targetDefId !== undefined) {
      return chosen.targetDefId === engine.targetDefId
    }
    return true
  }
  // declareEnd / elementalTuning 无参数，只比类型
  return true
}

export function ruleKeyOf(e: PlanTraceEntry): string | null {
  if (!e.matchedRule) return null
  // 拼键统一走 rule-key.ts（组合模式条目带层前缀；旧格式逐字节不变）
  return formatRuleKey({
    scope: e.matchedRule.scope,
    priority: e.matchedRule.priority,
    phaseId: e.phaseId,
    layer: e.matchedRule.layer,
    layerLabel: e.matchedRule.layerLabel,
  })
}

export interface AlignedDecisionPair {
  entry: PlanTraceEntry
  state: GameState
  stateLogIndex: number
}

export interface AlignedGameInput {
  trace: PlanTraceFile
  stateLog: ReturnType<typeof deserializeGameStateLog>
  data: GameData
  side: 0 | 1
  pairs: AlignedDecisionPair[]
  warnings: string[]
}

/** 读单局目录并按状态签名对齐 trace 决策点与 state log 暂停点（ISMCTS 与 NN oracle 共用） */
export async function loadAlignedGameInput(
  gameDir: string,
  opts?: { traceFileName?: string },
): Promise<AlignedGameInput> {
  const trace = JSON.parse(
    await readFile(join(gameDir, opts?.traceFileName ?? "plan_trace.json"), "utf-8"),
  ) as PlanTraceFile
  // lean trace（traceSignatures="lean"，无内嵌签名）：先从同局 state log 反查回填，
  // 对齐语义与 full 模式完全一致；full / 旧格式 trace 此调用恒 no-op（不读盘）
  const backfill = await backfillTraceSignatures(gameDir, trace)
  const raw = JSON.parse(await readFile(join(gameDir, "game_state_log.json"), "utf-8")) as { gv?: Version }
  // state log 自带对局游戏版本（gv）；旧版本对局用旧版本数据回算，避免规则漂移
  const data = getData(raw.gv ?? CURRENT_VERSION)
  const stateLog = deserializeGameStateLog(data, raw as Parameters<typeof deserializeGameStateLog>[1])

  const side = trace.side
  const actionEntries = trace.entries.filter((e) => e.method === "action")

  // 签名 → state log 下标队列；同签名的重复暂停点按序消费。
  const sigQueues = new Map<string, number[]>()
  stateLog.forEach((entry, i) => {
    if (!entry.canResume || entry.state.phase !== "action") return
    const sig = planStateSignature(exposeState(side, entry.state))
    const q = sigQueues.get(sig)
    if (q) q.push(i)
    else sigQueues.set(sig, [i])
  })

  const warnings: string[] = []
  // lean 回填缺口如实上报（full 模式 attempted=0 不触发）
  if (backfill.missed > 0) {
    warnings.push(`lean 签名回填：${backfill.missed}/${backfill.attempted} 条目无法从 state log 反查（引擎 pause/notify 边界差异或日志缺失），跳过`)
  }
  // 版本一致性轻校验（不中断）：trace 声明的版本与 state log gv 不符时收 warning，
  // 回算仍以 state log gv 为准（旧 trace 无 gameVersion 字段，不触发）。
  if (trace.gameVersion !== undefined && trace.gameVersion !== raw.gv) {
    warnings.push(`trace.gameVersion（${trace.gameVersion}）与 state log gv（${raw.gv ?? "（未标注）"}）不一致——以 gv 为准回算`)
  }
  const pairs: AlignedDecisionPair[] = []
  for (const entry of actionEntries) {
    if (!entry.stateSignature) {
      warnings.push(`seq=${entry.seq}: trace 无 stateSignature（旧格式文件或 lean 反查失败），跳过`)
      continue
    }
    const q = sigQueues.get(entry.stateSignature)
    const idx = q?.shift()
    if (idx === undefined) {
      warnings.push(`seq=${entry.seq}: 无匹配的 state log 暂停点，跳过`)
      continue
    }
    pairs.push({ entry, state: stateLog[idx].state, stateLogIndex: idx })
  }
  return { trace, stateLog, data, side, pairs, warnings }
}

export async function evalGameDir(
  gameDir: string,
  cfg: EvalConfig,
  opts?: { traceFileName?: string },
): Promise<GameEvalResult> {
  const { side, pairs, warnings } = await loadAlignedGameInput(gameDir, opts)

  const points: DecisionPointEval[] = []
  const perRule: Record<string, { points: number; blunders: number }> = {}
  let chosenInRoot = 0
  let divergences = 0
  let blunders = 0
  let comparablePoints = 0
  let alignmentMisses = 0

  for (const { entry, state, stateLogIndex } of pairs) {
    const res = await ismctsSearch(state, side, hpLeaf, {
      config: {
        determinizations: cfg.determinizations,
        simulations: cfg.simulations,
        timeBudgetMs: cfg.timeBudgetMs,
      },
    })
    const totalVisits = res.visitDistribution.reduce((s, v) => s + v, 0)
    const rootSummaries = res.rootActions.map(summarizeEngineAction)
    const chosenIdx = rootSummaries.findIndex((s) => chosenEqualsEngine(entry.chosen, s))
    const ruleKey = ruleKeyOf(entry) ?? "<fallback>"

    let isDivergence = false
    let isBlunder = false
    let visitGap: number | null = null
    if (chosenIdx < 0) {
      // 表示对不齐（trace 摘要与 oracle 根候选无法互认）≠ 计划走错：
      // 单列为 alignmentMiss，不进 blunder 率与规则归因，避免污染反思输入
      alignmentMisses++
      warnings.push(`seq=${entry.seq}: 计划动作不在 oracle 根候选中（表示对不齐，已排除出 blunder 统计）`)
    } else {
      chosenInRoot++
      comparablePoints++
      isDivergence = chosenIdx !== res.bestActionIndex
      visitGap = totalVisits > 0
        ? (res.visitDistribution[res.bestActionIndex] - res.visitDistribution[chosenIdx]) / totalVisits
        : 0
      isBlunder = isDivergence && visitGap > cfg.tau
      const bucket = (perRule[ruleKey] ??= { points: 0, blunders: 0 })
      bucket.points++
      if (isBlunder) {
        bucket.blunders++
        blunders++
      }
      if (isDivergence) divergences++
    }

    points.push({
      seq: entry.seq,
      stateLogIndex,
      stateSignature: entry.stateSignature ?? null,
      round: entry.round,
      turn: entry.turn,
      matchedRule: ruleKeyOf(entry),
      chosen: entry.chosen,
      oracleBest: JSON.stringify(summarizeEngineAction(res.rootActions[res.bestActionIndex] ?? { type: "none" })),
      chosenInRoot: chosenIdx >= 0,
      chosenRank: chosenIdx >= 0 ? chosenIdx : null,
      visitGap,
      isDivergence,
      isBlunder,
      alignmentMiss: chosenIdx < 0,
      oracleElapsedMs: Math.round(res.elapsedMs),
    })
  }

  const total = points.length
  return {
    points,
    metrics: {
      total,
      comparablePoints,
      chosenInRoot,
      divergences,
      blunders,
      alignmentMisses,
      blunderRate: comparablePoints > 0 ? blunders / comparablePoints : 0,
    },
    perRule,
    warnings,
  }
}

export async function collectGameDirs(target: string, traceFileName = "plan_trace.json"): Promise<string[]> {
  // 单局目录：直接含 trace 文件
  try {
    await readFile(join(target, traceFileName), "utf-8")
    return [target]
  } catch {
    // fall through: 视为 run 目录
  }
  const entries = await readdir(target, { withFileTypes: true })
  const dirs: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("game-")) continue
    const dir = join(target, e.name)
    try {
      await readFile(join(dir, traceFileName), "utf-8")
      await readFile(join(dir, "game_state_log.json"), "utf-8")
      dirs.push(dir)
    } catch {
      // 缺文件的对局跳过
    }
  }
  return dirs.sort()
}

export interface EvalRunOptions {
  traceFileName?: string
  /** 每局写出文件名（默认 plan_eval.json） */
  evalOutName?: string
  /** run 级汇总文件名（默认 plan_eval_summary.json；单局目录不写） */
  summaryOutName?: string
  onGameDone?: (dir: string, result: GameEvalResult) => void
}

export async function evalRunDir(
  target: string,
  cfg: EvalConfig,
  opts?: EvalRunOptions,
): Promise<RunEvalAggregate> {
  const gameDirs = await collectGameDirs(target, opts?.traceFileName)
  if (gameDirs.length === 0) {
    throw new Error(`no game dirs with ${opts?.traceFileName ?? "plan_trace.json"} + game_state_log.json under ${target}`)
  }

  const aggregate: RunEvalAggregate = {
    games: 0,
    totalPoints: 0,
    comparablePoints: 0,
    totalBlunders: 0,
    totalDivergences: 0,
    totalAlignmentMisses: 0,
    blunderRate: 0,
    perRule: {},
  }

  for (const dir of gameDirs) {
    const result = await evalGameDir(dir, cfg, { traceFileName: opts?.traceFileName })
    await writeFile(
      join(dir, opts?.evalOutName ?? "plan_eval.json"),
      `${JSON.stringify({ config: cfg, ...result }, null, 2)}\n`,
      "utf-8",
    )
    aggregate.games++
    aggregate.totalPoints += result.metrics.total
    aggregate.comparablePoints += result.metrics.comparablePoints
    aggregate.totalBlunders += result.metrics.blunders
    aggregate.totalDivergences += result.metrics.divergences
    aggregate.totalAlignmentMisses += result.metrics.alignmentMisses
    for (const [k, v] of Object.entries(result.perRule)) {
      const bucket = (aggregate.perRule[k] ??= { points: 0, blunders: 0 })
      bucket.points += v.points
      bucket.blunders += v.blunders
    }
    opts?.onGameDone?.(dir, result)
  }

  aggregate.blunderRate = aggregate.comparablePoints > 0
    ? aggregate.totalBlunders / aggregate.comparablePoints
    : 0
  if (gameDirs.length > 1) {
    await writeFile(
      join(target, opts?.summaryOutName ?? "plan_eval_summary.json"),
      `${JSON.stringify({ config: cfg, ...aggregate }, null, 2)}\n`,
      "utf-8",
    )
  }
  return aggregate
}
