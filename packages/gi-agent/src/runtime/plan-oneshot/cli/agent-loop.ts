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
 * 有界 agent 循环驱动器（plan harness 核心，设计文档 2026-08-28-agentic-plan-harness）。
 *
 * author / reflect 两个 CLI 共用的多轮交互骨架：LLM 每轮输出一个 JSON 命令
 * （request_modules / draft / final，reflect 修订模式另有 patch），本驱动器负责
 * 维护对话历史、解析命令、执行模块预算闸、调用校验回调、聚合并返回效率统计
 * （轮次 / 模块调用量 / token / patch 与协议抢救计数）。
 *
 * patch（2026-08-29 迭代动力学对策）：LLM 不再重发完整计划，而是提交受限 ops
 * 由 applyPatch 回调在服务端合并到当前决策树（plan-patch.ts）；ops 未触及的规则
 * 默认 keep。协议错误抢救（salvage）：模型漏写 action 包装但输出里带完整产物时，
 * 自动按 draft 受理——r2 实测 34k reasoning 因协议错误整体丢弃的教训。
 *
 * 本模块不写文件——sidecar（harness.json / transcript.jsonl）由调用方落盘，
 * 以便单元测试用 mock responder 全离线运行。
 */

import { chatCompletion, extractJson } from "./llm.js"
import type { HarnessChatMessage } from "./llm.js"
import type { PlanLintFinding } from "../fields-lint.js"

export type { HarnessChatMessage } from "./llm.js"

/** LLM 的模块索取请求（kind 必填，id 视模块类型而定） */
export interface ModuleRequest {
  kind: string
  id?: string | number
  reason?: string
}

/** harness 送达的一个模块内容块 */
export interface ServedModule {
  /** 展示键，如 "card_detail:311301" / "fewshot_plan" */
  key: string
  content: string
}

/** draft/final 校验回调的返回 */
export interface PayloadCheck<D> {
  ok: boolean
  /** 未通过时回注给 LLM 的问题列表 */
  issues: string[]
  /** 通过时的规范化产物（轮次耗尽时回退用） */
  result?: D
  /** 通过时回注的形态统计说明（如 "rules=26 phases=2"） */
  statsNote?: string
  /**
   * 静态 lint 发现（可选，调用方在跑过 lintPlan 时填；harness 统计消费——
   * 进 `counters.lintFindings` / `issueHistogram.lint`，`kind="card-face"` 的条目
   * 另进 `issueHistogram.cardFace` 与 `counters.cardFaceFixed` 的键追踪）。
   * 传数字为旧口径（仅计数、不追踪键）。
   */
  lintFindings?: PlanLintFinding[] | number
}

/** patch 命令载荷（ops 由 plan-patch.ts 解析与合并；调用方负责领域校验） */
export interface PatchCommand {
  ops: unknown
  predictionPostmortem?: unknown
  predictions?: unknown
}

/**
 * switch_route 命令载荷（reflect 换轴：从 alternates 旁档的候选树做单元级嫁接）。
 * 字段原样透传，语法/守卫由调用方（run-plan-reflect 的 applyRouteSwitch）校验。
 */
export interface RouteSwitchCommand {
  candidateIndex: unknown
  units: unknown
  reason?: string
  falsifiableClaim?: string
}

/** patch 命令处理回调的返回 */
export interface PatchApplyResult {
  ok: boolean
  issues: string[]
  /** 通过时回注的合并摘要（合并形态 / 静态回放核验 / 断言结果） */
  statsNote?: string
  /**
   * 静态 lint 发现（可选，合并核验跑过 lintPlan 时填；harness 统计消费——
   * 进 `counters.lintFindings` / `issueHistogram.lint`，`kind="card-face"` 的条目
   * 另进 `issueHistogram.cardFace` 与 `counters.cardFaceFixed` 的键追踪）。
   * 传数字为旧口径（仅计数、不追踪键）。
   */
  lintFindings?: PlanLintFinding[] | number
}

/** final 收尾核验回调的返回（patch 模式的静态回放/断言报告；前两次不过则打回） */
export interface FinalGateResult {
  passed: boolean
  report: string
}

export interface AgentLoopLlmOptions {
  model?: string
  maxTokens: number
  temperature: number
  /** 基础 seed；第 i 轮（0 起）实际使用 seed+i（沿用修复循环的变 seed 纪律） */
  seed?: number
  thinking: boolean
  stream: boolean
}

export interface AgentLoopOptions<D> {
  label: "author" | "reflect"
  system: string
  initialUser: string
  /** LLM 响应轮次上限（含首轮），>= 2 才进入本循环 */
  maxTurns: number
  /** 全程模块送达总量预算 */
  moduleBudget: number
  /** 单轮最多送达模块数 */
  perTurnModuleLimit: number
  llm: AgentLoopLlmOptions
  resolveModules: (requests: ModuleRequest[]) => Promise<ServedModule[]>
  /** draft / final 共用同一校验管线；仅终止语义不同 */
  check: (action: "draft" | "final", payload: unknown) => PayloadCheck<D> | Promise<PayloadCheck<D>>
  /** patch 命令处理（reflect 修订模式；缺省 = patch 未启用，输出协议错误） */
  applyPatch?: (cmd: PatchCommand) => Promise<PatchApplyResult>
  /**
   * switch_route 命令处理（reflect 换轴；缺省 = 未启用，输出协议错误）。
   * 仅在 --patch harness 模式且 run 目录存在 alternates 旁档时由调用方提供。
   */
  applySwitchRoute?: (cmd: RouteSwitchCommand) => Promise<PatchApplyResult>
  /**
   * final 收尾核验（patch 模式建议提供：静态回放 diff + 断言报告）。
   * 前 2 次 final 未通过核验则打回继续，第 3 次起放行（防死循环）。
   */
  finalGate?: (result: D) => Promise<FinalGateResult>
  /** 测试注入点：替代真实 chatCompletion */
  responder?: (
    messages: HarnessChatMessage[],
    llm: AgentLoopLlmOptions & { seed?: number },
  ) => Promise<{ content: string; reasoningContent?: string; usage?: Record<string, unknown> }>
}

export interface HarnessTurnRecord {
  turn: number
  /** assistant 原始输出（content；content 空时为 reasoning 摘要标记） */
  raw: string
  command: string | null
  /** harness 回注的 user 消息（模块内容 / 校验反馈 / 协议错误） */
  feedback: string
  usage?: Record<string, unknown>
  latencyMs: number
}

export interface HarnessStats {
  label: string
  model: string
  turns: number
  terminatedBy: "final" | "turn_cap_draft" | "failed"
  /** 轮次耗尽回退时，实际采用的 draft 出自第几轮 */
  adoptedDraftTurn?: number
  moduleRequests: {
    total: number
    perKind: Record<string, number>
    log: Array<{ turn: number; kind: string; id?: string | number; reason?: string }>
  }
  drafts: number
  finalAttempts: number
  protocolErrors: number
  /** 被抢救的协议错误数（漏 action 包装但产物完整，已按 draft 受理） */
  salvaged: number
  /** 被合并的 patch 命令数（仅 reflect 修订模式） */
  patches: number
  /**
   * 被成功嫁接的 switch_route 命令数（reflect 换轴，仅 --patch harness 模式且
   * 注入「替代路线参考」段时可用；被拒的 switch_route 计入
   * issueHistogram.patchRejected / rejected[stage=patch]，与 patch 被拒同口径）。
   */
  routeSwitches: number
  /** 被 finalGate 打回的 final 次数 */
  gatedFinals: number
  /**
   * 校验期 issue 类别直方图（WP2 P0-4）：draft/final 校验未通过的 issues 逐条按
   * `classifyIssueText` 机械分类（deadRule/closedSet/format），协议错误轮计 format，
   * patch 被拒的 issues 计 patchRejected（逐条），lint findings 计 lint（逐条）。
   * 2026-09-08 起 lint 按 `finding.kind` 分桶：`card-face` = 卡面数值校核发现
   * （lint 的子集，不再靠 message 文本分类）。
   */
  issueHistogram: { deadRule: number; format: number; closedSet: number; lint: number; cardFace: number; patchRejected: number }
  /**
   * 被拒 draft/patch 逐条留档（WP2 P0-4）：stage=draft = draft/final 校验未通过
   * （reasonCode = 主导 issue 类别），stage=patch = patch 被拒（reasonCode 恒
   * "patchRejected"）。detail = 回注 issues 的拼接截断（≤200 字）。协议错误轮与
   * finalGate 打回不进本表（前者只进 issueHistogram.format，后者已有 gatedFinals）。
   */
  rejected: Array<{ stage: "draft" | "patch"; round: number; reasonCode: string; detail: string }>
  /**
   * WP2 P0-4 计数器：lintFindings = 累计 lint 发现数；droppedAttempts = 被丢弃的
   * attempt（draft/final 校验未通过 + patch 被拒 + 协议错误轮）；totalAttempts =
   * draft/final/patch 命令轮 + 协议错误轮（request_modules 不算 attempt）。
   * 2026-09-08：cardFaceFixed = 循环内早前 draft/patch lint 出现过、但最终采纳稿的
   * lint 未再出现的 card-face finding 键（kind|path|message）去重计数——LLM 主动
   * 修正卡面数值错误的次数探针。
   */
  counters: { lintFindings: number; droppedAttempts: number; totalAttempts: number; cardFaceFixed: number }
  /**
   * content 为空（仅思考链，如烧穿 maxTokens）的轮次统计：
   * total = 发生次数；salvaged = 从思考链提取出有效 JSON 并当作输出的次数；
   * failed = 思考链无有效 JSON、按协议错误处理的次数。benchmark 质量探针。
   */
  reasoningOnly: { total: number; salvaged: number; failed: number }
  tokens: { prompt: number; completion: number; reasoning: number; available: boolean }
  wallMs: number
  /** 失败时的错误说明 */
  error?: string
}

export interface AgentLoopOutcome<D> {
  status: HarnessStats["terminatedBy"]
  /** final 通过时为 final 产物；turn_cap_draft 时为最近通过校验的 draft 产物 */
  result?: D
  stats: HarnessStats
  turns: HarnessTurnRecord[]
}

interface Command {
  action: "request_modules" | "draft" | "final" | "patch" | "switch_route"
  requests?: ModuleRequest[]
  /** 命令级 reason（request_modules 的整批理由；请求级 reason 优先） */
  reason?: string
  /** draft/final 的产物载荷：author 用 plan 键，reflect 用 result 键，两者都接受 */
  payload?: unknown
  /** patch 命令载荷 */
  patch?: PatchCommand
  /** switch_route 命令载荷 */
  routeSwitch?: RouteSwitchCommand
}

/** 当前回合可用的命令集合（协议错误提示与未知 action 报错按此列出） */
interface CommandActions {
  patch: boolean
  switchRoute: boolean
}

/** 协议错误反馈里的命令格式提示（两处共用；draft/final 的产物键 plan / result 均可） */
function protocolHint(remaining: number, actions: CommandActions): string {
  const extra = [
    ...(actions.patch ? ['{"action":"patch","ops":[...]}'] : []),
    ...(actions.switchRoute
      ? ['{"action":"switch_route","candidateIndex":<候选序号>,"units":["opening"|"fallback"|"rules"|"phase:<phaseId>"],"reason":"...","falsifiableClaim":"..."}']
      : []),
  ]
  return `每轮只输出一个 JSON 命令：{"action":"request_modules",...} / {"action":"draft","plan":{...}} / {"action":"final","plan":{...}}（draft/final 的产物也可放 "result" 键${extra.length > 0 ? `；本回合另有 ${extra.join(" / ")}` : ""}；剩余 ${remaining} 轮）。`
}

function parseCommand(raw: string, actions: CommandActions): Command {
  const parsed = extractJson(raw) as Record<string, unknown>
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("输出不是 JSON 对象")
  }
  const action = parsed.action
  if (action === "request_modules" || action === "draft" || action === "final") {
    return {
      action,
      requests: Array.isArray(parsed.requests) ? (parsed.requests as ModuleRequest[]) : undefined,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      payload: parsed.plan ?? parsed.result,
    }
  }
  if (action === "patch") {
    return {
      action,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      patch: { ops: parsed.ops, predictionPostmortem: parsed.predictionPostmortem, predictions: parsed.predictions },
    }
  }
  if (action === "switch_route") {
    return {
      action,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      routeSwitch: {
        candidateIndex: parsed.candidateIndex,
        units: parsed.units,
        reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
        falsifiableClaim: typeof parsed.falsifiableClaim === "string" ? parsed.falsifiableClaim : undefined,
      },
    }
  }
  const valid = ["request_modules", "draft", "final", ...(actions.patch ? ["patch"] : []), ...(actions.switchRoute ? ["switch_route"] : [])]
  throw new Error(`未知 action：${String(action)}（可选 ${valid.join(" / ")}）`)
}

/**
 * 协议错误抢救：模型输出完整产物但漏写 action 包装（round25-r2 实测 34k reasoning
 * 因此整体丢弃）。识别四类可抢救形态，按 draft / patch / switch_route 受理：
 * ① 顶层 plan / result 键；② 顶层即 GamePlanV1；③ 顶层即 ReflectPlanResultV1
 * （或含 ruleVerdicts 数组）；④ 含 ops 数组（漏 action 的 patch）；⑤ 含
 * units + candidateIndex（漏 action 的 switch_route）。
 */
function salvageCommand(raw: string): Command | null {
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  if (Array.isArray(o.ops)) {
    return { action: "patch", patch: { ops: o.ops, predictionPostmortem: o.predictionPostmortem, predictions: o.predictions } }
  }
  if (Array.isArray(o.units) && o.candidateIndex !== undefined) {
    return {
      action: "switch_route",
      routeSwitch: {
        candidateIndex: o.candidateIndex,
        units: o.units,
        reason: typeof o.reason === "string" ? o.reason : undefined,
        falsifiableClaim: typeof o.falsifiableClaim === "string" ? o.falsifiableClaim : undefined,
      },
    }
  }
  const payload = o.plan ?? o.result
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { action: "draft", payload }
  }
  if (o.version === "GamePlanV1" || o.version === "ReflectPlanResultV1" || Array.isArray(o.ruleVerdicts)) {
    return { action: "draft", payload: o }
  }
  return null
}

function accumulateUsage(
  tokens: HarnessStats["tokens"],
  usage: Record<string, unknown> | undefined,
): void {
  if (!usage) return
  tokens.available = true
  tokens.prompt += Number(usage.prompt_tokens ?? 0) || 0
  tokens.completion += Number(usage.completion_tokens ?? 0) || 0
  const details = usage.completion_tokens_details as Record<string, unknown> | undefined
  tokens.reasoning += Number(details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0) || 0
}

// ── WP2 P0-4：issue 分类计数 + 被拒留档（纯统计，不改反馈文本与决策路径）──

/** issue 文本类别（issueHistogram 键中的三分类；lint/patchRejected 由事件源直接给定） */
export type IssueCategory = "deadRule" | "format" | "closedSet"

/**
 * issue 类别机械分类：deadRule（死规则/引用牌表外 defId/永不命中）优先于
 * closedSet（封闭集合违规：ruleRef 不在原计划/当前树、未知 field/op/层、层前缀），
 * 其余归 format。口径注记同步 docs/oracle-free-harness-metrics.md §7.1。
 */
export function classifyIssueText(text: string): IssueCategory {
  if (/死规则|dead\s*rule|not in deck|not in opponent deck|牌表外|永不命中|never\s*match/i.test(text)) return "deadRule"
  if (/不在原计划|不在当前树|不在.{0,6}计划|封闭集合|合法值形如|未知\s*(op|action|键|层)|unknown\s*(field|op|action|layer|key)|层前缀|不存在/i.test(text)) return "closedSet"
  return "format"
}

/** rejected[].detail 截断上限（规格 §2.3：≤200 字） */
const REJECTED_DETAIL_MAX = 200

function rejectedDetail(issues: string[]): string {
  const joined = issues.join("；")
  return joined.length > REJECTED_DETAIL_MAX ? `${joined.slice(0, REJECTED_DETAIL_MAX - 1)}…` : joined
}

/** 被拒留档的 reasonCode：逐 issue 分类计数后取主导类别（平票按 deadRule > closedSet > format） */
function dominantIssueCategory(issues: string[]): IssueCategory {
  const perCat: Partial<Record<IssueCategory, number>> = {}
  for (const issue of issues) perCat[classifyIssueText(issue)] = (perCat[classifyIssueText(issue)] ?? 0) + 1
  const order: IssueCategory[] = ["deadRule", "closedSet", "format"]
  return order
    .filter((c) => (perCat[c] ?? 0) > 0)
    .sort((a, b) => (perCat[b] ?? 0) - (perCat[a] ?? 0))[0] ?? "format"
}

/** 模块内容块拼成一条 user 消息 */
function formatServedModules(served: ServedModule[], notices: string[]): string {
  const parts = served.map((m) => `## ${m.key}\n\n${m.content}`)
  if (notices.length > 0) parts.unshift(notices.map((n) => `（${n}）`).join("\n"))
  return `# harness 送达的模块\n\n${parts.join("\n\n")}\n\n继续：输出下一个 JSON 命令。`
}

export async function runAgentLoop<D>(opts: AgentLoopOptions<D>): Promise<AgentLoopOutcome<D>> {
  const startedAt = Date.now()
  const messages: HarnessChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.initialUser },
  ]
  const respond = opts.responder ?? (async (msgs: HarnessChatMessage[], llm: AgentLoopLlmOptions & { seed?: number }) => {
    const r = await chatCompletion({ messages: msgs, ...llm })
    return { content: r.content, reasoningContent: r.reasoningContent, usage: r.usage }
  })

  const stats: HarnessStats = {
    label: opts.label,
    model: opts.llm.model ?? "(env default)",
    turns: 0,
    terminatedBy: "failed",
    moduleRequests: { total: 0, perKind: {}, log: [] },
    drafts: 0,
    finalAttempts: 0,
    protocolErrors: 0,
    salvaged: 0,
    patches: 0,
    routeSwitches: 0,
    gatedFinals: 0,
    issueHistogram: { deadRule: 0, format: 0, closedSet: 0, lint: 0, cardFace: 0, patchRejected: 0 },
    rejected: [],
    counters: { lintFindings: 0, droppedAttempts: 0, totalAttempts: 0, cardFaceFixed: 0 },
    reasoningOnly: { total: 0, salvaged: 0, failed: 0 },
    tokens: { prompt: 0, completion: 0, reasoning: 0, available: false },
    wallMs: 0,
  }
  // P0-4 记录器：issue 分类计数 / 被拒留档 / lint / attempt 计数（只写 stats，不碰 feedback）
  // 2026-09-08：lint 发现按 finding.kind 分桶（card-face 进 issueHistogram.cardFace），
  // 并追踪 card-face 键的「曾出现 → 最终采纳稿不再出现」差值（counters.cardFaceFixed）。
  const lintKeyOf = (f: PlanLintFinding): string => `${f.kind}|${f.path}|${f.message}`
  const seenCardFaceKeys = new Set<string>()
  let lastLintKeys: string[] = []
  let acceptedLintKeys = new Set<string>()
  const recordLintFindings = (findings: PlanLintFinding[] | number | undefined): void => {
    if (findings === undefined) return
    if (typeof findings === "number") {
      lastLintKeys = []
      if (findings <= 0) return
      stats.issueHistogram.lint += findings
      stats.counters.lintFindings += findings
      return
    }
    lastLintKeys = findings.map(lintKeyOf)
    if (findings.length === 0) return
    stats.issueHistogram.lint += findings.length
    stats.counters.lintFindings += findings.length
    for (const f of findings) {
      if (f.kind !== "card-face") continue
      stats.issueHistogram.cardFace++
      seenCardFaceKeys.add(lintKeyOf(f))
    }
  }
  const recordRejected = (stage: "draft" | "patch", round: number, issues: string[]): void => {
    if (issues.length === 0) return
    for (const issue of issues) {
      stats.issueHistogram[stage === "patch" ? "patchRejected" : classifyIssueText(issue)]++
    }
    stats.rejected.push({
      stage,
      round,
      reasonCode: stage === "patch" ? "patchRejected" : dominantIssueCategory(issues),
      detail: rejectedDetail(issues),
    })
  }
  const recordAttempt = (dropped: boolean): void => {
    stats.counters.totalAttempts++
    if (dropped) stats.counters.droppedAttempts++
  }
  /** 协议错误轮：计 format 直方图 + 丢弃 attempt（request_modules 抛错不算 attempt） */
  const recordProtocolError = (countsAsAttempt: boolean): void => {
    stats.issueHistogram.format++
    if (countsAsAttempt) recordAttempt(true)
  }
  const turnRecords: HarnessTurnRecord[] = []
  let lastValidDraft: { result: D; turn: number } | null = null
  let moduleServedTotal = 0
  let gatedFinals = 0

  const finish = (status: HarnessStats["terminatedBy"], result?: D): AgentLoopOutcome<D> => {
    stats.terminatedBy = status
    stats.gatedFinals = gatedFinals
    stats.counters.cardFaceFixed = [...seenCardFaceKeys].filter((k) => !acceptedLintKeys.has(k)).length
    stats.wallMs = Date.now() - startedAt
    return { status, result, stats, turns: turnRecords }
  }

  for (let turnIndex = 0; turnIndex < opts.maxTurns; turnIndex++) {
    const turn = turnIndex + 1
    stats.turns = turn
    const remaining = opts.maxTurns - turn
    const turnSeed = opts.llm.seed !== undefined ? opts.llm.seed + turnIndex : undefined

    const t0 = Date.now()
    let resp: { content: string; reasoningContent?: string; usage?: Record<string, unknown> }
    try {
      resp = await respond(messages, { ...opts.llm, seed: turnSeed })
    } catch (e) {
      stats.error = `LLM 调用失败（第 ${turn} 轮）：${e instanceof Error ? e.message : String(e)}`
      return finish("failed")
    }
    const latencyMs = Date.now() - t0
    accumulateUsage(stats.tokens, resp.usage)

    const raw0 = resp.content || ""
    // content 为空（仅思考链，如思考烧穿 maxTokens）时：尝试从思考链提取最后一个
    // 完整 JSON 当作本轮输出（thinking 模型常在思考里草拟完整计划/命令）。
    // 提取成功 → 走正常 parse/salvage 流程（裸产物会被 salvageCommand 按 draft 受理）；
    // 提取失败 → 标记文本走协议错误路径，并计入 reasoningOnly.failed 质量指标。
    let raw = raw0
    if (!raw && resp.reasoningContent) {
      stats.reasoningOnly.total++
      try {
        raw = JSON.stringify(extractJson(resp.reasoningContent))
        stats.reasoningOnly.salvaged++
      } catch {
        stats.reasoningOnly.failed++
        raw = `[reasoning-only 输出：content 为空且思考链无有效 JSON（思考 ${resp.reasoningContent.length} 字符）]`
      }
    }
    // 对话历史里的 assistant 消息必须非空（部分网关拒绝空 content）
    messages.push({ role: "assistant", content: raw || "(empty)" })

    let feedback: string
    let commandName: string | null = null
    let cmd: Command
    let salvageNote = ""
    const actions: CommandActions = { patch: opts.applyPatch !== undefined, switchRoute: opts.applySwitchRoute !== undefined }
    try {
      cmd = parseCommand(raw, actions)
    } catch (parseErr) {
      const salvaged = salvageCommand(raw)
      if (!salvaged) {
        stats.protocolErrors++
        recordProtocolError(true)
        feedback = `协议错误：${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n${protocolHint(remaining, actions)}`
        turnRecords.push({ turn, raw, command: null, feedback, usage: resp.usage, latencyMs })
        messages.push({ role: "user", content: feedback })
        continue
      }
      cmd = salvaged
      stats.protocolErrors++
      stats.salvaged++
      salvageNote = "（协议错误已自动抢救：检测到缺少 action 包装的完整产物，已按 draft/patch/switch_route 受理——下轮请输出标准命令）"
      commandName = `${salvaged.action}（salvaged）`
    }
    if (!commandName) commandName = cmd.action

    try {
      if (cmd.action === "request_modules") {
        const requests = (cmd.requests ?? []).filter((r) => typeof r?.kind === "string" && r.kind.length > 0)
        if (requests.length === 0) {
          throw new Error("request_modules 需要非空 requests 数组（每项含 kind）")
        }
        for (const r of requests) {
          stats.moduleRequests.log.push({ turn, kind: r.kind, id: r.id, reason: r.reason ?? cmd.reason })
          stats.moduleRequests.perKind[r.kind] = (stats.moduleRequests.perKind[r.kind] ?? 0) + 1
        }
        stats.moduleRequests.total += requests.length
        const notices: string[] = []
        let batch = requests
        if (batch.length > opts.perTurnModuleLimit) {
          notices.push(`单轮最多送达 ${opts.perTurnModuleLimit} 个模块，本次请求 ${batch.length} 个已截断`)
          batch = batch.slice(0, opts.perTurnModuleLimit)
        }
        const budgetLeft = opts.moduleBudget - moduleServedTotal
        if (batch.length > budgetLeft) {
          notices.push(`全程模块预算 ${opts.moduleBudget} 已用尽/不足，仅送达前 ${Math.max(0, budgetLeft)} 个`)
          batch = batch.slice(0, Math.max(0, budgetLeft))
        }
        const served = batch.length > 0 ? await opts.resolveModules(batch) : []
        moduleServedTotal += served.length
        notices.push(`模块用量：累计已送达 ${moduleServedTotal}/${opts.moduleBudget}；剩余轮次 ${remaining}`)
        feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}${formatServedModules(served, notices)}`
      } else if (cmd.action === "patch") {
        if (!opts.applyPatch) {
          throw new Error("patch 未启用（本轮回合未开启 patch 修订模式）")
        }
        const applied = await opts.applyPatch(cmd.patch ?? { ops: undefined })
        recordAttempt(!applied.ok)
        recordLintFindings(applied.lintFindings)
        if (applied.ok) {
          stats.patches++
          acceptedLintKeys = new Set(lastLintKeys)
          feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}patch 已合并（累计 ${stats.patches} 条命令）。${applied.statsNote ? `\n\n${applied.statsNote}` : ""}\n\n可继续 patch / request_modules / final（剩余 ${remaining} 轮）。`
        } else {
          recordRejected("patch", turn, applied.issues)
          feedback = `patch 被拒绝（${applied.issues.length} 个问题，未做部分应用）：\n${applied.issues.slice(0, 20).map((s) => `- ${s}`).join("\n")}\n请修正后重新 patch，或用 draft/final（剩余 ${remaining} 轮）。`
        }
      } else if (cmd.action === "switch_route") {
        if (!opts.applySwitchRoute) {
          throw new Error("switch_route 未启用（仅 --patch harness 模式且首轮注入「替代路线参考」段时可用）")
        }
        const applied = await opts.applySwitchRoute(cmd.routeSwitch ?? { candidateIndex: undefined, units: undefined })
        recordAttempt(!applied.ok)
        recordLintFindings(applied.lintFindings)
        if (applied.ok) {
          stats.routeSwitches++
          acceptedLintKeys = new Set(lastLintKeys)
          feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}switch_route 已嫁接（累计 ${stats.routeSwitches} 条命令）。${applied.statsNote ? `\n\n${applied.statsNote}` : ""}\n\n可继续 switch_route / patch / request_modules / final（剩余 ${remaining} 轮）。`
        } else {
          recordRejected("patch", turn, applied.issues)
          feedback = `switch_route 被拒绝（${applied.issues.length} 个问题）：\n${applied.issues.slice(0, 20).map((s) => `- ${s}`).join("\n")}\n请修正后重新 switch_route，或用 patch / draft / final（剩余 ${remaining} 轮）。`
        }
      } else {
        // draft / final
        const bareFinal = cmd.action === "final"
          && (cmd.payload === undefined || cmd.payload === null)
          && opts.applyPatch !== undefined
        if (cmd.payload === undefined || cmd.payload === null) {
          if (!bareFinal) {
            throw new Error(`${cmd.action} 需要携带产物（plan / result 键${opts.applyPatch ? "；patch 模式的 final 可不带产物，以累计 patch 为产出" : ""}）`)
          }
        }
        if (cmd.action === "draft") stats.drafts++
        else stats.finalAttempts++
        const check = await opts.check(cmd.action, cmd.payload ?? null)
        recordAttempt(!check.ok)
        recordLintFindings(check.lintFindings)
        if (check.ok) {
          acceptedLintKeys = new Set(lastLintKeys)
          lastValidDraft = { result: check.result as D, turn }
          if (cmd.action === "final") {
            if (opts.finalGate && gatedFinals < 2) {
              const gate = await opts.finalGate(check.result as D)
              if (!gate.passed) {
                gatedFinals++
                feedback = `final 校验通过，但收尾核验未通过（第 ${gatedFinals} 次，第 3 次 final 将强制放行）：\n${gate.report}\n请确认无误后再次 final（强制通过），或继续修订（剩余 ${remaining} 轮）。`
                turnRecords.push({ turn, raw, command: commandName, feedback, usage: resp.usage, latencyMs })
                messages.push({ role: "user", content: feedback })
                continue
              }
            }
            turnRecords.push({ turn, raw, command: commandName, feedback: "(final 校验通过)", usage: resp.usage, latencyMs })
            return finish("final", check.result)
          }
          feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}draft 校验通过。${check.statsNote ? `形态：${check.statsNote}。` : ""}`
            + `可继续 request_modules 索取资料或 draft 提交修订稿；确认无误后用 final 定稿（剩余 ${remaining} 轮，轮次耗尽将以最后一稿通过校验的 draft 为产出）。`
        } else {
          const issueLines = check.issues.slice(0, 20).map((s) => `- ${s}`).join("\n")
          feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}${cmd.action} 校验未通过（${check.issues.length} 个问题）：\n${issueLines}\n`
            + `请修订后重新 draft 或 final（剩余 ${remaining} 轮）。`
          recordRejected("draft", turn, check.issues)
        }
      }
    } catch (e) {
      stats.protocolErrors++
      // request_modules 处理抛错不是一次 draft/patch/switch_route attempt（不进 counters）；
      // draft/final/patch/switch_route 路径的异常按被丢弃 attempt 计（P0-4 口径）
      recordProtocolError(cmd.action !== "request_modules")
      feedback = `${salvageNote ? `${salvageNote}\n\n` : ""}协议错误：${e instanceof Error ? e.message : String(e)}\n${protocolHint(remaining, actions)}`
    }
    turnRecords.push({ turn, raw, command: commandName, feedback, usage: resp.usage, latencyMs })
    messages.push({ role: "user", content: feedback })
  }

  // 轮次耗尽
  if (lastValidDraft) {
    stats.adoptedDraftTurn = lastValidDraft.turn
    return finish("turn_cap_draft", lastValidDraft.result)
  }
  stats.error = "轮次耗尽且无任何通过校验的 draft"
  return finish("failed")
}
