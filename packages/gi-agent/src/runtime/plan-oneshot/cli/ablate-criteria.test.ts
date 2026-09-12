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
 * 消融引擎侧判据（judgeEngineOnly）的纯函数测试：
 * thenMiss 归零主判据 / 覆盖率混淆闸 / 胜率区间 N≥20 闸 / 同种子反事实判据。
 * 另覆盖 ablate-numeric.ts 的数值修订检测与配对命中数提取（含降级路径）。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeEngineOnly, type EngineOnlyJudgeInput } from "./ablate-criteria.js"
import {
  countRuleHitsInTrace,
  diffNumericRevision,
  extractNumericPairedHits,
  pairHitsBySeed,
} from "./ablate-numeric.js"
import type { DecisionRuleV1 } from "../game-plan-v1.js"

const base: EngineOnlyJudgeInput = {
  verdict: "revise",
  ruleRef: "global:10",
  baseThenMiss: 5,
  armThenMiss: 0,
  baseCoverage: 0.8,
  armCoverage: 0.8,
  baseFallbackRate: 0.1,
  armFallbackRate: 0.1,
  baseWinRate: 0.5,
  armWinRate: 0.5,
  games: 20,
  minEffect: 0.03,
  coverageTol: 0.05,
}

describe("judgeEngineOnly（thenMiss 类修订）", () => {
  it("thenMiss 归零 → supported", () => {
    const r = judgeEngineOnly({ ...base, baseThenMiss: 5, armThenMiss: 0 })
    expect(r.status).toBe("supported")
    expect(r.note).toContain("归零")
  })

  it("thenMiss 部分下降未归零 → inconclusive", () => {
    expect(judgeEngineOnly({ ...base, baseThenMiss: 5, armThenMiss: 2 }).status).toBe("inconclusive")
  })

  it("thenMiss 未降/反升 → refuted", () => {
    expect(judgeEngineOnly({ ...base, baseThenMiss: 5, armThenMiss: 5 }).status).toBe("refuted")
    expect(judgeEngineOnly({ ...base, baseThenMiss: 5, armThenMiss: 7 }).status).toBe("refuted")
  })

  it("thenMiss 归零但 coverage 崩坏 → inconclusive（混淆闸）", () => {
    const r = judgeEngineOnly({ ...base, baseThenMiss: 5, armThenMiss: 0, armCoverage: 0.7 })
    expect(r.status).toBe("inconclusive")
    expect(r.note).toContain("覆盖劣化")
  })

  it("fallback 率跳升同样触发混淆闸", () => {
    expect(judgeEngineOnly({ ...base, armFallbackRate: 0.2 }).status).toBe("inconclusive")
  })
})

describe("judgeEngineOnly（胜率区间判据：remove / 非 thenMiss 类 revise）", () => {
  const winBase = { ...base, baseThenMiss: 0, armThenMiss: 0 }

  it("remove 胜率升超阈值（N=20）→ supported", () => {
    expect(judgeEngineOnly({ ...winBase, verdict: "remove", armWinRate: 0.65 }).status).toBe("supported")
  })

  it("remove 胜率降超阈值 → refuted", () => {
    expect(judgeEngineOnly({ ...winBase, verdict: "remove", armWinRate: 0.4 }).status).toBe("refuted")
  })

  it("胜率落在噪声区间内 → inconclusive", () => {
    expect(judgeEngineOnly({ ...winBase, verdict: "remove", armWinRate: 0.52 }).status).toBe("inconclusive")
  })

  it("N<20 时胜率判据不生效（样本量闸）", () => {
    const r = judgeEngineOnly({ ...winBase, verdict: "remove", armWinRate: 0.9, games: 10 })
    expect(r.status).toBe("inconclusive")
    expect(r.note).toContain("N≥20")
  })

  it("胜率升但覆盖崩坏 → inconclusive（无法归因）", () => {
    expect(judgeEngineOnly({ ...winBase, verdict: "remove", armWinRate: 0.7, armCoverage: 0.6 }).status).toBe("inconclusive")
  })

  it("臂 thenMiss 新增在 note 中提示（不直接改判）", () => {
    const r = judgeEngineOnly({ ...winBase, armThenMiss: 3, armWinRate: 0.65 })
    expect(r.status).toBe("supported")
    expect(r.note).toContain("thenMiss 新增 3")
  })
})

describe("judgeEngineOnly（同种子反事实判据：数值修订 revise 臂）", () => {
  const numBase: EngineOnlyJudgeInput = { ...base, baseThenMiss: 0, armThenMiss: 0 }
  const paired = (baseHits: number[], armHits: number[]) => ({ seeds: baseHits.length, baseHits, armHits })

  it("命中率上升超阈值 → supported（note 含判据名 / seeds / 方向）", () => {
    const r = judgeEngineOnly({ ...numBase, numericPaired: paired(Array(20).fill(0), Array(20).fill(1)) })
    expect(r.status).toBe("supported")
    expect(r.note).toContain("同种子反事实判据")
    expect(r.note).toContain("seeds=20")
    expect(r.note).toContain("命中率上升")
  })

  it("命中率下降超阈值 → refuted", () => {
    const r = judgeEngineOnly({ ...numBase, numericPaired: paired(Array(20).fill(1), Array(20).fill(0)) })
    expect(r.status).toBe("refuted")
    expect(r.note).toContain("命中率下降")
  })

  it("命中率差落在噪声区间内 → inconclusive", () => {
    const r = judgeEngineOnly({ ...numBase, numericPaired: paired(Array(20).fill(1), Array(20).fill(1)) })
    expect(r.status).toBe("inconclusive")
    expect(r.note).toContain("落在噪声区间内")
  })

  it("配对 seeds<20 → inconclusive（N≥20 闸优先于效应量）", () => {
    const r = judgeEngineOnly({ ...numBase, numericPaired: paired(Array(10).fill(0), Array(10).fill(1)) })
    expect(r.status).toBe("inconclusive")
    expect(r.note).toContain("N≥20")
    expect(r.note).toContain("seeds=10")
  })

  it("覆盖劣化优先于配对判定 → inconclusive（混淆闸）", () => {
    const r = judgeEngineOnly({
      ...numBase,
      armCoverage: 0.7,
      numericPaired: paired(Array(20).fill(0), Array(20).fill(1)),
    })
    expect(r.status).toBe("inconclusive")
    expect(r.note).toContain("覆盖劣化")
  })

  it("thenMiss 归零优先于配对判据（baseThenMiss>0）", () => {
    const r = judgeEngineOnly({
      ...numBase,
      baseThenMiss: 5,
      armThenMiss: 0,
      numericPaired: paired(Array(20).fill(1), Array(20).fill(0)),
    })
    expect(r.status).toBe("supported")
    expect(r.note).toContain("归零")
    expect(r.note).not.toContain("同种子反事实判据")
  })

  it("numericPaired 缺省 → 回落胜率区间判据", () => {
    const r = judgeEngineOnly({ ...numBase, armWinRate: 0.65 })
    expect(r.status).toBe("supported")
    expect(r.note).toContain("胜率")
    expect(r.note).not.toContain("同种子反事实判据")
  })
})

describe("diffNumericRevision（数值修订检测）", () => {
  const rule = (over: Partial<DecisionRuleV1> = {}): DecisionRuleV1 => ({
    priority: 10,
    then: { action_case: "useSkill" },
    reason: "test",
    ...over,
  })

  it("then.damage_min 变化 → touched（变化清单可读）", () => {
    const d = diffNumericRevision(
      rule({ then: { action_case: "useSkill", damage_min: 3 } }),
      rule({ then: { action_case: "useSkill", damage_min: 5 } }),
    )
    expect(d.touched).toBe(true)
    expect(d.changes).toEqual(["then.damage_min 3→5"])
  })

  it("then.kills 变化 → touched", () => {
    const d = diffNumericRevision(
      rule({ then: { action_case: "useSkill", kills: false } }),
      rule({ then: { action_case: "useSkill", kills: true } }),
    )
    expect(d.touched).toBe(true)
    expect(d.changes[0]).toContain("then.kills false→true")
  })

  it("when 骰子闸数值变化 → touched（dice.total / dice.pyro / dice.pyro+omni）", () => {
    const d = diffNumericRevision(
      rule({ when: [{ field: "dice.total", op: ">=", value: 3 }, { field: "dice.pyro", op: ">=", value: 2 }, { field: "dice.pyro+omni", op: ">=", value: 3 }] }),
      rule({ when: [{ field: "dice.total", op: ">=", value: 4 }, { field: "dice.pyro", op: ">=", value: 2 }, { field: "dice.pyro+omni", op: ">=", value: 5 }] }),
    )
    expect(d.touched).toBe(true)
    expect(d.changes).toEqual(["when dice.pyro+omni 3→5", "when dice.total 3→4"])
  })

  it("when HP 闸数值变化 → touched（active / characters.<defId>）", () => {
    const d = diffNumericRevision(
      rule({ when: [{ field: "self.active.hp", op: "<=", value: 5 }, { field: "opponent.characters.1302.hp", op: "<=", value: 6 }] }),
      rule({ when: [{ field: "self.active.hp", op: "<=", value: 3 }, { field: "opponent.characters.1302.hp", op: "<=", value: 6 }] }),
    )
    expect(d.touched).toBe(true)
    expect(d.changes).toEqual(["when self.active.hp 5→3"])
  })

  it("数值未变（含算子变化）→ 不标记", () => {
    const d = diffNumericRevision(
      rule({ then: { action_case: "useSkill", damage_min: 3 }, when: [{ field: "dice.pyro", op: ">=", value: 2 }] }),
      rule({ then: { action_case: "useSkill", damage_min: 3 }, when: [{ field: "dice.pyro", op: "<=", value: 2 }] }),
    )
    expect(d).toEqual({ touched: false, changes: [] })
  })

  it("非数值闸字段变化（手牌/召唤物计数）→ 不标记", () => {
    const d = diffNumericRevision(
      rule({ when: [{ field: "hand.count", op: ">=", value: 2 }] }),
      rule({ when: [{ field: "hand.count", op: ">=", value: 4 }] }),
    )
    expect(d.touched).toBe(false)
  })

  it("闸条件新增/删除 → 标记（数值集合变化）", () => {
    expect(diffNumericRevision(rule(), rule({ when: [{ field: "self.active.hp", op: "<=", value: 5 }] })).touched).toBe(true)
    expect(diffNumericRevision(rule({ when: [{ field: "dice.total", op: ">=", value: 3 }] }), rule()).touched).toBe(true)
  })
})

describe("pairHitsBySeed / countRuleHitsInTrace", () => {
  it("按 seed 升序配对并跳过单侧缺失局", () => {
    const r = pairHitsBySeed(new Map([[103, 5], [101, 2], [102, 0]]), new Map([[100, 1], [101, 3], [103, 0]]))
    expect(r.seedList).toEqual([101, 103])
    expect(r.baseHits).toEqual([2, 5])
    expect(r.armHits).toEqual([3, 0])
    expect(r.skipped).toBe(2)
  })

  it("countRuleHitsInTrace 按 matchedRule + phaseId 拼键（与 perRuleHits 同口径）", () => {
    const trace = {
      entries: [
        { phaseId: null, matchedRule: { scope: "global", priority: 10 } },
        { phaseId: "burst", matchedRule: { scope: "phase", priority: 20 } },
        { phaseId: "burst", matchedRule: { scope: "phase", priority: 20 } },
        { phaseId: null, matchedRule: null },
      ],
      summary: { perRuleHits: { "global:10": 1, "phase:burst:20": 2 } },
    }
    expect(countRuleHitsInTrace(trace, "global:10")).toEqual({ hits: 1, entryIdentity: true })
    expect(countRuleHitsInTrace(trace, "phase:burst:20")).toEqual({ hits: 2, entryIdentity: true })
    expect(countRuleHitsInTrace(trace, "global:99")).toEqual({ hits: 0, entryIdentity: true })
  })

  it("逐条目身份与 summary 聚合矛盾 → entryIdentity=false（降级信号）", () => {
    const trace = {
      entries: [{ phaseId: null, matchedRule: null }],
      summary: { perRuleHits: { "global:10": 1 } },
    }
    expect(countRuleHitsInTrace(trace, "global:10")).toEqual({ hits: 0, entryIdentity: false })
    expect(countRuleHitsInTrace({ summary: { perRuleHits: {} } }, "global:10")).toEqual({ hits: 0, entryIdentity: false })
  })
})

describe("extractNumericPairedHits（逐局 trace 配对 + 降级）", () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ablate-numeric-"))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const traceJson = (hits: number, entryIdentity = true): Record<string, unknown> => {
    const entries = Array.from({ length: hits }, (_, i) => ({
      seq: i,
      round: 1,
      turn: 0,
      method: "action",
      stateLogIndex: null,
      phaseId: null,
      candidateCount: 2,
      matchedRule: entryIdentity ? { scope: "global", priority: 10, reason: "test" } : null,
      fallbackUsed: false,
      chosen: null,
      notes: [],
      thenMiss: [],
    }))
    return {
      version: "PlanTraceV1",
      planId: "testplan",
      parentPlanId: null,
      seed: 1,
      deckCodes: null,
      side: 0,
      opponentPolicy: "plan:opp",
      entries,
      summary: {
        result: "win",
        rounds: 3,
        decisionCounts: { total: entries.length, ruleMatched: hits, fallback: 0 },
        coverage: 1,
        perMethod: {},
        perRuleHits: { "global:10": hits },
        perRuleThenMiss: {},
      },
    }
  }

  const writeRun = async (name: string, games: Array<{ dir: string; hits: number; entryIdentity?: boolean }>): Promise<string> => {
    const runDir = join(root, name)
    for (const g of games) {
      await mkdir(join(runDir, g.dir), { recursive: true })
      await writeFile(join(runDir, g.dir, "plan_trace.json"), JSON.stringify(traceJson(g.hits, g.entryIdentity ?? true)), "utf-8")
    }
    return runDir
  }

  const perGame = (games: Array<{ dir: string; seed: number }>) => games.map((g) => ({ gameDir: g.dir, seed: g.seed }))

  it("同 seed 配对命中数（两侧齐全）", async () => {
    const baseRunDir = await writeRun("ok/base", [{ dir: "game-0001", hits: 1 }, { dir: "game-0002", hits: 0 }])
    const armRunDir = await writeRun("ok/arm", [{ dir: "game-0001", hits: 2 }, { dir: "game-0002", hits: 1 }])
    const r = await extractNumericPairedHits({
      baseRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: perGame([{ dir: "game-0001", seed: 100 }, { dir: "game-0002", seed: 101 }]),
      armPerGame: perGame([{ dir: "game-0001", seed: 100 }, { dir: "game-0002", seed: 101 }]),
    })
    expect(r.unavailable).toBeUndefined()
    expect(r.seeds).toBe(2)
    expect(r.baseHits).toEqual([1, 0])
    expect(r.armHits).toEqual([2, 1])
    expect(r.skipped).toBe(0)
  })

  it("单侧缺失局跳过并计数", async () => {
    const baseRunDir = await writeRun("skip/base", [{ dir: "game-0001", hits: 1 }, { dir: "game-0002", hits: 1 }])
    const armRunDir = await writeRun("skip/arm", [{ dir: "game-0001", hits: 2 }])
    const r = await extractNumericPairedHits({
      baseRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: perGame([{ dir: "game-0001", seed: 100 }, { dir: "game-0002", seed: 101 }]),
      armPerGame: perGame([{ dir: "game-0001", seed: 100 }]),
    })
    expect(r.seeds).toBe(1)
    expect(r.baseHits).toEqual([1])
    expect(r.armHits).toEqual([2])
    expect(r.skipped).toBe(1)
  })

  it("基线缺 perGame → 不可用（回落胜率区间）", async () => {
    const armRunDir = await writeRun("noperGame/arm", [{ dir: "game-0001", hits: 1 }])
    const r = await extractNumericPairedHits({
      baseRunDir: armRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: [],
      armPerGame: perGame([{ dir: "game-0001", seed: 100 }]),
    })
    expect(r.unavailable).toContain("perGame")
  })

  it("两侧 seed 无交集 → 不可用", async () => {
    const baseRunDir = await writeRun("nomatch/base", [{ dir: "game-0001", hits: 1 }])
    const armRunDir = await writeRun("nomatch/arm", [{ dir: "game-0001", hits: 1 }])
    const r = await extractNumericPairedHits({
      baseRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: perGame([{ dir: "game-0001", seed: 100 }]),
      armPerGame: perGame([{ dir: "game-0001", seed: 200 }]),
    })
    expect(r.unavailable).toContain("无交集")
  })

  it("trace 缺逐条目规则身份 → 不可用", async () => {
    const baseRunDir = await writeRun("noid/base", [{ dir: "game-0001", hits: 1, entryIdentity: false }])
    const armRunDir = await writeRun("noid/arm", [{ dir: "game-0001", hits: 1 }])
    const r = await extractNumericPairedHits({
      baseRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: perGame([{ dir: "game-0001", seed: 100 }]),
      armPerGame: perGame([{ dir: "game-0001", seed: 100 }]),
    })
    expect(r.unavailable).toContain("逐条目规则身份")
  })

  it("配对局两侧均零命中 → 不可用（无信号）", async () => {
    const baseRunDir = await writeRun("zero/base", [{ dir: "game-0001", hits: 0 }])
    const armRunDir = await writeRun("zero/arm", [{ dir: "game-0001", hits: 0 }])
    const r = await extractNumericPairedHits({
      baseRunDir,
      armRunDir,
      traceFileName: "plan_trace.json",
      refKey: "global:10",
      basePerGame: perGame([{ dir: "game-0001", seed: 100 }]),
      armPerGame: perGame([{ dir: "game-0001", seed: 100 }]),
    })
    expect(r.unavailable).toContain("均无该规则命中")
  })
})
