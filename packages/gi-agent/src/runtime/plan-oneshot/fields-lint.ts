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
 * fields-lint — GamePlanV1 规则链的静态 lint（warnings，不阻断校验）。
 *
 * 封闭字段集合使大量链级问题可静态发现；这里只做无假阳性的保守检查：
 * ① 链内条件包含关系（早位规则遮蔽晚位规则——后者仅在早位 thenMiss 后可达）；
 * ② 同链 when 完全重复；
 * ③ 单规则 when 内同字段条件矛盾（== 冲突 / 数值区间为空）；
 * ④ 卡面数值校核（2026-09-08，需 ctx：骰子闸 vs 费用、HP 阈值 vs 上限、
 *    damage_min vs 字面量基础伤害）——纯机械比对，真值**全部来自
 *    card-face-table 的 @gi-tcg/data 源码静态扫描**（费用/HP/基础伤害同源，
 *    含 `.since`/`.until` 版本变体），零网络、零资产接口。
 *    useSkill 的技能持有者从 when 的 `self.active.defId ==` 推导（数字 target
 *    是对手侧伤害目标，见 action-match.ts），推不出即跳过该项校核；技能按
 *    同类型**全变体最宽松匹配**（如纳西妲两个元素战技 17032 3草 / 17033 5草：
 *    闸能支付任一变体即不报，伤害任一字面量变体满足即不报，dynamic 变体跳过）；
 *    then 带 `skill_def_id` 时改用**精确变体**（该技能自己的费用/基础伤害），并做
 *    存在性校核（必须属于己方任一角色的技能，需 ctx.deck）。
 * 全部为 finding 级提示，不影响 validateGamePlan 的 ok 判定；不重复 validate 的
 * 存在性检查（lint 只做数值一致性）。message 进 LLM 回注/提示，统一英文。
 */

import type { CardFaceCost, CardFaceDamage, CardFaceDef, CardFaceTable } from "./card-face-table.js"
import type { ActionSpecV1, DecisionRuleV1, GamePlanV1, WhenConditionV1 } from "./game-plan-v1.js"

export type PlanLintKind = "chain" | "contradiction" | "card-face"

export interface PlanLintFinding {
  kind: PlanLintKind
  path: string
  message: string
}

/** 卡面校核上下文；缺省（undefined）时只跑 ①②③ 三类链级检查 */
export interface PlanLintContext {
  /** @gi-tcg/data 源码事实表（费用/HP/基础伤害唯一真值源，纯本地扫描） */
  cardFace?: CardFaceTable
  /**
   * 己方牌表（可选）：用于 then.skill_def_id 的存在性校核（必须属于己方任一角色
   * 的技能）。缺省时跳过该校核（不误报）。
   */
  deck?: { characters: readonly number[] }
}

function condKey(c: WhenConditionV1): string {
  return `${c.field}|${c.op}|${String(c.value)}`
}

function condSet(when: WhenConditionV1[] | undefined): Set<string> {
  return new Set((when ?? []).map(condKey))
}

/** 数值提取：仅纯数字（$field 动态引用无法静态判定，跳过） */
function numeric(cond: WhenConditionV1): number | null {
  if (typeof cond.value === "number") return cond.value
  if (typeof cond.value === "string" && cond.value !== "" && !cond.value.startsWith("$") && !Number.isNaN(Number(cond.value))) {
    return Number(cond.value)
  }
  return null
}

/** 同字段条件组内矛盾检测；返回矛盾描述或 null */
function contradictionInGroup(conds: WhenConditionV1[]): string | null {
  const eqs = new Set<string>()
  let lo: { v: number; strict: boolean } | null = null
  let hi: { v: number; strict: boolean } | null = null
  let hasNumeric = false
  for (const c of conds) {
    const v = numeric(c)
    if (v === null) continue
    hasNumeric = true
    switch (c.op) {
      case "==": eqs.add(String(v)); break
      case "!=": break // 与区间约束不构成静态矛盾
      case "<=": hi = mergeHi(hi, { v, strict: false }); break
      case "<": hi = mergeHi(hi, { v, strict: true }); break
      case ">=": lo = mergeLo(lo, { v, strict: false }); break
      case ">": lo = mergeLo(lo, { v, strict: true }); break
    }
  }
  if (eqs.size > 1) return `multiple == values on the same field are mutually exclusive (${[...eqs].join(" vs ")})`
  if (hasNumeric && eqs.size === 1) {
    const v = Number([...eqs][0])
    if (hi && (v > hi.v || (v === hi.v && hi.strict))) return `== ${v} contradicts ${hi.strict ? "<" : "<="} ${hi.v}`
    if (lo && (v < lo.v || (v === lo.v && lo.strict))) return `== ${v} contradicts ${lo.strict ? ">" : ">="} ${lo.v}`
    return null
  }
  if (lo && hi) {
    if (lo.v > hi.v) return `empty range: > ${lo.v} and < ${hi.v}`
    if (lo.v === hi.v && (lo.strict || hi.strict)) return `empty range: ${lo.strict ? ">" : ">="} ${lo.v} and ${hi.strict ? "<" : "<="} ${hi.v}`
  }
  // 字符串/布尔的 == 互斥
  const strEqs = conds.filter((c) => c.op === "==" && numeric(c) === null && !(typeof c.value === "string" && c.value.startsWith("$")))
  const strVals = new Set(strEqs.map((c) => String(c.value)))
  if (strVals.size > 1) return `multiple == values on the same field are mutually exclusive (${[...strVals].join(" vs ")})`
  return null
}

function mergeLo(a: { v: number; strict: boolean } | null, b: { v: number; strict: boolean }): { v: number; strict: boolean } {
  if (!a) return b
  if (a.v !== b.v) return a.v > b.v ? a : b
  return { v: a.v, strict: a.strict || b.strict }
}

function mergeHi(a: { v: number; strict: boolean } | null, b: { v: number; strict: boolean }): { v: number; strict: boolean } {
  if (!a) return b
  if (a.v !== b.v) return a.v < b.v ? a : b
  return { v: a.v, strict: a.strict || b.strict }
}

interface ChainRef {
  path: string
  rules: DecisionRuleV1[]
}

function chainsOf(plan: GamePlanV1): ChainRef[] {
  const out: ChainRef[] = [{ path: "rules", rules: plan.rules ?? [] }]
  ;(plan.phases ?? []).forEach((p, i) => out.push({ path: `phases[${i}].rules`, rules: p.rules ?? [] }))
  return out
}

export function lintPlan(plan: GamePlanV1, ctx?: PlanLintContext): PlanLintFinding[] {
  const findings: PlanLintFinding[] = []
  for (const chain of chainsOf(plan)) {
    // ① 条件包含（早位遮蔽晚位）与 ② 完全重复
    const condSets = chain.rules.map((r) => condSet(r.when))
    for (let i = 0; i < chain.rules.length; i++) {
      for (let j = i + 1; j < chain.rules.length; j++) {
        const a = chain.rules[i]
        const b = chain.rules[j]
        if (condSets[i].size === 0 && condSets[j].size === 0) {
          findings.push({
            kind: "chain",
            path: `${chain.path}[${j}]`,
            message: `when is always-true for both this rule and ${chain.path}[${i}] — ${chain.path}[${j}] is only reachable after its thenMiss; confirm this fallback chain is intentional`,
          })
          continue
        }
        if (condSets[i].size > 0 && condSets[i].size === condSets[j].size && [...condSets[i]].every((k) => condSets[j].has(k))) {
          findings.push({ kind: "chain", path: `${chain.path}[${j}]`, message: `when is identical to ${chain.path}[${i}] (priority ${a.priority}; this rule has priority ${b.priority}) — only reachable after its thenMiss` })
          continue
        }
        if (condSets[i].size > 0 && [...condSets[i]].every((k) => condSets[j].has(k))) {
          findings.push({
            kind: "chain",
            path: `${chain.path}[${j}]`,
            message: `condition inclusion: when of ${chain.path}[${i}] (priority ${a.priority}) ⊆ when of this rule — this rule is only reachable after that rule's thenMiss; confirm the fallback chain is intentional`,
          })
        }
      }
    }
    // ③ 单规则 when 内矛盾
    chain.rules.forEach((r, i) => {
      const byField = new Map<string, WhenConditionV1[]>()
      for (const c of r.when ?? []) {
        byField.set(c.field, [...(byField.get(c.field) ?? []), c])
      }
      for (const [field, conds] of byField) {
        if (conds.length < 2) continue
        const msg = contradictionInGroup(conds)
        if (msg) {
          findings.push({ kind: "contradiction", path: `${chain.path}[${i}].when`, message: `field ${field}: ${msg} (this condition group is always false; the rule may be entirely unreachable)` })
        }
      }
    })
    // ④ 卡面数值校核（需 ctx；无 ctx 时整体跳过——对照臂最小干预）
    if (ctx) findings.push(...cardFaceFindings(chain, ctx))
  }
  return findings
}

// ── ④ 卡面数值校核（2026-09-08）─────────────────────────────────────────
// 纯机械比对：骰子闸 vs 费用、HP 阈值 vs 上限、damage_min vs 字面量基础伤害。
// 真值唯一来源 = card-face-table（@gi-tcg/data 源码静态扫描，零网络）。
// 不重复 validate 的存在性检查；dynamic 伤害与反应加成算术不在范围内。

interface NormalizedCosts {
  byElement: Map<string, number>
  /** 骰子总费（元素+无色+同色+万能；不含充能与秘传） */
  diceTotal: number
  /** 展示文本，如 "3雷+2充能" */
  text: string
}

const COST_ELEMENT_LABELS: Record<string, string> = {
  cryo: "冰", hydro: "水", pyro: "火", electro: "雷", anemo: "风", geo: "岩", dendro: "草",
  void: "无色", same: "同色", omni: "万能", energy: "充能", legend: "秘传",
}

/** 计划 skill_type → @gi-tcg/data 源码 `.type(...)` 短名（card-face-table.skillOfType 口径） */
const SOURCE_SKILL_TYPE_BY_PLAN_NAME: Record<string, string> = {
  normal_attack: "normal",
  elemental_skill: "elemental",
  burst: "burst",
  // 旧计划/旧锚点仍可能写两值形态（兼容）
  normal: "normal",
  elemental: "elemental",
}

function normalizeCosts(costs: readonly CardFaceCost[]): NormalizedCosts {
  const byElement = new Map<string, number>()
  let diceTotal = 0
  for (const c of costs) {
    byElement.set(c.element, (byElement.get(c.element) ?? 0) + c.count)
    if (c.element !== "energy" && c.element !== "legend") diceTotal += c.count
  }
  const text = costs.map((c) => `${c.count}${COST_ELEMENT_LABELS[c.element] ?? c.element}`).join("+")
  return { byElement, diceTotal, text: text || "0费" }
}

/** 行动牌费用：源码事实表唯一来源；空费用（0 费或无该卡）返回 null（跳过校核） */
function cardCostsOf(defId: number, ctx: PlanLintContext): NormalizedCosts | null {
  const def = ctx.cardFace?.get(defId)
  if (def && def.kind === "card" && def.costs.length > 0) return normalizeCosts(def.costs)
  return null
}

/**
 * 角色指定类型技能的**全部变体**（同类型可多个：纳西妲两个元素战技
 * 17032 3草 / 17033 5草；纯水精灵 22012 3水 / 22013 5水）。
 * skill_type 经 SOURCE_SKILL_TYPE_BY_PLAN_NAME 映射到源码 `.type(...)` 短名后
 * 查 card-face-table.skillsOf（费用与基础伤害同源，零网络）。
 */
function skillVariantsOf(charDefId: number, skillType: string, ctx: PlanLintContext): CardFaceDef[] {
  const sourceType = SOURCE_SKILL_TYPE_BY_PLAN_NAME[skillType] ?? skillType
  return (ctx.cardFace?.skillsOf(charDefId) ?? []).filter((d) => d.skillType === sourceType)
}

/** 精确技能变体（then.skill_def_id 指名；非 skill 类别或查不到返回 undefined） */
function exactSkillVariantOf(skillDefId: number, ctx: PlanLintContext): CardFaceDef | undefined {
  const def = ctx.cardFace?.get(skillDefId)
  return def?.kind === "skill" ? def : undefined
}

/** useSkill 的变体解析结果：精确指名（skill_def_id）或同类型全变体（skill_type） */
interface UseSkillFace {
  variants: CardFaceDef[]
  /** 消息主体（`skill #17033 (character 1703)` / `skill elemental_skill (character 1703)`） */
  subject: string
}

/**
 * useSkill 的变体集合：`skill_def_id` 优先（精确变体，不再最宽松展开）；否则按
 * `when` 推导持有者 + `skill_type` 取同类型全变体。都解析不出返回 null（跳过）。
 */
function useSkillFaceOf(spec: ActionSpecV1, when: readonly WhenConditionV1[] | undefined, ctx: PlanLintContext): UseSkillFace | null {
  const owner = skillOwnerOf(when)
  if (spec.skill_def_id !== undefined) {
    const def = exactSkillVariantOf(spec.skill_def_id, ctx)
    if (!def) return null
    return { variants: [def], subject: `skill #${spec.skill_def_id}${owner !== null ? ` (character ${owner})` : ""}` }
  }
  if (spec.skill_type === undefined || owner === null) return null
  return { variants: skillVariantsOf(owner, spec.skill_type, ctx), subject: `skill ${spec.skill_type} (character ${owner})` }
}

/** 有费用声明的变体费用（空费用 = 未声明费用 / prepared 变体，不参与费用腿） */
function costedVariantsOf(variants: readonly CardFaceDef[]): NormalizedCosts[] {
  return variants.filter((d) => d.costs.length > 0).map((d) => normalizeCosts(d.costs))
}

/** 角色卡面 HP 上限：源码事实表唯一来源；无该角色返回 undefined（跳过校核） */
function maxHpOf(defId: number, ctx: PlanLintContext): number | undefined {
  return ctx.cardFace?.get(defId)?.health
}

interface DiceGate {
  field: string
  /** `dice.<e>+omni` 形态的元素名 */
  element?: string
  total: boolean
  /** 满足该闸所需的最小骰数（`>` 时 +1） */
  min: number
}

function diceGatesOf(when: readonly WhenConditionV1[] | undefined): DiceGate[] {
  const out: DiceGate[] = []
  for (const c of when ?? []) {
    if (c.op !== ">=" && c.op !== ">") continue
    const v = numeric(c)
    if (v === null) continue
    const min = c.op === ">" ? v + 1 : v
    if (c.field === "dice.total") {
      out.push({ field: c.field, total: true, min })
      continue
    }
    const m = /^dice\.(cryo|hydro|pyro|electro|anemo|geo|dendro)\+omni$/.exec(c.field)
    if (m) out.push({ field: c.field, element: m[1], total: false, min })
  }
  return out
}

interface GateComparison {
  direction: "under" | "over"
  /** 触发判定的变体所需骰数 */
  need: number
  /** 触发判定的变体费用（消息文本用） */
  costs: NormalizedCosts
}

/**
 * 骰子闸 × 同类型全变体（最宽松判定，不误报优先）：闸能支付**任一**变体
 * （`min ≥ 该变体所需骰`）即不报；连最便宜的变体都付不起 → under（报最便宜变体）；
 * 连最贵的变体都被闸超出 → over（报最贵变体）。
 * 单变体时与旧 compareGate 逐分支等价。
 */
function compareGateVariants(gate: DiceGate, variants: readonly NormalizedCosts[]): GateComparison | null {
  const needs = variants.map((costs) => ({
    costs,
    need: gate.total ? costs.diceTotal : (costs.byElement.get(gate.element!) ?? 0),
  }))
  const cheapest = needs.reduce((a, b) => (b.need < a.need ? b : a))
  const priciest = needs.reduce((a, b) => (b.need > a.need ? b : a))
  if (gate.min < cheapest.need) return { direction: "under", need: cheapest.need, costs: cheapest.costs }
  if (priciest.need > 0 && gate.min > priciest.need) return { direction: "over", need: priciest.need, costs: priciest.costs }
  return null
}

function gateFinding(subject: string, gate: DiceGate, cmp: GateComparison, costs: NormalizedCosts): string {
  if (cmp.direction === "under") {
    return `${subject}: the rule's dice gate ${gate.field} requires only ${gate.min} dice, below the card cost ${costs.text} — when the dice exactly meet the gate the action is not executable (the rule's then always misses at those points); suspected cost mistake`
  }
  return `${subject}: the rule's dice gate ${gate.field} requires ${gate.min} dice, above the card cost ${costs.text} (${gate.min - cmp.need} extra) — ignore if the dice are reserved for follow-up actions, otherwise the cost may be misremembered (heuristic)`
}

function hpThresholdFinding(field: string, op: string, value: number, maxHp: number): string | null {
  const impossible = (op === ">=" && value > maxHp) || (op === ">" && value >= maxHp) || (op === "==" && value > maxHp)
  if (!impossible) return null
  return `field ${field}: condition ${op} ${value} exceeds this character's card-face HP cap ${maxHp} — unless some effect raises the HP cap, this condition is always false`
}

/**
 * useSkill 的技能持有者：数字 target 是技能伤害的**对手侧**目标（action-match.ts
 * 语义），不能当持有者用。持有者只能从 when 的 `self.active.defId ==` 条件推导；
 * 推不出（缺条件 / 非 == / 动态值）→ 返回 null，调用方跳过该校核。
 */
function skillOwnerOf(when: readonly WhenConditionV1[] | undefined): number | null {
  for (const c of when ?? []) {
    if (c.field !== "self.active.defId" || c.op !== "==") continue
    const v = numeric(c)
    if (v !== null) return v
  }
  return null
}

function checkActionCosts(spec: ActionSpecV1, when: readonly WhenConditionV1[] | undefined, path: string, ctx: PlanLintContext): PlanLintFinding[] {
  const out: PlanLintFinding[] = []
  const gates = diceGatesOf(when)
  if (gates.length === 0) return out

  if (spec.action_case === "playCard" && typeof spec.card_def_id === "number") {
    const costs = cardCostsOf(spec.card_def_id, ctx)
    if (!costs) return out
    for (const gate of gates) {
      const cmp = compareGateVariants(gate, [costs])
      if (cmp) out.push({ kind: "card-face", path, message: gateFinding(`action card ${spec.card_def_id}`, gate, cmp, cmp.costs) })
    }
    return out
  }

  if (spec.action_case === "useSkill") {
    const face = useSkillFaceOf(spec, when, ctx)
    if (face === null) return out
    const variants = costedVariantsOf(face.variants)
    if (variants.length === 0) return out
    for (const gate of gates) {
      const cmp = compareGateVariants(gate, variants)
      if (cmp) out.push({ kind: "card-face", path, message: gateFinding(face.subject, gate, cmp, cmp.costs) })
    }
  }
  return out
}

function checkHpGates(when: readonly WhenConditionV1[] | undefined, path: string, ctx: PlanLintContext): PlanLintFinding[] {
  const out: PlanLintFinding[] = []
  for (const c of when ?? []) {
    const m = /^(?:self|opponent)\.characters\.(\d+)\.hp$/.exec(c.field)
    if (!m) continue
    const value = numeric(c)
    if (value === null) continue
    const maxHp = maxHpOf(Number(m[1]), ctx)
    if (maxHp === undefined) continue
    const msg = hpThresholdFinding(c.field, c.op, value, maxHp)
    if (msg) out.push({ kind: "card-face", path, message: msg })
  }
  return out
}

function checkDamageMin(spec: ActionSpecV1, when: readonly WhenConditionV1[] | undefined, path: string, ctx: PlanLintContext): PlanLintFinding[] {
  if (spec.action_case !== "useSkill") return []
  const damageMin = spec.damage_min
  if (typeof damageMin !== "number") return []
  const face = useSkillFaceOf(spec, when, ctx)
  if (face === null) return []
  const variants = face.variants
  if (variants.length === 0) return []
  const literal = variants
    .map((def) => ({ def, base: ctx.cardFace?.baseDamageOf(def.defId) }))
    .filter((x): x is { def: CardFaceDef; base: CardFaceDamage } => x.base !== undefined)
  // 任一字面量变体满足即不报
  if (literal.some((x) => damageMin <= x.base.value + 2)) return []
  // 存在无字面量真值的变体（dynamic / 无伤害条目）→ 该腿跳过（与 anchor-check 口径一致）
  if (literal.length < variants.length) return []
  const subject = face.subject
  const tail = "heuristic hint, please double-check the damage number (ignore if it depends on a specific reaction/equipment bonus)"
  if (literal.length === 1) {
    return [{
      kind: "card-face",
      path,
      message: `${subject}: then.damage_min=${damageMin} exceeds the skill's base damage ${literal[0].base.value} + 2 (reaction/buff allowance) — ${tail}`,
    }]
  }
  const listed = literal.map((x) => `${x.base.value} (skill ${x.def.defId})`).join(" / ")
  return [{
    kind: "card-face",
    path,
    message: `${subject}: then.damage_min=${damageMin} exceeds every literal variant's base damage + 2 (card-face bases: ${listed}) — ${tail}`,
  }]
}

/**
 * then.skill_def_id 存在性校核：必须属于己方任一角色的技能（存在性归 lint——
 * validate 不做技能归属检查）。ctx.deck 缺省时跳过（不误报）。
 */
function checkSkillDefId(spec: ActionSpecV1, path: string, ctx: PlanLintContext): PlanLintFinding[] {
  const skillDefId = spec.skill_def_id
  if (skillDefId === undefined || ctx.deck === undefined) return []
  const known = new Set(
    ctx.deck.characters.flatMap((charDefId) => (ctx.cardFace?.skillsOf(charDefId) ?? []).map((s) => s.defId)),
  )
  if (known.has(skillDefId)) return []
  return [{
    kind: "card-face",
    path,
    message: `then.skill_def_id ${skillDefId} is not a skill of any character in your deck (deck characters: ${ctx.deck.characters.join(", ")}) — the rule can never match`,
  }]
}

function cardFaceFindings(chain: ChainRef, ctx: PlanLintContext): PlanLintFinding[] {
  const out: PlanLintFinding[] = []
  chain.rules.forEach((rule, i) => {
    const path = `${chain.path}[${i}]`
    out.push(...checkSkillDefId(rule.then, path, ctx))
    out.push(...checkActionCosts(rule.then, rule.when, path, ctx))
    out.push(...checkHpGates(rule.when, path, ctx))
    out.push(...checkDamageMin(rule.then, rule.when, path, ctx))
  })
  return out
}
