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
 * 路线换轴单元级嫁接测试：各单元类型、phase 替换 vs 追加、守卫（≤2/已采纳/
 * phaseId 必须在候选树）、输入不可变、形状摘要与 alternates 旁档。
 */

import { describe, expect, it } from "vitest"
import type { GamePlanV1 } from "./game-plan-v1.js"
import {
  PLAN_ALTERNATES_VERSION,
  adoptedUnitMap,
  applyRouteGraft,
  buildAlternatesSidecar,
  checkGraftUnits,
  normalizeGraftUnit,
  planShapeSummary,
  type AlternateCandidate,
} from "./plan-graft.js"

function plan(over: Partial<GamePlanV1> = {}): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "p0",
    parentPlanId: null,
    createdAt: "2026-09-08T00:00:00.000Z",
    author: "test",
    context: { deckCode: "DECK", opponent: { kind: "mirror" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 8, confidence: 0.5, keyThreats: [] },
    opening: {
      chooseActive: [{ characterDefId: 1301, reason: "工作树首发" }],
      mulligan: [{ keep: { cardDefId: 311501 }, reason: "留牌" }],
      reroll: [{ keepElements: ["pyro"], reason: "留火" }],
    },
    phases: [
      { phaseId: "burst", when: [{ field: "self.active.energy", op: "==", value: 3 }], rules: [{ priority: 5, then: { action_case: "declareEnd" }, reason: "工作树爆发" }] },
    ],
    rules: [
      { priority: 10, then: { action_case: "useSkill", skill_type: "normal_attack" }, reason: "工作树普攻" },
      { priority: 20, then: { action_case: "declareEnd" }, reason: "工作树兜底" },
    ],
    fallback: { policy: "conservative" },
    ...over,
  }
}

function candidate(over: Partial<GamePlanV1> = {}): GamePlanV1 {
  return plan({
    planId: "p1",
    opening: {
      chooseActive: [{ characterDefId: 1403, reason: "候选首发" }],
      mulligan: [{ toss: { cardTag: "food" }, reason: "弃食物" }],
      reroll: [{ keepElements: ["electro", "omni"], minKeep: 2, reason: "留雷" }],
    },
    phases: [
      { phaseId: "burst", when: [{ field: "self.active.energy", op: ">=", value: 2 }], rules: [{ priority: 5, then: { action_case: "useSkill", skill_type: "burst" }, reason: "候选爆发" }] },
      { phaseId: "late", when: [{ field: "round", op: ">=", value: 6 }], rules: [{ priority: 6, then: { action_case: "declareEnd" }, reason: "候选后期" }] },
    ],
    rules: [
      { priority: 7, then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "候选战技" },
      { priority: 30, then: { action_case: "declareEnd" }, reason: "候选兜底" },
    ],
    fallback: { policy: "declare_end" },
    ...over,
  })
}

describe("normalizeGraftUnit", () => {
  it("接受四种单元形态，拒绝其他", () => {
    expect(normalizeGraftUnit("opening")).toBe("opening")
    expect(normalizeGraftUnit(" fallback ")).toBe("fallback")
    expect(normalizeGraftUnit("rules")).toBe("rules")
    expect(normalizeGraftUnit("phase:burst")).toBe("phase:burst")
    expect(normalizeGraftUnit("phase:")).toBeNull()
    expect(normalizeGraftUnit("opening+fallback")).toBeNull()
    expect(normalizeGraftUnit(42)).toBeNull()
  })
})

describe("applyRouteGraft", () => {
  it("opening 整体替换（chooseActive/mulligan/reroll），其余保持工作树", () => {
    const working = plan()
    const cand = candidate()
    const { plan: out, applied } = applyRouteGraft(working, cand, ["opening"])
    expect(applied).toEqual(["opening"])
    expect(out.opening).toEqual(cand.opening)
    expect(out.rules).toEqual(working.rules)
    expect(out.fallback).toEqual(working.fallback)
    expect(out.phases).toEqual(working.phases)
  })

  it("fallback 只换 policy", () => {
    const { plan: out, applied } = applyRouteGraft(plan(), candidate(), ["fallback"])
    expect(applied).toEqual(["fallback"])
    expect(out.fallback).toEqual({ policy: "declare_end" })
    expect(out.opening).toEqual(plan().opening)
  })

  it("rules 整体替换且 priority 原样取自候选", () => {
    const { plan: out } = applyRouteGraft(plan(), candidate(), ["rules"])
    expect(out.rules.map((r) => r.priority)).toEqual([7, 30])
    expect(out.rules[0].reason).toBe("候选战技")
  })

  it("phase:<id> 工作树已存在 → 原位替换（位置不变）", () => {
    const working = plan({
      phases: [
        { phaseId: "early", when: [], rules: [{ priority: 1, then: { action_case: "declareEnd" }, reason: "e" }] },
        { phaseId: "burst", when: [], rules: [{ priority: 5, then: { action_case: "declareEnd" }, reason: "b" }] },
      ],
    })
    const { plan: out, applied } = applyRouteGraft(working, candidate(), ["phase:burst"])
    expect(applied).toEqual(["phase:burst"])
    expect(out.phases.map((p) => p.phaseId)).toEqual(["early", "burst"])
    expect(out.phases[1].rules[0].reason).toBe("候选爆发")
  })

  it("phase:<id> 工作树没有 → 追加到 phases 末尾", () => {
    const working = plan()
    const { plan: out, applied } = applyRouteGraft(working, candidate(), ["phase:late"])
    expect(applied).toEqual(["phase:late"])
    expect(out.phases.map((p) => p.phaseId)).toEqual(["burst", "late"])
    expect(out.phases[1].rules[0].reason).toBe("候选后期")
  })

  it("多单元一次嫁接：各取各的单元来源", () => {
    const { plan: out, applied } = applyRouteGraft(plan(), candidate(), ["opening", "phase:late"])
    expect(applied).toEqual(["opening", "phase:late"])
    expect(out.opening.chooseActive[0].characterDefId).toBe(1403)
    expect(out.phases.map((p) => p.phaseId)).toEqual(["burst", "late"])
    expect(out.rules).toEqual(plan().rules)
  })

  it("候选树中不存在的 phase 被跳过（兜底，不抛错）", () => {
    const { plan: out, applied } = applyRouteGraft(plan(), candidate(), ["phase:nope"])
    expect(applied).toEqual([])
    expect(out.phases).toEqual(plan().phases)
  })

  it("输入不可变（工作树与候选树均不被修改）", () => {
    const working = plan()
    const cand = candidate()
    const workingBefore = structuredClone(working)
    const candBefore = structuredClone(cand)
    const { plan: out } = applyRouteGraft(working, cand, ["opening", "rules", "fallback"])
    expect(working).toEqual(workingBefore)
    expect(cand).toEqual(candBefore)
    // 返回的是新对象：改它不影响输入
    out.opening.chooseActive[0].characterDefId = 9999
    expect(working.opening.chooseActive[0].characterDefId).toBe(1301)
  })
})

describe("checkGraftUnits", () => {
  it("归一化合法 units", () => {
    const r = checkGraftUnits(candidate(), ["opening", " phase:late "])
    expect(r).toEqual({ ok: true, units: ["opening", "phase:late"] })
  })

  it("单次 >2 个单元 → 拒绝", () => {
    const r = checkGraftUnits(candidate(), ["opening", "fallback", "rules"])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("单次最多嫁接 2 个单元")
  })

  it("非数组 / 空数组 / 非法 unit / 重复 unit → 拒绝", () => {
    expect(checkGraftUnits(candidate(), undefined).ok).toBe(false)
    expect(checkGraftUnits(candidate(), []).ok).toBe(false)
    const bad = checkGraftUnits(candidate(), ["opening", "opening"])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join("\n")).toContain("重复")
    const illegal = checkGraftUnits(candidate(), ["opening:all"])
    expect(illegal.ok).toBe(false)
    if (!illegal.ok) expect(illegal.errors.join("\n")).toContain("非法")
  })

  it("phaseId 必须在候选树中存在（工作树有、候选树没有也拒绝）", () => {
    const r = checkGraftUnits(candidate(), ["phase:burst", "phase:nope"])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("phase:nope")
      expect(r.errors.join("\n")).toContain("候选树中不存在")
    }
    // burst 在候选树中存在 → 放行
    expect(checkGraftUnits(candidate(), ["phase:burst"]).ok).toBe(true)
  })

  it("已采纳单元（候选 adoptedUnits）→ 拒绝", () => {
    const r = checkGraftUnits(candidate(), ["opening"], { adopted: new Set(["opening"]) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("已被该候选采纳")
  })

  it("本 run 已从其他候选嫁接 → 拒绝", () => {
    const r = checkGraftUnits(candidate(), ["fallback"], { graftedThisRun: new Set(["fallback"]) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("本 run 已从其他候选嫁接")
  })

  it("本 run 累计上限：已嫁接 1 个后再嫁 2 个 → 拒绝", () => {
    const r = checkGraftUnits(candidate(), ["opening", "fallback"], { graftedThisRun: new Set(["rules"]) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join("\n")).toContain("超过本 run 上限 2")
    // 再嫁 1 个仍可
    expect(checkGraftUnits(candidate(), ["opening"], { graftedThisRun: new Set(["rules"]) }).ok).toBe(true)
  })
})

describe("planShapeSummary", () => {
  it("给出首发/phases/rules/fallback 的紧凑形态", () => {
    const s = planShapeSummary(candidate())
    expect(s).toContain("opening 首发=1403")
    expect(s).toContain("phases=2（burst/late）")
    expect(s).toContain("global rules=2")
    expect(s).toContain("fallback=declare_end")
    expect(planShapeSummary(plan({ phases: [] }))).toContain("phases=0；")
  })
})

describe("alternates 旁档", () => {
  it("buildAlternatesSidecar 保序 + 深拷贝候选", () => {
    const candidates: AlternateCandidate[] = [
      { index: 0, archetype: "控制", reviewNote: "稳", adoptedUnits: [], plan: plan() },
      { index: 1, archetype: "节奏", reviewNote: "快", adoptedUnits: [], plan: candidate() },
    ]
    const sidecar = buildAlternatesSidecar({ deckCode: "DECK", chosenIndex: 1, candidates, createdAt: "2026-09-08T00:00:00.000Z" })
    expect(sidecar.version).toBe(PLAN_ALTERNATES_VERSION)
    expect(sidecar.chosenIndex).toBe(1)
    expect(sidecar.candidates.map((c) => c.index)).toEqual([0, 1])
    sidecar.candidates[0].plan.opening.chooseActive[0].characterDefId = 9999
    expect(candidates[0].plan.opening.chooseActive[0].characterDefId).toBe(1301)
  })

  it("adoptedUnitMap 汇总逐候选已采纳单元", () => {
    const sidecar = buildAlternatesSidecar({
      deckCode: "DECK",
      chosenIndex: 0,
      candidates: [
        { index: 0, archetype: "a", reviewNote: "", adoptedUnits: [], plan: plan() },
        { index: 2, archetype: "b", reviewNote: "", adoptedUnits: ["opening"], plan: candidate() },
      ],
    })
    const map = adoptedUnitMap(sidecar)
    expect([...map.get(0)!]).toEqual([])
    expect([...map.get(2)!]).toEqual(["opening"])
  })
})
