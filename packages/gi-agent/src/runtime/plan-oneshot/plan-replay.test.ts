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
 * plan-replay 测试：fixture run 目录（1 局 trace+eval）上的静态回放矩阵、
 * 与原计划的 diff、逐 op 反事实断言、本侧文件授权边界（side1 数据不被 side0 语料读取）。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import getData from "@gi-tcg/data"
import { CURRENT_VERSION, type DeckConfig } from "@gi-tcg/core"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import {
  loadReplayCorpus,
  replayPlan,
  replayChainPlan,
  replayPortfolio,
  verifyPatchAssertions,
  verifyPortfolioPatchAssertions,
  formatPatchVerification,
  sideFileNames,
} from "./plan-replay.js"
import { lintPlan } from "./fields-lint.js"
import { applyPlanPatch } from "./plan-patch.js"
import type { ResolvedPortfolio } from "./portfolio.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

const gameData = getData(CURRENT_VERSION)

/** 真实牌表码（hasCardP 口径测试用：known_deck 解码路径） */
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

/** 玩家视角 state 最小构造（字段与 fields.ts 求值所需对齐） */
function state(opts: { dice?: number[]; hp?: number; oppHp?: number; activeDefId?: number }): unknown {
  const dice = opts.dice ?? [6, 6, 8, 3, 3]
  const mkChar = (defId: number, hp: number, id: number, active: boolean) => ({
    id, definitionId: defId, health: hp, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, defeated: false,
    ...(active ? {} : {}),
  })
  return {
    roundNumber: 3,
    currentTurn: 1,
    player: [
      {
        activeCharacterId: -1,
        character: [mkChar(opts.activeDefId ?? 1605, opts.hp ?? 10, -1, true), mkChar(1309, 10, -2, false), mkChar(1602, 12, -3, false)],
        dice,
        handCard: [],
        summon: [],
        support: [],
        combatStatus: [],
        declaredEnd: false,
        initiativeSkill: [],
        legendUsed: false,
        pileCard: [],
      },
      {
        activeCharacterId: -4,
        character: [mkChar(2301, opts.oppHp ?? 6, -4, true), mkChar(2302, 8, -5, false), mkChar(2303, 8, -6, false)],
        dice: [1, 1, 2],
        handCard: [{ definitionId: 330002, id: -100 }],
        summon: [],
        support: [],
        combatStatus: [],
        declaredEnd: false,
        initiativeSkill: [],
        legendUsed: false,
        pileCard: [],
      },
    ],
  }
}

function plan(opts?: { tuningWhen?: never[] | undefined }): GamePlanV1 {
  void opts
  return {
    version: "GamePlanV1",
    planId: "bbbbbbbbbbbb",
    parentPlanId: null,
    createdAt: "2026-08-30T00:00:00Z",
    author: "test",
    context: { deckCode: "ABC", opponent: { kind: "mirror" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
    opening: { chooseActive: [], mulligan: [], reroll: [] },
    phases: [],
    rules: [
      { priority: 5, when: [{ field: "dice.geo+omni", op: ">=", value: 3 }], then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "岩战技" },
      { priority: 20, when: [{ field: "opponent.active.hp", op: "<=", value: 4 }], then: { action_case: "useSkill", skill_type: "normal_attack", target: "opponent.active" }, reason: "收头普攻" },
      { priority: 30, then: { action_case: "elementalTuning" }, reason: "调和兜底" },
    ],
    fallback: { policy: "conservative" },
  }
}

function writeFixture(
  runDir: string,
  side: 0 | 1,
  points: Array<{ seq: number; state: unknown; blunder?: boolean; rule?: string | null }>,
  routing?: "general-only" | `single:${string}`,
): void {
  const { traceName, evalName } = sideFileNames(side)
  const gameDir = join(runDir, "game-0001")
  mkdirSync(gameDir, { recursive: true })
  const entries = points.map((p) => ({
    seq: p.seq, stateLogIndex: null, round: 3, turn: 1, method: "action",
    phaseId: null, candidateCount: 5,
    matchedRule: null, fallbackUsed: false,
    chosen: { actionCase: "declareEnd" }, notes: [],
    stateSignature: JSON.stringify(p.state),
  }))
  const trace = {
    version: "PlanTraceV1", planId: "bbbbbbbbbbbb", parentPlanId: null, seed: 1,
    deckCodes: ["ABC", "ABC"], side, opponentPolicy: "baseline",
    ...(routing !== undefined ? { routing } : {}),
    entries,
    summary: { result: "win", rounds: 5, decisionCounts: { total: points.length, ruleMatched: points.length, fallback: 0 }, coverage: 1, perMethod: {}, perRuleHits: {}, perRuleThenMiss: {} },
  }
  writeFileSync(join(gameDir, traceName), JSON.stringify(trace))
  writeFileSync(join(gameDir, evalName), JSON.stringify({
    points: points.map((p) => ({ seq: p.seq, isBlunder: p.blunder ?? false, visitGap: p.blunder ? 4 : 0, oracleBest: "{\"actionCase\":\"switchActive\"}", matchedRule: p.rule ?? null })),
  }))
}

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), "plan-replay-"))
}

describe("loadReplayCorpus", () => {
  it("只读本侧文件（授权边界）：side0 语料不含 side1 投毒数据", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      writeFixture(runDir, 0, [
        { seq: 0, state: state({}), blunder: true, rule: "global:20" },
        { seq: 1, state: state({ dice: [1, 1, 1, 1] }), blunder: false, rule: "global:5" },
      ])
      // side1 投毒：如果 side0 语料误读 side1 文件，点数会变多
      writeFixture(runDir, 1, [{ seq: 0, state: state({}), blunder: true, rule: "global:999" }])
      const corpus = await loadReplayCorpus(runDir, 0)
      expect(corpus.gameCount).toBe(1)
      expect(corpus.points).toHaveLength(2)
      expect(corpus.points.every((p) => p.traceRule !== "global:999")).toBe(true)
      // side1 语料独立可读（互不污染）
      const corpus1 = await loadReplayCorpus(runDir, 1)
      expect(corpus1.points).toHaveLength(1)
      expect(corpus1.points[0].traceRule).toBe("global:999")
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe("replayPlan", () => {
  it("命中矩阵：首条命中 / fallback / 被遮蔽计数", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      // seq0: geo+omni=3 → global:5；seq1: 无岩骰、对手 hp6 → global:30 调和兜底；seq2: 对手 hp2，无岩骰 → global:20 收头
      writeFixture(runDir, 0, [
        { seq: 0, state: state({ dice: [6, 6, 8] }) },
        { seq: 1, state: state({ dice: [3, 3, 1], oppHp: 6 }) },
        { seq: 2, state: state({ dice: [3, 3, 1], oppHp: 2 }) },
      ])
      const corpus = await loadReplayCorpus(runDir, 0)
      const p = plan()
      const r = replayPlan(p, corpus, gameData)
      expect(r.totalPoints).toBe(3)
      expect(r.perRule["global:5"]).toEqual({ hits: 1, shadowed: 0 })
      expect(r.perRule["global:20"]).toEqual({ hits: 1, shadowed: 0 })
      // 调和兜底（恒真）：seq1 命中，seq0/seq2 被更早规则遮蔽
      expect(r.perRule["global:30"]).toEqual({ hits: 1, shadowed: 2 })
      expect(r.fallbackPoints).toHaveLength(0)
      expect(r.fallbackRate).toBe(0)
      expect(r.pointKeys).toEqual(["global:5", "global:30", "global:20"])
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it("diff 与断言：revise 收紧后原 blunder 点不再命中", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      // 两个 blunder 点都命中 global:5（岩骰够但 oracle 想切人）
      writeFixture(runDir, 0, [
        { seq: 0, state: state({ dice: [6, 6, 8] }), blunder: true, rule: "global:5" },
        { seq: 1, state: state({ dice: [6, 6, 6, 8] }), blunder: true, rule: "global:5" },
        { seq: 2, state: state({ dice: [3, 3, 1] }) },
      ])
      const corpus = await loadReplayCorpus(runDir, 0)
      const base = plan()
      const baseReplay = replayPlan(base, corpus, gameData)
      expect(baseReplay.perRule["global:5"].hits).toBe(2)

      // patch：global:5 收紧为 geo+omni>=4 → seq0（geo2+omni1=3）不再命中，seq1（4）仍命中
      const merged = applyPlanPatch(base, {
        ops: [{ op: "revise", ruleRef: "global:5", when: [{ field: "dice.geo+omni", op: ">=", value: 4 }], reason: "省骰" }],
      })
      expect(merged.ok).toBe(true)
      if (!merged.ok) return
      const nextReplay = replayPlan(merged.plan, corpus, gameData)
      const assertions = verifyPatchAssertions(merged.appliedOps, corpus, base, merged.plan, gameData)
      expect(assertions).toHaveLength(1)
      expect(assertions[0]).toMatchObject({ ruleRef: "global:5", targetPoints: 2, stillMatched: 1, status: "partial" })
      const text = formatPatchVerification({ opsCount: 1, assertions, base: baseReplay, next: nextReplay, lintFindings: lintPlan(merged.plan) })
      expect(text).toContain("fallback 率 0.0% → 0.0%")
      expect(text).toContain("global:5 2→1")
      expect(text).toContain("部分生效")
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it("remove 后 blunder 点转入 fallback 会在断言中标注", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      writeFixture(runDir, 0, [
        { seq: 0, state: state({ dice: [6, 6, 8] }), blunder: true, rule: "global:5" },
        { seq: 1, state: state({ dice: [3, 3, 1] }) },
      ])
      const corpus = await loadReplayCorpus(runDir, 0)
      const base = plan()
      // 先删调和兜底再删 global:5 → seq0 落 fallback
      const merged = applyPlanPatch(base, {
        ops: [
          { op: "remove", ruleRef: "global:5", reason: "全删" },
          { op: "remove", ruleRef: "global:30", reason: "全删" },
        ],
      })
      expect(merged.ok).toBe(true)
      if (!merged.ok) return
      const assertions = verifyPatchAssertions(merged.appliedOps, corpus, base, merged.plan, gameData)
      const a5 = assertions.find((a) => a.ruleRef === "global:5")!
      expect(a5.nowFallback).toBe(1)
      expect(a5.note).toContain("fallback")
      const nextReplay = replayPlan(merged.plan, corpus, gameData)
      // 两个点的对手 HP 均 >4，唯一剩余规则 global:20 不命中 → 全部落 fallback
      expect(nextReplay.fallbackRate).toBe(1)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe("lintPlan", () => {
  it("条件包含（遮蔽）与完全重复", () => {
    const p = plan()
    p.rules = [
      { priority: 1, when: [{ field: "dice.geo", op: ">=", value: 3 }], then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "宽" },
      { priority: 2, when: [{ field: "dice.geo", op: ">=", value: 3 }, { field: "opponent.active.hp", op: "<=", value: 4 }], then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "窄（被遮蔽）" },
      { priority: 3, when: [{ field: "dice.geo", op: ">=", value: 3 }], then: { action_case: "playCard", card_def_id: 312010 }, reason: "完全重复" },
    ]
    const findings = lintPlan(p)
    expect(findings.some((f) => f.path === "rules[1]" && f.message.includes("condition inclusion"))).toBe(true)
    expect(findings.some((f) => f.path === "rules[2]" && f.message.includes("identical"))).toBe(true)
  })

  it("同字段矛盾：== 互斥与空区间", () => {
    const p = plan()
    p.rules = [
      { priority: 1, when: [{ field: "self.active.element", op: "==", value: "geo" }, { field: "self.active.element", op: "==", value: "pyro" }], then: { action_case: "elementalTuning" }, reason: "互斥" },
      { priority: 2, when: [{ field: "self.active.hp", op: ">", value: 5 }, { field: "self.active.hp", op: "<", value: 5 }], then: { action_case: "elementalTuning" }, reason: "空区间" },
      { priority: 3, when: [{ field: "self.active.hp", op: ">=", value: 3 }, { field: "self.active.hp", op: "<=", value: 5 }], then: { action_case: "elementalTuning" }, reason: "合法区间不报" },
    ]
    const findings = lintPlan(p)
    expect(findings.some((f) => f.path === "rules[0].when" && f.message.includes("mutually exclusive"))).toBe(true)
    expect(findings.some((f) => f.path === "rules[1].when" && f.message.includes("empty range"))).toBe(true)
    expect(findings.some((f) => f.path === "rules[2].when")).toBe(false)
  })
})

describe("分层回放（G6，Phase 3a）", () => {
  /** general-only 层化链计划（unknown_deck；单条恒真规则） */
  function generalLayered(): GamePlanV1 {
    return {
      version: "GamePlanV1",
      planId: "ge0000000001",
      parentPlanId: null,
      createdAt: "2026-08-30T00:00:00Z",
      author: "test",
      context: { deckCode: "ABC", opponent: { kind: "unknown_deck" } },
      predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
      opening: { chooseActive: [], mulligan: [], reroll: [] },
      phases: [],
      rules: [{ priority: 10, then: { action_case: "elementalTuning" }, reason: "general 调和兜底" }],
      fallback: { policy: "conservative" },
    }
  }

  /** single 层计划（known_deck；高 priority 恒真规则——层主序下先于 general） */
  function singleLayered(): GamePlanV1 {
    return {
      version: "GamePlanV1",
      planId: "si0000000001",
      parentPlanId: null,
      createdAt: "2026-08-30T00:00:00Z",
      author: "test",
      context: { deckCode: "ABC", opponent: { kind: "known_deck", deckCode: DECK1 } },
      predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
      opening: { chooseActive: [], mulligan: [], reroll: [] },
      phases: [],
      rules: [{ priority: 500, then: { action_case: "elementalTuning" }, reason: "single 调和优先" }],
      fallback: { policy: "declare_end" },
    }
  }

  function portfolioTarget(): ResolvedPortfolio {
    const general = generalLayered()
    const single = singleLayered()
    return {
      manifest: {
        version: "PlanPortfolioV1",
        generalPlan: "general.json",
        singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }],
      },
      general,
      generalId: general.planId,
      singles: [{ label: "hongniu", opponentDeckCode: DECK1, planRef: "single.json", plan: single, planId: single.planId }],
      portfolioId: "pf1234567890ab",
    }
  }

  it("组合链：single 层整体前置（priority 500 先于 general 10）；键带层前缀；general-only 层化链键带 general: 前缀", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      writeFixture(runDir, 0, [{ seq: 0, state: state({}) }], "single:hongniu")
      const corpus = await loadReplayCorpus(runDir, 0)
      expect(corpus.routing).toBe("single:hongniu")
      const general = generalLayered()
      const single = singleLayered()
      // 组合链：single:500 恒真 → 首条命中（层主序，而非纯 priority）
      const combo = replayChainPlan({ general, single: { plan: single, label: "hongniu" } }, corpus, gameData)
      expect(combo.pointKeys).toEqual(["single:hongniu:global:500"])
      expect(combo.perRule["single:hongniu:global:500"]).toEqual({ hits: 1, shadowed: 0 })
      // general 规则被遮蔽
      expect(combo.perRule["general:global:10"]).toEqual({ hits: 0, shadowed: 1 })
      // general-only 层化链：键带 general: 前缀（任务 0 口径）
      const only = replayChainPlan({ general, layered: true }, corpus, gameData)
      expect(only.pointKeys).toEqual(["general:global:10"])
      expect(only.perRule["general:global:10"]).toEqual({ hits: 1, shadowed: 0 })
      // 旧单树（无层）键无前缀——零行为变化
      const legacy = replayPlan(general, corpus, gameData)
      expect(legacy.pointKeys).toEqual(["global:10"])
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it("replayPortfolio：分层 × 分组矩阵（行=组 label，列=层化规则键）", async () => {
    const dirA = makeRunDir()
    const dirB = makeRunDir()
    try {
      mkdirSync(dirA, { recursive: true })
      mkdirSync(dirB, { recursive: true })
      // 组 A 路由到 single（组合链），组 B general-only
      writeFixture(dirA, 0, [{ seq: 0, state: state({}) }], "single:hongniu")
      writeFixture(dirB, 0, [{ seq: 0, state: state({}) }], "general-only")
      const corpusA = await loadReplayCorpus(dirA, 0)
      const corpusB = await loadReplayCorpus(dirB, 0)
      const result = replayPortfolio(portfolioTarget(), [
        { label: "A", corpus: corpusA },
        { label: "B", corpus: corpusB },
      ], gameData)
      expect(result.groupOrder).toEqual(["A", "B"])
      expect(result.totalPoints).toBe(2)
      expect(result.perGroup.A.routing).toBe("single:hongniu")
      expect(result.perGroup.A.replay.pointKeys).toEqual(["single:hongniu:global:500"])
      expect(result.perGroup.B.routing).toBe("general-only")
      expect(result.perGroup.B.replay.pointKeys).toEqual(["general:global:10"])
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it("hasCardP 口径：组合链用 single 绑定 known_deck 解码（命中）；general-only 维持 general 声明（unknown_deck → undefined，不命中）", async () => {
    const runDir = makeRunDir()
    try {
      mkdirSync(runDir, { recursive: true })
      // 对手牌表中携带的第一张卡（真实分享码解码）；hasCardP 概率 > 0
      const deck = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig
      const targetCard = deck.cards[0]
      const withHasCardP = (over: GamePlanV1): GamePlanV1 => ({
        ...over,
        rules: [
          { priority: 1, when: [{ field: `opp.hand.hasCardP.${targetCard}`, op: ">=", value: 0.001 }], then: { action_case: "elementalTuning" }, reason: "对手握着关键卡" },
          { priority: 10, then: { action_case: "elementalTuning" }, reason: "兜底" },
        ],
      })
      const general = withHasCardP(generalLayered())
      const single = withHasCardP(singleLayered())
      writeFixture(runDir, 0, [{ seq: 0, state: state({}) }], "single:hongniu")
      const corpus = await loadReplayCorpus(runDir, 0)
      // 组合链：hasCardP 用 single 的 known_deck 解码 → 概率 > 0 → 命中 single 层规则
      const combo = replayChainPlan({ general, single: { plan: single, label: "hongniu" } }, corpus, gameData)
      expect(combo.pointKeys[0]).toBe("single:hongniu:global:1")
      // general-only：general 声明 unknown_deck → undefined → hasCardP 条件不成立 → 落兜底规则
      const only = replayChainPlan({ general, layered: true }, corpus, gameData)
      expect(only.pointKeys[0]).toBe("general:global:10")
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it("verifyPortfolioPatchAssertions：跨组聚合目标点（general 规则在两组共用）", async () => {
    const dirA = makeRunDir()
    const dirB = makeRunDir()
    try {
      mkdirSync(dirA, { recursive: true })
      mkdirSync(dirB, { recursive: true })
      // 两组都有 blunder 点命中 general:global:5（岩骰够但 oracle 想切人）
      writeFixture(dirA, 0, [
        { seq: 0, state: state({ dice: [6, 6, 8] }), blunder: true, rule: "general:global:5" },
        { seq: 1, state: state({ dice: [6, 6, 6, 8] }), blunder: true, rule: "general:global:5" },
      ], "single:hongniu")
      writeFixture(dirB, 0, [
        { seq: 0, state: state({ dice: [6, 6, 8] }), blunder: true, rule: "general:global:5" },
      ], "general-only")
      const corpusA = await loadReplayCorpus(dirA, 0)
      const corpusB = await loadReplayCorpus(dirB, 0)
      const general = generalLayered()
      // single 层规则在语料点上不命中（round>=99 恒假）→ 两组 base keys 都命中 general:global:5
      const single: GamePlanV1 = {
        ...singleLayered(),
        rules: [{ priority: 500, when: [{ field: "round", op: ">=", value: 99 }], then: { action_case: "elementalTuning" }, reason: "single 永不命中" }],
      }
      // general:global:5 层内收紧为 geo+omni>=4 → seq0（geo2+omni1=3）不再命中
      general.rules = [
        { priority: 5, when: [{ field: "dice.geo+omni", op: ">=", value: 3 }], then: { action_case: "elementalTuning" }, reason: "general 调" },
        { priority: 10, then: { action_case: "elementalTuning" }, reason: "兜底" },
      ]
      const base: ResolvedPortfolio = {
        ...portfolioTarget(),
        general,
        generalId: general.planId,
        singles: [{ label: "hongniu", opponentDeckCode: DECK1, planRef: "single.json", plan: single, planId: single.planId }],
      }
      const merged = applyPlanPatch(base, {
        ops: [{ op: "revise", ruleRef: "general:global:5", when: [{ field: "dice.geo+omni", op: ">=", value: 4 }], reason: "收紧" }],
      })
      expect(merged.ok).toBe(true)
      if (!merged.ok) return
      const assertions = verifyPortfolioPatchAssertions(merged.appliedOps, [
        { label: "A", corpus: corpusA },
        { label: "B", corpus: corpusB },
      ], base, merged.portfolio, gameData)
      expect(assertions).toHaveLength(1)
      // 3 个目标点（A 组 2 + B 组 1）：A 组 seq1（geo3+omni1=4）仍命中 → stillMatched 1
      expect(assertions[0]).toMatchObject({ ruleRef: "general:global:5", targetPoints: 3, stillMatched: 1, status: "partial" })
    } finally {
      rmSync(dirA, { recursive: true, force: true })
      rmSync(dirB, { recursive: true, force: true })
    }
  })
})
