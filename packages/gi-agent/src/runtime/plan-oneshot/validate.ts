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
 * GamePlanV1 校验器（设计文档 §2.4）：结构 + 封闭集合 + 语义三层校验。
 * one-shot 模式下没有对局期 LLM 纠错，所有可静态发现的问题必须在此拦截。
 */

import { createHash } from "node:crypto"
import { VERSIONS, type GameData } from "@gi-tcg/core"
import type { GamePlanV1, DecisionRuleV1, WhenConditionV1 } from "./game-plan-v1.js"
import { isKnownPlanField, ELEMENT_NAMES } from "./fields.js"

export interface PlanValidationIssue {
  /** JSON 路径，如 "rules[2].when[0].field" */
  path: string
  message: string
  /** true = author CLI 可尝试自动修复（如 priority 重排）；false = 需 LLM 重写 */
  repairable: boolean
}

export interface PlanValidationResult {
  ok: boolean
  issues: PlanValidationIssue[]
  /**
   * 劝告性警告（不影响 ok）：如 opp.hand.hasCardP 引用了对手牌表外的卡
   * （运行时恒 undefined 的疑似死规则）或起草时对手牌表未知无法校验。
   */
  warnings: PlanValidationIssue[]
}

export interface PlanValidationContext {
  /** 己方牌表（分享码解码后） */
  deck: { characters: number[]; cards: number[] }
  /** 对手牌表（context.opponent.kind === "known_deck" 或 mirror 时提供） */
  opponentDeck?: { characters: number[]; cards: number[] }
  /**
   * 版本存在性校验（V1 版本钉扎）：提供该计划版本的数据后，牌表角色/卡牌
   * defId 必须在该版本数据中存在（如 .since("v6.5.0") 的卡在 v6.3.0 不存在）。
   * 规则引用的 defId 均要求在牌表内，牌表层校验后传递覆盖。
   */
  data?: GameData
}

/** when 条件中角色引用的归属上下文（语义校验用） */
interface WhenCharContext {
  selfChars: Set<number>
  /** null = 对手牌表未知，跳过对手侧引用检查 */
  oppChars: Set<number> | null
  /** 对手牌表行动牌集合（hasCardP 语义校验用）；null = 未知，给警告 */
  oppCards: Set<number> | null
}

const ACTION_CASES = new Set(["useSkill", "playCard", "switchActive", "declareEnd", "elementalTuning"])
const SKILL_TYPES = new Set(["normal_attack", "elemental_skill", "burst"])
const OPS = new Set(["<=", ">=", "==", "!=", "<", ">"])
const FALLBACK_POLICIES = new Set(["baseline", "conservative", "declare_end"])
const KEEP_ELEMENTS = new Set([...ELEMENT_NAMES, "omni"])
/** phaseId 只允许此字符集：不得含 ':'（ruleRef "phase:<id>:<priority>" 的分隔符） */
const PHASE_ID_RE = /^[A-Za-z0-9_-]+$/

function fail(path: string, message: string, repairable = false): PlanValidationIssue {
  return { path, message, repairable }
}

function validateWhen(
  when: WhenConditionV1[] | undefined,
  path: string,
  issues: PlanValidationIssue[],
  charCtx?: WhenCharContext,
  warnings?: PlanValidationIssue[],
): void {
  if (when === undefined) return
  if (!Array.isArray(when)) {
    issues.push(fail(path, "when must be an array"))
    return
  }
  when.forEach((cond, i) => {
    const p = `${path}[${i}]`
    if (typeof cond.field !== "string" || !isKnownPlanField(cond.field)) {
      issues.push(fail(`${p}.field`, `unknown field: ${String(cond.field)}`))
    }
    if (!OPS.has(cond.op)) {
      issues.push(fail(`${p}.op`, `unknown op: ${String(cond.op)}`))
    }
    if (typeof cond.value === "string" && cond.value.startsWith("$")) {
      const ref = cond.value.slice(1)
      if (!isKnownPlanField(ref)) {
        issues.push(fail(`${p}.value`, `unknown $field reference: ${ref}`))
      }
    } else if (!["number", "string", "boolean"].includes(typeof cond.value)) {
      issues.push(fail(`${p}.value`, `invalid value type: ${typeof cond.value}`))
    }
    // 角色引用语义校验：when 里引用不在牌表中的角色 = 死规则（LLM 常见幻觉）
    if (charCtx && typeof cond.field === "string") {
      const m = /^(self|opponent)\.characters\.(\d+)\./.exec(cond.field)
      if (m) {
        const defId = Number(m[2])
        const set = m[1] === "self" ? charCtx.selfChars : charCtx.oppChars
        if (set && !set.has(defId)) {
          issues.push(fail(`${p}.field`, `character ${defId} not in ${m[1]} deck (this rule can never match)`))
        }
      }
      const mActive = /^(self|opponent)\.active\.defId$/.exec(cond.field)
      if (mActive && (cond.op === "==" || cond.op === "!=")) {
        const v = typeof cond.value === "number" ? cond.value : Number(cond.value)
        if (!Number.isNaN(v)) {
          const set = mActive[1] === "self" ? charCtx.selfChars : charCtx.oppChars
          if (set && !set.has(v)) {
            issues.push(fail(`${p}.value`, `character ${v} not in ${mActive[1]} deck (this rule can never match)`))
          }
        }
      }
      // opp.hand.hasCardP.<defId> 语义校验（劝告性警告，不拒）：
      // 明牌先验字段，引用的卡应在对手牌表内；起草时对手未知则无法校验归属。
      const mHasCardP = /^opp\.hand\.hasCardP\.(\d+)$/.exec(cond.field)
      if (mHasCardP && warnings) {
        const defId = Number(mHasCardP[1])
        if (charCtx.oppCards === null) {
          warnings.push(fail(`${p}.field`, `opp.hand.hasCardP.${defId}: the opponent deck is unknown at authoring time, so ownership cannot be checked; at runtime it is evaluated against the actual opponent deck of the batch, and if the opponent does not run that card the condition is always false`))
        } else if (!charCtx.oppCards.has(defId)) {
          warnings.push(fail(`${p}.field`, `card ${defId} not in opponent deck — opp.hand.hasCardP is always undefined at runtime (condition always false), suspected dead rule`))
        }
      }
    }
  })
}

function validateRule(
  rule: DecisionRuleV1,
  path: string,
  deckCards: Set<number>,
  issues: PlanValidationIssue[],
  charCtx?: WhenCharContext,
  warnings?: PlanValidationIssue[],
): void {
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) {
    issues.push(fail(`${path}.priority`, "priority must be a finite number", true))
  }
  validateWhen(rule.when, `${path}.when`, issues, charCtx, warnings)
  const then = rule.then
  if (!then || typeof then !== "object") {
    issues.push(fail(`${path}.then`, "then is required"))
    return
  }
  if (!ACTION_CASES.has(then.action_case)) {
    issues.push(fail(`${path}.then.action_case`, `unknown action_case: ${String(then.action_case)}`))
  }
  if (then.skill_type !== undefined && !SKILL_TYPES.has(then.skill_type)) {
    issues.push(fail(`${path}.then.skill_type`, `unknown skill_type: ${String(then.skill_type)}`))
  }
  if (then.skill_type !== undefined && then.action_case !== "useSkill") {
    issues.push(fail(`${path}.then.skill_type`, "skill_type only applies to useSkill"))
  }
  if (then.skill_def_id !== undefined) {
    if (typeof then.skill_def_id !== "number" || !Number.isFinite(then.skill_def_id)) {
      issues.push(fail(`${path}.then.skill_def_id`, "skill_def_id must be a number (the #id from the deck detail)"))
    }
    if (then.action_case !== "useSkill") {
      issues.push(fail(`${path}.then.skill_def_id`, "skill_def_id only applies to useSkill"))
    }
  }
  // 数字 target = 角色 defId：必须属于对应牌表，否则规则永不命中（死规则）
  if (then.target !== undefined && typeof then.target === "number" && charCtx) {
    if (then.action_case === "switchActive") {
      if (!charCtx.selfChars.has(then.target)) {
        issues.push(fail(`${path}.then.target`, `character ${then.target} not in self deck (this rule can never match)`, true))
      }
    } else if (then.action_case === "useSkill" || then.action_case === "playCard") {
      // playCard 可能指向己方角色（装备等），useSkill 通常指向对手——并集校验
      const known = new Set([...charCtx.selfChars, ...(charCtx.oppChars ?? [])])
      if (!known.has(then.target)) {
        issues.push(fail(`${path}.then.target`, `character ${then.target} not in either deck (this rule can never match)`, true))
      }
    }
  } else if (then.target !== undefined && typeof then.target === "string"
    && then.target !== "opponent.active" && then.target !== "opponent.benched") {
    // 归一化（normalizePlanNumericFields）漏网时的防御：数字 id 写成字符串 = 运行时死规则
    // （matchTarget 对非 number 直接 return false）
    issues.push(fail(`${path}.then.target`,
      `target must be a numeric defId or opponent.active/opponent.benched, got the string "${then.target}" (do not quote numeric ids)`, true))
  }
  if (then.card_def_id !== undefined) {
    if (then.action_case !== "playCard") {
      issues.push(fail(`${path}.then.card_def_id`, "card_def_id only applies to playCard"))
    } else if (!deckCards.has(then.card_def_id)) {
      // 引用了不在牌表中的卡：规则永远不会命中，可机械移除（死规则）
      issues.push(fail(`${path}.then.card_def_id`, `card ${then.card_def_id} not in deck`, true))
    }
  }
  if (then.damage_min !== undefined && (typeof then.damage_min !== "number" || then.damage_min < 0)) {
    issues.push(fail(`${path}.then.damage_min`, "damage_min must be a non-negative number"))
  }
  if (typeof rule.reason !== "string" || rule.reason.length === 0) {
    issues.push(fail(`${path}.reason`, "reason is required (enters trace & reflection attribution)"))
  }
}

function checkPriorityUniqueness(rules: readonly DecisionRuleV1[], path: string, issues: PlanValidationIssue[]): void {
  const seen = new Map<number, number>()
  rules.forEach((r, i) => {
    const prev = seen.get(r.priority)
    if (prev !== undefined) {
      issues.push(fail(`${path}[${i}].priority`, `duplicate priority ${r.priority} (first at index ${prev})`, true))
    }
    seen.set(r.priority, i)
  })
}

export function validateGamePlan(plan: GamePlanV1, ctx: PlanValidationContext): PlanValidationResult {
  const issues: PlanValidationIssue[] = []
  const warnings: PlanValidationIssue[] = []
  const deckCards = new Set(ctx.deck.cards)
  const deckCharacters = new Set(ctx.deck.characters)
  const charCtx: WhenCharContext = {
    selfChars: deckCharacters,
    oppChars: ctx.opponentDeck ? new Set(ctx.opponentDeck.characters) : null,
    oppCards: ctx.opponentDeck ? new Set(ctx.opponentDeck.cards) : null,
  }

  if (plan.version !== "GamePlanV1") {
    issues.push(fail("version", `must be "GamePlanV1", got ${String(plan.version)}`))
  }
  for (const key of ["planId", "createdAt", "author"] as const) {
    if (typeof plan[key] !== "string" || plan[key].length === 0) {
      issues.push(fail(key, `${key} is required`))
    }
  }
  if (plan.parentPlanId !== null && typeof plan.parentPlanId !== "string") {
    issues.push(fail("parentPlanId", "must be string or null"))
  }

  // context
  const opp = plan.context?.opponent
  if (typeof plan.context?.deckCode !== "string" || plan.context.deckCode.length === 0) {
    issues.push(fail("context.deckCode", "deckCode is required"))
  }
  if (!opp || !["mirror", "known_deck", "unknown_deck"].includes(opp.kind)) {
    issues.push(fail("context.opponent.kind", `unknown opponent kind: ${String(opp?.kind)}`))
  } else if (opp.kind === "known_deck" && typeof opp.deckCode !== "string") {
    issues.push(fail("context.opponent.deckCode", "known_deck requires deckCode"))
  }
  // 版本钉扎（V1）：声明版本必须是 core 白名单内的合法版本串
  if (plan.context?.gameVersion !== undefined && !(VERSIONS as readonly string[]).includes(plan.context.gameVersion)) {
    issues.push(fail("context.gameVersion", `unknown game version: ${String(plan.context.gameVersion)} (available: ${VERSIONS.join(", ")})`))
  }
  // 版本存在性（V1）：提供版本数据后，牌表 defId 必须在该版本中存在
  // （规则引用的 defId 均要求在牌表内，此层校验传递覆盖全部规则引用）
  if (ctx.data) {
    const gvLabel = plan.context?.gameVersion ?? "(version data)"
    for (const chId of ctx.deck.characters) {
      if (!ctx.data.characters.has(chId)) {
        issues.push(fail("context.deckCode", `character ${chId} not in ${gvLabel} data (this version has no such character; the game would fail at setup)`))
      }
    }
    for (const cardId of ctx.deck.cards) {
      if (!ctx.data.entities.has(cardId)) {
        issues.push(fail("context.deckCode", `card ${cardId} not in ${gvLabel} data (this version has no such card; the game would fail at setup)`))
      }
    }
    if (ctx.opponentDeck) {
      for (const chId of ctx.opponentDeck.characters) {
        if (!ctx.data.characters.has(chId)) {
          issues.push(fail("context.opponent.deckCode", `character ${chId} not in ${gvLabel} data (this version has no such character)`))
        }
      }
      for (const cardId of ctx.opponentDeck.cards) {
        if (!ctx.data.entities.has(cardId)) {
          issues.push(fail("context.opponent.deckCode", `card ${cardId} not in ${gvLabel} data (this version has no such card)`))
        }
      }
    }
  }

  // predictions（强制，findings §10.4 修复）
  const pred = plan.predictions
  if (!pred || typeof pred !== "object") {
    issues.push(fail("predictions", "predictions is required"))
  } else {
    if (!(pred.winRateEstimate >= 0 && pred.winRateEstimate <= 1)) {
      issues.push(fail("predictions.winRateEstimate", "must be in [0, 1]"))
    }
    if (!(pred.expectedRounds > 0)) {
      issues.push(fail("predictions.expectedRounds", "must be > 0"))
    }
    if (!(pred.confidence >= 0 && pred.confidence <= 1)) {
      issues.push(fail("predictions.confidence", "must be in [0, 1]"))
    }
    if (!Array.isArray(pred.keyThreats)) {
      issues.push(fail("predictions.keyThreats", "must be an array"))
    }
  }

  // opening（LLM 可能把数组写成单个对象——先归一化再校验）
  const openingArr = <T>(v: T[] | T | undefined, path: string): T[] => {
    if (v === undefined || v === null) return []
    if (Array.isArray(v)) return v
    if (typeof v === "object") {
      issues.push(fail(path, "must be an array (treated as a single-entry object)", true))
      return [v]
    }
    issues.push(fail(path, "must be an array"))
    return []
  }
  openingArr(plan.opening?.chooseActive, "opening.chooseActive").forEach((rule, i) => {
    const p = `opening.chooseActive[${i}]`
    if (!deckCharacters.has(rule.characterDefId)) {
      issues.push(fail(`${p}.characterDefId`, `character ${rule.characterDefId} not in deck`, true))
    }
    validateWhen(rule.when, `${p}.when`, issues, charCtx, warnings)
  })
  openingArr(plan.opening?.mulligan, "opening.mulligan").forEach((rule, i) => {
    const p = `opening.mulligan[${i}]`
    if (!rule.keep && !rule.toss) {
      issues.push(fail(p, "mulligan rule needs keep or toss"))
    }
    for (const [key, sel] of Object.entries({ keep: rule.keep, toss: rule.toss })) {
      if (sel?.cardDefId !== undefined && !deckCards.has(sel.cardDefId)) {
        issues.push(fail(`${p}.${key}.cardDefId`, `card ${sel.cardDefId} not in deck`, true))
      }
    }
  })
  openingArr(plan.opening?.reroll, "opening.reroll").forEach((rule, i) => {
    const p = `opening.reroll[${i}]`
    if (!Array.isArray(rule.keepElements) || rule.keepElements.length === 0) {
      issues.push(fail(`${p}.keepElements`, "must be a non-empty array"))
    } else {
      rule.keepElements.forEach((el, j) => {
        if (!KEEP_ELEMENTS.has(el as never)) {
          issues.push(fail(`${p}.keepElements[${j}]`, `unknown element: ${el}`))
        }
      })
    }
    validateWhen(rule.when, `${p}.when`, issues, charCtx, warnings)
  })

  // phases + global rules
  const phaseIds = new Set<string>()
  if (plan.phases !== undefined && !Array.isArray(plan.phases)) {
    issues.push(fail("phases", "must be an array"))
  }
  ;(Array.isArray(plan.phases) ? plan.phases : []).forEach((phase, i) => {
    const p = `phases[${i}]`
    if (!phase.phaseId || phaseIds.has(phase.phaseId)) {
      issues.push(fail(`${p}.phaseId`, `missing or duplicate phaseId: ${String(phase.phaseId)}`))
    } else if (typeof phase.phaseId === "string" && !PHASE_ID_RE.test(phase.phaseId)) {
      issues.push(fail(`${p}.phaseId`, `phaseId only allows [A-Za-z0-9_-] (a ':' would break ruleRef parsing)`, true))
    }
    phaseIds.add(phase.phaseId)
    validateWhen(phase.when, `${p}.when`, issues, charCtx, warnings)
    phase.rules?.forEach((rule, j) => validateRule(rule, `${p}.rules[${j}]`, deckCards, issues, charCtx, warnings))
    checkPriorityUniqueness(phase.rules ?? [], `${p}.rules`, issues)
  })
  if (!Array.isArray(plan.rules)) {
    issues.push(fail("rules", "rules must be an array (possibly empty)"))
  } else {
    plan.rules.forEach((rule, i) => validateRule(rule, `rules[${i}]`, deckCards, issues, charCtx, warnings))
    checkPriorityUniqueness(plan.rules, "rules", issues)
  }
  // 空计划闸：全局 + 各阶段合计 0 条规则 = 100% fallback，不是有效决策树（修复环节
  // 曾出现 LLM 连续失败后吐空壳通过校验的情况）
  const totalRules = (Array.isArray(plan.rules) ? plan.rules.length : 0)
    + (Array.isArray(plan.phases) ? plan.phases.reduce((n, ph) => n + (ph.rules?.length ?? 0), 0) : 0)
  if (totalRules === 0) {
    issues.push(fail("rules", "plan has zero rules (100% fallback is not a valid decision tree; output substantive rules)"))
  }

  // fallback（强制）
  if (!FALLBACK_POLICIES.has(plan.fallback?.policy)) {
    issues.push(fail("fallback.policy", `unknown fallback policy: ${String(plan.fallback?.policy)}`))
  }

  return { ok: issues.length === 0, issues, warnings }
}

// ── 数值字段规范化 ─────────────────────────────────────────────────────

/**
 * LLM 常把数字 id 写成字符串（"1605"）。在加载/生成后、校验前调用，
 * 把计划中的 id/数值字段统一为 number，避免 Set<number>.has("1605") 误判。
 */
export function normalizePlanNumericFields(plan: GamePlanV1): GamePlanV1 {
  const toNum = (v: unknown): unknown =>
    typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v
  const out = structuredClone(plan)
  // LLM 可能把数组写成单个对象
  const arr = <T>(v: T[] | T | undefined): T[] | undefined =>
    v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]
  if (out.opening) {
    out.opening.chooseActive = arr(out.opening.chooseActive) ?? []
    out.opening.mulligan = arr(out.opening.mulligan) ?? []
    out.opening.reroll = arr(out.opening.reroll) ?? []
  }
  out.phases = arr(out.phases) ?? []
  out.rules = arr(out.rules) ?? []
  for (const r of out.opening?.chooseActive ?? []) {
    if (typeof r.characterDefId === "string") r.characterDefId = Number(r.characterDefId)
  }
  for (const r of out.opening?.mulligan ?? []) {
    if (r.keep?.cardDefId !== undefined) r.keep.cardDefId = Number(r.keep.cardDefId)
    if (r.toss?.cardDefId !== undefined) r.toss.cardDefId = Number(r.toss.cardDefId)
  }
  const allRules = [...(out.rules ?? []), ...(out.phases ?? []).flatMap((p) => p.rules ?? [])]
  for (const r of allRules) {
    if (typeof r.then?.card_def_id === "string") r.then.card_def_id = Number(r.then.card_def_id)
    if (typeof r.then?.target === "string") {
      // 数字 target = 角色 defId：字符串化 id 归一回数字（"1605" → 1605），
      // 否则 matchTarget 的 typeof number 检查直接 return false → 运行时死规则。
      // opponent.active / opponent.benched 等字符串哨兵保持原样（toNum 不转换）。
      r.then.target = toNum(r.then.target) as number | "opponent.active" | "opponent.benched"
    }
    for (const c of r.when ?? []) {
      if (typeof c.value === "string" && !c.value.startsWith("$")) {
        c.value = toNum(c.value) as number | string | boolean
      }
    }
  }
  for (const p of out.phases ?? []) {
    for (const c of p.when ?? []) {
      if (typeof c.value === "string" && !c.value.startsWith("$")) {
        c.value = toNum(c.value) as number | string | boolean
      }
    }
  }
  return out
}

// ── 自动修复：机械移除引用非牌表 defId 的死规则 ─────────────────────────

/**
 * 自动修复（author CLI 用）：删除引用了不在己方牌表中的 card_def_id /
 * characterDefId 的规则与 opening 条目——这些规则永远不会命中（死规则），
 * 静默移除不改变可执行语义。返回修复后的计划与被移除条目清单。
 */
export function autoRepairPlan(
  plan: GamePlanV1,
  ctx: PlanValidationContext,
): { plan: GamePlanV1; dropped: string[] } {
  const deckCards = new Set(ctx.deck.cards)
  const deckCharacters = new Set(ctx.deck.characters)
  const dropped: string[] = []
  const out = structuredClone(plan)

  const ruleAlive = (r: DecisionRuleV1): boolean => {
    if (r.then?.card_def_id !== undefined && !deckCards.has(r.then.card_def_id)) {
      dropped.push(`rule(priority=${r.priority}): card_def_id ${r.then.card_def_id} not in deck`)
      return false
    }
    return true
  }
  out.rules = (out.rules ?? []).filter(ruleAlive)
  out.phases = (out.phases ?? []).map((p) => ({ ...p, rules: (p.rules ?? []).filter(ruleAlive) }))

  if (out.opening) {
    out.opening.chooseActive = (out.opening.chooseActive ?? []).filter((r) => {
      if (!deckCharacters.has(r.characterDefId)) {
        dropped.push(`opening.chooseActive: character ${r.characterDefId} not in deck`)
        return false
      }
      return true
    })
    out.opening.mulligan = (out.opening.mulligan ?? []).filter((r) => {
      const bad = [r.keep?.cardDefId, r.toss?.cardDefId]
        .some((id) => id !== undefined && !deckCards.has(id))
      if (bad) dropped.push("opening.mulligan: entry references card not in deck")
      return !bad
    })
  }
  return { plan: out, dropped }
}

// ── planId 内容寻址 ────────────────────────────────────────────────────
/** 键排序的稳定序列化（computePlanId / computePortfolioId 共用） */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value)
}

/** 内容寻址 planId：sha256（剔除 planId/parentPlanId/createdAt）前 12 位 hex */
export function computePlanId(plan: Omit<GamePlanV1, "planId"> & { planId?: string }): string {
  const { planId: _planId, parentPlanId: _parent, createdAt: _created, ...rest } = plan
  return createHash("sha256").update(stableStringify(rest)).digest("hex").slice(0, 12)
}
