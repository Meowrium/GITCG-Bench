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
 * rule-key — 规则归因键（ruleRef / trace perRuleHits 键）的唯一拼键/解析 helper
 * （两层决策树 D4 定稿格式，见 TEMP-two-layer-general-single-gap-analysis.md §5）。
 *
 * 键格式：
 * - 旧格式（无层，单树时代，必须继续可读可写、逐字节一致）：
 *   `global:<priority>` / `phase:<phaseId>:<priority>` / `opening:0`
 *   （opening 规则无 priority 字段，trace 侧恒记 0）。
 * - 新格式 = 层前缀 + 旧键：`general:global:5` / `single:<label>:phase:burst:20` /
 *   `single:<label>:opening:0`。label = manifest `singles[].label`（缺省 =
 *   opponentDeckCode），禁止为空或含 ':'（portfolio 校验拒绝）。
 * - ablate 的合成新增规则标记 `add:` 继续整体前置（如 `add:single:hongniu:global:3`）。
 *
 * 全仓库拼键/解析一律收敛到本模块（trace finalize / plan-player-io thenMiss /
 * plan-replay / cli/modules / eval-game / plan-patch / run-plan-ablate /
 * run-plan-reflect / cli/evidence-extract），不得再散落模板字符串。
 */

import type { GamePlanV1 } from "./game-plan-v1.js"

export type RuleScope = "global" | "phase" | "opening"
export type RuleLayer = "general" | "single"

/** parseRuleKey 的解析结果 */
export interface ParsedRuleKey {
  /** 层维度；缺省 = 旧单树格式（无前缀） */
  layer?: { kind: "general" } | { kind: "single"; label: string }
  scope: RuleScope
  /** scope === "phase" 时必存在 */
  phaseId?: string
  priority: number
  /** `add:` 前缀（ablate 合成新增规则）；未带前缀时该字段缺省 */
  added?: boolean
}

/** formatRuleKey 的输入（拼键侧持有的扁平层标注，与 trace matchedRule 同形） */
export interface RuleKeyParts {
  scope: RuleScope
  priority: number
  /** scope === "phase" 的阶段 id；缺省按 "?" 占位（沿用旧格式 `phase:?:<p>` 先例） */
  phaseId?: string | null
  /** 层维度；缺省 = 旧单树格式（无前缀） */
  layer?: RuleLayer
  /** layer === "single" 时的 label（由调用方保证已设）；缺省按 "?" 占位 */
  layerLabel?: string | null
  /** ablate 合成新增规则：整体前置 "add:" */
  added?: boolean
}

const PRIORITY_RE = "-?\\d+(?:\\.\\d+)?"
const GLOBAL_KEY_RE = new RegExp(`^global:(${PRIORITY_RE})$`)
const PHASE_KEY_RE = new RegExp(`^phase:([^:]+):(${PRIORITY_RE})$`)
const OPENING_KEY_RE = new RegExp(`^opening:(${PRIORITY_RE})$`)

/**
 * 拼键。无层时输出与旧格式逐字节一致：
 * `global:<p>` / `phase:<phaseId>:<p>` / `opening:0`（opening 恒记 0，忽略入参 priority）。
 */
export function formatRuleKey(parts: RuleKeyParts): string {
  const bare = parts.scope === "phase"
    ? `phase:${parts.phaseId ?? "?"}:${parts.priority}`
    : parts.scope === "opening"
      ? "opening:0"
      : `global:${parts.priority}`
  const layerPrefix = parts.layer === undefined
    ? ""
    : parts.layer === "general"
      ? "general:"
      : `single:${parts.layerLabel ?? "?"}:`
  return `${parts.added === true ? "add:" : ""}${layerPrefix}${bare}`
}

/**
 * 解析。同时接受旧格式、层前缀格式与 `add:` 前缀；垃圾输入返回 null。
 * 注意：本函数接受 opening 键（`opening:0` 等）——只消费 global/phase 的旧调用方
 * （plan-patch / run-plan-ablate）在各自的薄包装里把 opening 继续判为非法。
 */
export function parseRuleKey(key: string): ParsedRuleKey | null {
  if (typeof key !== "string" || key.length === 0) return null
  let rest = key
  let added = false
  if (rest.startsWith("add:")) {
    added = true
    rest = rest.slice(4)
  }
  let layer: ParsedRuleKey["layer"]
  if (rest.startsWith("general:")) {
    layer = { kind: "general" }
    rest = rest.slice("general:".length)
  } else if (rest.startsWith("single:")) {
    // label 取到下一个 ':' 为止（label 本身禁止含 ':'，由 portfolio 校验保证）
    const idx = rest.indexOf(":", "single:".length)
    if (idx < 0) return null
    const label = rest.slice("single:".length, idx)
    if (label.length === 0) return null
    layer = { kind: "single", label }
    rest = rest.slice(idx + 1)
  }
  const base = (b: { scope: RuleScope; phaseId?: string; priority: number }): ParsedRuleKey => ({
    ...(layer !== undefined ? { layer } : {}),
    ...b,
    ...(added ? { added: true } : {}),
  })
  let m = GLOBAL_KEY_RE.exec(rest)
  if (m) return base({ scope: "global", priority: Number(m[1]) })
  m = PHASE_KEY_RE.exec(rest)
  if (m) return base({ scope: "phase", phaseId: m[1], priority: Number(m[2]) })
  m = OPENING_KEY_RE.exec(rest)
  if (m) return base({ scope: "opening", priority: Number(m[1]) })
  return null
}

/**
 * 收集单计划的全部合法 ruleRef——global + phases + opening。
 * opening 键固定 `opening:0`（opening 规则无 priority 字段，trace 侧恒记 0），
 * 仅当计划声明了至少一条 opening 条目时纳入（空 opening 不产生该键，避免
 * 零命中告警噪声）。layer 缺省 = 旧格式键（无前缀）。
 */
export function collectRuleKeys(
  plan: GamePlanV1,
  layer?: { kind: "general" } | { kind: "single"; label: string },
): Set<string> {
  const layerParts: Pick<RuleKeyParts, "layer" | "layerLabel"> = layer === undefined
    ? {}
    : layer.kind === "general"
      ? { layer: "general" }
      : { layer: "single", layerLabel: layer.label }
  const refs = new Set<string>()
  for (const r of plan.rules ?? []) {
    refs.add(formatRuleKey({ scope: "global", priority: r.priority, ...layerParts }))
  }
  for (const p of plan.phases ?? []) {
    for (const r of p.rules ?? []) {
      refs.add(formatRuleKey({ scope: "phase", phaseId: p.phaseId, priority: r.priority, ...layerParts }))
    }
  }
  const opening = plan.opening
  const hasOpening = (opening?.chooseActive?.length ?? 0) + (opening?.mulligan?.length ?? 0) + (opening?.reroll?.length ?? 0) > 0
  if (hasOpening) {
    refs.add(formatRuleKey({ scope: "opening", priority: 0, ...layerParts }))
  }
  return refs
}
