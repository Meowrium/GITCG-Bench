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
 * 卡面事实表测试：对真实 @gi-tcg/data 源文件的解析断言（费用/HP/伤害/版本覆盖/dynamic）。
 */

import { describe, expect, it } from "vitest"
import { buildCardFaceTable } from "./card-face-table.js"

describe("buildCardFaceTable（真实数据源）", () => {
  const table = buildCardFaceTable()

  it("角色卡面：雷电将军 1407 health(10)/energy(2)/since v3.7.0", () => {
    const raiden = table.get(1407)
    expect(raiden?.kind).toBe("character")
    expect(raiden?.health).toBe(10)
    expect(raiden?.energy).toBe(2)
    expect(raiden?.since).toBe("v3.7.0")
  })

  it("技能卡面：奥义·梦想真说 14073 burst / 3雷+2充能 / 3雷伤", () => {
    const burst = table.get(14073)
    expect(burst?.kind).toBe("skill")
    expect(burst?.skillType).toBe("burst")
    expect(burst?.costs).toEqual([
      { element: "electro", count: 3 },
      { element: "energy", count: 2 },
    ])
    expect(burst?.damage[0]).toEqual({ type: "Electro", value: 3 })
    expect(burst?.dynamic).toBe(false)
  })

  it("角色 → 技能按类型解析（.skills(...) 句柄）", () => {
    expect(table.skillsOf(1407).map((d) => d.defId)).toContain(14073)
    expect(table.skillOfType(1407, "burst")?.defId).toBe(14073)
    expect(table.skillOfType(1407, "normal")?.defId).toBe(14071)
    expect(table.skillOfType(1407, "elemental")?.defId).toBe(14072)
  })

  it("行动牌费用：万千的愿望 214071 = 3雷+2充能", () => {
    const card = table.get(214071)
    expect(card?.kind).toBe("card")
    expect(card?.costs).toEqual([
      { element: "electro", count: 3 },
      { element: "energy", count: 2 },
    ])
  })

  it("版本变体：诺艾尔 1602 latest=12，v5.4.0 旧版覆盖=10，v5.5.0 起=12", () => {
    expect(table.get(1602)?.health).toBe(12)
    expect(buildCardFaceTable({ gameVersion: "v5.4.0" }).get(1602)?.health).toBe(10)
    expect(buildCardFaceTable({ gameVersion: "v5.5.0" }).get(1602)?.health).toBe(12)
  })

  it("since 门：v3.3.0 下看不到 v3.7.0 引入的雷电将军；诺艾尔旧版覆盖 10", () => {
    const old = buildCardFaceTable({ gameVersion: "v3.3.0" })
    expect(old.get(1407)).toBeUndefined()
    expect(old.get(1602)?.health).toBe(10)
  })

  it("动态伤害：积木小人 301028 的 .do 闭包伤害标 dynamic 且无字面量伤害", () => {
    const toy = table.get(301028)
    expect(toy?.kind).toBe("summon")
    expect(toy?.dynamic).toBe(true)
    expect(toy?.damage).toEqual([])
    expect(toy?.heal).toEqual([])
    expect(toy?.usage).toBe(2)
  })

  it("字面量治疗：诸愿百眼之轮 114072 的 .do increaseDamage 标 dynamic", () => {
    const status = table.get(114072)
    expect(status?.kind).toBe("status")
    expect(status?.dynamic).toBe(true)
  })

  it("endPhaseDamage(DamageType.Heal, N) 归入治疗而非伤害", () => {
    const melody = table.get(112011)
    expect(melody?.kind).toBe("summon")
    expect(melody?.damage).toEqual([])
    expect(melody?.heal).toEqual([1])
    expect(melody?.dynamic).toBe(false)
  })

  it("同 id 跨类别：2602 同时是 extension 与若陀龙王（get 取角色）", () => {
    const azhdaha = table.get(2602)
    expect(azhdaha?.kind).toBe("character")
    expect(table.skillsOf(2602).length).toBeGreaterThan(0)
  })

  it("目录不可读时返回空表（不抛错）", () => {
    const empty = buildCardFaceTable({ dataSrcDir: "D:/definitely/not/a/real/dir" })
    expect(empty.size).toBe(0)
    expect(empty.get(1407)).toBeUndefined()
    expect(empty.baseDamageOf(14073)).toBeUndefined()
  })
})
