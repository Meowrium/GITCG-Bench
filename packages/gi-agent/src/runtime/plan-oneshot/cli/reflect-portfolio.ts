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
 * reflect-portfolio — plan:reflect 的两层组合（portfolio）模式辅助函数
 * （G5，Phase 3b；D4/D6 定稿见 TEMP-two-layer-general-single-gap-analysis.md §5）。
 *
 * - buildLayerRoutingAdvice：D6 反思路由标注（k=2——证据键出现在 ≥2 组 → General，
 *   仅 1 组 → 该组 Single；纯函数，reflect 的 stats 文本注入用）；
 * - readPortfolioRunArchive / assertPortfolioGroupIds：组 run 目录的 portfolio.side0.json
 *   装载与组间/组↔manifest 的 portfolioId 一致性断言（防拿旧代 run 修订新 portfolio）；
 * - resolveGroupSingleLabel：组 → Single 路由判定（trace.deckCodes 首选、对手计划备选）；
 * - writePortfolioOutputs：portfolio 模式产物写出（plans/general.<tag>.json +
 *   plans/single.<label>.<tag>.json + 更新 portfolio.json，planRef 指向新文件、
 *   lineage 刷新为新 planId）；
 * - formatPortfolioPatchVerification：分层静态回放核验文案（patch 合并后回注）。
 *
 * 本模块不 import run-plan-reflect（CLI 入口文件在 main() 内直接执行，测试不可
 * import 它）；纯函数与装载逻辑全部收敛于此，colocated 单测直接 import 本模块。
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { GamePlanV1 } from "../game-plan-v1.js"
import type { PlanPortfolioV1, ResolvedPortfolio } from "../portfolio.js"
import { routeSingle } from "../portfolio.js"
import { parseRuleKey } from "../rule-key.js"
import { STATUS_LABELS } from "../plan-replay.js"
import type { PatchAssertion, PortfolioReplayResult } from "../plan-replay.js"

// ── D6 反思路由标注（k=2，纯函数） ─────────────────────────────────────

/** buildLayerRoutingAdvice 的组输入：每组在哪些规则键上出现了证据
 *  （reflect 侧取 summary.perRuleThenMiss + perRuleHits + evalSummary.perRule 的键并集） */
export interface LayerAdviceGroup {
  /** 对手组名（run 目录 basename） */
  label: string
  /** 本组路由到的 single label（仅用于"仅本组"标注的点名；缺省不点名） */
  singleLabel?: string
  /** when 全真但 then 零命中的规则键 → 次数 */
  perRuleThenMiss?: Record<string, unknown>
  /** 规则命中热力图键 → 次数 */
  perRuleHits?: Record<string, unknown>
  /** oracle 归因 perRule 键 → 归因数据 */
  perRuleEval?: Record<string, unknown>
}

/** 统计每个规则键出现在多少个组（来源并集），按 D6 k=2 口径输出路由建议行。
 *  - 键出现于 ≥2 组 → 建议修 General（跨组共性）；
 *  - 键仅 1 组且键带 `single:<label>:` 层前缀 → 建议修 Single(<label>)（仅本组）；
 *  - 键仅 1 组且为 general 层键 → 建议修 General（仅本组出现，注意过拟合）；
 *  - legacy 无层前缀键 → 不标注（旧单树流程不变）。
 * 输出按（出现组数降序，键字典序）稳定排序；无标注返回空数组。 */
export function buildLayerRoutingAdvice(groups: LayerAdviceGroup[]): string[] {
  const groupKeys = groups.map((g) => {
    const s = new Set<string>()
    for (const m of [g.perRuleThenMiss, g.perRuleHits, g.perRuleEval]) {
      if (!m) continue
      for (const k of Object.keys(m)) s.add(k)
    }
    return s
  })
  const allKeys = new Set<string>()
  for (const s of groupKeys) {
    for (const k of s) allKeys.add(k)
  }
  const lines: string[] = []
  for (const key of allKeys) {
    const parsed = parseRuleKey(key)
    if (!parsed?.layer) continue // legacy 无前缀键 → 不标注（旧流程不变）
    const appearing = groups
      .map((g, i) => (groupKeys[i].has(key) ? g : null))
      .filter((g): g is LayerAdviceGroup => g !== null)
    const n = appearing.length
    if (n >= 2) {
      lines.push(`- ${key}：出现于 ${n} 组（${appearing.map((g) => g.label).join(" / ")}）→ 建议修 General（跨组共性）`)
    } else if (n === 1) {
      const only = appearing[0]
      const where = only.singleLabel ? `（组 ${only.label}，路由 Single(${only.singleLabel})）` : `（组 ${only.label}）`
      if (parsed.layer.kind === "single") {
        lines.push(`- ${key}${where} → 建议修 Single(${parsed.layer.label})（仅本组）`)
      } else {
        lines.push(`- ${key}${where} → 建议修 General（仅本组出现，注意过拟合）`)
      }
    }
  }
  return lines.sort((a, b) => {
    // 组数降序（跨组共性优先），同组数按整行字典序稳定
    const countA = a.match(/出现于 (\d+) 组/) ? Number(a.match(/出现于 (\d+) 组/)![1]) : 1
    const countB = b.match(/出现于 (\d+) 组/) ? Number(b.match(/出现于 (\d+) 组/)![1]) : 1
    if (countA !== countB) return countB - countA
    return a < b ? -1 : a > b ? 1 : 0
  })
}

// ── 组 run 目录的 portfolio 归档断言（防旧代 run 修订新 portfolio） ─────

/** portfolio.side0.json 的归档结构（batch-runner 写；manifest 字段 + portfolioId + resolved + routing） */
export interface PortfolioRunArchive {
  portfolioId?: string
  routing?: string
  [k: string]: unknown
}

/** 读组 run 目录的 portfolio.side0.json（缺失/不可解析 → null） */
export async function readPortfolioRunArchive(dir: string): Promise<PortfolioRunArchive | null> {
  try {
    return JSON.parse(await readFile(join(dir, "portfolio.side0.json"), "utf-8")) as PortfolioRunArchive
  } catch {
    return null
  }
}

/** 组间 + 组↔manifest 的 portfolioId 一致性断言。返回错误列表（空数组 = 通过）：
 *  - 某组缺 portfolio.side0.json / 无 portfolioId → 错误；
 *  - 组间 portfolioId 不等 → 错误（文案仿 run-plan-reflect 的 planId 断言）；
 *  - 组 portfolioId 与 manifest 重算值不等 → 错误（防止拿旧代 run 修订新 portfolio）。 */
export function assertPortfolioGroupIds(
  groups: Array<{ label: string; archive: PortfolioRunArchive | null }>,
  manifestPortfolioId: string,
): string[] {
  const errors: string[] = []
  const ids = new Map<string, string>()
  for (const g of groups) {
    const id = g.archive?.portfolioId
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`对手组 ${g.label}：run 目录缺 portfolio.side0.json（或其中无 portfolioId）——portfolio 模式要求批跑按组合模式产出并归档；若为旧单树 run 请勿传 --portfolio`)
      continue
    }
    ids.set(g.label, id)
  }
  if (ids.size > 1) {
    const firstLabel = groups.find((g) => ids.has(g.label))!.label
    const firstId = ids.get(firstLabel)!
    for (const [label, id] of ids) {
      if (id !== firstId) {
        errors.push(`交叉对手证据包要求同一 portfolio：${firstLabel} portfolioId=${firstId}，但 ${label} portfolioId=${id}`)
      }
    }
  }
  for (const [label, id] of ids) {
    if (id !== manifestPortfolioId) {
      errors.push(`对手组 ${label}：run 归档 portfolioId=${id} 与 --portfolio manifest 重算值 ${manifestPortfolioId} 不一致——请用与 manifest 同代批跑的证据（防拿旧代 run 修订新 portfolio）`)
    }
  }
  return errors
}

// ── 组 → Single 路由判定 ───────────────────────────────────────────────

/** 判定某对手组（run 目录）路由到的 single label：
 *  首选读组内 game 目录的 plan_trace[.side1].json 的 deckCodes[1 - trace.side]
 *  （batch-runner 按实际执舵侧排列，两侧反思均正确，任何 opponent 类型都有）；
 *  备选对手侧计划文件 plan.side{1-side}.json 的 context.opponent.known_deck.deckCode
 *  （仅 opponent=plan 时存在）。两者都解析出对手 deckCode 后经 routeSingle 命中
 *  → 该 single label；无命中（未覆盖该对手）→ undefined（不设 singleLabel）。 */
export async function resolveGroupSingleLabel(
  dir: string,
  side: 0 | 1,
  portfolio: ResolvedPortfolio,
): Promise<string | undefined> {
  const traceName = side === 0 ? "plan_trace.json" : "plan_trace.side1.json"
  let gameDirs: string[] = []
  try {
    gameDirs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("game-"))
      .map((e) => e.name)
      .sort()
  } catch {
    gameDirs = []
  }
  for (const game of gameDirs) {
    let trace: { deckCodes?: [string, string] | null; side?: number } | null = null
    try {
      const raw = JSON.parse(await readFile(join(dir, game, traceName), "utf-8")) as { deckCodes?: [string, string] | null; side?: number }
      trace = raw
    } catch {
      continue
    }
    const codes = trace?.deckCodes
    if (!codes) continue
    // deckCodes[planSide] = 主计划牌表，deckCodes[1-planSide] = 对手牌表；trace.side = 本局 planSide
    const planSide = trace.side === 1 ? 1 : 0
    const oppCode = codes[1 - planSide]
    if (typeof oppCode === "string" && oppCode.length > 0) {
      const single = routeSingle(portfolio, oppCode)
      if (single) return single.label
    }
  }
  // 备选：对手侧计划文件（仅 opponent=plan 时存在；known_deck 才有效）
  const oppPlanPath = join(dir, `plan.side${side === 0 ? 1 : 0}.json`)
  try {
    const oppPlan = JSON.parse(await readFile(oppPlanPath, "utf-8")) as GamePlanV1
    const opp = oppPlan.context?.opponent
    if (opp?.kind === "known_deck") {
      const single = routeSingle(portfolio, opp.deckCode)
      if (single) return single.label
    }
  } catch {
    // 无对手计划文件 → 无法判定，返回 undefined
  }
  return undefined
}

// ── portfolio 模式产物写出 ─────────────────────────────────────────────

/** 反思工作闭包的 portfolio 形态（PatchPlanTarget 结构兼容 + opponentDeckCode 溯源） */
export interface WorkingPortfolio {
  general: GamePlanV1
  singles: Array<{ label: string; opponentDeckCode: string; plan: GamePlanV1 }>
}

/** 产物 tag：--round N → `r<N>`；缺省沿用输入 manifest 的 generalPlan 文件名
 *  （`general.<tag>.json` 形态 → 取 <tag>，原位修订；否则 manifest 文件名去扩展名）。 */
export function portfolioTagOf(opts: { round?: number; portfolioPath: string }, manifest: PlanPortfolioV1): string {
  if (opts.round !== undefined) return `r${opts.round}`
  const m = /^general\.(.+)\.json$/.exec(basename(manifest.generalPlan))
  if (m) return m[1]
  return basename(opts.portfolioPath).replace(/\.json$/, "")
}

/** portfolio 模式产物写出：
 *  - <outDir>/plans/general.<tag>.json
 *  - <outDir>/plans/single.<label>.<tag>.json（每个 single）
 *  - <outDir>/portfolio.json：planRef 指向新文件、lineage 刷新为新 planId
 * 返回写出的 portfolio.json 路径与计划文件相对路径列表。 */
export async function writePortfolioOutputs(opts: {
  outDir: string
  tag: string
  working: WorkingPortfolio
}): Promise<{ portfolioPath: string; planFiles: string[] }> {
  const { outDir, tag, working } = opts
  const plansDir = join(outDir, "plans")
  await mkdir(plansDir, { recursive: true })
  const planFiles: string[] = []
  const generalRel = `plans/general.${tag}.json`
  await writeFile(join(outDir, generalRel), `${JSON.stringify(working.general, null, 2)}\n`, "utf-8")
  planFiles.push(generalRel)
  const singles: PlanPortfolioV1["singles"] = []
  for (const s of working.singles) {
    const rel = `plans/single.${s.label}.${tag}.json`
    await writeFile(join(outDir, rel), `${JSON.stringify(s.plan, null, 2)}\n`, "utf-8")
    planFiles.push(rel)
    singles.push({
      opponentDeckCode: s.opponentDeckCode,
      ...(s.label !== s.opponentDeckCode ? { label: s.label } : {}),
      planRef: rel,
    })
  }
  const next: PlanPortfolioV1 = {
    version: "PlanPortfolioV1",
    generalPlan: generalRel,
    singles,
    lineage: {
      generalId: working.general.planId,
      singles: Object.fromEntries(working.singles.map((s) => [s.label, s.plan.planId])),
    },
  }
  const portfolioPath = join(outDir, "portfolio.json")
  await writeFile(portfolioPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8")
  return { portfolioPath, planFiles }
}

// ── 分层静态回放核验文案（patch 合并后回注） ───────────────────────────

/** 分层 × 分组核验文案：逐组 fallback 率变化 + 汇总 + 逐 op 断言（跨组聚合）。 */
export function formatPortfolioPatchVerification(opts: {
  opsCount: number
  assertions: PatchAssertion[]
  base: PortfolioReplayResult
  next: PortfolioReplayResult
  lintFindings?: Array<{ path: string; message: string }>
}): string {
  const lines: string[] = []
  for (const label of opts.next.groupOrder) {
    const b = opts.base.perGroup[label]?.replay
    const n = opts.next.perGroup[label].replay
    if (!b || !n) continue
    const fb0 = (b.fallbackRate * 100).toFixed(1)
    const fb1 = (n.fallbackRate * 100).toFixed(1)
    lines.push(`对手组 ${label}（routing=${opts.next.perGroup[label].routing}）：fallback 率 ${fb0}% → ${fb1}%（语料 ${n.totalPoints} 点）`)
  }
  const tp = opts.next.totalPoints
  lines.push(`汇总：${opts.next.groupOrder.length} 组 / ${tp} 点 / fallback ${opts.next.totalFallback}（${tp > 0 ? ((opts.next.totalFallback / tp) * 100).toFixed(1) : "0"}%）`)
  if (opts.assertions.length > 0) {
    lines.push("逐 op 断言（跨组聚合）：")
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
