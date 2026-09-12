// Copyright (C) 2024-2025 Guyutongxue
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

// ---------------------------------------------------------------------------
// P3: Hidden Information Estimation
// ---------------------------------------------------------------------------
// §18.3 P3: "基于已打出/调和牌的信息 + 牌库剩余 + 对手行为模式"
//            "先用 framework.md def 0 的概率上界公式作为基线"
//
// framework.md §2 概率公式：
//   P(对手手中有卡 X) <= 1 - C(N-k, h) / C(N, h)
//   其中 N = 牌库+手牌总数, k = 该卡在剩余牌中的最大可能数, h = 手牌大小

import type { OpponentHiddenEstimateV1 } from "@gi-tcg/ml/contracts"

/**
 * 对手卡池配置 — 从已知信息构建。
 */
export interface OpponentDeckProfile {
  /** 初始牌库总数（通常 30） */
  initialDeckSize: number
  /** 已知被打出或调和掉的 definition_id 列表 */
  revealedDefinitionIds: number[]
  /** 对手当前手牌数 */
  handCount: number
  /** 对手当前牌库数 */
  pileCount: number
  /** 已知的卡定义 ID → 最大副本数映射（构筑规则：通常每卡最多 2 张） */
  maxCopiesPerCard: number
}

/**
 * 单张卡 x 在对手手中的概率上界。
 *
 * P(hand contains x) <= 1 - C(N - k, h) / C(N, h)
 *
 * 其中:
 *   N = pileCount + handCount (剩余未知牌总数)
 *   k = maxRemainingCopies (剩余可能副本数)
 *   h = handCount
 */
export function cardInHandProbabilityUpperBound(
  profile: OpponentDeckProfile,
  definitionId: number,
): number {
  const totalUnknown = profile.pileCount + profile.handCount
  if (totalUnknown <= 0 || profile.handCount <= 0) {
    return 0
  }

  // 计算该卡的剩余最大可能副本数
  const revealedCount = profile.revealedDefinitionIds.filter(
    (id) => id === definitionId,
  ).length
  const maxRemaining = Math.max(0, profile.maxCopiesPerCard - revealedCount)

  if (maxRemaining <= 0) {
    return 0 // 所有副本都已被打出
  }

  // P(手中无此卡) = C(N-k, h) / C(N, h)
  // 用对数避免大数溢出
  const N = totalUnknown
  const k = Math.min(maxRemaining, N) // k 不能超过牌池
  const h = profile.handCount

  if (k >= N) {
    return 1 // 剩余牌全是这张卡，必在手中
  }
  if (h > N - k) {
    return 1 // 手牌多于非此卡的牌数，必有至少一张
  }

  // C(N-k, h) / C(N, h) = product_{i=0}^{h-1} (N-k-i) / (N-i)
  let logRatio = 0
  for (let i = 0; i < h; i++) {
    logRatio += Math.log(N - k - i) - Math.log(N - i)
  }
  const probNotInHand = Math.exp(logRatio)
  return Math.max(0, Math.min(1, 1 - probNotInHand))
}

/**
 * 批量计算多张卡的概率上界。
 */
export function batchCardProbabilities(
  profile: OpponentDeckProfile,
  definitionIds: number[],
): Map<number, number> {
  const result = new Map<number, number>()
  for (const defId of definitionIds) {
    result.set(defId, cardInHandProbabilityUpperBound(profile, defId))
  }
  return result
}

// ---------------------------------------------------------------------------
// 卡牌类型分类（用于 expected_type_counts 估计）
// ---------------------------------------------------------------------------

/** 卡牌类型标签 */
export type CardCategory = "event" | "equipment" | "support" | "food" | "resonance"

/**
 * 从 definition_id 推断卡牌类型。
 *
 * 策略：基于 TCG ID 编码规则推断：
 * - 33xxxx → 装备（武器/圣遗物/天赋）
 * - 32xxxx → 支援
 * - 31xxxx → 装备
 * - 34xxxx → 事件
 * - 其他 → 事件（默认）
 */
export function classifyCardCategory(definitionId: number): CardCategory {
  const prefix = Math.floor(definitionId / 10000)
  switch (prefix) {
    case 31: // 武器
    case 33: // 天赋
      return "equipment"
    case 32: // 支援/场地
      return "support"
    case 34: // 事件
      return "event"
    default:
      return "event"
  }
}

/**
 * 构建增强版对手隐藏信息估计。
 *
 * 在原始 OpponentHiddenEstimateV1 基础上，根据对手牌池推断：
 * 1. expected_type_counts: 基于已知牌推断剩余牌类型分布
 * 2. expected_response_buckets: 基于概率上界估计关键回应牌
 */
export function buildEnhancedHiddenEstimate(
  baseEstimate: OpponentHiddenEstimateV1,
  profile: OpponentDeckProfile,
  keyResponseCards?: {
    healCards?: number[]
    diceFixCards?: number[]
    swapCards?: number[]
    burstEnableCards?: number[]
  },
): OpponentHiddenEstimateV1 {
  // 1. 估计剩余牌类型分布
  const revealedCategoryCounts: Record<CardCategory, number> = {
    event: 0,
    equipment: 0,
    support: 0,
    food: 0,
    resonance: 0,
  }
  for (const defId of profile.revealedDefinitionIds) {
    const cat = classifyCardCategory(defId)
    revealedCategoryCounts[cat]++
  }

  // 假设标准 30 卡构筑中的典型比例（可由对手阵营调整）
  const TYPICAL_TYPE_RATIO = {
    event: 10,
    equipment: 8,
    support: 6,
    food: 4,
    resonance: 2,
  }
  const totalTypical = Object.values(TYPICAL_TYPE_RATIO).reduce((a, b) => a + b, 0)
  const remainingTotal = profile.pileCount + profile.handCount
  const expectedTypes: Record<CardCategory, number> = {
    event: 0,
    equipment: 0,
    support: 0,
    food: 0,
    resonance: 0,
  }
  for (const cat of Object.keys(TYPICAL_TYPE_RATIO) as CardCategory[]) {
    const typicalCount = (TYPICAL_TYPE_RATIO[cat] / totalTypical) * profile.initialDeckSize
    const remaining = Math.max(0, typicalCount - revealedCategoryCounts[cat])
    expectedTypes[cat] = remainingTotal > 0 ? remaining : 0
  }

  // 2. 估计关键回应牌概率
  const responseBuckets = { ...baseEstimate.expected_response_buckets }
  if (keyResponseCards) {
    responseBuckets.heal_like = maxProbabilityAcrossCards(
      profile,
      keyResponseCards.healCards ?? [],
    )
    responseBuckets.dice_fix_like = maxProbabilityAcrossCards(
      profile,
      keyResponseCards.diceFixCards ?? [],
    )
    responseBuckets.swap_like = maxProbabilityAcrossCards(
      profile,
      keyResponseCards.swapCards ?? [],
    )
    responseBuckets.burst_enable_like = maxProbabilityAcrossCards(
      profile,
      keyResponseCards.burstEnableCards ?? [],
    )
  }

  return {
    ...baseEstimate,
    remaining_deck_count: profile.pileCount,
    expected_type_counts: expectedTypes,
    expected_response_buckets: responseBuckets,
  }
}

/**
 * 计算一组卡中至少有一张在手中的概率上界。
 * P(至少一张) = max(P(card_i)) — 保守但计算快速。
 */
function maxProbabilityAcrossCards(
  profile: OpponentDeckProfile,
  definitionIds: number[],
): number {
  if (definitionIds.length === 0) return 0
  let maxProb = 0
  for (const defId of definitionIds) {
    maxProb = Math.max(maxProb, cardInHandProbabilityUpperBound(profile, defId))
  }
  return maxProb
}
