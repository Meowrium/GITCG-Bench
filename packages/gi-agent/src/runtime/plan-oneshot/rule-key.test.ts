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
 * rule-key 测试：旧格式逐字节一致（往返）、层前缀格式往返、add: 前缀、
 * 垃圾输入拒绝、collectRuleKeys 口径（只含 global + phases，不含 opening）。
 */

import { describe, expect, it } from "vitest"
import { formatRuleKey, parseRuleKey, collectRuleKeys } from "./rule-key.js"
import type { GamePlanV1 } from "./game-plan-v1.js"

describe("formatRuleKey：旧格式逐字节一致", () => {
  it("无层输出与历史字符串一致", () => {
    expect(formatRuleKey({ scope: "global", priority: 11 })).toBe("global:11")
    expect(formatRuleKey({ scope: "phase", phaseId: "burst", priority: 20 })).toBe("phase:burst:20")
    // opening 规则无 priority 字段，恒记 0（忽略入参 priority）
    expect(formatRuleKey({ scope: "opening", priority: 0 })).toBe("opening:0")
    expect(formatRuleKey({ scope: "opening", priority: 5 })).toBe("opening:0")
    // patch 半分插入产生的小数/负 priority
    expect(formatRuleKey({ scope: "global", priority: 8.75 })).toBe("global:8.75")
    expect(formatRuleKey({ scope: "global", priority: -1 })).toBe("global:-1")
    // phaseId 缺省占位（trace 旧行为 e.phaseId ?? "?"）
    expect(formatRuleKey({ scope: "phase", priority: 3 })).toBe("phase:?:3")
    expect(formatRuleKey({ scope: "phase", phaseId: null, priority: 3 })).toBe("phase:?:3")
  })

  it("层前缀格式", () => {
    expect(formatRuleKey({ scope: "global", priority: 5, layer: "general" })).toBe("general:global:5")
    expect(formatRuleKey({ scope: "phase", phaseId: "burst", priority: 20, layer: "general" })).toBe("general:phase:burst:20")
    expect(formatRuleKey({ scope: "opening", priority: 0, layer: "general" })).toBe("general:opening:0")
    expect(formatRuleKey({ scope: "global", priority: 5, layer: "single", layerLabel: "hongniu" })).toBe("single:hongniu:global:5")
    expect(formatRuleKey({ scope: "phase", phaseId: "burst", priority: 20, layer: "single", layerLabel: "hongniu" })).toBe("single:hongniu:phase:burst:20")
    expect(formatRuleKey({ scope: "opening", priority: 0, layer: "single", layerLabel: "hongniu" })).toBe("single:hongniu:opening:0")
  })

  it("add: 前缀整体前置", () => {
    expect(formatRuleKey({ scope: "global", priority: 3, added: true })).toBe("add:global:3")
    expect(formatRuleKey({ scope: "global", priority: 3, layer: "single", layerLabel: "hongniu", added: true })).toBe("add:single:hongniu:global:3")
    expect(formatRuleKey({ scope: "phase", phaseId: "burst", priority: 2, layer: "general", added: true })).toBe("add:general:phase:burst:2")
  })
})

describe("parseRuleKey", () => {
  it("旧格式往返", () => {
    expect(parseRuleKey("global:11")).toEqual({ scope: "global", priority: 11 })
    expect(parseRuleKey("phase:burst:20")).toEqual({ scope: "phase", phaseId: "burst", priority: 20 })
    expect(parseRuleKey("opening:0")).toEqual({ scope: "opening", priority: 0 })
    expect(parseRuleKey("global:-1.5")).toEqual({ scope: "global", priority: -1.5 })
  })

  it("层格式往返", () => {
    expect(parseRuleKey("general:global:5")).toEqual({ layer: { kind: "general" }, scope: "global", priority: 5 })
    expect(parseRuleKey("general:phase:burst:20")).toEqual({ layer: { kind: "general" }, scope: "phase", phaseId: "burst", priority: 20 })
    expect(parseRuleKey("single:hongniu:global:5")).toEqual({ layer: { kind: "single", label: "hongniu" }, scope: "global", priority: 5 })
    expect(parseRuleKey("single:hongniu:phase:burst:20")).toEqual({ layer: { kind: "single", label: "hongniu" }, scope: "phase", phaseId: "burst", priority: 20 })
    expect(parseRuleKey("single:hongniu:opening:0")).toEqual({ layer: { kind: "single", label: "hongniu" }, scope: "opening", priority: 0 })
  })

  it("add: 前缀", () => {
    expect(parseRuleKey("add:global:3")).toEqual({ scope: "global", priority: 3, added: true })
    expect(parseRuleKey("add:phase:burst:2")).toEqual({ scope: "phase", phaseId: "burst", priority: 2, added: true })
    expect(parseRuleKey("add:single:hongniu:global:3")).toEqual({ layer: { kind: "single", label: "hongniu" }, scope: "global", priority: 3, added: true })
    // 不带前缀时 added 字段缺省（保持旧解析形状）
    expect(parseRuleKey("global:3")).not.toHaveProperty("added")
  })

  it("label 允许空格/斜杠/中文等奇怪字符（仅 ':' 与空串非法）", () => {
    expect(parseRuleKey("single:红牛 mk2:global:5")).toEqual({ layer: { kind: "single", label: "红牛 mk2" }, scope: "global", priority: 5 })
    expect(parseRuleKey("single:a/b(c):phase:x_y-9:1")).toEqual({ layer: { kind: "single", label: "a/b(c)" }, scope: "phase", phaseId: "x_y-9", priority: 1 })
  })

  it("拒绝垃圾输入", () => {
    const garbage = [
      "",
      "global", "global:", "global:x", "global:1.2.3", "global:5x",
      "phase:burst", "phase::5", "phase:burst:x",
      "opening", "opening:x",
      "foo:global:5", "add:", "add:foo", "add:add:global:3",
      // 层前缀的垃圾形态
      "general:", "general:global:x", "generalx:global:5",
      "single:global:5", // label 缺失时 "global" 被当作 label，剩余 "5" 非法
      "single::global:5", // 空 label
      "single:x", "single:x:",
      "single:a:b:global:5", // label 含 ':' 的形态（合法 label 不可能产生这种键）
    ]
    for (const bad of garbage) {
      expect(parseRuleKey(bad)).toBe(null)
    }
  })

  it("format → parse 往返保持语义", () => {
    const cases = [
      { scope: "global", priority: 7 },
      { scope: "phase", phaseId: "burst", priority: 20 },
      { scope: "opening", priority: 0 },
      { scope: "global", priority: 5, layer: "general" as const },
      { scope: "phase", phaseId: "late", priority: 1, layer: "single" as const, layerLabel: "leihe" },
      { scope: "global", priority: 3, layer: "single" as const, layerLabel: "hongniu", added: true },
    ] as const
    for (const c of cases) {
      const parsed = parseRuleKey(formatRuleKey(c))
      expect(parsed).not.toBe(null)
      expect(parsed!.scope).toBe(c.scope)
      expect(parsed!.priority).toBe(c.scope === "opening" ? 0 : c.priority)
      expect(parsed!.phaseId).toBe("phaseId" in c ? c.phaseId : undefined)
      expect(parsed!.added).toBe("added" in c && c.added ? true : undefined)
      if ("layer" in c && c.layer === "single") {
        expect(parsed!.layer).toEqual({ kind: "single", label: c.layerLabel })
      } else if ("layer" in c && c.layer === "general") {
        expect(parsed!.layer).toEqual({ kind: "general" })
      } else {
        expect(parsed!.layer).toBeUndefined()
      }
    }
  })
})

describe("collectRuleKeys", () => {
  const plan = {
    version: "GamePlanV1",
    planId: "aaaaaaaaaaaa",
    parentPlanId: null,
    createdAt: "2026-09-02T00:00:00Z",
    author: "test",
    context: { deckCode: "ABC", opponent: { kind: "unknown_deck" } },
    predictions: { winRateEstimate: 0.5, expectedRounds: 6, confidence: 0.5, keyThreats: [] },
    opening: {
      chooseActive: [{ characterDefId: 1302, reason: "opening 不进 ruleRef 集合" }],
      mulligan: [],
      reroll: [],
    },
    phases: [
      {
        phaseId: "burst",
        when: [],
        rules: [{ priority: 20, then: { action_case: "useSkill", skill_type: "burst" }, reason: "爆发" }],
      },
    ],
    rules: [
      { priority: 1, then: { action_case: "useSkill", kills: true }, reason: "斩杀" },
      { priority: 10, then: { action_case: "declareEnd" }, reason: "收" },
    ],
    fallback: { policy: "conservative" },
  } satisfies GamePlanV1 as GamePlanV1

  it("含 global + phases + opening（opening 键固定 opening:0）", () => {
    expect([...collectRuleKeys(plan)].sort()).toEqual(["global:1", "global:10", "opening:0", "phase:burst:20"])
  })

  it("带层时整体加层前缀", () => {
    expect([...collectRuleKeys(plan, { kind: "general" })].sort()).toEqual([
      "general:global:1", "general:global:10", "general:opening:0", "general:phase:burst:20",
    ])
    expect([...collectRuleKeys(plan, { kind: "single", label: "hongniu" })].sort()).toEqual([
      "single:hongniu:global:1", "single:hongniu:global:10", "single:hongniu:opening:0", "single:hongniu:phase:burst:20",
    ])
  })

  it("空 opening 不产生 opening 键", () => {
    const empty = { ...plan, opening: { chooseActive: [], mulligan: [], reroll: [] } } satisfies GamePlanV1 as GamePlanV1
    expect([...collectRuleKeys(empty)].sort()).toEqual(["global:1", "global:10", "phase:burst:20"])
  })
})
