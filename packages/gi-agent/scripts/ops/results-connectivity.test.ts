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
 * results-connectivity 离线单测：连通池 / 双分量 / 孤立选手 / 逐 period 分组 /
 * pairsPlayed·pairsTotal 口径 / 空输入。纯函数零副作用。
 */

import { describe, expect, it } from "vitest"
import {
  buildPlayerGraph,
  buildPlayerGraphsByPeriod,
  formatComponents,
  type ConnectivityGame,
} from "./results-connectivity.js"

function game(p1: string, p2: string, period?: number): ConnectivityGame {
  return { p1, p2, winner: "p1", ...(period !== undefined ? { period } : {}) }
}

describe("buildPlayerGraph", () => {
  it("连通池：单分量 + pairsPlayed/pairsTotal", () => {
    const g = buildPlayerGraph([game("a", "b"), game("b", "c")])
    expect(g.components).toEqual([["a", "b", "c"]])
    expect(g.componentCount).toBe(1)
    expect(g.isolatedPlayers).toEqual([])
    expect(g.pairsPlayed).toBe(2)
    expect(g.pairsTotal).toBe(3)
  })

  it("双分量：各自列出选手（分量按首元素升序、分量内升序）", () => {
    const g = buildPlayerGraph([game("b", "a"), game("d", "c")])
    expect(g.components).toEqual([["a", "b"], ["c", "d"]])
    expect(g.componentCount).toBe(2)
    expect(g.pairsPlayed).toBe(2)
    expect(g.pairsTotal).toBe(6)
    expect(g.isolatedPlayers).toEqual([])
  })

  it("孤立选手：仅出现在自对局（p1===p2）里的选手单成分、计入 isolatedPlayers", () => {
    const g = buildPlayerGraph([game("a", "b"), game("solo", "solo")])
    expect(g.components).toEqual([["a", "b"], ["solo"]])
    expect(g.componentCount).toBe(2)
    expect(g.isolatedPlayers).toEqual(["solo"])
    expect(g.pairsPlayed).toBe(1) // 自对局不算一对
    expect(g.pairsTotal).toBe(3)
  })

  it("重复对局只计一对；正反手/双向写法同键", () => {
    const g = buildPlayerGraph([game("a", "b"), game("b", "a"), game("a", "b")])
    expect(g.components).toEqual([["a", "b"]])
    expect(g.pairsPlayed).toBe(1)
    expect(g.pairsTotal).toBe(1)
  })

  it("空输入：零分量零对数", () => {
    expect(buildPlayerGraph([])).toEqual({
      components: [],
      componentCount: 0,
      isolatedPlayers: [],
      pairsPlayed: 0,
      pairsTotal: 0,
    })
  })
})

describe("buildPlayerGraphsByPeriod", () => {
  it("逐 period 分组（升序）；期内图只含该期对局", () => {
    const graphs = buildPlayerGraphsByPeriod([
      game("a", "b", 1),
      game("c", "d", 0),
      game("a", "b", 0),
    ])
    expect(graphs.map((g) => g.period)).toEqual([0, 1])
    expect(graphs[0]!.components).toEqual([["a", "b"], ["c", "d"]]) // 期内断连
    expect(graphs[0]!.componentCount).toBe(2)
    expect(graphs[0]!.pairsPlayed).toBe(2)
    expect(graphs[0]!.pairsTotal).toBe(6)
    expect(graphs[1]!.components).toEqual([["a", "b"]])
    expect(graphs[1]!.componentCount).toBe(1)
    expect(graphs[1]!.pairsPlayed).toBe(1)
    expect(graphs[1]!.pairsTotal).toBe(1)
  })

  it("缺省 period = 0（与 tree-bench 一致）", () => {
    const graphs = buildPlayerGraphsByPeriod([game("a", "b"), game("b", "c", 2)])
    expect(graphs.map((g) => g.period)).toEqual([0, 2])
    expect(graphs[0]!.components).toEqual([["a", "b"]])
    expect(graphs[1]!.components).toEqual([["b", "c"]])
  })

  it("空输入：空数组", () => {
    expect(buildPlayerGraphsByPeriod([])).toEqual([])
  })
})

describe("formatComponents", () => {
  it("分量单行文本", () => {
    expect(formatComponents([["a", "b"], ["c"]])).toBe("{a, b}  {c}")
  })
})
