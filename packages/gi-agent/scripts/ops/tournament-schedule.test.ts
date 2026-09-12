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
 * tournament-schedule 离线单测：默认赛程与旧 model-tournament 内联循环逐元素一致
 * （手算期望全表）+ 赛程扩展维度（crossGeneration="vs-previous"、chainGap>1）+
 * roundFilter/多环境顺序契约。零依赖零副作用。
 */

import { describe, expect, it } from "vitest"
import { enumerateSchedule, type BatchSpec, type ScheduleInput } from "./tournament-schedule.js"

// ── fixture ──────────────────────────────────────────────────────────────

const ENV = "v6.3"

function inputOf(over: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    models: ["A", "B"],
    envs: [{ label: ENV, deckCount: 2 }],
    rounds: 1,
    ...over,
  }
}

/** 紧凑序列化（断言用）：一行 = 一个批的全部赛程坐标 */
function line(s: BatchSpec): string {
  return `r${s.round}|${s.envLabel}|${s.planModel}@r${s.planRound}|${s.oppModel}@r${s.oppRound}|${s.di}-vs-${s.dj}|${s.isChain ? "chain" : "matrix"}`
}

/** 手算期望：M=2（A,B）× D=2 × r0..r1 的现行赛程（同代矩阵 → 链批，env 外层/代升序） */
const EXPECTED_DEFAULT: string[] = [
  // r0 同代矩阵（A→B 4 格 + B→A 4 格；无链批）
  `r0|${ENV}|A@r0|B@r0|0-vs-0|matrix`,
  `r0|${ENV}|A@r0|B@r0|0-vs-1|matrix`,
  `r0|${ENV}|A@r0|B@r0|1-vs-0|matrix`,
  `r0|${ENV}|A@r0|B@r0|1-vs-1|matrix`,
  `r0|${ENV}|B@r0|A@r0|0-vs-0|matrix`,
  `r0|${ENV}|B@r0|A@r0|0-vs-1|matrix`,
  `r0|${ENV}|B@r0|A@r0|1-vs-0|matrix`,
  `r0|${ENV}|B@r0|A@r0|1-vs-1|matrix`,
  // r1 同代矩阵
  `r1|${ENV}|A@r1|B@r1|0-vs-0|matrix`,
  `r1|${ENV}|A@r1|B@r1|0-vs-1|matrix`,
  `r1|${ENV}|A@r1|B@r1|1-vs-0|matrix`,
  `r1|${ENV}|A@r1|B@r1|1-vs-1|matrix`,
  `r1|${ENV}|B@r1|A@r1|0-vs-0|matrix`,
  `r1|${ENV}|B@r1|A@r1|0-vs-1|matrix`,
  `r1|${ENV}|B@r1|A@r1|1-vs-0|matrix`,
  `r1|${ENV}|B@r1|A@r1|1-vs-1|matrix`,
  // r1 同模型链批（X@r1 vs X@r0，全格对）
  `r1|${ENV}|A@r1|A@r0|0-vs-0|chain`,
  `r1|${ENV}|A@r1|A@r0|0-vs-1|chain`,
  `r1|${ENV}|A@r1|A@r0|1-vs-0|chain`,
  `r1|${ENV}|A@r1|A@r0|1-vs-1|chain`,
  `r1|${ENV}|B@r1|B@r0|0-vs-0|chain`,
  `r1|${ENV}|B@r1|B@r0|0-vs-1|chain`,
  `r1|${ENV}|B@r1|B@r0|1-vs-0|chain`,
  `r1|${ENV}|B@r1|B@r0|1-vs-1|chain`,
]

// ── 默认赛程（行为保持）──────────────────────────────────────────────────

describe("enumerateSchedule 默认赛程", () => {
  it("无 schedule：输出与旧内联循环逐元素一致（手算全表）", () => {
    const specs = enumerateSchedule(inputOf())
    expect(specs.map(line)).toEqual(EXPECTED_DEFAULT)
    // 关键字段抽查（顺序之外的字段完整性）
    const first = specs[0]!
    expect(first).toEqual({
      round: 0, envLabel: ENV,
      planModel: "A", planRound: 0, di: 0,
      oppModel: "B", oppRound: 0, dj: 0,
      isChain: false,
    })
    const chain = specs.find((s) => s.isChain)!
    expect(chain).toEqual({
      round: 1, envLabel: ENV,
      planModel: "A", planRound: 1, di: 0,
      oppModel: "A", oppRound: 0, dj: 0,
      isChain: true,
    })
  })

  it("显式缺省值（crossGeneration=\"none\" + chainGap=1）等价于无 schedule", () => {
    const explicit = enumerateSchedule(inputOf({ schedule: { crossGeneration: "none", chainGap: 1 } }))
    expect(explicit.map(line)).toEqual(EXPECTED_DEFAULT)
  })

  it("r0 无链批；roundFilter 只枚举该代", () => {
    expect(enumerateSchedule(inputOf({ roundFilter: 0 })).map(line)).toEqual(EXPECTED_DEFAULT.slice(0, 8))
    expect(enumerateSchedule(inputOf({ roundFilter: 1 })).map(line)).toEqual(EXPECTED_DEFAULT.slice(8))
  })

  it("多环境：env 为最外层循环", () => {
    const specs = enumerateSchedule(inputOf({
      envs: [{ label: "v6.3", deckCount: 2 }, { label: "v4.0", deckCount: 1 }],
    }))
    expect(specs.slice(0, 24).every((s) => s.envLabel === "v6.3")).toBe(true)
    expect(specs.slice(24).every((s) => s.envLabel === "v4.0")).toBe(true)
    // 第二个环境 D=1：r0 矩阵 2 批 + r1 矩阵 2 批 + r1 链 2 批 = 6
    expect(specs.slice(24)).toHaveLength(6)
  })
})

// ── 跨模型跨代（vs-previous）─────────────────────────────────────────────

describe("enumerateSchedule crossGeneration=\"vs-previous\"", () => {
  it("r=1 恰好追加 X@1 vs Y@0 全格对（双向、8 批；默认 24 批原样保留为前缀）", () => {
    const specs = enumerateSchedule(inputOf({ schedule: { crossGeneration: "vs-previous" } }))
    expect(specs.map(line).slice(0, EXPECTED_DEFAULT.length)).toEqual(EXPECTED_DEFAULT)
    expect(specs).toHaveLength(EXPECTED_DEFAULT.length + 8)
    const added = specs.slice(EXPECTED_DEFAULT.length)
    expect(added.map(line)).toEqual([
      `r1|${ENV}|A@r1|B@r0|0-vs-0|matrix`,
      `r1|${ENV}|A@r1|B@r0|0-vs-1|matrix`,
      `r1|${ENV}|A@r1|B@r0|1-vs-0|matrix`,
      `r1|${ENV}|A@r1|B@r0|1-vs-1|matrix`,
      `r1|${ENV}|B@r1|A@r0|0-vs-0|matrix`,
      `r1|${ENV}|B@r1|A@r0|0-vs-1|matrix`,
      `r1|${ENV}|B@r1|A@r0|1-vs-0|matrix`,
      `r1|${ENV}|B@r1|A@r0|1-vs-1|matrix`,
    ])
    expect(added.every((s) => !s.isChain)).toBe(true)
  })

  it("r≥2：只出 s<r 的新代打旧代切片（非 r×s 全方阵）", () => {
    const specs = enumerateSchedule(inputOf({
      rounds: 2,
      schedule: { crossGeneration: "vs-previous" },
    }))
    const cross = specs.filter((s) => s.planModel !== s.oppModel && s.planRound !== s.oppRound)
    // r=1：2 个有序模型对 × 1 个 s × 4 格 = 8；r=2：2 × 2 个 s × 4 格 = 16
    expect(cross).toHaveLength(24)
    expect(new Set(cross.map((s) => `${s.planRound}<-${s.oppRound}`))).toEqual(
      new Set(["1<-0", "2<-0", "2<-1"]),
    )
    // 反向（旧代打新代）不出现在任何 spec 里
    expect(cross.every((s) => s.oppRound < s.planRound)).toBe(true)
  })
})

// ── 隔代链（chainGap）────────────────────────────────────────────────────

describe("enumerateSchedule chainGap", () => {
  it("chainGap=2：r=2 追加 X@2 vs X@0（全格对），r=1 无隔代批", () => {
    const specs = enumerateSchedule(inputOf({ rounds: 2, schedule: { chainGap: 2 } }))
    // 默认 40（r0 8 + r1 16 + r2 16）+ 隔代 8（A/B × 4 格，r=2）
    expect(specs).toHaveLength(48)
    const gap = specs.filter((s) => s.isChain && s.planRound - s.oppRound === 2)
    expect(gap.map(line)).toEqual([
      `r2|${ENV}|A@r2|A@r0|0-vs-0|chain`,
      `r2|${ENV}|A@r2|A@r0|0-vs-1|chain`,
      `r2|${ENV}|A@r2|A@r0|1-vs-0|chain`,
      `r2|${ENV}|A@r2|A@r0|1-vs-1|chain`,
      `r2|${ENV}|B@r2|B@r0|0-vs-0|chain`,
      `r2|${ENV}|B@r2|B@r0|0-vs-1|chain`,
      `r2|${ENV}|B@r2|B@r0|1-vs-0|chain`,
      `r2|${ENV}|B@r2|B@r0|1-vs-1|chain`,
    ])
    // 相邻链仍在（r=1、r=2 各 8）
    expect(specs.filter((s) => s.isChain && s.planRound - s.oppRound === 1)).toHaveLength(16)
    expect(specs.some((s) => s.isChain && s.planRound - s.oppRound === 2 && s.round === 1)).toBe(false)
  })

  it("chainGap=1（显式）：只出相邻代链", () => {
    const specs = enumerateSchedule(inputOf({ rounds: 2, schedule: { chainGap: 1 } }))
    expect(specs.filter((s) => s.isChain).every((s) => s.planRound - s.oppRound === 1)).toBe(true)
    expect(specs).toHaveLength(40)
  })
})
