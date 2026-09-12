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
 * candidate-session — r0 多候选起草的「单对话多轮」会话核心（`--candidates N`）。
 *
 * 设计（2026-09-09 改造）：N 个候选不再互相不可见，而是在**同一对话**里分 N 轮
 * 依次起草——第 k 轮能看到前 k-1 个候选的完整 JSON（作为 assistant 消息留在
 * messages 里），prompt 要求其沿路线维度显式拉开距离。每轮输出契约不变
 * `{"archetype": ..., "plan": GamePlanV1}`；校验不通过时在同一对话内以 user 跟进
 * 消息回注 issue 列表修复（每候选 `--repair` 预算）。
 *
 * 多样性机检：新候选身份（`identity`；author 侧取 planId——内容哈希，同 planId 即
 * 同内容，等价于「与已收录候选逐字节相同」）与已收录候选相同 → 视为可修复失败
 * （回注 must-differ 文案），计入 repair 预算。任一候选预算耗尽 → 整格失败
 * （返回 failedIndex，全有全无语义不变）。
 *
 * seed 公式不变：第 k 候选第 a 次尝试 = `seedBase + k*100 + a`（复现性锚点）。
 * 本模块零 I/O、零 LLM 依赖：chat 由调用方注入（便于离线单测）。
 */

import type { HarnessChatMessage } from "./llm.js"

export interface CandidateChatResponse {
  content: string
  reasoningContent?: string
}

export interface CandidateChatRequest {
  /** 对话快照（含 system、历史 user/assistant 原文与最新指令） */
  messages: HarnessChatMessage[]
  seed?: number
}

export type CandidateChatFn = (req: CandidateChatRequest) => Promise<CandidateChatResponse>

export interface CandidateCheckContext<T> {
  index: number
  attempt: number
  /** 已收录的前序候选（第 k 轮可见前 k-1 个） */
  prior: readonly T[]
}

export type CandidateCheckResult<T> =
  | { ok: true; candidate: T }
  | { ok: false; issues: string[] }

export interface CandidateSessionOptions<T> {
  count: number
  /** 系统提示词（author-system + candidates 章节） */
  system: string
  /** 完整输入（牌表/锚点）；第 1 轮 user = baseUser + 第 1 轮起草指令 */
  baseUser: string
  /** 每候选修复预算（`--repair`） */
  repair: number
  /** seed 基值；缺省时不发 seed 参数 */
  seedBase: number | undefined
  chat: CandidateChatFn
  /** 解析 + 制备 + 校验（自带进度日志）；失败返回回注 issue 列表 */
  check: (resp: CandidateChatResponse, ctx: CandidateCheckContext<T>) => CandidateCheckResult<T> | Promise<CandidateCheckResult<T>>
  /** 候选身份（同身份即视为重复候选） */
  identity: (candidate: T) => string
  log: (message: string) => void
}

export type CandidateSessionOutcome<T> =
  | { ok: true; candidates: T[] }
  | { ok: false; failedIndex: number }

const DUPLICATE_ISSUE = "must differ from previous candidates: this draft is identical (same planId / same plan bytes) to a candidate already in the conversation; choose a different route and output a new tree"

function draftInstruction(round: number, count: number, index: number, priorCount: number): string {
  const base = `# Candidate draft (${round}/${count}, index=${index})\n\nFollowing the system prompt's "candidate draft mode", output \`{"archetype":"...","plan":{...}}\`. Output JSON only.`
  if (priorCount === 0) return base
  return `${base}\n\nThe conversation above already contains ${priorCount} accepted candidate(s). You MUST take a route that is explicitly different from every one of them (see the system prompt's route differentiation discipline); do not repeat a route and do not output a near-identical tree.`
}

function repairInstruction(issues: readonly string[]): string {
  return `# The previous draft of this candidate failed; fix the issues below and output the full JSON again:\n${issues.map((s) => `- ${s}`).join("\n")}`
}

/**
 * 单对话多轮起草主循环。返回全部候选（按 index 升序）或首个失败候选的 index。
 * messages 累积：system + 完整输入 + 逐轮 user 指令 + 逐轮 assistant 原文。
 */
export async function runCandidateSession<T>(opts: CandidateSessionOptions<T>): Promise<CandidateSessionOutcome<T>> {
  const { count, system, baseUser, repair, seedBase, chat, check, identity, log } = opts
  const messages: HarnessChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `${baseUser}\n\n${draftInstruction(1, count, 0, 0)}` },
  ]
  const candidates: T[] = []
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      messages.push({ role: "user", content: draftInstruction(index + 1, count, index, candidates.length) })
    }
    let lastIssues: string[] = []
    let accepted: T | null = null
    for (let attempt = 0; attempt <= repair; attempt++) {
      if (attempt > 0) messages.push({ role: "user", content: repairInstruction(lastIssues) })
      const resp = await chat({
        messages: [...messages],
        seed: seedBase !== undefined ? seedBase + index * 100 + attempt : undefined,
      })
      messages.push({ role: "assistant", content: resp.content || (resp.reasoningContent ?? "") })
      const outcome = await check(resp, { index, attempt, prior: candidates })
      if (!outcome.ok) {
        lastIssues = outcome.issues
        continue
      }
      const id = identity(outcome.candidate)
      if (candidates.some((c) => identity(c) === id)) {
        log(`[candidate ${index}] attempt ${attempt}: duplicate of a previous candidate (${id})`)
        lastIssues = [DUPLICATE_ISSUE]
        continue
      }
      accepted = outcome.candidate
      break
    }
    if (accepted === null) {
      log(`candidate ${index} 起草失败：校验未通过且修复次数用尽`)
      return { ok: false, failedIndex: index }
    }
    candidates.push(accepted)
  }
  return { ok: true, candidates }
}
