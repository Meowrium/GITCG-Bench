// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * D 类：决策日志可解释性验证
 *
 * 验证 RankedPolicyCandidate.reasons 是否充分填充，
 * 以及 CandidateScoreBreakdown 的字段是否可用于决策解析。
 *
 * 对应文档: docs/v26-ai-architecture-recommendations.md §9 (P1-3)
 *           docs/archive/v14-model-requirements.md §A4
 */
import { expect, test } from "vitest"
import { BaselinePolicy } from "../../runtime/policy/baseline-policy.js"
import type { PolicyCandidateAction, PolicyTurnDigest } from "../../runtime/policy/types.js"

function makePolicy() {
  return new BaselinePolicy({})
}

function r1Digest(candidates: Record<string, unknown>[]): PolicyTurnDigest {
  return {
    round: 1,
    turn: 0,
    self_summary: {
      active_character_id: 1001,
      characters: [{ id: 1001, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true }],
      hand_cards: [{}, {}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2001,
      characters: [{ id: 2001, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true }],
    },
    resource_summary: {
      cards_in_hand: 5,
      dice_count: 8,
      omni_count: 0,
      support_count: 0,
      summon_count: 0,
      max_support_count: 4,
      max_summon_count: 4,
    },
    candidate_actions: candidates.map((c, i) => ({
      candidate_id: c.candidate_id ?? `candidate_${i}`,
      action_case: c.action_case ?? "useSkill",
      damage_estimate: c.damage_estimate ?? 0,
      dice_cost: c.dice_cost ?? 0,
      tags: c.tags ?? [],
      ...c,
    })) as PolicyCandidateAction[],
  }
}

// ─────────────────────────────────────────────
// D1: top-1 reasons 不为空
// ─────────────────────────────────────────────

test("D1: top-1 的 reasons 列表不为空", () => {
  const policy = makePolicy()

  const digest = r1Digest([
    { candidate_id: "skill_a", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decision = policy.choose(digest)
  const top1 = decision.ranked[0]

  expect(top1).toBeDefined()
  expect(top1.reasons.length).toBeGreaterThan(0)
  // 每个 reason 至少要有可读的长度
  for (const reason of top1.reasons) {
    expect(reason.length).toBeGreaterThanOrEqual(2)
  }
})

// ─────────────────────────────────────────────
// D2: 所有候选项都有 reasons
// ─────────────────────────────────────────────

test("D2: 所有候选动作的 reasons 均被填充", () => {
  const policy = makePolicy()

  const digest = r1Digest([
    { candidate_id: "skill_a", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "skill_b", action_case: "useSkill", damage_estimate: 1, dice_cost: 2 },
    { candidate_id: "support", action_case: "playCard", card_entity_type: 2, damage_estimate: 0, dice_cost: 2, create_support_value: 1.5 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decision = policy.choose(digest)

  for (const ranked of decision.ranked) {
    expect(ranked.reasons.length).toBeGreaterThan(0)
  }
})

// ─────────────────────────────────────────────
// D3: finalScore 可以还原为 component 加权和
//     (当前 BaselinePolicy 没有 CandidateScoreBreakdown,
//      但 heuristicScore 应能解释)
// ─────────────────────────────────────────────

test("D3: heuristicScore 与 finalScore 一致 (BaselinePolicy)", () => {
  const policy = makePolicy()

  const digest = r1Digest([
    { candidate_id: "skill_a", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decision = policy.choose(digest)

  for (const ranked of decision.ranked) {
    // BaselinePolicy 中 finalScore = heuristicScore (无 learnedScore)
    if (ranked.learnedScore === undefined) {
      expect(ranked.finalScore).toBe(ranked.heuristicScore)
    }
  }
})

// ─────────────────────────────────────────────
// D4: reasons 包含关键决策信息
// ─────────────────────────────────────────────

test("D4: declareEnd 的 reasons 包含解释原因", () => {
  const policy = makePolicy()

  const digest = r1Digest([
    { candidate_id: "skill_a", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decision = policy.choose(digest)

  // declareEnd 应有解释
  const endRanked = decision.ranked.find((r) => r.candidateId === "declareEnd")
  expect(endRanked).toBeDefined()

  if (endRanked) {
    // reasons 至少有一条提到 "end" 或 "penalty" 或 "declare"
    const hasDeclareEndReason = endRanked.reasons.some(
      (r) => r.toLowerCase().includes("end") || r.toLowerCase().includes("penalty")
    )
    expect(hasDeclareEndReason).toBe(true)
  }
})

// ─────────────────────────────────────────────
// D5: 决策日志能输出完整顺序 (所有候选按 score 排序)
// ─────────────────────────────────────────────

test("D5: ranked 列表按 finalScore 降序排列", () => {
  const policy = makePolicy()

  const digest = r1Digest([
    { candidate_id: "skill_a", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "skill_b", action_case: "useSkill", damage_estimate: 1, dice_cost: 2 },
    { candidate_id: "support", action_case: "playCard", card_entity_type: 2, damage_estimate: 0, dice_cost: 2, create_support_value: 1.5 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decision = policy.choose(digest)

  for (let i = 1; i < decision.ranked.length; i++) {
    expect(decision.ranked[i - 1].finalScore).toBeGreaterThanOrEqual(
      decision.ranked[i].finalScore
    )
  }
})
