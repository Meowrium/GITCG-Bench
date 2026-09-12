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
 * GamePlanV1 的 when 字段求值：对玩家视角 state（Pb State）求值字段路径。
 * 字段白名单见设计文档 §2.2；未知字段在运行时解析为 undefined（条件恒假），
 * 校验期由 validate.ts 直接拒绝。
 */

import type { GameData } from "@gi-tcg/core"
import type { Notification } from "@gi-tcg/typings"
import type { PlanConditionOp } from "./game-plan-v1.js"
import { resolveThreatField } from "./threat.js"
import { probHoldAtLeastOne } from "./dice-prior.js"

export type PbViewState = NonNullable<Notification["state"]>
export type PbViewCharacter = PbViewState["player"][number]["character"][number]

/**
 * 稳定序列化：递归按键名排序、丢弃 undefined（与 JSON.stringify 语义一致）。
 * 签名匹配不能依赖对象键序（trace 侧 notify 对象与 eval 侧 exposeState 重建
 * 对象的键序没有任何契约保证）。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * 对齐签名：玩家视角 state 的规范化 JSON（键序稳定）。
 * 归一化 PlayerStatus（rpc 决策时刻为 ACTING=4，暂停点为 UNSPECIFIED=0），
 * 其余字段原样。oracle 回算侧用 exposeState(side, engineState) 重算匹配。
 */
export function planStateSignature(state: PbViewState): string {
  return stableStringify({
    ...state,
    player: state.player.map((p) => ({ ...p, status: 0 })),
  })
}

/** 字段求值上下文 */
export interface PlanFieldContext {
  state: PbViewState
  side: 0 | 1
  /** 当前命中阶段 id；无阶段命中时为 "none" */
  phaseId: string | null
  /** 本回合内本方已执行的 action 次数（IO 侧计数） */
  actionsTakenThisTurn: number
  gameData: GameData
  /**
   * 对手牌表（卡牌 defId → 携带张数）：**赛前明牌信息**（明牌表赛制下双方
   * 牌表公开），不是上帝视角——不跟踪对手已打出/弃置的牌，只作先验。
   * 由 batch-runner 按本局实际对手牌表注入；缺省时 opp.hand.hasCardP.* 恒 undefined。
   */
  opponentDeckCards?: ReadonlyMap<number, number>
}

/** DeckConfig.cards（每张携带卡一个条目）→ defId 携带张数表 */
export function cardCountMapOf(cards: readonly number[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const id of cards) m.set(id, (m.get(id) ?? 0) + 1)
  return m
}

export const ELEMENT_NAMES = [
  "cryo", "hydro", "pyro", "electro", "anemo", "geo", "dendro",
] as const
export type ElementName = (typeof ELEMENT_NAMES)[number]

/** DiceType 枚举值（= proto）：1..7 元素，8 万能，0 未指定 */
export const DICE_TYPE_BY_ELEMENT: Record<ElementName | "omni", number> = {
  cryo: 1, hydro: 2, pyro: 3, electro: 4, anemo: 5, geo: 6, dendro: 7, omni: 8,
}

/** 角色 definition id 的元素编码：1xyz → x（百位）= 元素（1..7） */
export function elementOfCharacterDefId(definitionId: number): ElementName | undefined {
  const digit = Math.floor((definitionId % 1000) / 100)
  return digit >= 1 && digit <= 7 ? ELEMENT_NAMES[digit - 1] : undefined
}

/** AuraType 枚举值 → 字符串（anemo/geo 不能构成附着） */
export function auraNameOf(aura: number): string {
  switch (aura) {
    case 0: return "none"
    case 1: return "cryo"
    case 2: return "hydro"
    case 3: return "pyro"
    case 4: return "electro"
    case 7: return "dendro"
    case 113: return "cryo_dendro"
    default: return `unknown_${aura}`
  }
}

// ── 字段白名单 ─────────────────────────────────────────────────────────

/** 饱腹状态 defId（core `builder/card.ts` 的 SATIATED_ID；data commons 303300，oneDuration = 仅本回合） */
const SATIATED_STATUS_DEF_ID = 303300

const STATIC_FIELDS = new Set([
  "round", "turn", "phase", "actionsTakenThisTurn",
  "self.aliveCount", "opponent.aliveCount",
  "dice.total", "dice.omni",
  "hand.count",
  "self.summons.count", "opponent.summons.count",
  "self.supports.count", "opponent.supports.count",
  // 对手可见但内容脱敏的节奏事实（io.ts exposeState：骰子牌面置 UNSPECIFIED、手牌内容隐藏）
  "self.declaredEnd", "opponent.declaredEnd",
  "opponent.dice.total", "opponent.hand.count",
  // 对手回合威胁估计（玩家视角派生量：上界/概率而非精确值，语义见 threat.ts 头注）
  "opp.threat.maxDamage", "opp.threat.lethal", "opp.threat.burstReady",
  "opp.threat.burstP", "opp.threat.maxDamageAfterSwitch", "opp.threat.lethalP",
])

const FIELD_PATTERNS: readonly RegExp[] = [
  /^(self|opponent)\.active\.(hp|energy|maxEnergy|aura|defId|element|alive|satied)$/,
  /^(self|opponent)\.characters\.\d+\.(hp|energy|maxEnergy|alive|satied|aura)$/,
  /^dice\.(cryo|hydro|pyro|electro|anemo|geo|dendro)$/,
  // 唯一合法的"加法"形态：元素+万能总数（万能骰可抵元素费的精确支付能力）
  /^dice\.(cryo|hydro|pyro|electro|anemo|geo|dendro)\+omni$/,
  /^hand\.hasCard\.\d+$/,
  /^hand\.countWithTag\.[a-z_]+$/,
  // 对手手牌估牌概率（明牌先验，dice-prior.ts 超几何；注入对手牌表时可用）
  /^opp\.hand\.hasCardP\.\d+$/,
]

export function isKnownPlanField(field: string): boolean {
  return STATIC_FIELDS.has(field) || FIELD_PATTERNS.some((p) => p.test(field))
}

// ── 字段求值 ───────────────────────────────────────────────────────────

function characterField(c: PbViewCharacter | undefined, key: string): number | string | boolean | undefined {
  if (!c) return undefined
  switch (key) {
    case "hp": return c.health
    case "energy": return c.energy
    case "maxEnergy": return c.maxEnergy
    case "aura": return auraNameOf(c.aura)
    case "defId": return c.definitionId
    case "element": return elementOfCharacterDefId(c.definitionId)
    case "alive": return !c.defeated
    case "satied": return (c.entity ?? []).some((e) => e.definitionId === SATIATED_STATUS_DEF_ID)
    default: return undefined
  }
}

/** 求值单个字段路径；未知字段或引用对象不存在时返回 undefined */
export function resolvePlanField(
  field: string,
  ctx: PlanFieldContext,
): number | string | boolean | undefined {
  const self = ctx.state.player[ctx.side]
  const opponent = ctx.state.player[ctx.side === 0 ? 1 : 0]
  if (!self || !opponent) return undefined

  if (field === "round") return ctx.state.roundNumber
  if (field === "turn") return ctx.state.currentTurn
  if (field === "phase") return ctx.phaseId ?? "none"
  if (field === "actionsTakenThisTurn") return ctx.actionsTakenThisTurn

  if (field === "self.aliveCount") return self.character.filter((c) => !c.defeated).length
  if (field === "opponent.aliveCount") return opponent.character.filter((c) => !c.defeated).length

  let m = /^(self|opponent)\.active\.(\w+)$/.exec(field)
  if (m) {
    const player = m[1] === "self" ? self : opponent
    const active = player.character.find((c) => c.id === player.activeCharacterId)
    return characterField(active, m[2])
  }

  const mChar = /^(self|opponent)\.characters\.(\d+)\.(\w+)$/.exec(field)
  if (mChar) {
    const player = mChar[1] === "self" ? self : opponent
    const targetDefId = Number(mChar[2])
    const c = player.character.find((ch) => ch.definitionId === targetDefId)
    return characterField(c, mChar[3])
  }

  if (field === "dice.total") return self.dice.length
  if (field === "dice.omni") return self.dice.filter((d) => d === DICE_TYPE_BY_ELEMENT.omni).length
  m = /^dice\.(\w+)$/.exec(field)
  if (m && (ELEMENT_NAMES as readonly string[]).includes(m[1])) {
    const dt = DICE_TYPE_BY_ELEMENT[m[1] as ElementName]
    return self.dice.filter((d) => d === dt).length
  }
  // dice.<元素>+omni：该元素骰 + 万能骰总数（万能可抵元素费）——元素费用判断的标准字段
  m = /^dice\.(\w+)\+omni$/.exec(field)
  if (m && (ELEMENT_NAMES as readonly string[]).includes(m[1])) {
    const dt = DICE_TYPE_BY_ELEMENT[m[1] as ElementName]
    return self.dice.filter((d) => d === dt || d === DICE_TYPE_BY_ELEMENT.omni).length
  }

  if (field === "hand.count") return self.handCard.length
  m = /^hand\.hasCard\.(\d+)$/.exec(field)
  if (m) {
    const defId = Number(m[1])
    return self.handCard.some((c) => c.definitionId === defId)
  }
  m = /^hand\.countWithTag\.([a-z_]+)$/.exec(field)
  if (m) {
    const tag = m[1]
    return self.handCard.filter((c) => {
      const tags = ctx.gameData.entities.get(c.definitionId)?.tags
      return tags?.some((t) => String(t).toLowerCase() === tag) ?? false
    }).length
  }

  if (field === "self.summons.count") return self.summon.length
  if (field === "opponent.summons.count") return opponent.summon.length
  if (field === "self.supports.count") return self.support.length
  if (field === "opponent.supports.count") return opponent.support.length

  // 对手节奏事实（牌面/内容在 exposeState 已脱敏，仅数量与标志可见）
  if (field === "self.declaredEnd") return self.declaredEnd ?? false
  if (field === "opponent.declaredEnd") return opponent.declaredEnd ?? false
  if (field === "opponent.dice.total") return opponent.dice.length
  if (field === "opponent.hand.count") return opponent.handCard.length

  // 对手手牌估牌概率：P(对手手牌持有 ≥1 张该卡) = 1 − C(U−k,h)/C(U,h)，
  // h = 对手手牌数，U = h + 对手牌库剩余（pileCard 长度可见、内容脱敏），
  // k = 该卡在对手牌表的携带张数（赛前明牌先验，不跟踪已打出牌 → 随对局推进偏高估）。
  m = /^opp\.hand\.hasCardP\.(\d+)$/.exec(field)
  if (m) {
    const k = ctx.opponentDeckCards?.get(Number(m[1]))
    if (k === undefined) return undefined // 对手牌表未注入或该卡不在其中
    const h = opponent.handCard.length
    const pile = (opponent.pileCard ?? []).length
    return Math.round(probHoldAtLeastOne(h + pile, h, k) * 1000) / 1000
  }

  // 对手回合威胁估计（上界/概率派生量；threat.ts）
  if (field.startsWith("opp.threat.")) {
    return resolveThreatField(field.slice("opp.threat.".length), self, opponent, ctx.gameData)
  }

  return undefined
}

// ── 条件求值 ───────────────────────────────────────────────────────────

function compare(actual: number | string | boolean, op: PlanConditionOp, expected: number | string | boolean): boolean {
  // LLM 常把数字写成字符串（"1605"）：==/!= 时若 actual 为数字且 expected 为数值字符串，做数值同化
  if ((op === "==" || op === "!=") && typeof actual === "number" && typeof expected === "string") {
    const t = expected.trim()
    if (t !== "" && !Number.isNaN(Number(t))) expected = Number(t)
  }
  // LLM 可能对布尔字段写 1/0（"alive == 1"）：做布尔同化，避免恒假死规则
  if (typeof actual === "boolean" && typeof expected === "number") {
    expected = expected !== 0
  }
  switch (op) {
    case "==": return actual === expected
    case "!=": return actual !== expected
  }
  if (typeof actual !== "number" || typeof expected !== "number") return false
  switch (op) {
    case "<=": return actual <= expected
    case ">=": return actual >= expected
    case "<": return actual < expected
    case ">": return actual > expected
  }
}

/**
 * 求值单条 when 条件。value 为 "$field.path" 时动态引用另一字段。
 * 任一侧解析失败（undefined）→ false。
 */
export function evaluateWhenCondition(
  cond: { field: string; op: PlanConditionOp; value: number | string | boolean },
  ctx: PlanFieldContext,
): boolean {
  const actual = resolvePlanField(cond.field, ctx)
  if (actual === undefined) return false
  let expected = cond.value
  if (typeof expected === "string" && expected.startsWith("$")) {
    const ref = resolvePlanField(expected.slice(1), ctx)
    if (ref === undefined) return false
    expected = ref
  }
  return compare(actual, cond.op, expected)
}

export function evaluateWhenAll(
  when: readonly { field: string; op: PlanConditionOp; value: number | string | boolean }[] | undefined,
  ctx: PlanFieldContext,
): boolean {
  if (!when || when.length === 0) return true
  return when.every((c) => evaluateWhenCondition(c, ctx))
}
