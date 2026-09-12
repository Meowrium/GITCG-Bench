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
 * ablate-numeric — plan:ablate 的「同种子反事实判据」输入构造（数值修订检测 + 配对命中数）。
 *
 * 背景：engine-only 消融原判据只证明"没退化"——thenMiss 归零对死规则有效，胜率区间
 * 对 N≥20 的整局结果太粗，看不出「改对了一个数值」（then.damage_min / then.kills /
 * when 骰子闸或 HP 闸的数值）是否真的改变了该规则自身的命中。臂批跑沿用基线 seedBase
 * （run-plan-ablate.ts），base 与 arm 的第 i 局同 seed，于是可逐局配对：
 *
 * - diffNumericRevision：revise 臂的数值修订检测（base vs revised 同位置规则）；
 * - countRuleHitsInTrace：单局 trace 中某规则键的命中数——按 matchedRule + phaseId
 *   拼键（trace.ts 的 PlanTraceCollector.finalize 与 perRuleHits 同口径）；
 * - pairHitsBySeed / extractNumericPairedHits：按 seed 配对两侧逐局命中数，输出
 *   { seeds, baseHits, armHits }（同 seed 对齐；单侧缺失的局跳过并计数）。
 *
 * 降级：perGame 缺失、两侧 seed 无交集、trace 缺逐条目规则身份、配对局两侧全零命中
 * 时返回 unavailable——判定侧回落既有胜率区间判据，并把原因写进 note。
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { DecisionRuleV1 } from "../game-plan-v1.js"
import { formatRuleKey } from "../rule-key.js"
import type { PlanTraceFile } from "../trace.js"
import type { NumericPairedHits } from "./ablate-criteria.js"

// ── 数值修订检测 ───────────────────────────────────────────────────────

/** when 数值闸字段：骰子闸 dice.total / dice.<元素> / dice.<元素>+omni */
const DICE_GATE_RE = /^dice\.(?:total|cryo|hydro|pyro|electro|anemo|geo|dendro)(?:\+omni)?$/
/** when 数值闸字段：HP 闸 self|opponent.active.hp / self|opponent.characters.<defId>.hp */
const HP_GATE_RE = /^(?:self|opponent)\.(?:active|characters\.\d+)\.hp$/

/** 条件值 → 数值；动态引用（"$field.path"）与非数值返回 null */
function numericValueOf(v: number | string | boolean): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const t = v.trim()
    if (t === "" || t.startsWith("$")) return null
    const n = Number(t)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** 规则中数值闸字段 → 数值（同字段多条时后者覆盖；检测只看数值不看算子） */
function gateValuesOf(rule: DecisionRuleV1): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of rule.when ?? []) {
    if (!DICE_GATE_RE.test(c.field) && !HP_GATE_RE.test(c.field)) continue
    const v = numericValueOf(c.value)
    if (v !== null) out.set(c.field, v)
  }
  return out
}

const fmtNum = (v: number | boolean | undefined): string => v === undefined ? "（缺省）" : String(v)

export interface NumericRevisionDiff {
  /** 是否存在数值变化（then.damage_min / then.kills / when 闸数值） */
  touched: boolean
  /** 变化清单（进消融报告供审计，如 "then.damage_min 3→5"） */
  changes: string[]
}

/**
 * 数值修订检测：base 与 revised 同位置规则在 then.damage_min / then.kills 或 when
 * 数值闸（骰子/HP）上是否有数值差异。只比数值——算子变化、字段替换属结构差异，
 * 不触发本判据（回落既有胜率区间判据）。
 */
export function diffNumericRevision(baseRule: DecisionRuleV1, revisedRule: DecisionRuleV1): NumericRevisionDiff {
  const changes: string[] = []
  if (baseRule.then.damage_min !== revisedRule.then.damage_min) {
    changes.push(`then.damage_min ${fmtNum(baseRule.then.damage_min)}→${fmtNum(revisedRule.then.damage_min)}`)
  }
  if (baseRule.then.kills !== revisedRule.then.kills) {
    changes.push(`then.kills ${fmtNum(baseRule.then.kills)}→${fmtNum(revisedRule.then.kills)}`)
  }
  const baseGates = gateValuesOf(baseRule)
  const revisedGates = gateValuesOf(revisedRule)
  for (const field of [...new Set([...baseGates.keys(), ...revisedGates.keys()])].sort()) {
    const b = baseGates.get(field)
    const r = revisedGates.get(field)
    if (b !== r) changes.push(`when ${field} ${fmtNum(b)}→${fmtNum(r)}`)
  }
  return { touched: changes.length > 0, changes }
}

// ── 逐局命中数（与 perRuleHits 同口径） ────────────────────────────────

/**
 * 单局 trace 中某规则键的命中数：逐条目按 matchedRule（scope/priority/layer）+
 * entry.phaseId 拼键，与 PlanTraceCollector.finalize 汇总 perRuleHits 的口径一致。
 * entryIdentity=false 表示逐条目规则身份不可用（无 entries 数组，或条目侧命中数与
 * summary.perRuleHits 矛盾）——此时配对指标必须降级。
 */
export function countRuleHitsInTrace(trace: unknown, refKey: string): { hits: number; entryIdentity: boolean } {
  const t = trace as Partial<PlanTraceFile> | null | undefined
  const entries = t?.entries
  if (!Array.isArray(entries)) return { hits: 0, entryIdentity: false }
  let hits = 0
  for (const e of entries) {
    const m = e.matchedRule
    if (!m) continue
    const key = formatRuleKey({
      scope: m.scope,
      priority: m.priority,
      phaseId: e.phaseId ?? null,
      layer: m.layer,
      layerLabel: m.layerLabel,
    })
    if (key === refKey) hits++
  }
  const summaryHits = t?.summary?.perRuleHits?.[refKey] ?? 0
  return { hits, entryIdentity: hits > 0 || summaryHits === 0 }
}

// ── 同种子配对 ─────────────────────────────────────────────────────────

/** 按 seed 配对的命中数（seedList 与 baseHits/armHits 同下标对齐，seed 升序） */
export interface PairedHits {
  seedList: number[]
  baseHits: number[]
  armHits: number[]
  /** 单侧缺失/不可读而跳过的局数 */
  skipped: number
}

/** 两侧 seed → 命中数映射按 seed 升序配对；任一侧缺失的 seed 跳过并计数 */
export function pairHitsBySeed(base: ReadonlyMap<number, number>, arm: ReadonlyMap<number, number>): PairedHits {
  const seedList: number[] = []
  const baseHits: number[] = []
  const armHits: number[] = []
  let skipped = 0
  for (const seed of [...new Set([...base.keys(), ...arm.keys()])].sort((a, b) => a - b)) {
    const b = base.get(seed)
    const a = arm.get(seed)
    if (b === undefined || a === undefined) {
      skipped++
      continue
    }
    seedList.push(seed)
    baseHits.push(b)
    armHits.push(a)
  }
  return { seedList, baseHits, armHits, skipped }
}

/** 同种子反事实配对命中数（= 判定输入 NumericPairedHits + 降级信息） */
export interface NumericPairedExtraction extends NumericPairedHits {
  /** 单侧缺失/不可读而跳过的局数（>0 时判定 note 注明） */
  skipped: number
  /** 非空 = 配对指标不可用（判定回落胜率区间判据） */
  unavailable?: string
}

export interface ExtractNumericPairedOpts {
  baseRunDir: string
  armRunDir: string
  /** 逐局 trace 文件名（side0: plan_trace.json；side1: plan_trace.side1.json） */
  traceFileName: string
  /** 被修订规则的判定键（组合模式为层化键 general:… / single:<label>:…） */
  refKey: string
  basePerGame: ReadonlyArray<{ gameDir: string; seed: number }>
  armPerGame: ReadonlyArray<{ gameDir: string; seed: number }>
}

async function readTraceHits(path: string, refKey: string): Promise<{ hits: number; entryIdentity: boolean } | null> {
  try {
    return countRuleHitsInTrace(JSON.parse(await readFile(path, "utf-8")) as unknown, refKey)
  } catch {
    return null
  }
}

/**
 * 逐局配对命中数提取（engine-only 数值修订臂）：臂批跑沿用基线 seedBase，base 与
 * arm 同 seed 的局逐局读 trace 取该规则命中数（单侧缺失的局跳过）。
 */
export async function extractNumericPairedHits(opts: ExtractNumericPairedOpts): Promise<NumericPairedExtraction> {
  const unavailable = (reason: string): NumericPairedExtraction => ({ seeds: 0, baseHits: [], armHits: [], skipped: 0, unavailable: reason })
  if (opts.basePerGame.length === 0) return unavailable("基线 summary 缺 perGame（旧产物）")
  if (opts.armPerGame.length === 0) return unavailable("臂 summary 缺 perGame")
  const baseDirOfSeed = new Map(opts.basePerGame.map((g) => [g.seed, g.gameDir]))
  const armDirOfSeed = new Map(opts.armPerGame.map((g) => [g.seed, g.gameDir]))
  const seeds = [...baseDirOfSeed.keys()].filter((s) => armDirOfSeed.has(s)).sort((a, b) => a - b)
  if (seeds.length === 0) {
    return unavailable(`两侧 seed 无交集（基线 ${opts.basePerGame.length} 局 / 臂 ${opts.armPerGame.length} 局）`)
  }
  const baseHits: number[] = []
  const armHits: number[] = []
  let paired = 0
  let skipped = opts.basePerGame.length + opts.armPerGame.length - 2 * seeds.length
  for (const seed of seeds) {
    const b = await readTraceHits(join(opts.baseRunDir, baseDirOfSeed.get(seed)!, opts.traceFileName), opts.refKey)
    const a = await readTraceHits(join(opts.armRunDir, armDirOfSeed.get(seed)!, opts.traceFileName), opts.refKey)
    if (!b || !a) {
      skipped++
      continue
    }
    if (!b.entryIdentity) return unavailable(`基线 trace 缺逐条目规则身份（seed=${seed}）`)
    if (!a.entryIdentity) return unavailable(`臂 trace 缺逐条目规则身份（seed=${seed}）`)
    paired++
    baseHits.push(b.hits)
    armHits.push(a.hits)
  }
  if (paired === 0) return unavailable("配对局为 0（两侧 trace 均不可读）")
  if (baseHits.every((h) => h === 0) && armHits.every((h) => h === 0)) {
    return { seeds: paired, baseHits, armHits, skipped, unavailable: `${paired} 个配对局两侧均无该规则命中（键不匹配或规则本就零命中）` }
  }
  return { seeds: paired, baseHits, armHits, skipped }
}

/**
 * 跨证据组聚合（组合模式 General claim 汇总）：命中数组直接拼接（配对仍按组内
 * seed 对齐，组间 seed 可能重叠，但每对都是同 seed 同局），seeds/skipped 求和。
 * 任一组不可用 → 整体不可用（判定回落胜率区间，note 注明原因）。
 */
export function combineNumericPaired(parts: readonly NumericPairedExtraction[]): NumericPairedExtraction {
  const skipped = parts.reduce((s, p) => s + p.skipped, 0)
  const bad = parts.find((p) => p.unavailable)
  if (bad) return { seeds: 0, baseHits: [], armHits: [], skipped, unavailable: `部分证据组配对不可用（${bad.unavailable}）` }
  if (parts.length === 0) return { seeds: 0, baseHits: [], armHits: [], skipped, unavailable: "无已配对证据组" }
  return {
    seeds: parts.reduce((s, p) => s + p.seeds, 0),
    baseHits: parts.flatMap((p) => p.baseHits),
    armHits: parts.flatMap((p) => p.armHits),
    skipped,
  }
}
