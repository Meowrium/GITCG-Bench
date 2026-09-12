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
 * prompt 口径测试（无 oracle 自进化臂 S-M1 验收：engine-only 反思全程无 oracle
 * 字样进入 prompt，transcript 可机检——系统提示词是其最大组成部分，在此闸住）。
 */

import { describe, expect, it } from "vitest"
import {
  REFLECT_SYSTEM_PROMPT,
  REFLECT_SYSTEM_PROMPT_ENGINE_ONLY,
  AUTHOR_SYSTEM_PROMPT,
  buildCandidateReviewSystemPrompt,
  buildCandidatesSystemPrompt,
  buildReflectSystemPrompt,
} from "./plan-prompts.js"

const PROTOCOL = { maxTurns: 6, moduleBudget: 12, perTurnModules: 4, maxPatchOps: 8 }

describe("reflect prompt 的 evidence 变体", () => {
  it("engine-only 系统提示词无任何 oracle 字样（one-shot 与 harness 全组合）", () => {
    expect(REFLECT_SYSTEM_PROMPT_ENGINE_ONLY).not.toMatch(/oracle/i)
    expect(buildReflectSystemPrompt(true, PROTOCOL, false, "engine-only")).not.toMatch(/oracle/i)
    expect(buildReflectSystemPrompt(true, PROTOCOL, true, "engine-only")).not.toMatch(/oracle/i)
    expect(buildReflectSystemPrompt(false, undefined, false, "engine-only")).not.toMatch(/oracle/i)
  })

  it("engine-only 变体锚定机械指标（thenMiss/coverage/胜率区间/威胁读数）", () => {
    const p = buildReflectSystemPrompt(true, PROTOCOL, true, "engine-only")
    expect(p).toContain("thenMiss")
    expect(p).toContain("coverage")
    expect(p).toContain("胜率区间")
    expect(p).toContain("opp.threat")
    expect(p).toContain("零命中")
    expect(p).toContain("龟缩化")
    // patch 口径说明：无 blunder 点属预期
    expect(p).toContain("no-target")
  })

  it("oracle 口径保持既有措辞（变体确实分叉）", () => {
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/oracle/)
    expect(buildReflectSystemPrompt(true, PROTOCOL, false, "oracle")).toMatch(/oracle/)
    expect(buildReflectSystemPrompt(true, PROTOCOL, true, "oracle")).toMatch(/oracle/)
  })

  it("占位符在两种口径下都被完全替换", () => {
    for (const p of [
      REFLECT_SYSTEM_PROMPT,
      REFLECT_SYSTEM_PROMPT_ENGINE_ONLY,
      AUTHOR_SYSTEM_PROMPT,
      buildReflectSystemPrompt(true, PROTOCOL, true, "engine-only"),
    ]) {
      expect(p).not.toContain("{{PLAN_SCHEMA_SPEC}}")
      expect(p).not.toContain("{{GAME_RULES}}")
      expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/)
    }
  })

  it("schema 封闭集合在两口径间一致（只换证据措辞，不改字段语义）", () => {
    const specOf = (p: string) => [...new Set(p.match(/opp\.threat\.[a-zA-Z]+/g) ?? [])].sort()
    expect(specOf(REFLECT_SYSTEM_PROMPT_ENGINE_ONLY)).toEqual(specOf(REFLECT_SYSTEM_PROMPT))
  })

  it("多候选起草/评审提示词：占位替换、载荷契约与路线纪律齐备", () => {
    const sys = buildCandidatesSystemPrompt(3)
    expect(sys).toContain("Candidate drafting mode")
    expect(sys).toContain("archetype")
    expect(sys).toContain("Route differentiation discipline")
    expect(sys).not.toMatch(/\{\{[A-Z_]+\}\}/)
    const review = buildCandidateReviewSystemPrompt(3)
    expect(review).toContain("route reviewer")
    expect(review).toContain("choice")
    expect(review).toContain("notes")
    expect(review).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it("patch 协议含 switch_route 段（换轴命令，仅替代路线参考段注入时可用）", () => {
    const p = buildReflectSystemPrompt(true, PROTOCOL, true, "engine-only")
    expect(p).toContain("switch_route")
    expect(p).toContain("替代路线参考")
    expect(p).toContain("phase:<phaseId>")
  })
})
