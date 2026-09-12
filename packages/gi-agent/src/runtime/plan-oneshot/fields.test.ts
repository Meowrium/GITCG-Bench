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
import { isKnownPlanField, resolvePlanField, type PlanFieldContext, type PbViewState } from "./fields.js"

function ctxWithSatiety(entityDefIds: number[]): PlanFieldContext {
  const state = {
    roundNumber: 3,
    currentTurn: 0,
    player: [
      {
        activeCharacterId: -500000,
        character: [
          {
            id: -500000,
            definitionId: 1602,
            health: 5,
            energy: 1,
            maxEnergy: 2,
            aura: 0,
            defeated: false,
            entity: entityDefIds.map((definitionId, i) => ({ id: -100 - i, definitionId })),
          },
        ],
        dice: [],
        handCard: [],
        summon: [],
        support: [],
        declaredEnd: false,
      },
      {
        character: [],
        dice: [0, 0, 0, 0],
        handCard: [{}, {}, {}],
        summon: [],
        support: [],
        declaredEnd: true,
      },
    ],
  } as unknown as PbViewState
  return { state, side: 0, phaseId: null, actionsTakenThisTurn: 1, gameData: {} as PlanFieldContext["gameData"] }
}

describe("plan field: satied（饱腹）", () => {
  it("白名单接受 active/characters 的 satied，拒绝未知拼法", () => {
    expect(isKnownPlanField("self.active.satied")).toBe(true)
    expect(isKnownPlanField("self.characters.1602.satied")).toBe(true)
    expect(isKnownPlanField("opponent.characters.1309.satied")).toBe(true)
    expect(isKnownPlanField("self.characters.1602.satiated")).toBe(false)
  })

  it("角色身上有 303300（饱腹）状态时为 true", () => {
    const ctx = ctxWithSatiety([303300])
    expect(resolvePlanField("self.characters.1602.satied", ctx)).toBe(true)
    expect(resolvePlanField("self.active.satied", ctx)).toBe(true)
  })

  it("无状态或仅有其他状态时为 false（本回合还能吃）", () => {
    expect(resolvePlanField("self.characters.1602.satied", ctxWithSatiety([]))).toBe(false)
    expect(resolvePlanField("self.characters.1602.satied", ctxWithSatiety([311305]))).toBe(false)
  })

  it("对手节奏事实：declaredEnd / 骰数 / 手牌数（内容脱敏）", () => {
    expect(isKnownPlanField("opponent.declaredEnd")).toBe(true)
    expect(isKnownPlanField("self.declaredEnd")).toBe(true)
    expect(isKnownPlanField("opponent.dice.total")).toBe(true)
    expect(isKnownPlanField("opponent.hand.count")).toBe(true)
    const ctx = ctxWithSatiety([])
    expect(resolvePlanField("opponent.declaredEnd", ctx)).toBe(true)
    expect(resolvePlanField("self.declaredEnd", ctx)).toBe(false)
    expect(resolvePlanField("opponent.dice.total", ctx)).toBe(4)
    expect(resolvePlanField("opponent.hand.count", ctx)).toBe(3)
  })

  it("dice.<元素>+omni：万能可抵的元素支付能力", () => {
    expect(isKnownPlanField("dice.geo+omni")).toBe(true)
    expect(isKnownPlanField("dice.pyro+omni")).toBe(true)
    expect(isKnownPlanField("dice.geo+dice.omni")).toBe(false)
    // state: 2 geo + 5 omni（r4 反思发现的 geo0/omni5 局面）
    const ctx = ctxWithSatiety([])
    ctx.state.player[0].dice = [6, 6, 8, 8, 8, 8, 8]
    expect(resolvePlanField("dice.geo", ctx)).toBe(2)
    expect(resolvePlanField("dice.omni", ctx)).toBe(5)
    expect(resolvePlanField("dice.geo+omni", ctx)).toBe(7)
  })

  it("opp.threat.* 白名单与降级（无 GameData 时 undefined 恒假）", () => {
    expect(isKnownPlanField("opp.threat.maxDamage")).toBe(true)
    expect(isKnownPlanField("opp.threat.lethal")).toBe(true)
    expect(isKnownPlanField("opp.threat.burstReady")).toBe(true)
    expect(isKnownPlanField("opp.threat.burstP")).toBe(true)
    expect(isKnownPlanField("opp.threat.maxDamageAfterSwitch")).toBe(true)
    expect(isKnownPlanField("opp.threat.foo")).toBe(false)
    expect(isKnownPlanField("opponent.threat.maxDamage")).toBe(false)
    // gameData 为空对象（无 characters）：对手出战角色查不到画像 → undefined
    const ctx = ctxWithSatiety([])
    ctx.state.player[1].activeCharacterId = -1
    ctx.state.player[1].character = [
      { id: -1, definitionId: 1602, health: 10, energy: 2, maxEnergy: 2, aura: 0, defeated: false, entity: [] },
    ] as unknown as PbViewState["player"][number]["character"]
    expect(resolvePlanField("opp.threat.maxDamage", ctx)).toBeUndefined()
    expect(resolvePlanField("opp.threat.burstReady", ctx)).toBeUndefined()
  })

  it("opp.hand.hasCardP.<defId>：明牌先验的超几何估牌", () => {
    // 白名单
    expect(isKnownPlanField("opp.hand.hasCardP.332001")).toBe(true)
    expect(isKnownPlanField("opp.hand.hasCardP.foo")).toBe(false)
    expect(isKnownPlanField("opponent.hand.hasCardP.332001")).toBe(false)
    expect(isKnownPlanField("opp.hand.hasCard.332001")).toBe(false)

    const ctx = ctxWithSatiety([])
    // 对手：手牌 3 + 牌库 27 = 未见 30；该卡携带 2 张 → P = 1 − C(28,3)/C(30,3) ≈ 0.193
    ctx.state.player[1].pileCard = Array(27).fill({}) as never
    ctx.opponentDeckCards = new Map([[332001, 2]])
    expect(resolvePlanField("opp.hand.hasCardP.332001", ctx)).toBeCloseTo(0.193, 3)

    // 牌库字段缺失时按 0 计：U = h = 3，k = 2 → U−k = 1 < h → 鸽笼必含
    const ctxNoPile = ctxWithSatiety([])
    ctxNoPile.opponentDeckCards = new Map([[332001, 2]])
    expect(resolvePlanField("opp.hand.hasCardP.332001", ctxNoPile)).toBe(1)

    // 卡不在对手牌表 → undefined（条件恒假）；未注入牌表 → undefined
    expect(resolvePlanField("opp.hand.hasCardP.300000", ctx)).toBeUndefined()
    expect(resolvePlanField("opp.hand.hasCardP.332001", ctxWithSatiety([]))).toBeUndefined()
  })
})

describe("plan field: characters.<defId>.aura（后台角色附着）", () => {
  it("白名单接受 self/opponent.characters.<defId>.aura，拒绝未知拼法", () => {
    expect(isKnownPlanField("self.characters.1602.aura")).toBe(true)
    expect(isKnownPlanField("opponent.characters.1309.aura")).toBe(true)
    expect(isKnownPlanField("self.characters.1602.aura2")).toBe(false)
    expect(isKnownPlanField("self.characters.1602.aural")).toBe(false)
  })

  it("后台角色 aura 求值：0 → none，3 → pyro（与 active.aura 同口径）", () => {
    const ctx = ctxWithSatiety([])
    expect(resolvePlanField("self.characters.1602.aura", ctx)).toBe("none")
    ;(ctx.state.player[0].character[0] as { aura: number }).aura = 3
    expect(resolvePlanField("self.characters.1602.aura", ctx)).toBe("pyro")
  })
})
