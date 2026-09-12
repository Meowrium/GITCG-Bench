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
 * M2 知识通道 schema —— 卡组知识（LLMDeckKnowledge）与 Meta Insight 的结构定义，
 * 以及送入 prompt 前的长度治理（perSection 800 / total 3000，含 Meta Insight）。
 *
 * 与 deck-analysis 的 Ground Truth schema 的关系：
 *   - KeyCard / OpeningSequence 直接复用（import type），知识结构不重复定义。
 *   - preGameAnalysis 是 GT 的「预测/计划」侧，refinedKnowledge 是历轮进化产物。
 *
 * 长度上限依据：SELF-EVOLUTION-IMPL.md（perSection 800 / total 3000）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { GiTcgError } from "@gi-tcg/core"
import type { KeyCard, OpeningSequence } from "../../../deck-analysis/src/annotate/schema"

/** knowledge 通道统一错误类型（GiTcgError 为抽象基类，须子类化）。 */
export class KnowledgeError extends GiTcgError {}

export type SectionId = "diceManagement" | "cardTempo" | "characterSwitching" | "matchupNotes"

/**
 * 分节顺序：
 *   1. 进化时的 round-robin 轮转顺序；
 *   2. 超总量时的压缩顺序（靠前者先被压缩）。
 */
export const SECTION_IDS: readonly SectionId[] = [
  "matchupNotes",
  "diceManagement",
  "cardTempo",
  "characterSwitching",
]

/** 渲染到 prompt 时的小节标题（顺序与 SECTION_IDS 一致）。 */
export const SECTION_LABELS: Record<SectionId, string> = {
  diceManagement: "骰子管理",
  cardTempo: "出牌与技能节奏",
  characterSwitching: "切人时机",
  matchupNotes: "matchup 专项",
}

/** M2 每次进化只更新一个分节（round-robin），其余分节原样保留。 */
export interface SectionedRefinedKnowledge {
  sections: Record<SectionId, string>
  /** 分节级版本号：sectionVersions[sid] 表示该分节被更新过的次数。 */
  sectionVersions: Partial<Record<SectionId, number>>
}

/** 开局前的静态分析（来自 GT 卡组内秉属性 + 一次 LLM 调用），不随对局演进。 */
export interface PreGameAnalysis {
  openingSequences: OpeningSequence[]
  keyCards: KeyCard[]
  damageMode: string
  powerCurve: string
}

/** 每轮对战（一个 matchup 的一场）产生的进化记录。 */
export interface IterationEntry {
  iteration: number
  timestamp: string
  opponentDeckCode: string
  opponentDeckName: string
  predictedMatchup: {
    tempoShift: string
    reactionAdvantage: string
    threatResponse: string
    overallDirection: string
    decisiveFactor: string
  }
  preGameChoices: {
    mulliganKept: number[]
    openingCharacter: number
    plannedSequence: string
  }
  gameResult: {
    winner: "me" | "opponent"
    totalRounds: number
    keyTurningPoint: string
  }
  postGameReflection: {
    predictionAccuracy: "correct" | "partial" | "wrong"
    whatWasWrong: string
    revisedAnalysis: string
  }
  /** 产生本次更新的算子：M1=复盘算子、M2=知识算子、E1/E2=进化算子。 */
  operator: "M1" | "M2" | "E1" | "E2"
  /** 本次更新落在哪个分节（仅 E 系列算子产生内容更新）。 */
  targetSection: SectionId
  /** 更新前的分节版本号快照。 */
  parentSectionVersions: Partial<Record<SectionId, number>>
  /** 血缘链 id：从初始知识到当前状态的逐次演化路径。 */
  lineageId: string
  /** E2 骨干合成时写入的来源反思骨干（M1 等算子产生的条目省略）。 */
  backbone?: string
  /** 本次反思基于的有效样本局数（2026-08-20 起写入）。
   *  resume 续算补局后若该局数增大，旧反思条目作废并基于全量样本重新反思。 */
  sampleGames?: number
}

/** 单套卡组的完整知识体：静态分析 + 历轮迭代记录 + 当前精炼知识。 */
export interface LLMDeckKnowledge {
  deckCode: string
  createdAt: string
  /** 0 = 仅 preGameAnalysis；每经过一轮 M2 进化 +1。 */
  version: number
  preGameAnalysis: PreGameAnalysis
  iterationLog: IterationEntry[]
  refinedKnowledge?: SectionedRefinedKnowledge
}

/** Meta Insight 是跨卡组的全局洞察，计入 total 上限但独立于四个分节。 */
export interface MetaInsight {
  convergenceDiagnosis: string
  limitationAnalysis: string
  pathSuggestion: string
}

export const META_FIELDS = ["convergenceDiagnosis", "limitationAnalysis", "pathSuggestion"] as const

export const META_LABELS: Record<(typeof META_FIELDS)[number], string> = {
  convergenceDiagnosis: "收敛诊断",
  limitationAnalysis: "局限分析",
  pathSuggestion: "改进路径",
}

export interface KnowledgeLimits {
  /** 每个分节（及每个 Meta Insight 字段）的字符上限。 */
  perSection: number
  /** 四节 + Meta 三字段的合计字符上限。 */
  total: number
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = { perSection: 800, total: 3000 }

export const ELLIPSIS = "…"

export interface KnowledgeTruncation {
  /** 被截断/压缩过的分节（去重）。 */
  sections: SectionId[]
  /** Meta Insight 是否被截断/压缩过。 */
  meta: boolean
}

/**
 * 单步压缩：把 text 削到大约一半，末尾接省略号。
 * 保证输出严格短于输入（至少 1 字符），避免死循环。
 * 注意传入的必须是纯文本（不含 Markdown 结构），压缩后仍合法。
 */
function shrink(text: string): string {
  if (text.length <= 1) {
    return ""
  }
  const keep = Math.floor(text.length / 2)
  const out = text.slice(0, keep) + ELLIPSIS
  return out.length >= text.length ? text.slice(0, keep - 1) + ELLIPSIS : out
}

/**
 * 强制知识长度上限（纯函数，不修改入参，返回截断后的新对象）。
 *
 * 规则：
 *   1. 先按 perSection 硬截（slice + 省略号）：四个分节 + Meta 三个字段；
 *   2. 合计仍超 total 时，按 SECTION_IDS 顺序逐节压缩（matchupNotes 最先）；
 *   3. 全部分节压空仍超时，再依次压缩 Meta 三个字段；
 *   4. 返回 truncated 记录实际发生了哪些截断/压缩。
 */
export function enforceKnowledgeLimits(
  knowledge: LLMDeckKnowledge,
  meta?: MetaInsight,
  limits: KnowledgeLimits = DEFAULT_KNOWLEDGE_LIMITS,
): { knowledge: LLMDeckKnowledge; meta?: MetaInsight; truncated: KnowledgeTruncation } {
  const truncated: KnowledgeTruncation = { sections: [], meta: false }

  const refine = knowledge.refinedKnowledge
  if (!refine) {
    return { knowledge, meta, truncated }
  }

  const sections = { ...refine.sections }
  for (const id of SECTION_IDS) {
    const text = sections[id]
    if (text.length > limits.perSection) {
      sections[id] = text.slice(0, limits.perSection) + ELLIPSIS
      truncated.sections.push(id)
    }
  }

  let newMeta = meta
  if (meta) {
    const next: Record<(typeof META_FIELDS)[number], string> = { ...meta }
    for (const field of META_FIELDS) {
      if (next[field].length > limits.perSection) {
        next[field] = next[field].slice(0, limits.perSection) + ELLIPSIS
        truncated.meta = true
      }
    }
    newMeta = { convergenceDiagnosis: next.convergenceDiagnosis, limitationAnalysis: next.limitationAnalysis, pathSuggestion: next.pathSuggestion }
  }

  let total = 0
  for (const id of SECTION_IDS) {
    total += sections[id].length
  }
  if (newMeta) {
    for (const field of META_FIELDS) {
      total += newMeta[field].length
    }
  }

  // 超总量：先按 SECTION_IDS 顺序压分节，压空再压 meta。
  for (const id of SECTION_IDS) {
    while (total > limits.total && sections[id].length > 0) {
      const before = sections[id]
      sections[id] = shrink(before)
      total -= before.length - sections[id].length
      if (!truncated.sections.includes(id)) {
        truncated.sections.push(id)
      }
    }
  }
  if (newMeta) {
    for (const field of META_FIELDS) {
      while (total > limits.total && newMeta[field].length > 0) {
        const before = newMeta[field]
        newMeta[field] = shrink(before)
        total -= before.length - newMeta[field].length
        truncated.meta = true
      }
    }
  }

  return {
    knowledge: {
      ...knowledge,
      refinedKnowledge: { ...refine, sections },
    },
    meta: newMeta,
    truncated,
  }
}

/**
 * 渲染知识为 prompt 片段：首行标题 + preGameAnalysis 摘要 + 四个分节小节，
 * meta 存在时追加 `### Meta Insight` 小节。空分节/空字段不输出。
 */
export function renderKnowledgeForPrompt(knowledge: LLMDeckKnowledge, meta?: MetaInsight): string {
  const lines: string[] = ["## 卡组知识（历史对战积累）"]

  const pre = knowledge.preGameAnalysis
  lines.push(`- 伤害模式：${pre.damageMode}`)
  lines.push(`- 强度曲线：${pre.powerCurve}`)
  if (pre.keyCards.length > 0) {
    lines.push(`- 关键卡：${pre.keyCards.map((k) => k.id).join("、")}`)
  }
  const primarySeq = pre.openingSequences.find((s) => s.isPrimary)
  if (primarySeq) {
    lines.push(`- 开局序列「${primarySeq.name}」：${primarySeq.steps.map((s) => s.action).join(" → ")}`)
  }

  const refine = knowledge.refinedKnowledge
  if (refine) {
    for (const id of SECTION_IDS) {
      const text = refine.sections[id]
      if (text.length > 0) {
        lines.push(`### ${SECTION_LABELS[id]}`)
        lines.push(text)
      }
    }
  }

  if (meta) {
    lines.push("### Meta Insight")
    for (const field of META_FIELDS) {
      const text = meta[field]
      if (text.length > 0) {
        lines.push(`- ${META_LABELS[field]}：${text}`)
      }
    }
  }

  return lines.join("\n")
}

/** 新建一份空知识体（version 0，仅静态分析占位，无迭代记录）。 */
export function createEmptyKnowledge(deckCode: string): LLMDeckKnowledge {
  return {
    deckCode,
    createdAt: new Date().toISOString(),
    version: 0,
    preGameAnalysis: {
      openingSequences: [],
      keyCards: [],
      damageMode: "",
      powerCurve: "",
    },
    iterationLog: [],
    refinedKnowledge: {
      sections: {
        matchupNotes: "",
        diceManagement: "",
        cardTempo: "",
        characterSwitching: "",
      },
      sectionVersions: {},
    },
  }
}

/** 持久化知识体到 JSON 文件（父目录自动创建）。 */
export function saveKnowledge(knowledge: LLMDeckKnowledge, file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(knowledge, null, 2)}\n`, "utf-8")
}

/** 从 JSON 文件加载知识体，形状不合法时抛 GiTcgError。 */
export function loadKnowledge(file: string): LLMDeckKnowledge {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"))
  } catch (err) {
    throw new KnowledgeError(
      `读取知识文件失败: ${file}（${err instanceof Error ? err.message : String(err)}）`,
    )
  }
  const k = parsed as Partial<LLMDeckKnowledge>
  if (
    typeof k?.deckCode !== "string" ||
    typeof k.version !== "number" ||
    !Array.isArray(k.iterationLog)
  ) {
    throw new KnowledgeError(`知识文件形状不合法: ${file}`)
  }
  return parsed as LLMDeckKnowledge
}
