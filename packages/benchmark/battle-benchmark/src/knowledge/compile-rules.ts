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
 * E2 知识条款 → 决策片段 DSL 规则编译器。
 *
 * 背景：knowledge 分节是自由文本，无法直接映射到动作（传导断档原因之一）。
 * fragmented-decision 模式的 DecisionFragmentV1.rules 是 when/then 规则链，
 * 与 E2 触发式规则同构——本模块用一次离线 LLM 调用把知识文本编译为
 * DSL 规则模板，随注入文件进入 prompt，由对局 LLM 在决策点实例化。
 *
 * DSL 契约镜像 packages/mcp/src/scoring/types.ts（DecisionRuleV1/WhenConditionV1/
 * ActionSpecV1）与 FragmentResolver.DSL_FIELDS 的封闭字段集。此处不 import
 * @gi-tcg/mcp，避免 benchmark → mcp 的跨包依赖；契约有变动时两侧需同步。
 */

import { EvolveError } from "../evolve/llm-client"
import type { CallLlm } from "../evolve/reflect"
import type { LLMDeckKnowledge } from "./schema"
import { SECTION_IDS, SECTION_LABELS } from "./schema"

export interface CompiledWhenCondition {
  field: string
  op: "<=" | ">=" | "==" | "!=" | "<" | ">"
  value: number | string | boolean
}

export interface CompiledActionSpec {
  action_case: "useSkill" | "playCard" | "switchActive" | "declareEnd" | "elementalTuning"
  skill_type?: "normal_attack" | "elemental_skill" | "burst"
  target?: string | number
  prefer_reaction?: string[]
  damage_min?: number
  kills?: boolean
  card_tag?: string
  card_def_id?: number
  require_tag?: string
}

export interface CompiledRule {
  priority: number
  when?: CompiledWhenCondition[]
  then: CompiledActionSpec
  reason: string
  /** 来源分节（追溯用，不进 fragment）。 */
  sourceSection?: string
}

/** when 条件的封闭字段集（与 FragmentResolver.DSL_FIELDS 对齐）。 */
export const DSL_WHEN_FIELDS: readonly string[] = [
  "self.active.hp",
  "self.active.energy",
  "self.active.max_energy",
  "opponent.active.hp",
  "opponent.active.aura",
  "opponent.active.alive",
  "resource.dice_count",
  "resource.omni_count",
  "resource.cards_in_hand",
  "digest.round",
  "digest.turn",
  "digest.lethal.my_kill",
  "digest.lethal.opponent_kill",
]

const DSL_OPS = ["<=", ">=", "==", "!=", "<", ">"] as const
const DSL_ACTION_CASES = ["useSkill", "playCard", "switchActive", "declareEnd", "elementalTuning"] as const
const DSL_SKILL_TYPES = ["normal_attack", "elemental_skill", "burst"] as const

/** 单次编译产出的规则数上限（注入体积护栏）。 */
export const COMPILED_RULES_LIMIT = 12

/**
 * 结构校验编译产物：丢掉不合法的规则并记录原因。
 * 只校验 DSL 封闭集合（字段/操作符/action_case/skill_type），不做语义判断。
 */
export function validateCompiledRules(raw: unknown): { rules: CompiledRule[]; dropped: string[] } {
  const dropped: string[] = []
  if (!Array.isArray(raw)) {
    return { rules: [], dropped: ["编译产物不是数组"] }
  }
  const rules: CompiledRule[] = []
  for (const [idx, item] of raw.entries()) {
    const tag = `rules[${idx}]`
    if (typeof item !== "object" || item === null) {
      dropped.push(`${tag}: 不是对象`)
      continue
    }
    const r = item as Record<string, unknown>
    if (typeof r.priority !== "number" || !Number.isFinite(r.priority)) {
      dropped.push(`${tag}: priority 缺失或非数值`)
      continue
    }
    const then = r.then as Record<string, unknown> | undefined
    if (typeof then !== "object" || then === null) {
      dropped.push(`${tag}: then 缺失`)
      continue
    }
    if (typeof then.action_case !== "string" || !(DSL_ACTION_CASES as readonly string[]).includes(then.action_case)) {
      dropped.push(`${tag}: action_case 非法: ${String(then.action_case)}`)
      continue
    }
    if (
      then.skill_type !== undefined &&
      (typeof then.skill_type !== "string" || !(DSL_SKILL_TYPES as readonly string[]).includes(then.skill_type))
    ) {
      dropped.push(`${tag}: skill_type 非法: ${String(then.skill_type)}`)
      continue
    }
    let when: CompiledWhenCondition[] | undefined
    if (Array.isArray(r.when) && r.when.length > 0) {
      when = []
      let bad = false
      for (const c of r.when) {
        if (typeof c !== "object" || c === null) {
          bad = true
          break
        }
        const cond = c as Record<string, unknown>
        if (typeof cond.field !== "string" || !DSL_WHEN_FIELDS.includes(cond.field)) {
          dropped.push(`${tag}: when.field 不在封闭集合: ${String(cond.field)}`)
          bad = true
          break
        }
        if (typeof cond.op !== "string" || !(DSL_OPS as readonly string[]).includes(cond.op)) {
          dropped.push(`${tag}: when.op 非法: ${String(cond.op)}`)
          bad = true
          break
        }
        const v = cond.value
        if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
          dropped.push(`${tag}: when.value 类型非法: ${typeof v}`)
          bad = true
          break
        }
        when.push({ field: cond.field, op: cond.op as CompiledWhenCondition["op"], value: v })
      }
      if (bad) {
        continue
      }
    }
    const spec: CompiledActionSpec = {
      action_case: then.action_case as CompiledActionSpec["action_case"],
      ...(typeof then.skill_type === "string"
        ? { skill_type: then.skill_type as CompiledActionSpec["skill_type"] }
        : {}),
      ...(typeof then.target === "string" || typeof then.target === "number" ? { target: then.target } : {}),
      ...(Array.isArray(then.prefer_reaction)
        ? { prefer_reaction: (then.prefer_reaction as unknown[]).filter((x): x is string => typeof x === "string") }
        : {}),
      ...(typeof then.damage_min === "number" ? { damage_min: then.damage_min } : {}),
      ...(then.kills === true ? { kills: true } : {}),
      ...(typeof then.card_tag === "string" ? { card_tag: then.card_tag } : {}),
      ...(typeof then.card_def_id === "number" ? { card_def_id: then.card_def_id } : {}),
      ...(typeof then.require_tag === "string" ? { require_tag: then.require_tag } : {}),
    }
    rules.push({
      priority: r.priority,
      ...(when !== undefined ? { when } : {}),
      then: spec,
      reason: typeof r.reason === "string" && r.reason.length > 0 ? r.reason : "（无理由）",
      ...(typeof r.sourceSection === "string" ? { sourceSection: r.sourceSection } : {}),
    })
  }
  // priority 升序、去重到上限
  rules.sort((a, b) => a.priority - b.priority)
  return { rules: rules.slice(0, COMPILED_RULES_LIMIT), dropped }
}

const COMPILER_SYSTEM = `你是「卡组知识 → 决策规则」编译器。把七圣召唤卡组知识文本编译为决策片段 DSL 规则链。

## DSL 契约
每条规则：{ "priority": int（小=优先，从 0 起按 5 或 10 步进）, "when": [条件...]（可选，全部满足才命中；省略=恒真）, "then": 动作规范, "reason": "一句话理由", "sourceSection": "来源分节id" }

when 条件：{ "field": 字段, "op": 操作符, "value": 值 }
- field 只能用以下封闭集合：
  self.active.hp / self.active.energy / self.active.max_energy
  opponent.active.hp / opponent.active.aura（none/pyro/hydro/electro/cryo/anemo/geo/dendro）/ opponent.active.alive（布尔）
  resource.dice_count / resource.omni_count / resource.cards_in_hand
  digest.round / digest.turn
  digest.lethal.my_kill（布尔：我方有斩杀机会）/ digest.lethal.opponent_kill（布尔：对手有斩杀机会）
- op：<= >= == != < >
- value：数值/字符串/布尔；"$字段名" 表示引用另一字段（如 "$self.active.hp"）

then 动作规范：{ "action_case": 必填, 其他过滤器可选且全部满足才匹配 }
- action_case：useSkill / playCard / switchActive / declareEnd / elementalTuning
- skill_type：normal_attack / elemental_skill / burst
- kills：true（要求候选能击杀）
- damage_min：数值（候选总伤下限）
- prefer_reaction：["melt","vaporize",...]（候选反应类型含其一）
- card_tag：字符串（按候选 tags/notes 子串匹配，如 heal_card / utility_card）
- card_def_id：数值（精确指定卡牌 definition_id，仅在知识明确点名某张牌时使用）
- require_tag：字符串（如 summon / fast_action）

## 编译原则
1. 只编译知识中**可判定的条件→动作**条款；纯叙事、无法映射到上述字段的经验不要硬编。
2. 回合数条件用 digest.round（知识里的 T1/T2 = round 1/2）。
3. 「能杀就杀」类条款编译为 when digest.lethal.my_kill==true + then kills:true，放最高优先级。
4. 保命/防斩杀类用 digest.lethal.opponent_kill 或 opponent.active.hp 等表达。
5. 兜底条款（恒真 when 省略）priority 给 90+。
6. 输出 8-12 条，priority 不得重复。
7. 只输出 JSON 数组，不要任何其他文字。`

function buildCompilerUser(knowledge: LLMDeckKnowledge): string {
  const parts: string[] = ["# 卡组知识（待编译）"]
  const refine = knowledge.refinedKnowledge
  if (refine) {
    for (const id of SECTION_IDS) {
      const text = refine.sections[id]
      if (text && text.trim().length > 0) {
        parts.push(`\n## 分节 ${id}（${SECTION_LABELS[id]}）\n${text}`)
      }
    }
  }
  if (knowledge.preGameAnalysis.damageMode) {
    parts.push(`\n## 战前分析\n伤害模式：${knowledge.preGameAnalysis.damageMode}\n强度曲线：${knowledge.preGameAnalysis.powerCurve}`)
  }
  parts.push("\n# 输出\nJSON 规则数组（8-12 条）。")
  return parts.join("\n")
}

/** 从 LLM 输出提取 JSON 数组（容忍 Markdown 围栏与前后缀）。 */
function extractJsonArray(text: string): unknown {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start < 0 || end <= start) {
    return null
  }
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

export interface CompileResult {
  rules: CompiledRule[]
  dropped: string[]
  /** LLM 原始输出长度（诊断用）。 */
  rawChars: number
}

/**
 * 编译当前知识为 DSL 规则模板。知识为空（无 refinedKnowledge 非空分节）时
 * 返回空结果而不调 LLM。
 */
export async function compileKnowledgeToRules(opts: {
  knowledge: LLMDeckKnowledge
  callLlm: CallLlm
}): Promise<CompileResult> {
  const { knowledge, callLlm } = opts
  const hasContent =
    knowledge.refinedKnowledge !== undefined &&
    SECTION_IDS.some((id) => (knowledge.refinedKnowledge?.sections[id] ?? "").trim().length > 0)
  if (!hasContent) {
    return { rules: [], dropped: [], rawChars: 0 }
  }
  // 推理模型结构化输出需要充足的 token 上限（4000 曾被推理烧穿返回空串）。
  const raw = await callLlm({
    system: COMPILER_SYSTEM,
    user: buildCompilerUser(knowledge),
    temperature: 0.2,
    maxTokens: 16000,
  })
  const parsed = extractJsonArray(raw)
  if (parsed === null) {
    throw new EvolveError(`规则编译产物不是合法 JSON 数组（前 200 字符）: ${raw.slice(0, 200)}`)
  }
  const { rules, dropped } = validateCompiledRules(parsed)
  return { rules, dropped, rawChars: raw.length }
}

/** 渲染编译规则为注入文件的 Markdown 小节（空规则返回空串）。 */
export function renderCompiledRulesForPrompt(rules: CompiledRule[], knowledgeVersion: number): string {
  if (rules.length === 0) {
    return ""
  }
  const lines: string[] = [
    "",
    `## 可执行规则模板（DSL 编译产物，源自知识 v${knowledgeVersion}）`,
    "以下规则由历史知识编译而来，与 submit_decision_fragment_v1 的 rules 完全同构。",
    "提交决策片段时：**把适用模板实例化为你的 rules 条目**（可按当前 digest 微调 when 数值与 card_def_id，保持 priority 相对顺序），置于你的临时规则之前。",
    "",
    "```json",
    JSON.stringify(rules.map(({ sourceSection: _s, ...rest }) => rest), null, 1),
    "```",
    "",
  ]
  return lines.join("\n")
}
