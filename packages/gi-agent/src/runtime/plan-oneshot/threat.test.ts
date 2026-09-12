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

import { describe, expect, it } from "vitest"
import type { GameData } from "@gi-tcg/core"
import type { SourceDamageInfo } from "../../knowledge/character-profiles/source-parser.js"
import {
  reactionBonusOnMainTarget,
  buildThreatProfile,
  resolveThreatField,
  loadSkillDamageMap,
} from "./threat.js"
import type { PbViewState } from "./fields.js"

type PbViewPlayer = PbViewState["player"][number]

// ── 假数据：1602 诺艾尔（geo，出战）/ 1605 一斗（geo，后台） ────────────

const fakeGameData = {
  characters: new Map([
    [1602, {
      id: 1602,
      skills: [
        // 普攻：1 岩 + 2 无色，物理 2
        { id: 16021, skillType: "normal", initiativeSkillConfig: { requiredCost: new Map([[6, 1], [0, 2]]) } },
        // 战技：3 岩，岩伤 3
        { id: 16022, skillType: "elemental", initiativeSkillConfig: { requiredCost: new Map([[6, 3]]) } },
        // 爆发：4 岩 + 2 能量，岩伤 4 + 附加 1
        { id: 16023, skillType: "burst", initiativeSkillConfig: { requiredCost: new Map([[6, 4], [9, 2]]) } },
      ],
    }],
    [1605, {
      id: 1605,
      skills: [
        // 战技：3 岩，岩伤 6（后台高威胁）
        { id: 16052, skillType: "elemental", initiativeSkillConfig: { requiredCost: new Map([[6, 3]]) } },
      ],
    }],
  ]),
} as unknown as GameData

const fakeDamageMap = new Map<number, SourceDamageInfo>([
  [16021, { mainDamageType: 0, mainDamageValue: 2, additionalDamage: [], createsSummon: false, createsStatus: false }],
  [16022, { mainDamageType: 6, mainDamageValue: 3, additionalDamage: [], createsSummon: false, createsStatus: false }],
  [16023, { mainDamageType: 6, mainDamageValue: 4, additionalDamage: [{ type: 0, value: 1 }], createsSummon: false, createsStatus: false }],
  [16052, { mainDamageType: 6, mainDamageValue: 6, additionalDamage: [], createsSummon: false, createsStatus: false }],
])

function makeSelf(overrides: {
  activeHp?: number
  activeAura?: number
  activeShield?: number
  combatShield?: number
}): PbViewPlayer {
  return {
    activeCharacterId: -100,
    character: [
      {
        id: -100,
        definitionId: 1701,
        health: overrides.activeHp ?? 10,
        energy: 0,
        maxEnergy: 2,
        aura: overrides.activeAura ?? 0,
        defeated: false,
        entity: overrides.activeShield
          ? [{ id: -1, definitionId: 301001, shield: overrides.activeShield }]
          : [],
      },
    ],
    combatStatus: overrides.combatShield
      ? [{ id: -2, definitionId: 301011, shield: overrides.combatShield }]
      : [],
    dice: [],
    handCard: [],
    summon: [],
    support: [],
    declaredEnd: false,
  } as unknown as PbViewPlayer
}

function makeOpponent(overrides: {
  activeEnergy?: number
  activeDefId?: number
  diceTotal?: number
  benchedAlive?: boolean
}): PbViewPlayer {
  return {
    activeCharacterId: -200,
    character: [
      {
        id: -200,
        definitionId: overrides.activeDefId ?? 1602,
        health: 10,
        energy: overrides.activeEnergy ?? 0,
        maxEnergy: 2,
        aura: 0,
        defeated: false,
        entity: [],
      },
      {
        id: -201,
        definitionId: 1605,
        health: 10,
        energy: 0,
        maxEnergy: 3,
        aura: 0,
        defeated: !(overrides.benchedAlive ?? true),
        entity: [],
      },
    ],
    combatStatus: [],
    dice: Array(overrides.diceTotal ?? 8).fill(0), // 牌面脱敏
    handCard: [],
    summon: [],
    support: [],
    declaredEnd: false,
  } as unknown as PbViewPlayer
}

function threat(name: string, self: PbViewPlayer, opponent: PbViewPlayer) {
  return resolveThreatField(name, self, opponent, fakeGameData, fakeDamageMap)
}

describe("threat: 反应加成表（转写自 core base/reaction.ts + base/skill.ts）", () => {
  it("融化/蒸发/超载 +2，超导/结晶/绽放等 +1，扩散主目标与无反应 0", () => {
    expect(reactionBonusOnMainTarget(1, 3)).toBe(2) // 火打冰附着：融化
    expect(reactionBonusOnMainTarget(2, 3)).toBe(2) // 火打水附着：蒸发
    expect(reactionBonusOnMainTarget(4, 3)).toBe(2) // 火打雷附着：超载
    expect(reactionBonusOnMainTarget(1, 4)).toBe(1) // 雷打冰附着：超导
    expect(reactionBonusOnMainTarget(2, 6)).toBe(1) // 岩打水附着：结晶
    expect(reactionBonusOnMainTarget(7, 2)).toBe(1) // 水打草附着：绽放
    expect(reactionBonusOnMainTarget(3, 5)).toBe(0) // 风打火附着：扩散主目标不加
    expect(reactionBonusOnMainTarget(0, 3)).toBe(0) // 无附着
    expect(reactionBonusOnMainTarget(3, 0)).toBe(0) // 物理无反应
    expect(reactionBonusOnMainTarget(7, 1)).toBe(0) // 冰打草附着：无反应（冰草共存）
    expect(reactionBonusOnMainTarget(113, 3)).toBe(2) // 火打冰草复合附着：融化
  })
})

describe("threat: buildThreatProfile", () => {
  it("成本拆分为元素/总数/能量，伤害含 additionalDamage 上界", () => {
    const p = buildThreatProfile(fakeGameData, fakeDamageMap, 1602)
    expect(p).toBeDefined()
    const burst = p!.find((s) => s.skillType === "burst")!
    expect(burst.elementDice).toBe(4)
    expect(burst.totalDice).toBe(4)
    expect(burst.energyCost).toBe(2)
    expect(burst.damage).toBe(5) // 4 + 1 附加
    const normal = p!.find((s) => s.skillType === "normal")!
    expect(normal.totalDice).toBe(3) // 1 元素 + 2 无色
    expect(normal.elementDice).toBe(1)
  })

  it("角色不在 GameData 中时返回 undefined", () => {
    expect(buildThreatProfile(fakeGameData, fakeDamageMap, 9999)).toBeUndefined()
  })
})

describe("threat: opp.threat.* 字段求值", () => {
  it("maxDamage：可支付技能中取最大（含反应加成）", () => {
    // 8 骰全可用上界：爆发 5 可付（4 费 + 能量 2）
    expect(threat("maxDamage", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(5)
    // 3 骰：爆发（4 费）付不起，战技 3 为最大
    expect(threat("maxDamage", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 3 }))).toBe(3)
    // 能量不满：爆发被排除
    expect(threat("maxDamage", makeSelf({}), makeOpponent({ activeEnergy: 1, diceTotal: 8 }))).toBe(3)
    // 我方出战带冰附着：岩伤触发结晶 +1
    expect(threat("maxDamage", makeSelf({ activeAura: 1 }), makeOpponent({ activeEnergy: 2, diceTotal: 3 }))).toBe(4)
  })

  it("lethal：maxDamage ≥ HP + 可见护盾（角色实体 + 战斗状态）", () => {
    expect(threat("lethal", makeSelf({ activeHp: 5 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(true)
    expect(threat("lethal", makeSelf({ activeHp: 6 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(false)
    // 护盾计入：5 血 + 1 盾 = 6 > 5 伤害
    expect(threat("lethal", makeSelf({ activeHp: 5, activeShield: 1 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(false)
    // 战斗状态里的护盾（结晶盾）同样计入
    expect(threat("lethal", makeSelf({ activeHp: 5, combatShield: 1 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(false)
  })

  it("burstReady：能量满且骰数够爆发费", () => {
    expect(threat("burstReady", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 4 }))).toBe(true)
    expect(threat("burstReady", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 3 }))).toBe(false)
    expect(threat("burstReady", makeSelf({}), makeOpponent({ activeEnergy: 1, diceTotal: 8 }))).toBe(false)
  })

  it("burstP：骰面隐藏时的支付概率（元素+万能二项尾）", () => {
    // 8 骰付 4 元素费：P(Binom(8, 1/4) >= 4) ≈ 0.114
    expect(threat("burstP", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBeCloseTo(0.114, 2)
    // 4 骰付 4 元素费：全中元素/万能 0.25^4 ≈ 0.004
    expect(threat("burstP", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 4 }))).toBeCloseTo(0.004, 3)
    // 骰数低于总费用或能量不满 → 0
    expect(threat("burstP", makeSelf({}), makeOpponent({ activeEnergy: 2, diceTotal: 3 }))).toBe(0)
    expect(threat("burstP", makeSelf({}), makeOpponent({ activeEnergy: 1, diceTotal: 8 }))).toBe(0)
  })

  it("maxDamageAfterSwitch：切人（1 骰）+ 技能两动上界，取后台最大值", () => {
    // 8 骰 → 预算 7：一斗战技 6 伤可付
    expect(threat("maxDamageAfterSwitch", makeSelf({}), makeOpponent({ activeEnergy: 0, diceTotal: 8 }))).toBe(6)
    // 3 骰 → 预算 2：一斗 3 费战技付不起
    expect(threat("maxDamageAfterSwitch", makeSelf({}), makeOpponent({ activeEnergy: 0, diceTotal: 3 }))).toBe(0)
    // 后台全灭 → 0
    expect(threat("maxDamageAfterSwitch", makeSelf({}), makeOpponent({ activeEnergy: 0, diceTotal: 8, benchedAlive: false }))).toBe(0)
  })

  it("lethalP：达标斩杀技能的骰子支付概率取最大（同 burstP 口径）", () => {
    // hp5：仅爆发 5 伤达标（4 岩费，8 骰）→ P(Binom(8, 1/4) >= 4) ≈ 0.114
    expect(threat("lethalP", makeSelf({ activeHp: 5 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBeCloseTo(0.114, 2)
    // hp3：战技 3 伤也达标（3 岩费 ≈ 0.321），与爆发（≈ 0.114）取最大
    expect(threat("lethalP", makeSelf({ activeHp: 3 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBeCloseTo(0.321, 3)
    // 无达标技能 → 0（不是 undefined）
    expect(threat("lethalP", makeSelf({ activeHp: 10 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(0)
    // 能量不足：爆发被排除，战技 3 < 5 → 0
    expect(threat("lethalP", makeSelf({ activeHp: 5 }), makeOpponent({ activeEnergy: 1, diceTotal: 8 }))).toBe(0)
    // 护盾计入斩杀线：5 血 + 1 盾 = 6 > 爆发 5 → 0
    expect(threat("lethalP", makeSelf({ activeHp: 5, activeShield: 1 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBe(0)
    // 反应加成入斩杀线：hp4 + 冰附着 → 战技 3+结晶1=4 达标
    expect(threat("lethalP", makeSelf({ activeHp: 4, activeAura: 1 }), makeOpponent({ activeEnergy: 2, diceTotal: 8 }))).toBeCloseTo(0.321, 3)
    // 骰数不足总费用 → 0（爆发 4 费 > 3 骰）
    expect(threat("lethalP", makeSelf({ activeHp: 5 }), makeOpponent({ activeEnergy: 2, diceTotal: 3 }))).toBe(0)
  })

  it("降级：伤害表为空时伤害类字段 undefined，费用类字段仍可用", () => {
    const empty = new Map<number, SourceDamageInfo>()
    const self = makeSelf({})
    const opp = makeOpponent({ activeEnergy: 2, diceTotal: 8 })
    expect(resolveThreatField("maxDamage", self, opp, fakeGameData, empty)).toBeUndefined()
    expect(resolveThreatField("lethal", self, opp, fakeGameData, empty)).toBeUndefined()
    expect(resolveThreatField("lethalP", self, opp, fakeGameData, empty)).toBeUndefined()
    expect(resolveThreatField("burstReady", self, opp, fakeGameData, empty)).toBe(true)
    expect(resolveThreatField("burstP", self, opp, fakeGameData, empty)).toBeCloseTo(0.114, 2)
  })

  it("未知字段名与缺失角色 → undefined", () => {
    expect(threat("foo", makeSelf({}), makeOpponent({}))).toBeUndefined()
    const noChar = { ...makeOpponent({}), character: [] } as unknown as PbViewPlayer
    expect(threat("maxDamage", makeSelf({}), noChar)).toBeUndefined()
  })
})

describe("threat: 源码伤害表懒加载（真实 @gi-tcg/data 源码）", () => {
  it("能解析出非空伤害表（repo 内运行）", () => {
    const map = loadSkillDamageMap()
    expect(map.size).toBeGreaterThan(100)
    // 抽查：诺艾尔战技 16022 存在且伤害为数字
    const noelle = map.get(16022)
    expect(noelle).toBeDefined()
    expect(typeof noelle!.mainDamageValue).toBe("number")
  })
})

describe("threat: 真实 GameData 集成（回归：skillType 在技能顶层而非 initiativeSkillConfig 内）", () => {
  it("buildThreatProfile 对真实角色产出非空画像，且 burstP 链路可用", async () => {
    const { default: getData } = await import("@gi-tcg/data")
    const gd = getData() as unknown as GameData
    const map = loadSkillDamageMap()
    // 一斗 1605：普攻/战技/爆发三技能都应入画像（roundT2 全零根因的回归钉）
    const p = buildThreatProfile(gd, map, 1605)
    expect(p).toBeDefined()
    expect(p!.length).toBeGreaterThanOrEqual(3)
    expect(p!.some((s) => s.skillType === "burst")).toBe(true)
    // 战技直伤低（真实伤害在召唤物），普攻上界 5：满骰时 maxDamage 应 > 0（回归值 = 0）
    const self = makeSelf({})
    const opp = makeOpponent({ activeDefId: 1605, activeEnergy: 0, diceTotal: 8 })
    expect(resolveThreatField("maxDamage", self, opp, gd, map)).toBeGreaterThan(0)
    // 能量满 + 8 骰：burstReady=true、burstP>0
    const oppFull = makeOpponent({ activeDefId: 1605, activeEnergy: 3, diceTotal: 8 })
    expect(resolveThreatField("burstReady", self, oppFull, gd, map)).toBe(true)
    expect(resolveThreatField("burstP", self, oppFull, gd, map)).toBeGreaterThan(0)
  }, 20000) // 导入完整 data 包 + 全量源码伤害表解析，默认 5s 超时在负载下不够
})
