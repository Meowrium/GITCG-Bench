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
import {
  binomialTail,
  probSingleElementAtLeast,
  probElementOrOmniAtLeast,
  probHoldAtLeastOne,
  usefulProbAfterReroll,
  probUsefulAfterReroll,
  formatDicePriorMarkdown,
} from "./dice-prior.js"

describe("dice-prior: 二项尾概率", () => {
  it("已知值：8 骰指定元素/元素+万能的尾概率", () => {
    // Binomial(8, 1/8)
    expect(probSingleElementAtLeast(8, 1)).toBeCloseTo(0.6564, 3)
    expect(probSingleElementAtLeast(8, 2)).toBeCloseTo(0.2637, 3)
    expect(probSingleElementAtLeast(8, 3)).toBeCloseTo(0.0673, 3)
    // Binomial(8, 1/4)
    expect(probElementOrOmniAtLeast(8, 2)).toBeCloseTo(0.6329, 3)
    expect(probElementOrOmniAtLeast(8, 3)).toBeCloseTo(0.3215, 3)
    expect(probElementOrOmniAtLeast(8, 4)).toBeCloseTo(0.1138, 3)
  })

  it("边界：k<=0 为 1，k>n 为 0，n=0 时 k>=1 为 0", () => {
    expect(binomialTail(8, 0.25, 0)).toBe(1)
    expect(binomialTail(0, 0.25, 0)).toBe(1)
    expect(binomialTail(8, 0.25, 9)).toBe(0)
    expect(binomialTail(0, 0.25, 1)).toBe(0)
  })

  it("单调性：k 增则概率不增，n 增则概率不减", () => {
    for (let k = 1; k < 8; k++) {
      expect(probElementOrOmniAtLeast(8, k + 1)).toBeLessThanOrEqual(probElementOrOmniAtLeast(8, k))
    }
    for (let n = 1; n < 8; n++) {
      expect(probElementOrOmniAtLeast(n + 1, 3)).toBeGreaterThanOrEqual(probElementOrOmniAtLeast(n, 3))
    }
  })
})

describe("dice-prior: reroll 一次后", () => {
  it("单骰可用概率 q = p(2-p)", () => {
    expect(usefulProbAfterReroll(2)).toBeCloseTo(0.4375, 6) // 元素+万能
    expect(usefulProbAfterReroll(3)).toBeCloseTo(0.609375, 6) // 2 元素队
    expect(usefulProbAfterReroll(4)).toBeCloseTo(0.75, 6) // 3 元素队
  })

  it("reroll 后概率严格高于裸 roll", () => {
    for (let k = 1; k <= 6; k++) {
      expect(probUsefulAfterReroll(8, k, 2)).toBeGreaterThan(probElementOrOmniAtLeast(8, k))
    }
  })
})

describe("dice-prior: 超几何估牌（probHoldAtLeastOne）", () => {
  it("已知值：30 张未见牌、携带 2 张、手牌 5 → 1 − C(28,5)/C(30,5)", () => {
    // P = 1 − (25·24)/(30·29) = 1 − 600/870 ≈ 0.3103
    expect(probHoldAtLeastOne(30, 5, 2)).toBeCloseTo(0.310, 3)
    // 手牌 3：1 − (27·26)/(30·29) = 168/870 ≈ 0.1931
    expect(probHoldAtLeastOne(30, 3, 2)).toBeCloseTo(0.193, 3)
    // 手牌 1：k/U
    expect(probHoldAtLeastOne(30, 1, 1)).toBeCloseTo(1 / 30, 6)
    expect(probHoldAtLeastOne(30, 1, 2)).toBeCloseTo(2 / 30, 6)
  })

  it("边界：k<=0 或 h<=0 为 0；U−k < h 为 1（鸽笼）；k>U 钳制", () => {
    expect(probHoldAtLeastOne(30, 5, 0)).toBe(0)
    expect(probHoldAtLeastOne(30, 0, 2)).toBe(0)
    expect(probHoldAtLeastOne(0, 5, 2)).toBe(0)
    expect(probHoldAtLeastOne(10, 5, 8)).toBe(1) // 未见 10 张里藏 8 张，手牌 5 必含
    expect(probHoldAtLeastOne(30, 5, 35)).toBe(1) // k>U 按 U 钳制
  })

  it("单调性：携带数 k 增则概率不减，手牌 h 增则概率不减", () => {
    for (let k = 1; k < 4; k++) {
      expect(probHoldAtLeastOne(30, 5, k + 1)).toBeGreaterThanOrEqual(probHoldAtLeastOne(30, 5, k))
    }
    for (let h = 1; h < 8; h++) {
      expect(probHoldAtLeastOne(30, h + 1, 2)).toBeGreaterThanOrEqual(probHoldAtLeastOne(30, h, 2))
    }
  })
})

describe("dice-prior: dice_prior 模块内容", () => {
  it("markdown 含三张表且体量在模块上限（4000 字符）内", () => {
    const md = formatDicePriorMarkdown()
    expect(md).toContain("开局 8 骰")
    expect(md).toContain("reroll 一次后")
    expect(md).toContain("剩余 n 骰")
    expect(md.length).toBeLessThan(4000) // cli/modules.ts MAX_MODULE_CHARS
  })
})
