// Copyright (C) 2024-2025 Guyutongxue
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

/**
 * P1-1: Realistic draw expectation per round.
 *
 * Estimates expected cards drawn per turn, accounting for:
 * - Natural draw (5 start + 2 per round)
 * - Draw engines that trigger passively (artifacts, supports)
 * - The fact that draw engines must first be drawn and played
 *
 * Returns per-round estimates, NOT theoretical max.
 */

import type { DeckCardInfo } from "../heuristics"

export interface DrawEstimate {
  /** Per-round expected draw counts */
  perRound: number[]
  /** Total draw over first N rounds */
  totalDraws: number[]
  /** Which engines contribute per round */
  engines: Array<{
    cardName: string
    triggerCondition: string
    expectedDrawsPerRound: number[] // per round after deployment
    earliestDeployRound: number
  }>
}

/**
 * Estimate per-round expected draw for a deck.
 *
 * Conservative assumptions:
 * - Maximum 2 artifacts playable by R2 (realistically, need dice for skills too)
 * - Supports deploy gradually, not all at once
 * - Triggers are not always met (e.g., reaction trigger needs opponent state)
 */
export function estimateDrawExpectation(
  cards: DeckCardInfo[],
): DrawEstimate {
  const engines: DrawEstimate["engines"] = []

  // Natural draw
  const NATURAL_START = 5
  const NATURAL_PER_ROUND = 2

  // Identify draw engines from card descriptions
  for (const card of cards) {
    const desc = (card.description || "") + (card.playingDescription || "")

    // 饰金之梦: draw on reaction damage, up to 2 per round
    if (card.name.includes("饰金之梦")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "敌方受元素反应伤害(上限2/回合)",
        expectedDrawsPerRound: [0, 0, 1.2, 1.5, 1.5], // ramp-up
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 浮溯之珏: draw 1 on normal attack, 1 per round
    if (card.name.includes("浮溯之珏")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "装备者普攻后(上限1/回合)",
        expectedDrawsPerRound: [0, 0, 0.7, 0.8, 0.8],
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 灵光明烁之心: draw 1 on taking damage, 1 per round
    if (card.name.includes("灵光明烁之心")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "装备者受伤后(出战,上限1/回合)",
        expectedDrawsPerRound: [0, 0, 0.5, 0.6, 0.6],
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 常九爷: draws 2 on 3 inspiration
    if (card.name.includes("常九爷")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "累积3灵感→弃置抽2(约2回合兑现1次)",
        expectedDrawsPerRound: [0, 0, 0.7, 1.0, 1.0],
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 寻宝仙灵: draws 3 on 3 clues
    if (card.name.includes("寻宝仙灵")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "累积3线索→弃置抽3(约2-3回合兑现1次)",
        expectedDrawsPerRound: [0, 0, 0.6, 1.0, 1.0],
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 立本: draws 2 when cashed
    if (card.name.includes("立本")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "收集3色骰→兑现抽2",
        expectedDrawsPerRound: [0, 1.0, 0, 0, 0], // burst: R2 cash-in
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }

    // 运筹帷幄: draws 2 immediately
    if (card.name.includes("运筹帷幄")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "打出即抽2(一次性)",
        expectedDrawsPerRound: [2, 0, 0, 0, 0],
        earliestDeployRound: 0, // can play immediately
      })
    }

    // 赌徒耳环: generates 2 omni on kill (not draw, but resource)
    if (card.name.includes("赌徒")) {
      engines.push({
        cardName: card.name,
        triggerCondition: "击杀→生成2万能骰(限3次)",
        expectedDrawsPerRound: [0, 0, 0, 0, 0], // not card draw
        earliestDeployRound: estimateDeployRound(card, cards.length),
      })
    }
  }

  // Compute per-round expected draw
  // Rounds 0-4 (0 = starting hand, 1-4 = turns)
  const perRound: number[] = []
  const totalDraws: number[] = []

  for (let round = 0; round < 5; round++) {
    let draw = round === 0 ? NATURAL_START : NATURAL_PER_ROUND

    // R0: no engines are on the field yet — don't count engine draws
    if (round > 0) {
      for (const engine of engines) {
        if (round >= engine.earliestDeployRound) {
          const engineRound = round - engine.earliestDeployRound
          if (engineRound < engine.expectedDrawsPerRound.length) {
            draw += engine.expectedDrawsPerRound[engineRound]
          } else {
            draw +=
              engine.expectedDrawsPerRound[
                engine.expectedDrawsPerRound.length - 1
              ]
          }
        }
      }
    }

    perRound.push(Math.round(draw * 10) / 10)
    totalDraws.push(
      Math.round(
        (totalDraws[totalDraws.length - 1] ?? draw),
      ) * 10,
    )
  }

  return { perRound, totalDraws, engines }
}

/**
 * Estimate the earliest round a card can be deployed.
 * Based on card cost and available dice per round.
 */
function estimateDeployRound(
  card: DeckCardInfo,
  _totalCards: number,
): number {
  // Parse the dice cost
  const rawDice = (card.playCost || [])
    .filter((c) => c.type !== "GCG_COST_ENERGY")
    .reduce((sum, c) => sum + c.count, 0)

  // R1: ~5 dice available for supports/equipment (after skill use)
  // Cards costing 1 can deploy R1, 2-3 can deploy R1-R2
  if (rawDice <= 1) return 1
  if (rawDice <= 3) return 1
  return 2
}
