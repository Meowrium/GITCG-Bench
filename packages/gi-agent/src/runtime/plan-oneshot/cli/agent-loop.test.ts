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
 * agent-loop 有界循环驱动器测试：mock responder 全离线覆盖
 * 模块请求/草稿校验/定稿/轮次耗尽回退/协议错误/预算闸/效率统计。
 */

import { describe, expect, it } from "vitest"
import { runAgentLoop } from "./agent-loop.js"
import type { AgentLoopLlmOptions, HarnessChatMessage, ModuleRequest, PayloadCheck, ServedModule } from "./agent-loop.js"

const LLM: AgentLoopLlmOptions = { maxTokens: 4096, temperature: 0.2, seed: 100, thinking: false, stream: false }

interface Fixture {
  calls: Array<{ messages: HarnessChatMessage[]; seed?: number }>
}

function makeResponder(script: Array<string | { content?: string; reasoningContent?: string }>, fixture?: Fixture) {
  let i = 0
  return async (messages: HarnessChatMessage[], llm: AgentLoopLlmOptions & { seed?: number }) => {
    fixture?.calls.push({ messages: messages.map((m) => ({ ...m })), seed: llm.seed })
    const step = script[Math.min(i, script.length - 1)]
    i++
    const usage = { prompt_tokens: 10 * i, completion_tokens: i }
    if (typeof step === "string") return { content: step, usage }
    return { content: step.content ?? "", reasoningContent: step.reasoningContent, usage }
  }
}

function makeResolver(served: string[] = []): (reqs: ModuleRequest[]) => Promise<ServedModule[]> {
  return async (reqs) => reqs.map((r) => {
    served.push(r.kind)
    return { key: r.id !== undefined ? `${r.kind}:${r.id}` : r.kind, content: `CONTENT(${r.kind})` }
  })
}

/** 简易校验：payload.good === true 时通过 */
function check(_action: "draft" | "final", payload: unknown): PayloadCheck<{ good: boolean }> {
  const p = payload as { good?: boolean }
  if (p && p.good === true) return { ok: true, issues: [], result: { good: true }, statsNote: "good=true" }
  return { ok: false, issues: ["payload.good 必须为 true"] }
}

const BASE = {
  label: "author" as const,
  system: "SYS",
  initialUser: "USER",
  moduleBudget: 12,
  perTurnModuleLimit: 4,
  llm: LLM,
  check,
}

describe("runAgentLoop", () => {
  it("模块请求 → draft 失败 → draft 通过 → final 定稿 全流程", async () => {
    const served: string[] = []
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 8,
      resolveModules: makeResolver(served),
      responder: makeResponder([
        JSON.stringify({ action: "request_modules", requests: [{ kind: "card_detail", id: 1 }, { kind: "field_reference" }], reason: "核实数值" }),
        JSON.stringify({ action: "draft", plan: { good: false } }),
        JSON.stringify({ action: "draft", plan: { good: true } }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.result).toEqual({ good: true })
    const s = outcome.stats
    expect(s.turns).toBe(4)
    expect(s.moduleRequests.total).toBe(2)
    expect(s.moduleRequests.perKind).toEqual({ card_detail: 1, field_reference: 1 })
    expect(s.moduleRequests.log[0]).toMatchObject({ turn: 1, kind: "card_detail", id: 1, reason: "核实数值" })
    expect(s.drafts).toBe(2)
    expect(s.finalAttempts).toBe(1)
    expect(s.protocolErrors).toBe(0)
    expect(s.tokens.available).toBe(true)
    expect(s.tokens.prompt).toBe(10 + 20 + 30 + 40)
    expect(s.terminatedBy).toBe("final")
    // 模块内容确实回注进对话
    const moduleMsg = fixture.calls[1].messages.at(-1)
    expect(moduleMsg?.role).toBe("user")
    expect(moduleMsg?.content).toContain("card_detail:1")
    expect(moduleMsg?.content).toContain("CONTENT(field_reference)")
    // 逐轮 seed = base + turnIndex
    expect(fixture.calls.map((c) => c.seed)).toEqual([100, 101, 102, 103])
  })

  it("轮次耗尽回退到最近通过校验的 draft", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      responder: makeResponder([
        JSON.stringify({ action: "draft", plan: { good: true } }),
        JSON.stringify({ action: "request_modules", requests: [{ kind: "fewshot_plan" }] }),
        JSON.stringify({ action: "draft", plan: { good: false } }),
      ]),
    })
    expect(outcome.status).toBe("turn_cap_draft")
    expect(outcome.result).toEqual({ good: true })
    expect(outcome.stats.adoptedDraftTurn).toBe(1)
  })

  it("协议错误：非 JSON / 未知 action / 缺载荷，计入 protocolErrors 且继续", async () => {
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 5,
      resolveModules: makeResolver(),
      responder: makeResponder([
        "这不是 JSON",
        JSON.stringify({ action: "fly_to_moon" }),
        JSON.stringify({ action: "draft" }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.protocolErrors).toBe(3)
    // 协议错误反馈含命令格式提示
    const feedback = fixture.calls[1].messages.at(-1)?.content ?? ""
    expect(feedback).toContain("协议错误")
  })

  it("单轮模块数上限与全程预算闸", async () => {
    const served: string[] = []
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 4,
      moduleBudget: 2,
      perTurnModuleLimit: 3,
      resolveModules: makeResolver(served),
      responder: makeResponder([
        // 请求 4 个 → 单轮限 3
        JSON.stringify({ action: "request_modules", requests: [{ kind: "a" }, { kind: "b" }, { kind: "c" }, { kind: "d" }] }),
        // 预算只剩 0（上轮已送达 3 > 预算 2？——不：预算闸先切到 2）→ 本轮应 0 个
        JSON.stringify({ action: "request_modules", requests: [{ kind: "e" }] }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    // 预算 2：第一轮请求 4 个先按单轮限 3 截断、再按预算 2 截断 → 送达 2；第二轮预算已尽 → 0
    expect(served).toEqual(["a", "b"])
    const firstFeedback = fixture.calls[1].messages.at(-1)?.content ?? ""
    expect(firstFeedback).toContain("2/2")
    const secondFeedback = fixture.calls[2].messages.at(-1)?.content ?? ""
    expect(secondFeedback).toContain("预算")
  })

  it("轮次耗尽且无任何通过校验的 draft → failed", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: makeResponder(["garbage", JSON.stringify({ action: "draft", plan: { good: false } })]),
    })
    expect(outcome.status).toBe("failed")
    expect(outcome.result).toBeUndefined()
    expect(outcome.stats.error).toContain("轮次耗尽")
  })

  it("responder 抛错 → failed 且带错误说明", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      responder: async () => { throw new Error("网关 502") },
    })
    expect(outcome.status).toBe("failed")
    expect(outcome.stats.error).toContain("网关 502")
    expect(outcome.stats.turns).toBe(1)
  })

  it("reasoning_content 兜底：content 为空时从 reasoning 提取命令", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: async () => ({
        content: "",
        reasoningContent: `推理过程……\n\`\`\`json\n${JSON.stringify({ action: "final", plan: { good: true } })}\n\`\`\``,
      }),
    })
    expect(outcome.status).toBe("final")
  })

  // ── patch 命令 + 协议错误抢救 + finalGate（2026-08-29 patch 修订模式）──

  function patchCheck(state: { patches: string[] }) {
    return (_action: "draft" | "final", payload: unknown): PayloadCheck<{ good: boolean }> => {
      if (payload === null) {
        // patch 模式裸 final：以累计 patch 为产出
        if (state.patches.length === 0) return { ok: false, issues: ["无累计 patch"] }
        return { ok: true, issues: [], result: { good: true } }
      }
      const p = payload as { good?: boolean }
      if (p && p.good === true) return { ok: true, issues: [], result: { good: true } }
      return { ok: false, issues: ["payload.good 必须为 true"] }
    }
  }

  it("patch 命令：合并成功/被拒绝/裸 final 定稿", async () => {
    const state = { patches: [] as string[] }
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 4,
      resolveModules: makeResolver(),
      check: patchCheck(state),
      applyPatch: async (cmd) => {
        const ops = cmd.ops as Array<{ op: string; ruleRef?: string }>
        if (ops.some((o) => o.ruleRef === "global:999")) {
          return { ok: false, issues: ["ruleRef global:999 在当前树中不存在"] }
        }
        state.patches.push(...ops.map((o) => o.op))
        return { ok: true, issues: [], statsNote: "已合并" }
      },
      responder: makeResponder([
        JSON.stringify({ action: "patch", ops: [{ op: "revise", ruleRef: "global:5", when: [], reason: "r" }] }),
        JSON.stringify({ action: "patch", ops: [{ op: "remove", ruleRef: "global:999", reason: "r" }] }),
        JSON.stringify({ action: "final" }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.result).toEqual({ good: true })
    const s = outcome.stats
    expect(s.patches).toBe(1)
    expect(state.patches).toEqual(["revise"])
    expect(s.finalAttempts).toBe(1)
    // 被拒绝的 patch 反馈含问题列表与"未做部分应用"
    const rejectedFeedback = fixture.calls[2].messages.at(-1)?.content ?? ""
    expect(rejectedFeedback).toContain("global:999")
    // 裸 final 的反馈为通过
    expect(outcome.turns[2].feedback).toContain("(final 校验通过)")
  })

  it("patch 未启用时输出协议错误", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: makeResponder([
        JSON.stringify({ action: "patch", ops: [{ op: "remove", ruleRef: "global:5", reason: "r" }] }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.protocolErrors).toBe(1)
  })

  // ── switch_route 命令（reflect 换轴，2026-09-08 单元级嫁接）──

  it("switch_route：嫁接成功计数 routeSwitches，被拒计 patchRejected 并留档 stage=patch", async () => {
    const state = { routes: [] as string[] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      applySwitchRoute: async (cmd) => {
        if (cmd.candidateIndex === 9) return { ok: false, issues: ["候选 9 不存在（可选 0/1/2）"] }
        state.routes.push(...(cmd.units as string[]))
        return { ok: true, issues: [], statsNote: "已嫁接 opening" }
      },
      responder: makeResponder([
        JSON.stringify({ action: "switch_route", candidateIndex: 1, units: ["opening"], reason: "路线更贴锚点", falsifiableClaim: "换开局后 fallback 率下降" }),
        JSON.stringify({ action: "switch_route", candidateIndex: 9, units: ["rules"], reason: "r", falsifiableClaim: "c" }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    const s = outcome.stats
    expect(s.routeSwitches).toBe(1)
    expect(s.patches).toBe(0)
    expect(state.routes).toEqual(["opening"])
    expect(outcome.turns[0].feedback).toContain("switch_route 已嫁接")
    expect(outcome.turns[1].feedback).toContain("候选 9 不存在")
    expect(s.issueHistogram.patchRejected).toBe(1)
    expect(s.rejected[0]).toMatchObject({ stage: "patch", round: 2, reasonCode: "patchRejected" })
    expect(s.counters.droppedAttempts).toBe(1)
  })

  it("switch_route 未启用时输出协议错误", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: makeResponder([
        JSON.stringify({ action: "switch_route", candidateIndex: 0, units: ["opening"], reason: "r", falsifiableClaim: "c" }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.protocolErrors).toBe(1)
    expect(outcome.turns[0].feedback).toContain("switch_route 未启用")
  })

  it("switch_route 启用时协议错误提示列出该命令", async () => {
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      applySwitchRoute: async () => ({ ok: true, issues: [] }),
      responder: makeResponder(["garbage", JSON.stringify({ action: "final", plan: { good: true } })]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.turns[0].feedback).toContain("switch_route")
  })

  it("salvage：漏 action 的 switch_route（顶层 candidateIndex + units）→ 按 switch_route 受理", async () => {
    const state = { routes: [] as string[] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      applySwitchRoute: async (cmd) => {
        state.routes.push(...(cmd.units as string[]))
        return { ok: true, issues: [] }
      },
      responder: makeResponder([
        JSON.stringify({ candidateIndex: 2, units: ["fallback"], reason: "r", falsifiableClaim: "c" }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.salvaged).toBe(1)
    expect(state.routes).toEqual(["fallback"])
  })

  it("salvage：漏写 action 包装但带 result 键 → 按 draft 受理", async () => {
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      responder: makeResponder([
        // r2 实测形态：完整 ReflectPlanResultV1 直接输出，无 action
        JSON.stringify({ result: { revisedPlan: { good: true } } }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    const s = outcome.stats
    expect(s.salvaged).toBe(1)
    expect(s.protocolErrors).toBe(1)
    expect(s.drafts).toBe(1)
    // 抢救提示回注进对话
    expect(fixture.calls[1].messages.at(-1)?.content).toContain("抢救")
  })

  it("salvage：漏 action 的 patch（顶层 ops 数组）→ 按 patch 受理", async () => {
    const state = { patches: [] as string[] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      check: patchCheck(state),
      applyPatch: async (cmd) => {
        state.patches.push("ok")
        return { ok: true, issues: [], statsNote: "已合并" }
      },
      responder: makeResponder([
        JSON.stringify({ ops: [{ op: "remove", ruleRef: "global:5", reason: "r" }] }),
        JSON.stringify({ action: "final" }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.salvaged).toBe(1)
    expect(state.patches).toEqual(["ok"])
  })

  it("draft/final 的产物放 result 键同样受理且载荷原样透传（roundT1 回归）", async () => {
    const seen: unknown[] = []
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      check: (_action, payload) => {
        seen.push(payload)
        const p = payload as { revisedPlan?: { good?: boolean } }
        if (p?.revisedPlan?.good === true) return { ok: true, issues: [], result: { good: true } }
        return { ok: false, issues: ["payload.revisedPlan.good 必须为 true"] }
      },
      responder: makeResponder([
        // roundT1 实测形态：{"action":"final","result":{...ReflectPlanResultV1...}}
        JSON.stringify({ action: "draft", result: { version: "ReflectPlanResultV1", revisedPlan: { good: false }, revisedPredictions: { confidence: 0.3 } } }),
        JSON.stringify({ action: "final", result: { version: "ReflectPlanResultV1", revisedPlan: { good: true }, revisedPredictions: { confidence: 0.5 } } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.protocolErrors).toBe(0)
    // result 键载荷（含内嵌 revisedPredictions）原样送达 check
    expect((seen[0] as { revisedPredictions?: { confidence?: number } }).revisedPredictions?.confidence).toBe(0.3)
    expect((seen[1] as { revisedPredictions?: { confidence?: number } }).revisedPredictions?.confidence).toBe(0.5)
  })

  it("协议错误提示注明 result 键可用", async () => {
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: makeResponder(["garbage", JSON.stringify({ action: "final", plan: { good: true } })], fixture),
    })
    expect(outcome.status).toBe("final")
    expect(fixture.calls[1].messages.at(-1)?.content).toContain(`"result" 键`)
  })

  it("finalGate：未通过打回（最多 2 次），第 3 次 final 强制放行", async () => {
    let gateCalls = 0
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 6,
      resolveModules: makeResolver(),
      finalGate: async () => {
        gateCalls++
        return gateCalls <= 2
          ? { passed: false, report: "合并计划与原计划一致——无修订" }
          : { passed: true, report: "ok" }
      },
      responder: makeResponder([
        JSON.stringify({ action: "final", plan: { good: true } }),
        JSON.stringify({ action: "final", plan: { good: true } }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    expect(gateCalls).toBe(2)
    expect(outcome.stats.gatedFinals).toBe(2)
    expect(outcome.stats.finalAttempts).toBe(3)
  })

  it("content 为空但思考链含完整命令 JSON：提取为输出并执行（salvaged 计数）", async () => {
    const fixture: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 3,
      resolveModules: makeResolver(),
      responder: makeResponder([
        { content: "", reasoningContent: '先内部推演…\n{"action":"request_modules","requests":[{"kind":"card_detail","id":1}]}' },
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.result).toEqual({ good: true })
    expect(outcome.stats.reasoningOnly).toEqual({ total: 1, salvaged: 1, failed: 0 })
    // 第二轮调用时，历史里的 assistant 消息应为提取出的 JSON（而非思考全文），不污染上下文
    const secondCall = fixture.calls[1]?.messages ?? []
    const firstAssistant = secondCall.find((m) => m.role === "assistant")
    expect(firstAssistant?.content).toContain('"action":"request_modules"')
    expect(firstAssistant?.content).not.toContain("先内部推演")
  })

  it("content 为空且思考链无有效 JSON：协议错误计数（failed 计入 benchmark 指标）", async () => {
    const fixture0: Fixture = { calls: [] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 2,
      resolveModules: makeResolver(),
      responder: makeResponder([
        { content: "", reasoningContent: "纯散文思考,没有任何 JSON 对象或代码块" },
        JSON.stringify({ action: "final", plan: { good: true } }),
      ], fixture0),
    })
    expect(outcome.status).toBe("final")
    expect(outcome.stats.reasoningOnly).toEqual({ total: 1, salvaged: 0, failed: 1 })
    expect(outcome.stats.protocolErrors).toBeGreaterThanOrEqual(1)
    // 第二轮调用时，历史里的 assistant 消息是标记文本而非思考全文（不污染上下文）
    const secondCall = fixture0.calls[1]?.messages ?? []
    const firstAssistant = secondCall.find((m) => m.role === "assistant")
    expect(firstAssistant?.content).toContain("[reasoning-only 输出")
    expect(firstAssistant?.content.length).toBeLessThan(200)
  })

  // ── WP2 P0-4：issue 直方图 + 被拒留档 + counters ──

  it("P0-4：draft 校验未通过的 issues 机械分类进 issueHistogram，rejected 留档（主导类别 + detail ≤200 字），counters 计数", async () => {
    const longIssue = `format 类超长问题：${"x".repeat(300)}`
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 4,
      resolveModules: makeResolver(),
      check: (_action, payload) => {
        const p = payload as { good?: boolean }
        if (p && p.good === true) return { ok: true, issues: [], result: { good: true }, lintFindings: 2 }
        return {
          ok: false,
          issues: ["rules[0]: 引用牌表外 defId 999999（死规则）", "when[0]: unknown field self.mana", longIssue],
          lintFindings: 2,
        }
      },
      responder: makeResponder([
        JSON.stringify({ action: "draft", plan: { good: false } }),
        JSON.stringify({ action: "draft", plan: { good: true } }),
        JSON.stringify({ action: "final", plan: { good: true } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    const s = outcome.stats
    // lint 逐次校验调用累计：失败稿 2 + 通过稿 2 + final 稿 2 = 6（每次反馈都会报告当前 lint 数）
    expect(s.issueHistogram).toEqual({ deadRule: 1, format: 1, closedSet: 1, lint: 6, cardFace: 0, patchRejected: 0 })
    expect(s.rejected).toHaveLength(1)
    expect(s.rejected[0]).toMatchObject({ stage: "draft", round: 1, reasonCode: "deadRule" })
    expect(s.rejected[0].detail.length).toBeLessThanOrEqual(200)
    expect(s.rejected[0].detail).toContain("死规则")
    // attempt 口径：2 次 draft + 1 次 final = 3，其中首轮校验未通过被丢弃
    expect(s.counters).toEqual({ lintFindings: 6, droppedAttempts: 1, totalAttempts: 3, cardFaceFixed: 0 })
  })

  it("P0-4：patch 被拒计 patchRejected 且 rejected 留档 stage=patch；协议错误轮计 format 并进 droppedAttempts", async () => {
    const state = { patches: [] as string[] }
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 4,
      resolveModules: makeResolver(),
      check: patchCheck(state),
      applyPatch: async (cmd) => {
        const ops = cmd.ops as Array<{ ruleRef?: string }>
        if (ops.some((o) => o.ruleRef === "global:999")) {
          return { ok: false, issues: ["ruleRef global:999 在当前树中不存在", "同命令重复 ruleRef"] }
        }
        state.patches.push("ok")
        return { ok: true, issues: [], statsNote: "已合并", lintFindings: 1 }
      },
      responder: makeResponder([
        "garbage",
        JSON.stringify({ action: "patch", ops: [{ op: "revise", ruleRef: "global:999" }] }),
        JSON.stringify({ action: "patch", ops: [{ op: "revise", ruleRef: "global:5" }] }),
        JSON.stringify({ action: "final" }),
      ]),
    })
    expect(outcome.status).toBe("final")
    const s = outcome.stats
    expect(s.issueHistogram.patchRejected).toBe(2)
    expect(s.issueHistogram.format).toBe(1)
    expect(s.issueHistogram.lint).toBe(1)
    expect(s.rejected).toHaveLength(1)
    expect(s.rejected[0]).toMatchObject({ stage: "patch", round: 2, reasonCode: "patchRejected" })
    expect(s.rejected[0].detail).toContain("global:999")
    // attempt 口径：garbage 协议错误轮 + patch 被拒 + patch 合并 + 裸 final = 4，丢弃 2
    expect(s.counters).toEqual({ lintFindings: 1, droppedAttempts: 2, totalAttempts: 4, cardFaceFixed: 0 })
  })

  it("卡面校核计数：lintFindings 数组按 kind 分桶，cardFaceFixed 统计早前出现且最终采纳稿消失的键", async () => {
    const cf = (path: string, message: string) => ({ kind: "card-face" as const, path, message })
    const chain = (path: string, message: string) => ({ kind: "chain" as const, path, message })
    const outcome = await runAgentLoop({
      ...BASE,
      maxTurns: 4,
      resolveModules: makeResolver(),
      check: (_action, payload) => {
        const p = payload as { draft?: number }
        if (p?.draft === 2) return { ok: true, issues: [], result: p, lintFindings: [cf("rules[1]", "费用记错")] }
        if (p?.draft === 3) return { ok: true, issues: [], result: p, lintFindings: [cf("rules[0]", "仍错"), cf("rules[2]", "新增")] }
        return { ok: false, issues: ["坏稿"], lintFindings: [cf("rules[1]", "费用记错"), chain("rules[3]", "遮蔽")] }
      },
      responder: makeResponder([
        JSON.stringify({ action: "draft", plan: { draft: 1 } }),
        JSON.stringify({ action: "draft", plan: { draft: 2 } }),
        JSON.stringify({ action: "draft", plan: { draft: 3 } }),
        JSON.stringify({ action: "final", plan: { draft: 3 } }),
      ]),
    })
    expect(outcome.status).toBe("final")
    const s = outcome.stats
    // lint 逐稿累计 2+1+2+2=7；cardFace 为其中 kind=card-face 的子集 1+1+2+2=6
    expect(s.issueHistogram.lint).toBe(7)
    expect(s.issueHistogram.cardFace).toBe(6)
    // 最终采纳稿（第 3 稿）的键：rules[0]仍错 / rules[2]新增；早前出现过的 rules[1]费用记错已消失 → 1
    expect(s.counters.cardFaceFixed).toBe(1)
    expect(s.counters.lintFindings).toBe(7)
  })
})
