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
 * plan-patch — 反思修订的受限补丁协议（2026-08-29 分析的迭代动力学对策）。
 *
 * 动机：round25 数据显示全量重写式反思每轮仅保留 6–22/37–40 条规则，上轮已验证
 * 的规则被连带破坏（r4→r5 blunder 回弹 +14pp）。本协议把修订表达从"重写整棵树"
 * 收窄为"对当前决策树的受限 ops"，由 harness 在服务端合并：
 *
 * 授权边界（硬约束，全部在本模块强制）：
 * 1. ops 只作用于调用方传入的**当前轮次指定决策树**（plan:reflect --plan 载入的
 *    那一份的后代）——ops 是纯数据，不含任何文件路径，无法触及其他计划文件；
 * 2. `context` / `author` / `planId` / `parentPlanId` / `createdAt` / `opening`
 *    等系统字段不在 op 的可表达范围内，LLM 结构上无法越界修改；
 * 3. ruleRef 是封闭集合：revise/remove 的目标必须存在于当前树（错误整批拒绝，
 *    不做部分应用）；add 的位置引用同理；
 * 4. 单条命令 ops 数量有上限（默认 8），未触及的规则默认 keep。
 *
 * 两层组合模式（Phase 3a，G5-3）：applyPlanPatch 目标可为一棵单树
 * （`GamePlanV1`，旧行为零变化）或一个 portfolio 目标（`PatchPlanTarget`，
 * general + singles 分层树）。portfolio 目标下：
 * - revise/remove 的 ruleRef **必须带层前缀**（`general:…` / `single:<label>:…`），
 *   无前缀 → 该 op 报错；层内键必须存在于对应层树（collectRuleKeys 按层展开）；
 * - add / set_fallback 增可选 `layer` 键（`"general"` 或 `"single:<label>"`），
 *   portfolio 目标下缺省 → 报错；层定位先于 scope/position（fallback 按层归属，D2）；
 * - 被触及的每层树收尾重算 planId、parentPlanId 指向该层旧 planId
 *   （normalizePlanNumericFields + computePlanId，逐层同一逻辑）；
 *   auto-repair/校验由调用方（reflect）负责，本模块不做。
 * opening 依旧不可 patch（parseRuleRef 拒绝 opening 键；collectRuleKeys 的 opening 键
 * 只用于 ruleRef 合法集合的劝告性校验）。
 */

import type {
  ActionSpecV1,
  DecisionRuleV1,
  GamePlanV1,
  PlanFallbackPolicyKind,
  WhenConditionV1,
} from "./game-plan-v1.js"
import { collectRuleKeys, formatRuleKey, parseRuleKey, type RuleKeyParts } from "./rule-key.js"
import { computePlanId, normalizePlanNumericFields } from "./validate.js"

const FALLBACK_POLICIES: ReadonlySet<string> = new Set(["baseline", "conservative", "declare_end"])

/** add 的插入位置："start"/"end" 或相对某条现有规则 */
export type PatchPosition = "start" | "end" | { before: string } | { after: string }

/** 层定位（与 rule-key.ts 的 ParsedRuleKey.layer 同形；"general" 或 "single:<label>"） */
export type PatchLayerSpec = { kind: "general" } | { kind: "single"; label: string }

/** 修订 op 的公共字段 */
interface PatchOpBase {
  /** 人类可读理由（合成 verdicts 的 justification；审计链） */
  reason: string
  /** 可证伪声明（可选；非空时消融管线 plan:ablate 可验证） */
  falsifiableClaim?: string | null
}

export type PlanPatchOp =
  | ({ op: "revise"; ruleRef: string; when?: WhenConditionV1[]; then?: ActionSpecV1 } & PatchOpBase)
  | ({ op: "remove"; ruleRef: string } & PatchOpBase)
  | ({
      op: "add"
      /** "global"（默认）或已存在的 phaseId */
      scope?: string
      /**
       * 层定位（Phase 3a，portfolio 目标）：`"general"` 或 `"single:<label>"`。
       * portfolio 目标下必填（缺省 → 报错）；单树目标下缺省照旧（提供了反而报错）。
       * 层定位先于 scope/position 解析。
       */
      layer?: string
      position?: PatchPosition
      when?: WhenConditionV1[]
      then: ActionSpecV1
    } & PatchOpBase)
  | ({
      op: "set_fallback"
      policy: string
      /** 层定位（D2 fallback 按层归属）；同 add.layer 的缺省/必填规则 */
      layer?: string
    } & PatchOpBase)

/** patch 命令载荷（agent-loop 的 "patch" action） */
export interface PlanPatchCommand {
  ops: PlanPatchOp[]
  predictionPostmortem?: string
  predictions?: Partial<GamePlanV1["predictions"]>
}

export interface PatchVerdict {
  ruleRef: string
  verdict: "keep" | "revise" | "remove"
  justification: string
  falsifiableClaim?: string | null
  /** 机械来源：patch = patch 合成；draft = 全量稿 verdicts 的规范化快照 */
  source: "patch" | "draft"
}

export type PlanPatchApplyResult =
  | { ok: true; plan: GamePlanV1; appliedOps: PlanPatchOp[]; verdicts: PatchVerdict[] }
  | { ok: false; errors: string[] }

/**
 * portfolio 目标的 patch 应用目标（最小结构接口；ResolvedPortfolio 结构兼容——
 * general 树 + singles 各带一棵层树；调用方负责把结果映射回 ResolvedPortfolio）。
 * 注意：本模块不 import batch-runner；portfolio 装载/路由在 portfolio.ts。
 */
export interface PatchPlanTarget {
  general: GamePlanV1
  singles: Array<{ label: string; plan: GamePlanV1 }>
}

export type PlanPatchPortfolioApplyResult =
  | { ok: true; portfolio: PatchPlanTarget; appliedOps: PlanPatchOp[]; verdicts: PatchVerdict[] }
  | { ok: false; errors: string[] }

const OP_KEYS: Record<string, ReadonlySet<string>> = {
  revise: new Set(["op", "ruleRef", "when", "then", "reason", "falsifiableClaim"]),
  remove: new Set(["op", "ruleRef", "reason", "falsifiableClaim"]),
  add: new Set(["op", "layer", "scope", "position", "when", "then", "reason", "falsifiableClaim"]),
  set_fallback: new Set(["op", "layer", "policy", "reason", "falsifiableClaim"]),
}

/** 解析 `layer` 键值（"general" 或 "single:<label>"）；非法返回 null（label 非空且不含 ':'，与 portfolio 校验同口径） */
function parseLayerSpec(layer: unknown): PatchLayerSpec | null {
  if (typeof layer !== "string") return null
  if (layer === "general") return { kind: "general" }
  if (layer.startsWith("single:")) {
    const label = layer.slice("single:".length)
    if (label.length === 0 || label.includes(":")) return null
    return { kind: "single", label }
  }
  return null
}

/** 解析结果（layer 缺省 = 旧单树格式无前缀键） */
interface ParsedRuleRef {
  layer?: PatchLayerSpec
  scope: "global" | "phase"
  phaseId?: string
  priority: number
}

/**
 * 薄本地包装：解析统一走 rule-key.ts 的 parseRuleKey，这里把输出适配回本协议
 * 的判别联合——接受旧格式与层前缀格式的 global/phase 键（`add:` 前缀与 opening
 * 键仍判为非法）。层前缀经 parseRuleKey 直接透传（`general:global:5` /
 * `single:<label>:phase:burst:20`）；单树目标下带层前缀的 ref 由
 * applyPlanPatch 在预检中拒绝（层语义只存在于 portfolio 目标）。
 */
function parseRuleRef(ref: unknown): ParsedRuleRef | null {
  if (typeof ref !== "string") return null
  const parsed = parseRuleKey(ref)
  if (!parsed || parsed.added === true) return null
  const layer = parsed.layer
  if (parsed.scope === "global") return { ...(layer ? { layer } : {}), scope: "global", priority: parsed.priority }
  if (parsed.scope === "phase") return { ...(layer ? { layer } : {}), scope: "phase", phaseId: parsed.phaseId!, priority: parsed.priority }
  return null
}

function rulesOfScope(plan: GamePlanV1, scope: string): DecisionRuleV1[] {
  if (scope === "global") return plan.rules ?? []
  return plan.phases?.find((p) => p.phaseId === scope)?.rules ?? []
}

/** 层键的 formatRuleKey 输入（layer 缺省 = 旧格式无前缀） */
function layerKeyParts(layer: PatchLayerSpec | undefined): Pick<RuleKeyParts, "layer" | "layerLabel"> {
  return layer === undefined
    ? {}
    : layer.kind === "general"
      ? { layer: "general" }
      : { layer: "single", layerLabel: layer.label }
}

function ruleRefOf(scope: string, priority: number, layer?: PatchLayerSpec): string {
  // 拼键统一走 rule-key.ts（scope 此处为 "global" 或 phaseId；无层时旧格式逐字节不变）
  return scope === "global"
    ? formatRuleKey({ scope: "global", priority, ...layerKeyParts(layer) })
    : formatRuleKey({ scope: "phase", phaseId: scope, priority, ...layerKeyParts(layer) })
}

/**
 * 解析 patch 命令载荷（结构级，不查封闭集合）。
 * 未知 op 类型 / 未知键 → 报错（防静默丢弃越界意图）。
 */
export function parsePlanPatchCommand(
  payload: unknown,
  opts?: { maxOps?: number },
): { ok: true; cmd: PlanPatchCommand } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["patch 载荷必须是对象（含 ops 数组）"] }
  }
  const o = payload as Record<string, unknown>
  const unknownKeys = Object.keys(o).filter((k) => !["ops", "predictionPostmortem", "predictions"].includes(k))
  if (unknownKeys.length > 0) {
    errors.push(`patch 含未知键：${unknownKeys.join(", ")}（patch 只接受 ops / predictionPostmortem / predictions）`)
  }
  if (!Array.isArray(o.ops) || o.ops.length === 0) {
    errors.push("patch.ops 必须是非空数组")
    return { ok: false, errors }
  }
  const maxOps = opts?.maxOps ?? 8
  if (o.ops.length > maxOps) {
    errors.push(`单条 patch 命令最多 ${maxOps} 个 op（收到 ${o.ops.length}）——分多条 patch 提交，未触及的规则默认保留`)
    return { ok: false, errors }
  }
  const ops: PlanPatchOp[] = []
  o.ops.forEach((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`ops[${i}] 必须是对象`)
      return
    }
    const ro = raw as Record<string, unknown>
    const kind = ro.op
    const allowed = typeof kind === "string" ? OP_KEYS[kind] : undefined
    if (!allowed) {
      errors.push(`ops[${i}].op 未知：${String(kind)}（可选 revise / remove / add / set_fallback）`)
      return
    }
    const extra = Object.keys(ro).filter((k) => !allowed.has(k))
    if (extra.length > 0) {
      errors.push(`ops[${i}]（${String(kind)}）含未知键：${extra.join(", ")}——patch 无法表达该意图（context/author/谱系等系统字段不可修改）`)
      return
    }
    if (typeof ro.reason !== "string" || ro.reason.length === 0) {
      errors.push(`ops[${i}].reason 必填（进入 verdicts 审计链）`)
      return
    }
    const base: PatchOpBase = {
      reason: ro.reason,
      falsifiableClaim: typeof ro.falsifiableClaim === "string" || ro.falsifiableClaim === null ? (ro.falsifiableClaim as string | null) : undefined,
    }
    if (kind === "revise" || kind === "remove") {
      if (!parseRuleRef(ro.ruleRef)) {
        errors.push(`ops[${i}].ruleRef 非法：${String(ro.ruleRef)}（形如 global:5 / phase:burst:20）`)
        return
      }
      if (kind === "revise") {
        if (ro.when === undefined && ro.then === undefined) {
          errors.push(`ops[${i}]：revise 至少提供 when 或 then 之一`)
          return
        }
        ops.push({ op: "revise", ruleRef: ro.ruleRef as string, when: ro.when as WhenConditionV1[] | undefined, then: ro.then as ActionSpecV1 | undefined, ...base })
      } else {
        ops.push({ op: "remove", ruleRef: ro.ruleRef as string, ...base })
      }
      return
    }
    if (kind === "add") {
      if (!ro.then || typeof ro.then !== "object") {
        errors.push(`ops[${i}]：add 需要 then`)
        return
      }
      if (ro.layer !== undefined && !parseLayerSpec(ro.layer)) {
        errors.push(`ops[${i}].layer 非法：${String(ro.layer)}（"general" 或 "single:<label>"，label 非空且不含 ':'）`)
        return
      }
      let position: PatchPosition = "end"
      if (ro.position !== undefined) {
        if (ro.position === "start" || ro.position === "end") {
          position = ro.position
        } else if (typeof ro.position === "object" && ro.position !== null) {
          const p = ro.position as Record<string, unknown>
          if (typeof p.before === "string" && !parseRuleRef(p.before)) {
            errors.push(`ops[${i}].position.before 非法 ruleRef：${p.before}`)
            return
          }
          if (typeof p.after === "string" && !parseRuleRef(p.after)) {
            errors.push(`ops[${i}].position.after 非法 ruleRef：${p.after}`)
            return
          }
          if (typeof p.before !== "string" && typeof p.after !== "string") {
            errors.push(`ops[${i}].position 对象形式需要 before 或 after`)
            return
          }
          position = p.before !== undefined ? { before: p.before as string } : { after: p.after as string }
        } else {
          errors.push(`ops[${i}].position 非法：${JSON.stringify(ro.position)}（"start" / "end" / {before} / {after}）`)
          return
        }
      }
      if (ro.scope !== undefined && (typeof ro.scope !== "string" || ro.scope.length === 0)) {
        errors.push(`ops[${i}].scope 必须是 "global" 或已存在的 phaseId`)
        return
      }
      ops.push({
        op: "add",
        ...(ro.layer !== undefined ? { layer: ro.layer as string } : {}),
        scope: (ro.scope as string | undefined) ?? "global",
        position,
        when: ro.when as WhenConditionV1[] | undefined,
        then: ro.then as ActionSpecV1,
        ...base,
      })
      return
    }
    // set_fallback
    if (typeof ro.policy !== "string" || !FALLBACK_POLICIES.has(ro.policy)) {
      errors.push(`ops[${i}].policy 非法：${String(ro.policy)}（可选 baseline / conservative / declare_end）`)
      return
    }
    if (ro.layer !== undefined && !parseLayerSpec(ro.layer)) {
      errors.push(`ops[${i}].layer 非法：${String(ro.layer)}（"general" 或 "single:<label>"，label 非空且不含 ':'）`)
      return
    }
    ops.push({
      op: "set_fallback",
      policy: ro.policy,
      ...(ro.layer !== undefined ? { layer: ro.layer as string } : {}),
      ...base,
    })
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, cmd: { ops, predictionPostmortem: typeof o.predictionPostmortem === "string" ? o.predictionPostmortem : undefined, predictions: o.predictions as PlanPatchCommand["predictions"] } }
}

/** 层键字符串（"general" 或 "single:<label>"；verdicts/错误信息的带层引用） */
function layerKeyOf(layer: PatchLayerSpec): string {
  return layer.kind === "general" ? "general" : `single:${layer.label}`
}

/** 计算插入点的 priority：严格落在相邻规则之间（半分），链内唯一且不重排既有规则 */
function insertionPriority(
  chain: readonly DecisionRuleV1[],
  position: PatchPosition,
  scope: string,
  layer?: PatchLayerSpec,
): { priority: number; anchor?: string } | { error: string } {
  const sorted = [...chain].sort((a, b) => a.priority - b.priority)
  if (position === "start") {
    return sorted.length === 0 ? { priority: 1 } : { priority: sorted[0].priority - 1 }
  }
  if (position === "end") {
    return sorted.length === 0 ? { priority: 1 } : { priority: sorted[sorted.length - 1].priority + 1 }
  }
  const ref = "before" in position ? parseRuleRef(position.before) : parseRuleRef(position.after)
  if (!ref) return { error: `position 引用的 ruleRef 非法：${JSON.stringify(position)}` }
  const idx = sorted.findIndex((r) => r.priority === ref.priority)
  if (idx < 0) {
    return { error: `position 引用的规则 ${ruleRefOf(scope, ref.priority, layer)} 在当前层树中不存在` }
  }
  if ("before" in position) {
    const prev = idx > 0 ? sorted[idx - 1].priority : undefined
    return { priority: prev !== undefined ? (prev + ref.priority) / 2 : ref.priority - 1, anchor: ruleRefOf(scope, ref.priority, layer) }
  }
  const next = idx < sorted.length - 1 ? sorted[idx + 1].priority : undefined
  return { priority: next !== undefined ? (ref.priority + next) / 2 : ref.priority + 1, anchor: ruleRefOf(scope, ref.priority, layer) }
}

function upsertRule(chain: DecisionRuleV1[], rule: DecisionRuleV1): void {
  const i = chain.findIndex((r) => r.priority === rule.priority)
  if (i >= 0) chain[i] = rule
  else chain.push(rule)
}

/**
 * 在单棵树上按序应用一个 op（单树路径与 portfolio 各层共用）。
 * - 顺序语义：op 依次应用，后面的 op 看到前面 op 的结果（ruleRef 按**当前**树解析）；
 * - revise 保留原 priority（blame 键稳定），缺省的 when/then/reason 沿用原值；
 * - add 以半分 priority 插入，不重排既有规则；
 * - layer 缺省 = 旧单树格式（verdicts 无层前缀）；提供时 verdicts 带层前缀
 *   （add 合成 ref 形如 `add:general:global:12.5` / `add:single:hongniu:global:12.5`，
 *   set_fallback 为 `general:fallback` / `single:<label>:fallback`）。
 */
function applyOneOp(
  out: GamePlanV1,
  op: PlanPatchOp,
  layer: PatchLayerSpec | undefined,
  verdicts: PatchVerdict[],
): { ok: true } | { ok: false; errors: string[] } {
  if (op.op === "set_fallback") {
    out.fallback = { policy: op.policy as PlanFallbackPolicyKind }
    verdicts.push({
      ruleRef: layer === undefined ? "fallback" : `${layerKeyOf(layer)}:fallback`,
      verdict: "revise",
      justification: `（patch:set_fallback${layer ? ` @${layerKeyOf(layer)}` : ""}）${op.reason}`,
      falsifiableClaim: op.falsifiableClaim,
      source: "patch",
    })
    return { ok: true }
  }
  if (op.op === "add") {
    const scopeName = op.scope ?? "global"
    const phaseObj = scopeName === "global" ? undefined : out.phases.find((p) => p.phaseId === scopeName)!
    const chain: DecisionRuleV1[] = scopeName === "global" ? out.rules : (phaseObj!.rules ??= [])
    const pos = insertionPriority(chain, op.position ?? "end", scopeName, layer)
    if ("error" in pos) {
      // 预检已覆盖大部分情况；位置引用被同命令先前的 op 删除时走到这里
      return { ok: false, errors: [`add 定位失败：${pos.error}（同命令先前的 op 可能已改变规则链）`] }
    }
    const rule: DecisionRuleV1 = { priority: pos.priority, then: op.then, reason: op.reason }
    if (op.when !== undefined) rule.when = op.when
    upsertRule(chain, rule)
    verdicts.push({
      ruleRef: `add:${layer === undefined ? "" : `${layerKeyOf(layer)}:`}${scopeName}:${pos.priority}`,
      verdict: "revise",
      justification: `（patch:add @${ruleRefOf(scopeName, pos.priority, layer)}${pos.anchor ? `，锚点 ${pos.anchor}` : ""}）${op.reason}`,
      falsifiableClaim: op.falsifiableClaim,
      source: "patch",
    })
    return { ok: true }
  }
  const ref = parseRuleRef(op.ruleRef)!
  const scope = ref.scope === "global" ? "global" : ref.phaseId
  if (op.op === "remove") {
    if (scope === "global") out.rules = out.rules.filter((r) => r.priority !== ref.priority)
    else {
      const phase = out.phases.find((p) => p.phaseId === scope)!
      phase.rules = (phase.rules ?? []).filter((r) => r.priority !== ref.priority)
    }
    verdicts.push({ ruleRef: op.ruleRef, verdict: "remove", justification: `（patch）${op.reason}`, falsifiableClaim: op.falsifiableClaim, source: "patch" })
    return { ok: true }
  }
  if (op.op === "revise") {
    const chain = scope === "global" ? out.rules : out.phases.find((p) => p.phaseId === scope)!.rules ?? []
    const rule = chain.find((r) => r.priority === ref.priority)
    if (!rule) return { ok: false, errors: [`revise 定位失败：${op.ruleRef} 在合并过程中消失（同命令先前的 op 可能已删除它）`] }
    if (op.when !== undefined) rule.when = op.when
    if (op.then !== undefined) rule.then = op.then
    if (op.reason) rule.reason = op.reason
    verdicts.push({ ruleRef: op.ruleRef, verdict: "revise", justification: `（patch）${op.reason}`, falsifiableClaim: op.falsifiableClaim, source: "patch" })
    return { ok: true }
  }
  // remove 分支已在上面 return（类型穷尽保护）
  const _never: never = op
  void _never
  return { ok: false, errors: [`无法应用的 op 类型：${String((op as { op: string }).op)}`] }
}

/**
 * 单树目标：在当前决策树上按序应用 patch ops（全量重写式反思的替代路径）。
 *
 * - 全或无：任一 op 校验失败 → 整条命令拒绝（不部分应用）；
 * - 顺序语义：op 依次应用，后面的 op 看到前面 op 的结果（ruleRef 按**当前**树解析）；
 * - revise 保留原 priority（blame 键稳定），缺省的 when/then/reason 沿用原值；
 * - add 以半分 priority 插入，不重排既有规则；
 * - `context` 等系统字段不在 op 可表达范围内（parsePlanPatchCommand 已拦截未知键）；
 * - 层语义只存在于 portfolio 目标：单树目标下带层前缀的 ruleRef 与 add/set_fallback
 *   的 layer 键一律报错（旧合法输入行为零变化）。
 */
function applyPlanPatchSingle(
  currentPlan: GamePlanV1,
  cmd: PlanPatchCommand,
): PlanPatchApplyResult {
  // 预检：全部 ruleRef 必须存在于当前树（封闭集合，硬错误）
  const errors: string[] = []
  const seen = new Set<string>()
  for (const [i, op] of cmd.ops.entries()) {
    if (op.op === "add" || op.op === "set_fallback") {
      if (op.layer !== undefined) {
        errors.push(`ops[${i}]：单树目标不接受 layer 键（${op.layer}）——层语义只存在于 portfolio 目标`)
        continue
      }
    }
    const ref = "ruleRef" in op ? parseRuleRef(op.ruleRef) : null
    if (("ruleRef" in op) && !ref) {
      errors.push(`ops[${i}].ruleRef 非法：${String((op as { ruleRef: unknown }).ruleRef)}`)
      continue
    }
    if (ref) {
      if (ref.layer !== undefined) {
        errors.push(`ops[${i}]：单树目标不接受层前缀 ruleRef（${String((op as { ruleRef: unknown }).ruleRef)}）——层语义只存在于 portfolio 目标`)
        continue
      }
      const chain = rulesOfScope(currentPlan, ref.scope === "global" ? "global" : ref.phaseId!)
      const exists = chain.some((r) => r.priority === ref.priority)
      const key = `${ref.scope}:${ref.priority}`
      const ruleRef = (op as { ruleRef: string }).ruleRef
      if (!exists) errors.push(`ops[${i}]：ruleRef ${ruleRef} 在当前树中不存在（封闭集合；可用值见上轮反馈）`)
      else if (seen.has(key)) errors.push(`ops[${i}]：ruleRef ${ruleRef} 在同一命令中重复操作`)
      else seen.add(key)
    }
    if (op.op === "add") {
      const scope = op.scope ?? "global"
      if (scope !== "global" && !currentPlan.phases?.some((p) => p.phaseId === scope)) {
        errors.push(`ops[${i}]：add.scope "${scope}" 不是已存在的 phaseId`)
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const out = structuredClone(currentPlan)
  out.rules = out.rules ?? []
  out.phases = out.phases ?? []
  const verdicts: PatchVerdict[] = []
  for (const op of cmd.ops) {
    const r = applyOneOp(out, op, undefined, verdicts)
    if (!r.ok) return { ok: false, errors: r.errors }
  }
  return { ok: true, plan: out, appliedOps: cmd.ops, verdicts }
}

/**
 * portfolio 目标：按层定位、逐层合并 patch ops（G5-3 定稿契约，见文件头）。
 *
 * - 每个 op 先定位层：revise/remove 的 ruleRef 必须带层前缀
 *   （`general:…` / `single:<label>:…`，无前缀 → 报错）；add / set_fallback
 *   必须带 layer 键（缺省 → 报错）。层定位先于 scope/position。
 * - 层内封闭集合：revise/remove 的键必须存在于该层树（collectRuleKeys 按层展开，
 *   opening 依旧不可 patch）；add.scope 必须是该层已存在的 phaseId；position 引用
 *   若带层前缀必须与 add.layer 一致（无前缀视为层内引用）。
 * - 全或无：任一 op 校验失败 → 整条命令拒绝（不部分应用）。
 * - 被触及的每层树收尾：normalizePlanNumericFields + parentPlanId = 该层旧 planId
 *   + computePlanId（沿用现有 finalize 逻辑逐层走同一遍；auto-repair/上下文接管
 *   属调用方职责，本模块不做）。未触及的层树原样保留。
 * - verdicts 引用带层前缀的键。
 */
function applyPlanPatchPortfolio(
  target: PatchPlanTarget,
  cmd: PlanPatchCommand,
): PlanPatchPortfolioApplyResult {
  const singlesByLabel = new Map(target.singles.map((s) => [s.label, s]))
  const layerPlanOf = (layer: PatchLayerSpec): GamePlanV1 | null =>
    layer.kind === "general" ? target.general : (singlesByLabel.get(layer.label)?.plan ?? null)

  // 预检：逐 op 定位层 + 层内封闭集合（全部通过才应用）
  const errors: string[] = []
  const seen = new Set<string>()
  const resolved: Array<{ op: PlanPatchOp; layer: PatchLayerSpec }> = []
  for (const [i, op] of cmd.ops.entries()) {
    if (op.op === "revise" || op.op === "remove") {
      const ref = parseRuleRef(op.ruleRef)
      if (!ref) {
        errors.push(`ops[${i}].ruleRef 非法：${String((op as { ruleRef: unknown }).ruleRef)}`)
        continue
      }
      if (!ref.layer) {
        errors.push(`ops[${i}]：portfolio 目标下 revise/remove 的 ruleRef 必须带层前缀（general:… / single:<label>:…），收到 ${String((op as { ruleRef: unknown }).ruleRef)}`)
        continue
      }
      const layerPlan = layerPlanOf(ref.layer)
      if (!layerPlan) {
        errors.push(`ops[${i}]：ruleRef 层不存在：${String((op as { ruleRef: unknown }).ruleRef)}（可用 general / ${target.singles.map((s) => `single:${s.label}`).join(" / ")}）`)
        continue
      }
      const chain = rulesOfScope(layerPlan, ref.scope === "global" ? "global" : ref.phaseId!)
      const exists = chain.some((r) => r.priority === ref.priority)
      const key = `${layerKeyOf(ref.layer)}:${ref.scope}:${ref.priority}`
      const ruleRef = (op as { ruleRef: string }).ruleRef
      if (!exists) errors.push(`ops[${i}]：ruleRef ${ruleRef} 在该层树中不存在（封闭集合；可用值见上轮反馈）`)
      else if (seen.has(key)) errors.push(`ops[${i}]：ruleRef ${ruleRef} 在同一命令中重复操作`)
      else seen.add(key)
      resolved.push({ op, layer: ref.layer })
      continue
    }
    if (op.op === "add" || op.op === "set_fallback") {
      const spec = parseLayerSpec(op.layer)
      if (!spec) {
        errors.push(`ops[${i}]：portfolio 目标下 ${op.op} 必须提供 layer 键（"general" 或 "single:<label>"）`)
        continue
      }
      if (!layerPlanOf(spec)) {
        errors.push(`ops[${i}]：layer 不存在：${String(op.layer)}（可用 general / ${target.singles.map((s) => `single:${s.label}`).join(" / ")}）`)
        continue
      }
      resolved.push({ op, layer: spec })
      if (op.op === "add") {
        const layerPlan = layerPlanOf(spec)!
        const scope = op.scope ?? "global"
        if (scope !== "global" && !layerPlan.phases?.some((p) => p.phaseId === scope)) {
          errors.push(`ops[${i}]：add.scope "${scope}" 不是层 ${layerKeyOf(spec)} 已存在的 phaseId`)
        }
        // position 引用若带层前缀必须与 add.layer 一致（层定位先于 position）
        if (op.position && typeof op.position === "object") {
          const posRef = "before" in op.position ? op.position.before : op.position.after
          const pre = parseRuleRef(posRef)
          if (pre?.layer && layerKeyOf(pre.layer) !== layerKeyOf(spec)) {
            errors.push(`ops[${i}]：position 引用层与 add.layer 不一致：${posRef} vs ${String(op.layer)}`)
          }
        }
      }
      continue
    }
    const _exhaustive: never = op
    void _exhaustive
  }
  if (errors.length > 0) return { ok: false, errors }

  // 应用：按层分组（保持组内 op 顺序；跨层树互不干扰），逐层走同一 finalize
  const groupByLayer = new Map<string, { layer: PatchLayerSpec; ops: PlanPatchOp[] }>()
  for (const { op, layer } of resolved) {
    const key = layerKeyOf(layer)
    const g = groupByLayer.get(key) ?? { layer, ops: [] }
    g.ops.push(op)
    groupByLayer.set(key, g)
  }
  let outGeneral = structuredClone(target.general)
  outGeneral.rules = outGeneral.rules ?? []
  outGeneral.phases = outGeneral.phases ?? []
  const outSingles = new Map(target.singles.map((s) => [s.label, { ...s, plan: structuredClone(s.plan) }]))
  for (const s of outSingles.values()) {
    s.plan.rules = s.plan.rules ?? []
    s.plan.phases = s.plan.phases ?? []
  }
  const allVerdicts: PatchVerdict[] = []
  for (const { layer, ops } of groupByLayer.values()) {
    const tree = layer.kind === "general" ? outGeneral : outSingles.get(layer.label)!.plan
    const oldPlanId = tree.planId
    const verdicts: PatchVerdict[] = []
    for (const op of ops) {
      const r = applyOneOp(tree, op, layer, verdicts)
      if (!r.ok) return { ok: false, errors: r.errors }
    }
    // finalize：normalize + parentPlanId = 该层旧 planId + computePlanId
    const normalized = normalizePlanNumericFields(tree)
    normalized.parentPlanId = oldPlanId
    normalized.planId = computePlanId(normalized)
    if (layer.kind === "general") outGeneral = normalized
    else {
      const s = outSingles.get(layer.label)!
      s.plan = normalized
    }
    allVerdicts.push(...verdicts)
  }
  return {
    ok: true,
    portfolio: { general: outGeneral, singles: [...outSingles.values()].map((s) => ({ label: s.label, plan: s.plan })) },
    appliedOps: cmd.ops,
    verdicts: allVerdicts,
  }
}

/**
 * 应用 patch ops：单树目标（`GamePlanV1`，旧行为零变化）或 portfolio 目标
 * （`PatchPlanTarget`，general + singles 分层，见 applyPlanPatchPortfolio）。
 */
export function applyPlanPatch(currentPlan: GamePlanV1, cmd: PlanPatchCommand): PlanPatchApplyResult
export function applyPlanPatch(target: PatchPlanTarget, cmd: PlanPatchCommand): PlanPatchPortfolioApplyResult
export function applyPlanPatch(
  target: GamePlanV1 | PatchPlanTarget,
  cmd: PlanPatchCommand,
): PlanPatchApplyResult | PlanPatchPortfolioApplyResult {
  return "general" in target && "singles" in target
    ? applyPlanPatchPortfolio(target, cmd)
    : applyPlanPatchSingle(target as GamePlanV1, cmd)
}

/** patch 合成 verdicts 的 ruleRef 前缀（ruleRefWarnings 的白名单）：
 *  单树格式 `add:*` / `fallback`；组合模式带层前缀 `general:fallback` /
 *  `single:<label>:fallback`（add 合成 ref 的 `add:` 前缀始终整体前置） */
export function isSyntheticPatchRef(ref: string): boolean {
  return ref.startsWith("add:") || ref === "fallback"
    || ref === "general:fallback"
    || /^single:[^:]+:fallback$/.test(ref)
}
