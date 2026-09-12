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
 * plan:ablate — 消融臂编排器（设计文档 §6 falsifiableClaim 验证）。
 *
 * 对反思产出的每条裁决（revise/remove + 非空 falsifiableClaim），生成
 * 单变量消融计划（remove=删该规则；revise=换成 r1 中同位置修订版），
 * 与 r0 基线在同一 seed 梯（含相同先手交替设置）上各跑 N 局并做 oracle
 * 回算，机械判定 claim 真假：
 *   - revise：该规则的 blunder 率下降 ≥ minEffect → supported，上升 ≥ minEffect
 *     → refuted，否则 inconclusive（效应量阈值过滤噪声级移动）
 *   - remove：整体 blunderRate 下降 ≥ minEffect → supported（声称"该规则有害"），
 *     上升 ≥ minEffect → refuted，否则 inconclusive
 * 判定 note 附 McNemar 配对计数（baseline blunder & 臂非 blunder = b，反向 = c）。
 *
 * --evidence engine-only（2026-08-30 无 oracle 自进化臂 S-M2）：消融臂不读任何
 * eval 文件（基线 plan_eval_summary 不读、臂不回算、无 McNemar），判据全部来自
 * 批跑 summary（ablate-criteria.ts）：
 *   - revise 且基线 thenMiss>0：thenMiss 归零 → supported；未降 → refuted；
 *     部分下降 → inconclusive；coverage/fallback 劣化超 --coverage-tol（默认 5pp）
 *     一律 inconclusive（覆盖崩坏混淆闸）
 *   - revise 且为数值修订（then.damage_min / then.kills / when 骰子闸或 HP 闸数值
 *     变化，检测在 ablate-numeric.ts）：同种子反事实判据——base/arm 同 seed 逐局
 *     配对取该规则命中数，配对 seeds<20 → inconclusive，每局命中率差超 ±minEffect
 *     才下方向性结论；配对不可用（缺 perGame / 缺逐条目规则身份 / 两侧零命中）
 *     回落胜率区间并在 note 注明
 *   - remove 或其余 revise：胜率区间判据，N≥20 才生效（否则 inconclusive），
 *     臂胜率−基线胜率超 ±minEffect 才下方向性结论
 *
 * 用法：
 *   pnpm run plan:ablate -- --base <r0 plan> --revised <r1 plan> \
 *     --reflection <r1.reflection.json> --baseline-run <round games dir> \
 *     --side <0|1> --opponent-plan <对方 r0 plan> --out <dir> [--top 5] [--games 10] [--min-effect 0.03] \
 *     [--evidence oracle|engine-only] [--coverage-tol 0.05]
 *
 * 前提：baseline-run 目录已有该侧的批跑 summary（side0: summary.json，
 * side1: summary.side1.json——均为该计划口径的统计）与 plan_eval_summary
 * （engine-only 模式不需要后者），且由修复后的批跑代码产出（含 alternateFirstPlayer 字段）。
 *
 * ── portfolio 模式（G7，Phase 4）──
 *   pnpm run plan:ablate -- --portfolio-base <portfolio.json> --portfolio-revised <manifest|目录> \
 *     --reflection <rN.reflection.json> --evidence-runs <run1,run2,...> --out <dir> \
 *     [--top 5] [--min-effect 0.03] [--coverage-tol 0.05] [--evidence engine-only]
 *
 * 与旧参数互斥（--base/--revised/--baseline-run/--opponent-plan 不得同用；--side 固定 0）。
 * - 臂 = 对 portfolio 应用层化 revise/remove/add（ruleRef 带层前缀 general:… /
 *   single:<label>:…，直接走 applyPlanPatch 的 PatchPlanTarget 重载）；
 * - 对手矩阵：general 臂对全部 evidence 组批跑；single 臂只跑路由到该 single 的组
 *   （resolveGroupSingleLabel 判定），无命中组 → 臂 skipped；
 * - 每组批跑：PlanBatchConfig.portfolio = 变异后 portfolio，opponent 复用该证据组的
 *   plan.side1.json（对手必须为 plan 型）；种子/局数沿用该组 baseline summary
 *   （seedBase/games 字段，保持可比）；
 * - 指标：基线 = 各证据组已有 summary；臂 = 新跑。engine-only 判据不变，thenMiss 按
 *   层化键取数；数值修订臂的同种子反事实配对按组提取（trace 键即层化键），
 *   General claim 跨组汇总（胜率按总局数加权、配对命中数组拼接），Single claim 只看本组。
 * - 报告：ablation-report.json 增组维度（每臂 → per-group 结果 + 跨组汇总判定）。
 * - oracle 证据：portfolio 模式先只支持 engine-only（oracle 判据的规则级归因对
 *   组合链无对应基线 eval 产物），非 engine-only 报错。
 */

import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { CURRENT_VERSION, type Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import {
  loadPlanWithValidation,
  runPlanBatch,
} from "../batch-runner.js"
import { parseRuleKey } from "../rule-key.js"
import { loadPortfolioWithValidation, type ResolvedPortfolio } from "../portfolio.js"
import { checkRunDirVersions, resolveDeclaredPlanVersion } from "../version.js"
import {
  validateGamePlan,
  computePlanId,
  type GamePlanV1,
  type DecisionRuleV1,
} from "../index.js"
import { evalRunDir, DEFAULT_EVAL_CONFIG, type RunEvalAggregate } from "../../../evaluation/plan-eval/eval-game.js"
import { judgeEngineOnly, type EngineOnlyJudgeInput, type NumericPairedHits } from "./ablate-criteria.js"
import {
  combineNumericPaired,
  diffNumericRevision,
  extractNumericPairedHits,
  type NumericPairedExtraction,
} from "./ablate-numeric.js"
import type { EvidenceMode } from "./evidence-extract.js"
import { resolveGroupSingleLabel } from "./reflect-portfolio.js"
import {
  aggregateGroupMetrics,
  buildPortfolioAblationArms,
  portfolioFromPatched,
  selectGroupsForArm,
  type AblationClaim,
  type AggregatedMetrics,
  type EvidenceGroupRef,
  type GroupMetricsInput,
  type PortfolioArmReport,
  type PortfolioGroupResult,
} from "./ablate-portfolio.js"

/** 读 JSON 文件；失败时给出可操作的报错（基线产物缺失/旧格式时指明需重跑的管线） */
async function readJsonStrict<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T
  } catch (e) {
    throw new Error(`无法读取${what}（${path}）：${e instanceof Error ? e.message : String(e)}。请先对该侧运行 plan:batch（oracle 口径还需 plan:eval）生成基线产物，见文件头"前提"说明`)
  }
}

interface RuleVerdict {
  ruleRef: string
  verdict: "keep" | "revise" | "remove"
  justification?: string
  falsifiableClaim?: string | null
}

/** 臂/基线的判定输入快照：oracle 口径（blunder）与引擎侧口径（thenMiss/coverage）并存 */
interface ArmMetrics {
  ruleBlunders?: string
  overallBlunderRate?: number
  winRate: number
  ruleThenMiss?: number
  coverage?: number
  fallbackRate?: number
}

interface ArmResult {
  armId: string
  ruleRef: string
  verdict: "revise" | "remove"
  falsifiableClaim: string
  status: "supported" | "refuted" | "inconclusive" | "skipped"
  note: string
  /** McNemar 配对计数：b = 基线 blunder 且臂非 blunder，c = 反向（engine-only 恒 null） */
  paired: { matched: number; b: number; c: number } | null
  /** 数值修订标记（revise 臂）：同种子反事实判据的适用闸（ablate-numeric.ts） */
  numericTouched?: boolean
  /** 数值变化清单（如 "then.damage_min 3→5"） */
  numericChanges?: string[]
  /** 同种子反事实配对命中数（数值修订臂；unavailable 非空 = 已回落胜率区间） */
  numericPaired?: NumericPairedExtraction
  baseline: ArmMetrics
  arm: ArmMetrics & { games: number }
}

/** 按 stateSignature 收集 (签名 → isBlunder)，供臂间配对 */
async function collectBlunderBySignature(
  root: string,
  evalFileName: string,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  let gameDirs: string[] = []
  try {
    gameDirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
      .map((e) => e.name)
  } catch {
    return out
  }
  for (const g of gameDirs) {
    try {
      const evalFile = JSON.parse(await readFile(join(root, g, evalFileName), "utf-8")) as {
        points?: Array<{ stateSignature: string | null; isBlunder: boolean; alignmentMiss?: boolean }>
      }
      for (const p of evalFile.points ?? []) {
        if (p.stateSignature !== null && !p.alignmentMiss) {
          if (!out.has(p.stateSignature)) out.set(p.stateSignature, p.isBlunder)
        }
      }
    } catch {
      // 缺 eval 文件的对局跳过
    }
  }
  return out
}

/**
 * 薄本地包装：解析统一走 rule-key.ts 的 parseRuleKey（含 add: 前缀处理），
 * 这里把输出适配回消融臂的判别联合——层前缀键（组合模式 ruleRef 协议属
 * Phase 3）与 opening 键在此仍判为不可解析。
 */
function parseRuleRef(ref: string): { scope: "global"; priority: number; added: boolean } | { scope: "phase"; phaseId: string; priority: number; added: boolean } | null {
  const parsed = parseRuleKey(ref)
  if (!parsed || parsed.layer !== undefined) return null
  const added = parsed.added === true
  if (parsed.scope === "global") return { scope: "global", priority: parsed.priority, added }
  if (parsed.scope === "phase") return { scope: "phase", phaseId: parsed.phaseId!, priority: parsed.priority, added }
  return null
}

function findRule(plan: GamePlanV1, ref: ReturnType<typeof parseRuleRef>): DecisionRuleV1 | undefined {
  if (!ref) return undefined
  if (ref.scope === "global") return plan.rules.find((r) => r.priority === ref.priority)
  const phase = plan.phases.find((p) => p.phaseId === ref.phaseId)
  return phase?.rules.find((r) => r.priority === ref.priority)
}

function withRuleRemoved(plan: GamePlanV1, ref: NonNullable<ReturnType<typeof parseRuleRef>>): GamePlanV1 {
  const out = structuredClone(plan)
  if (ref.scope === "global") {
    out.rules = out.rules.filter((r) => r.priority !== ref.priority)
  } else {
    out.phases = out.phases.map((p) => p.phaseId === ref.phaseId
      ? { ...p, rules: p.rules.filter((r) => r.priority !== ref.priority) }
      : p)
  }
  return out
}

function withRuleReplaced(plan: GamePlanV1, ref: NonNullable<ReturnType<typeof parseRuleRef>>, revised: DecisionRuleV1): GamePlanV1 {
  const out = structuredClone(plan)
  if (ref.scope === "global") {
    out.rules = out.rules.map((r) => r.priority === ref.priority ? structuredClone(revised) : r)
  } else {
    out.phases = out.phases.map((p) => p.phaseId === ref.phaseId
      ? { ...p, rules: p.rules.map((r) => r.priority === ref.priority ? structuredClone(revised) : r) }
      : p)
  }
  return out
}

function withRuleAdded(plan: GamePlanV1, ref: NonNullable<ReturnType<typeof parseRuleRef>>, rule: DecisionRuleV1): GamePlanV1 {
  const out = structuredClone(plan)
  const insert = (rules: DecisionRuleV1[]): DecisionRuleV1[] =>
    [...rules, structuredClone(rule)].sort((a, b) => a.priority - b.priority)
  if (ref.scope === "global") {
    out.rules = insert(out.rules)
  } else {
    out.phases = out.phases.map((p) => p.phaseId === ref.phaseId ? { ...p, rules: insert(p.rules) } : p)
  }
  return out
}

// ── portfolio 模式（G7，Phase 4）────────────────────────────────────────

/** 证据组装载结果：路由判定 + 基线 summary 快照 + 对手计划（plan 型） */
interface EvidenceGroup {
  label: string
  dir: string
  singleLabel?: string
  summary: {
    seedBase: number
    games: number
    alternateFirstPlayer?: boolean
    winRate: number
    wins: number
    avgCoverage?: number
    fallbackRate?: number
    perRuleHits?: Record<string, number>
    perRuleThenMiss?: Record<string, number>
    /** 逐局元信息（同种子反事实配对的 seed → gameDir 来源；旧产物可能缺省） */
    perGame?: Array<{ gameDir: string; seed: number }>
    /** 批跑数据版本（V0 起落盘；旧产物缺省 undefined） */
    gameVersion?: string
  }
  opponent: GamePlanV1
}

/** 读组 summary.json（side0 口径）与对手计划 plan.side1.json（plan 型才存在） */
async function loadEvidenceGroup(dir: string): Promise<EvidenceGroup> {
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf-8")) as EvidenceGroup["summary"]
  const opponentPath = join(dir, "plan.side1.json")
  let opponent: GamePlanV1
  try {
    opponent = JSON.parse(await readFile(opponentPath, "utf-8")) as GamePlanV1
  } catch {
    throw new Error(
      `portfolio 消融：证据组 ${dir} 缺 plan.side1.json（对手不是 plan 型或未归档）——`
      + "portfolio 消融 MVP 仅支持 plan 型对手（批跑 config opponent: {type:\"plan\"}）",
    )
  }
  return { label: basename(dir), dir, summary, opponent }
}

/** 每组汇总指标的简化快照（供 General claim 跨组汇总与排序取数） */
function groupSnapshot(g: EvidenceGroup, thenMissOf: (g: EvidenceGroup) => number): GroupMetricsInput {
  return {
    games: g.summary.games,
    wins: g.summary.wins,
    coverage: g.summary.avgCoverage ?? 0,
    fallbackRate: g.summary.fallbackRate ?? 0,
    thenMiss: thenMissOf(g),
  }
}

/** engine-only 判据输入构造（层化键 refKey 取数；G7-2/3） */
function engineOnlyInput(opts: {
  verdict: "revise" | "remove"
  refKey: string
  baseline: AggregatedMetrics
  arm: AggregatedMetrics
  minEffect: number
  coverageTol: number
  /** 同种子反事实配对命中数（数值修订 revise 臂；缺省 = 不可用，回落胜率区间） */
  numericPaired?: NumericPairedHits
}): EngineOnlyJudgeInput {
  return {
    verdict: opts.verdict,
    ruleRef: opts.refKey,
    baseThenMiss: opts.baseline.thenMiss,
    armThenMiss: opts.arm.thenMiss,
    baseCoverage: opts.baseline.coverage,
    armCoverage: opts.arm.coverage,
    baseFallbackRate: opts.baseline.fallbackRate,
    armFallbackRate: opts.arm.fallbackRate,
    baseWinRate: opts.baseline.winRate,
    armWinRate: opts.arm.winRate,
    games: opts.arm.games,
    minEffect: opts.minEffect,
    coverageTol: opts.coverageTol,
    ...(opts.numericPaired ? { numericPaired: opts.numericPaired } : {}),
  }
}

/** 配对判据的可用部分（去降级字段）；不可用时返回 undefined → 判定回落胜率区间 */
function usablePaired(p: NumericPairedExtraction | null): NumericPairedHits | undefined {
  return p && !p.unavailable ? { seeds: p.seeds, baseHits: p.baseHits, armHits: p.armHits } : undefined
}

/** 配对降级/跳局的 note 后缀（判定 note 尾注） */
function pairedNoteSuffix(p: NumericPairedExtraction | null): string {
  if (!p) return ""
  if (p.unavailable) return `；同种子反事实判据不可用（${p.unavailable}）——回落胜率区间`
  return p.skipped > 0 ? `；同种子反事实配对跳过 ${p.skipped} 局（单侧缺失/不可读）` : ""
}

/** 每条 claim 的基线排序键（engine-only：跨组 thenMiss 汇总为主信号；refKey 层化取数） */
function baselineRankOf(groups: EvidenceGroup[], refKey: string): number {
  const agg = aggregateGroupMetrics(groups.map((g) => groupSnapshot(g, (gg) => gg.summary.perRuleThenMiss?.[refKey] ?? 0)))
  return agg.thenMiss * 10000
}

/**
 * portfolio 模式主流程（G7）：臂 = 对 portfolio 应用层化 revise/remove/add；
 * general 臂对全部证据组批跑，single 臂只跑路由命中组；engine-only 判据不变，
 * 报告带组维度 + 跨组汇总判定。
 */
async function runPortfolioAblation(opts: {
  base: ResolvedPortfolio
  revised: ResolvedPortfolio
  evidenceGroups: EvidenceGroup[]
  claims: AblationClaim[]
  outDir: string
  top: number
  minEffect: number
  coverageTol: number
  /** 对局数据版本（V1 版本钉扎：main 按 base/revised 共同版本解析后传入） */
  gameVersion: Version
}): Promise<void> {
  const { base, revised, evidenceGroups, claims, outDir, top, minEffect, coverageTol, gameVersion } = opts
  const data = getData(gameVersion)
  const groupRefs: EvidenceGroupRef[] = evidenceGroups.map((g) => ({ label: g.label, singleLabel: g.singleLabel }))
  const results: PortfolioArmReport[] = []
  const skippedCounts = { unsupported: 0, noGroup: 0, patchFail: 0 }
  const tested: Array<PortfolioArmReport & { summary: NonNullable<PortfolioArmReport["summary"]> }> = []
  let armIndex = 0

  for (const arm of buildPortfolioAblationArms({ base, revised, claims })) {
    const layerLabel = arm.layer.kind === "general" ? "general" : `single:${arm.layer.label}`
    if (arm.skipped) {
      skippedCounts.unsupported++
      console.log(`[${arm.ruleRef}] SKIP: ${arm.skipped}`)
      results.push({
        armId: "", ruleRef: arm.ruleRef, verdict: arm.verdict, falsifiableClaim: arm.falsifiableClaim,
        layer: arm.layer, refKey: arm.refKey, status: "skipped", note: arm.skipped, groups: [], summary: null,
      })
      continue
    }
    // 组选择（G7-1/2）：general 臂全组；single 臂仅路由命中组
    const { selected, skippedNote } = selectGroupsForArm(arm.layer, groupRefs)
    if (skippedNote) {
      skippedCounts.noGroup++
      console.log(`[${arm.ruleRef}] SKIP: ${skippedNote}`)
      results.push({
        armId: "", ruleRef: arm.ruleRef, verdict: arm.verdict, falsifiableClaim: arm.falsifiableClaim,
        layer: arm.layer, refKey: arm.refKey, status: "skipped", note: skippedNote, groups: [], summary: null,
      })
      continue
    }
    armIndex++
    const armId = `arm-${String(armIndex).padStart(2, "0")}-${arm.ruleRef.replace(/:/g, "_")}`
    const armDir = join(outDir, armId)
    await mkdir(armDir, { recursive: true })
    // 变异后 portfolio（patch 已逐层重算 planId；portfolioId 重算）
    const patchedPortfolio = portfolioFromPatched(base, arm.patched)

    const groupResults: PortfolioGroupResult[] = []
    const baselineSnaps: GroupMetricsInput[] = []
    const armSnaps: GroupMetricsInput[] = []
    const numericSnaps: NumericPairedExtraction[] = []
    for (const g of selected) {
      const evGroup = evidenceGroups.find((eg) => eg.label === g.label)!
      const groupGamesDir = join(armDir, g.label, "games")
      const baseThenMiss = evGroup.summary.perRuleThenMiss?.[arm.refKey] ?? 0
      // 臂批跑：portfolio = 变异后组合，opponent 复用该证据组的 plan 型对手，种子/局数沿用组基线
      const armBatch = await runPlanBatch({
        plan: patchedPortfolio.general,
        portfolio: patchedPortfolio,
        opponent: { type: "plan", plan: evGroup.opponent },
        opponentDeckCode: evGroup.opponent.context.deckCode,
        games: evGroup.summary.games,
        seedBase: evGroup.summary.seedBase,
        alternateFirstPlayer: evGroup.summary.alternateFirstPlayer,
        outDir: groupGamesDir,
        concurrency: 4,
      }, data)
      const armThenMiss = armBatch.perRuleThenMiss?.[arm.refKey] ?? 0
      // 同种子反事实配对（数值修订 revise 臂）：本组基线/臂 trace 按 seed 配对取命中数
      const numericPaired = arm.verdict === "revise" && arm.numericTouched === true
        ? await extractNumericPairedHits({
          baseRunDir: evGroup.dir,
          armRunDir: groupGamesDir,
          traceFileName: "plan_trace.json",
          refKey: arm.refKey,
          basePerGame: evGroup.summary.perGame ?? [],
          armPerGame: armBatch.perGame,
        })
        : null
      if (numericPaired) numericSnaps.push(numericPaired)
      // 组内判定（McNemar 配对逐组进行；engine-only 无 eval 配对）
      const judged = judgeEngineOnly(engineOnlyInput({
        verdict: arm.verdict,
        refKey: arm.refKey,
        baseline: { games: evGroup.summary.games, wins: evGroup.summary.wins, winRate: evGroup.summary.winRate, coverage: evGroup.summary.avgCoverage ?? 0, fallbackRate: evGroup.summary.fallbackRate ?? 0, thenMiss: baseThenMiss },
        arm: { games: armBatch.games, wins: armBatch.wins, winRate: armBatch.winRate, coverage: armBatch.avgCoverage, fallbackRate: armBatch.fallbackRate, thenMiss: armThenMiss },
        minEffect,
        coverageTol,
        numericPaired: usablePaired(numericPaired),
      }))
      const judgedNote = judged.note + pairedNoteSuffix(numericPaired)
      groupResults.push({
        group: evGroup.label,
        routing: evGroup.singleLabel ? `single:${evGroup.singleLabel}` : "general-only",
        status: judged.status,
        note: judgedNote,
        baseline: { winRate: evGroup.summary.winRate, coverage: evGroup.summary.avgCoverage, fallbackRate: evGroup.summary.fallbackRate, thenMiss: baseThenMiss },
        arm: { winRate: armBatch.winRate, coverage: armBatch.avgCoverage, fallbackRate: armBatch.fallbackRate, thenMiss: armThenMiss, games: armBatch.games },
      })
      baselineSnaps.push({
        games: evGroup.summary.games,
        wins: evGroup.summary.wins,
        coverage: evGroup.summary.avgCoverage ?? 0,
        fallbackRate: evGroup.summary.fallbackRate ?? 0,
        thenMiss: baseThenMiss,
      })
      armSnaps.push({
        games: armBatch.games,
        wins: armBatch.wins,
        coverage: armBatch.avgCoverage,
        fallbackRate: armBatch.fallbackRate,
        thenMiss: armThenMiss,
      })
      console.log(`[${armId}] ${g.label}: ${judged.status} ${arm.ruleRef} (${arm.verdict}): ${judgedNote}; winRate ${(evGroup.summary.winRate * 100).toFixed(0)}%→${(armBatch.winRate * 100).toFixed(0)}%`)
    }
    // 跨组汇总判定（General claim 口径：胜率按总局数加权；Single claim 只看本组）
    const summaryBaseline = aggregateGroupMetrics(baselineSnaps)
    const summaryArm = aggregateGroupMetrics(armSnaps)
    const summaryPaired = arm.verdict === "revise" && arm.numericTouched === true
      ? combineNumericPaired(numericSnaps)
      : null
    const summaryJudged = judgeEngineOnly(engineOnlyInput({
      verdict: arm.verdict,
      refKey: arm.refKey,
      baseline: summaryBaseline,
      arm: summaryArm,
      minEffect,
      coverageTol,
      numericPaired: usablePaired(summaryPaired),
    }))
    const summaryNote = summaryJudged.note + pairedNoteSuffix(summaryPaired)
    tested.push({
      armId, ruleRef: arm.ruleRef, verdict: arm.verdict, falsifiableClaim: arm.falsifiableClaim,
      layer: arm.layer, refKey: arm.refKey,
      status: summaryJudged.status, note: summaryNote,
      groups: groupResults,
      summary: {
        status: summaryJudged.status,
        note: summaryNote,
        games: summaryArm.games,
        baseline: summaryBaseline,
        arm: summaryArm,
      },
    })
    console.log(`[${armId}] SUMMARY ${summaryJudged.status.toUpperCase()} ${arm.ruleRef} (${arm.verdict}): ${summaryNote}`)
  }

  results.push(...tested)
  results.sort((a, b) => (a.armId === "" ? 1 : 0) - (b.armId === "" ? 1 : 0) || a.armId.localeCompare(b.armId))
  const totals = {
    tested: tested.length,
    supported: tested.filter((r) => r.status === "supported").length,
    refuted: tested.filter((r) => r.status === "refuted").length,
    inconclusive: tested.filter((r) => r.status === "inconclusive").length,
    skipped: results.filter((r) => r.status === "skipped").length,
  }
  const report = {
    mode: "portfolio" as const,
    basePortfolioId: base.portfolioId,
    revisedPortfolioId: revised.portfolioId,
    evidence: "engine-only" as const,
    side: 0,
    totals,
    groups: evidenceGroups.map((g) => ({ label: g.label, singleLabel: g.singleLabel ?? null, games: g.summary.games, seedBase: g.summary.seedBase })),
    arms: results,
  }
  await writeFile(join(outDir, "ablation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8")
  console.log(`\n消融报告 → ${join(outDir, "ablation-report.json")}`)
  console.log(`supported=${totals.supported} refuted=${totals.refuted} inconclusive=${totals.inconclusive} skipped=${totals.skipped}（层不存在/无命中组：unsupported=${skippedCounts.unsupported} noGroup=${skippedCounts.noGroup}）`)
}

/** --portfolio-revised 接受 manifest 路径或目录（目录则读其 portfolio.json） */
async function loadPortfolioArg(path: string): Promise<ResolvedPortfolio> {
  let manifestPath = path
  try {
    const st = await stat(path)
    if (st.isDirectory()) manifestPath = join(path, "portfolio.json")
  } catch {
    // 文件不存在 → 交由 loadPortfolioWithValidation 报错
  }
  const loaded = await loadPortfolioWithValidation(manifestPath)
  for (const w of loaded.warnings) console.warn(`[portfolio warn] ${w}`)
  return loaded.portfolio
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--")
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const basePath = get("base")
  const revisedPath = get("revised")
  const reflectionPath = get("reflection")
  const baselineRun = get("baseline-run")
  const side = Number(get("side") ?? "0") as 0 | 1
  const opponentPlanPath = get("opponent-plan")
  const outDir = get("out")
  const top = Number(get("top") ?? 5)
  const games = Number(get("games") ?? 10)
  const minEffect = Number(get("min-effect") ?? 0.03)
  const coverageTol = Number(get("coverage-tol") ?? 0.05)
  const evidenceRaw = get("evidence") ?? "oracle"
  const portfolioBasePath = get("portfolio-base")
  const portfolioRevisedPath = get("portfolio-revised")
  const evidenceRunsRaw = get("evidence-runs")
  const portfolioMode = portfolioBasePath !== undefined || portfolioRevisedPath !== undefined || evidenceRunsRaw !== undefined
  // 版本错配放行（V1）：所有版本错误降级 warning（与 batch/reflect 侧语义一致）
  const force = args.includes("--force")

  // ── portfolio 模式参数校验（G7）：与旧参数互斥；evidence 仅 engine-only；side 固定 0 ──
  if (portfolioMode) {
    if (!portfolioBasePath || !portfolioRevisedPath || !evidenceRunsRaw) {
      console.error("portfolio 模式需同时提供 --portfolio-base <manifest> --portfolio-revised <manifest|目录> --evidence-runs <run1,run2,...>")
      process.exit(1)
    }
    if (basePath || revisedPath || baselineRun || opponentPlanPath) {
      console.error("portfolio 模式与 --base/--revised/--baseline-run/--opponent-plan 互斥（旧单树路径逐行不变）")
      process.exit(1)
    }
    if (evidenceRaw !== "engine-only") {
      console.error("portfolio 模式当前仅支持 --evidence engine-only（oracle 判据的规则级归因对组合链无对应基线 eval 产物）；收到 " + String(evidenceRaw))
      process.exit(1)
    }
    if (side !== 0) {
      console.error("portfolio 模式固定 side=0（portfolio 为批跑主计划，对手读证据组 plan.side1.json）；收到 --side " + String(side))
      process.exit(1)
    }
    if (!reflectionPath || !outDir) {
      console.error("usage: plan:ablate portfolio -- --portfolio-base <portfolio.json> --portfolio-revised <manifest|目录> --reflection <rN.reflection.json> --evidence-runs <run1,run2,...> --out <dir> [--top 5] [--min-effect 0.03] [--coverage-tol 0.05] [--force]")
      process.exit(1)
    }
    const reflection = JSON.parse(await readFile(reflectionPath, "utf-8")) as { ruleVerdicts?: RuleVerdict[] }
    const claims: AblationClaim[] = (reflection.ruleVerdicts ?? [])
      .filter((v): v is RuleVerdict & { verdict: "revise" | "remove" } =>
        (v.verdict === "revise" || v.verdict === "remove") && typeof v.ruleRef === "string" && typeof v.falsifiableClaim === "string")
      .map((v) => ({ ruleRef: v.ruleRef!, verdict: v.verdict, falsifiableClaim: v.falsifiableClaim! }))
    const evidenceGroupDirs = evidenceRunsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    const evidenceGroups = await Promise.all(evidenceGroupDirs.map(loadEvidenceGroup))
    // 组 → Single 路由判定（复用 reflect-portfolio 的 resolveGroupSingleLabel 逻辑）
    const base = await loadPortfolioArg(portfolioBasePath)
    for (const g of evidenceGroups) {
      g.singleLabel = await resolveGroupSingleLabel(g.dir, 0, base)
    }
    const revised = await loadPortfolioArg(portfolioRevisedPath)
    // 版本钉扎（V1）：base 与 revised 两 manifest 的共同版本必须一致（含"一方声明
    // 一方未声明"）；不一致 → 报错中断，--force 降级 warning（以 revised 为准）
    let planVersion: Version
    {
      const bv = base.commonGameVersion
      const rv = revised.commonGameVersion
      if (bv === rv) {
        planVersion = bv ?? CURRENT_VERSION
      } else {
        const message = `portfolio-base 与 portfolio-revised 的共同版本不一致（base=${bv ?? "（未声明）"}，revised=${rv ?? "（未声明）"}）——跨版本消融会引入词表漂移噪声`
        if (!force) {
          console.error(`[version] ${message}；请统一版本，或加 --force 放行（以 revised 为准）`)
          process.exit(1)
        }
        console.warn(`[version warn] ${message}；--force 放行，实际使用 ${rv ?? bv ?? CURRENT_VERSION}`)
        planVersion = rv ?? bv ?? CURRENT_VERSION
      }
      // 证据组 run 目录版本断言（旧产物未标注 → warning；错配 → 中断，--force 降级）
      const check = checkRunDirVersions(
        evidenceGroups.map((g) => ({ dir: g.dir, version: g.summary.gameVersion })),
        planVersion,
        { force },
      )
      for (const w of check.warnings) console.warn(`[version warn] ${w}`)
      if (check.errors.length > 0) {
        for (const e of check.errors) console.error(`[version] ${e}`)
        console.error("证据组 run 目录与计划版本错配——请统一版本后重试，或加 --force 放行（降级 warning）。")
        process.exit(1)
      }
      console.log(`[version] ablate(portfolio) gameVersion=${planVersion}（臂批跑数据按此版本；--force=${force}）`)
    }
    // 排序：按基线 thenMiss 汇总降序选 top（与旧模式 engine-only 排序同口径，refKey 层化）
    const rankedClaims = [...claims].sort((a, b) => baselineRankOf(evidenceGroups, b.ruleRef) - baselineRankOf(evidenceGroups, a.ruleRef))
    await mkdir(outDir, { recursive: true })
    await runPortfolioAblation({
      base,
      revised,
      evidenceGroups,
      claims: rankedClaims.slice(0, top),
      outDir,
      top,
      minEffect,
      coverageTol,
      gameVersion: planVersion,
    })
    return
  }

  if (!basePath || !revisedPath || !reflectionPath || !baselineRun || !opponentPlanPath || !outDir || (side !== 0 && side !== 1)
    || (evidenceRaw !== "oracle" && evidenceRaw !== "engine-only")) {
    console.error("usage: plan:ablate -- --base <r0> --revised <r1> --reflection <r1.reflection.json> --baseline-run <dir> --side <0|1> --opponent-plan <对方 r0> --out <dir> [--top 5] [--games 10] [--min-effect 0.03] [--evidence oracle|engine-only] [--coverage-tol 0.05] [--force]")
    process.exit(1)
  }
  const evidence = evidenceRaw as EvidenceMode
  const engineOnly = evidence === "engine-only"

  const base = await loadPlanWithValidation(basePath)
  const revised = await loadPlanWithValidation(revisedPath)
  const opponent = await loadPlanWithValidation(opponentPlanPath)
  const reflection = JSON.parse(await readFile(reflectionPath, "utf-8")) as { ruleVerdicts?: RuleVerdict[] }
  const verdicts = reflection.ruleVerdicts ?? []

  // 版本钉扎（V1）：消融数据版本 = 被修订计划声明 ?? CURRENT_VERSION；base/opponent
  // 若声明了不同版本 → 报错中断（--force 降级 warning）
  let planVersion: Version
  try {
    planVersion = resolveDeclaredPlanVersion(revised)
  } catch (e) {
    console.error(`[version] ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }
  for (const [what, plan] of [["base", base], ["opponent", opponent]] as const) {
    const declared = plan.context.gameVersion
    if (declared !== undefined && declared !== planVersion) {
      const message = `${what} 计划声明的 gameVersion=${declared} 与被修订计划版本 ${planVersion} 不一致——跨版本消融会引入词表漂移噪声`
      if (!force) {
        console.error(`[version] ${message}；请统一版本，或加 --force 放行`)
        process.exit(1)
      }
      console.warn(`[version warn] ${message}；--force 放行`)
    }
  }
  const data = getData(planVersion)
  // 基线数据：该侧批跑 summary（计划口径 winRate，无需反转）+ oracle 归因（engine-only 不读）
  const summaryName = side === 0 ? "summary.json" : "summary.side1.json"
  const evalSummaryName = side === 0 ? "plan_eval_summary.json" : "plan_eval_summary.side1.json"
  const batchSummary = await readJsonStrict<{
    seedBase: number
    winRate: number
    alternateFirstPlayer?: boolean
    avgCoverage?: number
    fallbackRate?: number
    perRuleHits?: Record<string, number>
    perRuleThenMiss?: Record<string, number>
    /** 逐局元信息（同种子反事实配对的 seed → gameDir 来源；旧产物可能缺省） */
    perGame?: Array<{ gameDir: string; seed: number }>
    /** 批跑数据版本（V0 起落盘；旧产物缺省 undefined） */
    gameVersion?: string
  }>(join(baselineRun, summaryName), `基线批跑 ${summaryName}`)
  // 版本钉扎（V1）：基线 run 目录版本断言（旧产物未标注 → warning；错配 → 中断，--force 降级）
  {
    const check = checkRunDirVersions([{ dir: baselineRun, version: batchSummary.gameVersion }], planVersion, { force })
    for (const w of check.warnings) console.warn(`[version warn] ${w}`)
    if (check.errors.length > 0) {
      for (const e of check.errors) console.error(`[version] ${e}`)
      console.error("基线 run 目录与计划版本错配——请统一版本后重试，或加 --force 放行（降级 warning）。")
      process.exit(1)
    }
    console.log(`[version] ablate gameVersion=${planVersion}（臂批跑数据按此版本；--force=${force}）`)
  }
  const baselineEval = engineOnly
    ? null
    : await readJsonStrict<RunEvalAggregate>(join(baselineRun, evalSummaryName), `基线 ${evalSummaryName}`)
  const seedBase = batchSummary.seedBase
  const alternateFirstPlayer = batchSummary.alternateFirstPlayer === true
  const baselineWinRate = batchSummary.winRate // 该计划口径（修复后的批跑已按侧聚合）
  const baselineCoverage = batchSummary.avgCoverage ?? 0
  const baselineFallbackRate = batchSummary.fallbackRate ?? 0
  const baselineThenMissOf = (key: string) => batchSummary.perRuleThenMiss?.[key] ?? 0
  const baselineMetrics: ArmMetrics = engineOnly
    ? { winRate: baselineWinRate, coverage: baselineCoverage, fallbackRate: baselineFallbackRate }
    : { overallBlunderRate: baselineEval!.blunderRate, winRate: baselineWinRate }

  // 选 claim：revise/remove + 非空 claim + ruleRef 可解析且规则存在；
  // 排序：oracle 口径按基线 blunder 数，engine-only 按基线 thenMiss 数（主信号）再按命中数
  type Claim = { ruleRef: string; verdict: "revise" | "remove"; claim: string; ref: NonNullable<ReturnType<typeof parseRuleRef>>; rankKey: number }
  const skipped: ArmResult[] = []
  const claims: Claim[] = []
  for (const v of verdicts) {
    if (v.verdict === "keep" || !v.falsifiableClaim) continue
    const claimText = v.falsifiableClaim
    const ref = parseRuleRef(v.ruleRef)
    if (!ref) {
      skipped.push({
        armId: "", ruleRef: v.ruleRef, verdict: v.verdict,
        falsifiableClaim: claimText, status: "skipped",
        note: "ruleRef 不可解析（opening 或格式不符）",
        paired: null,
        baseline: { ...baselineMetrics },
        arm: { winRate: 0, games: 0 },
      })
      continue
    }
    // add: 前缀的规则只在 r1（revised）里存在；其余须在 r0（base）里存在
    if (!findRule(ref.added ? revised : base, ref)) {
      skipped.push({
        armId: "", ruleRef: v.ruleRef, verdict: v.verdict,
        falsifiableClaim: claimText, status: "skipped",
        note: ref.added ? "r1 中不存在该新增规则" : "r0 中不存在该规则",
        paired: null,
        baseline: { ...baselineMetrics },
        arm: { winRate: 0, games: 0 },
      })
      continue
    }
    const key = ref.scope === "global" ? `global:${ref.priority}` : `phase:${ref.phaseId}:${ref.priority}`
    const rankKey = engineOnly
      ? baselineThenMissOf(key) * 10000 + (batchSummary.perRuleHits?.[key] ?? 0)
      : baselineEval!.perRule[key]?.blunders ?? 0
    claims.push({ ruleRef: v.ruleRef, verdict: v.verdict, claim: claimText, ref, rankKey })
  }
  claims.sort((a, b) => b.rankKey - a.rankKey)
  const selected = claims.slice(0, top)

  console.log(`ablation: ${selected.length} arms (跳过 ${skipped.length} 条不可测试裁决), side=${side}, games/arm=${games}, seedBase=${seedBase}, alternateFirstPlayer=${alternateFirstPlayer}, evidence=${evidence}, minEffect=${(minEffect * 100).toFixed(1)}pp${engineOnly ? `, coverageTol=${(coverageTol * 100).toFixed(1)}pp` : ""}`)
  await mkdir(outDir, { recursive: true })

  const results: ArmResult[] = [...skipped]
  for (let idx = 0; idx < selected.length; idx++) {
    const { ruleRef: claimRuleRef, verdict, claim, ref } = selected[idx]
    const refKey = ref.scope === "global" ? `global:${ref.priority}` : `phase:${ref.phaseId}:${ref.priority}`
    const armId = `arm-${String(idx + 1).padStart(2, "0")}-${claimRuleRef.replace(/:/g, "_")}`
    const armDir = join(outDir, armId)
    await mkdir(armDir, { recursive: true })

    // 构造消融计划
    let ablated: GamePlanV1
    let numericTouched = false
    let numericChanges: string[] = []
    if (verdict === "remove" && !ref.added) {
      ablated = withRuleRemoved(base, ref)
    } else {
      const revisedRule = findRule(revised, ref)
      if (!revisedRule) {
        results.push({
          armId, ruleRef: claimRuleRef, verdict, falsifiableClaim: claim,
          status: "skipped", note: "r1 中找不到同位置修订规则（结构重排）",
          paired: null,
          baseline: { ...baselineMetrics },
          arm: { winRate: 0, games: 0 },
        })
        console.log(`[${armId}] SKIP: r1 中无 ${refKey}`)
        continue
      }
      if (ref.added) {
        // add: 前缀 = 验证"新增该规则是否有益"：臂 = r0 + r1 的该规则
        ablated = withRuleAdded(base, ref, revisedRule)
      } else {
        ablated = withRuleReplaced(base, ref, revisedRule)
        // 数值修订检测（同种子反事实判据的适用闸）：base vs revised 同位置规则的
        // then.damage_min / then.kills / when 骰子闸或 HP 闸数值差异
        if (verdict === "revise") {
          const diff = diffNumericRevision(findRule(base, ref)!, revisedRule)
          numericTouched = diff.touched
          numericChanges = diff.changes
        }
      }
    }
    ablated.parentPlanId = base.planId
    ablated.createdAt = new Date().toISOString()
    ablated.planId = computePlanId(ablated)

    // 校验消融计划
    const deck = DEFAULT_ASSETS_MANAGER.decode(ablated.context.deckCode)
    const opp = ablated.context.opponent
    const opponentDeck = opp.kind === "mirror" ? deck
      : opp.kind === "known_deck" ? DEFAULT_ASSETS_MANAGER.decode(opp.deckCode)
      : undefined
    const validation = validateGamePlan(ablated, { deck, opponentDeck })
    if (!validation.ok) {
      results.push({
        armId, ruleRef: claimRuleRef, verdict, falsifiableClaim: claim,
        status: "skipped",
        note: `消融计划校验失败: ${validation.issues.map((i) => i.message).join("; ").slice(0, 120)}`,
        paired: null,
        baseline: { ...baselineMetrics },
        arm: { winRate: 0, games: 0 },
      })
      console.log(`[${armId}] SKIP: 校验失败`)
      continue
    }
    await writeFile(join(armDir, "plan.json"), `${JSON.stringify(ablated, null, 2)}\n`, "utf-8")

    // 跑批（与基线同 seed 梯 + 相同先手交替设置）+ oracle 回算（engine-only 跳过）
    const armGamesDir = join(armDir, "games")
    const evalFileName = side === 0 ? "plan_eval.json" : "plan_eval.side1.json"
    const traceFileName = side === 0 ? "plan_trace.json" : "plan_trace.side1.json"
    const batchCfg = side === 0
      ? { plan: ablated, opponent: { type: "plan" as const, plan: opponent }, opponentDeckCode: opponent.context.deckCode }
      : { plan: opponent, opponent: { type: "plan" as const, plan: ablated }, opponentDeckCode: ablated.context.deckCode }
    const armBatch = await runPlanBatch({
      ...batchCfg,
      games,
      seedBase,
      alternateFirstPlayer,
      outDir: armGamesDir,
      concurrency: 4,
    }, data)
    const armEval = engineOnly
      ? null
      : await evalRunDir(armGamesDir, DEFAULT_EVAL_CONFIG, {
        traceFileName,
        evalOutName: side === 0 ? "plan_eval.json" : "plan_eval.side1.json",
        summaryOutName: side === 0 ? "plan_eval_summary.json" : "plan_eval_summary.side1.json",
      })

    // 臂关注计划的统计：side0 时 ablated 是批跑主计划；side1 时读 summary.side1.json
    type SideSummary = {
      winRate: number
      avgCoverage?: number
      fallbackRate?: number
      perRuleThenMiss?: Record<string, number>
      /** 逐局元信息（同种子反事实配对的 seed → gameDir 来源） */
      perGame?: Array<{ gameDir: string; seed: number }>
    }
    const armSideSummary: SideSummary = side === 0
      ? armBatch
      : JSON.parse(await readFile(join(armGamesDir, "summary.side1.json"), "utf-8")) as SideSummary
    const armWinRate = armSideSummary.winRate

    // 同种子反事实配对（engine-only 数值修订 revise 臂）：基线/臂逐局 trace 按 seed
    // 配对取该规则命中数；不可用（缺 perGame / 缺逐条目身份 / 两侧零命中）时回落胜率区间
    const numericPaired: NumericPairedExtraction | null = engineOnly && verdict === "revise" && numericTouched
      ? await extractNumericPairedHits({
        baseRunDir: baselineRun,
        armRunDir: armGamesDir,
        traceFileName,
        refKey,
        basePerGame: batchSummary.perGame ?? [],
        armPerGame: armSideSummary.perGame ?? [],
      })
      : null

    // McNemar 配对计数：同 stateSignature（同信息集）的决策点两臂对比（engine-only 无 eval，跳过）
    let paired: ArmResult["paired"] = null
    if (!engineOnly) {
      const baselineSigMap = await collectBlunderBySignature(baselineRun, evalFileName)
      const armSigMap = await collectBlunderBySignature(armGamesDir, evalFileName)
      let pairedB = 0
      let pairedC = 0
      for (const [sig, baseBlunder] of baselineSigMap) {
        const armBlunder = armSigMap.get(sig)
        if (armBlunder === undefined) continue
        if (baseBlunder && !armBlunder) pairedB++
        else if (!baseBlunder && armBlunder) pairedC++
      }
      const pairedMatched = [...baselineSigMap.keys()].filter((s) => armSigMap.has(s)).length
      paired = { matched: pairedMatched, b: pairedB, c: pairedC }
    }

    // 判定（带最小效应量阈值，过滤噪声级移动）
    let status: ArmResult["status"]
    let note: string
    let baseRuleStr: string | undefined
    let armRuleStr: string | undefined
    let armRuleThenMiss: number | undefined
    if (engineOnly) {
      // 引擎侧判据（ablate-criteria.ts）：thenMiss 归零 / 同种子反事实 / 胜率区间 / 覆盖闸
      const judged = judgeEngineOnly({
        verdict,
        ruleRef: refKey,
        baseThenMiss: baselineThenMissOf(refKey),
        armThenMiss: armSideSummary.perRuleThenMiss?.[refKey] ?? 0,
        baseCoverage: baselineCoverage,
        armCoverage: armSideSummary.avgCoverage ?? 0,
        baseFallbackRate: baselineFallbackRate,
        armFallbackRate: armSideSummary.fallbackRate ?? 0,
        baseWinRate: baselineWinRate,
        armWinRate,
        games,
        minEffect,
        coverageTol,
        numericPaired: usablePaired(numericPaired),
      })
      status = judged.status
      note = judged.note + pairedNoteSuffix(numericPaired)
      armRuleThenMiss = armSideSummary.perRuleThenMiss?.[refKey] ?? 0
    } else {
      const baseRule = baselineEval!.perRule[refKey]
      const armRule = armEval!.perRule[refKey]
      baseRuleStr = baseRule ? `${baseRule.blunders}/${baseRule.points}` : undefined
      armRuleStr = armRule ? `${armRule.blunders}/${armRule.points}` : undefined
      if (verdict === "revise") {
        if (!baseRule || !armRule || baseRule.points === 0 || armRule.points === 0) {
          status = "inconclusive"
          note = `规则命中点不足（基线 ${baseRuleStr ?? "无"}，臂 ${armRuleStr ?? "无"}）`
        } else {
          const br = baseRule.blunders / baseRule.points
          const ar = armRule.blunders / armRule.points
          if (ar < br - minEffect) status = "supported"
          else if (ar > br + minEffect) status = "refuted"
          else status = "inconclusive"
          note = `规则 blunder 率 ${(br * 100).toFixed(0)}% → ${(ar * 100).toFixed(0)}%（阈值 ±${(minEffect * 100).toFixed(0)}pp）`
        }
      } else {
        // remove：声称"该规则有害" → 整体 blunderRate 应下降 ≥ minEffect
        if (armEval!.blunderRate < baselineEval!.blunderRate - minEffect) status = "supported"
        else if (armEval!.blunderRate > baselineEval!.blunderRate + minEffect) status = "refuted"
        else status = "inconclusive"
        note = `整体 blunderRate ${(baselineEval!.blunderRate * 100).toFixed(1)}% → ${(armEval!.blunderRate * 100).toFixed(1)}%（阈值 ±${(minEffect * 100).toFixed(0)}pp）`
      }
      if (paired && paired.matched > 0) {
        note += `；配对 n=${paired.matched}（基线错臂对=${paired.b}，臂错基线对=${paired.c}）`
      }
    }

    results.push({
      armId,
      ruleRef: claimRuleRef,
      verdict,
      falsifiableClaim: claim,
      status,
      note,
      paired,
      ...(engineOnly && verdict === "revise" ? { numericTouched, numericChanges } : {}),
      ...(numericPaired ? { numericPaired } : {}),
      baseline: {
        ...baselineMetrics,
        ruleBlunders: baseRuleStr,
        ruleThenMiss: engineOnly ? baselineThenMissOf(refKey) : undefined,
      },
      arm: {
        ruleBlunders: armRuleStr,
        overallBlunderRate: armEval?.blunderRate,
        winRate: armWinRate,
        ruleThenMiss: armRuleThenMiss,
        coverage: engineOnly ? armSideSummary.avgCoverage : undefined,
        fallbackRate: engineOnly ? armSideSummary.fallbackRate : undefined,
        games,
      },
    })
    console.log(`[${armId}] ${status.toUpperCase()} ${claimRuleRef} (${verdict}): ${note}; winRate ${(baselineWinRate * 100).toFixed(0)}%→${(armWinRate * 100).toFixed(0)}%`)
  }

  const tested = results.filter((r) => r.status !== "skipped")
  const report = {
    basePlanId: base.planId,
    revisedPlanId: revised.planId,
    side,
    /** 判定口径：oracle（blunder 率 + McNemar）/ engine-only（thenMiss/coverage/胜率区间） */
    evidence,
    gamesPerArm: games,
    seedBase,
    totals: {
      tested: tested.length,
      supported: tested.filter((r) => r.status === "supported").length,
      refuted: tested.filter((r) => r.status === "refuted").length,
      inconclusive: tested.filter((r) => r.status === "inconclusive").length,
      skipped: results.filter((r) => r.status === "skipped").length,
    },
    arms: results,
  }
  await writeFile(join(outDir, "ablation-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8")
  console.log(`\n消融报告 → ${join(outDir, "ablation-report.json")}`)
  console.log(`supported=${report.totals.supported} refuted=${report.totals.refuted} inconclusive=${report.totals.inconclusive} skipped=${report.totals.skipped}`)
}

await main()
