// Copyright (C) 2024-2025 Guyutongxue
//
// Multi-card resource cycle detection.
// Identifies 2-3 card combinations that produce net positive resources.

import type { DeckCardInfo } from "../heuristics"
import type { EffectiveCost } from "./cost-stacking"
import { computeEffectiveCost } from "./cost-stacking"

export interface ResourceCycle {
  cards: string[]
  steps: string[]
  netDiceChange: number
  netCardsChange: number
  /** Whether this cycle is repeatable */
  repeatable: boolean
  description: string
}

/** Known resource cycle templates */
interface CycleTemplate {
  name: string
  requiredPatterns: RegExp[]
  computeSteps: (matched: string[]) => string[]
  computeNetDice: (matched: string[]) => number
  computeNetCards: (matched: string[]) => number
  description: string
  repeatable: boolean
}

const CYCLE_TEMPLATES: CycleTemplate[] = [
  {
    name: "圣遗物回收重打 (琴音之诗+饰金之梦)",
    requiredPatterns: [/琴音之诗/, /饰金之梦/],
    computeSteps: (m) => [
      `${m[0] || "琴音之诗"} 回收已装备圣遗物（下次打圣遗物-1~-2骰）`,
      `触发野猪公主：装备弃置→产1万能骰（如有）`,
      `重打${m[1] || "饰金之梦"}: 饰金之梦原费3骰，琴音-1~-2 + 弥生七月-1~-2，可降到0~1骰`,
      `${m[1] || "饰金之梦"} 入场产1同色+1万能骰`,
    ],
    computeNetDice: (_) => 2, // conservative
    computeNetCards: (_) => 0, // artifact returned to hand then replayed
    description: "圣遗物回手重打循环，净产骰+2~3",
    repeatable: true,
  },
  {
    name: "支援替换循环 (净觉花)",
    requiredPatterns: [/净觉花/],
    computeSteps: (m) => [
      `${m[0] || "净觉花"} 弃置支援区1张牌`,
      `生成2张随机支援牌到手牌`,
      `打出新支援牌：净觉花-1骰；若为伙伴牌且迪娜泽黛在场再-1骰`,
    ],
    computeNetDice: (_) => 0, // support cycling is card-neutral, slightly dice-positive
    computeNetCards: (_) => 1, // net +1 card (discard 1 support, gain 2, play 1 support = net -1 support +1 hand)
    description: "支援替换循环，维持支援区同时补充手牌",
    repeatable: true,
  },
  // 注：原"三重降费叠满"模板（弥生七月+化种匣+迪娜泽黛 → 饰金之梦）已删除：
  // 迪娜泽黛仅减"伙伴"牌、化种匣仅减"支援"牌，二者对圣遗物（饰金之梦）均不生效，
  // 该模板的减费算式与卡牌真实效果矛盾。
]

export function detectResourceCycles(
  cards: DeckCardInfo[],
): ResourceCycle[] {
  const cardNames = cards.map((c) => c.name)
  const results: ResourceCycle[] = []

  for (const template of CYCLE_TEMPLATES) {
    const matched: string[] = []
    for (const pattern of template.requiredPatterns) {
      const found = cardNames.find((name) => pattern.test(name))
      if (found) matched.push(found)
    }

    // Require all patterns to match
    if (matched.length < template.requiredPatterns.length) continue

    // Check for bonus cards
    const has野猪 = cardNames.some((n) => n.includes("野猪公主"))
    // 弥生七月仅减费圣遗物，故 bonus 只对涉及圣遗物的循环生效
    const isArtifactCycle = template.description.includes("圣遗物")
    const has弥生 = cardNames.some((n) => n.includes("弥生七月"))

    results.push({
      cards: matched,
      steps: template.computeSteps(matched),
      netDiceChange: template.computeNetDice(matched) + (has野猪 ? 1 : 0) + (has弥生 && isArtifactCycle ? 1 : 0),
      netCardsChange: template.computeNetCards(matched),
      repeatable: template.repeatable,
      description: `${template.name}: ${template.description}`,
    })
  }

  return results
}
