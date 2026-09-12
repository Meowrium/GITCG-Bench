// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

/**
 * plan-replay — 规则链静态回放器（起草/反思期的"修订扰动预演"）。
 *
 * 动机：规则链按 priority 全局升序匹配，修订任何一条规则（改条件/改优先级/增删）
 * 都会改变其后所有规则的命中面——"局部修订"实际是全局扰动。本模块把执行期才知道的
 * coverage/fallback/perRuleHits 统计前移到修订时刻：对上一轮 trace 记录的历史决策点
 * （玩家视角 state 签名）静态重放当前草稿的规则链，产出命中矩阵 + 与原计划的 diff +
 * 逐 op 的反事实断言。
 *
 * 信息纪律（授权边界）：
 * - 语料只读**本侧**文件：plan_trace[.side1].json / plan_eval<suffix>[.side1].json
 *   （与 evidence-extract / modules.ts 的 reflectFileNames 同一套命名）；对手侧的
 *   plan/trace/eval 文件一律不读。stateSignature 本身是 exposeState 脱敏后的
 *   玩家视角 state（对手手牌/骰面隐藏），不含对手决策树信息。
 * - 静态回放只求值 when（then 的候选匹配需要引擎运行时动作列表），因此命中矩阵是
 *   **覆盖上界**；`actionsTakenThisTurn` 在 trace 中无记录，一律按 0 求值（引用该
 *   字段的规则在回放中的读数偏保守）。`opp.hand.hasCardP.*` 的 k 来源：分层模式
 *   下优先用路由命中的 single 计划绑定 known_deck（比 general 更准），否则按
 *   general 声明口径（mirror/known_deck）求值，unknown_deck 恒 undefined。
 *
 * 两层组合（G6，Phase 3a）：组合链排序统一走 rule-chain.ts 的 combinedChain
 * （与 plan-player-io 执行期同一层主序语义）；replayPortfolio 按对手组 × 层化键
 * 输出分层矩阵；verifyPortfolioPatchAssertions 按组聚合逐 op 反事实断言。
 */

import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { DeckConfig, GameData } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { evaluateWhenAll, cardCountMapOf, type PbViewState } from "./fields.js"
import type { PlanFieldContext } from "./fields.js"
import { backfillTraceSignatures } from "./sig-backfill.js"
import type { GamePlanV1 } from "./game-plan-v1.js"
import type { PlanTraceFile } from "./trace.js"
import { formatRuleKey, parseRuleKey } from "./rule-key.js"
import { combinedChain, type ChainLayerSpec, type ChainScopedRule } from "./rule-chain.js"
import type { PortfolioRouting } from "./portfolio.js"

/** 本侧文件命名（trace / eval 与 oracle 回算后缀），授权边界的单一事实源 */
export function sideFileNames(side: 0 | 1, evalSuffix?: string): { traceName: string; evalName: string } {
  const suffix = evalSuffix ? `.${evalSuffix}` : ""
  return {
    traceName: side === 0 ? "plan_trace.json" : "plan_trace.side1.json",
    evalName: side === 0 ? `plan_eval${suffix}.json` : `plan_eval${suffix}.side1.json`,
  }
}

export interface ReplayPoint {
  game: string
  seq: number
  round: number
  turn: number
  /** 决策时刻玩家视角 state（由 stateSignature 反序列化） */
  state: PbViewState
  /** 本侧 oracle 回算信息（无 eval 时缺省） */
  blunder?: boolean
  gap?: number | null
  oracleBest?: string
  /** eval 记录的 blame 键（"global:40" / "<fallback>" / null） */
  traceRule?: string | null
}

export interface ReplayCorpus {
  side: 0 | 1
  gameCount: number
  points: ReplayPoint[]
  /** 语料是否带 oracle 回算列（engine-only 臂为 false——eval 读取被门控） */
  hasEval: boolean
  /** 本 run 的路由形态（组合模式 trace 文件携带；缺省 = 旧单树/未知） */
  routing?: PortfolioRouting
}

export async function loadReplayCorpus(
  runDir: string,
  side: 0 | 1,
  opts?: { evalSuffix?: string; evidence?: "oracle" | "engine-only" },
): Promise<ReplayCorpus> {
  const { traceName, evalName } = sideFileNames(side, opts?.evalSuffix)
  const engineOnly = opts?.evidence === "engine-only"
  const dirs = (await readdir(runDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
    .map((e) => e.name)
    .sort()
  const points: ReplayPoint[] = []
  let gameCount = 0
  let hasEval = false
  let routing: PortfolioRouting | undefined
  for (const game of dirs) {
    const dir = join(runDir, game)
    let trace: PlanTraceFile
    try {
      trace = JSON.parse(await readFile(join(dir, traceName), "utf-8")) as PlanTraceFile
    } catch {
      continue
    }
    // lean trace（traceSignatures="lean"）：从同局 state log 反查回填签名后再建语料
    // （full / 旧格式恒 no-op）。信息纪律不变：回填只注入 exposeState(side, …) 脱敏
    // 结果——与 full 模式内嵌签名的玩家视角信息等价，state log 的对手视角增量不可达。
    await backfillTraceSignatures(dir, trace)
    gameCount++
    routing ??= trace.routing
    const evalBySeq = new Map<number, { isBlunder?: boolean; visitGap?: number | null; oracleBest?: string; matchedRule?: string | null }>()
    if (!engineOnly) {
      try {
        const ev = JSON.parse(await readFile(join(dir, evalName), "utf-8")) as {
          points?: Array<{ seq: number; isBlunder?: boolean; visitGap?: number | null; oracleBest?: string; matchedRule?: string | null }>
        }
        for (const p of ev.points ?? []) evalBySeq.set(p.seq, p)
        if (evalBySeq.size > 0) hasEval = true
      } catch {
        // 未跑 oracle：无 eval 列
      }
    }
    for (const e of trace.entries) {
      if (e.method !== "action" || !e.stateSignature) continue
      let state: PbViewState
      try {
        state = JSON.parse(e.stateSignature) as PbViewState
      } catch {
        continue
      }
      const ev = evalBySeq.get(e.seq)
      points.push({
        game,
        seq: e.seq,
        round: e.round,
        turn: e.turn,
        state,
        blunder: ev?.isBlunder,
        gap: ev?.visitGap,
        oracleBest: ev?.oracleBest,
        traceRule: ev?.matchedRule ?? (e.fallbackUsed ? "<fallback>" : null),
      })
    }
  }
  return { side, gameCount, points, hasEval, ...(routing !== undefined ? { routing } : {}) }
}

// ── 静态求值 ────────────────────────────────────────────────────────────

/** 回放链输入：general 必填；single 为路由命中的层（缺省 = general-only）；layered 为 portfolio 上下文恒 true 标志 */
export interface ReplayChainInput {
  general: GamePlanV1
  /** 路由命中的 single 层（有 → 组合链；无 → general-only） */
  single?: { plan: GamePlanV1; label: string } | null
  /** portfolio 上下文恒 true：general-only 组同样带 general: 前缀（任务 0 口径）；纯旧单树 = false（键无前缀） */
  layered?: boolean
}

/** 组合链 specs（层主序 single < general；rule-chain.ts combinedChain 构造，与执行期同一排序语义） */
function chainSpecsOf(input: ReplayChainInput): ChainLayerSpec[] {
  if (input.single) {
    return [
      { plan: input.single.plan, layer: "single", layerLabel: input.single.label },
      { plan: input.general, layer: "general" },
    ]
  }
  return input.layered === true
    ? [{ plan: input.general, layer: "general" }]
    : [{ plan: input.general }]
}

/**
 * 回放语料没有对手牌表记录：hasCardP 口径（G6，Phase 3a）——
 * 路由命中 single 时用其绑定 known_deck 解码（single 计划必为 known_deck，
 * portfolio 校验 G8①保证，比 general 声明更准）；否则按 general 起草时声明的对手
 * （mirror/known_deck）解码作为 k 来源——与起草假设同口径。unknown_deck 或解码失败
 * → undefined，该字段在回放中恒 undefined（引用它的条件不参与命中面判定）。
 */
function opponentDeckCardsOf(input: ReplayChainInput): ReadonlyMap<number, number> | undefined {
  const plan = input.single?.plan ?? input.general
  const opp = plan.context.opponent
  const code = opp.kind === "mirror" ? plan.context.deckCode
    : opp.kind === "known_deck" ? opp.deckCode
    : undefined
  if (!code) return undefined
  try {
    return cardCountMapOf((DEFAULT_ASSETS_MANAGER.decode(code) as DeckConfig).cards)
  } catch {
    return undefined
  }
}

/** 组合链的每层求值上下文（各层独立判定命中 phase；opponentDeckCards 全链共享） */
function buildLayerContexts(
  point: ReplayPoint,
  side: 0 | 1,
  specs: readonly ChainLayerSpec[],
  gameData: GameData,
  opponentDeckCards?: ReadonlyMap<number, number>,
): PlanFieldContext[] {
  return specs.map((spec) => {
    const base: PlanFieldContext = {
      state: point.state,
      side,
      // 阶段选取时 phase 字段视为 "none"（与 PlanPlayerIO.selectActivePhase 语义一致）
      phaseId: null,
      // trace 不记录该计数；回放按 0 求值（引用该字段的规则读数偏保守，见文件头注记）
      actionsTakenThisTurn: 0,
      gameData,
      opponentDeckCards,
    }
    const activePhase = (spec.plan.phases ?? []).find((p) => evaluateWhenAll(p.when, base))
    return activePhase ? { ...base, phaseId: activePhase.phaseId } : base
  })
}

export function ruleKeyOf(rule: ChainScopedRule): string {
  // 拼键统一走 rule-key.ts（phaseId 在 combinedChain 构造时对 phase 规则必设；
  // 层标注带层前缀，portfolio 上下文与执行期键逐字节一致）
  return formatRuleKey({
    scope: rule.scope,
    priority: rule.priority,
    phaseId: rule.phaseId ?? null,
    layer: rule.layer,
    layerLabel: rule.layerLabel,
  })
}

/**
 * 对齐 corpus.points 顺序返回每个点的首条命中规则键（无命中 = null）。
 * 单树调用（ReplayChainInput 无 single/layered）= 旧格式键，逐字节不变。
 */
export function replayChainPointKeys(input: ReplayChainInput, corpus: ReplayCorpus, gameData: GameData): (string | null)[] {
  const specs = chainSpecsOf(input)
  const chain = combinedChain(specs)
  const opponentDeckCards = opponentDeckCardsOf(input)
  return corpus.points.map((point) => {
    const ctxs = buildLayerContexts(point, corpus.side, specs, gameData, opponentDeckCards)
    for (const { rule, layerIndex } of chain) {
      if (evaluateWhenAll(rule.when, ctxs[layerIndex])) return ruleKeyOf(rule)
    }
    return null
  })
}

/** 单树回放的 pointKeys 兼容入口（旧签名，行为零变化） */
export function replayPointKeys(plan: GamePlanV1, corpus: ReplayCorpus, gameData: GameData): (string | null)[] {
  return replayChainPointKeys({ general: plan }, corpus, gameData)
}

export interface PlanReplayResult {
  totalPoints: number
  /** 规则键 → 首条命中次数 / when 为真但被更早规则遮蔽的次数 */
  perRule: Record<string, { hits: number; shadowed: number }>
  fallbackPoints: Array<{ game: string; seq: number; round: number; blunder?: boolean; gap?: number | null; oracleBest?: string }>
  fallbackRate: number
  /** 与 corpus.points 对齐的首条命中键（null = fallback） */
  pointKeys: (string | null)[]
}

/** 单链回放核心（单树 / 组合链共用；组合模式键带层前缀） */
function replayChainImpl(input: ReplayChainInput, corpus: ReplayCorpus, gameData: GameData): PlanReplayResult {
  const pointKeys = replayChainPointKeys(input, corpus, gameData)
  const perRule: Record<string, { hits: number; shadowed: number }> = {}
  const fallbackPoints: PlanReplayResult["fallbackPoints"] = []
  // when 为真的全部规则（含被遮蔽者）——用于 shadowed 统计
  const specs = chainSpecsOf(input)
  const chain = combinedChain(specs)
  const opponentDeckCards = opponentDeckCardsOf(input)
  const whenTrueSets = corpus.points.map((point) => {
    const ctxs = buildLayerContexts(point, corpus.side, specs, gameData, opponentDeckCards)
    return chain
      .filter(({ rule, layerIndex }) => evaluateWhenAll(rule.when, ctxs[layerIndex]))
      .map(({ rule }) => ruleKeyOf(rule))
  })
  corpus.points.forEach((point, i) => {
    const key = pointKeys[i]
    const trues = whenTrueSets[i]
    for (const k of trues) {
      perRule[k] ??= { hits: 0, shadowed: 0 }
    }
    if (key === null) {
      fallbackPoints.push({ game: point.game, seq: point.seq, round: point.round, blunder: point.blunder, gap: point.gap, oracleBest: point.oracleBest })
    } else {
      perRule[key].hits++
      for (const k of trues) {
        if (k !== key) perRule[k].shadowed++
      }
    }
  })
  const total = corpus.points.length
  return {
    totalPoints: total,
    perRule,
    fallbackPoints,
    fallbackRate: total > 0 ? fallbackPoints.length / total : 0,
    pointKeys,
  }
}

/** 单树回放（旧签名，行为零变化——无 single/layered，键无前缀） */
export function replayPlan(plan: GamePlanV1, corpus: ReplayCorpus, gameData: GameData): PlanReplayResult {
  return replayChainImpl({ general: plan }, corpus, gameData)
}

/** 组合链回放（ReplayChainInput 支持 { general, single? }；分层键带层前缀） */
export function replayChainPlan(input: ReplayChainInput, corpus: ReplayCorpus, gameData: GameData): PlanReplayResult {
  return replayChainImpl(input, corpus, gameData)
}

// ── 反事实断言（patch 后机械验收） ───────────────────────────────────────

export interface PatchAssertion {
  opIndex: number
  op: "revise" | "remove"
  ruleRef: string
  /** 本侧 eval 中该规则的 blunder 点数（断言目标集） */
  targetPoints: number
  /** patch 后这些点仍由该规则首条命中（修订未改变命中面） */
  stillMatched: number
  /** patch 后落入 fallback（覆盖恶化信号） */
  nowFallback: number
  status: "fixed" | "partial" | "ineffective" | "no-target"
  note: string
}

/**
 * 逐 op 断言核心：对 revise/remove 的 ruleRef，取基线 keys 中该规则首条命中的
 * blunder 点，检查 patch 后这些点是否仍由该规则首条命中。
 * 注意：revise 若只修 then（thenMiss 类死规则），静态 when 回放无法确认修复——
 * status 会显示 ineffective，note 中已说明该局限。
 */
function verifyAssertionsCore(
  ops: Array<{ op: string; ruleRef?: string }>,
  corpus: ReplayCorpus,
  baseKeys: (string | null)[],
  nextKeys: (string | null)[],
): PatchAssertion[] {
  const out: PatchAssertion[] = []
  for (const [opIndex, op] of ops.entries()) {
    if ((op.op !== "revise" && op.op !== "remove") || !op.ruleRef) continue
    // 层定位：ruleRef 经 parseRuleKey 解析（单树 = 无前缀；portfolio = 带层前缀
    // general:… / single:<label>:…）；不是合法规则键（fallback/add: 合成 ref）跳过
    if (!parseRuleKey(op.ruleRef) || op.ruleRef.startsWith("add:")) continue
    const targets = corpus.points
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => p.blunder === true && baseKeys[i] === op.ruleRef)
    const stillMatched = targets.filter(({ i }) => nextKeys[i] === op.ruleRef).length
    const nowFallback = targets.filter(({ i }) => nextKeys[i] === null).length
    const n = targets.length
    let status: PatchAssertion["status"]
    if (n === 0) status = "no-target"
    else if (stillMatched === n) status = "ineffective"
    else if (stillMatched === 0) status = nowFallback > 0 ? "partial" : "fixed"
    else status = "partial"
    const notes: string[] = []
    if (status === "ineffective") {
      notes.push(n > 0 ? `${n} 个 blunder 点的 when 条件仍全部命中——若本意是修 then 映射（thenMiss）则静态回放无法确认，需对局复验` : "")
    }
    if (nowFallback > 0) notes.push(`${nowFallback} 个点转入 fallback（覆盖洞，建议补接管规则）`)
    out.push({
      opIndex,
      op: op.op as "revise" | "remove",
      ruleRef: op.ruleRef,
      targetPoints: n,
      stillMatched,
      nowFallback,
      status,
      note: notes.join("；"),
    })
  }
  return out
}

/**
 * 单树回放路径的逐 op 断言（旧签名，行为零变化——base/next 均按无层单树回放，
 * ruleRef 无前缀；合成 ref 跳过）。
 */
export function verifyPatchAssertions(
  ops: Array<{ op: string; ruleRef?: string }>,
  corpus: ReplayCorpus,
  basePlan: GamePlanV1,
  nextPlan: GamePlanV1,
  gameData: GameData,
): PatchAssertion[] {
  const baseKeys = replayPointKeys(basePlan, corpus, gameData)
  const nextKeys = replayPointKeys(nextPlan, corpus, gameData)
  return verifyAssertionsCore(ops, corpus, baseKeys, nextKeys)
}

/** 组合链回放路径的逐 op 断言（base/next 可为 { general, single? }，键带层前缀） */
export function verifyChainPatchAssertions(
  ops: Array<{ op: string; ruleRef?: string }>,
  corpus: ReplayCorpus,
  baseInput: ReplayChainInput,
  nextInput: ReplayChainInput,
  gameData: GameData,
): PatchAssertion[] {
  const baseKeys = replayChainPointKeys(baseInput, corpus, gameData)
  const nextKeys = replayChainPointKeys(nextInput, corpus, gameData)
  return verifyAssertionsCore(ops, corpus, baseKeys, nextKeys)
}

/** portfolio 上下文的逐 op 断言按组聚合的输入目标（ResolvedPortfolio / PatchPlanTarget 结构兼容） */
export interface PortfolioPlanTarget {
  general: GamePlanV1
  singles: Array<{ label: string; plan: GamePlanV1 }>
}

/** 按本组路由构造回放链输入（routing 优先取 trace 的 routing；无则用 singleLabel 提示；否则 general-only 层化链） */
function chainInputOf(target: PortfolioPlanTarget, group: PortfolioReplayGroupInput): ReplayChainInput {
  const routing = group.corpus.routing ?? (group.singleLabel ? (`single:${group.singleLabel}` as const) : undefined)
  if (routing !== undefined && routing.startsWith("single:")) {
    const label = routing.slice("single:".length)
    const single = target.singles.find((s) => s.label === label)
    if (single) return { general: target.general, single: { plan: single.plan, label: single.label }, layered: true }
  }
  return { general: target.general, layered: true }
}

/**
 * portfolio 上下文逐 op 断言：每组按路由（组合链 / general-only 层化链）回放
 * base/next，跨组聚合目标点集合（同一条 general 规则在各组的 blunder 点全部计入；
 * single 层规则只在该 single 被路由的组里出现——键带层前缀天然归组）。
 */
export function verifyPortfolioPatchAssertions(
  ops: Array<{ op: string; ruleRef?: string }>,
  groups: PortfolioReplayGroupInput[],
  base: PortfolioPlanTarget,
  next: PortfolioPlanTarget,
  gameData: GameData,
): PatchAssertion[] {
  const baseKeysByGroup = new Map<string, (string | null)[]>()
  const nextKeysByGroup = new Map<string, (string | null)[]>()
  for (const group of groups) {
    baseKeysByGroup.set(group.label, replayChainPointKeys(chainInputOf(base, group), group.corpus, gameData))
    nextKeysByGroup.set(group.label, replayChainPointKeys(chainInputOf(next, group), group.corpus, gameData))
  }
  const out: PatchAssertion[] = []
  for (const [opIndex, op] of ops.entries()) {
    if ((op.op !== "revise" && op.op !== "remove") || !op.ruleRef) continue
    if (!parseRuleKey(op.ruleRef) || op.ruleRef.startsWith("add:")) continue
    let n = 0
    let stillMatched = 0
    let nowFallback = 0
    for (const group of groups) {
      const baseKeys = baseKeysByGroup.get(group.label)!
      const nextKeys = nextKeysByGroup.get(group.label)!
      group.corpus.points.forEach((p, i) => {
        if (p.blunder !== true || baseKeys[i] !== op.ruleRef) return
        n++
        if (nextKeys[i] === op.ruleRef) stillMatched++
        if (nextKeys[i] === null) nowFallback++
      })
    }
    let status: PatchAssertion["status"]
    if (n === 0) status = "no-target"
    else if (stillMatched === n) status = "ineffective"
    else if (stillMatched === 0) status = nowFallback > 0 ? "partial" : "fixed"
    else status = "partial"
    const notes: string[] = []
    if (status === "ineffective") {
      notes.push(n > 0 ? `${n} 个 blunder 点的 when 条件仍全部命中——若本意是修 then 映射（thenMiss）则静态回放无法确认，需对局复验` : "")
    }
    if (nowFallback > 0) notes.push(`${nowFallback} 个点转入 fallback（覆盖洞，建议补接管规则）`)
    out.push({
      opIndex,
      op: op.op as "revise" | "remove",
      ruleRef: op.ruleRef,
      targetPoints: n,
      stillMatched,
      nowFallback,
      status,
      note: notes.join("；"),
    })
  }
  return out
}

// ── 分层回放（G6，Phase 3a）─────────────────────────────────────────────

/** 分层 × 分组矩阵：一行 = 一个对手组（run 目录），一列 = 层化规则键 */
export interface PortfolioReplayGroup {
  label: string
  /** 本组路由（"single:<label>" | "general-only"） */
  routing: PortfolioRouting
  /** 本组回放结果（perRule 键带层前缀；形状与 replayPlan 一致，plan_simulate 可渲染） */
  replay: PlanReplayResult
  /** 本组语料（渲染矩阵摘要需 gameCount/hasEval；replayPortfolio 不填，调用方回填） */
  corpus?: ReplayCorpus
}

export interface PortfolioReplayResult {
  /** 组 label → 该组分层回放 */
  perGroup: Record<string, PortfolioReplayGroup>
  /** 组顺序（Record 键序不可靠，另存数组） */
  groupOrder: string[]
  /** 全部组总点数 / 总 fallback 数（横向汇总） */
  totalPoints: number
  totalFallback: number
}

/** replayPortfolio 的分组输入（singleLabel 为路由提示：trace 无 routing 元信息时的回退） */
export interface PortfolioReplayGroupInput {
  label: string
  corpus: ReplayCorpus
  /** 本组路由到的 single label（缺省 = general-only；trace 已带 routing 时以 trace 为准） */
  singleLabel?: string
}

/**
 * portfolio 分层回放：每组按路由（有 single → 组合链；无 → general-only 层化链）
 * 对历史决策点静态回放，输出分层 × 分组矩阵。行 = 组 label，列 = 层化规则键
 * （值含首条命中 hits / 被遮蔽 shadowed，见 PlanReplayResult.perRule）。
 */
export function replayPortfolio(
  portfolio: PortfolioPlanTarget,
  groups: PortfolioReplayGroupInput[],
  gameData: GameData,
): PortfolioReplayResult {
  const perGroup: Record<string, PortfolioReplayGroup> = {}
  const groupOrder: string[] = []
  let totalPoints = 0
  let totalFallback = 0
  for (const group of groups) {
    const input = chainInputOf(portfolio, group)
    const routing: PortfolioRouting = group.corpus.routing
      ?? (group.singleLabel ? `single:${group.singleLabel}` : "general-only")
    const replay = replayChainPlan(input, group.corpus, gameData)
    perGroup[group.label] = { label: group.label, routing, replay }
    groupOrder.push(group.label)
    totalPoints += replay.totalPoints
    totalFallback += replay.fallbackPoints.length
  }
  return { perGroup, groupOrder, totalPoints, totalFallback }
}

// ── 报告格式化 ──────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<PatchAssertion["status"], string> = {
  fixed: "已生效（失误点不再由该规则命中）",
  partial: "部分生效",
  ineffective: "未见效（when 命中面未变）",
  "no-target": "无关联 blunder 点（低频规则或修 then 类意图，静态回放无法判定）",
}

export function formatPatchVerification(opts: {
  opsCount: number
  assertions: PatchAssertion[]
  base: PlanReplayResult
  next: PlanReplayResult
  lintFindings?: Array<{ path: string; message: string }>
  maxTransitions?: number
}): string {
  const lines: string[] = []
  const fb0 = (opts.base.fallbackRate * 100).toFixed(1)
  const fb1 = (opts.next.fallbackRate * 100).toFixed(1)
  lines.push(`静态回放核验（语料 ${opts.base.totalPoints} 点）：fallback 率 ${fb0}% → ${fb1}%`)
  const allRules = new Set([...Object.keys(opts.base.perRule), ...Object.keys(opts.next.perRule)])
  const deltas = [...allRules]
    .map((r) => ({ r, before: opts.base.perRule[r]?.hits ?? 0, after: opts.next.perRule[r]?.hits ?? 0 }))
    .filter((d) => d.before !== d.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
  if (deltas.length > 0) {
    lines.push(`命中面变化（hits 变动的规则，前 12）：${deltas.slice(0, 12).map((d) => `${d.r} ${d.before}→${d.after}`).join("；")}`)
    // 命中点迁移样例
    const transitions: string[] = []
    const maxT = opts.maxTransitions ?? 8
    for (let i = 0; i < opts.base.pointKeys.length && transitions.length < maxT; i++) {
      if (opts.base.pointKeys[i] !== opts.next.pointKeys[i]) {
        transitions.push(`${opts.base.pointKeys[i] ?? "<fallback>"} → ${opts.next.pointKeys[i] ?? "<fallback>"}`)
      }
    }
    if (transitions.length > 0) lines.push(`命中迁移样例：${transitions.join("；")}`)
  } else {
    lines.push("各规则命中面无变化")
  }
  if (opts.assertions.length > 0) {
    lines.push("逐 op 断言：")
    for (const a of opts.assertions) {
      const target = a.targetPoints > 0 ? `${a.targetPoints} 个 blunder 点，其中 ${a.stillMatched} 个仍由 ${a.ruleRef} 命中、${a.nowFallback} 个转入 fallback` : "无关联 blunder 点"
      lines.push(`- ops[${a.opIndex}] ${a.op} ${a.ruleRef}：${STATUS_LABELS[a.status]}（${target}）${a.note ? `。${a.note}` : ""}`)
    }
  }
  if (opts.lintFindings && opts.lintFindings.length > 0) {
    lines.push(`静态 lint：${opts.lintFindings.slice(0, 6).map((f) => `${f.path} ${f.message}`).join("；")}`)
  }
  return lines.join("\n")
}

/** plan_simulate 模块的矩阵摘要（模块内容用，≤4000 字符由注册表统一截断） */
export function formatMatrixSummary(replay: PlanReplayResult, corpus: ReplayCorpus): string {
  const lines: string[] = []
  lines.push(`语料：${corpus.gameCount} 局 / ${replay.totalPoints} 个 action 决策点（静态回放 = 覆盖上界，actionsTakenThisTurn 按 0 求值）`)
  const sorted = Object.entries(replay.perRule).sort((a, b) => b[1].hits - a[1].hits)
  lines.push(`规则命中（首条命中/被遮蔽）：${sorted.slice(0, 30).map(([k, v]) => `${k} ${v.hits}/${v.shadowed}`).join("；")}${sorted.length > 30 ? `（另 ${sorted.length - 30} 条）` : ""}`)
  lines.push(`fallback：${replay.fallbackPoints.length} 点（${(replay.fallbackRate * 100).toFixed(1)}%）`)
  if (replay.fallbackPoints.length > 0) {
    if (corpus.hasEval) {
      const fbBlunder = replay.fallbackPoints.filter((p) => p.blunder).length
      lines.push(`fallback 点（前 10，✗=oracle 判失误）：${replay.fallbackPoints.slice(0, 10).map((p) => `${p.game}:seq${p.seq} r${p.round}${p.blunder ? "✗" : ""}`).join("；")}${replay.fallbackPoints.length > 10 ? "…" : ""}`)
      lines.push(`fallback 点中 oracle 判失误：${fbBlunder} 个`)
    } else {
      lines.push(`fallback 点（前 10）：${replay.fallbackPoints.slice(0, 10).map((p) => `${p.game}:seq${p.seq} r${p.round}`).join("；")}${replay.fallbackPoints.length > 10 ? "…" : ""}`)
    }
  }
  return lines.join("\n")
}
