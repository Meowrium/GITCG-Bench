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
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/**
 * evidence-extract 的 threat 读数注入测试：formatThreat 纯函数 +
 * extractFullDigest 行格式（用临时 run 目录，全离线）。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { extractDecisionEvidence, extractFullDigest, findOracleArtifacts, formatThreat } from "./evidence-extract.js"
import type { PlanTraceFile } from "../trace.js"

describe("formatThreat", () => {
  it("无数据返回空串（旧 trace 兼容）", () => {
    expect(formatThreat(undefined)).toBe("")
    expect(formatThreat({})).toBe("")
  })

  it("逐字段紧凑拼接，lethal 有显著标记", () => {
    expect(formatThreat({ maxDamage: 6 })).toBe(" | 威胁:dmg6")
    expect(formatThreat({ maxDamage: 6, lethal: true })).toBe(" | 威胁:dmg6/斩杀!")
    expect(formatThreat({ burstReady: true, burstP: 0.625 })).toBe(" | 威胁:爆发就绪/爆发P0.625")
    expect(formatThreat({ maxDamage: 4, maxDamageAfterSwitch: 8 })).toBe(" | 威胁:dmg4/切后dmg8")
    // lethal=false / burstReady=false 不产生噪声
    expect(formatThreat({ lethal: false, burstReady: false })).toBe("")
  })
})

describe("extractFullDigest 威胁读数注入", () => {
  let runDir = ""

  afterAll(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true })
  })

  function traceWithThreat(threat: PlanTraceFile["entries"][number]["threat"]): PlanTraceFile {
    return {
      version: "PlanTraceV1",
      planId: "p",
      parentPlanId: null,
      seed: 1,
      deckCodes: null,
      side: 0,
      opponentPolicy: "baseline",
      entries: [
        {
          seq: 0,
          round: 1,
          turn: 0,
          method: "action",
          stateLogIndex: null,
          phaseId: null,
          candidateCount: 3,
          matchedRule: { scope: "global", priority: 10, reason: "r" },
          fallbackUsed: false,
          chosen: { actionCase: "declareEnd" },
          notes: [],
          threat,
        },
      ],
      summary: {
        result: "win",
        rounds: 1,
        decisionCounts: { total: 1, ruleMatched: 1, fallback: 0 },
        coverage: 1,
        perMethod: {},
        perRuleHits: {},
        perRuleThenMiss: {},
      },
    }
  }

  it("带 threat 的 action 行追加威胁读数；无 threat 的旧 trace 行不变", async () => {
    runDir = await mkdtemp(join(tmpdir(), "evidence-extract-"))
    await mkdir(join(runDir, "game-0001"))
    await mkdir(join(runDir, "game-0002"))
    await writeFile(
      join(runDir, "game-0001", "plan_trace.json"),
      JSON.stringify(traceWithThreat({ maxDamage: 7, lethal: true, burstP: 0.5 })),
    )
    await writeFile(
      join(runDir, "game-0002", "plan_trace.json"),
      JSON.stringify(traceWithThreat(undefined)),
    )

    const digest = await extractFullDigest(runDir, 0)
    expect(digest.totalPoints).toBe(2)
    expect(digest.lines[0]).toContain("| 威胁:dmg7/斩杀!/爆发P0.5")
    expect(digest.lines[1]).not.toContain("威胁")
  })
})

describe("findOracleArtifacts（engine-only 泄漏断言）", () => {
  let runDir = ""

  afterAll(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true })
  })

  it("顶层与 game-* 子目录的 plan_eval* 全部列出；干净目录返回空", async () => {
    runDir = await mkdtemp(join(tmpdir(), "oracle-leak-"))
    await mkdir(join(runDir, "game-0001"), { recursive: true })
    await mkdir(join(runDir, "game-0002"), { recursive: true })
    // 陈旧 ISMCTS 残留 + NN 产物 + side1 变体都应被捕获
    await writeFile(join(runDir, "plan_eval_summary.json"), "{}")
    await writeFile(join(runDir, "plan_eval_summary.nn.side1.json"), "{}")
    await writeFile(join(runDir, "game-0001", "plan_eval.json"), "{}")
    await writeFile(join(runDir, "game-0002", "plan_eval.nn.side1.json"), "{}")
    // 非 eval 产物不受影响
    await writeFile(join(runDir, "summary.json"), "{}")
    await writeFile(join(runDir, "plan.side0.json"), "{}")
    await writeFile(join(runDir, "game-0001", "plan_trace.json"), "{}")

    const hits = await findOracleArtifacts(runDir)
    expect(hits.length).toBe(4)
    expect(hits.some((h) => h.endsWith("plan_eval_summary.json"))).toBe(true)
    expect(hits.some((h) => h.includes("game-0001"))).toBe(true)
    expect(hits.some((h) => h.includes("summary.json") && !h.includes("plan_eval"))).toBe(false)

    const clean = await mkdtemp(join(tmpdir(), "oracle-clean-"))
    try {
      expect(await findOracleArtifacts(clean)).toEqual([])
    } finally {
      await rm(clean, { recursive: true, force: true })
    }
  })
})

describe("engine-only 证据提取（eval 文件存在也物理短路）", () => {
  let runDir = ""

  afterAll(async () => {
    if (runDir) await rm(runDir, { recursive: true, force: true })
  })

  function richTrace(): PlanTraceFile {
    return {
      version: "PlanTraceV1",
      planId: "p",
      parentPlanId: null,
      seed: 1,
      deckCodes: null,
      side: 0,
      opponentPolicy: "baseline",
      entries: [
        {
          seq: 0, round: 1, turn: 0, method: "action", stateLogIndex: null, phaseId: null,
          candidateCount: 3,
          matchedRule: { scope: "global", priority: 10, reason: "r" },
          fallbackUsed: false,
          chosen: { actionCase: "useSkill", skillDefId: 11041 },
          notes: [],
          threat: { maxDamage: 9, lethal: true },
          thenMiss: ["global:20"],
        },
        {
          seq: 1, round: 1, turn: 0, method: "action", stateLogIndex: null, phaseId: null,
          candidateCount: 2,
          matchedRule: null,
          fallbackUsed: true,
          fallbackPolicy: "conservative",
          chosen: { actionCase: "declareEnd" },
          notes: [],
        },
        {
          seq: 2, round: 1, turn: 0, method: "action", stateLogIndex: null, phaseId: null,
          candidateCount: 3,
          matchedRule: { scope: "global", priority: 30, reason: "r2" },
          fallbackUsed: false,
          chosen: { actionCase: "declareEnd" },
          notes: [],
        },
      ],
      summary: {
        result: "loss",
        rounds: 1,
        decisionCounts: { total: 3, ruleMatched: 2, fallback: 1 },
        coverage: 2 / 3,
        perMethod: {},
        perRuleHits: { "global:10": 1, "global:30": 1 },
        perRuleThenMiss: { "global:20": 1 },
      },
    }
  }

  it("extractFullDigest 降级为引擎侧列：无 oracle 列、thenMiss/fallback 标记、declareEnd 计数", async () => {
    runDir = await mkdtemp(join(tmpdir(), "engine-only-"))
    await mkdir(join(runDir, "game-0001"))
    await writeFile(join(runDir, "game-0001", "plan_trace.json"), JSON.stringify(richTrace()))
    // 故意放 eval 文件：engine-only 必须不读（泄漏通道短路）
    await writeFile(join(runDir, "game-0001", "plan_eval.nn.json"), JSON.stringify({
      points: [{ seq: 0, round: 1, visitGap: 0.9, isBlunder: true, oracleBest: "{}", chosen: null, matchedRule: "global:10" }],
    }))

    const digest = await extractFullDigest(runDir, 0, { evidence: "engine-only", evalSuffix: "nn" })
    expect(digest.totalPoints).toBe(3)
    expect(digest.blunders).toBe(0)
    expect(digest.thenMissPoints).toBe(1)
    expect(digest.declareEnds).toBe(2)
    expect(digest.fallbacks).toBe(1)
    for (const line of digest.lines) {
      expect(line).not.toMatch(/oracle|✗|✓| ~/u)
    }
    expect(digest.lines[0]).toContain("thenMiss:global:20")
    expect(digest.lines[1]).toContain("<fallback:conservative>")
  })

  it("extractDecisionEvidence：blunder 段消失，斩杀威胁点产出，label 前缀生效", async () => {
    const ev = await extractDecisionEvidence(runDir, 0, { evidence: "engine-only", label: "vs-hongniu" })
    expect(ev.blunderLines).toEqual([])
    expect(ev.threatLines.length).toBe(1)
    expect(ev.threatLines[0]).toContain("vs-hongniu/game-0001")
    expect(ev.threatLines[0]).toContain("斩杀!")
    expect(ev.fallbackLines.length).toBe(1)
    expect(ev.fallbackLines[0]).toContain("vs-hongniu/game-0001")

    // oracle 口径对照：同一目录能读到 blunder（证明上面是门控而非数据缺失）
    const evOracle = await extractDecisionEvidence(runDir, 0, { evalSuffix: "nn" })
    expect(evOracle.blunderLines.length).toBe(1)
    expect(evOracle.threatLines).toEqual([])
  })
})
