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
 * deck-detail 渲染单测：技能行带 `#<skill defId>`（同类型多变体各自指名），
 * 名字对不上时退化渲染不误配（纯函数，零网络）。
 */

import { describe, expect, it } from "vitest"
import type { GameData } from "@gi-tcg/core"
import { renderDeckDetail, type DeckDetailContext } from "./deck-detail.js"

const gameData = { entities: new Map() } as unknown as GameData

function nahidaCtx(): DeckDetailContext {
  return {
    characterFullInfo: [{
      id: 1703,
      name: "纳西妲",
      elements: ["dendro"],
      weapon: "catalyst",
      nations: ["sumeru"],
      hp: 10,
      maxEnergy: 3,
      skills: [
        { name: "行相", type: "普通攻击", description: "造成1点草元素伤害。", playCost: [{ type: "GCG_COST_DICE_DENDRO", count: 1 }, { type: "GCG_COST_DICE_VOID", count: 2 }], hidden: false },
        { name: "所闻遍计", type: "元素战技", description: "造成2点草元素伤害。", playCost: [{ type: "GCG_COST_DICE_DENDRO", count: 3 }], hidden: false },
        { name: "所闻遍计·真如", type: "元素战技", description: "造成3点草元素伤害。", playCost: [{ type: "GCG_COST_DICE_DENDRO", count: 5 }], hidden: false },
      ],
    }],
    cards: [],
    entityDescriptions: new Map(),
    generatedHandCardDescriptions: new Map(),
  }
}

const SKILL_IDS = new Map<string, number>([
  ["行相", 17031],
  ["所闻遍计", 17032],
  ["所闻遍计·真如", 17033],
])

describe("renderDeckDetail", () => {
  it("技能行渲染 `#<defId>`：同类型多变体各自指名", () => {
    const out = renderDeckDetail(nahidaCtx(), gameData, () => SKILL_IDS)
    expect(out).toContain('    - normal_attack #17031 "行相" cost 1草+2无色:')
    expect(out).toContain('    - elemental_skill #17032 "所闻遍计" cost 3草:')
    expect(out).toContain('    - elemental_skill #17033 "所闻遍计·真如" cost 5草:')
  })

  it("名字对不上（id 表缺项）时退化渲染不带 id，不误配", () => {
    const out = renderDeckDetail(nahidaCtx(), gameData, () => new Map([["行相", 17031]]))
    expect(out).toContain('    - elemental_skill "所闻遍计" cost 3草:')
    expect(out).not.toContain("#17032")
    expect(out).not.toContain("#17033")
  })
})
