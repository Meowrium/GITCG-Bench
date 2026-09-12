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
 * 模块注册表测试：共享模块（fewshot_plan / field_reference）离线可读；
 * reflect 专属模块用临时 fixture run 目录；未知 kind / 非法 id / 大小截断。
 * （card_detail / character_detail 依赖在线卡库数据，不在单测覆盖。）
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import getData from "@gi-tcg/data"
import { CURRENT_VERSION } from "@gi-tcg/core"
import { createModuleResolver, availableModuleKinds, MAX_MODULE_CHARS } from "./modules.js"
import type { ResolvedPortfolio } from "../portfolio.js"
import type { GamePlanV1 } from "../game-plan-v1.js"

/** 构造最小合法 PlanTraceFile 条目 */
function makeEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 0,
    round: 1,
    turn: 0,
    method: "action",
    stateLogIndex: null,
    stateSignature: JSON.stringify({
      roundNumber: 1,
      currentTurn: 0,
      player: [
        {
          activeCharacterId: 101,
          character: [{ id: 101, definitionId: 1306, health: 10, maxHealth: 10, energy: 1, maxEnergy: 3, aura: 0, defeated: false }],
          dice: [8, 1, 2],
          handCard: [{ definitionId: 311502 }],
          summon: [],
          support: [],
        },
        {
          activeCharacterId: 201,
          character: [{ id: 201, definitionId: 1103, health: 7, maxHealth: 10, energy: 2, maxEnergy: 2, aura: 0, defeated: false }],
          dice: [],
          handCard: [],
          summon: [],
          support: [],
        },
      ],
    }),
    phaseId: null,
    candidateCount: 3,
    matchedRule: { scope: "global", priority: 10, reason: "测试规则" },
    fallbackUsed: false,
    chosen: { actionCase: "useSkill", skillDefId: 13061 },
    notes: [],
    thenMiss: [],
    ...over,
  }
}

function makeTrace(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  const ruleMatched = entries.filter((e) => (e as { matchedRule: unknown }).matchedRule).length
  const fallback = entries.filter((e) => (e as { fallbackUsed: boolean }).fallbackUsed).length
  return {
    version: "PlanTraceV1",
    planId: "testplan0001",
    parentPlanId: null,
    seed: 42,
    deckCodes: ["A", "B"],
    side: 0,
    opponentPolicy: "baseline",
    entries,
    summary: {
      result: "win",
      rounds: 5,
      decisionCounts: { total: entries.length, ruleMatched, fallback },
      coverage: entries.length === 0 ? 0 : ruleMatched / entries.length,
      perRuleHits: { "global:10": ruleMatched },
      perRuleThenMiss: { "global:99": 1 },
    },
  }
}

describe("modules 注册表", () => {
  let runDir: string

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), "plan-modules-"))
    const gameDir = join(runDir, "game-000")
    await mkdir(gameDir, { recursive: true })
    const entries = [
      makeEntry({ seq: 0 }),
      makeEntry({
        seq: 1,
        matchedRule: null,
        fallbackUsed: true,
        fallbackPolicy: "conservative",
        chosen: { actionCase: "declareEnd" },
      }),
      makeEntry({ seq: 2, matchedRule: null, chosen: { actionCase: "elementalTuning" }, thenMiss: ["global:99"] }),
    ]
    await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(makeTrace(entries)), "utf-8")
    await writeFile(join(gameDir, "plan_eval.json"), JSON.stringify({
      points: [
        { seq: 0, round: 1, visitGap: 0.3, isBlunder: true, oracleBest: JSON.stringify({ actionCase: "useSkill", skillDefId: 13062 }), chosen: { actionCase: "useSkill", skillDefId: 13061 }, matchedRule: "global:10" },
        { seq: 1, round: 1, visitGap: 0.01, isBlunder: false, oracleBest: JSON.stringify({ actionCase: "declareEnd" }), chosen: { actionCase: "declareEnd" }, matchedRule: null },
      ],
    }), "utf-8")
  })

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true })
  })

  it("模块清单：author 仅共享模块，reflect 含 run 目录钻取模块", () => {
    const author = availableModuleKinds("author")
    const reflect = availableModuleKinds("reflect")
    expect(author).toContain("fewshot_plan")
    expect(author).not.toContain("rule_drilldown")
    for (const k of ["decision_detail", "rule_drilldown", "fallback_detail", "fallback_report", "game_summary"]) {
      expect(reflect).toContain(k)
    }
  })

  it("fewshot_plan / field_reference 离线可读且带形态提示", async () => {
    const resolve = createModuleResolver("author")
    const [fewshot, field] = await resolve([{ kind: "fewshot_plan" }, { kind: "field_reference" }])
    expect(fewshot.content).toContain("GamePlanV1")
    expect(fewshot.content).toContain("严禁照抄")
    expect(field.content).toContain("dice.total")
  })

  it("未知 kind 返回错误文案块且不抛异常", async () => {
    const resolve = createModuleResolver("author")
    const [m] = await resolve([{ kind: "nonsense" }])
    expect(m.content).toContain("未知模块 kind")
    // author 模式请求 reflect 专属模块 = 未知
    const [m2] = await resolve([{ kind: "rule_drilldown", id: "global:10" }])
    expect(m2.content).toContain("未知模块 kind")
  })

  it("非法 id：card_detail 的非数字 id 返回未找到", async () => {
    const resolve = createModuleResolver("author")
    const [m] = await resolve([{ kind: "card_detail", id: "abc" }])
    expect(m.content).toContain("id 必须是数字 defId")
  })

  it("decision_detail：返回 trace 条目原文 + oracle 回算原文 + 相邻点", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0 })
    const [m] = await resolve([{ kind: "decision_detail", id: "game-000:0" }])
    expect(m.content).toContain("trace 条目原文")
    expect(m.content).toContain("oracle 回算原文")
    expect(m.content).toContain("13062") // oracle 推荐技能
    expect(m.content).toContain("相邻决策点")
    // 格式错误与不存在
    const [bad] = await resolve([{ kind: "decision_detail", id: "xyz" }])
    expect(bad.content).toContain("id 格式应为")
    const [missing] = await resolve([{ kind: "decision_detail", id: "game-000:77" }])
    expect(missing.content).toContain("无此 seq")
  })

  it("rule_drilldown：命中与 thenMiss 分列", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0 })
    const [hit] = await resolve([{ kind: "rule_drilldown", id: "global:10" }])
    expect(hit.content).toContain("命中 1 次")
    expect(hit.content).toContain("✗")
    const [miss] = await resolve([{ kind: "rule_drilldown", id: "global:99" }])
    expect(miss.content).toContain("thenMiss")
    const [none] = await resolve([{ kind: "rule_drilldown", id: "global:12345" }])
    expect(none.content).toContain("既未命中也未出现在 thenMiss")
  })

  it("fallback_detail：列出全部兜底决策点", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0 })
    const [m] = await resolve([{ kind: "fallback_detail" }])
    expect(m.content).toContain("共 1 个")
    expect(m.content).toContain("conservative")
  })

  it("fallback_report：按出战角色×回合聚类，含威胁分布与代表行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plan-modules-fbr-"))
    try {
      const gameDir = join(dir, "game-000")
      await mkdir(gameDir, { recursive: true })
      const sig2 = JSON.stringify({
        roundNumber: 2,
        currentTurn: 0,
        player: [
          { activeCharacterId: 102, character: [{ id: 102, definitionId: 1407, health: 6, maxHealth: 10, energy: 2, maxEnergy: 2, aura: 0, defeated: false }], dice: [2, 2, 8, 8], handCard: [{ definitionId: 1 }, { definitionId: 2 }, { definitionId: 3 }, { definitionId: 4 }], summon: [], support: [] },
          { activeCharacterId: 201, character: [{ id: 201, definitionId: 1103, health: 7, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, defeated: false }], dice: [], handCard: [], summon: [], support: [] },
        ],
      })
      const entries = [
        makeEntry({ seq: 0 }),
        makeEntry({ seq: 1, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" } }),
        makeEntry({ seq: 2, matchedRule: null, fallbackUsed: true, fallbackPolicy: "aggressive", chosen: { actionCase: "useSkill", skillDefId: 13061 }, threat: { maxDamage: 10, lethal: true } }),
        makeEntry({ seq: 3, round: 2, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" }, stateSignature: sig2 }),
      ]
      await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(makeTrace(entries)), "utf-8")
      const resolve = createModuleResolver("reflect", { runDir: dir, side: 0 })
      const [m] = await resolve([{ kind: "fallback_report" }])
      expect(m.content).toContain("全部 action 决策点 4 个")
      expect(m.content).toContain("3 个（75.0%）")
      expect(m.content).toContain("聚为 2 类")
      expect(m.content).toContain("[2 次 / 66.7%] 出战")
      expect(m.content).toContain("(1306) × round1")
      expect(m.content).toContain("斩杀!×1")
      expect(m.content).toContain("(1407) × round2")
      expect(m.content).toContain("判定提示")
      expect(m.content).toContain("代表：[game-000 seq1]")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("game_summary：结果/覆盖 + 逐决策点", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0 })
    const [m] = await resolve([{ kind: "game_summary", id: "game-000" }])
    expect(m.content).toContain("结果 win")
    expect(m.content).toContain("coverage=33.3%")
    const [missing] = await resolve([{ kind: "game_summary", id: "game-999" }])
    expect(missing.content).toContain("无 trace 文件")
  })

  it("模块内容硬上限截断", async () => {
    // 造一个超长 fallback 列表
    const bigDir = await mkdtemp(join(tmpdir(), "plan-modules-big-"))
    try {
      const gameDir = join(bigDir, "game-000")
      await mkdir(gameDir, { recursive: true })
      const many = Array.from({ length: 60 }, (_, i) => makeEntry({
        seq: i,
        matchedRule: null,
        fallbackUsed: true,
        fallbackPolicy: "conservative",
        chosen: { actionCase: "declareEnd" },
      }))
      await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(makeTrace(many)), "utf-8")
      const resolve = createModuleResolver("reflect", { runDir: bigDir, side: 0 })
      const [m] = await resolve([{ kind: "fallback_detail" }])
      expect(m.content.length).toBeLessThanOrEqual(MAX_MODULE_CHARS + 60)
      expect(m.content).toContain("截断")
    } finally {
      await rm(bigDir, { recursive: true, force: true })
    }
  })
})

describe("engine-only 模块门控（eval 文件存在也只保留 trace 部分）", () => {
  let runDir: string

  beforeAll(async () => {
    // 复用主 fixture 的形态：trace + plan_eval.json 同时在场
    runDir = await mkdtemp(join(tmpdir(), "plan-modules-eo-"))
    const gameDir = join(runDir, "game-000")
    await mkdir(gameDir, { recursive: true })
    const entries = [
      makeEntry({ seq: 0 }),
      makeEntry({ seq: 1, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" } }),
      makeEntry({ seq: 2, matchedRule: null, chosen: { actionCase: "elementalTuning" }, thenMiss: ["global:99"] }),
    ]
    await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(makeTrace(entries)), "utf-8")
    await writeFile(join(gameDir, "plan_eval.json"), JSON.stringify({
      points: [
        { seq: 0, round: 1, visitGap: 0.3, isBlunder: true, oracleBest: JSON.stringify({ actionCase: "useSkill", skillDefId: 13062 }), chosen: { actionCase: "useSkill", skillDefId: 13061 }, matchedRule: "global:10" },
        { seq: 1, round: 1, visitGap: 0.01, isBlunder: false, oracleBest: JSON.stringify({ actionCase: "declareEnd" }), chosen: { actionCase: "declareEnd" }, matchedRule: null },
      ],
    }), "utf-8")
  })

  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true })
  })

  it("decision_detail：trace 原文在，oracle 回算原文消失", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0, evidence: "engine-only" })
    const [m] = await resolve([{ kind: "decision_detail", id: "game-000:0" }])
    expect(m.content).toContain("trace 条目原文")
    expect(m.content).not.toContain("oracle")
    expect(m.content).not.toContain("13062")
    // oracle 口径对照：同一目录读得出（证明是门控而非数据缺失）
    const resolveOracle = createModuleResolver("reflect", { runDir, side: 0 })
    const [m2] = await resolveOracle([{ kind: "decision_detail", id: "game-000:0" }])
    expect(m2.content).toContain("oracle 回算原文")
  })

  it("rule_drilldown / fallback_detail / game_summary：无 oracle 对照列", async () => {
    const resolve = createModuleResolver("reflect", { runDir, side: 0, evidence: "engine-only" })
    const [hit] = await resolve([{ kind: "rule_drilldown", id: "global:10" }])
    expect(hit.content).toContain("命中 1 次")
    expect(hit.content).not.toMatch(/oracle|✗|✓/)
    const [fb] = await resolve([{ kind: "fallback_detail" }])
    expect(fb.content).toContain("共 1 个")
    expect(fb.content).not.toMatch(/oracle|✗|✓/)
    const [gs] = await resolve([{ kind: "game_summary", id: "game-000" }])
    expect(gs.content).toContain("结果 win")
    expect(gs.content).not.toMatch(/oracle|✗|✓/)
    const [miss] = await resolve([{ kind: "rule_drilldown", id: "global:99" }])
    expect(miss.content).toContain("thenMiss")
  })
})

describe("多对手证据包（runDirs 分组聚合与组名寻址）", () => {
  let dirA: string
  let dirB: string

  beforeAll(async () => {
    for (const [dir, seq1Chosen] of [[ "a", "declareEnd" ], [ "b", "elementalTuning" ]] as const) {
      const root = await mkdtemp(join(tmpdir(), `plan-modules-multi-${dir}-`))
      const gameDir = join(root, "game-000")
      await mkdir(gameDir, { recursive: true })
      const entries = [
        makeEntry({ seq: 0 }),
        makeEntry({ seq: 1, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: seq1Chosen } }),
      ]
      await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(makeTrace(entries)), "utf-8")
      if (dir === "a") dirA = root
      else dirB = root
    }
  })

  afterAll(async () => {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  })

  const ctx = () => ({ side: 0 as const, runDirs: [{ label: "hongniu", dir: dirA }, { label: "shuining", dir: dirB }] })

  it("rule_drilldown / fallback_detail 跨组聚合且分组标头", async () => {
    const resolve = createModuleResolver("reflect", ctx())
    const [hit] = await resolve([{ kind: "rule_drilldown", id: "global:10" }])
    expect(hit.content).toContain("对手组 hongniu")
    expect(hit.content).toContain("对手组 shuining")
    expect(hit.content).toContain("命中 2 次")
    const [fb] = await resolve([{ kind: "fallback_detail" }])
    expect(fb.content).toContain("共 2 个")
    expect(fb.content).toContain("hongniu/game-000")
    expect(fb.content).toContain("shuining/game-000")
  })

  it("decision_detail / game_summary 需要组名前缀；裸 id 返回提示", async () => {
    const resolve = createModuleResolver("reflect", ctx())
    const [bare] = await resolve([{ kind: "decision_detail", id: "game-000:0" }])
    expect(bare.content).toContain("组名前缀")
    expect(bare.content).toContain("hongniu")
    const [qualified] = await resolve([{ kind: "decision_detail", id: "shuining/game-000:1" }])
    expect(qualified.content).toContain("决策点 shuining/game-000:1")
    expect(qualified.content).toContain("elementalTuning")
    const [badLabel] = await resolve([{ kind: "game_summary", id: "nobody/game-000" }])
    expect(badLabel.content).toContain("未知组名")
    const [gs] = await resolve([{ kind: "game_summary", id: "hongniu/game-000" }])
    expect(gs.content).toContain("结果 win")
  })
})

describe("portfolio 上下文 plan_simulate（Phase 3a 分层矩阵）", () => {
  let dirSingle: string
  let dirGeneral: string

  beforeAll(async () => {
    for (const [tag, routing] of [["single", "single:hongniu"], ["general", "general-only"]] as const) {
      const root = await mkdtemp(join(tmpdir(), `plan-modules-pf-${tag}-`))
      const gameDir = join(root, "game-000")
      await mkdir(gameDir, { recursive: true })
      const entries = [
        makeEntry({ seq: 0, matchedRule: { scope: "global", priority: 10, reason: "通用规则" } }),
        makeEntry({ seq: 1, matchedRule: null, fallbackUsed: true, fallbackPolicy: "conservative", chosen: { actionCase: "declareEnd" } }),
      ]
      const trace = { ...makeTrace(entries), routing, portfolioId: "pf000000000000" }
      await writeFile(join(gameDir, "plan_trace.json"), JSON.stringify(trace), "utf-8")
      if (tag === "single") dirSingle = root
      else dirGeneral = root
    }
  })

  afterAll(async () => {
    await rm(dirSingle, { recursive: true, force: true })
    await rm(dirGeneral, { recursive: true, force: true })
  })

  it("带 portfolio 上下文：按组路由输出分层矩阵（组标头 + routing + 汇总）", async () => {
    const mkPlan = (opponent: GamePlanV1["context"]["opponent"]): GamePlanV1 => ({
      version: "GamePlanV1",
      planId: "aaaaaaaaaaaa",
      parentPlanId: null,
      createdAt: "2026-08-30T00:00:00Z",
      author: "test",
      context: { deckCode: "ABC", opponent },
      predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
      opening: { chooseActive: [], mulligan: [], reroll: [] },
      phases: [],
      rules: [{ priority: 10, then: { action_case: "elementalTuning" }, reason: "通用兜底" }],
      fallback: { policy: "conservative" },
    })
    const general = mkPlan({ kind: "unknown_deck" })
    const single = mkPlan({ kind: "known_deck", deckCode: "DEF" })
    const portfolio: ResolvedPortfolio = {
      manifest: {
        version: "PlanPortfolioV1",
        generalPlan: "general.json",
        singles: [{ opponentDeckCode: "DEF", label: "hongniu", planRef: "single.json" }],
      },
      general,
      generalId: general.planId,
      singles: [{ label: "hongniu", opponentDeckCode: "DEF", planRef: "single.json", plan: single, planId: single.planId }],
      portfolioId: "pf000000000000",
    }
    const resolve = createModuleResolver("reflect", {
      side: 0,
      gameData: getData(CURRENT_VERSION),
      portfolio,
      runDirs: [
        { label: "hongniu", dir: dirSingle, singleLabel: "hongniu" },
        { label: "shuining", dir: dirGeneral },
      ],
    })
    const [m] = await resolve([{ kind: "plan_simulate" }])
    expect(m.content).toContain("对手组 hongniu")
    expect(m.content).toContain("routing=single:hongniu")
    expect(m.content).toContain("对手组 shuining")
    expect(m.content).toContain("routing=general-only")
    expect(m.content).toContain("汇总")
    // 组合链组：single 层键出现（single 层规则优先级高于 general 时仍前置）
    expect(m.content).toContain("single:hongniu:global:10")
    // general-only 组：general 层键
    expect(m.content).toContain("general:global:10")
  })
})
