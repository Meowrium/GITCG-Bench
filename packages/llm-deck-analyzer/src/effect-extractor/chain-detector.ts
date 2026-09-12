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

import type {
  CardEffectData,
  EffectSignal,
  TriggerSlot,
  TriggerChainEdge,
  TriggerChain,
  TriggerChainStep,
  SignalKind,
  TriggerKind,
  ChainProbability,
} from "./types"

/**
 * Given a card's effect data, produce signals (what it outputs)
 * and trigger slots (what it receives).
 */
function extractSignals(card: CardEffectData): EffectSignal[] {
  const signals: EffectSignal[] = []

  for (let si = 0; si < card.skills.length; si++) {
    const skill = card.skills[si]

    for (const effect of skill.effects) {
      const signal = effectToSignal(effect.kind, effect, card, si)
      if (signal) {
        signals.push(signal)
      }
    }
  }

  return signals
}

function effectToSignal(
  kind: string,
  effect: CardEffectData["skills"][number]["effects"][number],
  card: CardEffectData,
  skillIndex: number,
): EffectSignal | null {
  switch (kind) {
    case "self_damage":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "self_damage",
        skillIndex,
        target: effect.target ?? "my_active",
      }
    case "damage":
      if (effect.target === "my_active" || effect.target === "my_off_field" || effect.target === "self") {
        return {
          sourceCardId: card.id,
          sourceCardName: card.name,
          kind: "self_damage",
          skillIndex,
          target: effect.target,
        }
      }
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "damage",
        skillIndex,
        target: effect.target ?? "opp_active",
      }
    case "dispose_hand":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "discard_hand",
        skillIndex,
        detail: effect.args.strategy as string,
      }
    case "create_hand_card":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "create_hand_card",
        skillIndex,
        detail: effect.args.refName as string ?? effect.createsEntityName,
      }
    case "create_entity":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "create_entity",
        skillIndex,
        detail: effect.args.entityType as string,
      }
    case "continue_next_turn":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "continue_action",
        skillIndex,
      }
    case "switch_active":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "switch_active",
        skillIndex,
      }
    case "generate_dice":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "generate_dice",
        skillIndex,
      }
    case "draw_cards":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "draw_cards",
        skillIndex,
      }
    case "increase_damage":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "amplify_damage",
        skillIndex,
      }
    case "multiply_damage":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "amplify_damage",
        skillIndex,
        detail: "multiply",
      }
    case "heal":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "heal",
        skillIndex,
      }
    case "gain_energy":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "gain_energy",
        skillIndex,
      }
    case "shield":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "shield",
        skillIndex,
      }
    case "apply_element":
      return {
        sourceCardId: card.id,
        sourceCardName: card.name,
        kind: "apply_element",
        skillIndex,
        detail: effect.args.element as string,
      }
    default:
      return null
  }
}

function extractTriggerSlots(card: CardEffectData): TriggerSlot[] {
  const slots: TriggerSlot[] = []

  for (let si = 0; si < card.skills.length; si++) {
    const skill = card.skills[si]
    for (const trigger of skill.triggers) {
      slots.push({
        cardId: card.id,
        cardName: card.name,
        kind: trigger.kind,
        eventName: trigger.eventName,
        scope: trigger.scope,
        skillIndex: si,
        hasCustomFilter: trigger.hasCustomFilter,
        filterDescription: trigger.filterDescription,
      })
    }
  }

  return slots
}

/**
 * Signal-Trigger matching rules.
 * Determines whether a signal from one card can activate a trigger on another card.
 */
const SIGNAL_TRIGGER_MATCHES: Array<{
  signal: SignalKind
  trigger: TriggerKind
  probability: ChainProbability
  edgeType: "enables" | "amplifies" | "finishes" | "protects" | "stabilizes"
  description: string
}> = [
  // Self-damage triggers "on_damaged" effects (like 勘探钻机)
  {
    signal: "self_damage",
    trigger: "on_damaged",
    probability: "likely",
    edgeType: "enables",
    description: "自伤触发受击效果",
  },
  // Regular damage can trigger "on_damaged" (_enemy_ taking damage)
  {
    signal: "damage",
    trigger: "on_damaged",
    probability: "possible",
    edgeType: "enables",
    description: "伤害触发受击效果",
  },
  // Damage can trigger "on_defeated"
  {
    signal: "damage",
    trigger: "on_defeated",
    probability: "possible",
    edgeType: "finishes",
    description: "伤害可能击倒触发击倒效果",
  },
  // Discarding hand cards triggers "on_discard" effects (like 超量装药弹头)
  {
    signal: "discard_hand",
    trigger: "on_discard",
    probability: "possible",
    edgeType: "enables",
    description: "弃牌触发弃置效果",
  },
  // Creating a hand card enables the card to be available for discard triggers
  {
    signal: "create_hand_card",
    trigger: "on_discard",
    probability: "possible",
    edgeType: "enables",
    description: "生成手牌可被弃牌触发利用",
  },
  // Switching enables "on_swap" triggers
  {
    signal: "switch_active",
    trigger: "on_swap",
    probability: "certain",
    edgeType: "enables",
    description: "切人触发切换效果",
  },
  // Extra action enables finishing
  {
    signal: "continue_action",
    trigger: "on_skill_use",
    probability: "likely",
    edgeType: "finishes",
    description: "额外行动可衔接后续技能",
  },
  // 注：以下两条规则已删除：
  // - damage→on_damage_increase: 增伤(modifyDamage1)在伤害结算前应用，因果方向是增伤→更高伤害
  // - generate_dice→on_generate_dice: A产骰不会触发B的onGenerateDice事件
  // Creating an entity triggers "on_enter" effects
  // 注：on_enter只在实体自身进场时触发，仅listenToAll场景成立，降为possible
  {
    signal: "create_entity",
    trigger: "on_enter",
    probability: "possible",
    edgeType: "enables",
    description: "创建实体可能触发进场效果（仅listenToAll场景）",
  },
  // Reaction triggers
  {
    signal: "damage",
    trigger: "on_reaction",
    probability: "likely",
    edgeType: "enables",
    description: "元素伤害可能触发反应效果",
  },
  // Healing triggers "on_heal" effects (e.g., 老兵的容颜, 逐影猎人)
  {
    signal: "heal",
    trigger: "on_heal",
    probability: "likely",
    edgeType: "enables",
    description: "治疗触发治疗响应效果",
  },
  // Healing also triggers "on_damaged" via onDamageOrHeal shared event
  {
    signal: "heal",
    trigger: "on_damaged",
    probability: "possible",
    edgeType: "enables",
    description: "治疗触发受击/治疗共享效果",
  },
  // Gaining energy enables skill use (especially burst)
  {
    signal: "gain_energy",
    trigger: "on_skill_use",
    probability: "likely",
    edgeType: "enables",
    description: "充能使角色能够使用技能",
  },
  // Creating a hand card enables it to be played (triggering "on_play_card")
  {
    signal: "create_hand_card",
    trigger: "on_play_card",
    probability: "likely",
    edgeType: "enables",
    description: "生成手牌可被打出触发打出效果",
  },
  // 注：amplify_damage→on_damage_increase 已删除（方向反了，增伤在伤害前结算）
  // Shield protects, enabling on_damaged triggers to still fire (without character dying)
  {
    signal: "shield",
    trigger: "on_damaged",
    probability: "possible",
    edgeType: "protects",
    description: "护盾使角色存活触发受击效果",
  },
  // Applying element enables reactions
  {
    signal: "apply_element",
    trigger: "on_reaction",
    probability: "likely",
    edgeType: "enables",
    description: "附着元素可触发反应效果",
  },
  // Defeat triggers "on_defeated" effects
  {
    signal: "defeat",
    trigger: "on_defeated",
    probability: "likely",
    edgeType: "finishes",
    description: "击倒触发击倒效果",
  },
  // Drawing cards can trigger "on_draw" effects
  {
    signal: "draw_cards",
    trigger: "on_draw",
    probability: "possible",
    edgeType: "enables",
    description: "抽牌触发抽牌响应效果",
  },
  // Damage dealt triggers "on_damage_dealt" effects
  {
    signal: "damage",
    trigger: "on_damage_dealt",
    probability: "likely",
    edgeType: "enables",
    description: "造成伤害触发伤害响应效果",
  },
  // 注：以下两条已删除（方向反了/语义不成立）：
  // - amplify_damage→on_damage_dealt: 增伤是modifyDamage1阶段，不触发onDamageOrHeal
  // - gain_energy→on_damage_increase: 充能不触发增伤，二者无因果关系
  // --- 基于资源供给的间接联动（possible） ---
  // 装备进场可能触发进场效果（仅listenToAll场景）
  {
    signal: "equip",
    trigger: "on_enter",
    probability: "possible",
    edgeType: "enables",
    description: "装备进场可能触发进场效果（仅listenToAll场景）",
  },
  // 生成骰子使玩家能够打出牌（资源供给）
  {
    signal: "generate_dice",
    trigger: "on_play_card",
    probability: "possible",
    edgeType: "enables",
    description: "生成骰子为打出卡牌提供资源",
  },
  // 生成骰子使角色能够使用技能（资源供给）
  {
    signal: "generate_dice",
    trigger: "on_skill_use",
    probability: "possible",
    edgeType: "enables",
    description: "生成骰子为使用技能提供资源",
  },
  // 创建实体（召唤物）在回合结束触发效果（如召唤物结束阶段造成伤害）
  {
    signal: "create_entity",
    trigger: "on_round_end",
    probability: "possible",
    edgeType: "enables",
    description: "召唤物在场时触发回合结束效果",
  },
  // 创建实体（支援）在行动阶段触发效果（如派蒙产骰）
  {
    signal: "create_entity",
    trigger: "on_action_phase",
    probability: "possible",
    edgeType: "enables",
    description: "支援进场触发行动阶段效果",
  },
  // 充能使角色在回合开始时更接近爆发
  {
    signal: "gain_energy",
    trigger: "on_round_begin",
    probability: "possible",
    edgeType: "enables",
    description: "充能积累为回合开始爆发做准备",
  },
  // 抽牌补充手牌，为打出卡牌提供素材
  {
    signal: "draw_cards",
    trigger: "on_play_card",
    probability: "possible",
    edgeType: "enables",
    description: "抽牌为后续打出卡牌提供手牌",
  },
  // 护盾保护使角色能安全触发战斗开始/回合开始效果
  {
    signal: "shield",
    trigger: "on_battle_begin",
    probability: "possible",
    edgeType: "protects",
    description: "护盾保护角色存活到战斗开始触发",
  },
]

/**
 * Detect trigger chain edges between cards in a deck.
 * This is the core of the combo detection algorithm.
 */
export function detectTriggerChainEdges(
  cards: CardEffectData[],
  generatedCards: Map<string, CardEffectData>,
): TriggerChainEdge[] {
  const edges: TriggerChainEdge[] = []

  const allCards = [...cards]
  for (const genCard of generatedCards.values()) {
    if (!allCards.find(c => c.id === genCard.id)) {
      allCards.push(genCard)
    }
  }

  const allSignals = new Map<number, EffectSignal[]>()
  const allTriggerSlots = new Map<number, TriggerSlot[]>()

  for (const card of allCards) {
    allSignals.set(card.id, extractSignals(card))
    allTriggerSlots.set(card.id, extractTriggerSlots(card))
  }

  for (const sourceCard of allCards) {
    const sourceSignals = allSignals.get(sourceCard.id) ?? []

    for (const targetCard of allCards) {
      if (sourceCard.id === targetCard.id) {
        // Self-triggering is possible but we skip to reduce noise
        // (e.g., using a skill that triggers your own passive)
        continue
      }

      const targetSlots = allTriggerSlots.get(targetCard.id) ?? []

      for (const signal of sourceSignals) {
        for (const slot of targetSlots) {
          const match = findSignalTriggerMatch(signal, slot)
          if (match) {
            // Check scope compatibility
            if (!isScopeCompatible(signal, slot, sourceCard, targetCard)) {
              continue
            }

            edges.push({
              fromCardId: sourceCard.id,
              fromCardName: sourceCard.name,
              toCardId: targetCard.id,
              toCardName: targetCard.name,
              edgeType: match.edgeType,
              signal: signal.kind,
              trigger: slot.kind,
              probability: match.probability,
              description: match.description,
            })
          }
        }
      }
    }
  }

  // Deduplicate edges (same from→to with same signal+trigger)
  const deduped = deduplicateEdges(edges)

  // 限制每张源卡的出边数量：按概率排序，每张卡最多保留 top-5 条
  // 防止 O(n²) 的噪音边淹没真实联动
  const PROB_RANK: Record<ChainProbability, number> = { certain: 3, likely: 2, possible: 1 }
  const MAX_EDGES_PER_CARD = 5
  const bySource = new Map<number, TriggerChainEdge[]>()
  for (const e of deduped) {
    const list = bySource.get(e.fromCardId) ?? []
    list.push(e)
    bySource.set(e.fromCardId, list)
  }
  const trimmed: TriggerChainEdge[] = []
  for (const list of bySource.values()) {
    list.sort((a, b) => PROB_RANK[b.probability] - PROB_RANK[a.probability])
    trimmed.push(...list.slice(0, MAX_EDGES_PER_CARD))
  }

  return trimmed
}

function findSignalTriggerMatch(
  signal: EffectSignal,
  slot: TriggerSlot,
): (typeof SIGNAL_TRIGGER_MATCHES)[number] | null {
  for (const rule of SIGNAL_TRIGGER_MATCHES) {
    if (signal.kind === rule.signal && slot.kind === rule.trigger) {
      return rule
    }
  }
  return null
}

function isScopeCompatible(
  signal: EffectSignal,
  slot: TriggerSlot,
  sourceCard: CardEffectData,
  targetCard: CardEffectData,
): boolean {
  // "sameArea" scope: trigger only fires for same-character events
  // "samePlayer" scope: trigger fires for same-player events
  // "all" scope: trigger fires for any player's events
  // "self" scope: trigger only fires for the entity itself

  // For self_damage signals: the signal source is on same player as target
  // So samePlayer and all scopes are compatible
  if (signal.kind === "self_damage" || signal.kind === "damage") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    // "self" scope unlikely to be triggered by another card
    return slot.scope !== "self"
  }

  // For discard_hand: target scope must include samePlayer
  if (signal.kind === "discard_hand" || signal.kind === "create_hand_card") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer") return true
    return false
  }

  // For heal signals: same player heals trigger same-player effects
  if (signal.kind === "heal") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    return slot.scope !== "self"
  }

  // For gain_energy: affects same player's characters
  if (signal.kind === "gain_energy") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    return slot.scope !== "self"
  }

  // For shield: protects same player's characters
  if (signal.kind === "shield") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    return slot.scope !== "self"
  }

  // For apply_element: affects any character
  if (signal.kind === "apply_element") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    return slot.scope !== "self"
  }

  // For amplify_damage: same player amplification
  if (signal.kind === "amplify_damage") {
    if (slot.scope === "all") return true
    if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
    return slot.scope !== "self"
  }

  // Default: scope must overlap
  if (slot.scope === "all") return true
  if (slot.scope === "samePlayer" || slot.scope === "sameArea") return true
  return slot.scope !== "self"
}

function deduplicateEdges(edges: TriggerChainEdge[]): TriggerChainEdge[] {
  const seen = new Set<string>()
  const result: TriggerChainEdge[] = []
  for (const edge of edges) {
    const key = `${edge.fromCardId}->${edge.toCardId}:${edge.signal}:${edge.trigger}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(edge)
    }
  }
  return result
}

/**
 * Build multi-step trigger chains from edges.
 * A chain is a sequence of edges where each edge leads to the next.
 */
export function buildTriggerChains(
  edges: TriggerChainEdge[],
  maxDepth: number = 4,
): TriggerChain[] {
  const chains: TriggerChain[] = []

  // Build adjacency map: from → list of edges
  const adjacency = new Map<number, TriggerChainEdge[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.fromCardId) ?? []
    list.push(edge)
    adjacency.set(edge.fromCardId, list)
  }

  // DFS to find chains starting from each card
  const visited = new Set<string>()

  for (const startEdge of edges) {
    const chainId = `${startEdge.fromCardId}->${startEdge.toCardId}`
    if (visited.has(chainId)) continue

    const steps: TriggerChainStep[] = []
    const involvedCardIds = new Set<number>()
    const involvedNames = new Set<string>()

    // Start the chain
    steps.push({
      cardId: startEdge.fromCardId,
      cardName: startEdge.fromCardName,
      effectKind: startEdge.signal,
      targetCardId: startEdge.toCardId,
      triggerKind: startEdge.trigger,
    })
    involvedCardIds.add(startEdge.fromCardId)
    involvedCardIds.add(startEdge.toCardId)
    involvedNames.add(startEdge.fromCardName)
    involvedNames.add(startEdge.toCardName)
    visited.add(chainId)

    // Try to extend the chain
    let currentCardId = startEdge.toCardId
    for (let depth = 1; depth < maxDepth; depth++) {
      const nextEdges = adjacency.get(currentCardId)
      if (!nextEdges || nextEdges.length === 0) break

      // Pick the first unvisited next edge
      const nextEdge = nextEdges.find(e => !visited.has(`${e.fromCardId}->${e.toCardId}`))
      if (!nextEdge) break

      visited.add(`${nextEdge.fromCardId}->${nextEdge.toCardId}`)
      steps.push({
        cardId: nextEdge.fromCardId,
        cardName: nextEdge.fromCardName,
        effectKind: nextEdge.signal,
        targetCardId: nextEdge.toCardId,
        triggerKind: nextEdge.trigger,
      })
      involvedCardIds.add(nextEdge.fromCardId)
      involvedCardIds.add(nextEdge.toCardId)
      involvedNames.add(nextEdge.fromCardName)
      involvedNames.add(nextEdge.toCardName)
      currentCardId = nextEdge.toCardId
    }

    if (steps.length >= 2) {
      // Build description
      const chainDescription = steps.map((s, i) => {
        const triggerDesc = s.triggerKind ? ` (触发${triggerKindLabel(s.triggerKind)})` : ""
        return `${s.cardName}${triggerDesc}`
      }).join(" → ")

      chains.push({
        steps,
        description: chainDescription,
        involvedCardIds: [...involvedCardIds],
        involvedEntityNames: [...involvedNames],
        chainLength: steps.length,
      })
    }
  }

  // Sort by chain length (longest first) and deduplicate
  chains.sort((a, b) => b.chainLength - a.chainLength)
  return deduplicateChains(chains)
}

function triggerKindLabel(kind: TriggerKind): string {
  const labels: Record<string, string> = {
    on_damaged: "受击",
    on_damage_dealt: "造成伤害",
    on_defeated: "击倒",
    on_round_end: "回合结束",
    on_round_begin: "回合开始",
    on_swap: "切人",
    on_skill_use: "使用技能",
    on_play_card: "打出牌",
    on_discard: "弃牌",
    on_dispose: "弃置",
    on_draw: "抽牌",
    on_reaction: "反应",
    on_damage_increase: "增伤",
    on_damage_decrease: "减伤",
    on_heal: "治疗",
    on_enter: "进场",
    on_generate_dice: "生成骰子",
    on_battle_begin: "战斗开始",
    on_defeated_check: "被击倒前",
    on_action_phase: "行动阶段",
    on_end_phase: "结束阶段",
    on_variable_change: "变量变化",
    on_custom: "自定义",
    initiative: "打出",
  }
  return labels[kind] ?? kind
}

function deduplicateChains(chains: TriggerChain[]): TriggerChain[] {
  const seen = new Set<string>()
  const result: TriggerChain[] = []
  for (const chain of chains) {
    const key = chain.steps.map(s => `${s.cardId}:${s.effectKind}`).join("|")
    if (!seen.has(key)) {
      seen.add(key)
      result.push(chain)
    }
  }
  return result
}

/**
 * Main entry point: detect combos in a deck's card list.
 */
export function detectDeckCombos(
  deckCards: CardEffectData[],
  generatedCards: Map<string, CardEffectData>,
): {
  edges: TriggerChainEdge[]
  chains: TriggerChain[]
} {
  const edges = detectTriggerChainEdges(deckCards, generatedCards)
  const chains = buildTriggerChains(edges)
  return { edges, chains }
}