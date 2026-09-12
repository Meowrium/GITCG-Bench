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
 * candidate-session 单测：单对话多轮起草的 messages 累积、修复回注、重复候选拒绝、
 * repair 预算耗尽与 seed 公式（chat 由 mock 注入，零网络）。
 */

import { describe, expect, it } from "vitest"
import { runCandidateSession, type CandidateChatRequest, type CandidateCheckResult } from "./candidate-session.js"

interface Draft {
  index: number
  archetype: string
  plan: { planId: string; route: string }
}

function payload(archetype: string, route: string): string {
  return JSON.stringify({ archetype, plan: { planId: `p-${route}`, route } })
}

/** 简化 check：解析 JSON + 要求 archetype / plan.route */
function checkDraft(raw: string, index: number): CandidateCheckResult<Draft> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, issues: ["bad json"] }
  }
  const wrapped = parsed as { archetype?: unknown; plan?: { route?: unknown } } | null
  if (typeof wrapped?.archetype !== "string" || wrapped.archetype === "") return { ok: false, issues: ["missing archetype"] }
  if (typeof wrapped.plan?.route !== "string" || wrapped.plan.route === "") return { ok: false, issues: ["missing plan.route"] }
  return { ok: true, candidate: { index, archetype: wrapped.archetype, plan: wrapped.plan as Draft["plan"] } }
}

function session(
  replies: string[],
  opts: { count: number; repair?: number; seedBase?: number },
): { requests: CandidateChatRequest[]; logs: string[]; run: () => ReturnType<typeof runCandidateSession<Draft>> } {
  const requests: CandidateChatRequest[] = []
  const logs: string[] = []
  return {
    requests,
    logs,
    run: () => runCandidateSession<Draft>({
      count: opts.count,
      system: "SYS",
      baseUser: "DECK",
      repair: opts.repair ?? 2,
      seedBase: opts.seedBase ?? 1000,
      chat: async (req) => {
        requests.push(req)
        return { content: replies[requests.length - 1] ?? "" }
      },
      check: (resp, ctx) => checkDraft(resp.content, ctx.index),
      identity: (c) => c.plan.planId,
      log: (m) => logs.push(m),
    }),
  }
}

describe("runCandidateSession（单对话多轮）", () => {
  it("三轮顺序起草：messages 累积前序候选原文，seed = base + k*100 + a", async () => {
    const s = session([payload("aggro", "a"), payload("control", "b"), payload("combo", "c")], { count: 3 })
    const outcome = await s.run()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.candidates.map((c) => c.plan.planId)).toEqual(["p-a", "p-b", "p-c"])
    expect(s.requests).toHaveLength(3)
    expect(s.requests.map((r) => r.seed)).toEqual([1000, 1100, 1200])

    // 第 1 轮：system + 完整输入 + 起草指令
    const first = s.requests[0].messages
    expect(first.map((m) => m.role)).toEqual(["system", "user"])
    expect(first[1].content).toContain("DECK")
    expect(first[1].content).toContain("Candidate draft (1/3, index=0)")

    // 第 2 轮：能看到第 1 轮候选的完整 JSON（assistant 原文），且指令要求显式拉开距离
    const second = s.requests[1].messages
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(second[2].content).toContain('"planId":"p-a"')
    expect(second[3].content).toContain("Candidate draft (2/3, index=1)")
    expect(second[3].content).toContain("MUST take a route that is explicitly different")

    // 第 3 轮：可见前两个候选
    const third = s.requests[2].messages
    expect(third.filter((m) => m.role === "assistant")).toHaveLength(2)
    expect(third[2].content).toContain('"planId":"p-a"')
    expect(third[4].content).toContain('"planId":"p-b"')
  })

  it("校验失败在同一对话内回注 issue 修复（repair 预算内，seed 随 attempt 递增）", async () => {
    const s = session(["not json", payload("aggro", "a")], { count: 1, repair: 1 })
    const outcome = await s.run()
    expect(outcome.ok).toBe(true)
    expect(s.requests).toHaveLength(2)
    expect(s.requests.map((r) => r.seed)).toEqual([1000, 1001])
    const repair = s.requests[1].messages[s.requests[1].messages.length - 1]
    expect(repair.role).toBe("user")
    expect(repair.content).toContain("The previous draft of this candidate failed")
    expect(repair.content).toContain("- bad json")
    // 失败原文留在对话里
    expect(s.requests[1].messages.some((m) => m.role === "assistant" && m.content === "not json")).toBe(true)
  })

  it("重复候选（同 planId）被拒并回注 must-differ，重出后收录", async () => {
    const s = session([payload("aggro", "a"), payload("aggro", "a"), payload("control", "b")], { count: 2, repair: 1 })
    const outcome = await s.run()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.candidates.map((c) => c.plan.planId)).toEqual(["p-a", "p-b"])
    expect(s.requests).toHaveLength(3)
    expect(s.logs.some((l) => l.includes("duplicate of a previous candidate"))).toBe(true)
    const retry = s.requests[2].messages[s.requests[2].messages.length - 1]
    expect(retry.content).toContain("must differ from previous candidates")
  })

  it("候选 repair 预算耗尽 → 整格失败（failedIndex，无候选产出）", async () => {
    const s = session(["not json"], { count: 3, repair: 0 })
    const outcome = await s.run()
    expect(outcome).toEqual({ ok: false, failedIndex: 0 })
    expect(s.requests).toHaveLength(1)
    expect(s.logs.some((l) => l.includes("candidate 0 起草失败"))).toBe(true)
  })
})
