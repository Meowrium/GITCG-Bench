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
 * portfolio — 两层决策树（General + Single portfolio）的 manifest schema、
 * 装载与校验（D5/G8 定稿，见 TEMP-two-layer-general-single-gap-analysis.md §5）。
 *
 * - General = 一套应对所有对手的公共决策树（声明 unknown_deck）；
 * - Single = 每个对手卡组一棵专属树（声明 known_deck 且与 manifest 绑定一致），
 *   执行时由 batch-runner 按对手 deckCode 路由（routeSingle）；
 * - portfolioId = 对解析后的 { version, generalId, singles: { label: { opponentDeckCode,
 *   planId } } }（键排序、剔除 lineage/路径字段）做 sha256 前 12 位（与 computePlanId
 *   同手法）；planId 仍按单树内容寻址不变；
 * - 命名说明（D5）：`src/runtime/policy/` 的 temporal option portfolio 占用了
 *   "portfolio" 字面（同名不同义），本模块类型一律带 Plan/Resolved 前缀隔离。
 *
 * 注意：batch-runner 会 import 本模块，本模块不得 import batch-runner（循环依赖）；
 * 单计划装载逻辑（normalize + decode + validateGamePlan）与
 * batch-runner.loadPlanWithValidation 同口径地在此内联实现。
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { DeckConfig, Version } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import type { GamePlanV1 } from "./game-plan-v1.js"
import { normalizePlanNumericFields, stableStringify, validateGamePlan } from "./validate.js"
import { parseGameVersion } from "./version.js"

// ── manifest schema（D5） ───────────────────────────────────────────────

export interface PlanPortfolioSingleEntry {
  /** 绑定的对手卡组分享码（single 计划必须声明 known_deck 且与此一致，G8①） */
  opponentDeckCode: string
  /** 层键 label（ruleRef 前缀 `single:<label>:…`）；缺省 = opponentDeckCode；非空且不含 ':' */
  label?: string
  /** 计划文件路径（相对 manifest 所在目录解析） */
  planRef: string
}

export interface PlanPortfolioV1 {
  version: "PlanPortfolioV1"
  /** general 计划文件路径（相对 manifest 所在目录解析） */
  generalPlan: string
  singles: PlanPortfolioSingleEntry[]
  /** 可选谱系快照；装载时按解析结果重算校验，不一致只收 warning（不阻断） */
  lineage?: {
    generalId: string
    singles?: Record<string, string>
  }
}

// ── 解析结果 ─────────────────────────────────────────────────────────────

export interface ResolvedSingle {
  label: string
  opponentDeckCode: string
  /** manifest 中的原始相对路径（溯源用） */
  planRef: string
  plan: GamePlanV1
  planId: string
}

export interface ResolvedPortfolio {
  /** 原始 manifest（相对路径与 lineage 原样保留，run 目录归档用） */
  manifest: PlanPortfolioV1
  general: GamePlanV1
  generalId: string
  singles: ResolvedSingle[]
  portfolioId: string
  /**
   * 各层 context.gameVersion 的共同版本（全部声明且相同）；全未声明或
   * force 放行的不一致 → undefined（调用方回落到 config ?? CURRENT_VERSION）。
   * 由 loadPortfolioWithValidation 装载时计算。
   */
  commonGameVersion?: Version
}

/** 本 run 的路由形态（trace meta / 归档用） */
export type PortfolioRouting = "general-only" | `single:${string}`

/**
 * portfolio 内容寻址 id：对解析后的 { version, generalId, singles: { label:
 * { opponentDeckCode, planId } } } 做 sha256 前 12 位（键排序经 stableStringify，
 * 不受 singles 数组顺序、manifest 路径字段与 lineage 影响）。
 */
export function computePortfolioId(resolved: {
  generalId: string
  singles: ReadonlyArray<{ label: string; opponentDeckCode: string; planId: string }>
}): string {
  const content = {
    version: "PlanPortfolioV1",
    generalId: resolved.generalId,
    singles: Object.fromEntries(
      resolved.singles.map((s) => [s.label, { opponentDeckCode: s.opponentDeckCode, planId: s.planId }]),
    ),
  }
  return createHash("sha256").update(stableStringify(content)).digest("hex").slice(0, 12)
}

/** run 级路由：对手 deckCode 命中 singles → 该 Single，否则 null（General-only） */
export function routeSingle(portfolio: ResolvedPortfolio, opponentDeckCode: string): ResolvedSingle | null {
  return portfolio.singles.find((s) => s.opponentDeckCode === opponentDeckCode) ?? null
}

// ── 装载与校验（G8） ─────────────────────────────────────────────────────

/** 单计划装载：数值规范化 + decode + 完整校验（与 batch-runner.loadPlanWithValidation 同口径），不合法则抛错。
 * 计划声明 context.gameVersion 时用该版本数据做存在性校验（V1 版本钉扎）。 */
async function loadPlanChecked(planPath: string, what: string): Promise<GamePlanV1> {
  let plan: GamePlanV1
  try {
    plan = normalizePlanNumericFields(JSON.parse(await readFile(planPath, "utf-8")) as GamePlanV1)
  } catch (e) {
    throw new Error(`portfolio：${what} 的计划文件缺失或不可解析：${planPath}（${e instanceof Error ? e.message : String(e)}）`)
  }
  const deck = DEFAULT_ASSETS_MANAGER.decode(plan.context.deckCode) as DeckConfig
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
    throw new Error(`portfolio：${what} 计划 ${planPath} 校验失败：\n${detail}`)
  }
  return plan
}

/** 对手牌表字段（明牌先验）——General 层引用即疑似越层（lint，不阻断） */
const OPP_HAND_FIELD_RE = /^opp\.hand\./

function collectOppHandRefs(plan: GamePlanV1): string[] {
  const hits: string[] = []
  const scan = (rules: GamePlanV1["rules"], where: string): void => {
    rules?.forEach((r, i) => {
      for (const c of r.when ?? []) {
        if (OPP_HAND_FIELD_RE.test(c.field)) hits.push(`${where}[${i}].when 引用 ${c.field}`)
      }
    })
  }
  scan(plan.rules, "rules")
  plan.phases?.forEach((p, i) => scan(p.rules, `phases[${i}].rules`))
  return hits
}

/**
 * 装载 portfolio manifest 并做 G8 校验（硬错误抛错；lint/谱系不一致收 warnings）：
 * ① 每个 single 计划的 context.opponent 须为 known_deck 且 deckCode == manifest 绑定；
 * ② general 计划须声明 unknown_deck；
 * ③ 层内 priority 唯一等单树校验由 validateGamePlan 覆盖（跨层不查——D1 层主序后无冲突语义）；
 * ④ label 非空、不含 ':'、singles 内唯一（缺省 = opponentDeckCode）；
 * ⑤ planRef 相对 manifest 所在目录解析，缺失即报错。
 * lint：general 层规则 when 引用 opp.hand.* 对手牌表字段 → warning。
 */
export async function loadPortfolioWithValidation(
  path: string,
  opts?: { force?: boolean },
): Promise<{ portfolio: ResolvedPortfolio; warnings: string[] }> {
  const warnings: string[] = []
  let raw: PlanPortfolioV1
  try {
    raw = JSON.parse(await readFile(path, "utf-8")) as PlanPortfolioV1
  } catch (e) {
    throw new Error(`portfolio manifest 读取失败：${path}（${e instanceof Error ? e.message : String(e)}）`)
  }
  if (raw?.version !== "PlanPortfolioV1") {
    throw new Error(`portfolio ${path}：version 必须是 "PlanPortfolioV1"（实为 ${String(raw?.version)}）`)
  }
  if (typeof raw.generalPlan !== "string" || raw.generalPlan.length === 0) {
    throw new Error(`portfolio ${path}：generalPlan 必填（相对 manifest 的路径）`)
  }
  if (!Array.isArray(raw.singles)) {
    throw new Error(`portfolio ${path}：singles 必须是数组`)
  }
  const dir = dirname(path)

  // ④ label 规范检查（在装载计划前完成，错误信息不依赖计划内容）
  const seenLabels = new Set<string>()
  const entries: Array<{ label: string; opponentDeckCode: string; planRef: string }> = []
  raw.singles.forEach((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`portfolio ${path}：singles[${i}] 必须是对象`)
    }
    if (typeof s.opponentDeckCode !== "string" || s.opponentDeckCode.length === 0) {
      throw new Error(`portfolio ${path}：singles[${i}].opponentDeckCode 必填`)
    }
    if (typeof s.planRef !== "string" || s.planRef.length === 0) {
      throw new Error(`portfolio ${path}：singles[${i}].planRef 必填（相对 manifest 的路径）`)
    }
    const label = s.label ?? s.opponentDeckCode
    if (label.length === 0 || label.includes(":")) {
      throw new Error(`portfolio ${path}：singles[${i}].label 非法：${JSON.stringify(label)}（必须非空且不含 ':'——ruleRef 层前缀分隔符）`)
    }
    if (seenLabels.has(label)) {
      throw new Error(`portfolio ${path}：singles[${i}].label "${label}" 重复`)
    }
    seenLabels.add(label)
    entries.push({ label, opponentDeckCode: s.opponentDeckCode, planRef: s.planRef })
  })

  const general = await loadPlanChecked(join(dir, raw.generalPlan), "general")
  // ② general 必须 unknown_deck
  if (general.context.opponent.kind !== "unknown_deck") {
    throw new Error(
      `portfolio ${path}：general 计划必须声明 context.opponent = unknown_deck`
      + `（实为 ${general.context.opponent.kind}）——General 是面向所有对手的公共树（D3）`,
    )
  }
  // lint：general 层引用对手牌表字段 → warning（不阻断）
  for (const hit of collectOppHandRefs(general)) {
    warnings.push(`general 层规则 ${hit}：General 应只写共性规则；该明牌先验字段按批跑实际对手牌表求值，泛化语义存疑（G8 lint）`)
  }

  const singles: ResolvedSingle[] = []
  for (const e of entries) {
    const plan = await loadPlanChecked(join(dir, e.planRef), `single "${e.label}"`)
    const opp = plan.context.opponent
    // ① single 绑定一致性
    if (opp.kind !== "known_deck" || opp.deckCode !== e.opponentDeckCode) {
      throw new Error(
        `portfolio ${path}：single "${e.label}" 的计划必须声明 context.opponent = known_deck 且 deckCode 与 manifest 绑定一致`
        + `（manifest 绑定 ${e.opponentDeckCode}，计划声明 ${opp.kind === "known_deck" ? opp.deckCode : opp.kind}）`,
      )
    }
    singles.push({ label: e.label, opponentDeckCode: e.opponentDeckCode, planRef: e.planRef, plan, planId: plan.planId })
  }

  const generalId = general.planId
  const portfolioId = computePortfolioId({ generalId, singles })

  // lineage 可选；与解析结果不一致 → warning（不阻断，以重算为准）
  if (raw.lineage !== undefined) {
    if (raw.lineage.generalId !== generalId) {
      warnings.push(`lineage.generalId（${raw.lineage.generalId}）与解析结果（${generalId}）不一致——以装载时重算为准`)
    }
    for (const s of singles) {
      const recorded = raw.lineage.singles?.[s.label]
      if (recorded !== undefined && recorded !== s.planId) {
        warnings.push(`lineage.singles["${s.label}"]（${recorded}）与解析结果（${s.planId}）不一致——以装载时重算为准`)
      }
    }
  }

  // 版本钉扎（V0）：各层 context.gameVersion 一致性校验。
  // 全未声明 → 放行 + warning（建议钉版本）；有声明且全部相同 → 通过；
  // 混合（有的声明有的没声明）或互不相同 → 硬错误（force 放行降级 warning）。
  const layerPlans = [general, ...singles.map((s) => s.plan)]
  const declaredVersions = layerPlans
    .map((p) => p.context.gameVersion)
    .filter((v): v is string => v !== undefined)
  let commonGameVersion: Version | undefined
  if (declaredVersions.length === 0) {
    warnings.push(
      "portfolio 各层均未声明 context.gameVersion——游戏版本未钉住"
      + "（运行按 batch config ?? CURRENT_VERSION 决定）；建议在计划中声明一致版本避免词表漂移",
    )
  } else if (declaredVersions.length === layerPlans.length && new Set(declaredVersions).size === 1) {
    commonGameVersion = declaredVersions[0] as Version
  } else {
    const shown = layerPlans
      .map((p, i) => `${i === 0 ? "general" : `single "${singles[i - 1].label}"`}=${p.context.gameVersion ?? "（未声明）"}`)
      .join("，")
    const message = `portfolio 各层 context.gameVersion 不一致（${shown}）——计划跨版本起草，词表可能漂移`
    if (!opts?.force) {
      throw new Error(`${message}；请统一各层版本，或加 --force / config.force=true 放行`)
    }
    warnings.push(`${message}；--force 放行，实际版本按 batch config.gameVersion ?? CURRENT_VERSION 决定`)
  }

  return {
    portfolio: { manifest: raw, general, generalId, singles, portfolioId, commonGameVersion },
    warnings,
  }
}
