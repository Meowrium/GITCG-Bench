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

import { randomUUID } from "node:crypto"
import {
  DEFAULT_KNOWLEDGE_LIMITS,
  enforceKnowledgeLimits,
  renderKnowledgeForPrompt,
} from "../knowledge/schema"
import type {
  IterationEntry,
  KnowledgeLimits,
  LLMDeckKnowledge,
  MetaInsight,
  SectionId,
} from "../knowledge/schema"
import type { BattleRecord } from "../record/assemble"
import type { RoundSummaryStats } from "./meta-reflect"
import { EvolveError, chatCompletion, type ApiCredentials } from "./llm-client"

export interface CallLlmOptions {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
}

export type CallLlm = (opts: CallLlmOptions) => Promise<string>

/** evolve 反射（预测/复盘）的可注入依赖；缺省走 chatCompletion。 */
export interface ReflectDeps {
  callLlm?: CallLlm
  apiBase?: string
  apiKey?: string
  model?: string
  /** 备用 API（主 API 配额耗尽时自动切换，进程级生效） */
  fallback?: ApiCredentials
}

/** 用 chatCompletion 实现的默认 LLM 调用器。 */
export function makeDefaultCallLlm(deps: {
  apiBase: string
  apiKey: string
  model: string
  fallback?: ApiCredentials
}): CallLlm {
  return async (opts: CallLlmOptions) => {
    const content = await chatCompletion({
      apiBase: deps.apiBase,
      apiKey: deps.apiKey,
      model: deps.model,
      ...(deps.fallback !== undefined ? { fallback: deps.fallback } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    })
    return content
  }
}

export function resolveCallLlm(deps: ReflectDeps): CallLlm {
  if (deps.callLlm) {
    return deps.callLlm
  }
  const { apiBase, apiKey, model, fallback } = deps
  if (typeof apiBase === "string" && typeof apiKey === "string" && typeof model === "string") {
    return makeDefaultCallLlm({
      apiBase,
      apiKey,
      model,
      ...(fallback !== undefined ? { fallback } : {}),
    })
  }
  throw new EvolveError("缺少 LLM 调用配置：需提供 callLlm，或 apiBase/apiKey/model 三者齐全")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>
  }
  return null
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 从 LLM 输出中提取 JSON 对象：取首个 `{` 到末个 `}` 的切片再解析，
 * 容忍 Markdown 围栏/前后缀文字。
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) {
    return null
  }
  return tryParseJson(text.slice(start, end + 1))
}

export function requireStringFields(
  value: unknown,
  fields: string[],
  label: string,
): Record<string, string> {
  const obj = asRecord(value)
  if (!obj) {
    throw new EvolveError(`${label}: 输出不是 JSON 对象`)
  }
  const out: Record<string, string> = {}
  for (const field of fields) {
    const v = obj[field]
    if (typeof v !== "string") {
      throw new EvolveError(`${label}: 字段 ${field} 缺失或不是字符串`)
    }
    out[field] = v
  }
  return out
}

/** 赛前预测：针对对手卡组的五维定性判断。 */
export interface PreGamePrediction {
  tempoShift: string
  reactionAdvantage: string
  threatResponse: string
  overallDirection: string
  decisiveFactor: string
}

const PRE_GAME_FIELDS = [
  "tempoShift",
  "reactionAdvantage",
  "threatResponse",
  "overallDirection",
  "decisiveFactor",
] as const

const PRE_GAME_PROMPT = `请基于提供的引擎算法背景、我方卡组知识与对手卡组信息，输出一份赛前对局预测。
只输出一个 JSON 对象，不要 Markdown 代码块，不要任何其他文字。字段：
- tempoShift: 节奏走向预判（字符串，中文，50-150 字）
- reactionAdvantage: 反应优势预判（字符串，中文，50-150 字）
- threatResponse: 主要威胁与应对思路（字符串，中文，50-150 字）
- overallDirection: 总体方向（字符串，中文，50-150 字）
- decisiveFactor: 决胜关键因素（字符串，中文，50-150 字）`

/** 对某套对手卡组做赛前预测；输出解析失败时带纠错提示重试一次。 */
export async function preGamePredict(options: {
  knowledge: LLMDeckKnowledge
  opponentDeckCode: string
  opponentDeckName: string
  context: string
  deps?: ReflectDeps
}): Promise<PreGamePrediction> {
  const { knowledge, opponentDeckCode, opponentDeckName, context, deps } = options
  const callLlm = resolveCallLlm(deps ?? {})
  const system = [
    `你是《七圣召唤》竞技对局的预测助手。以下是引擎算法背景（TurnDigestV1 结构、决策工具、规则速查）：`,
    "",
    context,
  ].join("\n")
  const user = [
    PRE_GAME_PROMPT,
    "",
    `## 我方卡组知识\n${renderKnowledgeForPrompt(knowledge)}`,
    "",
    `## 对手卡组`,
    `名称：${opponentDeckName}`,
    `代码：${opponentDeckCode}`,
  ].join("\n")

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0 ? user : `${user}\n\n（上次输出不是合法 JSON 或缺少字段，请只输出一个 JSON 对象）`
    let text: string
    try {
      text = await callLlm({ system, user: prompt })
    } catch (err) {
      lastError = err
      if (attempt === 0) {
        continue
      }
      break
    }
    try {
      const parsed = requireStringFields(extractJsonObject(text), [...PRE_GAME_FIELDS], "赛前预测")
      return {
        tempoShift: parsed.tempoShift,
        reactionAdvantage: parsed.reactionAdvantage,
        threatResponse: parsed.threatResponse,
        overallDirection: parsed.overallDirection,
        decisiveFactor: parsed.decisiveFactor,
      }
    } catch (err) {
      lastError = err
    }
  }
  throw new EvolveError(
    `赛前预测失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** 赛后复盘：对照预测校验结果，产出目标分节的新内容。 */
export interface PostGameReflection {
  predictionAccuracy: "correct" | "partial" | "wrong"
  whatWasWrong: string
  revisedAnalysis: string
  updatedSection: string
}

const ACCURACY_VALUES = new Set(["correct", "partial", "wrong"])

/** 对一轮对局做赛后复盘；输出解析失败时带纠错提示重试一次。 */
export async function postGameReflect(options: {
  knowledge: LLMDeckKnowledge
  section: SectionId
  sectionText: string
  roundSummary: string
  prediction: PreGamePrediction
  context: string
  /** 引擎侧权威统计块（buildAuthoritativeStats 产出），有则注入 prompt。 */
  statsBlock?: string
  /** 最近一次 M4 元反思产出的全局洞察（有则随知识一起渲染）。 */
  meta?: MetaInsight
  deps?: ReflectDeps
}): Promise<PostGameReflection> {
  const { knowledge, section, sectionText, roundSummary, prediction, context, statsBlock, meta, deps } = options
  const callLlm = resolveCallLlm(deps ?? {})
  const system = [
    `你是《七圣召唤》竞技对局的复盘助手。以下是引擎算法背景（TurnDigestV1 结构、决策工具、规则速查）：`,
    "",
    context,
  ].join("\n")
  const user = [
    `请对照赛前预测复盘本轮对局，并产出知识分节「${section}」的更新内容。`,
    `只输出一个 JSON 对象，不要 Markdown 代码块，不要任何其他文字。字段：`,
    `- predictionAccuracy: "correct" | "partial" | "wrong"（预测与实际的吻合程度）`,
    `- whatWasWrong: 预测错在哪（字符串，中文，50-200 字）`,
    `- revisedAnalysis: 修正后的分析（字符串，中文，50-200 字）`,
    `- updatedSection: 分节「${section}」的新内容（纯文本，可含 Markdown 列表；若无需更新则输出原内容）`,
    `- ${SMALL_SAMPLE_RULE}`,
    "",
    `## 目标分节当前内容`,
    sectionText.length > 0 ? sectionText : "（空）",
    "",
    `## 本轮对局摘要\n${roundSummary}`,
    ...(statsBlock !== undefined
      ? [
          "",
          `## 权威统计（引擎计算，引用任何数字时必须以此块为准，禁止自行计算或估算）\n${statsBlock}`,
        ]
      : []),
    "",
    `## 赛前预测\n${JSON.stringify(prediction, null, 2)}`,
    "",
    `## 我方卡组知识（其余分节参考）\n${renderKnowledgeForPrompt(knowledge, meta)}`,
  ].join("\n")

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0 ? user : `${user}\n\n（上次输出不是合法 JSON 或缺少字段，请只输出一个 JSON 对象）`
    let text: string
    try {
      text = await callLlm({ system, user: prompt })
    } catch (err) {
      lastError = err
      if (attempt === 0) {
        continue
      }
      break
    }
    try {
      const parsed = requireStringFields(
        extractJsonObject(text),
        ["predictionAccuracy", "whatWasWrong", "revisedAnalysis", "updatedSection"],
        "赛后复盘",
      )
      if (!ACCURACY_VALUES.has(parsed.predictionAccuracy)) {
        throw new EvolveError(
          `赛后复盘: predictionAccuracy 必须是 correct/partial/wrong 之一（得到 ${parsed.predictionAccuracy}）`,
        )
      }
      return {
        predictionAccuracy: parsed.predictionAccuracy as PostGameReflection["predictionAccuracy"],
        whatWasWrong: parsed.whatWasWrong,
        revisedAnalysis: parsed.revisedAnalysis,
        updatedSection: parsed.updatedSection,
      }
    } catch (err) {
      lastError = err
    }
  }
  throw new EvolveError(
    `赛后复盘失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/**
 * 合并多条来源反思记录的 parentSectionVersions：每个分节取最大值。
 * E2 骨干合成跨多轮来源，用它推导自身的 parentSectionVersions。
 */
export function mergeSectionVersions(
  entries: IterationEntry[],
): Partial<Record<SectionId, number>> {
  const merged: Partial<Record<SectionId, number>> = {}
  for (const entry of entries) {
    for (const [sid, ver] of Object.entries(entry.parentSectionVersions)) {
      const current = merged[sid as SectionId] ?? -1
      const next = typeof ver === "number" ? ver : 0
      if (next > current) {
        merged[sid as SectionId] = next
      }
    }
  }
  return merged
}

/** E2 骨干合成结果：PostGameReflection 各字段 + 提炼出的共同骨干。 */
export interface E2BackboneResult extends PostGameReflection {
  backbone: string
}

/** 对最近 N 条来源反思记录做 E2 骨干合成；输出解析失败时带纠错提示重试一次。 */
export async function postGameReflectE2(options: {
  knowledge: LLMDeckKnowledge
  section: SectionId
  sectionText: string
  roundSummary: string
  prediction: PreGamePrediction
  context: string
  /** 最近 N 条反思记录（只读，M1/E2 算子产生，E2 条目可携带 backbone）。 */
  sourceEntries: IterationEntry[]
  /** 引擎侧权威统计块（buildAuthoritativeStats 产出），有则注入 prompt。 */
  statsBlock?: string
  /** 最近一次 M4 元反思产出的全局洞察（有则随知识一起渲染）。 */
  meta?: MetaInsight
  deps?: ReflectDeps
}): Promise<E2BackboneResult> {
  const {
    knowledge,
    section,
    sectionText,
    roundSummary,
    prediction,
    context,
    sourceEntries,
    statsBlock,
    meta,
    deps,
  } = options
  const callLlm = resolveCallLlm(deps ?? {})
  const system = [
    `你是《七圣召唤》竞技对局的进化助手。以下是引擎算法背景（TurnDigestV1 结构、决策工具、规则速查）：`,
    "",
    context,
  ].join("\n")
  const sourceLines = sourceEntries
    .map((e, i) => {
      const p = e.postGameReflection
      return [
        `- 来源${i + 1}（iteration ${e.iteration}，算子 ${e.operator}，分节 ${e.targetSection}）：`,
        `  - predictionAccuracy: ${p.predictionAccuracy}`,
        `  - whatWasWrong: ${p.whatWasWrong}`,
        `  - revisedAnalysis: ${p.revisedAnalysis}`,
        ...(e.backbone !== undefined ? [`  - backbone: ${e.backbone}`] : []),
      ].join("\n")
    })
    .join("\n")
  const user = [
    `请对照赛前预测，从最近 ${sourceEntries.length} 条反思记录中提取共同骨干，合成分节「${section}」的更新内容。`,
    `只输出一个 JSON 对象，不要 Markdown 代码块，不要任何其他文字。字段：`,
    `- predictionAccuracy: "correct" | "partial" | "wrong"（对赛前预测与整体走势的吻合判断）`,
    `- whatWasWrong: 预测错在哪（字符串，中文，50-200 字）`,
    `- revisedAnalysis: 修正后的分析（字符串，中文，50-200 字）`,
    `- updatedSection: 分节「${section}」的新内容（纯文本，可含 Markdown 列表；若无需更新则输出原内容）`,
    `- backbone: 提炼出的共同骨干（字符串，中文，50-200 字，概括最近 ${sourceEntries.length} 条反思记录共有的失败模式与修正方向）`,
    `- ${SMALL_SAMPLE_RULE}`,
    "",
    `## 来源反思记录（最近 ${sourceEntries.length} 条，只读）`,
    sourceLines.length > 0 ? sourceLines : "（无）",
    "",
    `## 目标分节当前内容`,
    sectionText.length > 0 ? sectionText : "（空）",
    "",
    `## 本轮对局摘要\n${roundSummary}`,
    ...(statsBlock !== undefined
      ? [
          "",
          `## 权威统计（引擎计算，引用任何数字时必须以此块为准，禁止自行计算或估算）\n${statsBlock}`,
        ]
      : []),
    "",
    `## 赛前预测\n${JSON.stringify(prediction, null, 2)}`,
    "",
    `## 我方卡组知识（其余分节参考）\n${renderKnowledgeForPrompt(knowledge, meta)}`,
  ].join("\n")

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = attempt === 0 ? user : `${user}\n\n（上次输出不是合法 JSON 或缺少字段，请只输出一个 JSON 对象）`
    let text: string
    try {
      text = await callLlm({ system, user: prompt })
    } catch (err) {
      lastError = err
      if (attempt === 0) {
        continue
      }
      break
    }
    try {
      const parsed = requireStringFields(
        extractJsonObject(text),
        ["predictionAccuracy", "whatWasWrong", "revisedAnalysis", "updatedSection", "backbone"],
        "E2 骨干合成",
      )
      if (!ACCURACY_VALUES.has(parsed.predictionAccuracy)) {
        throw new EvolveError(
          `E2 骨干合成: predictionAccuracy 必须是 correct/partial/wrong 之一（得到 ${parsed.predictionAccuracy}）`,
        )
      }
      return {
        predictionAccuracy: parsed.predictionAccuracy as PostGameReflection["predictionAccuracy"],
        whatWasWrong: parsed.whatWasWrong,
        revisedAnalysis: parsed.revisedAnalysis,
        updatedSection: parsed.updatedSection,
        backbone: parsed.backbone,
      }
    } catch (err) {
      lastError = err
    }
  }
  throw new EvolveError(
    `E2 骨干合成失败：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/**
 * 提取决策的 explanation：harness 行取 args.explanation；
 * LLM tool_call 行取 arguments（JSON 字符串）中的 explanation；无则 null。
 */
function extractExplanation(rawRequest: unknown): string | null {
  const req = asRecord(rawRequest)
  if (!req) {
    return null
  }
  if (req.harness === true) {
    const args = asRecord(req.args)
    return typeof args?.explanation === "string" ? (args.explanation as string) : null
  }
  const argsText = req.arguments
  if (typeof argsText !== "string") {
    return null
  }
  const args = asRecord(tryParseJson(argsText))
  return typeof args?.explanation === "string" ? (args.explanation as string) : null
}

/** 把一批已组装的 battle record 压成一段对局摘要（给 LLM 复盘用）。 */
export function summarizeRecords(records: BattleRecord[]): string {
  const wins = records.filter((r) => r.result.winner === "me").length
  const losses = records.filter((r) => r.result.winner === "opponent").length
  const draws = records.length - wins - losses
  const rounds = records.map((r) => r.result.totalRounds ?? 0)
  const avgRounds = rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : 0
  const lines = [
    `共 ${records.length} 局：胜 ${wins} / 负 ${losses} / 平 ${draws}，平均回合数 ${avgRounds.toFixed(1)}`,
  ]
  records.forEach((r, i) => {
    lines.push(`- g${i + 1}: winner=${r.result.winner}, totalRounds=${r.result.totalRounds ?? "null"}, decisions=${r.decisions.length}`)
  })

  // 采样决策理由：优先 choose_action，不足 30 条时补其余决策。
  const explanations: string[] = []
  for (const kind of ["choose_action", "select_card", "elemental_tuning", "switch_hands", "reroll_dice", "choose_active"]) {
    for (const r of records) {
      for (const d of r.decisions) {
        if (d.decisionKind !== kind) {
          continue
        }
        const exp = extractExplanation(d.rawRequest)
        if (exp !== null && exp.length > 0) {
          explanations.push(`[${d.decisionKind}] ${exp.slice(0, 200)}${exp.length > 200 ? "…" : ""}`)
        }
        if (explanations.length >= 30) {
          return lines.join("\n") + (explanations.length > 0 ? `\n## 决策理由采样\n${explanations.join("\n")}` : "")
        }
      }
    }
  }
  return lines.join("\n") + (explanations.length > 0 ? `\n## 决策理由采样\n${explanations.join("\n")}` : "")
}

/**
 * 权威统计块（引擎侧计算）：本轮 + 历轮 + 全程累计。
 * 注入反思 prompt——LLM 只做归因不做口算，引用任何数字必须以此块为准，
 * 从源头消灭统计转述错误与截断样本的误读（见 findings-consolidated §10.1/§10.2）。
 */
export function buildAuthoritativeStats(
  records: BattleRecord[],
  historyRounds?: RoundSummaryStats[],
): string {
  const wins = records.filter((r) => r.result.winner === "me").length
  const losses = records.filter((r) => r.result.winner === "opponent").length
  const draws = records.length - wins - losses
  const rounds = records.map((r) => r.result.totalRounds ?? 0)
  const avgRounds = rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : 0
  const lines = [
    `- 本轮：${records.length} 局，胜 ${wins} / 负 ${losses} / 平 ${draws}，平均回合 ${avgRounds.toFixed(1)}`,
  ]
  let cumGames = records.length
  let cumWins = wins
  let cumLosses = losses
  let cumDraws = draws
  let cumRoundSum = rounds.reduce((a, b) => a + b, 0)
  if (historyRounds !== undefined && historyRounds.length > 0) {
    const hist = historyRounds.map((h) => {
      const n = h.wins + h.losses + h.draws
      cumGames += n
      cumWins += h.wins
      cumLosses += h.losses
      cumDraws += h.draws
      cumRoundSum += (h.avgRounds ?? 0) * n
      const avg = typeof h.avgRounds === "number" ? `，平均回合 ${h.avgRounds.toFixed(1)}` : ""
      return `  - round${h.round}: ${n} 局，胜 ${h.wins} / 负 ${h.losses} / 平 ${h.draws}${avg}`
    })
    lines.push(`- 历轮：`, ...hist)
  }
  if (historyRounds !== undefined && historyRounds.length > 0) {
    const cumAvg = cumGames > 0 ? cumRoundSum / cumGames : 0
    const cumWinRate = cumWins + cumLosses > 0 ? ((cumWins / (cumWins + cumLosses)) * 100).toFixed(1) : "—"
    lines.push(
      `- 全程累计：${cumGames} 局，胜 ${cumWins} / 负 ${cumLosses} / 平 ${cumDraws}，胜率 ${cumWinRate}%，平均回合 ${cumAvg.toFixed(1)}`,
      `（"累计"只允许指此处的全程累计；禁止用部分轮次拼出"累计"字样）`,
    )
  }
  return lines.join("\n")
}

/** 小样本纪律（findings-consolidated §10.3）：注入复盘/合成 prompt 的固定约束句。 */
const SMALL_SAMPLE_RULE =
  `若权威统计显示本轮样本局数 < 10，禁止在 revisedAnalysis/updatedSection 中做方向性强断言` +
  `（如"凡是…极低""必须…"），必须显式写出样本量并标注不确定度。`

export interface RoundReflectionOptions {
  knowledge: LLMDeckKnowledge
  /** 轮序号（0 基），写入 IterationEntry.iteration。 */
  round: number
  roundSummary: string
  records: BattleRecord[]
  section: SectionId
  context: string
  opponentDeckCode: string
  opponentDeckName: string
  parentLineageId?: string
  /** 本轮反思算子：M1=复盘（默认）；E2=骨干合成（需 e2K 来源条数）。 */
  operator?: "M1" | "E2"
  /** E2 来源反思记录条数（最近 K 条，缺省 3）。 */
  e2K?: number
  /** 历轮汇总统计（引擎侧，不含本轮）；有则生成权威统计块注入反思 prompt。 */
  historyRounds?: RoundSummaryStats[]
  /** 最近一次 M4 元反思产出的全局洞察（有则随知识一起渲染）。 */
  meta?: MetaInsight
  limits?: KnowledgeLimits
  deps?: ReflectDeps
}

/**
 * 一轮完整反射：赛前预测 → 赛后复盘 → 更新 knowledge 并落一条 IterationEntry。
 * 返回更新后的知识体（已 enforceKnowledgeLimits）与该轮 entry。
 */
export async function runRoundReflection(
  options: RoundReflectionOptions,
): Promise<{ knowledge: LLMDeckKnowledge; entry: IterationEntry }> {
  const {
    knowledge,
    round,
    roundSummary,
    records,
    section,
    context,
    opponentDeckCode,
    opponentDeckName,
    parentLineageId,
    operator,
    e2K,
    historyRounds,
    meta,
    limits,
    deps,
  } = options

  const isE2 = operator === "E2"
  const limitsOrDefault = limits ?? DEFAULT_KNOWLEDGE_LIMITS
  // Meta Insight 渲染进 prompt 前先过一次长度治理（持久化侧保留原始内容，见 meta-reflect 输出）。
  const limitedMeta = enforceKnowledgeLimits(knowledge, meta, limitsOrDefault).meta

  const prediction = await preGamePredict({
    knowledge,
    opponentDeckCode,
    opponentDeckName,
    context,
    deps,
  })

  const sectionText = knowledge.refinedKnowledge?.sections[section] ?? ""
  const statsBlock = buildAuthoritativeStats(records, historyRounds)
  const common = {
    knowledge,
    section,
    sectionText,
    roundSummary,
    prediction,
    context,
    statsBlock,
    meta: limitedMeta,
    deps,
  }
  const sourceEntries = knowledge.iterationLog.slice(-(e2K ?? 3))
  const reflection = isE2
    ? await postGameReflectE2({ ...common, sourceEntries })
    : await postGameReflect(common)

  const wins = records.filter((r) => r.result.winner === "me").length
  const losses = records.filter((r) => r.result.winner === "opponent").length
  const rounds = records.map((r) => r.result.totalRounds ?? 0)
  const avgRounds = rounds.length > 0 ? Math.round(rounds.reduce((a, b) => a + b, 0) / rounds.length) : 0

  const entry: IterationEntry = {
    iteration: round,
    timestamp: new Date().toISOString(),
    opponentDeckCode,
    opponentDeckName,
    predictedMatchup: { ...prediction },
    preGameChoices: { mulliganKept: [], openingCharacter: 0, plannedSequence: "" },
    gameResult: {
      winner: records.length === 0 || wins < losses ? "opponent" : "me",
      totalRounds: avgRounds,
      keyTurningPoint: "",
    },
    postGameReflection: {
      predictionAccuracy: reflection.predictionAccuracy,
      whatWasWrong: reflection.whatWasWrong,
      revisedAnalysis: reflection.revisedAnalysis,
    },
    operator: isE2 ? "E2" : "M1",
    targetSection: section,
    parentSectionVersions: isE2
      ? mergeSectionVersions(sourceEntries)
      : { ...(knowledge.refinedKnowledge?.sectionVersions ?? {}) },
    lineageId: parentLineageId ?? randomUUID(),
    ...(isE2 ? { backbone: (reflection as E2BackboneResult).backbone } : {}),
    sampleGames: records.length,
  }

  const next = {
    ...knowledge,
    version: knowledge.version + 1,
    refinedKnowledge: {
      sections: {
        ...(knowledge.refinedKnowledge?.sections ?? {
          matchupNotes: "",
          diceManagement: "",
          cardTempo: "",
          characterSwitching: "",
        }),
        [section]: reflection.updatedSection.trim() === "" ? sectionText : reflection.updatedSection,
      },
      sectionVersions: {
        ...(knowledge.refinedKnowledge?.sectionVersions ?? {}),
        [section]: (knowledge.refinedKnowledge?.sectionVersions?.[section] ?? 0) + 1,
      },
    },
    iterationLog: [...knowledge.iterationLog, entry],
  }
  const limited = enforceKnowledgeLimits(next, meta, limitsOrDefault)
  return { knowledge: limited.knowledge, entry }
}
