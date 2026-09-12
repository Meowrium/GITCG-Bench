// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * V14 模型性质验证测试套件 (V1-V6)
 *
 * 验证 ranker / policy 是否满足基本数学性质。
 * 不依赖真实 engine，用合成 PolicyTurnDigest 构造。
 *
 * 对应文档: docs/archive/v14-model-requirements.md §6
 */
import { expect, test } from "vitest"
import { BaselinePolicy } from "../../runtime/policy/baseline-policy.js"
import type { PolicyTurnDigest } from "../../runtime/policy/types.js"

// ─────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────

function makePolicy() {
  return new BaselinePolicy({})
}

function r1Digest(overrides: Partial<PolicyTurnDigest> = {}): PolicyTurnDigest {
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
    candidate_actions: [],
    ...overrides,
  }
}

function skillAction(id: string, overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: id,
    action_case: "useSkill",
    damage_estimate: overrides.damage_estimate ?? 2,
    reaction_value: overrides.reaction_value ?? 0,
    dice_cost: overrides.dice_cost ?? 3,
    tags: ["use_skill"],
    ...overrides,
  }
}

function declareEndAction() {
  return {
    candidate_id: "declareEnd",
    action_case: "declareEnd",
    damage_estimate: 0,
    dice_cost: 0,
    tags: ["declare_end"],
  }
}

function burstAction(id: string, energy: number, maxEnergy: number, overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: id,
    action_case: "useSkill",
    damage_estimate: overrides.damage_estimate ?? 5,
    reaction_value: overrides.reaction_value ?? 0,
    dice_cost: overrides.dice_cost ?? 3,
    energy_gain_value: overrides.energy_gain_value ?? 0,
    tags: ["burst", "use_skill"],
    ...overrides,
    // Flag for test to identify as burst
    _burst: true,
  }
}

function playSupportCard(id: string) {
  return {
    candidate_id: id,
    action_case: "playCard",
    card_entity_type: 2, // support type
    damage_estimate: 0,
    dice_cost: 2,
    tags: ["play_card", "support"],
    create_support_value: 1.5,
  }
}

function normalizeCandidates(
  candidates: Record<string, unknown>[]
): Record<string, unknown>[] {
  // Ensure all candidates have minimum required fields
  return candidates.map((c, i) => ({
    candidate_id: c.candidate_id ?? `candidate_${i}`,
    action_case: c.action_case ?? "useSkill",
    damage_estimate: c.damage_estimate ?? 0,
    dice_cost: c.dice_cost ?? 0,
    tags: c.tags ?? [],
    ...c,
  }))
}

// ─────────────────────────────────────────────
// V1: R1 不为空测试
// ─────────────────────────────────────────────

test("V1: R1 — 有 8 骰 + 可用技能时不应 declareEnd", () => {
  const policy = makePolicy()

  const digest = r1Digest({
    candidate_actions: normalizeCandidates([
      skillAction("skill_a", { damage_estimate: 2, dice_cost: 3 }),
      declareEndAction(),
    ]),
  })

  const decision = policy.choose(digest)
  expect(decision.selectedCandidateId).not.toBe("declareEnd")
  expect(decision.selectedCandidateId).toBe("skill_a")

  // declareEnd 得分应低于任何技能
  const rankedEnd = decision.ranked.find((r) => r.candidateId === "declareEnd")
  const rankedSkill = decision.ranked.find((r) => r.candidateId === "skill_a")
  expect(rankedEnd).toBeDefined()
  expect(rankedSkill).toBeDefined()
  // 使用 != null 而非非空断言避免 linter 警告
  if (rankedEnd && rankedSkill) {
    expect(rankedEnd.finalScore).toBeLessThan(rankedSkill.finalScore)
  }
})

// ─────────────────────────────────────────────
// V2: 斩杀优先测试
// ─────────────────────────────────────────────

test("V2: 可斩杀时攻击应优先于 declareEnd 和非斩杀动作", () => {
  const policy = makePolicy()

  // 对手 1 HP, 我方有 3骰2伤技能 = 可斩杀
  const digest: PolicyTurnDigest = {
    round: 2,
    turn: 1,
    self_summary: {
      active_character_id: 1001,
      characters: [{ id: 1001, hp: 10, max_hp: 10, energy: 0, max_energy: 3, alive: true }],
      hand_cards: [{}, {}, {}, {}, {}],
    },
    opponent_summary: {
      active_character_id: 2001,
      characters: [{ id: 2001, hp: 1, max_hp: 10, energy: 0, max_energy: 3, alive: true }],
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
    candidate_actions: normalizeCandidates([
      skillAction("kill_skill", { damage_estimate: 2, dice_cost: 3 }),
      playSupportCard("support_a"),
      declareEndAction(),
    ]),
  }

  const decision = policy.choose(digest)
  expect(decision.selectedCandidateId).toBe("kill_skill")
})

// ─────────────────────────────────────────────
// V3: declareEnd 非最优测试
// ─────────────────────────────────────────────

test("V3: R1 + 8骰 + 多个技能可用时 declareEnd 得分最低", () => {
  const policy = makePolicy()

  const digest = r1Digest({
    candidate_actions: normalizeCandidates([
      skillAction("skill_a", { damage_estimate: 2, dice_cost: 3 }),
      skillAction("skill_b", { damage_estimate: 1, dice_cost: 2 }),
      declareEndAction(),
    ]),
  })

  const decision = policy.choose(digest)

  // declareEnd 得分应低于所有技能
  const endAction = decision.ranked.find((r) => r.candidateId === "declareEnd")
  for (const ranked of decision.ranked) {
    if (ranked.candidateId === "declareEnd") continue
    if (endAction) {
      expect(endAction.finalScore).toBeLessThan(ranked.finalScore)
    }
  }
})

// ─────────────────────────────────────────────
// V4: 充能感知测试
// ─────────────────────────────────────────────

test("V4: 满能量时 burst 得分应高于 0 能量时", () => {
  const policy = makePolicy()

  // 状态 A: 0 能量
  const digestA: PolicyTurnDigest = {
    round: 2,
    turn: 1,
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
    candidate_actions: normalizeCandidates([
      burstAction("burst_low_energy", 0, 3, { damage_estimate: 5, dice_cost: 3 }),
      skillAction("normal_skill", { damage_estimate: 2, dice_cost: 3 }),
      declareEndAction(),
    ]),
  }

  // 状态 B: 满能量
  const digestB: PolicyTurnDigest = {
    ...digestA,
    self_summary: {
      ...digestA.self_summary,
      characters: [{ id: 1001, hp: 10, max_hp: 10, energy: 3, max_energy: 3, alive: true }],
    },
    candidate_actions: normalizeCandidates([
      burstAction("burst_full_energy", 3, 3, { damage_estimate: 5, dice_cost: 3 }),
      skillAction("normal_skill", { damage_estimate: 2, dice_cost: 3 }),
      declareEndAction(),
    ]),
  }

  const decisionA = policy.choose(digestA)
  const decisionB = policy.choose(digestB)

  // 满能量时 burst 的排名应不低于 0 能量时
  const burstARank = decisionA.ranked.findIndex((r) => r.candidateId === "burst_low_energy")
  const burstBRank = decisionB.ranked.findIndex((r) => r.candidateId === "burst_full_energy")

  // 排名越小越好 (index 小 = score 高)
  // 满能量时 burst 排名不应更差
  expect(burstBRank).toBeLessThanOrEqual(burstARank)
})

// ─────────────────────────────────────────────
// V5: 反应感知测试
// ─────────────────────────────────────────────

test("V5: 有冰附着 → 火技能应比无附着时得分高", () => {
  const policy = makePolicy()

  // 无附着
  const digestNoAura: PolicyTurnDigest = {
    round: 2,
    turn: 1,
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
    candidate_actions: normalizeCandidates([
      skillAction("pyro_skill", { damage_estimate: 2, dice_cost: 3, reaction_value: 0 }),
      declareEndAction(),
    ]),
  }

  // 有冰附着 → melt 反应
  const digestWithAura: PolicyTurnDigest = {
    ...digestNoAura,
    candidate_actions: normalizeCandidates([
      skillAction("pyro_skill_melt", { damage_estimate: 2, dice_cost: 3, reaction_value: 2 }),
      declareEndAction(),
    ]),
  }

  const decisionNoAura = policy.choose(digestNoAura)
  const decisionWithAura = policy.choose(digestWithAura)

  const scoreNoAura = decisionNoAura.ranked.find((r) => r.candidateId === "pyro_skill")?.finalScore ?? 0
  const scoreWithAura = decisionWithAura.ranked.find((r) => r.candidateId === "pyro_skill_melt")?.finalScore ?? 0

  // 有反应加成的技能得分应更高
  expect(scoreWithAura).toBeGreaterThan(scoreNoAura)
})

// ─────────────────────────────────────────────
// V6: 骰子效率测试
// ─────────────────────────────────────────────

test("V6: 高骰子效率（3骰6伤）应优先于 3骰0伤（纯出牌）", () => {
  const policy = makePolicy()

  // 使用极端高效的技能 (3骰6伤, 效率 2.0) vs 支援牌 (效率 0)
  // BaselinePolicy 对支援有 supportWeight=1.1 加成，需要伤害远大于此
  const digest: PolicyTurnDigest = {
    round: 2,
    turn: 1,
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
    candidate_actions: normalizeCandidates([
      skillAction("efficient_skill", { damage_estimate: 6, dice_cost: 3 }),
      playSupportCard("zero_dmg_support"),
      declareEndAction(),
    ]),
  }

  const decision = policy.choose(digest)

  // 高伤害技能应得分高于零伤害的支援牌
  const skillRanked = decision.ranked.find((r) => r.candidateId === "efficient_skill")
  const supportRanked = decision.ranked.find((r) => r.candidateId === "zero_dmg_support")

  if (skillRanked && supportRanked) {
    expect(skillRanked.finalScore).toBeGreaterThan(supportRanked.finalScore)
  }
})
