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
 * Round 0 战前分析生成（deck-analysis 阶段 1 的降级实现）。
 *
 * 背景：被测侧开局不能走 llm-agent 的 legacy analyze 路径（会违反
 * DESIGN §7.2「只注入 knowledge 文件」的冻结原则），战前分析必须在
 * knowledge 生产线内完成——LLM 仅凭卡组构成生成 preGameAnalysis
 * （开局序列/关键卡/出伤模式/强度曲线），冻结进 knowledge v0。
 */

import { staticDecode } from "@gi-tcg/assets-manager"
import { buildDeckInfo, flattenDescription, type DeckInfo } from "../../../deck-analysis/src/deck-info"
import type { KeyCard, KeyCardRole, OpeningSequence } from "../../../deck-analysis/src/annotate/schema"
import type { PreGameAnalysis } from "../knowledge/schema"
import { EvolveError, type ApiCredentials } from "./llm-client"
import { resolveCallLlm, type ReflectDeps } from "./reflect"

// ── 卡组文本化 ─────────────────────────────────────────

/** 从 deck code 构建 DeckInfo（角色/卡牌 ID 列表 → 完整描述）。 */
export function deckInfoFromCode(deckCode: string, deckName = ""): DeckInfo {
  const decoded = staticDecode(deckCode)
  const characterIds = decoded.characters
  const cardIds = decoded.cards
  return buildDeckInfo("current", deckCode, deckName, characterIds, cardIds)
}

/** 渲染为 LLM 可读的紧凑卡组文本（角色技能全列、卡牌带费用与效果首行）。 */
export function renderDeckText(info: DeckInfo): string {
  const lines: string[] = []
  lines.push("## 角色")
  for (const c of info.characters) {
    lines.push(`### ${c.name}（${c.element}/${c.weapon}，HP ${c.hp}，能量 ${c.energy}）`)
    for (const s of c.skills) {
      lines.push(`- [${s.type}] ${s.name}（${s.cost}）：${s.description}`)
    }
  }
  lines.push("## 卡牌")
  for (const c of info.cards) {
    const subtype = c.subtype === "" ? "" : `/${c.subtype}`
    const tags = c.tags.length > 0 ? `，标签:${c.tags.join("/")}` : ""
    lines.push(`- ${c.name}（${c.type}${subtype}，${c.cost}${tags}）`)
  }
  return lines.join("\n")
}

// ── 输出解析 ───────────────────────────────────────────

const KEY_CARD_ROLES: readonly KeyCardRole[] = [
  "combo_starter", "combo_field", "combo_bridge", "combo_finisher",
  "damage_amplifier", "draw", "sustain", "disruption", "ramp", "flex_slot",
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

/** 从 LLM 文本中提取首个完整 JSON 对象（平衡括号扫描，容忍 ```json 围栏与尾随文本）。 */
function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/g, "")
  const start = cleaned.indexOf("{")
  if (start < 0) {
    throw new EvolveError("战前分析输出中未找到 JSON 对象")
  }
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\" && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) {
    throw new EvolveError("战前分析输出中的 JSON 括号不闭合")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch (err) {
    throw new EvolveError(`战前分析 JSON 解析失败: ${String(err)}`)
  }
  const obj = asRecord(parsed)
  if (obj === null) {
    throw new EvolveError("战前分析 JSON 不是对象")
  }
  return obj
}

function parseKeyCards(value: unknown): KeyCard[] {
  if (!Array.isArray(value)) return []
  const out: KeyCard[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (rec === null) continue
    const id = asString(rec.id ?? rec.name)
    if (id === "") continue
    const roleRaw = asString(rec.role, "flex_slot")
    const importanceRaw = asString(rec.importance, "important")
    const mulliganRaw = asString(rec.mulligan, "situational")
    out.push({
      id,
      role: (KEY_CARD_ROLES as readonly string[]).includes(roleRaw)
        ? (roleRaw as KeyCardRole)
        : "flex_slot",
      importance: (["core", "important", "flexible"] as const).includes(
        importanceRaw as "core" | "important" | "flexible",
      )
        ? (importanceRaw as "core" | "important" | "flexible")
        : "important",
      rationale: asString(rec.rationale),
      mulligan: (["always_keep", "high", "situational", "never"] as const).includes(
        mulliganRaw as "always_keep" | "high" | "situational" | "never",
      )
        ? (mulliganRaw as "always_keep" | "high" | "situational" | "never")
        : "situational",
    })
  }
  return out
}

function parseOpeningSequences(value: unknown): OpeningSequence[] {
  if (!Array.isArray(value)) return []
  const out: OpeningSequence[] = []
  for (const item of value) {
    const rec = asRecord(item)
    if (rec === null) continue
    const rawSteps = Array.isArray(rec.steps) ? rec.steps : []
    const steps = rawSteps
      .map((s) => {
        const sr = asRecord(s)
        if (sr !== null) {
          return {
            action: asString(sr.action),
            cost: asString(sr.cost),
            effectDescription: asString(sr.effectDescription ?? sr.effect),
          }
        }
        return { action: asString(s), cost: "", effectDescription: "" }
      })
      .filter((s) => s.action !== "")
    if (steps.length === 0) continue
    const styleRaw = asString(rec.style)
    out.push({
      id: asString(rec.id, `open-${out.length + 1}`),
      name: asString(rec.name, `开局 ${out.length + 1}`),
      condition: asString(rec.condition),
      ...(styleRaw === "tempo" || styleRaw === "charge_up" ? { style: styleRaw } : {}),
      steps,
      diceConstraint: asString(rec.diceConstraint),
      totalDiceUsed: typeof rec.totalDiceUsed === "number" ? rec.totalDiceUsed : 0,
      isPrimary: rec.isPrimary === true,
    })
  }
  if (out.length > 0 && !out.some((s) => s.isPrimary)) {
    out[0]!.isPrimary = true
  }
  return out
}

// ── 生成 ───────────────────────────────────────────────

const SYSTEM_PROMPT = `你是七圣召唤卡组分析师。仅凭给定卡组构成做 L2 静态分析（不依赖对局经验）。
要求：
1. 所有卡牌/角色/技能名称必须严格来自给定卡组文本，禁止凭记忆补充效果；
2. 开局序列是给「第 1 回合」的具体行动方案（含骰子约束），分支条件可为空（默认分支）；
3. 只输出一个 JSON 对象，不要输出任何解释文字。`

function buildUserPrompt(deckText: string, algorithmicContext: string): string {
  // 注意：格式说明必须紧凑——冗长的逐字段注释会让推理型模型陷入无限思考
  //（实测 finish_reason=length、reasoning 烧满 token、content 为空）
  return `${algorithmicContext}

## 卡组构成
${deckText}

只输出一个 JSON 对象（先直接给 JSON，不要解释）：
{"damageMode":"一句话","powerCurve":"一句话","keyCards":[{"id":"卡名/角色名","role":"用途一词","importance":"core","rationale":"一句话","mulligan":"high"}],"openingSequences":[{"id":"open-1","name":"开局","condition":"","steps":[{"action":"出战角色+技能","cost":"3岩","effectDescription":"效果"}],"diceConstraint":"3岩","totalDiceUsed":8,"isPrimary":true}]}
keyCards 3-6 张；openingSequences 1-2 个；steps 2-4 步。`
}

export interface PreGameDeps extends ReflectDeps {
  fallback?: ApiCredentials
}

/**
 * 生成 Round 0 战前分析。LLM 仅凭卡组构成（deckCode 解码文本）+
 * 算法上下文（A-CEoH 式注入），输出与 GT schema 兼容的 PreGameAnalysis。
 * 解析失败时带错误反馈重试一次，仍失败则抛 EvolveError。
 */
export async function generatePreGameAnalysis(opts: {
  deckCode: string
  deckName?: string
  context: string
  deps: PreGameDeps
}): Promise<PreGameAnalysis> {
  const { deckCode, context, deps } = opts
  const info = deckInfoFromCode(deckCode, opts.deckName ?? "")
  const deckText = renderDeckText(info)
  const callLlm = resolveCallLlm(deps)
  const userPrompt = buildUserPrompt(deckText, context)

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? userPrompt
        : `${userPrompt}\n\n## 上次输出解析失败\n${lastError!.message}\n请修正后只输出 JSON 对象。`
    const text = await callLlm({ system: SYSTEM_PROMPT, user: prompt, maxTokens: 8192 })
    try {
      const obj = extractJson(text)
      return {
        damageMode: asString(obj.damageMode),
        powerCurve: asString(obj.powerCurve),
        keyCards: parseKeyCards(obj.keyCards),
        openingSequences: parseOpeningSequences(obj.openingSequences),
      }
    } catch (err) {
      // 带上原始输出片段便于定位（截断/围栏/散文等失败形态一眼可辨）
      const snippet = text.replace(/\s+/g, " ").slice(0, 300)
      lastError = new EvolveError(
        `${err instanceof Error ? err.message : String(err)}（原始输出前300字符: ${snippet}）`,
      )
    }
  }
  throw lastError
}

export { flattenDescription }
