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
 * organizer 报告契约的纯函数层（WP4 件 3；编排入口在 organize-run.ts）：
 * 条目/报告类型、条目级校验（与 organizer-report.schema.json 同步）、report.md 渲染。
 * 校验不过 = 条目级剔除并记 invalidEntries（不整报作废，WP4 规格 §4）。
 */

import { existsSync } from "node:fs"
import { join, relative } from "node:path"

export type TaskName = "mentions" | "practice" | "misalign"
export const ALL_TASKS: readonly TaskName[] = ["mentions", "practice", "misalign"]

export interface OrganizerCitation {
  file: string
  game?: string
  seq?: number
  turn?: number
  ruleKey?: string
}

export interface OrganizerEntry {
  id: string
  dimension: "route" | "execution" | "misalign"
  conclusion: string
  citations: OrganizerCitation[]
  mechanicalAnchor?: { kind: string; ruleKey?: string; detail?: string }
  confidence: "high" | "medium" | "low"
  notes?: string
}

export interface InvalidEntry {
  task: TaskName
  index: number
  reason: string
  entry: unknown
}

export interface TaskFailure {
  task: TaskName
  error: string
}

export interface OrganizerReport {
  runDir: string
  model: string
  generatedAt: string
  tasks: Partial<Record<TaskName, OrganizerEntry[]>>
  invalidEntries?: InvalidEntry[]
  taskFailures?: TaskFailure[]
}

// ── 引用白名单（schema x-evidenceFileWhitelist；`*` = 单个路径段通配）──

export interface WhitelistMatcher {
  literal?: string
  re?: RegExp
}

export function compileWhitelist(patterns: string[]): WhitelistMatcher[] {
  return patterns.map((p) => {
    if (!p.includes("*")) return { literal: p }
    const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}$`)
    return { re }
  })
}

export function whitelistMatch(matchers: WhitelistMatcher[], file: string): boolean {
  return matchers.some((m) => (m.literal !== undefined ? m.literal === file : m.re!.test(file)))
}

// ── 条目校验 ─────────────────────────────────────────────────────────

const ANCHOR_KINDS = new Set(["perRuleHitsZero", "thenMiss", "declareEndRatio", "perMethodOpening", "predictionMismatch", "fallbackCluster", "other"])

export function validateEntry(
  raw: unknown,
  ctx: { matchers: WhitelistMatcher[]; packDir: string },
): { ok: true; entry: OrganizerEntry } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "条目不是对象" }
  const e = raw as Record<string, unknown>
  if (typeof e.id !== "string" || e.id.length === 0) return { ok: false, reason: "缺 id 或非字符串" }
  if (e.dimension !== "route" && e.dimension !== "execution" && e.dimension !== "misalign") {
    return { ok: false, reason: `dimension 非法: ${JSON.stringify(e.dimension)}（须 route|execution|misalign）` }
  }
  if (typeof e.conclusion !== "string" || e.conclusion.trim().length === 0) return { ok: false, reason: "缺 conclusion 或为空" }
  if (!Array.isArray(e.citations) || e.citations.length === 0) return { ok: false, reason: "citations 缺失或为空（每条结论强制附引用）" }
  const citations: OrganizerCitation[] = []
  for (let i = 0; i < e.citations.length; i++) {
    const c = e.citations[i]
    if (c === null || typeof c !== "object" || Array.isArray(c)) return { ok: false, reason: `citations[${i}] 不是对象` }
    const co = c as Record<string, unknown>
    if (typeof co.file !== "string" || co.file.length === 0) return { ok: false, reason: `citations[${i}].file 缺失` }
    if (!whitelistMatch(ctx.matchers, co.file)) {
      return { ok: false, reason: `citations[${i}].file 不在 evidencePack 白名单: ${co.file}` }
    }
    if (!existsSync(join(ctx.packDir, co.file))) {
      return { ok: false, reason: `citations[${i}].file 在 evidencePack 中不存在: ${co.file}` }
    }
    if (co.game !== undefined && (typeof co.game !== "string" || !/^game-[0-9]+$/.test(co.game))) {
      return { ok: false, reason: `citations[${i}].game 非法: ${JSON.stringify(co.game)}` }
    }
    for (const k of ["seq", "turn"] as const) {
      if (co[k] !== undefined && (typeof co[k] !== "number" || !Number.isInteger(co[k]) || co[k] < 0)) {
        return { ok: false, reason: `citations[${i}].${k} 须为 ≥0 整数` }
      }
    }
    if (co.ruleKey !== undefined && (typeof co.ruleKey !== "string" || co.ruleKey.length === 0)) {
      return { ok: false, reason: `citations[${i}].ruleKey 须为非空字符串` }
    }
    citations.push({
      file: co.file,
      ...(co.game !== undefined ? { game: co.game } : {}),
      ...(co.seq !== undefined ? { seq: co.seq } : {}),
      ...(co.turn !== undefined ? { turn: co.turn } : {}),
      ...(co.ruleKey !== undefined ? { ruleKey: co.ruleKey } : {}),
    })
  }
  let mechanicalAnchor: OrganizerEntry["mechanicalAnchor"]
  if (e.mechanicalAnchor !== undefined) {
    const a = e.mechanicalAnchor
    if (a === null || typeof a !== "object" || Array.isArray(a)) return { ok: false, reason: "mechanicalAnchor 须为对象" }
    const ao = a as Record<string, unknown>
    if (typeof ao.kind !== "string" || !ANCHOR_KINDS.has(ao.kind)) {
      return { ok: false, reason: `mechanicalAnchor.kind 非法: ${JSON.stringify(ao.kind)}` }
    }
    if (ao.ruleKey !== undefined && (typeof ao.ruleKey !== "string" || ao.ruleKey.length === 0)) {
      return { ok: false, reason: "mechanicalAnchor.ruleKey 须为非空字符串" }
    }
    mechanicalAnchor = {
      kind: ao.kind,
      ...(ao.ruleKey !== undefined ? { ruleKey: ao.ruleKey } : {}),
      ...(ao.detail !== undefined && typeof ao.detail === "string" ? { detail: ao.detail } : {}),
    }
  }
  // misalign 条目 = 机械锚点定位 + 语义归因 + 证据链（B案 §3.3）——锚点必带
  if (e.dimension === "misalign" && mechanicalAnchor === undefined) {
    return { ok: false, reason: "misalign 条目必须带 mechanicalAnchor（机械锚点）" }
  }
  if (e.confidence !== "high" && e.confidence !== "medium" && e.confidence !== "low") {
    return { ok: false, reason: `confidence 非法: ${JSON.stringify(e.confidence)}（须 high|medium|low）` }
  }
  if (e.notes !== undefined && typeof e.notes !== "string") return { ok: false, reason: "notes 须为字符串" }
  return {
    ok: true,
    entry: {
      id: e.id,
      dimension: e.dimension,
      conclusion: e.conclusion,
      citations,
      ...(mechanicalAnchor !== undefined ? { mechanicalAnchor } : {}),
      confidence: e.confidence,
      ...(e.notes !== undefined ? { notes: e.notes } : {}),
    },
  }
}

// ── report.md 渲染 ───────────────────────────────────────────────────

export const DIMENSION_OF_TASK: Record<TaskName, "route" | "execution" | "misalign"> = {
  mentions: "route",
  practice: "execution",
  misalign: "misalign",
}

const DIMENSION_CN: Record<OrganizerEntry["dimension"], string> = {
  route: "路线",
  execution: "执行",
  misalign: "错位",
}

function citationMarkdown(c: OrganizerCitation, relPack: string): string {
  const parts = [c.file]
  if (c.game !== undefined) parts.push(c.game)
  if (c.seq !== undefined) parts.push(`seq${c.seq}`)
  if (c.turn !== undefined) parts.push(`t${c.turn}`)
  if (c.ruleKey !== undefined) parts.push(c.ruleKey)
  const label = parts.join(" ")
  return `[${label}](${relPack}/${c.file})`
}

export function renderMarkdown(
  report: OrganizerReport,
  packDir: string,
  outDir: string,
  taskList: readonly TaskName[],
): string {
  const relPack = relative(outDir, packDir).split("\\").join("/") || "."
  const lines: string[] = [
    `# organizer 三任务报告`,
    ``,
    `- runDir: \`${report.runDir}\``,
    `- model: ${report.model}`,
    `- generatedAt: ${report.generatedAt}`,
    `- evidencePack: ${relPack}/`,
    `- organizer 定位：证据整理者（不打分；终审是人）。置信口径：high=直接机械锚点 / medium=证据链完整需解读 / low=跨局推断。`,
    ``,
    `> 证据缺口标注（B案 §3.1）：author 侧 transcript/harness/reflection 未接入本轮 evidence pack；「模型当时看到了什么输入」在 mentions 任务中不完整，人工终审时请注意。`,
    `> 视角纪律（B案 §6-1）：决策时合理性看玩家视角（stateSignature / fullDigest 摘要）；路线与结局才看上帝视角（draw-sequence / state log）。`,
    ``,
  ]
  for (const task of taskList) {
    const entries = report.tasks[task]
    lines.push(`## ${task}（${DIMENSION_CN[DIMENSION_OF_TASK[task]]}｜${entries?.length ?? 0} 条）`)
    if (!entries) {
      const failure = report.taskFailures?.find((f) => f.task === task)
      lines.push(``, `（任务被隔离：${failure?.error ?? "未知原因"}）`, ``)
      continue
    }
    if (entries.length === 0) lines.push(``, `（无条目）`, ``)
    for (const e of entries) {
      lines.push(`### ${e.id} ［${DIMENSION_CN[e.dimension]}/${e.confidence}］`)
      lines.push(``, e.conclusion, ``)
      lines.push(`- 引用: ${e.citations.map((c) => citationMarkdown(c, relPack)).join("；")}`)
      if (e.mechanicalAnchor) {
        const a = [e.mechanicalAnchor.kind, e.mechanicalAnchor.ruleKey, e.mechanicalAnchor.detail].filter(Boolean).join(" / ")
        lines.push(`- 机械锚点: ${a}`)
      }
      if (e.notes) lines.push(`- 备注: ${e.notes}`)
      lines.push(``)
    }
  }
  if ((report.invalidEntries?.length ?? 0) > 0) {
    lines.push(`## 校验剔除（invalidEntries，${report.invalidEntries!.length} 条）`, ``)
    for (const inv of report.invalidEntries!) {
      lines.push(`- task=${inv.task} index=${inv.index}：${inv.reason}`)
    }
    lines.push(``)
  }
  if ((report.taskFailures?.length ?? 0) > 0) {
    lines.push(`## 任务失败（taskFailures）`, ``)
    for (const f of report.taskFailures!) lines.push(`- ${f.task}: ${f.error}`)
    lines.push(``)
  }
  return `${lines.join("\n")}\n`
}
