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
 * Ground Truth schema (v3.0 冻结版) —— 卡组级与对局级分离。
 *
 * 存储布局：
 *   data/ground-truth/{version}/decks/{safeCode}.json              卡组内秉属性 (L2)
 *   data/ground-truth/{version}/matchups/{safeA}__vs__{safeB}.json 对局响应链 (L3)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// ── 路径 ────────────────────────────────────────────────

const DATA_DIR = join(import.meta.dirname ?? __dirname, "..", "..", "data")
const GT_DIR = join(DATA_DIR, "ground-truth")
export const PROGRESS_FILE = join(DATA_DIR, ".batch-progress.json")

/** 文件名安全串：deck code 前 20 字符，非字母数字转下划线 */
export function safeCode(deckCode: string): string {
  return deckCode.slice(0, 20).replace(/[^a-zA-Z0-9]/g, "_")
}

export function deckPath(version: string, deckCode: string): string {
  return join(GT_DIR, version, "decks", `${safeCode(deckCode)}.json`)
}

export function matchupPath(version: string, myCode: string, oppCode: string): string {
  return join(GT_DIR, version, "matchups", `${safeCode(myCode)}__vs__${safeCode(oppCode)}.json`)
}

// ── 公共类型 ─────────────────────────────────────────────

export interface Abstention {
  field: string
  reason: string
}

// ── 卡组级 schema (L2) ───────────────────────────────────

export type KeyCardRole =
  | "combo_starter" | "combo_field" | "combo_bridge" | "combo_finisher" | "damage_amplifier" | "draw"
  | "sustain" | "disruption" | "ramp" | "flex_slot"

export interface KeyCard {
  id: string
  role: KeyCardRole
  importance: "core" | "important" | "flexible"
  rationale: string
  /** 留牌优先级（仅行动牌；角色不抽牌，不设此项） */
  mulligan?: "always_keep" | "high" | "situational" | "never"
  /**
   * 关键技能/被动（仅角色；精确到 skill definitionId，与模拟器寻址一致）。
   * 空/缺省 = 不限定具体技能（整张角色卡都是关键组件）
   */
  skills?: { id: string; name: string }[]
}

export type KeyCardGroup = "combo" | "damage" | "draw" | "sustain" | "disruption" | "ramp" | "flex"

export const KEY_CARD_GROUPS: { group: KeyCardGroup; label: string; role: KeyCardRole | null }[] = [
  { group: "combo", label: "连招件", role: null }, // combo_starter / combo_finisher 二选一
  { group: "damage", label: "增伤/斩杀", role: "damage_amplifier" },
  { group: "draw", label: "过牌/检索", role: "draw" },
  { group: "sustain", label: "生存", role: "sustain" },
  { group: "disruption", label: "干扰", role: "disruption" },
  { group: "ramp", label: "蓄爆/资源", role: "ramp" },
  { group: "flex", label: "灵活位", role: "flex_slot" },
]

export interface OpeningStep {
  action: string
  cost: string
  effectDescription: string
}

/**
 * 开局决策树（一级分支结构）：
 * 每个分支 = 条件 + 该条件下的打法序列；isPrimary 的分支为默认分支
 * （条件不满足任何其他分支时的打法）。录入时按优先级从高到低。
 */
export interface OpeningSequence {
  id: string
  name: string
  /** 分支条件（如「手牌有卯师傅」「后手」「骰子 ≥3 同色」）；空串 = 默认分支 */
  condition: string
  /**
   * 分支打法风格：
   * "tempo"     节奏——骰子直接转化为行动权/伤害（技能/切换/进攻牌）
   * "charge_up" 蓄爆——将骰子以非技能形式消耗/存储（打出支援/装备类投资牌），
   *             在节省轮次/抢先的同时为后续回合铺垫更多资源
   */
  style?: "tempo" | "charge_up"
  steps: OpeningStep[]
  diceConstraint: string
  totalDiceUsed: number
  isPrimary: boolean
}

export interface DeckGroundTruth {
  schemaVersion: "3.0"
  deckCode: string
  deckName: string
  version: string
  deckProfile: { primaryType?: string; secondaryType?: string; tempo?: string; startupSpeed?: string }
  keyCards: Record<KeyCardGroup, KeyCard[]>
  openingSequences?: OpeningSequence[]
  setupDependency?: string
  damageMode?: string
  powerCurve?: string
  hasOneShotPotential?: boolean
  resilience?: {
    hasHealing: boolean
    hasShield: boolean
    hasImmuneControl: boolean
    /** 干扰站场：拆除/压制对手支援区（送你一程等） */
    hasBoardDisruption?: boolean
    /** 事件牌反制：反制对手事件牌（裁定之时等） */
    hasEventCounter?: boolean
    /** 召唤物去除：清除对手召唤物（护法之誓等） */
    hasSummonRemoval?: boolean
    /** 手牌破坏：削减对手手牌 */
    hasHandDisruption?: boolean
    /** 牌库破坏：削减对手牌库 */
    hasDeckDisruption?: boolean
    vulnerableTo: string[]
  }
  abstentions: Abstention[]
}

export function initDeckState(version: string, deckCode: string, deckName: string): DeckGroundTruth {
  return {
    schemaVersion: "3.0",
    deckCode, deckName, version,
    deckProfile: {},
    keyCards: { combo: [], damage: [], draw: [], sustain: [], disruption: [], ramp: [], flex: [] },
    abstentions: [],
  }
}

// ── 对局级 schema (L3) ───────────────────────────────────

export interface MatchupThreat {
  source: string
  kind: "lethal" | "disrupting" | "grinding" | "ramping" | string
  window: "early" | "mid" | "late" | string
  countermeasure: string
  /** 我方牌表中的针对牌名列表；null = 无针对牌，只能靠打法调整 */
  existingCounterCards: string[] | null
}

export interface RoleShift {
  cardOrCharacter: string
  isolatedRole: string
  matchupRole: string
  reason: string
}

/** 对局中单方视角的响应链标注（"我方"=该视角的持有方） */
export interface MatchupPerspective {
  opponentNotables: {
    elementComposition: string[]
    powerCurve: string
    damageMode: string
    threatSummary: string
  }
  threats: MatchupThreat[]
  reactionControl?: {
    myMonopoly: string[]
    oppMonopoly: string[]
    contested: string[]
    advantage: string
  }
  tempoShift?: { shift: string; rationale: string }
  windowShift?: { myEffectiveWindow: string; adjustment: string }
  roleShifts?: RoleShift[]
  playOrder?: { asFirst?: string; asSecond?: string }
  assessment: {
    myAdvantages: string[]
    oppAdvantages: string[]
    recommendedStrategy?: string
  }
  overallDirection: string
  decisiveFactor: string
  abstentions: Abstention[]
}

/**
 * 对局级 schema：正反手合并存储（每无序对一份）。
 * perspectives.a = A 视角（我方=A，对手=B）；perspectives.b = B 视角。
 */
export interface MatchupGroundTruth {
  schemaVersion: "3.0"
  version: string
  deckA: { code: string; name: string }
  deckB: { code: string; name: string }
  isMirror: boolean
  perspectives: { a: MatchupPerspective; b: MatchupPerspective }
}

export function initPerspective(oppElements: string[]): MatchupPerspective {
  return {
    opponentNotables: {
      elementComposition: oppElements,
      powerCurve: "",
      damageMode: "",
      threatSummary: "",
    },
    threats: [],
    assessment: { myAdvantages: [], oppAdvantages: [], recommendedStrategy: undefined },
    overallDirection: "",
    decisiveFactor: "",
    abstentions: [],
  }
}

export function initMatchupState(
  version: string,
  aCode: string, aName: string,
  bCode: string, bName: string,
  aElements: string[],
  bElements: string[],
): MatchupGroundTruth {
  return {
    schemaVersion: "3.0",
    version,
    deckA: { code: aCode, name: aName },
    deckB: { code: bCode, name: bName },
    isMirror: aCode === bCode,
    perspectives: { a: initPerspective(bElements), b: initPerspective(aElements) },
  }
}

// ── IO ──────────────────────────────────────────────────

export function loadJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

// ── 跨卡组继承 ───────────────────────────────────────────

export interface PriorKeyCardEntry {
  deckName: string
  group: KeyCardGroup
  card: KeyCard
}

/**
 * 构建跨卡组关键卡牌索引：cardId → 全部已录入条目（同版本所有卡组的 ground truth）。
 * 供录入向导继承默认值（同组优先、他组兜底）。
 */
export function buildPriorKeyCardIndex(version: string, excludeDeckCode?: string): Map<string, PriorKeyCardEntry[]> {
  const idx = new Map<string, PriorKeyCardEntry[]>()
  const dir = join(GT_DIR, version, "decks")
  if (!existsSync(dir)) return idx
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    const s = loadJson<DeckGroundTruth>(join(dir, f))
    if (!s || s.deckCode === excludeDeckCode) continue
    for (const { group } of KEY_CARD_GROUPS) {
      for (const card of s.keyCards?.[group] ?? []) {
        const list = idx.get(card.id) ?? []
        list.push({ deckName: s.deckName, group, card })
        idx.set(card.id, list)
      }
    }
  }
  return idx
}

export interface PriorThreat {
  deckName: string
  source: string
  kind: string
  window: string
  countermeasure: string
}

/**
 * 跨对局威胁检索：找出同版本中面对同一对手时已标过的威胁（按 source 去重）。
 * 对手威胁不随我方是谁而改变，供对局标注继承 source/kind/window。
 */
export function findPriorThreats(version: string, excludeMyDeckCode: string, opponentDeckCode: string): PriorThreat[] {
  const dir = join(GT_DIR, version, "matchups")
  if (!existsSync(dir)) return []
  const seen = new Set<string>()
  const out: PriorThreat[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue
    const raw = loadJson<MatchupGroundTruth>(join(dir, f))
    if (!raw) continue
    const s = normalizeMatchupState(raw)
    // 找出双方视角中「对手=opponentDeckCode」的那份（持有者不能是当前我方）
    const candidates: { meName: string; p: MatchupPerspective }[] = []
    if (s.deckB.code === opponentDeckCode && s.deckA.code !== excludeMyDeckCode) {
      candidates.push({ meName: s.deckA.name, p: s.perspectives.a })
    }
    if (s.deckA.code === opponentDeckCode && s.deckB.code !== excludeMyDeckCode) {
      candidates.push({ meName: s.deckB.name, p: s.perspectives.b })
    }
    for (const { meName, p } of candidates) {
      for (const t of p.threats ?? []) {
        if (seen.has(t.source)) continue
        seen.add(t.source)
        out.push({ deckName: meName, source: t.source, kind: t.kind, window: t.window, countermeasure: t.countermeasure })
      }
    }
  }
  return out
}

/** 加载后规整：补齐缺失的容器字段（兼容早期文件） */
export function normalizeDeckState(raw: DeckGroundTruth): DeckGroundTruth {
  raw.deckProfile ??= {}
  const kc: Partial<DeckGroundTruth["keyCards"]> = raw.keyCards ?? {}
  raw.keyCards = {
    combo: kc.combo ?? [],
    damage: kc.damage ?? [],
    draw: kc.draw ?? [],
    sustain: kc.sustain ?? [],
    disruption: kc.disruption ?? [],
    ramp: kc.ramp ?? [],
    flex: kc.flex ?? [],
  }
  delete (raw as unknown as Record<string, unknown>).comboLines // 已废弃字段：致胜线路
  raw.abstentions ??= []
  return raw
}

/** 加载后规整：补齐缺失的容器字段（兼容早期文件） */
/** 加载后规整：补齐容器字段；兼容旧的单视角格式（自动迁移为双视角） */
export function normalizeMatchupState(raw: MatchupGroundTruth): MatchupGroundTruth {
  const legacy = raw as unknown as Record<string, unknown>
  if (legacy.myDeckCode && !raw.perspectives) {
    // 旧单视角格式：myDeckCode/opponentDeckCode + 平铺字段 → perspectives.a
    const a = initPerspective((legacy.opponentNotables as MatchupPerspective["opponentNotables"])?.elementComposition ?? [])
    a.opponentNotables = (legacy.opponentNotables as MatchupPerspective["opponentNotables"]) ?? a.opponentNotables
    a.threats = (legacy.threats as MatchupPerspective["threats"]) ?? []
    a.reactionControl = legacy.reactionControl as MatchupPerspective["reactionControl"]
    a.tempoShift = legacy.tempoShift as MatchupPerspective["tempoShift"]
    a.windowShift = legacy.windowShift as MatchupPerspective["windowShift"]
    a.roleShifts = legacy.roleShifts as MatchupPerspective["roleShifts"]
    a.playOrder = legacy.playOrder as MatchupPerspective["playOrder"]
    a.assessment = (legacy.assessment as MatchupPerspective["assessment"]) ?? a.assessment
    a.overallDirection = (legacy.overallDirection as string) ?? ""
    a.decisiveFactor = (legacy.decisiveFactor as string) ?? ""
    a.abstentions = (legacy.abstentions as MatchupPerspective["abstentions"]) ?? []
    return {
      schemaVersion: "3.0",
      version: raw.version,
      deckA: { code: legacy.myDeckCode as string, name: legacy.myDeckName as string },
      deckB: { code: legacy.opponentDeckCode as string, name: legacy.opponentDeckName as string },
      isMirror: (legacy.isMirror as boolean) ?? false,
      perspectives: { a, b: initPerspective([]) },
    }
  }
  raw.perspectives ??= { a: initPerspective([]), b: initPerspective([]) }
  for (const p of [raw.perspectives.a, raw.perspectives.b]) {
    p.opponentNotables ??= { elementComposition: [], powerCurve: "", damageMode: "", threatSummary: "" }
    p.threats ??= []
    p.assessment ??= { myAdvantages: [], oppAdvantages: [] }
    p.abstentions ??= []
  }
  return raw
}

export function saveJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
}

export function loadProgress(): Record<string, number> {
  return loadJson<Record<string, number>>(PROGRESS_FILE) ?? {}
}

export function saveProgress(progress: Record<string, number>): void {
  saveJson(PROGRESS_FILE, progress)
}

// ── 轻量校验（告警，不阻断保存） ──────────────────────────

export function validateDeckState(s: DeckGroundTruth): string[] {
  const warnings: string[] = []
  if (s.deckProfile.primaryType && s.deckProfile.primaryType === s.deckProfile.secondaryType) {
    warnings.push("主类型与副类型相同（副类型应为不同维度或留空）")
  }
  const seen = new Map<string, string>()
  for (const { group } of KEY_CARD_GROUPS) {
    for (const c of s.keyCards[group]) {
      const prev = seen.get(c.id)
      if (prev) warnings.push(`关键卡牌 ${c.id} 同时出现在 ${prev} 与 ${group} 组`)
      else seen.set(c.id, group)
    }
  }
  for (const seq of s.openingSequences ?? []) {
    if (seq.totalDiceUsed > 8) {
      warnings.push(`开局序列「${seq.name}」总骰数 ${seq.totalDiceUsed} > 8`)
    }
  }
  const anyContent =
    s.deckProfile.primaryType ||
    KEY_CARD_GROUPS.some(({ group }) => s.keyCards[group].length > 0) ||
    (s.openingSequences?.length ?? 0) > 0 || s.damageMode
  if (!anyContent) warnings.push("卡组标注为空")
  return warnings
}

export function validateMatchupState(s: MatchupGroundTruth): string[] {
  const warnings: string[] = []
  const check = (p: MatchupPerspective, tag: string) => {
    if (p.threats.length === 0 && !p.abstentions.some(a => a.field.startsWith("threats"))) {
      warnings.push(`${tag}：未标注任何对手威胁（如确认无威胁请添加弃权说明）`)
    }
    if (!p.overallDirection) warnings.push(`${tag}：overallDirection 未填写`)
    if (!p.decisiveFactor) warnings.push(`${tag}：decisiveFactor 未填写`)
    for (const t of p.threats) {
      if (t.existingCounterCards === null && !t.countermeasure) {
        warnings.push(`${tag}：威胁「${t.source}」既无针对牌也无应对说明`)
      }
    }
  }
  check(s.perspectives.a, "A 视角")
  check(s.perspectives.b, "B 视角")
  return warnings
}
