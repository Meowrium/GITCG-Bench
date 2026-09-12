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
 * author-anchor-check — 策略锚点（`--anchor` 两阶段第一阶段产物）数值断言的
 * 纯机械机检（无 I/O、无 LLM）。
 *
 * 锚点 sidecar 的 killMath / comboLines 携带数值断言（斩杀伤害、技能费用、combo
 * 前提卡牌），但引擎侧机械证据（thenMiss / fallback / coverage）结构性看不到它们：
 * 数值记错不产生任何对局信号。本模块把断言逐条对照牌表与卡面事实表校核：
 * ① killMath[].characterDefId / comboLines[].requiredCardDefIds[] 不在己方牌表
 *    → issue（前提引用牌表没有的角色/卡，典型如牌表无噬星魔鸦却写「奥兹追击」）；
 * ② costAssertion（"3雷" / "2无色+1充能"，牌表费用原样格式）与
 *    skillsOf(characterDefId) 中**同类型全变体**的卡面费用比对 → 与任一变体一致
 *    即通过，全部不一致才 issue（如纳西妲两个元素战技 17032 3草 / 17033 5草）；
 * ③ damage 与**同类型全变体**的字面量基础伤害 + 2（反应/增益余量，启发式）比对 →
 *    任一变体满足即通过，全部超出才 issue；命中变体 dynamic（.do 闭包/条件增伤）
 *    或无字面量伤害时无数值真值 → unchecked（不拦截，detail 注明 dynamic）；
 *    带非空 reactionPrereq（依赖特定反应/装备加成的总伤断言）同样降级 unchecked
 *    （不拦截，detail 注明 prereq 原文）——静态不可验证的逃生舱，见 W2 设计意图。
 * skillType / costAssertion 缺失或技能无法解析时记 unchecked（不误报）。
 *
 * 返回 issues（喂回 author 重试循环）与逐条归一化断言（落
 * `<out>.anchor-assertions.json` 旁档，reflect 按计划版本重算）。
 * 旁档另记首轮合规账（`attempts` / `firstAttemptIssues`，2026-09-09）：机检失败**不做
 * 类型转换兜底**（如 killMath.damage 非数值即 issue），而是把「模型输出纪律」变成可
 * 跨格/跨模型聚合的度量——首轮通过率与 issue 机械归类（categorizeAnchorIssue）。
 *
 * v1 边界：第三条腿「对局实测」是扩展点——kills 规则位的 perRuleHits 已隐含击杀
 * 计数，伤害实测需 state log mutation 归因（未来工作）；本模块只做静态校核。
 */

import type { CardFaceCost, CardFaceDamage, CardFaceDef, CardFaceTable } from "../card-face-table.js"

export const ANCHOR_ASSERTIONS_VERSION = "AnchorAssertionsV1"

/** 己方牌表 defId（validate 的 PlanValidationContext.deck 同形） */
export interface AnchorCheckDeck {
  characters: readonly number[]
  cards: readonly number[]
}

export type AnchorAssertionStatus = "ok" | "issue" | "unchecked"

export interface AnchorCheckIssue {
  path: string
  message: string
}

/** 机检 issue 的机械归类（首轮合规率聚合用） */
export type AnchorIssueCategory = "missing-number" | "cost-mismatch" | "damage-over-allowance" | "not-in-deck" | "other"

/** 首轮失败的 issue（path + 机械归类 + 原文），落旁档供跨格/跨模型聚合 */
export interface AnchorFirstAttemptIssue {
  path: string
  category: AnchorIssueCategory
  message: string
}

/**
 * path + message → 机械归类（纯函数）。只认机检文案里的固定措辞，不做语义推断：
 * costAssertion 相关 / "…missing or not a number" / "exceeds … base damage" /
 * "is not in the deck"（牌表存在性），其余（含无 path 的解析/形状闸失败）记 other。
 */
export function categorizeAnchorIssue(path: string, message: string): AnchorIssueCategory {
  const text = `${path} ${message}`
  if (text.includes("costAssertion")) return "cost-mismatch"
  if (text.includes("missing or not a number")) return "missing-number"
  if (/exceeds .*base damage/.test(text)) return "damage-over-allowance"
  if (text.includes("is not in the deck")) return "not-in-deck"
  return "other"
}

export interface AnchorKillMathAssertion {
  index: number
  characterDefId: number | null
  source: string | null
  damage: number | null
  skillType: string | null
  costAssertion: string | null
  reactionPrereq: string | null
  status: AnchorAssertionStatus
  detail: string
}

export interface AnchorComboLineAssertion {
  index: number
  name: string
  earliestRound: number | null
  requiredCardDefIds: number[]
  diceNeeded: string | null
  status: AnchorAssertionStatus
  detail: string
}

export interface AnchorCheckResult {
  issues: AnchorCheckIssue[]
  killMath: AnchorKillMathAssertion[]
  comboLines: AnchorComboLineAssertion[]
  unchecked: string[]
}

export interface AnchorAssertionsSidecar {
  version: typeof ANCHOR_ASSERTIONS_VERSION
  /** 仅 `--game-version` 显式钉版本时写入（与 context.gameVersion 契约同口径） */
  gameVersion?: string
  deckCode: string
  killMath: AnchorKillMathAssertion[]
  comboLines: AnchorComboLineAssertion[]
  unchecked: string[]
  /**
   * 锚点阶段总尝试次数（首轮即过 = 1）。增量字段：旧旁档无此键（聚合侧按 n/a 处理）。
   */
  attempts?: number
  /** 首轮失败的 issue 列表（首轮即过为空数组）。增量字段：旧旁档无此键。 */
  firstAttemptIssues?: AnchorFirstAttemptIssue[]
  checkedAt: string
}

/**
 * 合法 skillType：计划侧三值（normal_attack|elemental_skill|burst）为主，兼容旧锚点
 * 的两值写法（normal|elemental；旧旁档仍会被 reflect 重算）。
 */
const SKILL_TYPES = new Set(["normal_attack", "elemental_skill", "burst", "normal", "elemental"])

/** skillType → card-face-table 的源码 `.type(...)` 短名 */
const SOURCE_SKILL_TYPE: Record<string, string> = {
  normal_attack: "normal",
  elemental_skill: "elemental",
  burst: "burst",
  normal: "normal",
  elemental: "elemental",
}

const ELEMENT_BY_LABEL: Record<string, string> = {
  冰: "cryo", 水: "hydro", 火: "pyro", 雷: "electro", 风: "anemo", 岩: "geo", 草: "dendro",
  无色: "void", 同色: "same", 万能: "omni", 充能: "energy", 特殊能量: "energy", 秘传: "legend",
  cryo: "cryo", hydro: "hydro", pyro: "pyro", electro: "electro", anemo: "anemo",
  geo: "geo", dendro: "dendro", void: "void", same: "same", omni: "omni",
  energy: "energy", legend: "legend",
}

const ELEMENT_LABELS: Record<string, string> = {
  cryo: "冰", hydro: "水", pyro: "火", electro: "雷", anemo: "风", geo: "岩", dendro: "草",
  void: "无色", same: "同色", omni: "万能",
}

/** 万能/无色/同色骰互通，构成「任意色」桶（覆盖判定用） */
const FLEXIBLE_ELEMENTS = new Set(["void", "same", "omni"])

/** 归一化后的费用画像：元素骰按元素计数，充能/秘传单列，骰子总数不含充能/秘传 */
export interface AnchorCostProfile {
  byElement: Map<string, number>
  energy: number
  legend: number
  diceTotal: number
  /** 展示文本（与牌表费用同格式，如 "3雷+2充能"） */
  text: string
}

function profileText(byElement: ReadonlyMap<string, number>, energy: number, legend: number): string {
  const parts: string[] = []
  for (const [element, count] of byElement) parts.push(`${count}${ELEMENT_LABELS[element] ?? element}`)
  if (energy > 0) parts.push(`${energy}充能`)
  if (legend > 0) parts.push(`${legend}秘传`)
  return parts.length > 0 ? parts.join("+") : "0费"
}

function profileOfCosts(costs: readonly CardFaceCost[]): AnchorCostProfile {
  const byElement = new Map<string, number>()
  let energy = 0
  let legend = 0
  for (const c of costs) {
    if (c.element === "energy") energy += c.count
    else if (c.element === "legend") legend += c.count
    else byElement.set(c.element, (byElement.get(c.element) ?? 0) + c.count)
  }
  const diceTotal = [...byElement.values()].reduce((s, n) => s + n, 0)
  return { byElement, energy, legend, diceTotal, text: profileText(byElement, energy, legend) }
}

/**
 * 解析人类形态费用断言（牌表费用原样格式：数字 + 元素标签，多项用 + 连接）。
 * 标签接受中文（雷/无色/同色/万能/充能/特殊能量/秘传）与英文元素名；分隔符容忍
 * 全角 ＋ 与顿号/逗号/分号。任一项无法解析 → 整串返回 null（调用方报格式 issue）。
 */
export function parseCostAssertion(raw: string): AnchorCostProfile | null {
  const normalized = raw.replace(/＋/g, "+").replace(/[，,、;；]/g, "+").replace(/\s+/g, "")
  if (normalized === "") return null
  // 零费形态（牌表 formatCost 的空费用展示即 "0费"）
  if (normalized === "0费" || normalized === "0") {
    return { byElement: new Map(), energy: 0, legend: 0, diceTotal: 0, text: "0费" }
  }
  const byElement = new Map<string, number>()
  let energy = 0
  let legend = 0
  for (const term of normalized.split("+")) {
    const m = /^(\d+)(.+)$/.exec(term)
    if (!m) return null
    const count = Number(m[1])
    if (!Number.isInteger(count) || count <= 0) return null
    const element = ELEMENT_BY_LABEL[m[2]]
    if (element === undefined) return null
    if (element === "energy") energy += count
    else if (element === "legend") legend += count
    else byElement.set(element, (byElement.get(element) ?? 0) + count)
  }
  const diceTotal = [...byElement.values()].reduce((s, n) => s + n, 0)
  return { byElement, energy, legend, diceTotal, text: profileText(byElement, energy, legend) }
}

function flexTotal(byElement: ReadonlyMap<string, number>): number {
  let n = 0
  for (const [element, count] of byElement) if (FLEXIBLE_ELEMENTS.has(element)) n += count
  return n
}

/**
 * 费用画像比对：骰子总数 / 充能 / 秘传必须相等；元素构成按「覆盖」判定——
 * 断言的某元素骰 + 断言侧万能/无色/同色 ≥ 卡面该元素要求，且断言该元素骰
 * ≤ 卡面该元素 + 卡面侧万能/无色/同色（两侧都有余量时不做元素级断言，避免把
 * 等价写法（3雷 ≈ 2雷+1无色）误判为不一致）。
 */
function compareCostProfiles(assertion: AnchorCostProfile, face: AnchorCostProfile): string[] {
  const diffs: string[] = []
  if (assertion.diceTotal !== face.diceTotal) diffs.push(`dice total ${assertion.diceTotal} ≠ card-face ${face.diceTotal}`)
  if (assertion.energy !== face.energy) diffs.push(`energy cost ${assertion.energy} ≠ card-face ${face.energy}`)
  if (assertion.legend !== face.legend) diffs.push(`legend cost ${assertion.legend} ≠ card-face ${face.legend}`)
  const aFlex = flexTotal(assertion.byElement)
  const fFlex = flexTotal(face.byElement)
  // 骰子总数已不一致时不再做元素级判断（总数差已覆盖，避免重复噪声）
  if (assertion.diceTotal !== face.diceTotal) return diffs
  const elements = new Set([...assertion.byElement.keys(), ...face.byElement.keys()])
  for (const element of elements) {
    if (FLEXIBLE_ELEMENTS.has(element)) continue
    const a = assertion.byElement.get(element) ?? 0
    const f = face.byElement.get(element) ?? 0
    if (a + aFlex < f) {
      diffs.push(`${element} dice insufficient: assertion ${a} (+${aFlex} omni/void/same) < card-face requirement ${f}`)
    } else if (a > f + fFlex) {
      diffs.push(`${element} dice excessive: assertion ${a} > card-face ${f} (+${fFlex} omni/void/same)`)
    }
  }
  return diffs
}

function numberOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v)
  return null
}

function strOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

function idList(ids: readonly number[], limit = 8): string {
  const unique = [...new Set(ids)]
  const shown = unique.slice(0, limit).join(", ")
  return unique.length > limit ? `${shown}…` : shown
}

/**
 * 费用断言 × 同类型全变体：任一变体费用一致即通过（返回 null）；全部不一致返回
 * issue 文案——单变体保留逐项 diff，多变体列出各变体费用（skill defId 定位）。
 */
function costMismatchMessage(
  costAssertion: string,
  parsed: AnchorCostProfile,
  variants: readonly CardFaceDef[],
  skillType: string,
): string | null {
  const scored = variants.map((v) => {
    const profile = profileOfCosts(v.costs)
    return { v, profile, diffs: compareCostProfiles(parsed, profile) }
  })
  if (scored.some((s) => s.diffs.length === 0)) return null
  if (scored.length === 1) {
    return `costAssertion "${costAssertion}" does not match the card-face cost "${scored[0].profile.text}": ${scored[0].diffs.join("; ")}`
  }
  const listed = scored.map((s) => `${s.profile.text} (skill ${s.v.defId})`).join(" / ")
  return `costAssertion "${costAssertion}" does not match any card-face cost of this ${skillType} skill (card-face costs: ${listed})`
}

/** 伤害断言超过全部字面量变体的 base + 2 时的 issue 文案（单变体保留旧措辞） */
function damageMismatchMessage(
  damage: number,
  literal: ReadonlyArray<{ v: CardFaceDef; base: CardFaceDamage }>,
  skillType: string,
): string {
  const tail = "— if it relies on a specific reaction/equipment bonus, state that in reactionPrereq; otherwise double-check the damage number (heuristic)"
  if (literal.length === 1) {
    return `damage=${damage} exceeds the skill's base damage ${literal[0].base.value} + 2 (reaction/buff allowance) ${tail}`
  }
  const listed = literal.map((x) => `${x.base.value} (skill ${x.v.defId})`).join(" / ")
  return `damage=${damage} exceeds the base damage + 2 of every literal variant of this ${skillType} skill (card-face bases: ${listed}) ${tail}`
}

function killMathEntry(
  raw: unknown,
  index: number,
  deck: AnchorCheckDeck,
  charSet: ReadonlySet<number>,
  table: CardFaceTable,
): { entry: AnchorKillMathAssertion; issues: AnchorCheckIssue[]; unchecked: string[] } {
  const e = (raw ?? {}) as Record<string, unknown>
  const characterDefId = numberOf(e.characterDefId)
  const damage = numberOf(e.damage)
  const skillType = strOf(e.skillType)?.toLowerCase() ?? null
  /** 非空别名：issue 文案里用（变体命中路径下 skillType 必非空，TS 无法跨分支收窄） */
  const skillTypeLabel = skillType ?? "unknown"
  const costAssertion = strOf(e.costAssertion)
  const reactionPrereq = strOf(e.reactionPrereq)
  const rel: AnchorCheckIssue[] = []
  const relUnchecked: string[] = []

  if (characterDefId === null || !Number.isInteger(characterDefId)) {
    rel.push({ path: "characterDefId", message: "characterDefId is missing or not a number" })
  } else if (!charSet.has(characterDefId)) {
    rel.push({
      path: "characterDefId",
      message: `character ${characterDefId} is not in the deck's characters (deck characters: ${idList(deck.characters)}) — the anchor premise references a character the deck does not have`,
    })
  }

  // 技能定位：同类型可能有多个变体（如纳西妲两个元素战技 17032 3草 / 17033 5草）
  let variants: CardFaceDef[] = []
  if (skillType === null) {
    relUnchecked.push("no skillType provided (normal_attack|elemental_skill|burst); skill cost and base damage unchecked")
  } else if (!SKILL_TYPES.has(skillType)) {
    rel.push({ path: "skillType", message: `skillType "${skillType}" is invalid (allowed: normal_attack|elemental_skill|burst)` })
  } else if (characterDefId !== null && charSet.has(characterDefId)) {
    const mapped = SOURCE_SKILL_TYPE[skillType] ?? skillType
    variants = table.skillsOf(characterDefId).filter((d) => d.skillType === mapped)
    if (variants.length === 0) {
      relUnchecked.push(`character ${characterDefId}'s ${skillType} skill cannot be resolved in the card-face table; cost/damage unchecked`)
    }
  }

  let costChecked = false
  let damageChecked = false

  if (costAssertion !== null) {
    const parsed = parseCostAssertion(costAssertion)
    if (parsed === null) {
      rel.push({
        path: "costAssertion",
        message: `costAssertion "${costAssertion}" cannot be parsed — copy the deck-detail cost verbatim (number + element, e.g. "3雷" / "2无色+1充能", terms joined with +)`,
      })
    } else if (variants.length === 0) {
      relUnchecked.push(`skill not resolved; costAssertion "${costAssertion}" unchecked`)
    } else {
      costChecked = true
      const mismatch = costMismatchMessage(costAssertion, parsed, variants, skillTypeLabel)
      if (mismatch !== null) rel.push({ path: "costAssertion", message: mismatch })
    }
  } else if (variants.length > 0) {
    relUnchecked.push("no costAssertion provided; skill cost unchecked")
  }

  if (damage === null) {
    rel.push({ path: "damage", message: "damage is missing or not a number" })
  } else if (variants.length === 0) {
    if (skillType !== null) relUnchecked.push(`skill not resolved; damage=${damage} unchecked`)
  } else {
    const evaluated = variants.map((v) => ({ v, base: table.baseDamageOf(v.defId) }))
    const literal = evaluated.filter((x): x is { v: CardFaceDef; base: CardFaceDamage } => x.base !== undefined)
    if (literal.some((x) => damage <= x.base.value + 2)) {
      damageChecked = true
    } else {
      // 无字面量真值（dynamic / 无伤害条目）或带 reactionPrereq 的加成总伤 → 不拦截，降级 unchecked
      const dynamicVariant = evaluated.find((x) => x.v.dynamic)
      const noBaseVariant = evaluated.find((x) => x.base === undefined && !x.v.dynamic)
      if (reactionPrereq !== null) {
        // 设计意图（reflect-evidence-gap W2）：依赖特定反应/装备加成的总伤静态不可验证，
        // 模型在 reactionPrereq 说明即放行（不报 issue，记 unchecked）
        relUnchecked.push(`asserted with reactionPrereq (${reactionPrereq}); boosted total not statically verifiable`)
      } else if (dynamicVariant !== undefined) {
        relUnchecked.push(`skill ${dynamicVariant.v.defId} damage is dynamic (.do closure / conditional bonus), no literal ground truth; damage=${damage} unchecked`)
      } else if (noBaseVariant !== undefined) {
        relUnchecked.push(`skill ${noBaseVariant.v.defId} has no literal base damage; damage=${damage} unchecked`)
      } else {
        damageChecked = true
        rel.push({ path: "damage", message: damageMismatchMessage(damage, literal, skillTypeLabel) })
      }
    }
  }

  const status: AnchorAssertionStatus = rel.length > 0 ? "issue" : costChecked || damageChecked ? "ok" : "unchecked"
  return {
    entry: {
      index,
      characterDefId: characterDefId !== null && Number.isInteger(characterDefId) ? characterDefId : null,
      source: strOf(e.source),
      damage,
      skillType,
      costAssertion,
      reactionPrereq,
      status,
      detail: [...rel.map((r) => r.message), ...relUnchecked].join("; "),
    },
    issues: rel.map((r) => ({ path: `killMath[${index}].${r.path}`, message: r.message })),
    unchecked: relUnchecked.map((u) => `killMath[${index}]: ${u}`),
  }
}

function comboLineEntry(
  raw: unknown,
  index: number,
  deck: AnchorCheckDeck,
  cardSet: ReadonlySet<number>,
): { entry: AnchorComboLineAssertion; issues: AnchorCheckIssue[]; unchecked: string[] } {
  const e = (raw ?? {}) as Record<string, unknown>
  const name = strOf(e.name) ?? `#${index}`
  const earliestRound = numberOf(e.earliestRound)
  const diceNeeded = strOf(e.diceNeeded)
  const required = e.requiredCardDefIds
  const rel: AnchorCheckIssue[] = []
  const relUnchecked: string[] = []
  const ids: number[] = []
  if (required === undefined) {
    relUnchecked.push("no requiredCardDefIds provided; combo prerequisite cards unchecked")
  } else if (!Array.isArray(required)) {
    rel.push({ path: "requiredCardDefIds", message: "requiredCardDefIds is not an array" })
  } else {
    required.forEach((v, j) => {
      const id = numberOf(v)
      if (id === null || !Number.isInteger(id)) {
        rel.push({ path: `requiredCardDefIds[${j}]`, message: `requiredCardDefIds[${j}] is not a numeric defId` })
        return
      }
      ids.push(id)
      if (!cardSet.has(id) && !deck.characters.includes(id)) {
        rel.push({
          path: `requiredCardDefIds[${j}]`,
          message: `defId ${id} is not in the deck (deck cards: ${idList(deck.cards)}) — the combo premise references a card the deck does not have; if it is a skill-generated summon/status, rewrite it as the skill name or drop the premise`,
        })
      }
    })
  }
  const status: AnchorAssertionStatus = rel.length > 0 ? "issue" : required === undefined ? "unchecked" : "ok"
  return {
    entry: { index, name, earliestRound, requiredCardDefIds: ids, diceNeeded, status, detail: [...rel.map((r) => r.message), ...relUnchecked].join("; ") },
    issues: rel.map((r) => ({ path: `comboLines[${index}].${r.path}`, message: r.message })),
    unchecked: relUnchecked.map((u) => `comboLines[${index}]: ${u}`),
  }
}

/** 锚点 JSON（或已归一化的旁档）→ 逐条校核结果（纯函数，无 I/O） */
export function checkAnchorAssertions(anchor: unknown, deck: AnchorCheckDeck, table: CardFaceTable): AnchorCheckResult {
  const root = (anchor !== null && typeof anchor === "object" ? anchor : {}) as Record<string, unknown>
  const issues: AnchorCheckIssue[] = []
  const unchecked: string[] = []
  const charSet = new Set(deck.characters)
  const cardSet = new Set(deck.cards)

  const killMathRaw = root.killMath
  const killMath: AnchorKillMathAssertion[] = []
  if (!Array.isArray(killMathRaw)) {
    issues.push({ path: "killMath", message: "killMath is not an array — the anchor must provide a killMath list" })
  } else {
    killMathRaw.forEach((item, i) => {
      const r = killMathEntry(item, i, deck, charSet, table)
      killMath.push(r.entry)
      issues.push(...r.issues)
      unchecked.push(...r.unchecked)
    })
  }

  const comboRaw = root.comboLines
  const comboLines: AnchorComboLineAssertion[] = []
  if (comboRaw !== undefined) {
    if (!Array.isArray(comboRaw)) {
      issues.push({ path: "comboLines", message: "comboLines is not an array" })
    } else {
      comboRaw.forEach((item, i) => {
        const r = comboLineEntry(item, i, deck, cardSet)
        comboLines.push(r.entry)
        issues.push(...r.issues)
        unchecked.push(...r.unchecked)
      })
    }
  }

  if (table.size === 0) {
    unchecked.push("the card-face table is empty (@gi-tcg/data source unreadable) — all skill costs/base damage unchecked")
  }
  return { issues, killMath, comboLines, unchecked }
}

/**
 * 校核结果 → 落盘旁档（`<out>.anchor-assertions.json`）。
 * `attempts` 缺省 1、`firstAttemptIssues` 缺省空数组（首轮即过形态）；两者为新增量字段，
 * 旧旁档不含它们，读取侧按缺省/n-a 处理。
 */
export function buildAnchorAssertionsSidecar(args: {
  check: AnchorCheckResult
  deckCode: string
  gameVersion?: string
  attempts?: number
  firstAttemptIssues?: readonly AnchorCheckIssue[]
  checkedAt?: string
}): AnchorAssertionsSidecar {
  return {
    version: ANCHOR_ASSERTIONS_VERSION,
    ...(args.gameVersion !== undefined ? { gameVersion: args.gameVersion } : {}),
    deckCode: args.deckCode,
    killMath: args.check.killMath,
    comboLines: args.check.comboLines,
    unchecked: args.check.unchecked,
    attempts: args.attempts ?? 1,
    firstAttemptIssues: (args.firstAttemptIssues ?? []).map((i) => ({
      path: i.path,
      category: categorizeAnchorIssue(i.path, i.message),
      message: i.message,
    })),
    checkedAt: args.checkedAt ?? new Date().toISOString(),
  }
}
