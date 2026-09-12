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
 * normalizePlanNumericFields / validateGamePlan 的 target 归一化测试：
 * LLM 把数字 id 写成字符串（"1605"）时，target 若未归一化会在运行时
 * （matchTarget 的 typeof number 检查）变成永不命中的死规则。
 */

import { describe, expect, it } from "vitest"
import { normalizePlanNumericFields, validateGamePlan } from "./validate.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

function basePlan(): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "p",
    parentPlanId: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    author: "test",
    context: { deckCode: "code", opponent: { kind: "mirror" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 5, confidence: 0.5, keyThreats: [] },
    opening: { chooseActive: [], mulligan: [], reroll: [] },
    phases: [],
    rules: [
      {
        priority: 1,
        when: [],
        then: { action_case: "switchActive", target: "1605" as unknown as number },
        reason: "t",
      },
    ],
    fallback: { policy: "conservative" },
  }
}

describe("normalizePlanNumericFields target", () => {
  it('字符串化 defId target（"1605"）归一化为数字 1605', () => {
    const out = normalizePlanNumericFields(basePlan())
    const then = out.rules?.[0].then
    expect(typeof then?.target).toBe("number")
    expect(then?.target).toBe(1605)
  })

  it("字符串哨兵 opponent.active / opponent.benched 保持原样", () => {
    const plan = basePlan()
    plan.rules = [
      { priority: 1, when: [], then: { action_case: "useSkill", target: "opponent.active" }, reason: "t" },
      { priority: 2, when: [], then: { action_case: "playCard", target: "opponent.benched", card_def_id: 1 }, reason: "t" },
    ]
    const out = normalizePlanNumericFields(plan)
    expect(out.rules?.[0].then.target).toBe("opponent.active")
    expect(out.rules?.[1].then.target).toBe("opponent.benched")
  })
})

describe("validateGamePlan 字符串 target 防御", () => {
  it("normalize 未跑时，非法字符串 target 报 issue（可修复）", () => {
    const plan = basePlan()
    // 不调用 normalize，直接校验——字符串 target 应被拦下
    const r = validateGamePlan(plan, { deck: { characters: [1605], cards: [] } })
    expect(r.ok).toBe(false)
    const hit = r.issues.find((i) => i.path.endsWith("then.target"))
    expect(hit).toBeDefined()
    expect(hit?.repairable).toBe(true)
  })

  it("normalize 后合法数字 target 通过校验（无 target issue）", () => {
    const plan = normalizePlanNumericFields(basePlan())
    const r = validateGamePlan(plan, { deck: { characters: [1605], cards: [] } })
    const hit = r.issues.find((i) => i.path.endsWith("then.target"))
    expect(hit).toBeUndefined()
  })
})

describe("validateGamePlan skill_def_id", () => {
  const CTX = { deck: { characters: [1703], cards: [] } }
  const withThen = (then: unknown): GamePlanV1 => {
    const plan = basePlan()
    plan.context = { deckCode: "code", opponent: { kind: "mirror" } }
    plan.rules = [{ priority: 1, when: [], then: then as GamePlanV1["rules"][number]["then"], reason: "t" }]
    return plan
  }

  it("非数字 skill_def_id 报 issue", () => {
    const r = validateGamePlan(withThen({ action_case: "useSkill", skill_def_id: "17033" }), CTX)
    expect(r.ok).toBe(false)
    expect(r.issues.map((i) => i.path)).toContain("rules[0].then.skill_def_id")
  })

  it("skill_def_id 仅允许 useSkill（配 playCard 报 issue）", () => {
    const r = validateGamePlan(withThen({ action_case: "playCard", card_def_id: 1, skill_def_id: 17033 }), CTX)
    expect(r.issues.map((i) => i.path)).toContain("rules[0].then.skill_def_id")
  })

  it("skill_type + skill_def_id 同时给出不冲突（两个过滤都生效）", () => {
    const r = validateGamePlan(withThen({ action_case: "useSkill", skill_type: "elemental_skill", skill_def_id: 17033 }), CTX)
    expect(r.issues.filter((i) => i.path.includes("skill_"))).toEqual([])
  })
})
