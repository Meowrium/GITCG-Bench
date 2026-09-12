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
 * plan-graft — 路线换轴的**单元级嫁接**（纯函数，无 I/O）与 alternates 旁档 schema。
 *
 * r0 多候选起草（plan:author --candidates N）把路线决策从"一次抽样的运气"变成
 * 显式选择：N 个候选独立起草、评审择一落地，落选候选进 `<out>.alternates.json`
 * 供反思期换轴。换轴粒度 = GamePlanV1 结构单元（决定稿 2026-09-08）：
 * `opening`（整体）/ `fallback`（policy）/ `rules`（全局链整体）/ `phase:<phaseId>`
 * （整链：when + rules）——**不按 opening vs 斩杀轴的功能轴二分**。
 *
 * 语义：
 * - `opening` / `fallback` / `rules` → 用候选树的对应单元整体替换工作树；
 * - `phase:<id>` → 工作树已有该 phaseId 时原位替换（when + rules），否则**追加到
 *   phases 末尾**（保持候选树内部相位顺序的语义简单化：追加位置的运行时优先级
 *   由 phase 的 when 决定，phases 数组顺序只影响静态展示）；
 * - 未列入 units 的部分一律保留工作树原值；输入不被修改（structuredClone）。
 *
 * 守卫（checkGraftUnits，纯函数）：unit 语法、单次 ≤2 个、本 run 累计 ≤2 个、
 * phaseId 必须存在于**候选树**、不得重复采纳（候选自身 adoptedUnits ∪ 本 run
 * 已嫁接集合）。调用方（reflect 的 switch_route）负责 run 级状态与 validate /
 * lint / 静态回放核验。
 */

import type { GamePlanV1 } from "./game-plan-v1.js"

export const PLAN_ALTERNATES_VERSION = "PlanAlternatesV1"

/** 换轴单元：GamePlanV1 结构单元 */
export type GraftUnit = "opening" | "fallback" | "rules" | `phase:${string}`

/** 落选/全部候选（`<out>.alternates.json` 的 candidates[]） */
export interface AlternateCandidate {
  /** r0 起草序号（0 起，与候选 review 的 choice 同域） */
  index: number
  /** 模型自标注路线标签（如 控制/中速/节奏/组合技/OTK/快攻） */
  archetype: string
  /** 评审对该候选的一句话短评（缺省空串） */
  reviewNote: string
  /** 已被 switch_route 嫁接的单元（r0 起草时为 []） */
  adoptedUnits: string[]
  plan: GamePlanV1
}

/** `<out>.alternates.json` / run 目录 `plan.side<N>.alternates.json` */
export interface PlanAlternatesSidecar {
  version: typeof PLAN_ALTERNATES_VERSION
  /** 仅 --game-version 显式钉版本时写入（与 context.gameVersion 契约同口径） */
  gameVersion?: string
  deckCode: string
  /** 评审选中的候选 index（reflect 换轴不得再选它——它就是已落地的树） */
  chosenIndex: number
  createdAt: string
  /** 全部候选（含被选中的那个——reflect 需要完整集合判断路线差异） */
  candidates: AlternateCandidate[]
}

export function buildAlternatesSidecar(args: {
  deckCode: string
  chosenIndex: number
  candidates: readonly AlternateCandidate[]
  gameVersion?: string
  createdAt?: string
}): PlanAlternatesSidecar {
  return {
    version: PLAN_ALTERNATES_VERSION,
    ...(args.gameVersion !== undefined ? { gameVersion: args.gameVersion } : {}),
    deckCode: args.deckCode,
    chosenIndex: args.chosenIndex,
    createdAt: args.createdAt ?? new Date().toISOString(),
    candidates: args.candidates.map((c) => structuredClone(c)),
  }
}

/** 候选 index → 已采纳单元集合（switch_route 的重复嫁接守卫输入） */
export function adoptedUnitMap(sidecar: PlanAlternatesSidecar): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>()
  for (const c of sidecar.candidates ?? []) map.set(c.index, new Set(c.adoptedUnits ?? []))
  return map
}

/** 候选形状摘要（替代路线参考段用：不注入整棵树，只给可判读的形态） */
export function planShapeSummary(plan: GamePlanV1): string {
  const active = plan.opening?.chooseActive?.[0]?.characterDefId
  const phases = plan.phases ?? []
  const phaseIds = phases.map((p) => p.phaseId).join("/")
  return `opening 首发=${active ?? "?"}；phases=${phases.length}${phaseIds !== "" ? `（${phaseIds}）` : ""}；global rules=${plan.rules?.length ?? 0}；fallback=${plan.fallback?.policy ?? "?"}`
}

/** 单元语法归一：非法返回 null（不做存在性判断——那是 checkGraftUnits 的事） */
export function normalizeGraftUnit(raw: unknown): GraftUnit | null {
  if (typeof raw !== "string") return null
  const unit = raw.trim()
  if (unit === "opening" || unit === "fallback" || unit === "rules") return unit
  const m = /^phase:(.+)$/.exec(unit)
  return m ? `phase:${m[1]}` : null
}

export interface GraftGuardOptions {
  /** 该候选已采纳的单元（sidecar.adoptedUnits） */
  adopted?: ReadonlySet<string>
  /** 本 run 已从任意候选嫁接的单元 */
  graftedThisRun?: ReadonlySet<string>
  /** 单次调用上限（默认 2）与本 run 累计上限（默认同值） */
  maxUnits?: number
}

/**
 * 换轴单元守卫（纯函数）：返回归一化后的 units 或全部错误（一次列全，便于回注）。
 * 不做跨 run 状态管理（graftedThisRun 由调用方传入）。
 */
export function checkGraftUnits(
  candidate: GamePlanV1,
  units: unknown,
  opts: GraftGuardOptions = {},
): { ok: true; units: GraftUnit[] } | { ok: false; errors: string[] } {
  const maxUnits = opts.maxUnits ?? 2
  const errors: string[] = []
  const list = Array.isArray(units) ? units : []
  if (!Array.isArray(units) || list.length === 0) {
    return { ok: false, errors: ["units 必须是非空数组（可选 opening / fallback / rules / phase:<phaseId>，单次 ≤2 个）"] }
  }
  const normalized: GraftUnit[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const unit = normalizeGraftUnit(raw)
    if (unit === null) {
      errors.push(`unit ${JSON.stringify(raw)} 非法（可选 opening / fallback / rules / phase:<phaseId>）`)
      continue
    }
    if (seen.has(unit)) {
      errors.push(`unit "${unit}" 在本次调用中重复`)
      continue
    }
    seen.add(unit)
    normalized.push(unit)
  }
  if (normalized.length > maxUnits) {
    errors.push(`单次最多嫁接 ${maxUnits} 个单元（本次 ${normalized.length} 个）`)
  }
  for (const unit of normalized) {
    if (unit.startsWith("phase:") && !(candidate.phases ?? []).some((p) => p.phaseId === unit.slice("phase:".length))) {
      errors.push(`unit "${unit}" 在候选树中不存在（phaseId 必须在候选树的 phases 中）`)
    }
    if (opts.adopted?.has(unit)) {
      errors.push(`unit "${unit}" 已被该候选采纳（adoptedUnits），不能重复嫁接`)
    }
    if (opts.graftedThisRun?.has(unit)) {
      errors.push(`unit "${unit}" 本 run 已从其他候选嫁接，不能重复嫁接`)
    }
  }
  if (opts.graftedThisRun !== undefined && normalized.length <= maxUnits && opts.graftedThisRun.size + normalized.length > maxUnits) {
    errors.push(`本 run 已嫁接 ${opts.graftedThisRun.size} 个单元，本次 ${normalized.length} 个将超过本 run 上限 ${maxUnits}（防路线反复横跳）`)
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, units: normalized }
}

/**
 * 单元级嫁接：工作树 = 基底，候选树 = 单元来源。返回新树（输入不被修改）。
 * 非法/候选树中缺失的单元被跳过（调用方应先过 checkGraftUnits；此处兜底）。
 */
export function applyRouteGraft(
  working: GamePlanV1,
  candidate: GamePlanV1,
  units: readonly unknown[],
): { plan: GamePlanV1; applied: string[] } {
  const out = structuredClone(working)
  const applied: string[] = []
  const seen = new Set<string>()
  for (const raw of units) {
    const unit = normalizeGraftUnit(raw)
    if (unit === null || seen.has(unit)) continue
    seen.add(unit)
    if (unit === "opening") {
      out.opening = structuredClone(candidate.opening)
    } else if (unit === "fallback") {
      out.fallback = structuredClone(candidate.fallback)
    } else if (unit === "rules") {
      out.rules = structuredClone(candidate.rules ?? [])
    } else {
      const phaseId = unit.slice("phase:".length)
      const source = (candidate.phases ?? []).find((p) => p.phaseId === phaseId)
      if (source === undefined) continue
      const idx = (out.phases ?? []).findIndex((p) => p.phaseId === phaseId)
      if (idx >= 0) out.phases[idx] = structuredClone(source)
      else out.phases = [...(out.phases ?? []), structuredClone(source)]
    }
    applied.push(unit)
  }
  return { plan: out, applied }
}
