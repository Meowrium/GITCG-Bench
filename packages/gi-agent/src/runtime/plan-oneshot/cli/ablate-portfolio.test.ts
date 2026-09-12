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
 * ablate-portfolio 测试：portfolio 消融臂构造（层化 ruleRef → 变异 portfolio 的
 * 层定位正确：general/single 分层、revise/remove/add、skipped 各路径）、组选择
 * 逻辑（general 臂全组 / single 臂仅命中组 / 无命中 skipped）、跨组指标汇总
 * （胜率按局数加权、thenMiss 求和）与 portfolioFromPatched 的 label 回溯。
 */

import { describe, expect, it } from "vitest"
import type { GamePlanV1 } from "../game-plan-v1.js"
import type { ResolvedPortfolio } from "../portfolio.js"
import { computePortfolioId } from "../portfolio.js"
import {
  aggregateGroupMetrics,
  buildPortfolioAblationArms,
  portfolioFromPatched,
  selectGroupsForArm,
} from "./ablate-portfolio.js"

const DECK0 =
  "ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA"
const DECK1 =
  "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA"

interface PlanSeed {
  planId: string
  rules?: GamePlanV1["rules"]
  phases?: GamePlanV1["phases"]
  opponent: GamePlanV1["context"]["opponent"]
}

const mkPlan = (seed: PlanSeed): GamePlanV1 => ({
  version: "GamePlanV1",
  planId: seed.planId,
  parentPlanId: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  author: "manual",
  context: { deckCode: DECK0, opponent: seed.opponent },
  predictions: { winRateEstimate: 0.5, expectedRounds: 6, confidence: 0.5, keyThreats: [] },
  opening: { chooseActive: [], mulligan: [], reroll: [] },
  phases: seed.phases ?? [],
  rules: seed.rules ?? [
    { priority: 1, when: [{ field: "dice.total", op: ">=", value: 0 }], then: { action_case: "declareEnd" }, reason: "通用兜底" },
  ],
  fallback: { policy: "conservative" },
})

const rule = (priority: number, then: GamePlanV1["rules"][number]["then"], reason: string): GamePlanV1["rules"][number] => ({
  priority,
  when: [{ field: "dice.total", op: ">=", value: 0 }],
  then,
  reason,
})

/** base：general 层 global:5/global:10 + phase:burst:2；single hongniu global:3 */
const basePortfolio = (): ResolvedPortfolio => {
  const general = mkPlan({
    planId: "g10000000001",
    opponent: { kind: "unknown_deck" },
    rules: [
      rule(5, { action_case: "elementalTuning" }, "base g5"),
      rule(10, { action_case: "declareEnd" }, "base g10"),
    ],
    phases: [{ phaseId: "burst", when: [], rules: [rule(2, { action_case: "useSkill" }, "base burst2")] }],
  })
  const single = mkPlan({
    planId: "s10000000001",
    opponent: { kind: "known_deck", deckCode: DECK1 },
    rules: [rule(3, { action_case: "elementalTuning" }, "base s3")],
  })
  const singles = [{ label: "hongniu", opponentDeckCode: DECK1, planRef: "single.json", plan: single, planId: single.planId }]
  return {
    manifest: { version: "PlanPortfolioV1", generalPlan: "general.json", singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }] },
    general,
    generalId: general.planId,
    singles,
    portfolioId: computePortfolioId({ generalId: general.planId, singles }),
  }
}

/** revised：general 层 global:5 修订 + 新增 global:7；single hongniu global:3 修订 + 新增 global:4 */
const revisedPortfolio = (): ResolvedPortfolio => {
  const general = mkPlan({
    planId: "g20000000001",
    opponent: { kind: "unknown_deck" },
    rules: [
      rule(5, { action_case: "declareEnd" }, "revised g5"),
      rule(7, { action_case: "useSkill" }, "revised g7 new"),
      rule(10, { action_case: "declareEnd" }, "revised g10"),
    ],
    phases: [],
  })
  const single = mkPlan({
    planId: "s20000000001",
    opponent: { kind: "known_deck", deckCode: DECK1 },
    rules: [
      rule(3, { action_case: "useSkill" }, "revised s3"),
      rule(4, { action_case: "declareEnd" }, "revised s4 new"),
    ],
  })
  const singles = [{ label: "hongniu", opponentDeckCode: DECK1, planRef: "single.json", plan: single, planId: single.planId }]
  return {
    manifest: { version: "PlanPortfolioV1", generalPlan: "general.json", singles: [{ opponentDeckCode: DECK1, label: "hongniu", planRef: "single.json" }] },
    general,
    generalId: general.planId,
    singles,
    portfolioId: computePortfolioId({ generalId: general.planId, singles }),
  }
}

const claim = (ruleRef: string, verdict: "revise" | "remove" = "revise") => ({
  ruleRef,
  verdict,
  falsifiableClaim: `claim ${ruleRef}`,
})

describe("buildPortfolioAblationArms：层化 ruleRef → 变异 portfolio 的层定位", () => {
  it("general 层 revise：变异 general 层树，single 层原样保留；refKey = 层化键", () => {
    const arms = buildPortfolioAblationArms({ base: basePortfolio(), revised: revisedPortfolio(), claims: [claim("general:global:5")] })
    expect(arms).toHaveLength(1)
    const arm = arms[0]
    expect(arm.skipped).toBeUndefined()
    expect(arm.layer).toEqual({ kind: "general" })
    expect(arm.refKey).toBe("general:global:5")
    expect(arm.patched.general.rules.find((r) => r.priority === 5)?.then).toEqual({ action_case: "declareEnd" })
    // single 层未触及
    expect(arm.patched.singles[0].label).toBe("hongniu")
    expect(arm.patched.singles[0].plan.rules.find((r) => r.priority === 3)?.then).toEqual({ action_case: "elementalTuning" })
  })

  it("single:<label> 层 revise：定位到对应 single 树，general 原样", () => {
    const arms = buildPortfolioAblationArms({ base: basePortfolio(), revised: revisedPortfolio(), claims: [claim("single:hongniu:global:3")] })
    expect(arms).toHaveLength(1)
    const arm = arms[0]
    expect(arm.skipped).toBeUndefined()
    expect(arm.layer).toEqual({ kind: "single", label: "hongniu" })
    expect(arm.refKey).toBe("single:hongniu:global:3")
    expect(arm.patched.singles[0].plan.rules.find((r) => r.priority === 3)?.then).toEqual({ action_case: "useSkill" })
    expect(arm.patched.general.rules.find((r) => r.priority === 5)?.then).toEqual({ action_case: "elementalTuning" })
  })

  it("remove：从对应层树删除该 priority", () => {
    const arms = buildPortfolioAblationArms({ base: basePortfolio(), revised: revisedPortfolio(), claims: [claim("general:global:10", "remove")] })
    expect(arms[0].skipped).toBeUndefined()
    expect(arms[0].patched.general.rules.some((r) => r.priority === 10)).toBe(false)
    expect(arms[0].patched.general.rules.some((r) => r.priority === 5)).toBe(true)
  })

  it("add: 前缀：臂 = base + revised 层树的新增规则（refKey = 合成 ref 去 add:）", () => {
    const arms = buildPortfolioAblationArms({ base: basePortfolio(), revised: revisedPortfolio(), claims: [claim("add:general:global:7")] })
    expect(arms[0].skipped).toBeUndefined()
    // add 插入到 end（base 层树 max=10 → 11）；refKey = 合成 ref 去 add: 前缀
    expect(arms[0].refKey).toBe("general:global:11")
    const added = arms[0].patched.general.rules.find((r) => r.priority === 11)
    expect(added).toBeDefined()
    expect(added!.then).toEqual({ action_case: "useSkill" })
    // base 其余规则保留
    expect(arms[0].patched.general.rules.some((r) => r.priority === 5)).toBe(true)
  })

  it("skipped 路径：无层前缀 / 层不存在 / base 规则不存在 / revised 结构重排 / add 目标不存在", () => {
    const base = basePortfolio()
    const revised = revisedPortfolio()
    const arms = buildPortfolioAblationArms({
      base,
      revised,
      claims: [
        claim("global:5"), // 无层前缀
        claim("single:unknown:global:3"), // 层不存在
        claim("general:global:99"), // base 不存在
        claim("general:phase:burst:2"), // revised 无 burst phase → 结构重排
        claim("add:general:global:99"), // add 目标在 revised 不存在
      ],
    })
    expect(arms.map((a) => a.skipped)).toEqual([
      expect.stringContaining("缺少层前缀"),
      expect.stringContaining("不存在"),
      expect.stringContaining("base 层树中不存在"),
      expect.stringContaining("找不到同位置修订规则"),
      expect.stringContaining("不存在该新增规则"),
    ])
    // skipped 臂的 patched 与 base 相同（未变异）
    expect(arms[0].patched.general.planId).toBe(base.general.planId)
  })

  it("数值修订标记：revise 臂的 then.damage_min 变化 → numericTouched（结构修订不触发）", () => {
    const revised = revisedPortfolio()
    const revisedGeneral = {
      ...revised.general,
      rules: revised.general.rules.map((r) => r.priority === 5 ? { ...r, then: { ...r.then, damage_min: 4 } } : r),
    }
    const numericArms = buildPortfolioAblationArms({
      base: basePortfolio(),
      revised: { ...revised, general: revisedGeneral },
      claims: [claim("general:global:5")],
    })
    expect(numericArms[0].numericTouched).toBe(true)
    expect(numericArms[0].numericChanges).toEqual(["then.damage_min （缺省）→4"])
    // 结构修订（action_case 变化）不触发数值标记 → 回落既有胜率区间判据
    const structuralArms = buildPortfolioAblationArms({ base: basePortfolio(), revised: revisedPortfolio(), claims: [claim("general:global:5")] })
    expect(structuralArms[0].numericTouched).toBe(false)
    expect(structuralArms[0].numericChanges).toEqual([])
  })
})

describe("selectGroupsForArm：臂 → 证据组选择", () => {
  const groups = [
    { label: "run-hongniu", singleLabel: "hongniu" },
    { label: "run-shuining", singleLabel: "shuining" },
    { label: "run-bare", singleLabel: undefined },
  ]

  it("general 臂 → 全部组", () => {
    const r = selectGroupsForArm({ kind: "general" }, groups)
    expect(r.selected.map((g) => g.label)).toEqual(["run-hongniu", "run-shuining", "run-bare"])
    expect(r.skippedNote).toBeUndefined()
  })

  it("single 臂 → 仅路由命中组", () => {
    const r = selectGroupsForArm({ kind: "single", label: "hongniu" }, groups)
    expect(r.selected.map((g) => g.label)).toEqual(["run-hongniu"])
    expect(r.skippedNote).toBeUndefined()
  })

  it("single 臂无命中组 → skipped 说明", () => {
    const r = selectGroupsForArm({ kind: "single", label: "moyou" }, groups)
    expect(r.selected).toEqual([])
    expect(r.skippedNote).toContain("无证据组路由到 single:moyou")
  })
})

describe("aggregateGroupMetrics：General claim 跨组汇总口径", () => {
  it("胜率/coverage/fallback 按局数加权，thenMiss 求和", () => {
    const agg = aggregateGroupMetrics([
      { games: 10, wins: 6, coverage: 0.8, fallbackRate: 0.1, thenMiss: 2 },
      { games: 30, wins: 12, coverage: 0.6, fallbackRate: 0.2, thenMiss: 5 },
    ])
    expect(agg.games).toBe(40)
    expect(agg.wins).toBe(18)
    expect(agg.winRate).toBeCloseTo(18 / 40)
    expect(agg.coverage).toBeCloseTo((0.8 * 10 + 0.6 * 30) / 40)
    expect(agg.fallbackRate).toBeCloseTo((0.1 * 10 + 0.2 * 30) / 40)
    expect(agg.thenMiss).toBe(7)
  })

  it("空数组 → 全零", () => {
    expect(aggregateGroupMetrics([])).toEqual({ games: 0, wins: 0, winRate: 0, coverage: 0, fallbackRate: 0, thenMiss: 0 })
  })
})

describe("portfolioFromPatched：patch 目标 → ResolvedPortfolio", () => {
  it("singles 按 label 回溯 opponentDeckCode/planRef；portfolioId 重算", () => {
    const base = basePortfolio()
    const arms = buildPortfolioAblationArms({ base, revised: revisedPortfolio(), claims: [claim("general:global:5")] })
    const out = portfolioFromPatched(base, arms[0].patched)
    expect(out.singles).toHaveLength(1)
    expect(out.singles[0].label).toBe("hongniu")
    expect(out.singles[0].opponentDeckCode).toBe(DECK1)
    expect(out.singles[0].planRef).toBe("single.json")
    expect(out.generalId).toBe(arms[0].patched.general.planId)
    // portfolioId = 按变异后内容重算
    expect(out.portfolioId).toBe(computePortfolioId({
      generalId: out.generalId,
      singles: out.singles.map((s) => ({ label: s.label, opponentDeckCode: s.opponentDeckCode, planId: s.planId })),
    }))
    expect(out.portfolioId).not.toBe(base.portfolioId)
  })
})
