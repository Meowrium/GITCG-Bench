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
 * M1 验收：GamePlanV1 校验 + PlanPlayerIO 确定性对局 + trace 产出。
 */

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CURRENT_VERSION, deserializeGameStateLog, exposeState, type DeckConfig } from "@gi-tcg/core"
import getData from "@gi-tcg/data"
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager"
import { ActionValidity, PbDiceType, createRpcRequest } from "@gi-tcg/typings"
import { SandboxRunner } from "../../sandbox/runner.js"
import { PolicyPlayerIO } from "../io/policy-player-io.js"
import { BaselinePolicy } from "../policy/baseline-policy.js"
import { PlanPlayerIO } from "./plan-player-io.js"
import { evaluateWhenCondition, planStateSignature, cardCountMapOf } from "./fields.js"
import { computePlanId, validateGamePlan } from "./validate.js"
import { runPlanBatch } from "./batch-runner.js"
import { computePortfolioId, type ResolvedPortfolio } from "./portfolio.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

const DECK0 = "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 = "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

const data = getData(CURRENT_VERSION)
const deck0 = DEFAULT_ASSETS_MANAGER.decode(DECK0) as DeckConfig
const deck1 = DEFAULT_ASSETS_MANAGER.decode(DECK1) as DeckConfig

function makePlan(overrides: Partial<GamePlanV1> = {}): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "testplan001",
    parentPlanId: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    author: "manual",
    context: { deckCode: DECK0, opponent: { kind: "mirror" } },
    predictions: {
      winRateEstimate: 0.5,
      expectedRounds: 6,
      confidence: 0.5,
      keyThreats: ["测试威胁"],
    },
    opening: {
      chooseActive: [{ characterDefId: deck0.characters[0], reason: "首发一号位" }],
      mulligan: [],
      reroll: [{ keepElements: ["pyro", "omni"], reason: "保留火骰与万能" }],
    },
    phases: [],
    rules: [
      {
        priority: 1,
        when: [],
        then: { action_case: "useSkill", kills: true },
        reason: "能斩必斩",
      },
      {
        priority: 10,
        when: [{ field: "opponent.active.aura", op: "==", value: "none" }],
        then: { action_case: "useSkill", skill_type: "elemental_skill" },
        reason: "无附着优先挂元素",
      },
      {
        priority: 90,
        when: [{ field: "dice.total", op: "<=", value: 2 }],
        then: { action_case: "declareEnd" },
        reason: "骰尽结束回合",
      },
    ],
    fallback: { policy: "conservative" },
    ...overrides,
  }
}

describe("GamePlanV1 validator", () => {
  it("accepts a hand-written valid plan", () => {
    const result = validateGamePlan(makePlan(), { deck: deck0 })
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("rejects unknown when-field", () => {
    const plan = makePlan()
    plan.rules[1].when = [{ field: "self.active.mana", op: ">=", value: 1 }]
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.path.includes("when") && i.message.includes("unknown field"))).toBe(true)
  })

  it("rejects card_def_id not in deck", () => {
    const plan = makePlan()
    plan.rules.push({
      priority: 20,
      then: { action_case: "playCard", card_def_id: 999999 },
      reason: "不存在的手牌",
    })
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes("not in deck"))).toBe(true)
  })

  it("rejects duplicate priority within a chain", () => {
    const plan = makePlan()
    plan.rules.push({
      priority: 10,
      then: { action_case: "declareEnd" },
      reason: "重复优先级",
    })
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes("duplicate priority"))).toBe(true)
  })

  it("rejects missing predictions", () => {
    const plan = makePlan()
    ;(plan.predictions as unknown) = undefined
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
  })

  it("computePlanId is content-addressed and stable", () => {
    const a = computePlanId(makePlan())
    const b = computePlanId(makePlan())
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
    const c = computePlanId(makePlan({ author: "someone-else" }))
    expect(c).not.toBe(a)
  })

  it("rejects phaseId containing ':' (breaks ruleRef parsing)", () => {
    const plan = makePlan()
    plan.phases = [{
      phaseId: "late:game",
      when: [{ field: "round", op: ">=", value: 3 }],
      rules: [],
    }]
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.path.includes("phaseId") && i.message.includes(":"))).toBe(true)
  })

  it("rejects numeric then.target not in a deck (dead rule)", () => {
    const plan = makePlan()
    plan.rules.push({
      priority: 30,
      then: { action_case: "switchActive", target: 999999 },
      reason: "切换到不存在的角色",
    })
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.path.includes("target") && i.message.includes("not in"))).toBe(true)
  })

  it("accepts numeric then.target referencing a deck character defId", () => {
    const plan = makePlan()
    plan.rules.push({
      priority: 30,
      then: { action_case: "switchActive", target: deck0.characters[1] },
      reason: "切换到二号位",
    })
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(true)
  })

  it("boolean fields coerce numeric literals (alive == 1 is true, not dead)", () => {
    const plan = makePlan()
    plan.rules.push({
      priority: 40,
      when: [{ field: "self.active.alive", op: "==", value: 1 }],
      then: { action_case: "declareEnd" },
      reason: "出战角色存活时结束（恒真条件）",
    })
    const result = validateGamePlan(plan, { deck: deck0 })
    expect(result.ok).toBe(true)
    // 纯函数层面：最小 state 上验证布尔 actual 与数字 expected 的同化
    const fakeState = {
      roundNumber: 2,
      currentTurn: 0,
      player: [
        {
          activeCharacterId: 11,
          character: [{ id: 11, definitionId: deck0.characters[0], defeated: false, health: 10 }],
          dice: [], handCard: [], summon: [], support: [],
        },
        {
          activeCharacterId: 21,
          character: [{ id: 21, definitionId: deck1.characters[0], defeated: false, health: 10 }],
          dice: [], handCard: [], summon: [], support: [],
        },
      ],
    } as never
    const ctx = { state: fakeState, side: 0 as const, phaseId: null, actionsTakenThisTurn: 1, gameData: data }
    expect(evaluateWhenCondition({ field: "self.active.alive", op: "==", value: 1 }, ctx)).toBe(true)
    expect(evaluateWhenCondition({ field: "self.active.alive", op: "==", value: 0 }, ctx)).toBe(false)
    expect(evaluateWhenCondition({ field: "self.active.alive", op: "==", value: true }, ctx)).toBe(true)
  })

  it("opp.hand.hasCardP 语义校验：劝告性警告，不拒", () => {
    const withHasCardP = (defId: number): GamePlanV1 => {
      const plan = makePlan()
      plan.rules.push({
        priority: 50,
        when: [{ field: `opp.hand.hasCardP.${defId}`, op: ">=", value: 0.5 }],
        then: { action_case: "declareEnd" },
        reason: "对手可能握着关键牌时收手",
      })
      return plan
    }
    const inDeck = deck0.cards[0]

    // mirror 上下文 + 提供对手牌表：卡在表内 → 无警告
    const ok = validateGamePlan(withHasCardP(inDeck), { deck: deck0, opponentDeck: deck0 })
    expect(ok.ok).toBe(true)
    expect(ok.warnings).toEqual([])

    // 卡不在对手牌表 → ok 仍为 true，但给"恒假死规则"警告
    const notIn = validateGamePlan(withHasCardP(999999), { deck: deck0, opponentDeck: deck0 })
    expect(notIn.ok).toBe(true)
    expect(notIn.warnings.some((w) => w.message.includes("not in opponent deck"))).toBe(true)

    // 对手牌表未知（未提供 opponentDeck）→ 给"无法校验"警告
    const unknown = validateGamePlan(withHasCardP(inDeck), { deck: deck0 })
    expect(unknown.ok).toBe(true)
    expect(unknown.warnings.some((w) => w.message.includes("opponent deck is unknown"))).toBe(true)
  })

  it("planStateSignature is key-order independent (stable stringify)", () => {
    const a = { roundNumber: 1, b: 2, player: [{ status: 4, id: 7 }] }
    const b = { b: 2, roundNumber: 1, player: [{ id: 7, status: 4 }] }
    expect(planStateSignature(a as never)).toBe(planStateSignature(b as never))
  })
})

describe("PlanPlayerIO smoke (plan vs baseline)", () => {
  async function runGame(seed: number, plan: GamePlanV1) {
    const runner = new SandboxRunner()
    const planIo = new PlanPlayerIO({
      side: 0,
      plan,
      gameData: data,
      trace: { planId: plan.planId, parentPlanId: plan.parentPlanId, side: 0, opponentPolicy: "baseline" },
    })
    const baselineIo = new PolicyPlayerIO({
      side: 1,
      policy: new BaselinePolicy(),
      searchOptions: { enabled: false },
    })
    const result = await runner.runOne(
      [deck0, deck1],
      data,
      [planIo, baselineIo],
      { captureReplay: true, seed },
    )
    return { result, trace: planIo.getTraceFile() }
  }

  it("completes a game with trace + state log, deterministically", async () => {
    const plan = makePlan()
    const g1 = await runGame(4201, plan)
    const g2 = await runGame(4201, plan)

    // 对局完成且结果确定
    expect(g1.result.winner === 0 || g1.result.winner === 1).toBe(true)
    expect(g1.result.rounds).toBeGreaterThan(0)
    expect(g1.result.winner).toBe(g2.result.winner)
    expect(g1.result.rounds).toBe(g2.result.rounds)

    // 动作序列逐点一致
    const seq1 = g1.trace.entries.map((e) => [e.method, e.matchedRule?.priority ?? null, e.chosen])
    const seq2 = g2.trace.entries.map((e) => [e.method, e.matchedRule?.priority ?? null, e.chosen])
    expect(JSON.stringify(seq1)).toBe(JSON.stringify(seq2))

    // trace 覆盖：有 action 决策点，summary 自洽
    const actions = g1.trace.entries.filter((e) => e.method === "action")
    expect(actions.length).toBeGreaterThan(0)
    expect(g1.trace.summary.decisionCounts.total).toBe(g1.trace.entries.length)
    expect(["win", "loss", "draw"]).toContain(g1.trace.summary.result)

    // 规则确实命中过（斩杀/挂元素/结束规则至少其一）
    expect(g1.trace.summary.decisionCounts.ruleMatched).toBeGreaterThan(0)

    // state log 与 trace 并存且可互链（同 round/turn 量级）
    expect(g1.result.replayLogJson).toBeDefined()
    const stateCount = (g1.result.replayLogJson as { store?: unknown[] }).store?.length ?? 0
    expect(stateCount).toBeGreaterThan(0)
    const maxRound = Math.max(...g1.trace.entries.map((e) => e.round))
    expect(maxRound).toBeLessThanOrEqual(g1.result.rounds)

    // 签名对齐不变量：trace 的 action 决策点应能在 state log 中按
    // exposeState(0, state) 签名精确找回（允许少量引擎 pause/notify 边界差异）
    const stateLog = deserializeGameStateLog(data, g1.result.replayLogJson!)
    const logSigs = new Set(
      stateLog
        .filter((e) => e.canResume && e.state.phase === "action")
        .map((e) => planStateSignature(exposeState(0, e.state))),
    )
    const unmatched = actions.filter((a) => a.stateSignature && !logSigs.has(a.stateSignature))
    expect(unmatched.length / actions.length).toBeLessThan(0.1)
  }, 60000)

  it("empty-rules plan exercises fallback on every action", async () => {
    const plan = makePlan({
      rules: [],
      opening: { chooseActive: [], mulligan: [], reroll: [] },
    })
    const { trace } = await runGame(4202, plan)
    const actions = trace.entries.filter((e) => e.method === "action")
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((e) => e.fallbackUsed)).toBe(true)
    expect(actions.every((e) => e.fallbackPolicy === "conservative")).toBe(true)
    expect(trace.summary.coverage).toBe(0)
  }, 60000)

  it("action 决策点 trace 携带 opp.threat 读数（确定性、仅 action 条目）", async () => {
    const g1 = await runGame(4203, makePlan())
    const g2 = await runGame(4203, makePlan())

    const actions = g1.trace.entries.filter((e) => e.method === "action")
    expect(actions.length).toBeGreaterThan(0)
    // 仓库内 data 源码可读：威胁读数应实际产生（dist 环境下允许整体省略）
    const withThreat = actions.filter((e) => e.threat !== undefined)
    expect(withThreat.length).toBeGreaterThan(0)
    for (const e of withThreat) {
      const t = e.threat!
      if (t.maxDamage !== undefined) expect(typeof t.maxDamage).toBe("number")
      if (t.lethal !== undefined) expect(typeof t.lethal).toBe("boolean")
      if (t.lethalP !== undefined) {
        expect(t.lethalP).toBeGreaterThanOrEqual(0)
        expect(t.lethalP).toBeLessThanOrEqual(1)
      }
      if (t.burstReady !== undefined) expect(typeof t.burstReady).toBe("boolean")
      if (t.burstP !== undefined) {
        expect(t.burstP).toBeGreaterThanOrEqual(0)
        expect(t.burstP).toBeLessThanOrEqual(1)
      }
    }
    // 非 action 条目不携带 threat
    expect(
      g1.trace.entries.filter((e) => e.method !== "action").every((e) => e.threat === undefined),
    ).toBe(true)
    // 同 seed 重跑：threat 读数逐点一致
    const threatSeq = (entries: typeof g1.trace.entries) =>
      JSON.stringify(entries.map((e) => e.threat ?? null))
    expect(threatSeq(g2.trace.entries)).toBe(threatSeq(g1.trace.entries))
  }, 60000)

  it("opp.hand.hasCardP：注入对手牌表后规则命中，未注入时静默不命中", async () => {
    const targetCard = deck1.cards[0]
    const plan = makePlan({
      rules: [
        {
          priority: 1,
          when: [{ field: `opp.hand.hasCardP.${targetCard}`, op: ">=", value: 0 }],
          then: { action_case: "declareEnd" },
          reason: "接线验证：hasCardP 可解析即命中（declareEnd 让对局快速收敛）",
        },
        ...makePlan().rules.map((r) => ({ ...r, priority: r.priority + 10 })),
      ],
    })
    const runWired = async (wired: boolean) => {
      const runner = new SandboxRunner()
      const planIo = new PlanPlayerIO({
        side: 0,
        plan,
        gameData: data,
        opponentDeckCards: wired ? cardCountMapOf(deck1.cards) : undefined,
        trace: { planId: plan.planId, parentPlanId: plan.parentPlanId, side: 0, opponentPolicy: "baseline" },
      })
      const baselineIo = new PolicyPlayerIO({
        side: 1,
        policy: new BaselinePolicy(),
        searchOptions: { enabled: false },
      })
      await runner.runOne([deck0, deck1], data, [planIo, baselineIo], { captureReplay: true, seed: 4204 })
      return planIo.getTraceFile()
    }
    const wired = await runWired(true)
    expect(wired.entries.filter((e) => e.matchedRule?.priority === 1).length).toBeGreaterThan(0)
    const unwired = await runWired(false)
    expect(unwired.entries.every((e) => e.matchedRule?.priority !== 1)).toBe(true)
  }, 60000)
})

// ── 两层组合模式（General+Single portfolio；D1=A 层主序，D2 生效计划）────────
// 合成 notify + rpc（不走真实引擎），精确断言层序、层键与归属。

const generalComboPlan = (overrides: Partial<GamePlanV1> = {}): GamePlanV1 => makePlan({
  planId: "ge0000000001",
  context: { deckCode: DECK0, opponent: { kind: "unknown_deck" } },
  opening: { chooseActive: [], mulligan: [], reroll: [] },
  phases: [],
  rules: [{ priority: 10, then: { action_case: "declareEnd" }, reason: "general 收" }],
  fallback: { policy: "conservative" },
  ...overrides,
})

const singleComboPlan = (overrides: Partial<GamePlanV1> = {}): GamePlanV1 => makePlan({
  planId: "si0000000001",
  context: { deckCode: DECK0, opponent: { kind: "known_deck", deckCode: DECK1 } },
  opening: { chooseActive: [], mulligan: [], reroll: [] },
  phases: [],
  rules: [{ priority: 500, then: { action_case: "elementalTuning" }, reason: "single 调和优先" }],
  fallback: { policy: "declare_end" },
  ...overrides,
})

const fakeActionState = () => ({
  roundNumber: 1,
  currentTurn: 0,
  player: [
    {
      activeCharacterId: 11,
      character: [
        { id: 11, definitionId: deck0.characters[0], defeated: false, health: 10, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, entity: [] },
        { id: 12, definitionId: deck0.characters[1], defeated: false, health: 10, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, entity: [] },
        { id: 13, definitionId: deck0.characters[2], defeated: false, health: 10, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, entity: [] },
      ],
      dice: [8, 8, 3, 3, 3, 3, 3, 3],
      handCard: [], summon: [], support: [], pileCard: [], declaredEnd: false,
    },
    {
      activeCharacterId: 21,
      character: [
        { id: 21, definitionId: deck1.characters[0], defeated: false, health: 8, maxHealth: 10, energy: 0, maxEnergy: 2, aura: 0, entity: [] },
      ],
      dice: [], handCard: [], summon: [], support: [], pileCard: [], declaredEnd: false,
    },
  ],
})

type SyntheticCase = "useSkill" | "elementalTuning" | "declareEnd"
const candidateOf = (c: SyntheticCase) => ({
  action: c === "useSkill"
    ? { $case: "useSkill" as const, value: { skillDefinitionId: 11031, targetIds: [] as number[] } }
    : c === "elementalTuning"
      ? { $case: "elementalTuning" as const, value: { removedCardId: 101, targetDice: PbDiceType.OMNI } }
      : { $case: "declareEnd" as const, value: {} },
  preview: [],
  requiredCost: [],
  autoSelectedDice: [],
  validity: ActionValidity.VALID,
  isFast: false,
})

const comboIo = (general: GamePlanV1, single: GamePlanV1 | null, label = "hongniu") =>
  new PlanPlayerIO({
    side: 0,
    plan: general,
    ...(single ? { single: { plan: single, label } } : {}),
    gameData: data,
    trace: {
      planId: general.planId,
      parentPlanId: null,
      side: 0,
      opponentPolicy: "baseline",
      ...(single ? { routing: `single:${label}` as const, portfolioId: "pf0000000000" } : {}),
    },
  })

/** notify 合成 state 后发一次 action rpc，返回 chosenActionIndex */
const actOnce = async (io: PlanPlayerIO, cases: SyntheticCase[]): Promise<number> => {
  io.notify({ state: fakeActionState() } as never)
  const resp = await io.rpc(createRpcRequest("action", { action: cases.map(candidateOf) }))
  if (resp.response?.$case !== "action") throw new Error("unexpected response")
  return resp.response.value.chosenActionIndex
}

describe("两层组合模式（General+Single，合成 rpc）", () => {
  it("D1=A：single 层整体前置——priority 500 仍先于 general 的 10 求值", async () => {
    const io = comboIo(generalComboPlan(), singleComboPlan())
    // 纯 priority 排序会让 general:10 先命中（declareEnd=index 1）；层主序下 single:500 胜出
    const chosen = await actOnce(io, ["useSkill", "declareEnd", "elementalTuning"])
    expect(chosen).toBe(2)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "action")!
    expect(entry.matchedRule).toMatchObject({
      scope: "global", priority: 500, layer: "single", layerLabel: "hongniu",
    })
    expect(trace.summary.perRuleHits).toEqual({ "single:hongniu:global:500": 1 })
    expect(trace.routing).toBe("single:hongniu")
    expect(trace.portfolioId).toBe("pf0000000000")
  })

  it("thenMiss 键带层前缀；single 死规则之后 general 层命中", async () => {
    const single = singleComboPlan({
      rules: [{
        priority: 5,
        then: { action_case: "playCard", card_def_id: deck0.cards[0] },
        reason: "single 死规则：无打牌候选",
      }],
    })
    const io = comboIo(generalComboPlan(), single)
    const chosen = await actOnce(io, ["useSkill", "declareEnd", "elementalTuning"])
    expect(chosen).toBe(1)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "action")!
    expect(entry.thenMiss).toEqual(["single:hongniu:global:5"])
    expect(entry.matchedRule).toMatchObject({ scope: "global", priority: 10, layer: "general" })
    expect(entry.matchedRule).not.toHaveProperty("layerLabel")
    expect(trace.summary.perRuleThenMiss).toEqual({ "single:hongniu:global:5": 1 })
    expect(trace.summary.perRuleHits).toEqual({ "general:global:10": 1 })
  })

  it("D2：fallback 取自 single（declare_end），而非 general（conservative）", async () => {
    const single = singleComboPlan({ rules: [], fallback: { policy: "declare_end" } })
    const general = generalComboPlan({ rules: [], fallback: { policy: "conservative" } })
    const io = comboIo(general, single)
    // 候选不含 declareEnd：declare_end 找不到目标 → 原地选 validActions[0]；
    // 与 conservative 的区别只能由 fallbackPolicy 字段证明归属
    const chosen = await actOnce(io, ["useSkill", "elementalTuning"])
    expect(chosen).toBe(0)
    const entry = io.getTraceFile().entries.find((e) => e.method === "action")!
    expect(entry.fallbackUsed).toBe(true)
    expect(entry.fallbackPolicy).toBe("declare_end")
  })

  it("D2：chooseActive 用 single 的 opening，matchedRule 带层标注", async () => {
    const single = singleComboPlan({
      opening: {
        chooseActive: [{ characterDefId: deck0.characters[1], reason: "single 首发二号位" }],
        mulligan: [],
        reroll: [],
      },
    })
    const general = generalComboPlan({
      opening: {
        chooseActive: [{ characterDefId: deck0.characters[0], reason: "general 首发一号位" }],
        mulligan: [],
        reroll: [],
      },
    })
    const io = comboIo(general, single)
    io.notify({ state: fakeActionState() } as never)
    const resp = await io.rpc(createRpcRequest("chooseActive", { candidateIds: [11, 12, 13] }))
    if (resp.response?.$case !== "chooseActive") throw new Error("unexpected response")
    expect(resp.response.value.activeCharacterId).toBe(12)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "chooseActive")!
    expect(entry.matchedRule).toMatchObject({
      scope: "opening", priority: 0, layer: "single", layerLabel: "hongniu",
    })
    expect(trace.summary.perRuleHits).toEqual({ "single:hongniu:opening:0": 1 })
  })

  it("每层独立判定命中 phase；phase 规则键带层前缀与 phaseId", async () => {
    const single = singleComboPlan({
      phases: [{
        phaseId: "burst",
        when: [],
        rules: [{ priority: 3, then: { action_case: "useSkill" }, reason: "single burst 战技" }],
      }],
      rules: [{ priority: 5, then: { action_case: "elementalTuning" }, reason: "single 调和" }],
    })
    const general = generalComboPlan({
      phases: [{
        phaseId: "late",
        when: [{ field: "round", op: ">=", value: 99 }], // 恒假：general 层无命中阶段
        rules: [{
          priority: 1,
          then: { action_case: "playCard", card_def_id: deck0.cards[0] },
          reason: "general late 打牌",
        }],
      }],
    })
    const io = comboIo(general, single)
    const chosen = await actOnce(io, ["useSkill", "declareEnd", "elementalTuning"])
    expect(chosen).toBe(0)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "action")!
    expect(entry.phaseId).toBe("burst")
    expect(entry.matchedRule).toMatchObject({
      scope: "phase", priority: 3, layer: "single", layerLabel: "hongniu",
    })
    expect(trace.summary.perRuleHits).toEqual({ "single:hongniu:phase:burst:3": 1 })
    // general 的 late 阶段未激活：其阶段规则连 thenMiss 都不应出现（层独立判定的证据）
    expect(entry.thenMiss ?? []).not.toContain("general:phase:late:1")
    expect(trace.summary.perRuleThenMiss).toEqual({})
  })

  it("未命中 fallback 条目的 phaseId = single 层的命中阶段", async () => {
    const single = singleComboPlan({
      phases: [{
        phaseId: "burst",
        when: [],
        rules: [{
          priority: 20,
          when: [{ field: "round", op: ">=", value: 99 }],
          then: { action_case: "useSkill" },
          reason: "永不命中",
        }],
      }],
      rules: [],
      fallback: { policy: "declare_end" },
    })
    const general = generalComboPlan({ rules: [] })
    const io = comboIo(general, single)
    const chosen = await actOnce(io, ["useSkill", "elementalTuning"])
    expect(chosen).toBe(0)
    const entry = io.getTraceFile().entries.find((e) => e.method === "action")!
    expect(entry.matchedRule).toBe(null)
    expect(entry.fallbackUsed).toBe(true)
    expect(entry.fallbackPolicy).toBe("declare_end")
    expect(entry.phaseId).toBe("burst")
  })

  it("旧单树模式：matchedRule 无层字段、键保持旧格式、trace 无 routing/portfolioId", async () => {
    const io = comboIo(generalComboPlan(), null)
    const chosen = await actOnce(io, ["useSkill", "declareEnd", "elementalTuning"])
    expect(chosen).toBe(1)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "action")!
    expect(entry.matchedRule).toMatchObject({ scope: "global", priority: 10 })
    expect(entry.matchedRule).not.toHaveProperty("layer")
    expect(entry.matchedRule).not.toHaveProperty("layerLabel")
    expect(trace.summary.perRuleHits).toEqual({ "global:10": 1 })
    expect(trace.routing).toBeUndefined()
    expect(trace.portfolioId).toBeUndefined()
  })

  // 任务 0 口径：portfolio 模式下 general-only 路由同样全程层化（layer="general"），
  // 保证同一条 general 规则在有/无 single 的组里键一致（D6 跨组归并）。
  const layeredGeneralIo = (general: GamePlanV1) =>
    new PlanPlayerIO({
      side: 0,
      plan: general,
      layered: true,
      gameData: data,
      trace: {
        planId: general.planId,
        parentPlanId: null,
        side: 0,
        opponentPolicy: "baseline",
        routing: "general-only",
        portfolioId: "pf0000000000",
      },
    })

  it("任务 0：layered general-only（无 single）——命中/thenMiss 键带 general: 前缀", async () => {
    const general = generalComboPlan({
      rules: [
        { priority: 5, then: { action_case: "playCard", card_def_id: deck0.cards[0] }, reason: "死规则：无打牌候选" },
        { priority: 10, then: { action_case: "declareEnd" }, reason: "general 收" },
      ],
    })
    const io = layeredGeneralIo(general)
    const chosen = await actOnce(io, ["useSkill", "declareEnd", "elementalTuning"])
    expect(chosen).toBe(1)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "action")!
    expect(entry.thenMiss).toEqual(["general:global:5"])
    expect(entry.matchedRule).toMatchObject({ scope: "global", priority: 10, layer: "general" })
    expect(entry.matchedRule).not.toHaveProperty("layerLabel")
    expect(trace.summary.perRuleThenMiss).toEqual({ "general:global:5": 1 })
    expect(trace.summary.perRuleHits).toEqual({ "general:global:10": 1 })
    expect(trace.routing).toBe("general-only")
    expect(trace.portfolioId).toBe("pf0000000000")
  })

  it("任务 0：layered general-only 的 opening 条目带 general 层标注", async () => {
    const general = generalComboPlan({
      opening: {
        chooseActive: [{ characterDefId: deck0.characters[1], reason: "general 首发二号位" }],
        mulligan: [],
        reroll: [],
      },
    })
    const io = layeredGeneralIo(general)
    io.notify({ state: fakeActionState() } as never)
    const resp = await io.rpc(createRpcRequest("chooseActive", { candidateIds: [11, 12, 13] }))
    if (resp.response?.$case !== "chooseActive") throw new Error("unexpected response")
    expect(resp.response.value.activeCharacterId).toBe(12)
    const trace = io.getTraceFile()
    const entry = trace.entries.find((e) => e.method === "chooseActive")!
    expect(entry.matchedRule).toMatchObject({ scope: "opening", priority: 0, layer: "general" })
    expect(trace.summary.perRuleHits).toEqual({ "general:opening:0": 1 })
  })
})

describe("runPlanBatch portfolio 路由", () => {
  const routedPortfolio = (): ResolvedPortfolio => {
    const general = generalComboPlan()
    const single = singleComboPlan({
      rules: [{ priority: 1, then: { action_case: "declareEnd" }, reason: "single 速收（每动必中）" }],
    })
    return {
      manifest: {
        version: "PlanPortfolioV1",
        generalPlan: "general.json",
        singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }],
      },
      general,
      generalId: general.planId,
      singles: [{
        label: "hongniu",
        opponentDeckCode: DECK1,
        planRef: "single.json",
        plan: single,
        planId: single.planId,
      }],
      portfolioId: computePortfolioId({
        generalId: general.planId,
        singles: [{ label: "hongniu", opponentDeckCode: DECK1, planId: single.planId }],
      }),
    }
  }

  it("路由命中 single：组合链键带层前缀，trace 与 portfolio.side0.json 记录 routing/portfolioId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-batch-portfolio-"))
    try {
      const portfolio = routedPortfolio()
      const summary = await runPlanBatch({
        plan: portfolio.general,
        portfolio,
        opponent: { type: "baseline" },
        opponentDeckCode: DECK1,
        games: 1,
        seedBase: 9701,
        outDir: dir,
      }, data)
      // single 层的 declareEnd 规则每动必中，general 层永远轮不到
      const hitKeys = Object.keys(summary.perRuleHits)
      expect(hitKeys.some((k) => k.startsWith("single:hongniu:"))).toBe(true)
      expect(hitKeys.some((k) => k.startsWith("general:"))).toBe(false)
      const trace = JSON.parse(await readFile(join(dir, "game-0001", "plan_trace.json"), "utf-8"))
      expect(trace.routing).toBe("single:hongniu")
      expect(trace.portfolioId).toBe(portfolio.portfolioId)
      const archived = JSON.parse(await readFile(join(dir, "portfolio.side0.json"), "utf-8"))
      expect(archived.portfolioId).toBe(portfolio.portfolioId)
      expect(archived.routing).toBe("single:hongniu")
      expect(archived.resolved.generalId).toBe(portfolio.generalId)
      expect(archived.resolved.singles.hongniu).toEqual({
        opponentDeckCode: DECK1,
        planId: portfolio.singles[0].planId,
      })
      // plan.side0.json 继续写 general 计划（旧工具链可读）
      const side0 = JSON.parse(await readFile(join(dir, "plan.side0.json"), "utf-8"))
      expect(side0.planId).toBe(portfolio.generalId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)

  it("路由未命中：routing=general-only，键带 general: 前缀（任务 0 层化口径，D6 跨组归并）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-batch-portfolio-"))
    try {
      const portfolio = routedPortfolio()
      const summary = await runPlanBatch({
        plan: portfolio.general,
        portfolio,
        opponent: { type: "baseline" },
        opponentDeckCode: DECK0, // 不在 singles 里 → General-only
        games: 1,
        seedBase: 9702,
        outDir: dir,
      }, data)
      const hitKeys = Object.keys(summary.perRuleHits)
      // 无 single 前缀（本 run 未路由到 single）；general 规则带 general: 前缀
      // （portfolio 模式恒层化——同一条 general 规则在各对手组键一致）
      expect(hitKeys.some((k) => k.includes("single:"))).toBe(false)
      expect(hitKeys.some((k) => k.startsWith("general:"))).toBe(true)
      expect(hitKeys).toContain("general:global:10")
      const trace = JSON.parse(await readFile(join(dir, "game-0001", "plan_trace.json"), "utf-8"))
      expect(trace.routing).toBe("general-only")
      expect(trace.portfolioId).toBe(portfolio.portfolioId)
      const entry = (trace.entries as Array<{ method: string; matchedRule: { scope: string; priority: number; layer?: string } | null }>)
        .find((e) => e.method === "action")!
      expect(entry.matchedRule).toMatchObject({ scope: "global", priority: 10, layer: "general" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
