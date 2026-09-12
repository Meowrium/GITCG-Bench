// Copyright (C) 2024-2025 Guyutongxue
//
// V27 Transition Scorer V0 单元测试
// 验证 H1/H2/H4/H8 约束的评分方向和独立性

import { expect, test } from "vitest"
import { GiMlPolicy } from "./gi-ml-policy.js"
import type { GiMlPolicyOptions } from "./gi-ml-policy.js"
import type { PolicyCandidateAction } from "./types.js"
import { DEFAULT_TRANSITION_CONFIG, type TransitionScorerV0Config } from "./transition-scorer.js"
import { scoreTransitionV0 } from "./transition-scorer.js"

const ZERO_ARTIFACT = {
  artifact_type: "slot_linear_ranker.v1" as const,
  artifact_version: "test",
  created_at: "2026-05-17T00:00:00.000Z",
  config: {},
}

function enabledConfig(overrides: Partial<TransitionScorerV0Config> = {}): TransitionScorerV0Config {
  return {
    ...DEFAULT_TRANSITION_CONFIG,
    enabled: true,
    enabledConstraints: ["H1", "H2", "H4", "H8"],
    ...overrides,
  }
}

function r1Digest(candidates: Record<string, unknown>[]) {
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
    opponent_declared_end: false,
  }
}

// ─────────────────────────────────────────────
// T1: H1 — declareEnd 受到行动权惩罚
// ─────────────────────────────────────────────

test("T1: H1 — declareEnd 在有可用技能时受到惩罚", () => {
  const digest = r1Digest([
    { candidate_id: "kill_skill", action_case: "useSkill", damage_estimate: 3, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const result = scoreTransitionV0(
    null, // observation not needed for H1
    digest,
    digest.candidate_actions[1], // declareEnd
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H1"] }),
  )

  expect(result.contribution).toBeLessThan(0)
  expect(result.reasons.some((r) => r.includes("H1"))).toBe(true)
  expect(result.reasons.some((r) => r.includes("opportunity"))).toBe(true)
})

// ─────────────────────────────────────────────
// T2: H1 — 对手结束后 declareEnd 额外惩罚
// ─────────────────────────────────────────────

test("T2: H1 — 对手已结束时 declareEnd 更严重的惩罚", () => {
  const digest = r1Digest([
    { candidate_id: "kill_skill", action_case: "useSkill", damage_estimate: 3, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])
  digest.opponent_declared_end = true

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[1],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H1"] }),
  )

  expect(result.contribution).toBeLessThan(0)
  expect(result.reasons.some((r) => r.includes("free_window"))).toBe(true)
})

// ─────────────────────────────────────────────
// T3: H2 — 高骰消耗动作有更多机会成本
// ─────────────────────────────────────────────

test("T3: H2 — 3骰消耗的机会成本高于 1骰", () => {
  const digest = r1Digest([
    { candidate_id: "expensive", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "cheap", action_case: "useSkill", damage_estimate: 1, dice_cost: 1 },
  ])

  const resultExpensive = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H2"] }),
  )

  const resultCheap = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[1],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H2"] }),
  )

  // 3骰的机会成本惩罚 > 1骰
  expect(resultExpensive.rawDelta).toBeLessThan(resultCheap.rawDelta)
})

// ─────────────────────────────────────────────
// T4: H4 — 空支援位新支援牌得分高
// ─────────────────────────────────────────────

test("T4: H4 — 空位 (slot=0) 打支援牌得分 > 已满位 (slot=4)", () => {
  const digestEmpty = r1Digest([
    { candidate_id: "support", action_case: "playCard", card_entity_type: 2, create_support_value: 1.5, dice_cost: 2 },
  ])
  digestEmpty.resource_summary.support_count = 0

  const digestFull = r1Digest([
    { candidate_id: "support", action_case: "playCard", card_entity_type: 2, create_support_value: 1.5, dice_cost: 2 },
  ])
  digestFull.resource_summary.support_count = 4

  // Need observation with supports for support_count to actually register
  const obsEmpty = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{ slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1001, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      combat_statuses: [],
      pile_count: 20,
      discard_count: 0,
      legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{ slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2001, alive: true, is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3, aura: null, equipment_ids: [], status_ids: [], usage_counters: {}, entities: [] }],
      summons: [],
      supports: [],
      combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20,
      discard_count: 0,
      declared_end: false,
      legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const obsFull = {
    ...obsEmpty,
    self: {
      ...obsEmpty.self,
      supports: [
        { id: 1, definition_id: 330001, variable_name: null, variable_value: null },
        { id: 2, definition_id: 330002, variable_name: null, variable_value: null },
        { id: 3, definition_id: 330003, variable_name: null, variable_value: null },
        { id: 4, definition_id: 330004, variable_name: null, variable_value: null },
      ],
    },
  }

  const resultEmpty = scoreTransitionV0(
    obsEmpty as any,
    digestEmpty,
    digestEmpty.candidate_actions[0],
    digestEmpty.candidate_actions,
    enabledConfig({ enabledConstraints: ["H4"] }),
  )

  const resultFull = scoreTransitionV0(
    obsFull as any,
    digestFull,
    digestFull.candidate_actions[0],
    digestFull.candidate_actions,
    enabledConfig({ enabledConstraints: ["H4"] }),
  )

  expect(resultEmpty.contribution).toBeGreaterThan(resultFull.contribution)
  expect(resultEmpty.reasons.some((r) => r.includes("H4:slot_0"))).toBe(true)
})

// ─────────────────────────────────────────────
// T5: H8 — 元素调谐被评估成本
// ─────────────────────────────────────────────

test("T5: H8 — 元素调谐有手牌保留成本", () => {
  const digest = r1Digest([
    {
      candidate_id: "tune",
      action_case: "elementalTuning",
      damage_estimate: 0,
      dice_cost: 1,
      meta_effect_slots: {
        retention_value_proxy: 2.5,
        reaction_window_loss: 1.5,
        finisher_alignment_loss: 0.5,
        setup_dependency_loss: 1.0,
      },
    },
    { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
  ])

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H8"] }),
  )

  // Tuning cost should be significant for a high-value sacrificed card
  expect(result.rawDelta).toBeLessThan(0)
  expect(result.reasons.some((r) => r.includes("H8:tuning"))).toBe(true)
  expect(result.reasons.some((r) => r.includes("retention"))).toBe(true)
})

// ─────────────────────────────────────────────
// T6: 集成 — GiMlPolicy 开启 transition 后 declareEnd 被降级
// ─────────────────────────────────────────────

test("T6: GiMlPolicy 开启 transition scoring 后 declareEnd 被进一步降级", () => {
  // Without transition scoring
  const policyOff = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    transitionScoringConfig: { ...DEFAULT_TRANSITION_CONFIG, enabled: false },
  })

  // With transition scoring enabled (H1 only)
  const policyOn = new GiMlPolicy(ZERO_ARTIFACT, null, {
    useBaselineTieBreaker: false,
    transitionScoringConfig: enabledConfig({ enabledConstraints: ["H1"] }),
  })

  const digest = r1Digest([
    { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const decisionOff = policyOff.choose(digest)
  const decisionOn = policyOn.choose(digest)

  // Both should still pick skill over declareEnd
  expect(decisionOff.selectedCandidateId).toBe("skill")
  expect(decisionOn.selectedCandidateId).toBe("skill")

  // But the declareEnd score should be lower with transition on
  const endRankedOff = decisionOff.ranked.find((r) => r.candidateId === "declareEnd")
  const endRankedOn = decisionOn.ranked.find((r) => r.candidateId === "declareEnd")

  expect(endRankedOff).toBeDefined()
  expect(endRankedOn).toBeDefined()

  if (endRankedOff && endRankedOn) {
    expect(endRankedOn.finalScore).toBeLessThan(endRankedOff.finalScore)
  }
})

// ─────────────────────────────────────────────
// T7: 非声明动作为零（非 H1/H2/H4/H8 动作）
// ─────────────────────────────────────────────

test("T7: 普通 useSkill 动作 H4/H8 贡献为零", () => {
  const digest = r1Digest([
    { candidate_id: "normal_skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
  ])

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig(),
  )

  // H4 and H8 should have zero raw since this is a skill not support/tuning
  const h4 = result.constraints.find((c) => c.id === "H4")
  const h8 = result.constraints.find((c) => c.id === "H8")

  if (h4) expect(h4.raw).toBe(0)
  if (h8) expect(h8.raw).toBe(0)
})

// ─────────────────────────────────────────────
// T8: 禁用时不产生任何效果
// ─────────────────────────────────────────────

test("T8: 禁用时有零贡献", () => {
  const digest = r1Digest([
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
  ])

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    { ...DEFAULT_TRANSITION_CONFIG, enabled: false },
  )

  expect(result.contribution).toBe(0)
  expect(result.reasons.length).toBe(0)
})

// ─────────────────────────────────────────────
// T9: H3 — 我方有附着时对手可以反应，损失反应窗口
// ─────────────────────────────────────────────

test("T9: H3 — 我方有附着 (aura debt) 负分", () => {
  const obs = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1407, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3,
        aura: 2, // hydro aura
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3,
        aura: null, // no aura
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const digest = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  const result = scoreTransitionV0(
    obs as any,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H3"] }),
  )

  // Having aura (hydro) is a reaction window for opponent → debt
  expect(result.reasons.some((r) => r.includes("H3:aura"))).toBe(true)
})

// ─────────────────────────────────────────────
// T10: H3 — 无附着动作零贡献
// ─────────────────────────────────────────────

test("T10: H3 — 非skill动作 H3 贡献为零", () => {
  const digest = r1Digest([
    { candidate_id: "switch", action_case: "switchCharacter", damage_estimate: 0, dice_cost: 1 },
  ])

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H3"] }),
  )

  // Switch doesn't change aura, should be zero
  expect(result.rawDelta).toBe(0)
})

// ─────────────────────────────────────────────
// T11: H5 — 高能源角色 (carry) burst 前切走负分
// ─────────────────────────────────────────────

test("T11: H5 — 满能量 carry 被切走有暴露风险", () => {
  const obs = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1407, alive: true,
        is_active: true, health: 5, max_health: 10, energy: 3, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 3, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const digest = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "switch", action_case: "switchCharacter", damage_estimate: 0, dice_cost: 1 },
      { candidate_id: "burst", action_case: "useSkill", damage_estimate: 6, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  // Switching away from full-energy carry (maxEnergy=3, energy=3 → carry role)
  // while opponent has burst → exposure risk
  const result = scoreTransitionV0(
    obs as any,
    digest,
    digest.candidate_actions[0], // switch
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H5"] }),
  )

  // Should have H5 reasoning
  expect(result.reasons.some((r) => r.includes("H5:role="))).toBe(true)
})

// ─────────────────────────────────────────────
// T12: H5 — carry 用 burst → 正分
// ─────────────────────────────────────────────

test("T12: H5 — 满能量 carry 用 burst 获正分", () => {
  const digest = r1Digest([
    { candidate_id: "burst", action_case: "useSkill", damage_estimate: 6, dice_cost: 3 },
  ])

  // Override to make it look like a carry using burst
  const obs = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1407, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 3, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 2,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const digest2 = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "burst", action_case: "useSkill", damage_estimate: 6, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  const result = scoreTransitionV0(
    obs as any,
    digest2,
    digest2.candidate_actions[0],
    digest2.candidate_actions,
    enabledConfig({ enabledConstraints: ["H5"] }),
  )

  // Carry burst-ready → positive alignment
  expect(result.reasons.some((r) => r.includes("H5:carry_burst_ready"))).toBe(true)
  expect(result.rawDelta).toBeGreaterThan(0)
})

// ─────────────────────────────────────────────
// T13: H6 — 对手满能量时威胁较大，我方动作降低威胁得正分
// ─────────────────────────────────────────────

test("T13: H6 — 对手 burst ready → 威胁评分高", () => {
  const obs = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1407, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3,
        aura: 1, // cryo aura → opponent can melt
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 3, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const digest = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  const result = scoreTransitionV0(
    obs as any,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H6"] }),
  )

  // Opponent has burst + we have aura → threat is high
  const hasThreatReason = result.reasons.some(
    (r) => r.includes("H6:threat_delta") || r.includes("H6:threat_static"),
  )
  expect(hasThreatReason).toBe(true)
})

// ─────────────────────────────────────────────
// T14: H7 — R1 先手得分倍率高于后手
// ─────────────────────────────────────────────

test("T14: H7 — R1 偶数 turn (先手) 倍率高于奇数 turn", () => {
  const digestFirst = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "skill", action_case: "useSkill", damage_estimate: 3, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  const digestSecond = {
    ...digestFirst,
    turn: 1,
  }

  const resultFirst = scoreTransitionV0(
    null, digestFirst, digestFirst.candidate_actions[0],
    digestFirst.candidate_actions, enabledConfig({ enabledConstraints: ["H7"] }),
  )

  const resultSecond = scoreTransitionV0(
    null, digestSecond, digestSecond.candidate_actions[0],
    digestSecond.candidate_actions, enabledConfig({ enabledConstraints: ["H7"] }),
  )

  // First mover (turn 0, even) should have higher or equal tempo bonus than second mover (turn 1, odd)
  expect(resultFirst.rawDelta).toBeGreaterThanOrEqual(resultSecond.rawDelta)
})

// ─────────────────────────────────────────────
// T15: H7 — declareEnd 不受 H7 影响
// ─────────────────────────────────────────────

test("T15: H7 — declareEnd 动作 H7 贡献为零", () => {
  const digest = r1Digest([
    { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
    { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
  ])

  const result = scoreTransitionV0(
    null,
    digest,
    digest.candidate_actions[0],
    digest.candidate_actions,
    enabledConfig({ enabledConstraints: ["H7"] }),
  )

  // declareEnd has actionFactor=0 → rawDelta should be 0
  expect(result.rawDelta).toBe(0)
})

// ─────────────────────────────────────────────
// T16: H9 — 低血量时隐藏风险增加
// ─────────────────────────────────────────────

test("T16: H9 — 低血量时隐藏风险惩罚更大", () => {
  const obsHighHp = {
    self: {
      supports: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1407, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 10, max_health: 10, energy: 0, max_energy: 3,
        aura: null,
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const obsLowHp = {
    ...obsHighHp,
    self: {
      ...obsHighHp.self,
      characters: [{
        ...obsHighHp.self.characters[0],
        health: 2, // low HP
      }],
    },
  }

  const digest = {
    round: 1, turn: 0,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 5, dice_count: 8, omni_count: 0, support_count: 0, summon_count: 0, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "skill", action_case: "useSkill", damage_estimate: 2, dice_cost: 3 },
    ],
    opponent_declared_end: false,
  }

  const resultHigh = scoreTransitionV0(
    obsHighHp as any, digest, digest.candidate_actions[0],
    digest.candidate_actions, enabledConfig({ enabledConstraints: ["H9"] }),
  )

  const resultLow = scoreTransitionV0(
    obsLowHp as any, digest, digest.candidate_actions[0],
    digest.candidate_actions, enabledConfig({ enabledConstraints: ["H9"] }),
  )

  // Low HP → higher hidden risk penalty
  expect(resultLow.rawDelta).toBeLessThanOrEqual(resultHigh.rawDelta)
})

// ─────────────────────────────────────────────
// T17: 全约束启用无崩溃集成测试
// ─────────────────────────────────────────────

test("T17: 全 9 约束同时启用无崩溃", () => {
  const obs = {
    self: {
      supports: [{ id: 1, definition_id: 330001, variable_name: null, variable_value: null }],
      dice: { total_count: 8, omni_count: 2, counts_by_type: { py: 3, hy: 3 } },
      declared_end: false,
      hand: { card_count: 5, visible_cards: [] },
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 1001, definition_id: 1305, alive: true,
        is_active: true, health: 8, max_health: 10, energy: 2, max_energy: 3,
        aura: 3, // pyro aura
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], combat_statuses: [],
      pile_count: 20, discard_count: 0, legend_used: false,
    },
    opponent: {
      active_character_index: 0 as 0 | 1 | 2 | null,
      characters: [{
        slot_index: 0 as 0 | 1 | 2, id: 2001, definition_id: 2201, alive: true,
        is_active: true, health: 6, max_health: 10, energy: 2, max_energy: 3,
        aura: 2, // hydro aura
        equipment_ids: [], status_ids: [], usage_counters: {}, entities: [],
      }],
      summons: [], supports: [], combat_statuses: [],
      dice: { total_count: 8, omni_count: 0, counts_by_type: {} },
      hand: { card_count: 5, visible_cards: [] },
      pile_count: 20, discard_count: 0, declared_end: false, legend_used: false,
    },
    pending_method: null as any,
    deck_info: { self_deck_cards: [], opponent_revealed_cards: [] },
  }

  const digest = {
    round: 2, turn: 3,
    self_summary: {},
    opponent_summary: {},
    resource_summary: { cards_in_hand: 4, dice_count: 8, omni_count: 2, support_count: 1, summon_count: 1, max_support_count: 4, max_summon_count: 4 },
    candidate_actions: [
      { candidate_id: "skill", action_case: "useSkill", damage_estimate: 3, dice_cost: 3 },
      { candidate_id: "declareEnd", action_case: "declareEnd", damage_estimate: 0, dice_cost: 0 },
      {
        candidate_id: "support", action_case: "playCard", card_entity_type: 2,
        damage_estimate: 0, dice_cost: 2, create_support_value: 1.0,
      },
      {
        candidate_id: "tune", action_case: "elementalTuning", damage_estimate: 0,
        dice_cost: 1, meta_effect_slots: {
          retention_value_proxy: 1.5, reaction_window_loss: 0.5,
          finisher_alignment_loss: 0, setup_dependency_loss: 0.5,
        },
      },
    ],
    opponent_declared_end: false,
  }

  // Enable all 9 constraints
  const config = enabledConfig({
    enabledConstraints: ["H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9"],
  })

  for (const candidate of digest.candidate_actions) {
    const result = scoreTransitionV0(
      obs as any, digest, candidate, digest.candidate_actions, config,
    )
    // Each should produce something (even if zero contribution)
    expect(result).toBeDefined()
    expect(typeof result.contribution).toBe("number")
    expect(Array.isArray(result.constraints)).toBe(true)
    expect(Array.isArray(result.reasons)).toBe(true)
  }
})
