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

import { EvolveError } from "./llm-client"
import { extractJsonObject, makeDefaultCallLlm, requireStringFields } from "./reflect"
import type { CallLlm, ReflectDeps } from "./reflect"
import { SECTION_IDS } from "../knowledge/schema"
import type { IterationEntry, MetaInsight, SectionId } from "../knowledge/schema"

/**
 * M4 元反思（跨轮全局诊断）。
 *
 * 阶段 2 引入：每 ne 轮 NE 后触发一次，基于近期轮次的对局表现与历轮反思记录，
 * 输出收敛诊断（premature/steady/oscillating/stagnant）、局限分析与下一步路径建议
 * （建议的分节与算子，供 run.ts 在下一轮消费）。
 *
 * 建议的下一轮路径（无建议时为 undefined）。
 */
export interface MetaPathway {
  suggestedSection?: SectionId
  suggestedOperator?: "M1" | "E2"
}

/** 近几轮的汇总统计（由 run.ts 维护传入）。 */
export interface RoundSummaryStats {
  round: number
  wins: number
  losses: number
  draws: number
  errors: number
  assembleFailures: number
  /** 本轮有效局的平均回合数（2026-08-20 起写入；供权威统计块使用）。 */
  avgRounds?: number
}

export interface MetaReflectionOptions {
  /** 当前轮序号（0 基，M4 在其后触发）。 */
  round: number
  roundSummaries: RoundSummaryStats[]
  /** 历轮反思记录（只读，供诊断用）。 */
  iterationLog: IterationEntry[]
  /** 违规率（当前数据源未接入，恒 null）。 */
  violationRate?: number | null
  /** 引擎算法背景（与预测/复盘 prompt 同一来源）。 */
  context: string
  deps?: ReflectDeps
}

export interface MetaReflectionResult {
  insight: MetaInsight
  pathway: MetaPathway
}

const CONVERGENCE_VALUES = new Set(["premature", "steady", "oscillating", "stagnant"])

/**
 * 元反思 prompt：跨轮元反思，输出收敛诊断与路径建议。
 * 注意：不得包含"骨干"/"复盘"字样，否则与 E2/M1 的 mock 分流冲突。
 */
const META_PROMPT = `请执行一次跨轮元反思，基于近期轮次的对局表现与历轮反思记录，给出全局收敛诊断与下一步路径建议。
只输出一个 JSON 对象，不要 Markdown 代码块，不要任何其他文字。字段：
- convergenceDiagnosis: "premature" | "steady" | "oscillating" | "stagnant"（收敛诊断：premature=过早收敛、steady=稳定收敛、oscillating=震荡反复、stagnant=停滞不增）
- limitationAnalysis: 当前进化机制的主要局限（字符串，中文，100-300 字）
- pathwayRecommendation: 对象，包含：
  - suggestedSection: "matchupNotes" | "diceManagement" | "cardTempo" | "characterSwitching" | null（建议下一轮更新的知识分节；无明确建议则 null）
  - suggestedOperator: "M1" | "E2" | null（建议下一轮使用的反思算子；无明确建议则 null）
  - text: 路径建议说明（字符串，中文，100-300 字）`

/** 与 reflect.ts 同构的 LLM 解析（本地复制 resolveCallLlm，reflect 的未导出）。 */
function resolveCallLlm(deps: ReflectDeps): CallLlm {
  if (deps.callLlm) {
    return deps.callLlm
  }
  const { apiBase, apiKey, model } = deps
  if (typeof apiBase === "string" && typeof apiKey === "string" && typeof model === "string") {
    return makeDefaultCallLlm({ apiBase, apiKey, model })
  }
  throw new EvolveError("缺少 LLM 调用配置：需提供 callLlm，或 apiBase/apiKey/model 三者齐全")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>
  }
  return null
}

/** 解析元反思输出；不合法时抛 EvolveError（触发带纠错提示的重试）。 */
function parseMetaOutput(value: unknown): MetaReflectionResult {
  const obj = asRecord(value)
  if (!obj) {
    throw new EvolveError("元反思: 输出不是 JSON 对象")
  }
  const diagnosis = obj.convergenceDiagnosis
  if (typeof diagnosis !== "string") {
    throw new EvolveError("元反思: 字段 convergenceDiagnosis 缺失或不是字符串")
  }
  if (!CONVERGENCE_VALUES.has(diagnosis)) {
    throw new EvolveError(
      `元反思: convergenceDiagnosis 必须是 premature/steady/oscillating/stagnant 之一（得到 ${diagnosis}）`,
    )
  }
  const lim = requireStringFields(obj, ["limitationAnalysis"], "元反思")
  const pw = asRecord(obj.pathwayRecommendation)
  if (!pw) {
    throw new EvolveError("元反思: 字段 pathwayRecommendation 缺失或不是对象")
  }
  const pwText = requireStringFields(pw, ["text"], "元反思")
  const pathway: MetaPathway = {}
  const ss = pw.suggestedSection
  if (typeof ss === "string" && (SECTION_IDS as readonly string[]).includes(ss)) {
    pathway.suggestedSection = ss as SectionId
  }
  const so = pw.suggestedOperator
  if (typeof so === "string" && (so === "M1" || so === "E2")) {
    pathway.suggestedOperator = so
  }
  return {
    insight: {
      convergenceDiagnosis: diagnosis,
      limitationAnalysis: lim.limitationAnalysis,
      pathSuggestion: pwText.text,
    },
    pathway,
  }
}

/**
 * 跨轮元反思（M4）。输出解析失败时带纠错提示重试一次；
 * 两次都失败则抛 EvolveError（run.ts 将终止本次运行，M4 失败不静默吞掉）。
 */
export async function generateMetaInsight(
  options: MetaReflectionOptions,
): Promise<MetaReflectionResult> {
  const { round, roundSummaries, iterationLog, violationRate, context, deps } = options
  const callLlm = resolveCallLlm(deps ?? {})
  const system = [
    `你是《七圣召唤》竞技对局进化的元反思助手。以下是引擎算法背景（TurnDigestV1 结构、决策工具、规则速查）：`,
    "",
    context,
  ].join("\n")
  const user = [
    META_PROMPT,
    "",
    `## 近期轮次汇总`,
    roundSummaries.map((s) => `round ${s.round}: ${s.wins}胜/${s.losses}负/${s.draws}平/${s.errors}错 组装失败${s.assembleFailures}`).join("\n"),
    "",
    `## 历轮反思记录（只读）`,
    iterationLog
      .map((e) =>
        [
          `- iteration ${e.iteration}: operator=${e.operator}, targetSection=${e.targetSection}, predictionAccuracy=${e.postGameReflection.predictionAccuracy}`,
          `  whatWasWrong: ${e.postGameReflection.whatWasWrong}`,
          `  revisedAnalysis: ${e.postGameReflection.revisedAnalysis}`,
          ...(e.backbone !== undefined ? [`  backbone: ${e.backbone}`] : []),
        ].join("\n"),
      )
      .join("\n") || "（无）",
    "",
    `## 违规率曲线`,
    violationRate != null ? `- violationRate: ${violationRate}` : "（无违规率数据，可忽略）",
    "",
    `## 引擎算法背景`,
    context,
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
      return parseMetaOutput(extractJsonObject(text))
    } catch (err) {
      lastError = err
    }
  }
  throw new EvolveError(
    `元反思失败（round ${round}）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
