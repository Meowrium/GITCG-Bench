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
 * ablate-portfolio — plan:ablate 的两层组合（portfolio）模式辅助模块（G7，Phase 4）。
 *
 * 与 run-plan-ablate.ts 的关系：CLI 入口的 main() 直接执行不可测，本模块收敛
 * portfolio 模式的全部纯函数与类型（臂构造 / 组选择 / 跨组指标汇总 / 报告形状），
 * colocated 单测直接 import 本模块；run-plan-ablate.ts 只做 IO（装载、批跑、写报告）。
 *
 * - buildPortfolioAblationArms：从 reflection 的 ruleVerdicts 构造消融臂——臂 =
 *   对 portfolio 应用层化 revise/remove/add（ruleRef 带层前缀 general:… /
 *   single:<label>:…，`add:` 前缀约定不变；直接走 applyPlanPatch 的 PatchPlanTarget
 *   重载，不新写定位逻辑）。skipped 臂带原因字符串（层不存在 / 规则不存在 /
 *   r1 同位置规则缺失 / patch 合并失败）。
 * - selectGroupsForArm：臂 → 证据组选择——general 臂跑全部组；single 臂只跑路由到
 *   该 single 的组（组 singleLabel 由调用方用 reflect-portfolio.resolveGroupSingleLabel
 *   预计算）；无命中组 → 返回 skipped 说明。
 * - aggregateGroupMetrics：General claim 的跨组汇总口径（D4 层键化后 perRuleThenMiss
 *   自然带层，但跨对手聚合口径要定义——G7 建议：General claim 用多对手证据组汇总，
 *   Single claim 只看本组）。胜率/coverage/fallback 按局数加权，thenMiss 计数直接求和。
 * - portfolioFromPatched：applyPlanPatch 输出（PatchPlanTarget）映射回 ResolvedPortfolio
 *   （manifest 原样保留、singles 按 label 回溯 opponentDeckCode/planRef、portfolioId 重算）。
 *
 * 报告形状（ablation-report.json 增组维度）：每臂 = { …旧字段, layer, groups:
 * [{ group, routing, status, note, baseline, arm }], summary: { 汇总判定 } }。
 */

import type { DecisionRuleV1, GamePlanV1 } from "../game-plan-v1.js"
import { applyPlanPatch, type PatchPlanTarget } from "../plan-patch.js"
import { computePortfolioId, type ResolvedPortfolio } from "../portfolio.js"
import { formatRuleKey, parseRuleKey, type ParsedRuleKey } from "../rule-key.js"
import { diffNumericRevision } from "./ablate-numeric.js"

// ── 臂构造 ─────────────────────────────────────────────────────────────

/** reflection ruleVerdicts 中可进入消融的 claim（verdict 非 keep + 非空 falsifiableClaim） */
export interface AblationClaim {
  ruleRef: string
  verdict: "revise" | "remove"
  falsifiableClaim: string
}

/** 层定位（与 rule-key.ts 的 ParsedRuleKey.layer 同形） */
export type AblationLayer = { kind: "general" } | { kind: "single"; label: string }

/** 构造完成的消融臂：层定位 + 变异后 portfolio（PatchPlanTarget）+ 判定取数键 */
export interface PortfolioAblationArm {
  /** 臂名（调用方按索引补序号：arm-XX-<ruleRef 下划线化>） */
  armId: string
  ruleRef: string
  verdict: "revise" | "remove"
  falsifiableClaim: string
  layer: AblationLayer
  /**
   * 判定取数键（summary.perRuleThenMiss / perRuleHits / eval perRule 的键）：
   * revise/remove = 层化键原样；add = 合成 ref 去 `add:` 前缀（实际插入键）。
   */
  refKey: string
  /** 变异后的组合目标（general + singles 分层树；未触及层与 base 相同） */
  patched: PatchPlanTarget
  /**
   * 数值修订标记（revise 臂专用）：base vs revised 同位置规则在 then.damage_min /
   * then.kills 或 when 骰子闸/HP 闸数值上有差异 → 同种子反事实判据适用
   * （ablate-numeric.ts diffNumericRevision）。
   */
  numericTouched?: boolean
  /** 数值变化清单（如 "then.damage_min 3→5"），进报告供审计 */
  numericChanges?: string[]
  /** 非空 = 该臂不可测试（组选择前即淘汰） */
  skipped?: string
}

/** 构造臂的输入：base / revised 组合目标 + reflection claims */
export interface BuildArmsInput {
  base: ResolvedPortfolio
  revised: ResolvedPortfolio
  claims: AblationClaim[]
}

function layerTreeOf(pf: ResolvedPortfolio, layer: AblationLayer): GamePlanV1 | null {
  if (layer.kind === "general") return pf.general
  return pf.singles.find((s) => s.label === layer.label)?.plan ?? null
}

/** 按层 + scope + priority 定位规则（global → rules；phase → phases[].rules） */
function findRuleInTree(tree: GamePlanV1, parsed: ParsedRuleKey): DecisionRuleV1 | undefined {
  if (parsed.scope === "global") return tree.rules?.find((r) => r.priority === parsed.priority)
  return tree.phases?.find((p) => p.phaseId === parsed.phaseId)?.rules?.find((r) => r.priority === parsed.priority)
}

/** 层键字符串（applyPlanPatch 的 add.layer 键："general" / "single:<label>"） */
function layerKeyOf(layer: AblationLayer): string {
  return layer.kind === "general" ? "general" : `single:${layer.label}`
}

/** 把 patch 目标映射回 ResolvedPortfolio（manifest 原样；singles 按 label 回溯原绑定） */
export function portfolioFromPatched(base: ResolvedPortfolio, patched: PatchPlanTarget): ResolvedPortfolio {
  const singles = patched.singles.map((p) => {
    const orig = base.singles.find((s) => s.label === p.label)
    if (!orig) {
      // 理论不可达（applyPlanPatch 只操作已存在的层）；防御性抛出
      throw new Error(`portfolio 消融：patch 结果含未知 single label "${p.label}"（层树在 base 中不存在）`)
    }
    return { ...orig, plan: p.plan, planId: p.plan.planId }
  })
  return {
    manifest: base.manifest,
    general: patched.general,
    generalId: patched.general.planId,
    singles,
    portfolioId: computePortfolioId({ generalId: patched.general.planId, singles }),
  }
}

/**
 * 从 reflection claims 构造全部消融臂（含 skipped）。纯函数、同步（applyPlanPatch
 * 是同步纯函数）。规则：revise/remove 的目标规则在 base 层树中必须存在；`add:` 前缀
 * 的目标在 revised 层树中必须存在（验证"新增该规则是否有益"）；revise 的同位置修订
 * 规则在 revised 层树中必须存在（取 revised 版 when/then 做单变量替换）。
 */
export function buildPortfolioAblationArms(input: BuildArmsInput): PortfolioAblationArm[] {
  const { base, revised, claims } = input
  const baseTarget: PatchPlanTarget = {
    general: base.general,
    singles: base.singles.map((s) => ({ label: s.label, plan: s.plan })),
  }
  const arms: PortfolioAblationArm[] = []
  for (const claim of claims) {
    const parsed = parseRuleKey(claim.ruleRef)
    if (!parsed) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer: { kind: "general" }, refKey: claim.ruleRef, patched: baseTarget, skipped: "ruleRef 不可解析（层化键格式不符）" })
      continue
    }
    if (!parsed.layer) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer: { kind: "general" }, refKey: claim.ruleRef, patched: baseTarget, skipped: "ruleRef 缺少层前缀（portfolio 模式须 general:… / single:<label>:…）" })
      continue
    }
    const layer: AblationLayer = parsed.layer
    const baseTree = layerTreeOf(base, layer)
    if (!baseTree) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: `层 ${layerKeyOf(layer)} 在 base portfolio 中不存在` })
      continue
    }
    const revisedTree = layerTreeOf(revised, layer)
    // add: 前缀 = 验证"新增该规则是否有益"：目标规则在 revised 层树中定位，臂 = base + 该规则
    if (parsed.added === true) {
      if (!revisedTree) {
        arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: `层 ${layerKeyOf(layer)} 在 revised portfolio 中不存在（无法取新增规则）` })
        continue
      }
      const rule = findRuleInTree(revisedTree, parsed)
      if (!rule) {
        arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: "revised 中不存在该新增规则（结构重排）" })
        continue
      }
      const result = applyPlanPatch(baseTarget, {
        ops: [{
          op: "add",
          layer: layerKeyOf(layer),
          scope: parsed.scope === "phase" ? parsed.phaseId! : "global",
          position: "end",
          when: rule.when,
          then: rule.then,
          reason: "portfolio 消融：验证新增规则是否有益",
          falsifiableClaim: claim.falsifiableClaim,
        }],
      })
      if (!result.ok) {
        arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: `add patch 合并失败：${result.errors[0]}` })
        continue
      }
      const synthetic = result.verdicts[0]?.ruleRef ?? ""
      const refKey = synthetic.startsWith("add:") ? synthetic.slice("add:".length) : formatRuleKey({ scope: parsed.scope, phaseId: parsed.scope === "phase" ? parsed.phaseId : null, priority: parsed.priority, layer: parsed.layer.kind, layerLabel: parsed.layer.kind === "single" ? parsed.layer.label : null })
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey, patched: result.portfolio })
      continue
    }
    // 非 add：revise/remove 的目标规则在 base 层树中必须存在
    if (!findRuleInTree(baseTree, parsed)) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: "base 层树中不存在该规则" })
      continue
    }
    if (claim.verdict === "remove") {
      const result = applyPlanPatch(baseTarget, {
        ops: [{ op: "remove", ruleRef: claim.ruleRef, reason: "portfolio 消融：验证移除该规则是否有益", falsifiableClaim: claim.falsifiableClaim }],
      })
      if (!result.ok) {
        arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: `remove patch 合并失败：${result.errors[0]}` })
        continue
      }
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: result.portfolio })
      continue
    }
    // revise：目标规则在 revised 层树中必须存在（取同位置修订版做单变量替换）
    if (!revisedTree || !findRuleInTree(revisedTree, parsed)) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: "revised 层树中找不到同位置修订规则（结构重排）" })
      continue
    }
    const revisedRule = findRuleInTree(revisedTree, parsed)!
    const numeric = diffNumericRevision(findRuleInTree(baseTree, parsed)!, revisedRule)
    const result = applyPlanPatch(baseTarget, {
      ops: [{
        op: "revise",
        ruleRef: claim.ruleRef,
        when: revisedRule.when,
        then: revisedRule.then,
        reason: "portfolio 消融：验证同位置修订是否有益",
        falsifiableClaim: claim.falsifiableClaim,
      }],
    })
    if (!result.ok) {
      arms.push({ armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim, layer, refKey: claim.ruleRef, patched: baseTarget, skipped: `revise patch 合并失败：${result.errors[0]}` })
      continue
    }
    arms.push({
      armId: "", ruleRef: claim.ruleRef, verdict: claim.verdict, falsifiableClaim: claim.falsifiableClaim,
      layer, refKey: claim.ruleRef, patched: result.portfolio,
      numericTouched: numeric.touched, numericChanges: numeric.changes,
    })
  }
  return arms
}

// ── 臂 → 证据组选择 ───────────────────────────────────────────────────

/** 证据组的路由快照（singleLabel 由调用方预计算；无命中即 undefined） */
export interface EvidenceGroupRef {
  /** 组名（run 目录 basename） */
  label: string
  /** 组对手 deckCode 路由到的 single label（resolveGroupSingleLabel 判定） */
  singleLabel?: string
}

/** 组选择结果：general 臂 → 全部组；single 臂 → 仅路由命中组；无命中 → skipped */
export function selectGroupsForArm(
  layer: AblationLayer,
  groups: EvidenceGroupRef[],
): { selected: EvidenceGroupRef[]; skippedNote?: string } {
  if (layer.kind === "general") return { selected: [...groups] }
  const selected = groups.filter((g) => g.singleLabel === layer.label)
  if (selected.length === 0) {
    return {
      selected: [],
      skippedNote: `无证据组路由到 single:${layer.label}（全部 ${groups.length} 个组均非该 single 绑定的对手）——该臂无对照样本`,
    }
  }
  return { selected }
}

// ── 跨组指标汇总（General claim 汇总口径） ────────────────────────────

/** 单组指标快照（供汇总：胜率/coverage/fallback 按局数加权，thenMiss 求和） */
export interface GroupMetricsInput {
  /** 本组局数（权重；= 该组基线 summary.games，臂同局数保证可比） */
  games: number
  wins: number
  coverage: number
  fallbackRate: number
  /** 本组该规则键的 thenMiss 计数（臂侧按 refKey 取） */
  thenMiss: number
}

export interface AggregatedMetrics {
  games: number
  wins: number
  winRate: number
  coverage: number
  fallbackRate: number
  thenMiss: number
}

/** General claim 的跨组汇总：胜率/coverage/fallback 按局数加权，thenMiss 直接求和。
 *  Single claim 只跑本组 → 汇总 = 该组原值（调用方传单元素数组即可）。 */
export function aggregateGroupMetrics(groups: GroupMetricsInput[]): AggregatedMetrics {
  const games = groups.reduce((s, g) => s + g.games, 0)
  const wins = groups.reduce((s, g) => s + g.wins, 0)
  const coverage = games > 0 ? groups.reduce((s, g) => s + g.coverage * g.games, 0) / games : 0
  const fallbackRate = games > 0 ? groups.reduce((s, g) => s + g.fallbackRate * g.games, 0) / games : 0
  return {
    games,
    wins,
    winRate: games > 0 ? wins / games : 0,
    coverage,
    fallbackRate,
    thenMiss: groups.reduce((s, g) => s + g.thenMiss, 0),
  }
}

// ── 报告形状（组维度） ─────────────────────────────────────────────────

/** 每臂 per-group 结果的固定形状（ablation-report.json 组维度） */
export interface PortfolioGroupResult {
  group: string
  /** 组运行形态："single:<label>" / "general-only"（来自组 run 归档或路由判定） */
  routing: string
  status: "supported" | "refuted" | "inconclusive" | "skipped"
  note: string
  baseline: {
    winRate: number
    coverage?: number
    fallbackRate?: number
    thenMiss: number
  }
  arm: {
    winRate: number
    coverage?: number
    fallbackRate?: number
    thenMiss: number
    games: number
  }
}

/** 每臂汇总判定的输入快照（跨组汇总后喂 judgeEngineOnly / oracle 判据） */
export interface PortfolioArmSummaryResult {
  status: "supported" | "refuted" | "inconclusive" | "skipped"
  note: string
  games: number
  baseline: AggregatedMetrics
  arm: AggregatedMetrics
}

/** 完整消融臂报告条目（groups 为组维度展开，summary 为跨组汇总判定） */
export interface PortfolioArmReport {
  armId: string
  ruleRef: string
  verdict: "revise" | "remove"
  falsifiableClaim: string
  layer: AblationLayer
  refKey: string
  status: "supported" | "refuted" | "inconclusive" | "skipped"
  note: string
  groups: PortfolioGroupResult[]
  summary: PortfolioArmSummaryResult | null
}
