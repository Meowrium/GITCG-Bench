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

/**
 * Prompt 构建器：将 DeckContext 中的原始数据格式化为 LLM 可读的文本。
 *
 * 只包含数据段（角色、卡牌、效果、衍生物、DSL 源码、统计），
 * 不包含任何启发式中间产物（trigger chain、combo clock、zone pressure 等）。
 * LLM 从原始事实自行推理，而非修正可能错误的先验。
 */

import type { DeckContext } from "./deck-context"
import { formatPlayCost, groupCardNames, formatCounts } from "./deck-context"

export function buildDeckPromptContext(context: DeckContext): string {
  const characters = context.characterFullInfo
    .map((character) => {
      const traits = [
        character.elements.join("/"),
        character.weapon,
        `HP${character.hp}`,
        `充能${character.maxEnergy}`,
        ...character.nations,
      ].filter(Boolean)
      const skillsBlock = character.skills
        .map((s) => {
          const costStr = formatPlayCost(s.playCost)
          const costSection = costStr ? `（${costStr}）` : ""
          return `    ${s.type}「${s.name}」${costSection}: ${s.description}`
        })
        .join("\n")
      const skillsSection = skillsBlock ? `\n${skillsBlock}` : ""
      return `- ${character.name}（${traits.join("，")}）${skillsSection}`
    })
    .join("\n")

  const groupedCards = groupCardNames(context.cards)
  const cards = Object.entries(groupedCards)
    .map(([group, items]) => `- ${group}: ${items.join("、")}`)
    .join("\n")

  const uniqueCards = [...new Map(context.cards.map((c) => [c.id, c])).values()]
  const cardDetails = uniqueCards
    .filter((c) => c.description)
    .map((c) => {
      const parts: string[] = []
      const tagSuffix = c.meaningfulTags.length > 0 ? ` [${c.meaningfulTags.join("，")}]` : ""
      const costSuffix = c.playCost.length > 0 ? `（${formatPlayCost(c.playCost)}）` : ""
      parts.push(`  ${c.name}${tagSuffix}${costSuffix}: ${c.description}`)
      if (c.playingDescription) {
        parts.push(`  ${c.name}（持续效果）: ${c.playingDescription}`)
      }
      return parts.join("\n")
    })
    .join("\n")

  const entityEntries = [...context.entityDescriptions.values()]
  const entitySection = entityEntries.length > 0
    ? `\n衍生物/状态效果（由卡牌或角色技能引用，不在初始牌组中）:\n${entityEntries.map((e) => `  ${e}`).join("\n")}`
    : ""

  const generatedHandCardEntries = [...context.generatedHandCardDescriptions.values()]
  const generatedHandCardSection = generatedHandCardEntries.length > 0
    ? `\n生成手牌（由角色技能生成，不在初始牌组中）:\n${generatedHandCardEntries.map((e) => `  ${e}`).join("\n")}`
    : ""

  // --- DSL 源码区块（与中文描述双通道对照） ---
  const dslSection = (() => {
    const hasCharDsl = context.characterDslSources && context.characterDslSources.size > 0
    const hasCardDsl = context.cardDslSources && context.cardDslSources.size > 0
    if (!hasCharDsl && !hasCardDsl) return ""

    const parts: string[] = []
    parts.push("以下为卡牌效果的 DSL 源码实现（精确、无歧义，与上方中文描述对照阅读）。")
    parts.push("DSL 速查：.on(event) 设置触发时机；.damage(type,value) / .heal(n) / .drawCards(n) / .generateDice(type,n) / .gainEnergy(n) 为效果；.usagePerRound(n)/.usage(n) 为次数限制；.if(cond).else() 为条件分支；c 为技能上下文（查询/操作），e 为事件参数。")

    if (hasCharDsl) {
      parts.push("\n; ===== 角色技能 DSL =====")
      for (const ch of context.characterFullInfo) {
        const skillSrcs = context.characterDslSources!.get(ch.id)
        if (!skillSrcs || skillSrcs.length === 0) continue
        parts.push(`; [${ch.name}]`)
        for (const s of skillSrcs) {
          parts.push(s)
        }
      }
    }

    if (hasCardDsl) {
      parts.push("\n; ===== 行动牌 DSL =====")
      const seen = new Set<number>()
      for (const c of context.cards) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        const src = context.cardDslSources!.get(c.id)
        if (!src) continue
        parts.push(`; [${c.subtype}] ${c.name}\n${src}`)
      }
    }

    return `\n${parts.join("\n")}\n`
  })()

  return `牌组代码: ${context.deckCode}
角色:
${characters}
卡牌:
${cards}
卡牌效果:
${cardDetails}${entitySection}${generatedHandCardSection}${dslSection}
摘要:
- 元素分布: ${formatCounts(context.summary.elementCounts)}
- 装备/事件/支援: ${context.summary.equipmentCount}/${context.summary.eventCount}/${context.summary.supportCount}
- 天赋牌数量: ${context.summary.talentCount}
- 共鸣牌数量: ${context.summary.resonanceCount}
- 重复关键牌: ${context.summary.cardFrequencies
      .filter((item) => item.count > 1)
      .slice(0, 6)
      .map((item) => `${item.name}x${item.count}`)
      .join("、") || "无"}`
}
