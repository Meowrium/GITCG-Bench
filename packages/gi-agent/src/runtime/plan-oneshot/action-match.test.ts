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
 * candidateMatchesSpec 的 skill_def_id 硬过滤单测（纳西妲两个元素战技
 * 17032/17033 为同类型多变体样本；不指定时按 skill_type 匹配、tie-break 不变）。
 */

import { describe, expect, it } from "vitest"
import type { GameData } from "@gi-tcg/core"
import { candidateMatchesSpec, candidateTieBreakScore, type ActionMatchContext, type RpcAction } from "./action-match.js"

const SKILL_TYPE_INDEX = new Map<number, "normal_attack" | "elemental_skill" | "burst">([
  [17032, "elemental_skill"],
  [17033, "elemental_skill"],
  [17034, "burst"],
])

const ctx: ActionMatchContext = {
  gameData: {} as GameData,
  opponentCharacterIds: new Set<number>(),
  opponentActiveId: undefined,
  defIdByEntityId: new Map<number, number>(),
}

function useSkill(skillDefinitionId: number): RpcAction {
  return {
    action: { $case: "useSkill", value: { skillDefinitionId, targetIds: [], mainDamageTargetId: undefined } },
    preview: [],
  } as unknown as RpcAction
}

describe("candidateMatchesSpec skill_def_id", () => {
  it("指定 17033 只命中真如；不指定时两个变体都可命中", () => {
    const exact = { action_case: "useSkill", skill_def_id: 17033 } as const
    expect(candidateMatchesSpec(exact, useSkill(17033), ctx, SKILL_TYPE_INDEX)).toBe(true)
    expect(candidateMatchesSpec(exact, useSkill(17032), ctx, SKILL_TYPE_INDEX)).toBe(false)

    const byType = { action_case: "useSkill", skill_type: "elemental_skill" } as const
    expect(candidateMatchesSpec(byType, useSkill(17032), ctx, SKILL_TYPE_INDEX)).toBe(true)
    expect(candidateMatchesSpec(byType, useSkill(17033), ctx, SKILL_TYPE_INDEX)).toBe(true)
  })

  it("skill_type + skill_def_id 同时给出：两个过滤都生效", () => {
    const both = { action_case: "useSkill", skill_type: "elemental_skill", skill_def_id: 17033 } as const
    expect(candidateMatchesSpec(both, useSkill(17033), ctx, SKILL_TYPE_INDEX)).toBe(true)
    expect(candidateMatchesSpec(both, useSkill(17032), ctx, SKILL_TYPE_INDEX)).toBe(false)

    // skill_type 与 skill_def_id 冲突 → 不命中（两者都过滤）
    const conflicting = { action_case: "useSkill", skill_type: "burst", skill_def_id: 17033 } as const
    expect(candidateMatchesSpec(conflicting, useSkill(17033), ctx, SKILL_TYPE_INDEX)).toBe(false)
  })

  it("不指定 skill_def_id 时两变体 tie-break 分数相同（现行 tie-break 不变）", () => {
    const spec = { action_case: "useSkill", skill_type: "elemental_skill" } as const
    expect(candidateTieBreakScore(spec, useSkill(17032), ctx))
      .toBe(candidateTieBreakScore(spec, useSkill(17033), ctx))
  })
})
