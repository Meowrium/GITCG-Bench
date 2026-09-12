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
 * organizer 报告契约单测（件 3）：条目级校验（引用白名单/存在性/锚点强制/枚举）、
 * 白名单通配、report.md 渲染（可点链接 + invalidEntries 呈现）。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  compileWhitelist,
  renderMarkdown,
  validateEntry,
  whitelistMatch,
  type OrganizerReport,
} from "./organize-report.js"

function validEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "m1",
    dimension: "route",
    conclusion: "计划提及「能斩必斩」策略",
    citations: [{ file: "fullDigest.txt", game: "game-0001", seq: 3, ruleKey: "global:10" }],
    confidence: "high",
    ...over,
  }
}

describe("organizer 条目校验（validateEntry）", () => {
  let packDir: string
  const schemaPatterns = [
    "fullDigest.txt", "stateSignatures.jsonl", "draw-sequence.md", "outliers.json",
    "plan.side0.json", "manifest.json", "side1/summary.side1.json", "side1/game-*/plan_trace.side1.json",
  ]

  beforeAll(async () => {
    packDir = await mkdtemp(join(tmpdir(), "organize-report-"))
    await writeFile(join(packDir, "fullDigest.txt"), "stub", "utf-8")
    await mkdir(join(packDir, "side1", "game-0001"), { recursive: true })
    await writeFile(join(packDir, "side1", "game-0001", "plan_trace.side1.json"), "{}", "utf-8")
    await writeFile(join(packDir, "side1", "summary.side1.json"), "{}", "utf-8")
  })

  afterAll(async () => {
    await rm(packDir, { recursive: true, force: true })
  })

  const ctx = () => ({ matchers: compileWhitelist(schemaPatterns), packDir })

  it("合法条目通过且引用字段规范化", () => {
    const v = validateEntry(validEntry(), ctx())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.entry.citations[0]).toEqual({ file: "fullDigest.txt", game: "game-0001", seq: 3, ruleKey: "global:10" })
      expect(v.entry).not.toHaveProperty("mechanicalAnchor")
      expect(v.entry).not.toHaveProperty("notes")
    }
  })

  it("缺引用 / 引用不在白名单 / 引用文件不存在 → 条目级剔除", () => {
    const ctx1 = ctx()
    expect(validateEntry(validEntry({ citations: [] }), ctx1).ok).toBe(false)
    const v2 = validateEntry(validEntry({ citations: [{ file: "run/plan_eval.json" }] }), ctx1)
    expect(v2.ok).toBe(false)
    if (!v2.ok) expect(v2.reason).toContain("白名单")
    const v3 = validateEntry(validEntry({ citations: [{ file: "draw-sequence.md" }] }), ctx1)
    expect(v3.ok).toBe(false)
    if (!v3.ok) expect(v3.reason).toContain("不存在")
  })

  it("side1 通配白名单：匹配实际 per-game 路径", () => {
    const matchers = compileWhitelist(schemaPatterns)
    expect(whitelistMatch(matchers, "side1/game-0001/plan_trace.side1.json")).toBe(true)
    expect(whitelistMatch(matchers, "side1/game-999/plan_trace.side1.json")).toBe(true)
    expect(whitelistMatch(matchers, "side1/game-0001/other.json")).toBe(false)
    expect(whitelistMatch(matchers, "summary.json")).toBe(false)
  })

  it("misalign 条目必须带 mechanicalAnchor，且 kind 在封闭集合内", () => {
    const v1 = validateEntry(validEntry({ dimension: "misalign" }), ctx())
    expect(v1.ok).toBe(false)
    if (!v1.ok) expect(v1.reason).toContain("mechanicalAnchor")
    const v2 = validateEntry(validEntry({
      dimension: "misalign",
      mechanicalAnchor: { kind: "perRuleHitsZero", ruleKey: "global:5", detail: "perRuleHits=0" },
    }), ctx())
    expect(v2.ok).toBe(true)
    const v3 = validateEntry(validEntry({
      dimension: "misalign",
      mechanicalAnchor: { kind: "madeUpKind" },
    }), ctx())
    expect(v3.ok).toBe(false)
    if (!v3.ok) expect(v3.reason).toContain("kind 非法")
  })

  it("dimension / confidence / 数值字段非法 → 剔除", () => {
    const c = ctx()
    expect(validateEntry(validEntry({ dimension: "score" }), c).ok).toBe(false)
    expect(validateEntry(validEntry({ confidence: "11/10" }), c).ok).toBe(false)
    expect(validateEntry(validEntry({ citations: [{ file: "fullDigest.txt", seq: -1 }] }), c).ok).toBe(false)
    expect(validateEntry(validEntry({ citations: [{ file: "fullDigest.txt", game: "g1" }] }), c).ok).toBe(false)
    expect(validateEntry("not an object", c).ok).toBe(false)
    expect(validateEntry(validEntry({ conclusion: "  " }), c).ok).toBe(false)
  })
})

describe("report.md 渲染（renderMarkdown）", () => {
  it("条目可点链接 + invalidEntries + 任务失败区", async () => {
    // 用真实兄弟目录验证相对链接计算（跨平台稳定）
    const outDir = await mkdtemp(join(tmpdir(), "organize-md-out-"))
    const packDir = await mkdtemp(join(tmpdir(), "organize-md-pack-"))
    const relPack = relative(outDir, packDir).split("\\").join("/")
    const report: OrganizerReport = {
      runDir: "/tmp/run",
      model: "deepseek-v4-flash-vision-exp",
      generatedAt: "2026-09-05T00:00:00.000Z",
      tasks: {
        misalign: [{
          id: "x1",
          dimension: "misalign",
          conclusion: "global:5 写了从未打过",
          citations: [{ file: "outliers.json", ruleKey: "global:5" }],
          mechanicalAnchor: { kind: "perRuleHitsZero", ruleKey: "global:5", detail: "perRuleHits=0" },
          confidence: "high",
        }],
        practice: [],
      },
      invalidEntries: [{ task: "mentions", index: 1, reason: "citations 缺失", entry: { id: "bad" } }],
      taskFailures: [{ task: "mentions", error: "LLM API 500" }],
    }
    const md = renderMarkdown(report, packDir, outDir, ["mentions", "practice", "misalign"])
    expect(md).toContain("# organizer 三任务报告")
    expect(md).toContain(`[outliers.json global:5](${relPack}/outliers.json)`) // 相对路径可点
    expect(md).toContain("机械锚点: perRuleHitsZero / global:5 / perRuleHits=0")
    expect(md).toContain("（任务被隔离：LLM API 500）")
    expect(md).toContain("task=mentions index=1：citations 缺失")
    expect(md).toContain("证据缺口标注")
    await rm(outDir, { recursive: true, force: true })
    await rm(packDir, { recursive: true, force: true })
  })
})
