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
 * fields-lint 第 4 类（卡面数值校核）测试：合成计划 + 桩 card-face 事实表（零网络）。
 * 同时回归 ①②③ 类 finding 的 kind 标注；末尾一组用真实 @gi-tcg/data 源码事实表
 * （buildCardFaceTable，纯本地扫描）证明费用腿与 damage_min 腿都会触发。
 */

import { describe, expect, it } from "vitest"
import { buildCardFaceTable, type CardFaceDef, type CardFaceTable } from "./card-face-table.js"
import { lintPlan, type PlanLintContext } from "./fields-lint.js"
import type { DecisionRuleV1, GamePlanV1 } from "./game-plan-v1.js"

function stubDef(over: Partial<CardFaceDef> & { defId: number; kind: CardFaceDef["kind"] }): CardFaceDef {
  return {
    sourceFile: "stub.ts",
    costs: [],
    damage: [],
    heal: [],
    dynamic: false,
    skillIds: [],
    ...over,
  }
}

function stubTable(defs: CardFaceDef[]): CardFaceTable {
  const map = new Map(defs.map((d) => [d.defId, d]))
  const skillsOf = (charDefId: number): CardFaceDef[] => {
    const ch = map.get(charDefId)
    if (!ch || ch.kind !== "character") return []
    return ch.skillIds.map((id) => map.get(id)).filter((d): d is CardFaceDef => d !== undefined)
  }
  return {
    gameVersion: "v6.6.0",
    size: map.size,
    get: (id) => map.get(id),
    skillsOf,
    skillOfType: (charDefId, skillType) => skillsOf(charDefId).find((d) => d.skillType === skillType),
    baseDamageOf: (id) => {
      const d = map.get(id)
      return d && !d.dynamic ? d.damage[0] : undefined
    },
  }
}

function plan(rules: DecisionRuleV1[]): GamePlanV1 {
  return {
    version: "GamePlanV1",
    planId: "linttest0001",
    parentPlanId: null,
    createdAt: "2026-09-08T00:00:00Z",
    author: "test",
    context: { deckCode: "ABC", opponent: { kind: "unknown_deck" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 7, confidence: 0.5, keyThreats: [] },
    opening: { chooseActive: [], mulligan: [], reroll: [] },
    phases: [],
    rules,
    fallback: { policy: "conservative" },
  }
}

function cardFaceFindings(p: GamePlanV1, ctx: PlanLintContext) {
  return lintPlan(p, ctx).filter((f) => f.kind === "card-face")
}

const ELECTRO_CARD = 312010
const RAIDEN = 1407

const ctx: PlanLintContext = {
  cardFace: stubTable([
    stubDef({ defId: ELECTRO_CARD, kind: "card", costs: [{ element: "electro", count: 3 }] }),
    stubDef({ defId: RAIDEN, kind: "character", health: 10, skillIds: [14073, 14075] }),
    stubDef({ defId: 14073, kind: "skill", skillType: "burst", costs: [{ element: "electro", count: 3 }, { element: "energy", count: 2 }], damage: [{ type: "Electro", value: 3 }] }),
    stubDef({ defId: 14075, kind: "skill", skillType: "normal", dynamic: true, damage: [{ type: "Physical", value: 9 }] }),
    stubDef({ defId: 1602, kind: "character", health: 12, skillIds: [] }),
  ]),
}

/** useSkill 的技能持有者：从 when 的 self.active.defId 推导；数字 target 是对手侧目标 */
const OWNER = { field: "self.active.defId", op: "==", value: RAIDEN } as const
const OPP_TARGET = 1602

describe("lintPlan 第 4 类：卡面数值校核", () => {
  it("playCard 骰子闸低于卡面费用 → 疑似费用记错（under）", () => {
    const p = plan([{
      priority: 1,
      when: [{ field: "dice.electro+omni", op: ">=", value: 2 }],
      then: { action_case: "playCard", card_def_id: ELECTRO_CARD },
      reason: "打出雷楔",
    }])
    const f = cardFaceFindings(p, ctx)
    expect(f).toHaveLength(1)
    expect(f[0].path).toBe("rules[0]")
    expect(f[0].message).toContain("below the card cost 3雷")
    expect(f[0].message).toContain("always misses")
  })

  it("playCard 骰子闸高于卡面费用 → 启发式（over，规格 demo：>=4 vs 3 费）", () => {
    const p = plan([{
      priority: 1,
      when: [{ field: "dice.electro+omni", op: ">=", value: 4 }],
      then: { action_case: "playCard", card_def_id: ELECTRO_CARD },
      reason: "打出雷楔",
    }])
    const f = cardFaceFindings(p, ctx)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("above the card cost 3雷 (1 extra)")
    expect(f[0].message).toContain("heuristic")
  })

  it("闸值恰好等于费用 → 零发现（不误报）", () => {
    const p = plan([{
      priority: 1,
      when: [{ field: "dice.electro+omni", op: ">=", value: 3 }],
      then: { action_case: "playCard", card_def_id: ELECTRO_CARD },
      reason: "打出雷楔",
    }])
    expect(cardFaceFindings(p, ctx)).toHaveLength(0)
  })

  it("dice.total 闸 vs 骰子总费（充能不占骰）", () => {
    const p = plan([
      {
        priority: 1,
        when: [{ field: "dice.total", op: ">=", value: 2 }],
        then: { action_case: "playCard", card_def_id: ELECTRO_CARD },
        reason: "总骰不足",
      },
      {
        priority: 2,
        when: [{ field: "dice.total", op: ">", value: 3 }],
        then: { action_case: "playCard", card_def_id: ELECTRO_CARD },
        reason: "总骰偏高",
      },
    ])
    const f = cardFaceFindings(p, ctx)
    expect(f.map((x) => x.path)).toEqual(["rules[0]", "rules[1]"])
    expect(f[0].message).toContain("below the card cost 3雷")
    expect(f[1].message).toContain("above the card cost 3雷")
  })

  it("useSkill：持有者取自 when 的 self.active.defId，数字 target 是对手侧目标", () => {
    const under = plan([{
      priority: 1,
      when: [OWNER, { field: "dice.electro+omni", op: ">=", value: 2 }],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET },
      reason: "雷神 Q",
    }])
    const over = plan([{
      priority: 1,
      when: [OWNER, { field: "dice.electro+omni", op: ">=", value: 4 }],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET },
      reason: "雷神 Q",
    }])
    const exact = plan([{
      priority: 1,
      when: [OWNER, { field: "dice.electro+omni", op: ">=", value: 3 }],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET },
      reason: "雷神 Q",
    }])
    expect(cardFaceFindings(under, ctx)[0].message).toContain("skill burst (character 1407)")
    expect(cardFaceFindings(under, ctx)[0].message).toContain("below the card cost 3雷+2充能")
    expect(cardFaceFindings(over, ctx)[0].message).toContain("above the card cost 3雷+2充能")
    expect(cardFaceFindings(exact, ctx)).toHaveLength(0)
  })

  it("useSkill：推不出 self.active.defId 持有者 → 跳过费用校核（不再把 target 当持有者）", () => {
    const p = plan([{
      priority: 1,
      when: [{ field: "dice.electro+omni", op: ">=", value: 2 }],
      then: { action_case: "useSkill", skill_type: "burst", target: RAIDEN },
      reason: "缺持有者条件",
    }])
    expect(cardFaceFindings(p, ctx)).toHaveLength(0)
  })

  it("useSkill：未知数字 target 不影响校核（target 只用于对手侧目标匹配）", () => {
    const p = plan([{
      priority: 1,
      when: [OWNER, { field: "dice.electro+omni", op: ">=", value: 2 }],
      then: { action_case: "useSkill", skill_type: "burst", target: 999999 },
      reason: "对手侧目标未知",
    }])
    const f = cardFaceFindings(p, ctx)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("skill burst (character 1407)")
  })

  it("HP 阈值超过卡面上限 → 恒假；等于上限不报", () => {
    const impossible = plan([{
      priority: 1,
      when: [{ field: "opponent.characters.1602.hp", op: ">=", value: 13 }],
      then: { action_case: "elementalTuning" },
      reason: "诺艾尔 HP13",
    }])
    const ok = plan([{
      priority: 1,
      when: [{ field: "opponent.characters.1602.hp", op: ">=", value: 12 }],
      then: { action_case: "elementalTuning" },
      reason: "诺艾尔 HP12",
    }])
    const f = cardFaceFindings(impossible, ctx)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("exceeds this character's card-face HP cap 12")
    expect(cardFaceFindings(ok, ctx)).toHaveLength(0)
  })

  it("damage_min 超过基础伤害 + 2 → 启发式；dynamic 技能跳过", () => {
    const tooHigh = plan([{
      priority: 1,
      when: [OWNER],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET, damage_min: 6 },
      reason: "雷神 Q 斩杀线",
    }])
    const headroom = plan([{
      priority: 1,
      when: [OWNER],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET, damage_min: 5 },
      reason: "雷神 Q 斩杀线",
    }])
    const dynamicSkill = plan([{
      priority: 1,
      when: [OWNER],
      then: { action_case: "useSkill", skill_type: "normal_attack", target: OPP_TARGET, damage_min: 99 },
      reason: "动态伤害技能",
    }])
    const f = cardFaceFindings(tooHigh, ctx)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("exceeds the skill's base damage 3 + 2")
    expect(f[0].message).toContain("heuristic")
    expect(cardFaceFindings(headroom, ctx)).toHaveLength(0)
    expect(cardFaceFindings(dynamicSkill, ctx)).toHaveLength(0)
  })

  it("无 ctx → 零 class-4；① ② ③ 类照常运行且 kind 正确", () => {
    const p = plan([
      { priority: 1, when: [{ field: "dice.electro+omni", op: ">=", value: 2 }], then: { action_case: "playCard", card_def_id: ELECTRO_CARD }, reason: "低闸" },
      { priority: 2, when: [{ field: "dice.electro+omni", op: ">=", value: 2 }], then: { action_case: "elementalTuning" }, reason: "完全重复" },
      { priority: 3, when: [{ field: "self.active.hp", op: ">", value: 5 }, { field: "self.active.hp", op: "<", value: 5 }], then: { action_case: "elementalTuning" }, reason: "空区间" },
    ])
    const withoutCtx = lintPlan(p)
    expect(withoutCtx.filter((f) => f.kind === "card-face")).toHaveLength(0)
    expect(withoutCtx.some((f) => f.kind === "chain")).toBe(true)
    expect(withoutCtx.some((f) => f.kind === "contradiction")).toBe(true)
    expect(lintPlan(p, ctx).filter((f) => f.kind === "card-face")).toHaveLength(1)
  })

  it("仅 cardFace 上下文即可完成费用/HP 校核（无资产数据）", () => {
    const faceOnly: PlanLintContext = {
      cardFace: stubTable([
        stubDef({ defId: ELECTRO_CARD, kind: "card", costs: [{ element: "electro", count: 3 }] }),
        stubDef({ defId: 1602, kind: "character", health: 12, skillIds: [] }),
      ]),
    }
    const p = plan([
      { priority: 1, when: [{ field: "dice.electro+omni", op: ">=", value: 4 }], then: { action_case: "playCard", card_def_id: ELECTRO_CARD }, reason: "高闸" },
      { priority: 2, when: [{ field: "self.characters.1602.hp", op: "==", value: 13 }], then: { action_case: "elementalTuning" }, reason: "HP13" },
    ])
    const f = cardFaceFindings(p, faceOnly)
    expect(f).toHaveLength(2)
    expect(f[0].message).toContain("above the card cost 3雷")
    expect(f[1].message).toContain("card-face HP cap 12")
  })

  it("角色/卡牌不可解析时跳过（存在性归 validate，lint 不重复报）", () => {
    const p = plan([
      { priority: 1, when: [{ field: "dice.electro+omni", op: ">=", value: 9 }], then: { action_case: "playCard", card_def_id: 999999 }, reason: "未知牌" },
      { priority: 2, when: [{ field: "self.active.defId", op: "==", value: 9999 }, { field: "dice.electro+omni", op: ">=", value: 9 }], then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET }, reason: "未知角色" },
      { priority: 3, when: [{ field: "opponent.characters.9999.hp", op: ">=", value: 99 }], then: { action_case: "elementalTuning" }, reason: "未知角色 HP" },
    ])
    expect(cardFaceFindings(p, ctx)).toHaveLength(0)
  })
})

describe("lintPlan 第 4 类：真实卡面事实表（本地 @gi-tcg/data 源码，零网络）", () => {
  const real: PlanLintContext = { cardFace: buildCardFaceTable() }
  const NAHIDA = 1703
  const OCEANID = 2201
  const NAHIDA_OWNER = { field: "self.active.defId", op: "==", value: NAHIDA } as const

  it("useSkill 费用腿与 damage_min 腿都会触发", () => {
    // 雷电将军爆发 14073：3雷+2充能，字面量基础伤害 3（card-face-table.test.ts 同口径）
    const p = plan([{
      priority: 1,
      when: [{ field: "self.active.defId", op: "==", value: RAIDEN }, { field: "dice.electro+omni", op: ">=", value: 2 }],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET, damage_min: 6 },
      reason: "雷神 Q 斩杀线",
    }])
    const f = cardFaceFindings(p, real)
    // 费用腿（2 < 3 雷）与 damage_min 腿（6 > 3 + 2）各一条
    expect(f.map((x) => x.message)).toEqual([
      expect.stringContaining("below the card cost 3雷+2充能"),
      expect.stringContaining("exceeds the skill's base damage 3 + 2"),
    ])
  })

  it("纳西妲双元素战技（17032 3草 / 17033 5草）：闸 5 能支付 5草 变体 → 不报 over", () => {
    const p = plan([{
      priority: 1,
      when: [NAHIDA_OWNER, { field: "dice.dendro+omni", op: ">=", value: 5 }],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET },
      reason: "所闻遍计·真如",
    }])
    expect(cardFaceFindings(p, real)).toHaveLength(0)
  })

  it("纳西妲：闸 2 连最便宜的 3草 变体都付不起 → 仍报 too-low", () => {
    const p = plan([{
      priority: 1,
      when: [NAHIDA_OWNER, { field: "dice.dendro+omni", op: ">=", value: 2 }],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET },
      reason: "所闻遍计",
    }])
    const f = cardFaceFindings(p, real)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("below the card cost 3草")
  })

  it("纳西妲：闸 6 超过最贵的 5草 变体 → 仍报 over", () => {
    const p = plan([{
      priority: 1,
      when: [NAHIDA_OWNER, { field: "dice.dendro+omni", op: ">=", value: 6 }],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET },
      reason: "所闻遍计·真如",
    }])
    const f = cardFaceFindings(p, real)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("above the card cost 5草 (1 extra)")
  })

  it("纳西妲 damage_min：任一字面量变体满足即不报；全部超出才报并列各变体 base", () => {
    const ok = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET, damage_min: 4 },
      reason: "3草变体 base 2 + 2 余量",
    }])
    expect(cardFaceFindings(ok, real)).toHaveLength(0)

    const bad = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET, damage_min: 6 },
      reason: "两个变体都超出",
    }])
    const f = cardFaceFindings(bad, real)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("exceeds every literal variant's base damage + 2 (card-face bases: 2 (skill 17032) / 3 (skill 17033))")
  })

  it("纯水精灵爆发为 dynamic 伤害：damage_min 断言总值 → 跳过该腿不报", () => {
    const p = plan([{
      priority: 1,
      when: [{ field: "self.active.defId", op: "==", value: OCEANID }],
      then: { action_case: "useSkill", skill_type: "burst", target: OPP_TARGET, damage_min: 6 },
      reason: "潮涌与激流",
    }])
    expect(cardFaceFindings(p, real)).toHaveLength(0)
  })

  it("skill_def_id 精确指名：费用腿只看该技能（闸 3 对 17033 的 5草 → too-low）", () => {
    const exact = plan([{
      priority: 1,
      when: [NAHIDA_OWNER, { field: "dice.dendro+omni", op: ">=", value: 3 }],
      then: { action_case: "useSkill", skill_type: "elemental_skill", skill_def_id: 17033, target: OPP_TARGET },
      reason: "指定所闻遍计·真如",
    }])
    const f = cardFaceFindings(exact, real)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("skill #17033 (character 1703)")
    expect(f[0].message).toContain("below the card cost 5草")
    // 不指名时闸 3 能支付 3草 变体 → 不报（最宽松口径）
    const loose = plan([{
      priority: 1,
      when: [NAHIDA_OWNER, { field: "dice.dendro+omni", op: ">=", value: 3 }],
      then: { action_case: "useSkill", skill_type: "elemental_skill", target: OPP_TARGET },
      reason: "任一元素战技",
    }])
    expect(cardFaceFindings(loose, real)).toHaveLength(0)
  })

  it("skill_def_id 精确指名：damage_min 只看该技能基础伤害", () => {
    const ok = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_def_id: 17033, target: OPP_TARGET, damage_min: 5 },
      reason: "真如 base 3 + 2 余量",
    }])
    expect(cardFaceFindings(ok, real)).toHaveLength(0)

    const bad = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_def_id: 17033, target: OPP_TARGET, damage_min: 6 },
      reason: "超出真如 base",
    }])
    const f = cardFaceFindings(bad, real)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("skill #17033 (character 1703)")
    expect(f[0].message).toContain("exceeds the skill's base damage 3 + 2")
  })

  it("skill_def_id 存在性：不属于己方任一角色的技能 → finding", () => {
    const withDeck: PlanLintContext = { cardFace: buildCardFaceTable(), deck: { characters: [NAHIDA] } }
    const p = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_def_id: 999999, target: OPP_TARGET },
      reason: "未知技能",
    }])
    const f = cardFaceFindings(p, withDeck)
    expect(f).toHaveLength(1)
    expect(f[0].message).toContain("then.skill_def_id 999999 is not a skill of any character in your deck (deck characters: 1703)")
    // 无 deck 上下文 → 跳过存在性校核（不误报）
    expect(cardFaceFindings(p, real)).toHaveLength(0)
    // 属于己方角色的技能 → 无 finding
    const ok = plan([{
      priority: 1,
      when: [NAHIDA_OWNER],
      then: { action_case: "useSkill", skill_def_id: 17033, target: OPP_TARGET },
      reason: "真如",
    }])
    expect(cardFaceFindings(ok, withDeck)).toHaveLength(0)
  })
})
