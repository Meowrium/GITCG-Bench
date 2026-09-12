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
 * organize-export 单测：合成 fixture run（2 局 + 缺 state log 局 + 离群 perGame）
 * 固化 evidencePack 行为——五件产物、opening 类决策点行、oracle 门控（eval 泄漏探针）、
 * 抽牌序列差分、离群阈值、预算整局省略、side1 包。
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GameStateLogEntry } from "@gi-tcg/core"
import { buildEvidencePack, computeOutliers, percentile, reconstructDrawSequence, type EvidencePackResult } from "./organize-export.js"

// ── 合成 fixture 构造 ────────────────────────────────────────────────

interface TestEntity { id: number; definition: { id: number }; attachments: unknown[] }

function ent(id: number, defId: number): TestEntity {
  return { id, definition: { id: defId }, attachments: [] }
}

function playerState(pile: TestEntity[], hands: TestEntity[]): Record<string, unknown> {
  return {
    initialPile: [{ id: 111 }, { id: 222 }, { id: 333 }],
    pile,
    hands,
    characters: [],
    combatStatuses: [],
    supports: [],
    summons: [],
    dice: [],
    declaredEnd: false,
    legendUsed: false,
    activeCharacterId: 0,
    removedEntities: [],
  }
}

function logState(p0: Record<string, unknown>, p1: Record<string, unknown>, round: number, phase: string): Record<string, unknown> {
  return { roundNumber: round, currentTurn: 0, phase, winner: null, players: [p0, p1], extensions: [] }
}

/** canResume=false：对齐循环跳过 exposeState（合成 state 只需满足读取端差分所需字段） */
function logEntry(state: Record<string, unknown>): Record<string, unknown> {
  return { s: state, e: [], r: false }
}

function sigJson(round: number, turn: number, handCount: number): string {
  return JSON.stringify({
    roundNumber: round,
    currentTurn: turn,
    player: [
      {
        activeCharacterId: 101,
        character: [{ id: 101, definitionId: 1306, health: 10, maxHealth: 10, energy: 1, maxEnergy: 3, aura: 0, defeated: false }],
        dice: [8, 1, 2],
        handCard: Array.from({ length: handCount }, () => ({ definitionId: 311502 })),
        summon: [],
        support: [],
        combatStatus: [],
      },
      {
        activeCharacterId: 201,
        character: [{ id: 201, definitionId: 1103, health: 7, maxHealth: 10, energy: 2, maxEnergy: 2, aura: 0, defeated: false }],
        dice: [],
        handCard: [],
        summon: [],
        support: [],
        combatStatus: [],
      },
    ],
  })
}

function traceEntry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    seq: 0,
    round: 1,
    turn: 0,
    method: "action",
    stateLogIndex: null,
    stateSignature: sigJson(1, 0, 5),
    phaseId: null,
    candidateCount: 3,
    matchedRule: { scope: "global", priority: 10, reason: "能斩必斩" },
    fallbackUsed: false,
    chosen: { actionCase: "useSkill", skillDefId: 13061 },
    notes: [],
    thenMiss: [],
    ...over,
  }
}

function makeTrace(entries: Array<Record<string, unknown>>, side: 0 | 1): Record<string, unknown> {
  const ruleMatched = entries.filter((e) => e.matchedRule).length
  const fallback = entries.filter((e) => e.fallbackUsed).length
  return {
    version: "PlanTraceV1",
    planId: side === 0 ? "testplan0001" : "oppp plan0001",
    parentPlanId: null,
    seed: 42,
    deckCodes: ["DECKCODEAAAA", "DECKCODEBBBB"],
    side,
    opponentPolicy: "plan:xxx",
    entries,
    summary: {
      result: "win",
      rounds: 5,
      decisionCounts: { total: entries.length, ruleMatched, fallback },
      coverage: entries.length === 0 ? 0 : ruleMatched / entries.length,
      perMethod: { action: { total: entries.length, ruleMatched, fallback } },
      perRuleHits: { "global:10": ruleMatched },
      perRuleThenMiss: { "global:99": 1 },
    },
  }
}

function perGameRow(gameDir: string, coverage: number, rounds: number): Record<string, unknown> {
  return { gameDir, seed: 100 + 1, planSide: 0, winner: 1, rounds, coverage, ruleMatched: 1, fallback: 1, total: 2 }
}

describe("organize-export 证据导出器", () => {
  let runDir: string
  let packDir: string
  let result: EvidencePackResult

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), "organize-export-run-"))
    packDir = await mkdtemp(join(tmpdir(), "organize-export-pack-"))

    // game-0001：trace（含 opening 类 + 异常点）+ state log（pile 差分可重建）
    // defId 用 9991xx（确保不命中真实卡名，nameOf 回退数字串，断言稳定）
    const g1 = join(runDir, "game-0001")
    await mkdir(g1, { recursive: true })
    const trace1 = makeTrace([
      traceEntry({ seq: 0, method: "switchHands", round: 0, matchedRule: null, fallbackUsed: true, fallbackPolicy: "keep_all", chosen: { actionCase: "switchHands" } }),
      traceEntry({ seq: 1, method: "chooseActive", round: 0, matchedRule: { scope: "opening", priority: 0, reason: "首发火系一号位" }, chosen: { actionCase: "switchActive", targetDefId: 1306 } }),
      traceEntry({ seq: 2, method: "rerollDice", round: 1, matchedRule: { scope: "opening", priority: 0, reason: "保留火/雷/万能骰" }, chosen: { actionCase: "rerollDice" } }),
      traceEntry({ seq: 3 }),
      traceEntry({ seq: 4, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" }, thenMiss: ["global:99"] }),
    ], 0)
    await writeFile(join(g1, "plan_trace.json"), JSON.stringify(trace1), "utf-8")
    // oracle 泄漏探针：engine-only 门控下该文件内容不得出现在任何产物中
    await writeFile(join(g1, "plan_eval.json"), JSON.stringify({ points: [{ seq: 3, oracleBest: "SECRET_ORACLE_MARKER" }] }), "utf-8")
    const stateLog = {
      v: "0.0.0",
      store: [],
      log: [
        logEntry(logState(playerState([ent(1, 999111), ent(2, 999222), ent(3, 999333)], []), playerState([ent(4, 999444)], []), 0, "initHands")),
        logEntry(logState(playerState([ent(3, 999333)], [ent(1, 999111), ent(2, 999222)]), playerState([ent(5, 999555)], [ent(4, 999444)]), 1, "roll")),
      ],
    }
    await writeFile(join(g1, "game_state_log.json"), JSON.stringify(stateLog), "utf-8")
    await writeFile(join(g1, "plan_trace.side1.json"), JSON.stringify(makeTrace([traceEntry({ seq: 0, method: "action", matchedRule: { scope: "global", priority: 5, reason: "对手规则" } })], 1)), "utf-8")

    // game-0002：只有 trace，无 state log（导出器须容忍并标注）
    const g2 = join(runDir, "game-0002")
    await mkdir(g2, { recursive: true })
    await writeFile(join(g2, "plan_trace.json"), JSON.stringify(makeTrace([traceEntry({ seq: 0, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" } })], 0)), "utf-8")

    // run 级产物
    const summary = {
      planId: "testplan0001",
      gameVersion: "v6.6.0",
      games: 4,
      seedBase: 100,
      alternateFirstPlayer: false,
      wins: 0, losses: 4, draws: 0,
      winRate: 0,
      avgRounds: 12.5,
      avgCoverage: 0.4875,
      fallbackRate: 0.5,
      perRuleHits: { "global:10": 2, "global:5": 0 },
      perRuleThenMiss: { "global:99": 2 },
      perGame: [
        perGameRow("game-0001", 0.6, 6),
        perGameRow("game-0002", 0.65, 30),
        perGameRow("game-0003", 0.0, 7),
        perGameRow("game-0004", 0.7, 7),
      ],
    }
    await writeFile(join(runDir, "summary.json"), JSON.stringify(summary), "utf-8")
    await writeFile(join(runDir, "summary.side1.json"), JSON.stringify({ ...summary, planId: "oppp plan0001", winRate: 1 }), "utf-8")
    await writeFile(join(runDir, "plan.side0.json"), JSON.stringify({ planId: "testplan0001", rules: [] }), "utf-8")

    result = await buildEvidencePack({ runDir, outDir: packDir, games: "all" })
  })

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true })
    await rm(packDir, { recursive: true, force: true })
  })

  it("五件产物 + plan.side0.json + manifest 全部落盘", () => {
    for (const f of ["fullDigest.txt", "stateSignatures.jsonl", "draw-sequence.md", "outliers.json", "manifest.json", "plan.side0.json", "side1/summary.side1.json", "side1/game-0001/plan_trace.side1.json"]) {
      expect(result.files).toContain(f)
    }
    expect(result.side1Present).toBe(true)
    expect(result.gamesSelected).toEqual(["game-0001", "game-0002"])
  })

  it("fullDigest 含 opening 类决策点行 + oracle 门控（eval 探针不泄漏）", async () => {
    const text = await readFile(join(packDir, "fullDigest.txt"), "utf-8")
    expect(text).toContain("[game-0001 seq0")
    expect(text).toContain("switchHands")
    expect(text).toContain("[game-0001 seq1")
    expect(text).toContain("chooseActive")
    expect(text).toContain("[game-0001 seq2")
    expect(text).toContain("rerollDice")
    // opening 行带 reason（mentions 交叉对照的第一手材料）
    expect(text).toContain("首发火系一号位")
    // 异常点 decision_detail（fallback / declareEnd / thenMiss；thenMiss 见条目 JSON）
    expect(text).toContain("decision_detail")
    expect(text).toContain("conservative")
    expect(text).toContain('"thenMiss":["global:99"]')
    // oracle 门控：eval 文件内容不得泄漏（engine-only）
    expect(text).not.toContain("SECRET_ORACLE_MARKER")
    expect(text).not.toContain("oracle 回算原文")
  })

  it("stateSignatures.jsonl 每决策点整条签名（不抽摘要）", async () => {
    const raw = await readFile(join(packDir, "stateSignatures.jsonl"), "utf-8")
    const lines = raw.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(6) // game-0001 5 条 + game-0002 1 条
    const first = JSON.parse(lines[0]!) as { game: string; seq: number; method: string; stateSignature: Record<string, unknown> }
    expect(first.game).toBe("game-0001")
    expect(first.seq).toBe(0)
    expect(first.method).toBe("switchHands")
    // 整条签名 = 可解析对象（玩家视角双方角色/骰/手牌俱在）
    expect(first.stateSignature.player).toHaveLength(2)
    expect((first.stateSignature.player as unknown[])[0]).toHaveProperty("handCard")
  })

  it("draw-sequence 与 pile 差分一致（事件 + 结算自洽）", async () => {
    const md = await readFile(join(packDir, "draw-sequence.md"), "utf-8")
    // P0：log#1 一次抽 2 张（entity 1/2 离堆进手），剩 entity 3
    expect(md).toContain("- log#1 r1 t0 phase=roll 抽 999111(999111) [entity 1]")
    expect(md).toContain("- log#1 r1 t0 phase=roll 抽 999222(999222) [entity 2]")
    expect(md).toContain("### P0（deck DECKCODEAAAA")
    // P1：entity 4 离堆进手（抽），entity 5 进堆（回洗）
    expect(md).toContain("抽 999444(999444) [entity 4]")
    expect(md).toContain("回洗 999555(999555) [entity 5]")
    // 结算行自洽：初始 - 抽出 - 离堆 = 牌堆剩
    expect(md).toContain("- 结算：初始 3 ｜ 抽出 2 ｜ 离堆 0 ｜ 回洗 0 ｜ 牌堆剩 1")
    // game-0002 无 state log：标注不可用而非崩溃
    expect(md).toContain("state log 不可用")
  })

  it("outliers.json 离群判定与阈值数字和 perGame 一致", async () => {
    const doc = JSON.parse(await readFile(join(packDir, "outliers.json"), "utf-8")) as {
      thresholds: { coverageMedian: number; coverageLower: number; roundsP95: number }
      outlierGames: string[]
      perGame: Array<{ gameDir: string; flags: string[] }>
      runAggregates: { perRuleHits: Record<string, number>; declareEnd: { count: number } }
    }
    expect(doc.thresholds.coverageMedian).toBeCloseTo(0.625, 10)
    expect(doc.thresholds.coverageLower).toBeCloseTo(0.625 - 2 * 0.2836700, 5)
    expect(doc.thresholds.roundsP95).toBeCloseTo(26.55, 10)
    expect(doc.outlierGames).toEqual(["game-0002", "game-0003"])
    const byGame = new Map(doc.perGame.map((r) => [r.gameDir, r.flags]))
    expect(byGame.get("game-0002")).toEqual(["roundsSpike"])
    expect(byGame.get("game-0003")).toEqual(["coverageCollapse"])
    expect(byGame.get("game-0001")).toEqual([])
    // run 级机械聚合（misalign 锚点原料）
    expect(doc.runAggregates.perRuleHits["global:5"]).toBe(0)
    expect(doc.runAggregates.declareEnd.count).toBe(2)
  })

  it("side1 包与 side0 视角互补（同一局两边 trace 都在）", async () => {
    const side1 = JSON.parse(await readFile(join(packDir, "side1", "game-0001", "plan_trace.side1.json"), "utf-8")) as { side: number; planId: string }
    const side0 = JSON.parse(await readFile(join(runDir, "game-0001", "plan_trace.json"), "utf-8")) as { side: number; planId: string }
    expect(side0.side).toBe(0)
    expect(side1.side).toBe(1)
    expect(side1.planId).not.toBe(side0.planId)
    const summary1 = JSON.parse(await readFile(join(packDir, "side1", "summary.side1.json"), "utf-8")) as { planId: string }
    expect(summary1.planId).toBe("oppp plan0001")
  })

  it("manifest 自述 oracle-free 与对齐警告", async () => {
    const manifest = JSON.parse(await readFile(join(packDir, "manifest.json"), "utf-8")) as {
      oracleFree: boolean
      side1Present: boolean
      alignmentWarnings: Record<string, string[]>
      limits: { perGameTruncation: boolean }
    }
    expect(manifest.oracleFree).toBe(true)
    expect(manifest.side1Present).toBe(true)
    expect(manifest.limits.perGameTruncation).toBe(false)
    // 合成 trace 的 action 条目带签名但无 canResume 暂停点 → 记录对齐警告（不崩溃）
    expect(Object.keys(manifest.alignmentWarnings)).toEqual(["game-0001", "game-0002"])
  })

  it("总预算超限按整局省略（单局不截断）", async () => {
    const tight = await buildEvidencePack({ runDir, outDir: `${packDir}-tight`, games: "all", maxLines: 10, maxChars: 500 })
    expect(tight.omittedGames).toEqual(["game-0001", "game-0002"])
    expect(tight.fullDigest.lines).toBeLessThan(20)
    const text = await readFile(`${packDir}-tight/fullDigest.txt`, "utf-8")
    expect(text).toContain("因总上限省略 2 局")
    expect(text).toContain("planId: testplan0001") // 头部 run 概览仍在
    expect(text).not.toContain("## game-0001 ｜ 结果") // 整局省略，不截断半局
    await rm(`${packDir}-tight`, { recursive: true, force: true })
  })
})

describe("organize-export 纯函数", () => {
  it("percentile 线性插值", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 10)
    expect(percentile([5], 0.95)).toBe(5)
    expect(percentile([], 0.5)).toBe(0)
  })

  it("computeOutliers：coverage < 中位数-2σ 且 rounds > P95", () => {
    const rows = [
      { gameDir: "game-0001", seed: 1, planSide: 0 as const, winner: 1 as const, rounds: 6, coverage: 0.6, ruleMatched: 6, fallback: 0, total: 10 },
      { gameDir: "game-0002", seed: 2, planSide: 0 as const, winner: 0 as const, rounds: 30, coverage: 0.65, ruleMatched: 6, fallback: 0, total: 10 },
      { gameDir: "game-0003", seed: 3, planSide: 0 as const, winner: 1 as const, rounds: 7, coverage: 0.0, ruleMatched: 0, fallback: 10, total: 10 },
      { gameDir: "game-0004", seed: 4, planSide: 0 as const, winner: 1 as const, rounds: 7, coverage: 0.7, ruleMatched: 7, fallback: 0, total: 10 },
    ]
    const { thresholds, rows: out, outlierGames } = computeOutliers(rows)
    expect(thresholds.coverageMedian).toBeCloseTo(0.625, 10)
    expect(outlierGames).toEqual(["game-0002", "game-0003"])
    expect(out.find((r) => r.gameDir === "game-0002")!.flags).toEqual(["roundsSpike"])
    expect(out.find((r) => r.gameDir === "game-0003")!.flags).toEqual(["coverageCollapse"])
  })
})

describe("reconstructDrawSequence（pile 差分）", () => {
  const mk = (players: Array<{ pile: TestEntity[]; hands: TestEntity[] }>, round: number, phase: string): GameStateLogEntry => {
    const p1 = players[1] ?? { pile: [], hands: [] }
    return ({
      state: logState(playerState(players[0]!.pile, players[0]!.hands), playerState(p1.pile, p1.hands), round, phase),
      canResume: false,
      mutations: undefined,
    }) as unknown as GameStateLogEntry
  }

  it("draw / leave / return 分类与计数", () => {
    const log = [
      mk([{ pile: [ent(1, 999111), ent(2, 999222), ent(3, 999333)], hands: [] }], 0, "initHands"),
      mk([{ pile: [ent(3, 999333)], hands: [ent(1, 999111), ent(2, 999222)] }], 1, "roll"),
      mk([{ pile: [ent(2, 999222)], hands: [ent(1, 999111)] }], 1, "action"), // 333 离堆未进手；222 回洗
      mk([{ pile: [], hands: [ent(1, 999111), ent(2, 999222)] }], 2, "roll"), // 222 再抽
    ]
    const seq = reconstructDrawSequence(log, 0)
    expect(seq.initialCount).toBe(3)
    expect(seq.events).toEqual([
      { logIndex: 1, round: 1, turn: 0, phase: "roll", kind: "draw", defId: 999111, entityId: 1 },
      { logIndex: 1, round: 1, turn: 0, phase: "roll", kind: "draw", defId: 999222, entityId: 2 },
      { logIndex: 2, round: 1, turn: 0, phase: "action", kind: "leave", defId: 999333, entityId: 3 },
      { logIndex: 2, round: 1, turn: 0, phase: "action", kind: "return", defId: 999222, entityId: 2 },
      { logIndex: 3, round: 2, turn: 0, phase: "roll", kind: "draw", defId: 999222, entityId: 2 },
    ])
    expect(seq.drawn).toBe(3)
    expect(seq.left).toBe(1)
    expect(seq.returned).toBe(1)
    expect(seq.finalPileCount).toBe(0)
    // 结算自洽：初始 = 剩 + 抽出 + 离堆 - 回洗
    expect(seq.finalPileCount).toBe(seq.initialCount - seq.drawn - seq.left + seq.returned)
  })
})
