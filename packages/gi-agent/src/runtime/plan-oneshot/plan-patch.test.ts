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
 * plan-patch 测试：ops 解析（封闭键集合/未知 op 拒绝）、服务端合并
 * （revise/remove/add 定位/set_fallback）、ruleRef 封闭集、上下文不可变。
 */

import { describe, expect, it } from "vitest"
import { parsePlanPatchCommand, applyPlanPatch, isSyntheticPatchRef } from "./plan-patch.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

function basePlan(): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "aaaaaaaaaaaa",
    parentPlanId: null,
    createdAt: "2026-08-30T00:00:00Z",
    author: "test",
    context: { deckCode: "ABC", opponent: { kind: "mirror" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
    opening: { chooseActive: [], mulligan: [], reroll: [] },
    phases: [
      {
        phaseId: "burst",
        when: [{ field: "self.active.energy", op: ">=", value: 3 }],
        rules: [{ priority: 10, when: [{ field: "dice.geo", op: ">=", value: 3 }], then: { action_case: "useSkill", skill_type: "burst" }, reason: "爆发" }],
      },
    ],
    rules: [
      { priority: 5, when: [{ field: "self.active.element", op: "==", value: "geo" }], then: { action_case: "elementalTuning" }, reason: "调岩" },
      { priority: 20, then: { action_case: "useSkill", skill_type: "normal_attack", target: "opponent.active" }, reason: "普攻兜底" },
    ],
    fallback: { policy: "conservative" },
  }
}

describe("parsePlanPatchCommand", () => {
  it("合法命令通过且 ops 数量上限生效", () => {
    const ok = parsePlanPatchCommand({ ops: [{ op: "remove", ruleRef: "global:5", reason: "死规则" }] })
    expect(ok.ok).toBe(true)
    const tooMany = parsePlanPatchCommand(
      { ops: Array.from({ length: 9 }, (_, i) => ({ op: "remove", ruleRef: `global:${i === 0 ? 5 : 20}`, reason: "r" })) },
      { maxOps: 8 },
    )
    // 9 个 op 里 8 个指向同一不存在的规则……上限检查先于封闭集
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.errors[0]).toContain("最多 8")
  })

  it("未知 op 类型 / 未知键 / 缺 reason 拒绝", () => {
    const cases: unknown[] = [
      { ops: [{ op: "reorder", ruleRef: "global:5" }] },
      { ops: [{ op: "remove", ruleRef: "global:5", reason: "r", context: { deckCode: "HACK" } }] },
      { ops: [{ op: "remove", ruleRef: "global:5" }] },
      { ops: "not-array" },
      { ops: [{ op: "remove", ruleRef: "global:5", reason: "r" }], predictionPostmortem: "x", bogus: 1 },
    ]
    for (const c of cases) {
      const r = parsePlanPatchCommand(c)
      expect(r.ok).toBe(false)
    }
  })

  it("add 缺 then / position 非法引用 / set_fallback 非法 policy 拒绝", () => {
    expect(parsePlanPatchCommand({ ops: [{ op: "add", reason: "r" }] }).ok).toBe(false)
    expect(parsePlanPatchCommand({ ops: [{ op: "add", then: { action_case: "declareEnd" }, position: { before: "bogus" }, reason: "r" }] }).ok).toBe(false)
    expect(parsePlanPatchCommand({ ops: [{ op: "set_fallback", policy: "aggressive", reason: "r" }] }).ok).toBe(false)
  })
})

describe("applyPlanPatch", () => {
  it("revise：改 when/then、保留 priority；缺省字段沿用原值", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, {
      ops: [{ op: "revise", ruleRef: "global:5", when: [{ field: "dice.geo+omni", op: ">=", value: 1 }], reason: "补万能骰支付" }],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rule = r.plan.rules.find((x) => x.priority === 5)!
    expect(rule.when).toEqual([{ field: "dice.geo+omni", op: ">=", value: 1 }])
    expect(rule.then).toEqual({ action_case: "elementalTuning" })
    expect(rule.reason).toBe("补万能骰支付")
    // 原计划不被修改（服务端合并的不可变性）
    expect(plan.rules.find((x) => x.priority === 5)!.when).toEqual([{ field: "self.active.element", op: "==", value: "geo" }])
    expect(r.verdicts[0]).toMatchObject({ ruleRef: "global:5", verdict: "revise", source: "patch" })
  })

  it("remove：全局与阶段规则", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, {
      ops: [
        { op: "remove", ruleRef: "global:20", reason: "普攻兜底黑洞" },
        { op: "remove", ruleRef: "phase:burst:10", reason: "死爆发" },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.rules).toHaveLength(1)
    expect(r.plan.phases[0].rules).toHaveLength(0)
    expect(r.verdicts.map((v) => v.verdict)).toEqual(["remove", "remove"])
  })

  it("add：位置语义（end/start/before/after 半分插入，不重排既有规则）", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, {
      ops: [
        { op: "add", position: { before: "global:20" }, when: [{ field: "opponent.active.hp", op: "<=", value: 5 }], then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "收头" },
        { op: "add", position: { after: "global:5" }, then: { action_case: "playCard", card_def_id: 312010 }, reason: "装备" },
        { op: "add", scope: "burst", position: "start", then: { action_case: "useSkill", skill_type: "burst" }, reason: "阶段爆发" },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const pris = r.plan.rules.map((x) => x.priority).sort((a, b) => a - b)
    // before global:20 → (5+20)/2=12.5；after global:5 → next 已是 12.5 → (5+12.5)/2=8.75；phase start → 9
    expect(pris).toEqual([5, 8.75, 12.5, 20])
    // phase start 插入 → priority 9（原 10 的规则保留，数组顺序不重排）
    expect(r.plan.phases[0].rules.map((x) => x.priority).sort((a, b) => a - b)).toEqual([9, 10])
    // 合成 verdicts 的 add ref
    expect(r.verdicts.every((v) => isSyntheticPatchRef(v.ruleRef) || v.ruleRef.startsWith("add:"))).toBe(true)
  })

  it("set_fallback 与 predictions/postmortem 透传", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, { ops: [{ op: "set_fallback", policy: "baseline", reason: "兜底可执行动作" }] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.fallback.policy).toBe("baseline")
  })

  it("封闭集合：不存在的 ruleRef / 重复操作 / 未知 phase → 整批拒绝且不部分应用", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, {
      ops: [
        { op: "remove", ruleRef: "global:20", reason: "ok" },
        { op: "revise", ruleRef: "global:77", when: [], reason: "不存在" },
      ],
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join("\n")).toContain("global:77")
    // 原计划完全未被触碰
    expect(plan.rules).toHaveLength(2)
    expect(plan.phases[0].rules).toHaveLength(1)

    const dup = applyPlanPatch(plan, {
      ops: [
        { op: "remove", ruleRef: "global:5", reason: "a" },
        { op: "revise", ruleRef: "global:5", when: [], reason: "b" },
      ],
    })
    expect(dup.ok).toBe(false)

    const badScope = applyPlanPatch(plan, { ops: [{ op: "add", scope: "nope", then: { action_case: "declareEnd" }, reason: "r" }] })
    expect(badScope.ok).toBe(false)
  })

  it("顺序语义：后面的 op 看到前面 op 的结果；revise 已被删除的规则报错", () => {
    const plan = basePlan()
    const r = applyPlanPatch(plan, {
      ops: [
        { op: "remove", ruleRef: "global:5", reason: "先删" },
        { op: "add", position: { after: "global:20" }, then: { action_case: "declareEnd" }, reason: "在 20 后加" },
      ],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.rules.map((x) => x.priority)).toEqual([20, 21])
  })
})

describe("applyPlanPatch 层协议（Phase 3a，G5-3）", () => {
  /** portfolio 最小目标（ResolvedPortfolio 结构兼容）：general + 一个 single */
  function portfolioTarget(): { general: GamePlanV1; singles: Array<{ label: string; plan: GamePlanV1 }> } {
    const general = basePlan()
    general.planId = "ge0000000001"
    general.context = { deckCode: "ABC", opponent: { kind: "unknown_deck" } }
    const single = basePlan()
    single.planId = "si0000000001"
    single.context = { deckCode: "ABC", opponent: { kind: "known_deck", deckCode: "DEF" } }
    single.rules = single.rules.filter((r) => r.priority !== 20) // 移除普攻兜底，留 global:5
    return { general, singles: [{ label: "hongniu", plan: single }] }
  }

  it("单树目标：带层前缀 ruleRef / layer 键一律拒绝（旧合法输入零行为变化）", () => {
    const plan = basePlan()
    const prefixed = applyPlanPatch(plan, {
      ops: [{ op: "remove", ruleRef: "general:global:5", reason: "r" }],
    })
    expect(prefixed.ok).toBe(false)
    if (prefixed.ok) return
    expect(prefixed.errors.join("\n")).toContain("单树目标不接受层前缀")

    const layerKey = applyPlanPatch(plan, {
      ops: [{ op: "add", layer: "general", then: { action_case: "declareEnd" }, reason: "r" }],
    })
    expect(layerKey.ok).toBe(false)
    if (layerKey.ok) return
    expect(layerKey.errors.join("\n")).toContain("单树目标不接受 layer 键")
  })

  it("portfolio 目标：revise/remove 必须带层前缀；层内封闭集合按层展开", () => {
    const { general, singles } = portfolioTarget()
    // 无前缀 → 报错
    const bare = applyPlanPatch({ general, singles }, {
      ops: [{ op: "remove", ruleRef: "global:5", reason: "r" }],
    })
    expect(bare.ok).toBe(false)
    if (bare.ok) return
    expect(bare.errors.join("\n")).toContain("必须带层前缀")

    // 带层前缀但键在该层不存在 → 报错（层内封闭集合）
    const missing = applyPlanPatch({ general, singles }, {
      ops: [{ op: "remove", ruleRef: "general:global:77", reason: "r" }],
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.errors.join("\n")).toContain("general:global:77")

    // 单树独有的 global:20 不存在于 single 层（single 已过滤掉）→ 报错
    const cross = applyPlanPatch({ general, singles }, {
      ops: [{ op: "remove", ruleRef: "single:hongniu:global:20", reason: "r" }],
    })
    expect(cross.ok).toBe(false)

    // 合法：revise general 层 + remove single 层，verdicts 带层前缀
    const ok = applyPlanPatch({ general, singles }, {
      ops: [
        { op: "revise", ruleRef: "general:global:5", when: [{ field: "dice.geo+omni", op: ">=", value: 1 }], reason: "general 补万能骰" },
        { op: "remove", ruleRef: "single:hongniu:global:5", reason: "single 死规则" },
      ],
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.portfolio.general.rules.find((r) => r.priority === 5)!.when).toEqual([{ field: "dice.geo+omni", op: ">=", value: 1 }])
    expect(ok.portfolio.singles[0].plan.rules).toHaveLength(0)
    expect(ok.verdicts.map((v) => v.ruleRef)).toEqual(["general:global:5", "single:hongniu:global:5"])
    // 原目标不被修改
    expect(general.rules.find((r) => r.priority === 5)!.when).toEqual([{ field: "self.active.element", op: "==", value: "geo" }])
    expect(singles[0].plan.rules).toHaveLength(1)
  })

  it("portfolio 目标：add / set_fallback 必须带 layer 键；层定位先于 scope/position", () => {
    const { general, singles } = portfolioTarget()
    const noLayer = applyPlanPatch({ general, singles }, {
      ops: [{ op: "add", then: { action_case: "declareEnd" }, reason: "r" }],
    })
    expect(noLayer.ok).toBe(false)
    if (noLayer.ok) return
    expect(noLayer.errors.join("\n")).toContain("必须提供 layer 键")

    // add 到 general 层（position.before 引用 general 层键）；add 到 single 层（scope 用该层 phase）
    const ok = applyPlanPatch({ general, singles }, {
      ops: [
        { op: "add", layer: "general", position: { before: "general:global:20" }, then: { action_case: "useSkill", skill_type: "elemental_skill" }, reason: "general 收头" },
        { op: "add", layer: "single:hongniu", scope: "burst", then: { action_case: "useSkill", skill_type: "burst" }, reason: "single 爆发" },
        { op: "set_fallback", layer: "single:hongniu", policy: "baseline", reason: "single 兜底" },
      ],
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    // general: before global:20 → (5+20)/2=12.5
    expect(ok.portfolio.general.rules.map((r) => r.priority).sort((a, b) => a - b)).toEqual([5, 12.5, 20])
    // single: phase burst end 插入 → priority 11（原 10 保留）
    expect(ok.portfolio.singles[0].plan.phases[0].rules.map((r) => r.priority).sort((a, b) => a - b)).toEqual([10, 11])
    expect(ok.portfolio.singles[0].plan.fallback.policy).toBe("baseline")
    expect(ok.verdicts.map((v) => v.ruleRef)).toEqual([
      "add:general:global:12.5",
      "add:single:hongniu:burst:11",
      "single:hongniu:fallback",
    ])
    // 合成 ref 全部被白名单识别（add:* 与带层 fallback）
    expect(ok.verdicts.every((v) => isSyntheticPatchRef(v.ruleRef))).toBe(true)
  })

  it("portfolio 目标：层不存在 / add.scope 不是该层 phaseId / position 层不一致 → 报错", () => {
    const { general, singles } = portfolioTarget()
    const badLayer = applyPlanPatch({ general, singles }, {
      ops: [{ op: "add", layer: "single:leihe", then: { action_case: "declareEnd" }, reason: "r" }],
    })
    expect(badLayer.ok).toBe(false)
    if (badLayer.ok) return
    expect(badLayer.errors.join("\n")).toContain("layer 不存在")

    const badScope = applyPlanPatch({ general, singles }, {
      ops: [{ op: "add", layer: "single:hongniu", scope: "nope", then: { action_case: "declareEnd" }, reason: "r" }],
    })
    expect(badScope.ok).toBe(false)

    const badPos = applyPlanPatch({ general, singles }, {
      ops: [{ op: "add", layer: "general", position: { before: "single:hongniu:global:5" }, then: { action_case: "declareEnd" }, reason: "r" }],
    })
    expect(badPos.ok).toBe(false)
    if (badPos.ok) return
    expect(badPos.errors.join("\n")).toContain("position 引用层与 add.layer 不一致")
  })

  it("portfolio 目标：被触及层 finalize——planId 重算、parentPlanId 指向该层旧 planId；未触及层原样", () => {
    const { general, singles } = portfolioTarget()
    const generalOldId = general.planId
    const singleOldId = singles[0].plan.planId
    const ok = applyPlanPatch({ general, singles }, {
      ops: [{ op: "revise", ruleRef: "single:hongniu:global:5", when: [{ field: "round", op: ">=", value: 2 }], reason: "r" }],
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    // 只有 single 层被触及：single.planId 重算且 parentPlanId = 旧 singleId；general 保持原 planId
    expect(ok.portfolio.singles[0].plan.planId).not.toBe(singleOldId)
    expect(ok.portfolio.singles[0].plan.parentPlanId).toBe(singleOldId)
    expect(ok.portfolio.general.planId).toBe(generalOldId)
  })
})
