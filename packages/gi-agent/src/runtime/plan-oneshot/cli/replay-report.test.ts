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
 * WP2 P0-3 replay-report 落盘单元测试：record 累计语义 + 写出文件 JSON 可解析、
 * 逐 op status 枚举合法（验收 §3-4 的离线替身——无需真 LLM 跑 reflect）。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReplayReport, recordPatchReplay, writeReplayReport, type ReplayReport } from "./replay-report.js"
import type { PatchAssertion } from "../plan-replay.js"

const STATUSES = ["fixed", "partial", "ineffective", "no-target"] as const

function assertionOf(status: PatchAssertion["status"], i: number): PatchAssertion {
  return {
    opIndex: i,
    op: "revise",
    ruleRef: `global:${10 + i}`,
    targetPoints: status === "no-target" ? 0 : 3,
    stillMatched: status === "ineffective" ? 3 : status === "partial" ? 1 : 0,
    nowFallback: status === "partial" ? 1 : 0,
    status,
    note: status === "ineffective" ? "静态回放无法确认 then 映射修复" : "",
  }
}

describe("replay-report（P0-3）", () => {
  it("recordPatchReplay 累计 patchIndex 与 totalAppliedOps；portfolioId 可选", () => {
    const report = createReplayReport("base00000001")
    expect(report.patches).toEqual([])
    expect(report.portfolioId).toBeUndefined()
    recordPatchReplay(report, { opsCount: 2, assertions: [assertionOf("fixed", 0)], fallbackRate: { base: 0.4, next: 0.2 } })
    recordPatchReplay(report, { opsCount: 1, assertions: [], fallbackRate: { base: 0.2, next: 0.2 } })
    expect(report.totalAppliedOps).toBe(3)
    expect(report.patches.map((p) => p.patchIndex)).toEqual([1, 2])
    const withPortfolio = createReplayReport("g0000000001", "pf0000000001")
    expect(withPortfolio.portfolioId).toBe("pf0000000001")
  })

  it("writeReplayReport 落盘 JSON 可解析、逐 op status 枚举合法、portfolio groups 保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-report-"))
    try {
      const report = createReplayReport("base00000001", "pf0000000001")
      recordPatchReplay(report, {
        opsCount: 4,
        assertions: STATUSES.map((s, i) => assertionOf(s, i)),
        fallbackRate: { base: 0.5, next: 0.25 },
        groups: [
          { label: "hongniu", fallbackRate: { base: 0.5, next: 0.2 } },
          { label: "leihe", fallbackRate: { base: 0.5, next: 0.3 } },
        ],
      })
      const path = join(dir, "reflect.replay-report.r3.json")
      await writeReplayReport(path, report)
      const parsed = JSON.parse(await readFile(path, "utf-8")) as ReplayReport
      expect(parsed.basePlanId).toBe("base00000001")
      expect(parsed.portfolioId).toBe("pf0000000001")
      expect(parsed.totalAppliedOps).toBe(4)
      expect(parsed.patches).toHaveLength(1)
      expect(parsed.patches[0].patchIndex).toBe(1)
      expect(parsed.patches[0].opsCount).toBe(4)
      for (const a of parsed.patches[0].assertions) {
        expect(STATUSES).toContain(a.status)
      }
      expect(parsed.patches[0].groups?.[0]).toEqual({ label: "hongniu", fallbackRate: { base: 0.5, next: 0.2 } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
