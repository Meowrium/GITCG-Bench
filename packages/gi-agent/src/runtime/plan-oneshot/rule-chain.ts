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
 * rule-chain — 两层组合链（D1=A）的唯一构造点：Single 层整体前置 + General 层，
 * 层内 = 命中 phase 规则前置 + global 规则，按（priority，原顺序）稳定排序。
 *
 * plan-player-io（执行期）与 plan-replay（静态回放）各自之前都内联写了这层排序
 * 逻辑，本模块收敛为单一实现，保证两处层主序语义逐字节一致
 * （TEMP-two-layer-general-single-gap-analysis.md §5-D1）。
 *
 * 语义：
 * - 层主序：specs 按调用方传入顺序拼接（组合模式 = [single, general]；
 *   general-only = [general]；旧单树 = [单树]，无层标注）；
 * - 层内排序：命中 phase 的 rules（activePhase 指定）前置到该层 global rules
 *   之前，按（priority，原顺序）稳定排序——同 priority 保原顺序；
 * - activePhase 缺省 = 全部 phases 的规则都进链（静态回放上界口径）；
 *   activePhase = null = 无 phase 规则（执行期该层无命中 phase）；
 * - 每条规则携带所属层下标（layerIndex），调用方据此关联该层的求值上下文
 *   （执行期各层的命中 phaseId 独立判定）。
 */

import type { DecisionRuleV1, GamePlanV1 } from "./game-plan-v1.js"
import type { RuleLayer } from "./rule-key.js"

/** 链内规则（在 DecisionRuleV1 之上标注 scope/所属层） */
export interface ChainScopedRule extends DecisionRuleV1 {
  scope: "phase" | "global"
  /** scope === "phase" 时所属层的命中阶段 id */
  phaseId?: string
  /** 层标注；缺省 = 旧单树（键无前缀） */
  layer?: RuleLayer
  /** layer === "single" 时设置（manifest singles[].label） */
  layerLabel?: string
}

/** 组合链的一层输入 */
export interface ChainLayerSpec {
  plan: GamePlanV1
  layer?: RuleLayer
  layerLabel?: string
  /**
   * 该层纳入链的 phase 规则来源：
   * - 缺省：全部 phases 的规则（静态回放覆盖上界口径）；
   * - 字符串 phaseId：只取该 phase 的规则（执行期命中 phase）；
   * - null：无 phase 规则（执行期该层无命中 phase）。
   */
  activePhase?: string | null
}

/** combinedChain 的单条输出：规则 + 所属层下标（关联该层求值上下文） */
export interface ChainOrderedRule {
  rule: ChainScopedRule
  layerIndex: number
}

/** 组合链构造（D1=A 层主序，见文件头）；与 plan-player-io 组合链同一排序语义 */
export function combinedChain(specs: readonly ChainLayerSpec[]): ChainOrderedRule[] {
  const out: ChainOrderedRule[] = []
  specs.forEach((spec, layerIndex) => {
    const tag = spec.layer === undefined
      ? {}
      : { layer: spec.layer, ...(spec.layerLabel !== undefined ? { layerLabel: spec.layerLabel } : {}) }
    const phaseRules: ChainScopedRule[] = spec.activePhase === undefined
      ? (spec.plan.phases ?? []).flatMap((p) => (p.rules ?? []).map((r) => ({ ...r, scope: "phase" as const, phaseId: p.phaseId, ...tag })))
      : spec.activePhase === null
        ? []
        : (spec.plan.phases ?? [])
          .filter((p) => p.phaseId === spec.activePhase)
          .flatMap((p) => (p.rules ?? []).map((r) => ({ ...r, scope: "phase" as const, phaseId: p.phaseId, ...tag })))
    const chain: ChainScopedRule[] = [
      ...phaseRules,
      ...(spec.plan.rules ?? []).map((r) => ({ ...r, scope: "global" as const, ...tag })),
    ]
    chain
      .map((rule, order) => ({ rule, order }))
      .sort((a, b) => a.rule.priority - b.rule.priority || a.order - b.order)
      .forEach(({ rule }) => out.push({ rule, layerIndex }))
  })
  return out
}
